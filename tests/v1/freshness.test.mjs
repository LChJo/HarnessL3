import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile as callbackExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkspaceRegistry } from '../../build/core/workspace.js';
import { Archive } from '../../build/core/archive.js';
import { FreshnessManager } from '../../build/core/freshness.js';

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
