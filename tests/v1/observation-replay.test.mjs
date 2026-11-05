import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, unlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile as callbackExecFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Archive } from '../../build/core/archive.js'
import { ObservationManager } from '../../build/core/observation.js'
import { Runtime } from '../../build/core/runtime.js'

const execFile = promisify(callbackExecFile)
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'harnessl3-bind-replay-'))
  const root = path.join(directory, 'project')
  await mkdir(root)
  const logFile = path.join(directory, 'actual.jsonl'), alias = path.join(directory, 'alias.jsonl')
  await writeFile(logFile, JSON.stringify({ type: 'session_meta', payload: { id: 'replay-fixture', cwd: root, cli_version: '0.162.1' } }) + '\n')
  await symlink(logFile, alias, 'file')
  const closers = []
  t.after(async () => {
    for (const close of closers.reverse()) await close()
    assert.ok(path.isAbsolute(directory) && path.basename(directory).startsWith('harnessl3-bind-replay-'))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  return { directory, root, logFile, alias, closers }
}

test('TC11 committed observation bind replays before resolving a now dangling log alias', async t => {
  const f = await fixture(t)
  const archive = new Archive(path.join(f.directory, 'archive'))
  const worktree = { id: randomUUID(), projectId: randomUUID(), root: f.root, gitCommonDir: path.join(f.root, '.git'), active: true, available: true, branch: 'main' }
  let queue = Promise.resolve()
  const manager = new ObservationManager({ worktree, archive, serial: work => { const next = queue.then(work); queue = next.catch(() => {}); return next }, pollIntervalMs: 0 })
  f.closers.push(() => manager.close())
  const request = { agent: 'codex', sessionId: 'replay-fixture', logFile: f.alias, requestId: randomUUID() }
  const first = await manager.bind(request)
  await unlink(f.logFile)
  const replay = await manager.bind(request)
  assert.equal(replay.replayed, true)
  assert.deepEqual(replay.bindings, first.bindings)
  assert.equal(archive.records().filter(record => record.requestId === request.requestId).length, 1)
  await assert.rejects(manager.bind({ ...request, logFile: path.join(f.directory, 'other-missing.jsonl') }), { code: 'REQUEST_ID_CONFLICT' })
})

test('TC11 Runtime bind keeps the original request identity after an aliased log disappears', async t => {
  const f = await fixture(t)
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Bind fixture'], ['config', 'user.email', 'fixture@example.invalid']]) await execFile('git', ['-C', f.root, ...args], { windowsHide: true })
  const dataRoot = path.join(f.directory, 'data')
  const runtime = new Runtime(dataRoot)
  f.closers.push(() => runtime.close())
  const request = (operation, flags = {}) => ({ operation, positionals: [], flags, cwd: f.root, requestId: randomUUID(), source: 'cli' })
  const initialized = await runtime.execute(request('init'))
  assert.equal(initialized.ok, true, JSON.stringify(initialized))
  const bind = request('agent bind', { agent: 'codex', session: 'replay-fixture', 'log-file': f.alias })
  const first = await runtime.execute(bind)
  assert.equal(first.ok, true, JSON.stringify(first))
  await unlink(f.logFile)
  const replay = await runtime.execute(bind)
  assert.equal(replay.ok, true, JSON.stringify(replay))
  assert.equal(replay.replayed, true)
  assert.deepEqual(replay.data, first.data)
  const conflict = await runtime.execute({ ...bind, flags: { ...bind.flags, 'log-file': path.join(f.directory, 'other-missing.jsonl') } })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.error.code, 'REQUEST_ID_CONFLICT')
})
