import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Archive } from '../../build/core/archive.js';
import { MigrationService, GarbageCollector } from '../../build/core/maintenance.js';
import { SearchIndex } from '../../build/core/index.js';

const rawHash = bytes => createHash('sha256').update(bytes).digest('hex');
const oldHash = value => rawHash(JSON.stringify(value));
const time = '2026-11-05T12:00:00.000Z';
async function fixture(t) {
  // Match GC's canonical identity when TMPDIR uses a symlink or Windows 8.3 alias.
  const base = await realpath(await mkdtemp(join(tmpdir(), 'harnessl3-maintenance-')));
  const source = join(base, 'synthetic-prototype');
  const dataRoot = join(base, 'formal-data');
  const worktree = { id: randomUUID(), projectId: randomUUID(), root: join(base, 'worktree'), gitCommonDir: join(base, 'worktree', '.git'), branch: 'fixture', active: true, available: true };
  const archive = new Archive(join(dataRoot, 'worktrees', worktree.id));
  await mkdir(join(source, 'context-tasks'), { recursive: true });
  await mkdir(join(source, 'context-snapshots'));
  let queue = Promise.resolve();
  const serial = work => { const next = queue.then(work); queue = next.catch(() => {}); return next; };
  const migration = new MigrationService({ worktree, archive, serial, now: () => time });
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, source, dataRoot, worktree, archive, serial, migration };
}
async function legacy(source, overrides = {}) {
  const bytes = Buffer.from('# Original synthetic method\n');
  const file = { path: 'SKILL.md', content: bytes.toString('utf8'), encoding: 'utf8', hash: rawHash(bytes), bytes: bytes.length };
  const skill = { id: 'legacy-engineering/example', name: 'Example', group: 'legacy-engineering', files: [file], contentHash: oldHash([[file.path, file.hash]]) };
  const plan = { id: randomUUID(), status: 'selected', catalogRevision: 'b'.repeat(64), skills: [skill] };
  const snapshot = { revision: 'a'.repeat(64), elements: [{ id: 'mgrp.object', title: 'Original old object' }], c4Views: [{ id: 'old-view', title: 'Old C4' }], sourceVersion: { evidenceHash: 'c'.repeat(64) } };
  const snapshotId = oldHash(snapshot);
  await writeFile(join(source, 'context-snapshots', `${snapshotId}.json`), JSON.stringify({ id: snapshotId, capturedAt: '2026-10-01T00:00:00.000Z', snapshot }));
  const body = { id: 'mgrp.object', title: 'Original old object', metadata: { evidence: [] }, ancestors: [], relationships: [], scope: 'exact-object' };
  const context = { ...body, contentHash: oldHash(body) };
  const task = { id: randomUUID(), title: 'Synthetic legacy task', projectId: 'OLD-PROJECT', worktreeId: 'old-path-hash', modelRevision: 'a'.repeat(64), sourceVersion: { evidenceHash: 'c'.repeat(64) }, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z', initialSnapshotId: snapshotId, batches: [{ id: randomUUID(), status: 'complete', snapshotId, skillPlan: plan, result: { directories: [], contexts: [context], unchanged: [], errors: [] } }], packet: { contexts: [context], scope: 'exact-objects' }, ...overrides };
  const raw = Buffer.from(JSON.stringify(task));
  await writeFile(join(source, 'context-tasks', `${task.id}.json`), raw);
  return { task, raw, file, snapshotId, snapshot, plan };
}
async function tree(root) {
  const result = {};
  async function scan(dir, prefix = '') { for (const entry of await readdir(dir, { withFileTypes: true })) { const rel = prefix + entry.name; if (entry.isDirectory()) await scan(join(dir, entry.name), rel + '/'); else if (entry.isFile()) result[rel] = rawHash(await readFile(join(dir, entry.name))); } }
  await scan(root); return result;
}

test('migration dry-run has no target writes and apply preserves original IDs, dates and bytes', async t => {
  const f = await fixture(t);
  const old = await legacy(f.source);
  const before = await tree(f.source);
  const preview = await f.migration.run({ source: f.source, requestId: randomUUID() });
  assert.equal(preview.mode, 'dry-run');
  assert.equal(preview.tasks[0].action, 'copy');
  await assert.rejects(stat(f.dataRoot), { code: 'ENOENT' });
  const applied = await f.migration.run({ source: f.source, mode: 'apply', expectedManifest: preview.manifestHash, requestId: randomUUID() });
  assert.equal(applied.sourcePreserved, true);
  assert.equal(applied.migrationId, preview.migrationId);
  assert.deepEqual(await tree(f.source), before);
  const restored = await f.migration.show(old.task.id);
  assert.equal(restored.kind, 'legacy-archive');
  assert.equal(restored.record.projectId, 'OLD-PROJECT');
  assert.equal(restored.record.worktreeId, 'old-path-hash');
  assert.equal(restored.record.packet.contexts[0].id, 'mgrp.object');
  assert.equal(restored.record.skillPlan.skills[0].group, 'legacy-engineering');
  assert.equal(restored.record.skillPlan.skills[0].files[0].content, undefined);
  assert.equal(restored.binding.sourceVersion, null);
  assert.equal(restored.binding.sourceScanRevision, null);
  const summaries = await f.migration.list();
  assert.equal(summaries[0].retentionBasisAt, old.task.updatedAt);
  assert.equal(summaries[0].createdAt, old.task.createdAt);
  assert.equal(f.archive.records()[0].payload.kind, 'legacy-migration');
});

test('repeated migration skips identical tasks, replays receipts and rejects conflicting target IDs', async t => {
  const f = await fixture(t);
  const old = await legacy(f.source);
  const input = { source: f.source, mode: 'apply', requestId: randomUUID() };
  await f.migration.run(input);
  const seq = f.archive.seq;
  assert.equal((await f.migration.run(input)).replayed, true);
  assert.equal(f.archive.seq, seq);
  const repeated = await f.migration.run({ ...input, requestId: randomUUID() });
  assert.equal(repeated.tasks[0].action, 'skip');
  const changed = { ...old.task, title: 'Conflicting bytes' };
  await writeFile(join(f.source, 'context-tasks', `${old.task.id}.json`), JSON.stringify(changed));
  assert.equal((await f.migration.run({ source: f.source })).tasks[0].action, 'conflict');
  await assert.rejects(f.migration.run({ source: f.source, mode: 'apply', requestId: randomUUID() }), { code: 'VERSION_CONFLICT' });
  assert.equal((await f.migration.show(old.task.id)).record.title, old.task.title);
});

test('changed preview manifest and damaged snapshot/skill bytes are never imported as current data', async t => {
  const f = await fixture(t);
  const old = await legacy(f.source);
  const preview = await f.migration.run({ source: f.source });
  await writeFile(join(f.source, 'context-tasks', `${old.task.id}.json`), JSON.stringify({ ...old.task, title: 'Changed during review' }));
  await assert.rejects(f.migration.run({ source: f.source, mode: 'apply', expectedManifest: preview.manifestHash, requestId: randomUUID() }), { code: 'VERSION_CONFLICT' });
  await writeFile(join(f.source, 'context-tasks', `${old.task.id}.json`), old.raw);
  await writeFile(join(f.source, 'context-snapshots', `${old.snapshotId}.json`), '{}');
  const invalid = await f.migration.run({ source: f.source });
  assert.equal(invalid.tasks[0].action, 'conflict');
  await assert.rejects(f.migration.run({ source: f.source, mode: 'apply', requestId: randomUUID() }), { code: 'ARCHIVE_CORRUPT' });
  await assert.rejects(stat(join(f.archive.root, 'journal.jsonl')), { code: 'ENOENT' });
});

test('missing legacy snapshots and invalid activity dates preserve partial/unknown without renewal', async t => {
  const f = await fixture(t);
  const old = await legacy(f.source, { initialSnapshotId: undefined, updatedAt: 'unknown', createdAt: 'unknown' });
  delete old.task.batches[0].snapshotId;
  await writeFile(join(f.source, 'context-tasks', `${old.task.id}.json`), JSON.stringify(old.task));
  await f.migration.run({ source: f.source, mode: 'apply', requestId: randomUUID() });
  const restored = await f.migration.show(old.task.id);
  assert.equal(restored.completeness, 'partial');
  assert.equal((await f.migration.list())[0].retentionBasisAt, null);
  assert.equal((await f.migration.list())[0].expiresAt, null);
  const read = await f.migration.read(old.task.id, { files: [{ skillId: old.plan.skills[0].id, path: 'SKILL.md', expectedHash: old.file.hash }] });
  assert.equal(read.record.legacyRead.files[0].file.content, old.file.content);
  assert.equal(read.record.legacyRead.files[0].skillId, 'legacy-engineering/example');
});

test('batch restore cannot expose later contexts or later selected skill files', async t => {
  const f = await fixture(t);
  const old = await legacy(f.source);
  const first = old.task.batches[0];
  const second = { id: randomUUID(), status: 'complete', snapshotId: old.snapshotId, result: { directories: [], contexts: [{ id: 'mgrp.later', title: 'Later body' }], errors: [] } };
  old.task.batches.push(second);
  old.task.packet.contexts.push(second.result.contexts[0]);
  await writeFile(join(f.source, 'context-tasks', `${old.task.id}.json`), JSON.stringify(old.task));
  await f.migration.run({ source: f.source, mode: 'apply', requestId: randomUUID() });
  const restored = await f.migration.show(old.task.id, first.id);
  assert.deepEqual(restored.record.packet.contexts.map(body => body.id), ['mgrp.object']);
  assert.equal(restored.record.batches.length, 1);
  await assert.rejects(f.migration.show(old.task.id, randomUUID()), { code: 'NOT_FOUND' });
});

test('GC lists only derived files and requires an explicit no-lease result before deletion', async t => {
  const f = await fixture(t);
  await f.archive.ready();
  const root = f.archive.root;
  await mkdir(join(root, 'cache'));
  const cache = join(root, 'cache', `${'d'.repeat(64)}.json`);
  await writeFile(cache, JSON.stringify({ schemaVersion: 1, kind: 'harness-cache', rebuildable: true, generator: 'test/1', expiresAt: '2026-11-01T00:00:00.000Z', content: {} }));
  const staging = join(root, 'snapshots', `.${'a'.repeat(64)}.json.${randomUUID()}.tmp`);
  await writeFile(staging, 'uncommitted');
  const protectedFile = join(root, 'snapshots', `${'b'.repeat(64)}.json`);
  await writeFile(protectedFile, 'immutable orphan history');
  await writeFile(join(root, 'cache', 'unknown-user-file.txt'), 'keep');
  await writeFile(join(f.dataRoot, 'registry.json'), '{}');
  const before = await tree(f.dataRoot);
  const gcUnknown = new GarbageCollector({ dataRoot: f.dataRoot, worktrees: [f.worktree], now: () => time });
  assert.equal((await gcUnknown.run()).candidates.length, 0);
  const gc = new GarbageCollector({ dataRoot: f.dataRoot, worktrees: [f.worktree], now: () => time, isLeased: async () => false });
  const preview = await gc.run();
  assert.deepEqual(new Set(preview.candidates.map(item => item.path)), new Set([cache, staging]));
  assert.deepEqual(preview.removed, []);
  assert.deepEqual(await tree(f.dataRoot), before);
  const applied = await gc.run({ mode: 'apply', expectedPlan: preview.planHash });
  assert.equal(applied.removed.length, 2);
  assert.equal(await readFile(protectedFile, 'utf8'), 'immutable orphan history');
  assert.equal(await readFile(join(root, 'cache', 'unknown-user-file.txt'), 'utf8'), 'keep');
});

test('GC rechecks leases/content and never follows a cache junction to user skills', async t => {
  const f = await fixture(t);
  await f.archive.ready();
  const cache = join(f.archive.root, 'cache');
  await mkdir(cache);
  const file = join(cache, `${'c'.repeat(64)}.json`);
  await writeFile(file, JSON.stringify({ schemaVersion: 1, kind: 'harness-cache', rebuildable: true, generator: 'test/1', expiresAt: '2026-11-01T00:00:00.000Z', content: {} }));
  const skills = join(f.dataRoot, 'skills');
  await mkdir(skills);
  await writeFile(join(skills, `${'e'.repeat(64)}.json`), 'user edited skills');
  await symlink(skills, join(cache, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  let checks = 0;
  const gc = new GarbageCollector({ dataRoot: f.dataRoot, worktrees: [f.worktree], now: () => time, isLeased: async () => ++checks > 1 });
  const applied = await gc.run({ mode: 'apply' });
  assert.deepEqual(applied.removed, []);
  assert.equal(await readFile(file, 'utf8').then(Boolean), true);
  assert.equal(await readFile(join(skills, `${'e'.repeat(64)}.json`), 'utf8'), 'user edited skills');
});

test('SQLite files are preserved for active or unknown workers and removable after a confirmed close', async t => {
  const f = await fixture(t);
  await f.archive.ready();
  const file = join(f.archive.root, 'index.sqlite');
  const index = new SearchIndex(file);
  await index.rebuild([], 0);
  const active = new GarbageCollector({ dataRoot: f.dataRoot, worktrees: [f.worktree], now: () => time, isLeased: async () => true });
  assert.equal((await active.run({ mode: 'apply' })).removed.length, 0);
  await index.close();
  const stopped = new GarbageCollector({ dataRoot: f.dataRoot, worktrees: [f.worktree], now: () => time, isLeased: async () => false });
  assert.equal((await stopped.run({ mode: 'apply' })).removed.length, 1);
  await assert.rejects(stat(file), { code: 'ENOENT' });
});

test('a corrupt retained skill and a linked source entry are blocked instead of repaired', async t => {
  const f = await fixture(t);
  const old = await legacy(f.source);
  old.task.batches[0].skillPlan.skills[0].files[0].content = 'changed without matching old hash';
  await writeFile(join(f.source, 'context-tasks', `${old.task.id}.json`), JSON.stringify(old.task));
  await assert.rejects(f.migration.run({ source: f.source, mode: 'apply', requestId: randomUUID() }), { code: 'ARCHIVE_CORRUPT' });
  await writeFile(join(f.source, 'context-tasks', `${old.task.id}.json`), old.raw);
  const outside = join(f.base, 'external'); await mkdir(outside);
  await writeFile(join(outside, 'user.txt'), 'user content');
  await symlink(outside, join(f.source, 'context-snapshots', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.migration.run({ source: f.source }), { code: 'INVALID_ARGUMENT' });
  assert.equal(await readFile(join(outside, 'user.txt'), 'utf8'), 'user content');
});

test('source mutation during archive installation leaves only uncommitted orphan archives', async t => {
  const f = await fixture(t);
  const old = await legacy(f.source);
  const snapshot = f.archive.snapshot.bind(f.archive);
  let changed = false;
  f.archive.snapshot = async (...args) => {
    const hash = await snapshot(...args);
    if (!changed) { changed = true; await writeFile(join(f.source, 'context-tasks', `${old.task.id}.json`), JSON.stringify({ ...old.task, title: 'Edited during apply' })); }
    return hash;
  };
  await assert.rejects(f.migration.run({ source: f.source, mode: 'apply', requestId: randomUUID() }), { code: 'VERSION_CONFLICT' });
  assert.equal(f.archive.records().length, 0);
  await assert.rejects(stat(join(f.archive.root, 'journal.jsonl')), { code: 'ENOENT' });
  assert.equal((await f.migration.run({ source: f.source })).tasks[0].action, 'copy');
});

test('GC retains changed files, malformed staging names and unknown reference status', async t => {
  const f = await fixture(t);
  await f.archive.ready();
  await mkdir(join(f.archive.root, 'cache'));
  const file = join(f.archive.root, 'cache', `${'c'.repeat(64)}.json`);
  await writeFile(file, JSON.stringify({ schemaVersion: 1, kind: 'harness-cache', rebuildable: true, generator: 'test/1', expiresAt: '2026-11-01T00:00:00.000Z', content: {} }));
  const malformed = join(f.archive.root, 'snapshots', `.${'a'.repeat(64)}.json.${'a'.repeat(36)}.tmp`);
  await writeFile(malformed, 'unknown data with a misleading filename');
  const unknown = new GarbageCollector({ dataRoot: f.dataRoot, worktrees: [f.worktree], now: () => time, isLeased: async () => false, isReferenced: async () => undefined });
  assert.equal((await unknown.run()).candidates.length, 0);
  let leases = 0;
  const changed = new GarbageCollector({ dataRoot: f.dataRoot, worktrees: [f.worktree], now: () => time, isLeased: async candidate => { if (++leases === 2 && candidate === file) await writeFile(file, 'now edited unknown data'); return false; } });
  const applied = await changed.run({ mode: 'apply' });
  assert.equal(applied.removed.length, 0);
  assert.equal(await readFile(file, 'utf8'), 'now edited unknown data');
  assert.equal(await readFile(malformed, 'utf8'), 'unknown data with a misleading filename');
});

test('a formal task UUID and a changed raw snapshot closure both conflict with legacy import', async t => {
  const formal = await fixture(t);
  const old = await legacy(formal.source);
  await formal.archive.commit({ scope: 'formal-fixture', requestId: randomUUID(), request: { operation: 'create fixture' }, payload: { kind: 'task', task: { id: old.task.id } }, receipt: {} });
  assert.equal((await formal.migration.run({ source: formal.source })).tasks[0].action, 'conflict');
  await assert.rejects(formal.migration.run({ source: formal.source, mode: 'apply', requestId: randomUUID() }), { code: 'VERSION_CONFLICT' });
  const other = await fixture(t);
  const original = await legacy(other.source);
  await other.migration.run({ source: other.source, mode: 'apply', requestId: randomUUID() });
  const file = join(other.source, 'context-snapshots', `${original.snapshotId}.json`);
  const changed = JSON.parse(await readFile(file, 'utf8')); changed.capturedAt = '2026-10-02T00:00:00.000Z';
  await writeFile(file, JSON.stringify(changed));
  assert.equal((await other.migration.run({ source: other.source })).tasks[0].action, 'conflict');
  await assert.rejects(other.migration.run({ source: other.source, mode: 'apply', requestId: randomUUID() }), { code: 'VERSION_CONFLICT' });
});

test('a legacy skill reference without retained bytes stays unknown and cannot borrow current files', async t => {
  const f = await fixture(t);
  const old = await legacy(f.source);
  delete old.task.batches[0].skillPlan.skills[0].files[0].content;
  await writeFile(join(f.source, 'context-tasks', `${old.task.id}.json`), JSON.stringify(old.task));
  await f.migration.run({ source: f.source, mode: 'apply', requestId: randomUUID() });
  const result = await f.migration.read(old.task.id, { files: [{ skillId: old.plan.skills[0].id, path: 'SKILL.md', expectedHash: old.file.hash }] });
  assert.equal(result.completeness, 'partial');
  assert.deepEqual(result.record.legacyRead.files, []);
  assert.equal(result.record.legacyRead.errors[0].code, 'FILE_NOT_ARCHIVED');
});
