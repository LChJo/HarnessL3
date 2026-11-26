import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, readdir, writeFile, lstat, appendFile, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Runtime } from '../../build/core/runtime.js';
import { Archive } from '../../build/core/archive.js';
import { PackedArchiveStore, PACK_FILE, PACK_FORMAT_FILE, PACK_FORMAT } from '../../build/core/packed-archive.js';
import { canonicalJson, sha256 } from '../../build/core/json.js';
import { fixture } from './helpers.mjs';
import { spaceDecision } from '../../scripts/v1/migrate-packed-storage.mjs';

const exec = promisify(execFile);
const migration = path.resolve('scripts/v1/migrate-packed-storage.mjs');
const run = (source, target, ...flags) => exec(process.execPath, [migration, '--source', source, '--target', target, ...flags], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });

test('TC32 real fresh CLI service initializes packed storage; legacy roots remain explicit', async t => {
  const f = await fixture(t, 'harnessl3-packed-default-', { legacy: false }); const root = await f.repository();
  const init = await f.cli(['init'], { cwd: root }); assert.equal(init.code, 0, init.stdout + init.stderr);
  const registry = JSON.parse(await readFile(path.join(f.dataRoot, 'registry.json'), 'utf8'));
  assert.equal(registry.schemaVersion, 2);
  const started = await f.cli(['task', 'start', '--title', 'Packed default'], { cwd: root }); assert.equal(started.code, 0, started.stdout + started.stderr);
  const taskId = started.body.data.taskId;
  const chosen = await f.cli(['task', 'select', taskId], { cwd: root }); assert.equal(chosen.code, 0, chosen.stdout + chosen.stderr);
  const stored = await f.cli(['runtime', 'diagnostics'], { cwd: root }); assert.equal(stored.code, 0, stored.stdout + stored.stderr);
  assert.equal(stored.body.data.result.packed.commits, 2);
  await assert.rejects(lstat(path.join(f.dataRoot, 'worktrees', init.body.target.worktreeId, 'journal.jsonl')), { code: 'ENOENT' });
  const audit = await f.cli(['archive', 'audit'], { cwd: root }); assert.equal(audit.code, 0, audit.stdout + audit.stderr);
  assert.equal((await f.cli(['serve', 'stop'])).code, 0);
  const reopened = await f.cli(['task', 'handoff', taskId], { cwd: root }); assert.equal(reopened.code, 0, reopened.stdout + reopened.stderr);
});

test('TC34 verified offline migration preserves original record and content bytes, deduplicates across workspaces and allows new transactions', async t => {
  const f = await fixture(t);
  const roots = [await f.repository(), await f.repository()]; await mkdir(f.dataRoot, { recursive: true });
  let runtime = new Runtime(f.dataRoot);
  const call = (cwd, operation, positionals = [], flags = {}, requestId = randomUUID(), input) => runtime.execute({ operation, positionals, flags, cwd, requestId, ...(input ? { input } : {}) });
  const worktrees = [];
  const starts = [];
  try {
    for (const root of roots) {
      const init = await call(root, 'init'); assert.equal(init.ok, true, JSON.stringify(init));
      worktrees.push(init.target.worktreeId);
      const entry = await call(root, 'task start', [], { title: 'Original history' }); assert.equal(entry.ok, true, JSON.stringify(entry)); starts.push(entry);
      const selectId = randomUUID();
      const selected = await call(root, 'task select', [entry.data.taskId], {}, selectId, { schemaVersion: 1, requestId: selectId, context: { expand: [], read: [], known: {} }, skills: [] });
      assert.equal(selected.ok, true, JSON.stringify(selected));
    }
    await runtime.close();
    const common = { immutable: 'same bytes across workspaces' };
    const hash = await new Archive(path.join(f.dataRoot, 'worktrees', worktrees[0])).snapshot('shared', common);
    assert.equal(await new Archive(path.join(f.dataRoot, 'worktrees', worktrees[1])).snapshot('shared', common), hash);
    const original = await readFile(path.join(f.dataRoot, 'worktrees', worktrees[0], 'snapshots', hash + '.json'));
    const journals = await Promise.all(worktrees.map(id => readFile(path.join(f.dataRoot, 'worktrees', id, 'journal.jsonl'))));
    const registry = await readFile(path.join(f.dataRoot, 'registry.json'));
    const target = path.join(path.dirname(f.dataRoot), 'converted store');
    const preview = await run(f.dataRoot, target);
    const previewBody = JSON.parse(preview.stdout.trim());
    assert.equal(previewBody.mode, 'dry-run');
    assert.equal(previewBody.totals.journal.files, worktrees.length, 'inventory layers business journals');
    assert.ok(previewBody.totals.snapshots.files > 0);
    assert.ok(previewBody.totals.tasks.files >= worktrees.length, 'inventory layers task materializations');
    assert.equal(previewBody.spaceSufficient, true);
    await assert.rejects(lstat(target), { code: 'ENOENT' });
    const converted = await run(f.dataRoot, target, '--apply');
    assert.equal(JSON.parse(converted.stdout.trim().split('\n').at(-1)).status, 'verified-copy');
    const report = JSON.parse(await readFile(path.join(target, 'migration-report.json'), 'utf8'));
    assert.ok(report.packedCounts.uniqueContents < report.packedCounts.files);
    for (const item of report.worktrees) {
      assert.equal(item.semantic.retention.windowMs, 60 * 86400000, 'the 60-day boundary is checked on converted records');
      assert.ok(item.semantic.retention.checked >= 1);
      assert.ok(item.semantic.retention.withinWindow >= 1);
      assert.equal(item.semantic.retention.checked, item.semantic.retention.withinWindow + item.semantic.retention.expired);
    }
    assert.deepEqual(await readFile(path.join(f.dataRoot, 'registry.json')), registry);
    const packed = new PackedArchiveStore(path.join(target, PACK_FILE));
    try {
      assert.deepEqual(packed.getFile(worktrees[0], 'snapshot', hash + '.json'), original);
      for (let i = 0; i < worktrees.length; i++) {
        const id = worktrees[i], records = [];
        for (let seq = 1; seq <= packed.latest(id).seq; seq++) records.push(packed.rawRecord(id, seq));
        assert.deepEqual(Buffer.concat(records), journals[i]);
        assert.deepEqual(await readFile(path.join(f.dataRoot, 'worktrees', id, 'journal.jsonl')), journals[i]);
      }
    } finally { packed.close(); }
    runtime = new Runtime(target);
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i], receipt = starts[i];
      const handoff = await call(root, 'task handoff', [receipt.data.taskId]); assert.equal(handoff.ok, true, JSON.stringify(handoff));
      const replay = await call(root, 'task start', [], { title: 'Original history' }, receipt.requestId); assert.equal(replay.ok, true, JSON.stringify(replay)); assert.equal(replay.replayed, true); assert.deepEqual(replay.data, receipt.data);
      const next = await call(root, 'task start', [], { title: 'New packed task' }); assert.equal(next.ok, true, JSON.stringify(next));
      const selectionId = randomUUID();
      const selected = await call(root, 'task select', [next.data.taskId], {}, selectionId, { schemaVersion: 1, requestId: selectionId, context: { expand: [], read: [next.data.directory.items[0].id], known: {} }, skills: [] });
      assert.equal(selected.ok, true, JSON.stringify(selected));
      const queryId = randomUUID();
      const queried = await call(root, 'context query', [next.data.taskId], {}, queryId, { schemaVersion: 1, requestId: queryId, read: [], expand: [next.data.directory.items[0].id], known: {} });
      assert.equal(queried.ok, true, JSON.stringify(queried));
      const resource = await runtime.worktreeResources(await runtime.registry().worktree(worktrees[i]), true);
      assert.equal(resource.archive.format, 'packed-sqlite/1');
      assert.ok(!(await readdir(resource.archive.root)).includes('journal.jsonl'));
      const rows = resource.archive.records({ kind: 'task', taskId: next.data.taskId });
      assert.equal(rows.length, 3);
      assert.equal(rows[1].payload.task.encoding, 'task-delta/1');
      assert.equal(rows[2].payload.task.encoding, 'task-delta/1');
      assert.equal(rows[2].payload.task.batches, undefined);
      assert.equal(rows[2].payload.task.append.value.packet, undefined);
      const restored = await call(root, 'task handoff', [next.data.taskId]); assert.equal(restored.ok, true, JSON.stringify(restored));
      assert.deepEqual(restored.data.packet, selected.data.packet);
      assert.equal((await call(root, 'archive audit')).ok, true);
    }
  } finally { await runtime.close(); }
});

test('TC32 content-defined packed blocks preserve exact bytes while deduplicating repeated large paths', async t => {
  const f = await fixture(t); await mkdir(f.dataRoot, { recursive: true });
  const store = new PackedArchiveStore(path.join(f.dataRoot, PACK_FILE), true);
  try {
    const worktree = randomUUID(), paths = Array.from({ length: 8000 }, (_, i) => `src/module-${String(i).padStart(5, '0')}/generated/source.ts`);
    const values = Array.from({ length: 10 }, (_, i) => Buffer.from(JSON.stringify({ epoch: i, pendingPaths: paths })));
    for (let i = 0; i < values.length; i++) store.putFile(worktree, 'snapshot', `state-${i}`, values[i]);
    for (let i = 0; i < values.length; i++) assert.deepEqual(store.getFile(worktree, 'snapshot', `state-${i}`), values[i]);
    const counts = store.counts();
    assert.equal(counts.uniqueContents, values.length);
    assert.ok(counts.uniqueBlocks > 0);
    assert.ok(counts.packedBytes < counts.rawBytes / 10, JSON.stringify(counts));
    assert.equal(store.verifyContents(), 10);
  } finally { store.close(); }
});

test('TC32 25 linked worktrees share immutable model and selected skill bytes while long task batches stay isolated', async t => {
  const f = await fixture(t, 'harnessl3-packed-multi-', { legacy: false });
  await mkdir(f.dataRoot, { recursive: true });
  new PackedArchiveStore(path.join(f.dataRoot, PACK_FILE), true).close();
  await writeFile(path.join(f.dataRoot, PACK_FORMAT_FILE), canonicalJson(PACK_FORMAT) + '\n');
  const root = await f.repository(); let runtime = new Runtime(f.dataRoot);
  const call = async (cwd, operation, positionals = [], flags = {}, input) => {
    const requestId = input?.requestId ?? randomUUID();
    const response = await runtime.execute({ operation, positionals, flags, cwd, requestId, ...(input ? { input } : {}) });
    assert.equal(response.ok, true, JSON.stringify(response)); return response;
  };
  const roots = [root], tasks = [], worktrees = new Set(); let lastPacket, firstBatch;
  try {
    await call(root, 'init');
    await f.git(root, 'add', '.harness'); await f.git(root, 'commit', '-m', 'Fixture model');
    for (let i = 1; i < 25; i++) {
      const linked = path.join(f.directory, `linked-${i}`); await f.git(root, 'worktree', 'add', '-b', `branch-${i}`, linked);
      await call(linked, 'worktree register', [linked]); roots.push(linked);
    }
    for (let i = 0; i < roots.length; i++) {
      const cwd = roots[i], entry = await call(cwd, 'task start', [], { title: `Isolated task ${i}` });
      const item = entry.data.directory.items[0], taskId = entry.data.taskId;
      const selected = await call(cwd, 'task select', [taskId], {}, { schemaVersion: 1, requestId: randomUUID(), context: { expand: [], read: [item.id], known: {} }, skills: [{ id: 'development/implement', reason: 'Shared immutable method' }] });
      tasks.push({ taskId, target: entry.target, packet: selected.data.packet, plan: selected.data.skillPlan }); worktrees.add(entry.target.worktreeId);
      if (i === 0) {
        firstBatch = selected.data.result.batchId; lastPacket = selected.data.packet;
        for (let j = 0; j < 20; j++) {
          await call(cwd, 'context query', [taskId], {}, { schemaVersion: 1, requestId: randomUUID(), expand: [item.id], read: [], known: {} });
        }
        const resource = await runtime.worktreeResources(await runtime.registry().worktree(entry.target.worktreeId), true);
        const records = resource.archive.records({ kind: 'task', taskId });
        assert.equal(records.length, 22);
        assert.ok(records.slice(1).every(record => record.payload.task.encoding === 'task-delta/1' && !('batches' in record.payload.task) && !('packet' in record.payload.task.append.value)));
      }
      await runtime.expireIdleResources(Number.MAX_SAFE_INTEGER);
    }
    assert.equal(worktrees.size, 25);
    assert.equal(new Set(tasks.map(task => task.target.projectId)).size, 1);
    const diagnostics = (await call(root, 'runtime diagnostics')).data.result;
    assert.equal(diagnostics.packed.commits, 70); assert.equal(diagnostics.loadedWorktrees, 0);
    assert.ok(diagnostics.packed.uniqueContents < diagnostics.packed.files, JSON.stringify(diagnostics.packed));
    await runtime.close(); runtime = new Runtime(f.dataRoot);
    for (let i = 0; i < roots.length; i++) {
      const handoff = await call(roots[i], 'task handoff', [tasks[i].taskId]);
      assert.deepEqual(handoff.data.packet, tasks[i].packet); assert.deepEqual(handoff.data.skillPlan, tasks[i].plan);
    }
    const original = await call(root, 'task handoff', [tasks[0].taskId], { batch: firstBatch }); assert.deepEqual(original.data.packet, lastPacket);
  } finally { await runtime.close(); }
});

test('TC34 corrupt referenced original prevents publishing the target format', async t => {
  const f = await fixture(t); const root = await f.repository(); await mkdir(f.dataRoot, { recursive: true });
  const runtime = new Runtime(f.dataRoot);
  let worktree;
  try {
    const init = await runtime.execute({ operation: 'init', positionals: [], flags: {}, cwd: root, requestId: randomUUID() });
    worktree = init.target.worktreeId;
    const started = await runtime.execute({ operation: 'task start', positionals: [], flags: { title: 'Protected history' }, cwd: root, requestId: randomUUID() });
    assert.equal(started.ok, true);
  } finally { await runtime.close(); }
  const archive = new Archive(path.join(f.dataRoot, 'worktrees', worktree), { readOnly: true }); await archive.ready();
  const reference = archive.references().find(r => r.kind === 'snapshot');
  const sourceFile = path.join(archive.root, 'snapshots', reference.hash + '.json'); await writeFile(sourceFile, 'invalid original');
  const target = path.join(path.dirname(f.dataRoot), 'incomplete store');
  await assert.rejects(run(f.dataRoot, target, '--apply'), error => error.code === 1);
  await assert.rejects(lstat(path.join(target, PACK_FORMAT_FILE)), { code: 'ENOENT' });
  assert.equal(await readFile(sourceFile, 'utf8'), 'invalid original');
});

test('TC34 explicit resume verifies prepared mappings and preserves an incomplete original journal tail', async t => {
  const f = await fixture(t); const root = await f.repository(); await mkdir(f.dataRoot, { recursive: true });
  const runtime = new Runtime(f.dataRoot); let id;
  try {
    const init = await runtime.execute({ operation: 'init', positionals: [], flags: {}, cwd: root, requestId: randomUUID() }); id = init.target.worktreeId;
    const started = await runtime.execute({ operation: 'task start', positionals: [], flags: { title: 'Interrupted source' }, cwd: root, requestId: randomUUID() }); assert.equal(started.ok, true);
  } finally { await runtime.close(); }
  const source = await realpath(f.dataRoot), targetPath = path.join(path.dirname(source), 'resumed target'); await mkdir(targetPath);
  const target = await realpath(targetPath), sourceRegistry = await readFile(path.join(source, 'registry.json'));
  const state = { schemaVersion: 1, source, target, registryHash: sha256(sourceRegistry) };
  await writeFile(path.join(target, 'migration-state.json'), canonicalJson(state) + '\n');
  const store = new PackedArchiveStore(path.join(target, PACK_FILE), true);
  try {
    store.setMeta('migration-source', state);
    const folder = path.join(source, 'worktrees', id, 'snapshots'), name = (await readdir(folder))[0];
    store.putFile(id, 'snapshot', name, await readFile(path.join(folder, name)));
  } finally { store.close(); }
  const journal = path.join(source, 'worktrees', id, 'journal.jsonl'), complete = await readFile(journal), tail = Buffer.from('{"schemaVersion":1,"partial":');
  await appendFile(journal, tail);
  const converted = await run(source, target, '--apply', '--resume');
  assert.equal(JSON.parse(converted.stdout.trim().split('\n').at(-1)).status, 'verified-copy');
  assert.deepEqual(await readFile(journal), Buffer.concat([complete, tail]));
  assert.deepEqual(await readFile(path.join(target, 'worktrees', id, 'diagnostics', 'migration-original-tail')), tail);
  const report = JSON.parse(await readFile(path.join(target, 'migration-report.json'), 'utf8'));
  assert.equal(report.worktrees[0].journal.tail.hash, sha256(tail));
  assert.equal(report.worktrees[0].journal.hash, sha256(Buffer.concat([complete, tail])));
});

test('TC34 migration space gate refuses an undersized destination and stays unknown without a probe', async () => {
  assert.deepEqual(spaceDecision(1000, 500), { status: 'sufficient', freeBytes: 1000, sourceBytes: 500 });
  assert.deepEqual(spaceDecision(500, 500), { status: 'sufficient', freeBytes: 500, sourceBytes: 500 });
  assert.deepEqual(spaceDecision(499, 500), { status: 'insufficient', freeBytes: 499, sourceBytes: 500 });
  assert.deepEqual(spaceDecision(null, 500), { status: 'unknown', freeBytes: null, sourceBytes: 500 });
  assert.equal(spaceDecision(-1, 500).status, 'invalid');
  assert.equal(spaceDecision(1000, -5).status, 'invalid');
});

test('TC32 long task delta chains are re-baselined periodically and stay exactly reconstructable', async t => {
  const f = await fixture(t, 'harnessl3-packed-baseline-', { legacy: false }); const root = await f.repository();
  const init = await f.cli(['init'], { cwd: root }); assert.equal(init.code, 0, init.stdout + init.stderr);
  const started = await f.cli(['task', 'start', '--title', 'Long chain'], { cwd: root }); assert.equal(started.code, 0, started.stdout + started.stderr);
  const taskId = started.body.data.taskId, directoryId = started.body.data.directory.items[0].id;
  const query = () => f.cli(['context', 'query', taskId, '--file', '-'], { cwd: root, input: JSON.stringify({ schemaVersion: 1, requestId: randomUUID(), expand: [directoryId], read: [], known: {} }) });
  for (let i = 0; i < 40; i++) { const queried = await query(); assert.equal(queried.code, 0, queried.stdout + queried.stderr); }
  const before = await f.cli(['task', 'handoff', taskId], { cwd: root }); assert.equal(before.code, 0, before.stdout + before.stderr);
  assert.equal((await f.cli(['serve', 'stop'])).code, 0);
  const store = new PackedArchiveStore(path.join(f.dataRoot, PACK_FILE));
  try {
    const id = init.body.target.worktreeId;
    const encodings = [];
    for (const header of store.headers(id, { kind: 'task', taskId })) encodings.push(store.record(id, header.seq).payload.task.encoding ?? 'full');
    assert.ok(encodings.length >= 41);
    assert.equal(encodings[0], 'full');
    let run = 0, maxRun = 0, fulls = 0;
    for (const encoding of encodings) { if (encoding === 'full') { fulls++; run = 0; } else { run++; maxRun = Math.max(maxRun, run); } }
    assert.ok(fulls >= 2, 'a long chain must contain a periodic full baseline');
    assert.ok(maxRun <= 32, `delta runs stay bounded, saw ${maxRun}`);
  } finally { store.close(); }
  const after = await f.cli(['task', 'handoff', taskId], { cwd: root }); assert.equal(after.code, 0, after.stdout + after.stderr);
  assert.deepEqual(after.body.data.packet, before.body.data.packet);
});
