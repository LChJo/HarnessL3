import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SearchIndex } from '../../build/core/index.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'harnessl3-index-'));
  const file = join(root, 'index.sqlite');
  const index = new SearchIndex(file);
  const instances = [index];
  t.after(async () => { for (const item of instances) await item.close(); await rm(root, { recursive: true, force: true }); });
  return { root, file, index, reopen: () => { const next = new SearchIndex(file); instances.push(next); return next; } };
}
const now = '2026-11-05T12:00:00.000Z';
const document = (id, overrides = {}) => ({ id, kind: 'task', title: `Purpose ${id}`, text: `session-${id} model-revision`, activityAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-11-30T00:00:00.000Z', data: { id }, ...overrides });

test('new derived index requires an authoritative rebuild, then paginates and filters', async t => {
  const { index } = await fixture(t);
  await index.ready();
  await assert.rejects(index.search({ limit: 10, offset: 0, now }), { code: 'INDEX_UNAVAILABLE' });
  await index.rebuild(Array.from({ length: 65 }, (_, i) => document(`task-${i.toString().padStart(2, '0')}`)), 8);
  const page = await index.search({ query: 'model-revision', limit: 50, offset: 0, now });
  assert.equal(page.total, 65);
  assert.equal(page.items.length, 50);
  assert.equal(page.hasMore, true);
  assert.equal(page.seq, 8);
  const last = await index.search({ limit: 50, offset: 50, now });
  assert.equal(last.items.length, 15);
  assert.equal(last.hasMore, false);
});

test('retention exact boundary is included and unknown/expired activity stays undiscoverable', async t => {
  const { index } = await fixture(t);
  await index.rebuild([
    document('exact', { expiresAt: now }),
    document('expired', { expiresAt: '2026-11-05T11:59:59.999Z' }),
    document('unknown', { activityAt: null, expiresAt: null }),
    document('future', { activityAt: '2026-11-01T00:00:00.000Z' }),
    document('entity', { kind: 'entity', activityAt: null, expiresAt: null }),
  ], 1);
  const all = await index.search({ limit: 20, offset: 0, now });
  assert.deepEqual(all.items.map(item => item.id), ['future', 'exact']);
  const range = await index.search({ from: '2026-10-01', to: '2026-10-01', limit: 20, offset: 0, now });
  assert.deepEqual(range.items.map(item => item.id), ['exact']);
  const entities = await index.search({ kind: 'entity', limit: 20, offset: 0, now });
  assert.deepEqual(entities.items.map(item => item.id), ['entity']);
});

test('transactional projections ignore duplicate sequence and reject gaps', async t => {
  const { index, reopen } = await fixture(t);
  await index.rebuild([document('one')], 1);
  await index.project(2, [document('two')]);
  await index.project(2, [document('must-not-appear')]);
  let results = await index.search({ limit: 20, offset: 0, now });
  assert.equal(results.total, 2);
  await assert.rejects(index.project(4, [document('gap')]), { code: 'INDEX_SEQUENCE_GAP' });
  await index.close();
  const reopened = reopen();
  await reopened.ready();
  results = await reopened.search({ query: 'session-two', limit: 20, offset: 0, now });
  assert.deepEqual(results.items.map(item => item.id), ['two']);
  assert.equal(results.seq, 2);
});

test('SQL and FTS syntax input is bound data and invalid date/page arguments reject', async t => {
  const { index } = await fixture(t);
  await index.rebuild([document('safe', { title: `quote " OR 1=1 -- literal` })], 1);
  assert.equal((await index.search({ query: '" OR 1=1 --', limit: 20, offset: 0, now })).total, 1);
  assert.equal((await index.search({ query: "'); DROP TABLE documents; --", limit: 20, offset: 0, now })).total, 0);
  assert.equal((await index.search({ limit: 20, offset: 0, now })).total, 1);
  await assert.rejects(index.search({ from: '2026-02-30', limit: 20, offset: 0, now }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(index.search({ limit: 0, offset: 0, now }), { code: 'INVALID_ARGUMENT' });
});

test('deleted or corrupt SQLite is quarantined and cannot return a false empty history', async t => {
  const { index, file, reopen } = await fixture(t);
  await index.rebuild([document('preserved')], 7);
  await index.close();
  const original = await readFile(file);
  await writeFile(file, 'not SQLite');
  const rebuilt = reopen();
  await rebuilt.ready();
  assert.equal(rebuilt.status.state, 'rebuilding');
  assert.ok(rebuilt.status.quarantinedPath);
  assert.equal(await readFile(rebuilt.status.quarantinedPath, 'utf8'), 'not SQLite');
  await assert.rejects(rebuilt.search({ limit: 20, offset: 0, now }), { code: 'INDEX_UNAVAILABLE' });
  await rebuilt.rebuild([document('preserved')], 7);
  assert.equal((await rebuilt.search({ limit: 20, offset: 0, now })).items[0].id, 'preserved');
  assert.ok(original.length > 0);
});

test('unexpected worker termination rejects pending calls and permits cleanup', async t => {
  const { index } = await fixture(t);
  await index.rebuild([document('one')], 1);
  const pending = index.rebuild(Array.from({ length: 10000 }, (_, i) => document(`load-${i}`)), 2);
  const rejected = assert.rejects(pending, { code: 'INDEX_UNAVAILABLE' });
  await index.worker.terminate();
  await rejected;
  assert.equal(index.status.state, 'degraded');
  await assert.rejects(index.search({ limit: 20, offset: 0, now }), { code: 'INDEX_UNAVAILABLE' });
});

test('closed workers reject requests without restarting a second worker', async t => {
  const { index } = await fixture(t);
  await index.rebuild([document('one')], 1);
  await index.close();
  await assert.rejects(index.search({ limit: 20, offset: 0, now }), { code: 'INDEX_UNAVAILABLE' });
});
