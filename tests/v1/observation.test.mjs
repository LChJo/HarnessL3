import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, appendFile, readdir, rm, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Archive } from '../../build/core/archive.js';
import { ObservationManager } from '../../build/core/observation.js';

const time = '2026-11-05T13:00:00.000Z';
async function fixture(t, agent = 'codex') {
  const base = await mkdtemp(join(tmpdir(), 'harnessl3-observation-'));
  const root = join(base, 'worktree');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'example.ts'), 'current bytes are not historical evidence');
  const log = join(base, 'session.jsonl');
  const source = await readFile(new URL(`./fixtures/observation/${agent}-synthetic.jsonl`, import.meta.url), 'utf8');
  await writeFile(log, source.replaceAll('__WORKTREE__', root.replaceAll('\\', '/')));
  const archive = new Archive(join(base, 'archive'));
  const worktree = { id: randomUUID(), projectId: randomUUID(), root, gitCommonDir: join(root, '.git'), active: true, available: true, branch: 'fixture' };
  let queue = Promise.resolve();
  const serial = work => { const next = queue.then(work); queue = next.catch(() => {}); return next; };
  const managers = [];
  const create = (overrides = {}) => { const manager = new ObservationManager({ worktree, archive, serial, pollIntervalMs: 0, now: () => time, validatedHostVersions: { codex: ['0.162.1'], 'claude-code': [] }, ...overrides }); managers.push(manager); return manager; };
  t.after(async () => { for (const manager of managers) await manager.close(); await rm(base, { recursive: true, force: true }); });
  return { base, root, log, archive, worktree, create, manager: create() };
}
const call = (id, command, cwd) => ({ type: 'response_item', timestamp: time, payload: { type: 'function_call', call_id: id, name: 'exec_command', arguments: JSON.stringify({ cmd: command, workdir: cwd }) } });
const result = (id, exit_code = 0) => ({ type: 'response_item', timestamp: time, payload: { type: 'function_call_output', call_id: id, output: JSON.stringify({ exit_code, output: 'SECRET_RESULT_TEXT' }) } });
const line = row => `${JSON.stringify(row)}\n`;

test('Codex normalizes paired literal operations without persisting transcript bodies', async t => {
  const { manager, log, archive, base } = await fixture(t);
  const original = await readFile(log);
  const bound = await manager.bind({ agent: 'codex', sessionId: 'synthetic-codex', logFile: log, requestId: randomUUID() });
  assert.equal(bound.bindings.length, 1);
  const status = await manager.status();
  assert.deepEqual(status.events.map(event => [event.operation, event.status]), [['read', 'succeeded'], ['search', 'succeeded'], ['write', 'succeeded']]);
  assert.equal(status.events[0].versionStatus, 'unknown');
  assert.equal(status.events[0].contentHash, null);
  assert.equal(status.events[0].returnedRange, null);
  assert.equal(status.events[1].exitCategory, 'no-matches');
  assert.ok(status.events.every(event => event.backfilled && event.taskId === null && event.ownership === 'matched'));
  assert.deepEqual(await readFile(log), original);
  const all = [];
  async function inspect(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) await inspect(path); else all.push(await readFile(path, 'utf8')); } }
  await inspect(archive.root);
  assert.equal(all.join('\n').includes('SECRET_'), false);
  assert.ok(archive.records().every(record => record.payload.kind === 'observation-state'));
  assert.ok(base);
});

test('incremental pairing survives restart and never duplicates observed calls', async t => {
  const { manager, log, root, create } = await fixture(t);
  const header = (await readFile(log, 'utf8')).split('\n')[0] + '\n';
  await writeFile(log, header + line(call('pending', 'cat src/example.ts', root)));
  const input = { agent: 'codex', sessionId: 'synthetic-codex', logFile: log, requestId: randomUUID() };
  const first = await manager.bind(input);
  assert.equal((await manager.status()).events[0].status, 'unknown');
  const offset = first.bindings[0].cursor.offset;
  await manager.close();
  await appendFile(log, line(result('pending')));
  const resumed = create();
  await resumed.poll();
  let status = await resumed.status();
  assert.equal(status.events.length, 1);
  assert.equal(status.events[0].status, 'succeeded');
  assert.ok(status.bindings[0].cursor.offset > offset);
  await resumed.poll();
  assert.equal((await resumed.status()).events.length, 1);
  await resumed.unbind(status.bindings[0].id, randomUUID());
  await appendFile(log, line(call('later', 'cat src/example.ts', root)));
  await resumed.poll();
  assert.equal((await resumed.status()).events.length, 1);
});

test('half UTF-8/JSON lines wait for completion and malformed complete lines leave a gap', async t => {
  const { manager, log, root } = await fixture(t);
  const header = (await readFile(log, 'utf8')).split('\n')[0] + '\n';
  const row = Buffer.from(line(call('unicode', "cat 'src/文件.ts'", root)));
  const split = row.indexOf(Buffer.from('文')) + 1;
  await writeFile(log, Buffer.concat([Buffer.from(header), row.subarray(0, split)]));
  await manager.bind({ agent: 'codex', sessionId: 'synthetic-codex', logFile: log, requestId: randomUUID() });
  assert.equal((await manager.status()).events.length, 0);
  await appendFile(log, Buffer.concat([row.subarray(split), Buffer.from('{broken}\n'), Buffer.from(line(result('unicode')))]));
  await manager.poll();
  const status = await manager.status();
  assert.equal(status.events.length, 1);
  assert.equal(status.events[0].status, 'succeeded');
  assert.equal(status.bindings[0].coverage.state, 'partial');
  assert.ok(status.bindings[0].coverage.diagnostics.some(item => item.code === 'INVALID_RECORD'));
});

test('dynamic/compound shell and ambiguous nested results remain coverage gaps', async t => {
  const { manager, log, root } = await fixture(t);
  const header = (await readFile(log, 'utf8')).split('\n')[0] + '\n';
  const nested = { type: 'response_item', timestamp: time, payload: { type: 'custom_tool_call', name: 'exec', call_id: 'nested', input: `await Promise.all([tools.exec_command({cmd:'cat src/example.ts',workdir:${JSON.stringify(root)}}),tools.exec_command({cmd:'cat src/other.ts',workdir:${JSON.stringify(root)}})]);` } };
  await writeFile(log, header + line(call('compound', 'cat src/example.ts; cat src/other.ts', root)) + line(result('compound')) + line(call('dynamic', 'cat $FILE', root)) + line(nested) + line(result('nested')));
  await manager.bind({ agent: 'codex', sessionId: 'synthetic-codex', logFile: log, requestId: randomUUID() });
  const status = await manager.status();
  assert.equal(status.events.length, 2);
  assert.ok(status.events.every(event => event.status === 'unknown' && event.tool === 'exec_command'));
  assert.ok(status.bindings[0].coverage.unsupportedRecords >= 2);
});

test('session/cwd mismatch refuses bind and replacement mismatch pauses collection', async t => {
  const { manager, log, root } = await fixture(t);
  await assert.rejects(manager.bind({ agent: 'codex', sessionId: 'another-session', logFile: log, requestId: randomUUID() }), { code: 'TARGET_CONFLICT' });
  await manager.bind({ agent: 'codex', sessionId: 'synthetic-codex', logFile: log, requestId: randomUUID() });
  await rename(log, `${log}.old`);
  await writeFile(log, line({ type: 'session_meta', payload: { id: 'different', cwd: root, cli_version: '0.162.1' } }) + line(call('wrong', 'cat src/example.ts', root)));
  await manager.poll();
  const status = await manager.status();
  assert.equal(status.events.length, 3);
  assert.equal(status.bindings[0].state, 'unknown');
  assert.ok(status.bindings[0].coverage.diagnostics.some(item => item.code === 'SESSION_MISMATCH'));
});

test('copy rotation deduplicates stable calls and truncation starts a new generation', async t => {
  const { manager, log, root } = await fixture(t);
  await manager.bind({ agent: 'codex', sessionId: 'synthetic-codex', logFile: log, requestId: randomUUID() });
  const original = await readFile(log);
  await rename(log, `${log}.old`);
  await writeFile(log, original);
  await manager.poll();
  assert.equal((await manager.status()).events.length, 3);
  const header = original.toString('utf8').split('\n')[0] + '\n';
  await writeFile(log, header + line(call('new', 'cat src/example.ts', root)) + line(result('new')));
  await manager.poll();
  const status = await manager.status();
  assert.equal(status.events.length, 4);
  assert.ok(status.bindings[0].cursor.generation >= 2);
  assert.equal(status.bindings[0].coverage.state, 'partial');
});

test('outside paths and symlink escapes are labeled without hashing current bytes', async t => {
  const { manager, log, root, base } = await fixture(t);
  const outside = join(base, 'outside.txt');
  await writeFile(outside, 'secret');
  const header = (await readFile(log, 'utf8')).split('\n')[0] + '\n';
  await writeFile(log, header + line(call('outside', `cat ${JSON.stringify(outside)}`, root)) + line(result('outside')));
  await manager.bind({ agent: 'codex', sessionId: 'synthetic-codex', logFile: log, requestId: randomUUID() });
  const event = (await manager.status()).events[0];
  assert.equal(event.ownership, 'outside-worktree');
  assert.equal(event.contentHash, null);
  const outsideDir = join(base, 'external');
  await mkdir(outsideDir);
  await writeFile(join(outsideDir, 'file.ts'), 'secret');
  await symlink(outsideDir, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await appendFile(log, line(call('symlink', 'cat linked/file.ts', root)) + line(result('symlink')));
  await manager.poll();
  assert.equal((await manager.status()).events.find(item => item.callId === 'symlink').ownership, 'outside-worktree');
});

test('Claude synthetic pairing reports ranges/failure but does not claim validated host support', async t => {
  const { manager, log } = await fixture(t, 'claude');
  await manager.bind({ agent: 'claude-code', sessionId: 'synthetic-claude', logFile: log, requestId: randomUUID() });
  const status = await manager.status();
  assert.equal(status.events.length, 2);
  assert.deepEqual(status.events[0].requestedRange, { startLine: 2, endLine: 4 });
  assert.deepEqual(status.events[0].returnedRange, { startLine: 2, endLine: 3 });
  assert.equal(status.events[0].status, 'unknown');
  assert.equal(status.events[1].status, 'failed');
  assert.equal(status.events[1].exitCategory, 'permission-denied');
  assert.equal(status.bindings[0].coverage.hostVersionVerified, false);
  assert.ok(status.bindings[0].coverage.unsupportedRecords > 0);
});

test('unified exec running session only resolves when its paired poll finishes', async t => {
  const { manager, log, root } = await fixture(t);
  const header = (await readFile(log, 'utf8')).split('\n')[0] + '\n';
  const running = { ...result('async'), payload: { type: 'function_call_output', call_id: 'async', output: JSON.stringify({ session_id: 42, output: '' }) } };
  const poll = { type: 'response_item', payload: { type: 'function_call', call_id: 'poll', name: 'write_stdin', arguments: JSON.stringify({ session_id: 42, chars: '' }) } };
  await writeFile(log, header + line(call('async', 'cat src/example.ts', root)) + line(running));
  await manager.bind({ agent: 'codex', sessionId: 'synthetic-codex', logFile: log, requestId: randomUUID() });
  assert.equal((await manager.status()).events[0].status, 'unknown');
  await appendFile(log, line(poll) + line(result('poll')));
  await manager.poll();
  const status = await manager.status();
  assert.equal(status.events.length, 1);
  assert.equal(status.events[0].status, 'succeeded');
});

test('deleted logs report an error without losing the last committed cursor', async t => {
  const { manager, log } = await fixture(t);
  await manager.bind({ agent: 'codex', sessionId: 'synthetic-codex', logFile: log, requestId: randomUUID() });
  const before = (await manager.status()).bindings[0].cursor.offset;
  await rm(log);
  await manager.poll();
  const status = await manager.status();
  assert.equal(status.bindings[0].coverage.state, 'error');
  assert.equal(status.bindings[0].cursor.offset, before);
  assert.equal(status.events.length, 3);
});

test('binding replay preserves its original receipt even after the original log is removed', async t => {
  const { manager, log, archive } = await fixture(t);
  const input = { agent: 'codex', sessionId: 'synthetic-codex', logFile: log, requestId: randomUUID() };
  const first = await manager.bind(input);
  const seq = archive.seq;
  await rm(log);
  const replay = await manager.bind(input);
  assert.deepEqual(replay.bindings, first.bindings);
  assert.equal(replay.replayed, true);
  assert.equal(archive.seq, seq);
});

test('failed observation commit cannot advance its in-memory cursor or discard a future retry', async t => {
  const { manager, log, archive, root } = await fixture(t);
  await manager.bind({ agent: 'codex', sessionId: 'synthetic-codex', logFile: log, requestId: randomUUID() });
  const before = (await manager.status()).bindings[0].cursor.offset;
  await appendFile(log, line(call('after-failure', 'cat src/example.ts', root)) + line(result('after-failure')));
  const commit = archive.commit.bind(archive);
  archive.commit = async () => { throw Object.assign(new Error('Injected before commit'), { code: 'IO_ERROR' }); };
  await assert.rejects(manager.poll(), { code: 'IO_ERROR' });
  assert.equal((await manager.status()).bindings[0].cursor.offset, before);
  assert.equal((await manager.status()).events.length, 3);
  archive.commit = commit;
  await manager.poll();
  assert.equal((await manager.status()).events.length, 4);
});

test('minimal desensitized Codex 0.162.1 envelope keeps aggregate child results unknown', async t => {
  const { manager, log, root } = await fixture(t);
  const real = await readFile(new URL('./fixtures/observation/codex-real-0.162.1.jsonl', import.meta.url), 'utf8');
  await writeFile(log, real.replaceAll('__WORKTREE__', root.replaceAll('\\', '/')));
  await manager.bind({ agent: 'codex', sessionId: 'real-shape-codex', logFile: log, requestId: randomUUID() });
  const status = await manager.status();
  assert.equal(status.events.length, 3);
  assert.ok(status.events.every(event => event.status === 'unknown' && event.resultMatched));
  assert.equal(status.bindings[0].coverage.hostVersionVerified, true);
});

test('minimal desensitized Claude 2.1.212 results pair without copying raw toolUseResult', async t => {
  const { log, root, create } = await fixture(t);
  const manager = create({ validatedHostVersions: { codex: ['0.162.1'], 'claude-code': ['2.1.212'] } });
  const real = await readFile(new URL('./fixtures/observation/claude-real-2.1.212.jsonl', import.meta.url), 'utf8');
  await writeFile(log, real.replaceAll('__WORKTREE__', root.replaceAll('\\', '/')));
  await manager.bind({ agent: 'claude-code', sessionId: 'real-shape-claude', logFile: log, requestId: randomUUID() });
  const status = await manager.status();
  assert.deepEqual(status.events.map(event => [event.tool, event.status]), [['Read', 'succeeded'], ['Edit', 'succeeded'], ['Grep', 'succeeded'], ['Write', 'succeeded']]);
  assert.deepEqual(status.events[0].returnedRange, { startLine: 1, endLine: 10 });
  assert.ok(status.events.every(event => event.contentHash === null));
  assert.equal(status.bindings[0].coverage.state, 'partial');
});

test('a renamed open log is drained while its explicitly bound path is temporarily absent', async t => {
  const { manager, log, root } = await fixture(t);
  await manager.bind({ agent: 'codex', sessionId: 'synthetic-codex', logFile: log, requestId: randomUUID() });
  await rename(log, `${log}.old`);
  await appendFile(`${log}.old`, line(call('drained', 'cat src/example.ts', root)) + line(result('drained')));
  await manager.poll();
  const status = await manager.status();
  assert.equal(status.events.length, 4);
  assert.equal(status.events.at(-1).status, 'succeeded');
  assert.equal(status.bindings[0].coverage.state, 'error');
});

test('real Codex single awaited literal read has a uniquely paired successful result', async t => {
  const { manager, log, root } = await fixture(t);
  const real = await readFile(new URL('./fixtures/observation/codex-real-single-read-0.162.1.jsonl', import.meta.url), 'utf8');
  await writeFile(log, real.replaceAll('__WORKTREE__', root.replaceAll('\\', '/')));
  await manager.bind({ agent: 'codex', sessionId: 'real-single-codex', logFile: log, requestId: randomUUID() });
  const status = await manager.status();
  assert.equal(status.events.length, 1);
  assert.equal(status.events[0].status, 'succeeded');
  assert.equal(status.events[0].resultMatched, true);
  assert.equal(status.events[0].contentHash, null);
  assert.equal(status.bindings[0].coverage.hostVersionVerified, true);
});

test('real Codex standalone failed read preserves exit1 without claiming returned context', async t => {
  const { manager, log, root } = await fixture(t);
  const real = await readFile(new URL('./fixtures/observation/codex-real-failed-read-0.162.1.jsonl', import.meta.url), 'utf8');
  await writeFile(log, real.replaceAll('__WORKTREE__', root.replaceAll('\\', '/')));
  await manager.bind({ agent: 'codex', sessionId: 'real-failed-codex', logFile: log, requestId: randomUUID() });
  const status = await manager.status();
  assert.equal(status.events.length, 1);
  assert.equal(status.events[0].status, 'failed');
  assert.equal(status.events[0].exitCategory, 'nonzero');
  assert.equal(status.events[0].resultMatched, true);
  assert.equal(status.events[0].contentHash, null);
  assert.equal(status.events[0].returnedRange, null);
  assert.equal(status.bindings[0].coverage.hostVersionVerified, true);
});
