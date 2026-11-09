import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile as callbackExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkspaceRegistry } from '../../build/core/workspace.js';
import { Archive } from '../../build/core/archive.js';
import { FreshnessManager } from '../../build/core/freshness.js';
import { sha256 } from '../../build/core/json.js';

const execFile = promisify(callbackExecFile);
const git = (root, ...args) => execFile('git', ['-C', root, ...args], { windowsHide: true });
async function until(predicate, label, timeout = 15000) {
  const started = Date.now();
  while (!await predicate()) {
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for ' + label);
    await delay(25);
  }
}

async function fixture(t, { extraSource = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'harnessl3-freshness-'));
  const managers = [];
  t.after(async () => {
    for (const manager of managers) await manager.close();
    assert.ok(path.basename(root).startsWith('harnessl3-freshness-'));
    await rm(root, { recursive: true, force: true });
  });
  const checkout = path.join(root, 'current checkout');
  const dataRoot = path.join(root, 'machine data');
  const seedRoot = path.join(root, 'seed');
  await mkdir(checkout);
  await mkdir(seedRoot);
  await writeFile(path.join(seedRoot, 'LICENSE'), 'Test fixture\n');
  const globalIgnore = path.join(root, 'global ignore');
  await writeFile(globalIgnore, '');
  await git(checkout, 'init', '-b', 'main');
  await git(checkout, 'config', 'user.name', 'Harness Fixture');
  await git(checkout, 'config', 'user.email', 'fixture@example.invalid');
  await git(checkout, 'config', 'core.autocrlf', 'false');
  await git(checkout, 'config', 'core.excludesfile', globalIgnore);
  await writeFile(path.join(checkout, 'README.md'), 'source baseline\n');
  await writeFile(path.join(checkout, '.gitignore'), 'ignored/\n');
  if (extraSource) await writeFile(path.join(checkout, 'other.ts'), 'other baseline\n');
  await git(checkout, 'add', '.');
  await git(checkout, 'commit', '-m', 'Initial fixture');
  const registry = new WorkspaceRegistry(dataRoot, { seedRoot });
  const initialized = await registry.init(checkout);
  const config = await registry.readConfig(checkout);
  await writeFile(initialized.paths.config, JSON.stringify({ ...config, skills: { root: 'project-skills' } }));
  const skillsRoot = path.join(checkout, 'project-skills');
  await mkdir(skillsRoot);
  const archiveRoot = path.join(dataRoot, 'worktrees', initialized.worktree.id);
  let queue = Promise.resolve();
  let queued;
  const serial = (operation) => {
    queued?.();
    const next = queue.then(operation);
    queue = next.catch(() => {});
    return next;
  };
  const create = async () => {
    const archive = new Archive(archiveRoot);
    const manager = new FreshnessManager({ worktree: initialized.worktree, archive, serial, pollIntervalMs: 60_000 });
    managers.push(manager);
    await manager.ready();
    return { manager, archive };
  };
  const { manager, archive } = await create();
  return { root, checkout, skillsRoot, globalIgnore, initialized, manager, archive, create, serial, watchQueue: (callback) => { queued = callback; } };
}

function proof(state, worktree, overrides = {}) {
  return {
    schemaVersion: 1, requestId: randomUUID(), target: { projectId: worktree.projectId, worktreeId: worktree.id }, phaseId: randomUUID(),
    sourceEpoch: state.sourceEpoch, expectedSourceVersion: state.sourceVersion, expectedModelRevision: state.modelRevision,
    scope: { paths: state.pendingPaths.length ? state.pendingPaths : ['README.md'], entities: [] }, disposition: 'no-semantic-change',
    reason: 'Reviewed the stated source paths against the current model.', checks: [{ name: 'Fixture review', status: 'passed', evidence: ['README.md'] }], ...overrides,
  };
}

test('TC07 background observation hashes changed leaves without promoting its baseline to a current full scan', async t => {
  const f = await fixture(t, { extraSource: true });
  const baseline = await f.manager.status(f.skillsRoot);
  const capture = t.mock.method(f.manager, 'capture', () => { throw new Error('Unexpected complete source scan'); });
  await writeFile(path.join(f.checkout, 'README.md'), 'Changed source\n');
  await until(() => f.manager.currentState().sourceEpoch > baseline.sourceEpoch, 'source notification');
  const observed = await f.manager.observe(f.skillsRoot);
  assert.equal(observed.state, 'pending');
  assert.equal(observed.scanPending, true);
  assert.deepEqual(observed.sourceVersion, baseline.sourceVersion);
  assert.ok(observed.sourceObservation.entries.some(entry => entry.path === 'README.md' && entry.contentHash === sha256(Buffer.from('Changed source\n'))));
  assert.ok(!observed.sourceObservation.entries.some(entry => entry.path === 'other.ts'));
  assert.equal(capture.mock.callCount(), 0);
  capture.mock.restore();
  const complete = await f.manager.status(f.skillsRoot);
  assert.notEqual(complete.sourceVersion.treeHash, baseline.sourceVersion.treeHash);
});

test('TC07 concurrent status callers share one complete reconciliation but a later call rechecks bytes', async t => {
  const f = await fixture(t);
  const original = f.manager.capture.bind(f.manager);
  const capture = t.mock.method(f.manager, 'capture', original);
  const results = await Promise.all([f.manager.status(f.skillsRoot), f.manager.status(f.skillsRoot), f.manager.status(f.skillsRoot)]);
  assert.equal(capture.mock.callCount(), 1);
  assert.ok(results.every(state => state.sourceVersion.treeHash === results[0].sourceVersion.treeHash));
  await f.manager.status(f.skillsRoot);
  assert.equal(capture.mock.callCount(), 2);
});

test('TC16 compact state references share receipt bytes and restore alongside unchanged inline history', async t => {
  const f = await fixture(t);
  const baseline = await f.manager.status(f.skillsRoot);
  const rows = f.archive.records({ kind: 'freshness-state' });
  assert.ok(rows.length);
  for (const row of rows) {
    assert.equal(row.payload.state, undefined);
    assert.equal(row.payload.stateHash, row.receiptHash);
    assert.deepEqual(await f.archive.readSnapshot(row.payload.stateHash), baseline);
  }
  await f.manager.close();
  const old = await f.archive.commit({ scope: 'old-inline-state', requestId: randomUUID(), request: {}, payload: { kind: 'freshness-state', state: baseline }, receipt: baseline, archives: f.archive.references() });
  const before = await readFile(path.join(f.archive.root, 'journal.jsonl'));
  const restored = await f.create();
  assert.equal(restored.archive.seq, old.seq);
  assert.deepEqual(restored.manager.currentState().sourceVersion, baseline.sourceVersion);
  assert.equal(restored.manager.currentState().scanPending, true);
  assert.deepEqual(await readFile(path.join(f.archive.root, 'journal.jsonl')), before);
});

test('TC07 watcher failure invalidates the old epoch and a complete status can restore coverage', async t => {
  const f = await fixture(t);
  const baseline = await f.manager.status(f.skillsRoot);
  const oldProof = proof(baseline, f.initialized.worktree);
  f.manager.watcher.emit('error', new Error('Injected coverage failure'));
  const gap = f.manager.currentState();
  assert.equal(gap.state, 'unknown');
  assert.ok(gap.sourceEpoch > baseline.sourceEpoch);
  assert.equal(gap.scanPending, true);
  assert.ok(gap.diagnostics.some(item => item.code === 'SOURCE_WATCH_ERROR'));
  const recovered = await f.manager.status(f.skillsRoot);
  assert.equal(recovered.scanPending, false);
  await assert.rejects(f.manager.verify(oldProof, f.skillsRoot), { code: 'SYNC_RACE' });
});

async function referencedDocument(t, { relative = 'decision.md' } = {}) {
  const f = await fixture(t, { extraSource: true });
  const document = path.join(f.checkout, relative);
  await mkdir(path.dirname(document), { recursive: true });
  await writeFile(document, 'Confirmed decision\n');
  const evidenceId = randomUUID(), entityId = randomUUID();
  await writeFile(path.join(f.checkout, '.harness', 'evidence.json'), JSON.stringify({ schemaVersion: 1, evidence: [
    { id: evidenceId, kind: 'document', claim: 'Confirmed decision', location: { path: relative }, hash: sha256(await readFile(document)), observedAt: new Date().toISOString() },
  ] }));
  await writeFile(path.join(f.checkout, '.harness', 'model', 'main.c4'), `specification { element system }
model { app = system "Application" { metadata {
  harness_id "${entityId}" brief "Confirmed decision" source "fact" status "verified" evidence "${evidenceId}" version "1"
} } }
`);
  return { ...f, document, relative, evidenceId, entityId };
}

async function linkedDocument(t) {
  const targetRelative = 'ignored/target/decision.md';
  const f = await referencedDocument(t, { relative: targetRelative });
  await symlink(path.dirname(f.document), path.join(f.checkout, 'ignored', 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const relative = 'ignored/alias/decision.md';
  const evidencePath = path.join(f.checkout, '.harness', 'evidence.json');
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  evidence.evidence[0].location.path = relative;
  await writeFile(evidencePath, JSON.stringify(evidence));
  return { ...f, relative, targetRelative };
}

test('TC07 linked document target writes and rollback invalidate old proofs outside the source scan', async t => {
  const f = await linkedDocument(t);
  const baseline = await f.manager.status(f.skillsRoot);
  const oldProof = proof(baseline, f.initialized.worktree);
  const verified = await f.manager.verify({ ...oldProof, requestId: randomUUID() }, f.skillsRoot);
  await writeFile(f.document, 'Changed linked decision\n');
  await until(() => f.manager.currentState().sourceEpoch > verified.sourceEpoch, 'linked reference target change');
  const changed = await f.manager.status(f.skillsRoot);
  assert.equal(changed.state, 'pending');
  assert.ok(changed.pendingPaths.includes(f.relative));
  assert.ok(changed.diagnostics.some(item => item.code === 'EVIDENCE_CHANGED' && item.evidenceId === f.evidenceId));
  await writeFile(f.document, 'Confirmed decision\n');
  await until(() => f.manager.currentState().sourceEpoch > changed.sourceEpoch, 'linked reference target rollback');
  const restored = await f.manager.status(f.skillsRoot);
  assert.deepEqual(restored.sourceVersion, baseline.sourceVersion);
  assert.equal(restored.sourceScanRevision, baseline.sourceScanRevision);
  await assert.rejects(f.manager.verify(oldProof, f.skillsRoot), error => error.code === 'SYNC_RACE');
  const current = await f.manager.status(f.skillsRoot);
  assert.equal((await f.manager.verify(proof(current, f.initialized.worktree), f.skillsRoot)).state, 'verified');
});

test('TC07 a missing linked directory keeps its target recreation observed', async t => {
  const f = await linkedDocument(t);
  const baseline = await f.manager.status(f.skillsRoot);
  const verified = await f.manager.verify(proof(baseline, f.initialized.worktree), f.skillsRoot);
  const target = await realpath(path.dirname(f.document));
  assert.equal(path.relative(await realpath(f.checkout), target).split(path.sep).join('/'), 'ignored/target');
  await rm(target, { recursive: true });
  await until(() => f.manager.currentState().sourceEpoch > verified.sourceEpoch, 'linked directory removal');
  const missing = await f.manager.status(f.skillsRoot);
  assert.ok(missing.diagnostics.some(item => item.code === 'EVIDENCE_MISSING' && item.evidenceId === f.evidenceId));
  const oldProof = proof(missing, f.initialized.worktree);
  await mkdir(target);
  await writeFile(f.document, 'Confirmed decision\n');
  await until(() => f.manager.currentState().sourceEpoch > missing.sourceEpoch, 'linked directory recreation');
  await f.manager.status(f.skillsRoot);
  await assert.rejects(f.manager.verify(oldProof, f.skillsRoot), error => error.code === 'SYNC_RACE');
  const current = await f.manager.status(f.skillsRoot);
  assert.equal((await f.manager.verify(proof(current, f.initialized.worktree), f.skillsRoot)).state, 'verified');
});

test('TC08 linked evidence failures and repaired pending paths match physical and alternative link scopes', async t => {
  const f = await linkedDocument(t);
  await symlink(path.dirname(f.document), path.join(f.checkout, 'ignored', 'second-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const alternative = 'ignored/second-alias/decision.md';
  const baseline = await f.manager.status(f.skillsRoot);
  const verified = await f.manager.verify(proof(baseline, f.initialized.worktree), f.skillsRoot);
  await writeFile(f.document, 'Changed linked decision\n');
  await until(() => f.manager.currentState().sourceEpoch > verified.sourceEpoch, 'linked scope input change');
  for (const relative of [f.relative, f.targetRelative, alternative]) {
    const current = await f.manager.status(f.skillsRoot);
    await assert.rejects(f.manager.verify(proof(current, f.initialized.worktree, { scope: { paths: [relative], entities: [] } }), f.skillsRoot), error => {
      assert.equal(error.code, 'SYNC_UNRESOLVED');
      assert.equal(error.details.result.automaticChecks.find(item => item.name === 'referenced-evidence').status, 'failed');
      return true;
    });
  }
  const evidencePath = path.join(f.checkout, '.harness', 'evidence.json');
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  evidence.evidence[0].hash = sha256(await readFile(f.document));
  evidence.evidence[0].observedAt = new Date().toISOString();
  await writeFile(evidencePath, JSON.stringify(evidence));
  const repaired = await f.manager.status(f.skillsRoot);
  const result = await f.manager.verify(proof(repaired, f.initialized.worktree, { scope: { paths: [alternative], entities: [] } }), f.skillsRoot);
  assert.equal(result.state, 'verified', JSON.stringify({ pendingPaths: result.pendingPaths, diagnostics: result.diagnostics }));
  assert.deepEqual(result.pendingPaths, []);
});

test('TC08 verifying one linked document preserves a pending sibling in the same directory', async t => {
  const f = await linkedDocument(t);
  const sibling = 'ignored/alias/sibling.md';
  const siblingPath = path.join(path.dirname(f.document), 'sibling.md');
  await writeFile(siblingPath, 'Sibling decision\n');
  const evidencePath = path.join(f.checkout, '.harness', 'evidence.json');
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  const siblingId = randomUUID();
  evidence.evidence.push({ ...evidence.evidence[0], id: siblingId, location: { path: sibling }, hash: sha256(await readFile(siblingPath)) });
  await writeFile(evidencePath, JSON.stringify(evidence));
  const modelPath = path.join(f.checkout, '.harness', 'model', 'main.c4');
  await writeFile(modelPath, (await readFile(modelPath, 'utf8')).replace(`evidence "${f.evidenceId}"`, `evidence "${f.evidenceId} ${siblingId}"`));
  const baseline = await f.manager.status(f.skillsRoot);
  await f.manager.verify(proof(baseline, f.initialized.worktree), f.skillsRoot);
  await writeFile(f.document, 'Changed linked decision\n');
  await writeFile(siblingPath, 'Changed sibling decision\n');
  const changed = await f.manager.status(f.skillsRoot);
  assert.ok(changed.diagnostics.some(item => item.code === 'EVIDENCE_CHANGED' && item.evidenceId === f.evidenceId));
  assert.ok(changed.diagnostics.some(item => item.code === 'EVIDENCE_CHANGED' && item.evidenceId === siblingId));
  for (const item of evidence.evidence) item.hash = sha256(await readFile(path.join(f.checkout, item.location.path)));
  await writeFile(evidencePath, JSON.stringify(evidence));
  const repaired = await f.manager.status(f.skillsRoot);
  const partial = await f.manager.verify(proof(repaired, f.initialized.worktree, { scope: { paths: [f.targetRelative], entities: [] } }), f.skillsRoot);
  assert.equal(partial.state, 'pending');
  assert.ok(partial.pendingPaths.includes(sibling));
  assert.ok(!partial.pendingPaths.includes(f.relative));
  const current = await f.manager.status(f.skillsRoot);
  const complete = await f.manager.verify(proof(current, f.initialized.worktree, { scope: { paths: [sibling], entities: [] } }), f.skillsRoot);
  assert.equal(complete.state, 'verified', JSON.stringify({ pendingPaths: complete.pendingPaths }));
  assert.deepEqual(complete.pendingPaths, []);
});

test('TC07 referenced documents inside .harness invalidate old proofs after a byte rollback', async t => {
  const f = await referencedDocument(t, { relative: '.harness/retained.md' });
  const baseline = await f.manager.status(f.skillsRoot);
  const oldProof = proof(baseline, f.initialized.worktree);
  const verified = await f.manager.verify({ ...oldProof, requestId: randomUUID() }, f.skillsRoot);
  await writeFile(f.document, 'Changed retained decision\n');
  await until(() => f.manager.currentState().sourceEpoch > verified.sourceEpoch, 'referenced .harness document change');
  const changed = await f.manager.status(f.skillsRoot);
  assert.equal(changed.state, 'pending');
  assert.ok(changed.pendingPaths.includes(f.relative));
  await writeFile(f.document, 'Confirmed decision\n');
  await until(() => f.manager.currentState().sourceEpoch > changed.sourceEpoch, 'referenced .harness document rollback');
  const restored = await f.manager.status(f.skillsRoot);
  assert.deepEqual(restored.sourceVersion, baseline.sourceVersion);
  assert.equal(restored.sourceScanRevision, baseline.sourceScanRevision);
  assert.equal(restored.modelRevision, baseline.modelRevision);
  await assert.rejects(f.manager.verify(oldProof, f.skillsRoot), error => error.code === 'SYNC_RACE');
  const current = await f.manager.status(f.skillsRoot);
  assert.equal((await f.manager.verify(proof(current, f.initialized.worktree), f.skillsRoot)).state, 'verified');
});

test('TC08 changed referenced documents remain visible and cannot be cleared by a passing caller declaration', async t => {
  const f = await referencedDocument(t);
  const baseline = await f.manager.status(f.skillsRoot);
  assert.equal((await f.manager.verify(proof(baseline, f.initialized.worktree), f.skillsRoot)).state, 'verified');
  await writeFile(f.document, 'Changed decision\n');
  const changed = await f.manager.status(f.skillsRoot);
  await assert.rejects(f.manager.verify(proof(changed, f.initialized.worktree), f.skillsRoot), error => {
    assert.equal(error.code, 'SYNC_UNRESOLVED');
    assert.ok(error.details.result.diagnostics.some(item => item.code === 'EVIDENCE_CHANGED' && item.file === f.relative));
    assert.equal(error.details.result.automaticChecks.find(item => item.name === 'referenced-evidence').status, 'failed');
    return true;
  });
  assert.notEqual(f.manager.currentState().state, 'verified');
});

test('TC06 referenced document Git diagnostics distinguish ignored and untracked files without staging them', async t => {
  const f = await referencedDocument(t, { relative: 'ignored/设计 [draft].md' });
  const indexPath = path.join(f.checkout, '.git', 'index');
  const originalIndex = await readFile(indexPath);
  const ignored = await f.manager.status(f.skillsRoot);
  assert.ok(ignored.diagnostics.some(item => item.code === 'EVIDENCE_IGNORED' && item.file === f.relative));
  assert.equal((await f.manager.verify(proof(ignored, f.initialized.worktree), f.skillsRoot)).state, 'verified', 'Git advice does not require staging to verify healthy evidence');
  assert.deepEqual(await readFile(indexPath), originalIndex);
  await git(f.checkout, 'add', '-f', '--', f.relative);
  const tracked = await f.manager.status(f.skillsRoot);
  assert.ok(!tracked.diagnostics.some(item => ['EVIDENCE_IGNORED', 'EVIDENCE_UNTRACKED'].includes(item.code)));
  await git(f.checkout, 'rm', '--cached', '--', f.relative);
  await writeFile(path.join(f.checkout, '.gitignore'), 'other-output/\n');
  const untracked = await f.manager.status(f.skillsRoot);
  assert.ok(untracked.diagnostics.some(item => item.code === 'EVIDENCE_UNTRACKED' && item.file === f.relative));
});

test('TC07 explicit document references stay observed outside the source scan and reject proofs after a byte rollback', async t => {
  const f = await referencedDocument(t, { relative: 'ignored/decision.md' });
  const baseline = await f.manager.status(f.skillsRoot);
  const oldProof = proof(baseline, f.initialized.worktree);
  const verified = await f.manager.verify({ ...oldProof, requestId: randomUUID() }, f.skillsRoot);
  await writeFile(f.document, 'Changed ignored reference\n');
  await until(() => f.manager.currentState().sourceEpoch > verified.sourceEpoch, 'explicit reference change');
  assert.equal(f.manager.currentState().state, 'pending');
  const changed = await f.manager.status(f.skillsRoot);
  assert.deepEqual(changed.sourceVersion, baseline.sourceVersion, 'Reference observation does not expand the source manifest');
  assert.ok(changed.diagnostics.some(item => item.code === 'EVIDENCE_CHANGED'));
  await writeFile(f.document, 'Confirmed decision\n');
  await until(() => f.manager.currentState().sourceEpoch > changed.sourceEpoch, 'explicit reference rollback');
  const restored = await f.manager.status(f.skillsRoot);
  assert.deepEqual(restored.sourceVersion, baseline.sourceVersion);
  await assert.rejects(f.manager.verify(oldProof, f.skillsRoot), error => {
    assert.equal(error.code, 'SYNC_RACE', JSON.stringify(error.details?.result));
    return true;
  });
  const current = await f.manager.status(f.skillsRoot);
  assert.equal((await f.manager.verify(proof(current, f.initialized.worktree), f.skillsRoot)).state, 'verified');
});

test('TC08 moving a missing document repairs current evidence while preserving the archived reference', async t => {
  const f = await referencedDocument(t);
  const baseline = await f.manager.status(f.skillsRoot);
  const archived = await f.archive.readSnapshot(baseline.lastValidModelSnapshotHash);
  await rm(f.document);
  const missing = await f.manager.status(f.skillsRoot);
  await assert.rejects(f.manager.verify(proof(missing, f.initialized.worktree), f.skillsRoot), error => {
    assert.equal(error.code, 'SYNC_UNRESOLVED');
    assert.ok(error.details.result.diagnostics.some(item => item.code === 'EVIDENCE_MISSING' && item.evidenceId === f.evidenceId));
    return true;
  });
  const moved = 'docs/retained-decision.md';
  await mkdir(path.join(f.checkout, 'docs'));
  await writeFile(path.join(f.checkout, moved), 'Confirmed decision\n');
  const evidencePath = path.join(f.checkout, '.harness', 'evidence.json');
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  evidence.evidence[0].location.path = moved;
  await writeFile(evidencePath, JSON.stringify(evidence));
  const repaired = await f.manager.status(f.skillsRoot);
  assert.equal((await f.manager.verify(proof(repaired, f.initialized.worktree), f.skillsRoot)).state, 'verified');
  const current = await f.archive.readSnapshot(f.manager.currentState().lastValidModelSnapshotHash);
  assert.equal(current.entities[0].id, f.entityId);
  assert.equal(current.evidence[0].id, f.evidenceId);
  assert.equal(current.evidence[0].location.path, moved);
  assert.deepEqual(await f.archive.readSnapshot(baseline.lastValidModelSnapshotHash), archived);
  assert.equal(archived.evidence[0].location.path, f.relative);
});

test('TC08 an unrelated local proof can be saved while referenced evidence remains unresolved', async t => {
  const f = await referencedDocument(t);
  const baseline = await f.manager.status(f.skillsRoot);
  await f.manager.verify(proof(baseline, f.initialized.worktree), f.skillsRoot);
  await writeFile(f.document, 'Changed decision\n');
  const changed = await f.manager.status(f.skillsRoot);
  const local = await f.manager.verify(proof(changed, f.initialized.worktree, { scope: { paths: ['other.ts'], entities: [] } }), f.skillsRoot);
  assert.equal(local.state, 'pending');
  assert.ok(local.pendingPaths.includes(f.relative));
  assert.equal(local.automaticChecks.find(item => item.name === 'referenced-evidence').status, 'passed');
  const entityScope = proof(local, f.initialized.worktree, { scope: { paths: [], entities: [f.entityId] } });
  await assert.rejects(f.manager.verify(entityScope, f.skillsRoot), error => error.code === 'SYNC_UNRESOLVED');
});

test('TC08 orphan evidence warnings do not block healthy current references to the same file', async t => {
  const f = await referencedDocument(t);
  const evidencePath = path.join(f.checkout, '.harness', 'evidence.json');
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  const orphanId = randomUUID();
  evidence.evidence.push({ ...evidence.evidence[0], id: orphanId, hash: '0'.repeat(64) });
  await writeFile(evidencePath, JSON.stringify(evidence));
  const state = await f.manager.status(f.skillsRoot);
  assert.ok(state.diagnostics.some(item => item.code === 'EVIDENCE_CHANGED' && item.evidenceId === orphanId));
  const verified = await f.manager.verify(proof(state, f.initialized.worktree), f.skillsRoot);
  assert.equal(verified.state, 'verified');
  assert.ok(verified.diagnostics.some(item => item.evidenceId === orphanId));
});

test('TC08 unreadable current evidence remains unresolved instead of being treated as a valid reference', async t => {
  const f = await referencedDocument(t);
  await rm(f.document);
  await mkdir(f.document);
  const state = await f.manager.status(f.skillsRoot);
  assert.ok(state.diagnostics.some(item => item.code === 'EVIDENCE_UNREADABLE' && item.evidenceId === f.evidenceId));
  await assert.rejects(f.manager.verify(proof(state, f.initialized.worktree), f.skillsRoot), error => error.code === 'SYNC_UNRESOLVED');
});

test('TC07 project-excluded evidence stays observed without changing the source scan policy', async t => {
  const f = await referencedDocument(t);
  const config = JSON.parse(await readFile(f.initialized.paths.config, 'utf8'));
  config.source.excludePatterns = [f.relative];
  await writeFile(f.initialized.paths.config, JSON.stringify(config));
  const baseline = await f.manager.status(f.skillsRoot);
  const verified = await f.manager.verify(proof(baseline, f.initialized.worktree), f.skillsRoot);
  await writeFile(f.document, 'Changed excluded decision\n');
  await until(() => f.manager.currentState().sourceEpoch > verified.sourceEpoch, 'project-excluded reference');
  const changed = await f.manager.status(f.skillsRoot);
  assert.deepEqual(changed.sourceVersion, baseline.sourceVersion);
  assert.equal(changed.sourceScanRevision, baseline.sourceScanRevision);
  assert.ok(changed.pendingPaths.includes(f.relative));
  await assert.rejects(f.manager.verify(proof(changed, f.initialized.worktree), f.skillsRoot), error => error.code === 'SYNC_UNRESOLVED');
});

test('TC08 Windows case-equivalent proof paths reject changed evidence and clear repaired aliases', async t => {
  if (process.platform !== 'win32') { t.skip('Requires native case-insensitive Windows path lookup'); return; }
  const f = await referencedDocument(t, { relative: 'ignored/decision.md' });
  const evidencePath = path.join(f.checkout, '.harness', 'evidence.json');
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  evidence.evidence[0].location.path = f.relative.toUpperCase();
  await writeFile(evidencePath, JSON.stringify(evidence));
  const baseline = await f.manager.status(f.skillsRoot);
  const verified = await f.manager.verify(proof(baseline, f.initialized.worktree), f.skillsRoot);
  await writeFile(f.document, 'Changed case-aliased decision\n');
  await until(() => f.manager.currentState().sourceEpoch > verified.sourceEpoch, 'case-equivalent proof input change');
  const changed = await f.manager.status(f.skillsRoot);
  const scope = { paths: [f.relative], entities: [] };
  await assert.rejects(f.manager.verify(proof(changed, f.initialized.worktree, { scope }), f.skillsRoot), error => {
    assert.equal(error.code, 'SYNC_UNRESOLVED');
    assert.equal(error.details.result.automaticChecks.find(item => item.name === 'referenced-evidence').status, 'failed');
    return true;
  });
  evidence.evidence[0].hash = sha256(await readFile(f.document));
  evidence.evidence[0].observedAt = new Date().toISOString();
  await writeFile(evidencePath, JSON.stringify(evidence));
  const repaired = await f.manager.status(f.skillsRoot);
  const result = await f.manager.verify(proof(repaired, f.initialized.worktree, { scope }), f.skillsRoot);
  assert.equal(result.state, 'verified');
  assert.deepEqual(result.pendingPaths, []);
});

test('TC07 Windows reference aliases with different casing still observe the real document', async t => {
  if (process.platform !== 'win32') { t.skip('Requires native case-insensitive Windows path lookup'); return; }
  const f = await referencedDocument(t, { relative: 'ignored/decision.md' });
  const evidencePath = path.join(f.checkout, '.harness', 'evidence.json');
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  evidence.evidence[0].location.path = f.relative.toUpperCase();
  await writeFile(evidencePath, JSON.stringify(evidence));
  const baseline = await f.manager.status(f.skillsRoot);
  const verified = await f.manager.verify(proof(baseline, f.initialized.worktree), f.skillsRoot);
  await writeFile(f.document, 'Changed case-aliased decision\n');
  await until(() => f.manager.currentState().sourceEpoch > verified.sourceEpoch, 'case-aliased reference event');
  const changed = await f.manager.status(f.skillsRoot);
  assert.equal(changed.state, 'pending');
  assert.ok(changed.diagnostics.some(item => item.code === 'EVIDENCE_CHANGED' && item.evidenceId === f.evidenceId));
});

test('TC07 initial status separates model validity from clean source and archives exact source rules', async (t) => {
  const f = await fixture(t);
  const state = await f.manager.status(f.skillsRoot);
  assert.equal(state.state, 'pending');
  assert.equal(state.modelState, 'valid');
  assert.equal(state.sourceVersion.status, 'clean');
  assert.equal(state.sourceEpoch, 0);
  assert.deepEqual(state.pendingPaths, ['.gitignore', 'README.md']);
  assert.ok(state.sourceScanRevision);
  const record = f.archive.records().at(-1);
  assert.equal(record.payload.kind, 'freshness-state');
  assert.ok(record.archives.length >= 4);
  for (const reference of record.archives) if (reference.kind === 'snapshot') await f.archive.readSnapshot(reference.hash);
});

test('TC08 local proof clears only its explicit source scope and failed checks retain unresolved paths', async (t) => {
  const f = await fixture(t, { extraSource: true });
  const current = await f.manager.status(f.skillsRoot);
  const local = await f.manager.verify(proof(current, f.initialized.worktree, { scope: { paths: ['README.md'], entities: [] } }), f.skillsRoot);
  assert.equal(local.state, 'pending');
  assert.deepEqual(local.pendingPaths, ['.gitignore', 'other.ts']);
  const failed = proof(local, f.initialized.worktree, { checks: [{ name: 'Review incomplete', status: 'unknown', evidence: [] }] });
  await assert.rejects(f.manager.verify(failed, f.skillsRoot), (error) => error?.code === 'SYNC_UNRESOLVED');
  assert.equal(f.manager.currentState().state, 'failed');
  assert.deepEqual(f.manager.currentState().pendingPaths, ['.gitignore', 'other.ts']);
  const final = await f.manager.verify(proof(f.manager.currentState(), f.initialized.worktree), f.skillsRoot);
  assert.equal(final.state, 'verified');
  assert.deepEqual(final.pendingPaths, []);
  assert.ok(final.proofId);
});

test('TC08 watched source writes and byte rollback advance the epoch and reject an old proof', async (t) => {
  const f = await fixture(t);
  const current = await f.manager.status(f.skillsRoot);
  const oldProof = proof(current, f.initialized.worktree);
  const baseline = await readFile(path.join(f.checkout, 'README.md'));
  await writeFile(path.join(f.checkout, 'README.md'), 'temporary source change\n');
  await until(() => f.manager.currentState().sourceEpoch > current.sourceEpoch, 'source watcher epoch');
  await writeFile(path.join(f.checkout, 'README.md'), baseline);
  await assert.rejects(f.manager.verify(oldProof, f.skillsRoot), (error) => error?.code === 'SYNC_RACE');
  assert.equal(f.manager.currentState().state, 'pending');
  assert.ok(f.manager.currentState().pendingPaths.includes('README.md'));
  const refreshed = await f.manager.status(f.skillsRoot);
  assert.equal(refreshed.sourceVersion.treeHash, current.sourceVersion.treeHash);
  assert.ok(refreshed.sourceEpoch > current.sourceEpoch);
  await f.manager.close();
  const reopened = await f.create();
  assert.ok(reopened.manager.currentState().sourceEpoch >= refreshed.sourceEpoch);
  assert.notEqual((await reopened.manager.status(f.skillsRoot)).state, 'verified');
});

test('TC07 native-ignored output and skill edits do not advance the source epoch', async (t) => {
  const f = await fixture(t);
  const baseline = await f.manager.status(f.skillsRoot);
  const verified = await f.manager.verify(proof(baseline, f.initialized.worktree), f.skillsRoot);
  await mkdir(path.join(f.checkout, 'ignored'));
  await writeFile(path.join(f.checkout, 'ignored', 'build.js'), 'ignored output');
  await writeFile(path.join(f.skillsRoot, 'SKILL.md'), 'editable skill bytes');
  await delay(500);
  const current = await f.manager.status(f.skillsRoot);
  assert.equal(current.sourceEpoch, verified.sourceEpoch);
  assert.equal(current.state, 'verified');
  assert.equal(current.sourceVersion.treeHash, verified.sourceVersion.treeHash);
  await rm(path.join(f.checkout, 'ignored'), { recursive: true });
  await delay(500);
  const afterIgnoredDeletion = await f.manager.status(f.skillsRoot);
  assert.equal(afterIgnoredDeletion.sourceEpoch, verified.sourceEpoch);
  assert.equal(afterIgnoredDeletion.state, 'verified');
});

test('TC07 model-only changes return pending without advancing sourceEpoch', async (t) => {
  const f = await fixture(t);
  const baseline = await f.manager.status(f.skillsRoot);
  const verified = await f.manager.verify(proof(baseline, f.initialized.worktree), f.skillsRoot);
  const modelFile = path.join(f.checkout, '.harness', 'model', 'main.c4');
  const original = await readFile(modelFile, 'utf8');
  await writeFile(modelFile, original.replace('Project boundary;', 'Updated project boundary;'));
  await until(() => f.manager.currentState().state === 'pending', 'model pending');
  const current = await f.manager.status(f.skillsRoot);
  assert.equal(current.sourceEpoch, verified.sourceEpoch);
  assert.notEqual(current.modelRevision, verified.modelRevision);
  assert.equal(current.state, 'pending');
});

test('TC08 verification rechecks source inside the shared commit queue', async (t) => {
  const f = await fixture(t);
  const baseline = await f.manager.status(f.skillsRoot);
  const request = proof(baseline, f.initialized.worktree);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const held = f.serial(async () => gate);
  let queued;
  const queuedPromise = new Promise((resolve) => { queued = resolve; });
  f.watchQueue(queued);
  const attempt = f.manager.verify(request, f.skillsRoot);
  await queuedPromise;
  f.watchQueue(undefined);
  await writeFile(path.join(f.checkout, 'README.md'), 'write after preflight, before commit\n');
  release();
  await held;
  await assert.rejects(attempt, (error) => error?.code === 'SYNC_RACE');
  assert.equal(f.manager.currentState().state, 'pending');
});

test('TC09 invalid current models retain the last valid identity and cannot produce a successful proof', async (t) => {
  const f = await fixture(t);
  const baseline = await f.manager.status(f.skillsRoot);
  const request = proof(baseline, f.initialized.worktree);
  await writeFile(path.join(f.checkout, '.harness', 'model', 'main.c4'), 'not valid LikeC4 {');
  const current = await f.manager.status(f.skillsRoot);
  assert.equal(current.modelState, 'invalid');
  assert.equal(current.modelRevision, baseline.modelRevision);
  assert.ok(current.attemptedModelRevision);
  assert.notEqual(current.attemptedModelRevision, baseline.modelRevision);
  assert.equal(current.sourceVersion.status, 'clean');
  await assert.rejects(f.manager.verify(request, f.skillsRoot), (error) => ['MODEL_INVALID', 'SYNC_UNRESOLVED'].includes(error?.code));
  assert.notEqual(f.manager.currentState().state, 'verified');
});

test('TC08 proof replay returns the original receipt without clearing newer pending state', async (t) => {
  const f = await fixture(t);
  const baseline = await f.manager.status(f.skillsRoot);
  const request = proof(baseline, f.initialized.worktree);
  const result = await f.manager.verify(request, f.skillsRoot);
  await writeFile(path.join(f.checkout, 'README.md'), 'later source\n');
  await until(() => f.manager.currentState().sourceEpoch > result.sourceEpoch, 'newer pending source');
  await f.manager.status(f.skillsRoot);
  const before = f.archive.seq;
  const replay = await f.manager.verify(request, f.skillsRoot);
  assert.equal(replay.replayed, true);
  assert.equal(replay.proofId, result.proofId);
  assert.equal(replay.state, 'verified');
  assert.equal(f.manager.currentState().state, 'pending');
  assert.equal(f.archive.seq, before);
});

test('TC08 invalid declared scope is recorded as a failure without leaving verifying state', async (t) => {
  const f = await fixture(t);
  const baseline = await f.manager.status(f.skillsRoot);
  const request = proof(baseline, f.initialized.worktree, { scope: { paths: ['README.md'], entities: [randomUUID()] } });
  await assert.rejects(f.manager.verify(request, f.skillsRoot), (error) => error?.code === 'INVALID_ARGUMENT');
  assert.equal(f.manager.currentState().state, 'failed');
  assert.deepEqual(f.manager.currentState().pendingPaths, baseline.pendingPaths);
});

test('TC07 exclusion-policy changes advance epoch even when selected source bytes are unchanged', async (t) => {
  const f = await fixture(t);
  const baseline = await f.manager.status(f.skillsRoot);
  const oldProof = proof(baseline, f.initialized.worktree);
  const config = JSON.parse(await readFile(f.initialized.paths.config, 'utf8'));
  config.source.excludePatterns = ['future-output/**'];
  await writeFile(f.initialized.paths.config, JSON.stringify(config));
  const current = await f.manager.status(f.skillsRoot);
  assert.deepEqual(current.sourceVersion, baseline.sourceVersion);
  assert.notEqual(current.sourceScanRevision, baseline.sourceScanRevision);
  assert.ok(current.sourceEpoch > baseline.sourceEpoch);
  await assert.rejects(f.manager.verify(oldProof, f.skillsRoot), (error) => error?.code === 'SYNC_RACE');
});

test('TC08 unknown source rules cannot be replaced by an empty successful verification scope', async (t) => {
  const f = await fixture(t);
  const baseline = await f.manager.status(f.skillsRoot);
  await rm(f.globalIgnore);
  await mkdir(f.globalIgnore);
  const current = await f.manager.status(f.skillsRoot);
  assert.equal(current.sourceVersion.status, 'unknown');
  assert.equal(current.sourceVersion.treeHash, null);
  assert.equal(current.sourceScanRevision, null);
  assert.notEqual(current.state, 'verified');
  await assert.rejects(f.manager.verify(proof(baseline, f.initialized.worktree), f.skillsRoot), (error) => error?.code === 'SYNC_UNRESOLVED');
});

test('TC16 missing freshness archives degrade synchronization while intact archive receipts remain readable', async (t) => {
  const f = await fixture(t);
  const baseline = await f.manager.status(f.skillsRoot);
  const intactReceipt = f.archive.records().at(-1).receiptHash;
  await f.manager.close();
  await rm(path.join(f.archive.root, 'snapshots', baseline.lastCompleteSource.references.manifest + '.json'));
  const reopened = await f.create();
  assert.equal(reopened.manager.currentState().state, 'unknown');
  assert.equal(reopened.archive.status, 'recovery-required');
  assert.ok(await reopened.archive.readSnapshot(intactReceipt));
  await assert.rejects(reopened.manager.status(f.skillsRoot), (error) => error?.code === 'ARCHIVE_CORRUPT');
});
