import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Runtime } from '../../build/core/runtime.js';
import { CurrentStateStore } from '../../build/core/current-state.js';
import { fixture } from './helpers.mjs';

test('TC32 ordinary status replaces one current checkpoint, never a receipt or source snapshot; proof stays durable', async t => {
  const f = await fixture(t);
  const root = await f.repository(); await mkdir(f.dataRoot, { recursive: true });
  let runtime = new Runtime(f.dataRoot);
  const call = (operation, input) => runtime.execute({ operation, positionals: [], flags: {}, cwd: root, requestId: input?.requestId ?? randomUUID(), ...(input ? { input } : {}) });
  try {
    const init = await call('init'); assert.equal(init.ok, true, JSON.stringify(init));
    const first = await call('sync status'); assert.equal(first.ok, true, JSON.stringify(first));
    const state = first.data.result;
    const archiveRoot = path.join(f.dataRoot, 'worktrees', init.target.worktreeId);
    const store = new CurrentStateStore(archiveRoot);
    const checkpoint = await store.load();
    assert.equal(checkpoint.seq, 0);
    assert.equal(checkpoint.state.sourceEpoch, state.sourceEpoch);
    assert.equal(checkpoint.source.manifest.content.entries.length, state.pendingPaths.length);
    assert.deepEqual(await readdir(path.join(archiveRoot, 'snapshots')), []);
    await writeFile(path.join(root, 'README.md'), 'changed state, no history\n');
    const current = await call('sync status'); assert.equal(current.ok, true, JSON.stringify(current));
    assert.equal((await store.load()).seq, 0);
    assert.deepEqual(await readdir(path.join(archiveRoot, 'snapshots')), []);
    const c = current.data.result;
    const proof = { schemaVersion: 1, requestId: randomUUID(), target: init.target, phaseId: randomUUID(), sourceEpoch: c.sourceEpoch, expectedSourceVersion: c.sourceVersion, expectedModelRevision: c.modelRevision, scope: { paths: c.pendingPaths, entities: [] }, disposition: 'no-semantic-change', reason: 'Reviewed current source', checks: [{ name: 'Fixture review', status: 'passed', evidence: ['README.md'] }] };
    const verified = await call('sync verify', proof); assert.equal(verified.ok, true, JSON.stringify(verified));
    assert.ok((await readdir(path.join(archiveRoot, 'snapshots'))).length >= 6);
    const journal = await readFile(path.join(archiveRoot, 'journal.jsonl'));
    assert.equal(journal.toString().trim().split('\n').length, 1);
    await runtime.close(); runtime = new Runtime(f.dataRoot);
    const replay = await call('sync verify', proof); assert.equal(replay.ok, true, JSON.stringify(replay)); assert.equal(replay.replayed, true);
    assert.deepEqual(await readFile(path.join(archiveRoot, 'journal.jsonl')), journal);
    const view = await runtime.view(init.target.worktreeId);
    assert.ok(view.model); assert.notEqual(view.freshness.state, 'verified');
  } finally { await runtime.close(); }
});

test('TC30 a corrupt current checkpoint cannot be mistaken for an empty state', async t => {
  const f = await fixture(t); const root = await f.repository(); await mkdir(f.dataRoot, { recursive: true });
  let runtime = new Runtime(f.dataRoot);
  const call = operation => runtime.execute({ operation, positionals: [], flags: {}, cwd: root, requestId: randomUUID() });
  try {
    const init = await call('init'); assert.equal(init.ok, true);
    const status = await call('sync status'); assert.equal(status.ok, true, JSON.stringify(status));
    await runtime.close();
    await writeFile(path.join(f.dataRoot, 'worktrees', init.target.worktreeId, 'current-state.sqlite'), 'corrupt');
    runtime = new Runtime(f.dataRoot);
    const rejected = await call('sync status'); assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'ARCHIVE_CORRUPT');
  } finally { await runtime.close(); }
});
