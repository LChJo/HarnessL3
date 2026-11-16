import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { fixture } from './helpers.mjs'
import { Archive } from '../../build/core/archive.js'
import { Runtime } from '../../build/core/runtime.js'
import { FreshnessManager } from '../../build/core/freshness.js'
import { startServer } from '../../build/service/main.js'

test('TC17 snapshot entry and archived handoff do not wait for source-observation state restoration', async t => {
  const f = await fixture(t)
  const root = await f.repository()
  const initialized = await f.cli(['init'], { cwd: root })
  assert.equal(initialized.code, 0)
  const started = await f.cli(['task', 'start', '--title', 'Historical context'], { cwd: root })
  assert.equal(started.code, 0, started.stdout)
  const taskId = started.body.data.taskId
  assert.equal((await f.cli(['task', 'select', taskId], { cwd: root })).code, 0)
  await f.cli(['serve', 'stop'])
  const dataRoot = await realpath(f.dataRoot), runtime = new Runtime(dataRoot)
  // Fail on the forbidden dependency itself, independent of Git/filesystem speed.
  const restore = t.mock.method(FreshnessManager.prototype, 'ready', async function () { throw new Error('Fixture source restoration is unavailable') })
  const request = runtime.execute({ operation: 'task handoff', requestId: randomUUID(), cwd: root, positionals: [taskId], flags: {} })
  try {
    const result = await request
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.data.kind, 'handoff')
    assert.equal(result.data.binding.sourceVersion.status, 'unknown')
    const entry = await runtime.execute({ operation: 'task start', requestId: randomUUID(), cwd: root, positionals: [], flags: { title: 'Snapshot without source restoration' } })
    assert.equal(entry.ok, true, JSON.stringify(entry))
    assert.equal(entry.data.binding.mode, 'snapshot')
    assert.equal(entry.data.binding.sourceVersion.status, 'unknown')
    assert.equal(restore.mock.callCount(), 0, 'snapshot and archived reads must not request source-state restoration')
    const live = await runtime.execute({ operation: 'sync status', requestId: randomUUID(), cwd: root, positionals: [], flags: {} })
    assert.equal(live.ok, false, 'the same unavailable dependency must still block current source checks')
    assert.equal(restore.mock.callCount(), 1, 'negative control proves the mocked dependency is reachable')
  } finally { await request; await runtime.close() }
})

test('TC17 subscription resumption leaves unrelated snapshot recovery until its workspace is requested', async t => {
  const f = await fixture(t)
  const root = await f.repository()
  const initialized = await f.cli(['init'], { cwd: root })
  assert.equal(initialized.code, 0, initialized.stdout)
  await f.cli(['serve', 'stop'])
  const dataRoot = await realpath(f.dataRoot), worktree = initialized.body.data.result.worktree
  const archiveRoot = path.join(dataRoot, 'worktrees', worktree.id), writer = new Archive(archiveRoot)
  const hash = await writer.snapshot('unrelated-history', { historical: true })
  await writer.commit({ scope: 'history', requestId: randomUUID(), request: {}, payload: { kind: 'synthetic-history' }, receipt: {}, archives: [{ kind: 'snapshot', hash }] })
  let reads = 0
  const original = Archive.prototype.readSnapshot
  t.mock.method(Archive.prototype, 'readSnapshot', function (requested) { if (this.root === archiveRoot && requested === hash) reads++; return original.call(this, requested) })
  const runtime = new Runtime(dataRoot)
  try {
    await runtime.ready()
    assert.equal(reads, 0, 'no explicit log binding needs this historical body at startup')
    await runtime.worktreeResources(worktree)
    assert.equal(reads, 1, 'target access still performs full reference validation')
  } finally { await runtime.close() }
})

test('TC23 control readiness and RPC remain available while archive recovery is pending', async t => {
  const f = await fixture(t)
  const root = await f.repository()
  const initialized = await f.cli(['init'], { cwd: root })
  assert.equal(initialized.code, 0, initialized.stdout + initialized.stderr)
  assert.equal((await f.cli(['serve', 'stop'])).code, 0)
  const dataRoot = await realpath(f.dataRoot)
  const archiveRoot = path.join(dataRoot, 'worktrees', initialized.body.data.result.worktree.id)
  await new Archive(archiveRoot).commit({ scope: 'synthetic-history', requestId: randomUUID(), request: {}, payload: {}, receipt: {} })
  let release, timer, lifecycle
  const gate = new Promise(resolve => { release = resolve })
  const original = Archive.prototype.ready
  t.mock.method(Archive.prototype, 'ready', function () { return this.root === archiveRoot ? gate.then(() => original.call(this)) : original.call(this) })
  const ready = new Promise((resolve, reject) => { lifecycle = startServer(dataRoot, 0, resolve); lifecycle.catch(reject) })
  try {
    const record = await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Control readiness waited for blocked archive recovery')), 5000) })])
    const headers = { authorization: 'Bearer ' + record.token, 'content-type': 'application/json' }
    const health = await fetch(record.url + '/health', { headers }).then(response => response.json())
    assert.equal(health.state, 'running')
    assert.equal(health.recovery.state, 'recovering')
    const rpc = await fetch(record.url + '/rpc', { method: 'POST', headers, body: JSON.stringify({ operation: 'project list', requestId: randomUUID(), cwd: root, positionals: [], flags: {} }) }).then(response => response.json())
    assert.equal(rpc.ok, true, JSON.stringify(rpc))
    const gc = await fetch(record.url + '/rpc', { method: 'POST', headers, signal: AbortSignal.timeout(2000), body: JSON.stringify({ operation: 'gc', requestId: randomUUID(), cwd: root, positionals: [], flags: { apply: true } }) }).then(response => response.json())
    assert.equal(gc.ok, false)
    assert.equal(gc.error.code, 'BUSY', 'cleanup must not race archive recovery')
  } finally {
    clearTimeout(timer); release()
    const record = await ready
    await fetch(record.url + '/stop', { method: 'POST', headers: { authorization: 'Bearer ' + record.token } }).then(response => response.arrayBuffer())
    await lifecycle
  }
})

test('TC17 startup and first worktree access recover the same committed archive once', async t => {
  const f = await fixture(t)
  const root = await f.repository()
  const initialized = await f.cli(['init'], { cwd: root })
  assert.equal(initialized.code, 0, initialized.stdout + initialized.stderr)
  const worktree = initialized.body.data.result.worktree
  assert.equal((await f.cli(['serve', 'stop'])).code, 0)
  const dataRoot = await realpath(f.dataRoot)
  const archiveRoot = path.join(dataRoot, 'worktrees', worktree.id)
  const writer = new Archive(archiveRoot)
  const hash = await writer.snapshot('synthetic-history', { padding: 'x'.repeat(256 * 1024) })
  await writer.commit({ scope: 'synthetic-history', requestId: randomUUID(), request: {}, payload: { kind: 'synthetic-history' }, receipt: {}, archives: [{ kind: 'snapshot', hash }] })
  let reads = 0
  const read = Archive.prototype.readSnapshot
  t.mock.method(Archive.prototype, 'readSnapshot', function (requested) {
    if (this.root === archiveRoot && requested === hash) reads++
    return read.call(this, requested)
  })
  const runtime = new Runtime(dataRoot)
  try {
    await runtime.ready()
    await runtime.worktreeResources(worktree)
    assert.equal(reads, 1, 'startup, task resources and legacy listing must share verified recovery')
  } finally { await runtime.close() }
})
