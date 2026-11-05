import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Archive } from '../../build/core/archive.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'harnessl3-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, archive: new Archive(root) };
}
const operation = (extras = {}) => ({ scope: `task:${randomUUID()}`, requestId: randomUUID(), request: { operation: 'test', value: 1 }, payload: { event: 'created' }, receipt: { answer: 'original' }, ...extras });

test('immutable snapshots and blobs validate their original bytes', async t => {
  const { archive, root } = await fixture(t);
  await archive.ready();
  const hash = await archive.snapshot('model', { title: 'Original', nested: [1, true] });
  assert.deepEqual(await archive.readSnapshot(hash), { title: 'Original', nested: [1, true] });
  assert.equal(await archive.snapshot('model', { nested: [1, true], title: 'Original' }), hash);
  const blob = await archive.blob(Buffer.from([0, 128, 255]));
  assert.deepEqual(await archive.readBlob(blob), Buffer.from([0, 128, 255]));
  await writeFile(join(root, 'snapshots', `${hash}.json`), '{}');
  await assert.rejects(archive.readSnapshot(hash), { code: 'ARCHIVE_CORRUPT' });
  await writeFile(join(root, 'skill-blobs', blob), 'changed');
  await assert.rejects(archive.readBlob(blob), { code: 'ARCHIVE_CORRUPT' });
  await assert.rejects(archive.readSnapshot('../outside'), { code: 'INVALID_ARGUMENT' });
});

test('commit is idempotent, conflicts reject and orphan archives do not commit', async t => {
  const { root, archive } = await fixture(t);
  await archive.ready();
  await archive.snapshot('unused-staging-result', { state: 'not committed' });
  const request = operation();
  assert.equal(await archive.replay(request.scope, request.requestId, request.request), null);
  assert.equal(archive.records().length, 0);
  const committed = await archive.commit(request);
  assert.deepEqual(committed, { receipt: { answer: 'original' }, replayed: false, seq: 1 });
  const replayed = await archive.commit({ ...request, payload: { event: 'different' }, receipt: { answer: 'must not overwrite' } });
  assert.deepEqual(replayed, { receipt: { answer: 'original' }, replayed: true, seq: 1 });
  await assert.rejects(archive.replay(request.scope, request.requestId, { operation: 'different' }), { code: 'REQUEST_ID_CONFLICT' });
  const after = new Archive(root);
  await after.ready();
  assert.deepEqual(await after.replay(request.scope, request.requestId, request.request), replayed);
  assert.equal(after.records().length, 1);
});

test('durable commit restores missing materializations without executing requests', async t => {
  const { archive, root } = await fixture(t);
  const taskId = randomUUID();
  const task = { id: taskId, title: 'Persisted', lastReadAt: null };
  const snapshotHash = await archive.snapshot('model', { exact: true });
  const request = operation({ archives: [{ kind: 'snapshot', hash: snapshotHash }], materializations: [{ path: `tasks/${taskId}.json`, content: task }] });
  await archive.commit(request);
  const expected = await readFile(join(root, 'tasks', `${taskId}.json`));
  await rm(join(root, 'tasks', `${taskId}.json`));
  const recovered = new Archive(root);
  await recovered.ready();
  assert.deepEqual(await readFile(join(root, 'tasks', `${taskId}.json`)), expected);
  assert.equal(recovered.records()[0].seq, 1);
  assert.deepEqual((await recovered.replay(request.scope, request.requestId, request.request)).receipt, request.receipt);
  await assert.rejects(recovered.commit(operation({ materializations: [{ path: '../escape.json', content: {} }] })), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(recovered.commit(operation({ materializations: [{ path: 'tasks/not-a-uuid.json', content: {} }] })), { code: 'INVALID_ARGUMENT' });
});

test('crash after journal commit replays receipt even if task replacement failed', async t => {
  const { archive, root } = await fixture(t);
  const taskId = randomUUID();
  await archive.ready();
  await mkdir(join(root, 'tasks', `${taskId}.json`));
  const request = operation({ materializations: [{ path: `tasks/${taskId}.json`, content: { id: taskId } }] });
  await assert.rejects(archive.commit(request), error => error.code === 'IO_ERROR' && error.details.committed === true);
  assert.equal(archive.records().length, 1);
  await rm(join(root, 'tasks', `${taskId}.json`), { recursive: true });
  const recovered = new Archive(root);
  await recovered.ready();
  assert.deepEqual((await recovered.replay(request.scope, request.requestId, request.request)).receipt, request.receipt);
  assert.equal(JSON.parse(await readFile(join(root, 'tasks', `${taskId}.json`), 'utf8')).id, taskId);
});

test('incomplete final journal line is preserved diagnostically and retried as uncommitted', async t => {
  const { archive, root } = await fixture(t);
  const first = operation();
  await archive.commit(first);
  const file = join(root, 'journal.jsonl');
  const original = await readFile(file);
  const tail = Buffer.from('{"schemaVersion":1,"seq":2');
  await writeFile(file, Buffer.concat([original, tail]));
  const recovered = new Archive(root);
  await recovered.ready();
  assert.deepEqual(await readFile(file), original);
  assert.equal(recovered.records().length, 1);
  const diagnostic = recovered.diagnostics.find(item => item.code === 'JOURNAL_INCOMPLETE_TAIL');
  assert.ok(diagnostic?.path);
  assert.deepEqual(await readFile(diagnostic.path), tail);
  assert.equal((await recovered.commit(operation())).seq, 2);
});

test('complete invalid journal record blocks new writes and preserves original file', async t => {
  const { archive, root } = await fixture(t);
  await archive.commit(operation());
  await archive.commit(operation());
  const file = join(root, 'journal.jsonl');
  const lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
  const changed = JSON.parse(lines[0]);
  changed.payload = { altered: true };
  const corrupted = `${JSON.stringify(changed)}\n${lines[1]}\n`;
  await writeFile(file, corrupted);
  const recovered = new Archive(root);
  await recovered.ready();
  assert.equal(recovered.status, 'recovery-required');
  await assert.rejects(recovered.commit(operation()), { code: 'ARCHIVE_CORRUPT' });
  assert.equal(await readFile(file, 'utf8'), corrupted);
  assert.equal(recovered.records().length, 0);
});

test('valid commit with a damaged referenced archive never reruns the request', async t => {
  const { archive, root } = await fixture(t);
  const hash = await archive.snapshot('model', { old: true });
  const request = operation({ archives: [{ kind: 'snapshot', hash }] });
  await archive.commit(request);
  await rm(join(root, 'snapshots', `${hash}.json`));
  const recovered = new Archive(root);
  await recovered.ready();
  await assert.rejects(recovered.replay(request.scope, request.requestId, request.request), { code: 'ARCHIVE_CORRUPT' });
  await assert.rejects(recovered.commit(request), { code: 'ARCHIVE_CORRUPT' });
  assert.equal(recovered.records().length, 1);
  assert.equal((await stat(join(root, 'journal.jsonl'))).isFile(), true);
});

test('concurrent writes retain contiguous hash-chained commit order', async t => {
  const { archive, root } = await fixture(t);
  const requests = Array.from({ length: 20 }, () => operation());
  await Promise.all(requests.map(request => archive.commit(request)));
  const recovered = new Archive(root);
  await recovered.ready();
  assert.deepEqual(recovered.records().map(record => record.seq), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal(recovered.status, 'ready');
});

test('queued commits detach request, receipt and materializations immediately', async t => {
  const { archive } = await fixture(t);
  const first = archive.commit(operation());
  const request = operation();
  const originalRequest = structuredClone(request.request);
  const second = archive.commit(request);
  request.request.value = 99;
  request.receipt.answer = 'mutated';
  await first;
  assert.deepEqual((await second).receipt, { answer: 'original' });
  assert.equal((await archive.replay(request.scope, request.requestId, originalRequest)).replayed, true);
});

test('content-addressed writes detach caller data before asynchronous I/O', async t => {
  const { archive } = await fixture(t);
  const model = { title: 'Original' };
  const bytes = Buffer.from('Original');
  const snapshot = archive.snapshot('model', model);
  const blob = archive.blob(bytes);
  model.title = 'Changed';
  bytes.fill(0);
  assert.deepEqual(await archive.readSnapshot(await snapshot), { title: 'Original' });
  assert.equal((await archive.readBlob(await blob)).toString('utf8'), 'Original');
});

test('read-only archive inspection never creates directories or repairs projections/tails', async t => {
  const { archive, root } = await fixture(t);
  const missing = join(root, 'absent');
  const empty = new Archive(missing, { readOnly: true });
  await empty.ready();
  await assert.rejects(stat(missing), { code: 'ENOENT' });
  const taskId = randomUUID();
  const request = operation({ materializations: [{ path: `tasks/${taskId}.json`, content: { id: taskId } }] });
  await archive.commit(request);
  await rm(join(root, 'tasks', `${taskId}.json`));
  const journal = join(root, 'journal.jsonl');
  const bytes = Buffer.concat([await readFile(journal), Buffer.from('{incomplete')]);
  await writeFile(journal, bytes);
  const inspector = new Archive(root, { readOnly: true });
  await inspector.ready();
  assert.equal(inspector.records().length, 1);
  assert.deepEqual(await readFile(journal), bytes);
  await assert.rejects(stat(join(root, 'tasks', `${taskId}.json`)), { code: 'ENOENT' });
  assert.deepEqual(await readdir(join(root, 'diagnostics')), []);
  assert.equal((await inspector.replay(request.scope, request.requestId, request.request)).replayed, true);
  await assert.rejects(inspector.commit(operation()), { code: 'IO_ERROR' });
});
