import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Archive } from '../../build/core/archive.js';
import { HarnessError } from '../../build/core/errors.js';
import { Runtime } from '../../build/core/runtime.js';
import { fixture } from './helpers.mjs';

test('TC33 resource expiry closes idle workspaces without changing task history or triggering source observation', async t => {
  const f = await fixture(t); const root = await f.repository(); await mkdir(f.dataRoot, { recursive: true });
  const runtime = new Runtime(f.dataRoot);
  const call = (operation, positionals = [], flags = {}) => runtime.execute({ operation, positionals, flags, cwd: root, requestId: randomUUID() });
  try {
    const init = await call('init'); assert.equal(init.ok, true);
    const task = await call('task start', [], { title: 'A passive snapshot' }); assert.equal(task.ok, true);
    const before = await call('runtime diagnostics'); assert.equal(before.ok, true, JSON.stringify(before));
    assert.equal(before.data.result.loadedWorktrees, 1);
    const resource = before.data.result.worktrees[0];
    assert.equal(resource.freshness.activeLease, false);
    assert.equal(resource.freshness.completeCaptures, 0);
    assert.equal(resource.observation.polling, false);
    const journal = path.join(f.dataRoot, 'worktrees', init.target.worktreeId, 'journal.jsonl'); const bytes = await readFile(journal);
    await runtime.expireIdleResources(Number.MAX_SAFE_INTEGER);
    const idle = await call('runtime diagnostics'); assert.equal(idle.data.result.loadedWorktrees, 0);
    assert.deepEqual(await readFile(journal), bytes);
    const handoff = await call('task handoff', [task.data.taskId]); assert.equal(handoff.ok, true, JSON.stringify(handoff));
    assert.deepEqual(await readFile(journal), bytes);
  } finally { await runtime.close(); }
});

test('TC33 low-space rejection cannot replace an intact receipt or create an uncommitted journal row', async t => {
  const f = await fixture(t); await mkdir(f.dataRoot, { recursive: true });
  const root = path.join(f.dataRoot, 'archive'); let low = false;
  const archive = new Archive(root, { capacity: async () => { if (low) throw new HarnessError('IO_ERROR', 'Injected disk-low condition', { reason: 'disk-space-low' }); } });
  const first = await archive.commit({ scope: 'first', requestId: randomUUID(), request: {}, payload: {}, receipt: { intact: true } });
  const before = await readFile(path.join(root, 'journal.jsonl')); const snapshots = await readdir(path.join(root, 'snapshots'));
  low = true;
  await assert.rejects(archive.commit({ scope: 'second', requestId: randomUUID(), request: {}, payload: {}, receipt: { new: true } }), { code: 'IO_ERROR' });
  assert.equal(archive.seq, first.seq);
  assert.deepEqual(await readFile(path.join(root, 'journal.jsonl')), before);
  assert.deepEqual(await readdir(path.join(root, 'snapshots')), snapshots);
  assert.deepEqual(await archive.receipt(first.seq), { intact: true });
});
