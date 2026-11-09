import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { fixture } from './helpers.mjs'
import { Archive } from '../../build/core/archive.js'
import { Runtime } from '../../build/core/runtime.js'
import { startServer } from '../../build/service/main.js'

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
