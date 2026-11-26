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
    assert.equal(idle.data.result.modelSharing.retainedVersions, 0);
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

test('TC33 background work rotates fairly across worktrees under the single-flight budget', async t => {
  const f = await fixture(t); await mkdir(f.dataRoot, { recursive: true });
  const runtime = new Runtime(f.dataRoot);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    const order = [];
    let active = 0, maxActive = 0;
    const slow = label => async () => {
      active++; maxActive = Math.max(maxActive, active); order.push(label + ':start');
      await delay(40);
      order.push(label + ':end'); active--;
    };
    // One workspace queues a burst; an independent workspace must wait only
    // for the current operation (round-robin), not the whole burst (the old
    // global FIFO did), while the frozen single-flight budget is preserved.
    const burst = [];
    for (let i = 0; i < 6; i++) burst.push(runtime.backgroundOperation('workspace-a', slow('a' + i)));
    const started = Date.now();
    await runtime.backgroundOperation('workspace-b', slow('b'));
    const elapsed = Date.now() - started;
    await Promise.all(burst);
    assert.equal(maxActive, 1, 'the single-flight background budget is preserved');
    assert.ok(elapsed < 6 * 40, `workspace B must not queue behind workspace A's whole burst (${elapsed}ms)`);
    assert.ok(order.indexOf('b:start') < order.indexOf('a5:end'), 'B starts before A finishes its burst');
    const diagnostics = await runtime.execute({ operation: 'runtime diagnostics', positionals: [], flags: {}, cwd: f.dataRoot, requestId: randomUUID() });
    assert.equal(diagnostics.ok, true, JSON.stringify(diagnostics));
    assert.equal(diagnostics.data.result.background.slotLimit, 1);
    assert.equal(diagnostics.data.result.background.inFlight, 0);
    assert.equal(diagnostics.data.result.background.queuedOperations, 0);
  } finally { await runtime.close(); }
});
