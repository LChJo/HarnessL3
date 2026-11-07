import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fixture } from './helpers.mjs'
import { Runtime } from '../../build/core/runtime.js'
import { Archive } from '../../build/core/archive.js'

test('TC21 opening a recorded task reuses its loaded journal and still checks its snapshot bytes', async t => {
  const f = await fixture(t, 'harness-v1-web-loading-')
  const root = await f.repository()
  const runtime = new Runtime(f.dataRoot)
  try {
    const call = (operation, positionals = [], flags = {}) => runtime.execute({ operation, positionals, flags, cwd: root, requestId: randomUUID() })
    const initialized = await call('init')
    assert.equal(initialized.ok, true, JSON.stringify(initialized))
    const started = await call('task start', [], { title: 'Open this recorded task' })
    assert.equal(started.ok, true, JSON.stringify(started))
    const worktree = await runtime.registry().worktree(initialized.target.worktreeId)
    const resource = await runtime.worktreeResources(worktree)
    // Extra committed history must not be read from disk again just to decide
    // whether this already loaded task uses the legacy format.
    await resource.archive.commit({ scope: 'loading-regression', requestId: randomUUID(), request: {}, payload: { kind: 'unrelated-history' }, receipt: {} })
    let reopens = 0
    const ready = Archive.prototype.ready
    t.mock.method(Archive.prototype, 'ready', function () {
      if (this.root === resource.archive.root && this !== resource.archive) reopens++
      return ready.call(this)
    })
    const view = await runtime.view(worktree.id, started.data.taskId)
    assert.equal(view.task.id, started.data.taskId)
    const shown = await call('task show', [started.data.taskId])
    assert.equal(shown.ok, true, JSON.stringify(shown))
    assert.equal(reopens, 0, 'opening a known task must not replay all committed history')
    await writeFile(path.join(resource.archive.root, 'snapshots', view.task.modelSnapshotHash + '.json'), '{}')
    await assert.rejects(runtime.view(worktree.id, started.data.taskId), { code: 'ARCHIVE_CORRUPT' })
  } finally { await runtime.close() }
})

test('TC20 Web projects committed task snapshots without renewing reads, and streams only its target', async t => {
  const f = await fixture(t, 'harness-v1-web-service-')
  const root = await f.repository()
  const initialized = await f.cli(['init'], { cwd: root })
  assert.equal(initialized.code, 0, initialized.stdout)
  const target = initialized.body.target
  const started = await f.cli(['task', 'start', '--title', 'Web snapshot'], { cwd: root })
  assert.equal(started.code, 0, started.stdout)
  const taskId = started.body.data.taskId
  const service = JSON.parse(await readFile(path.join(f.dataRoot, 'service.json'), 'utf8'))
  const origin = service.url
  const nonce = await fetch(origin + '/browser-session', { method: 'POST', headers: { authorization: 'Bearer ' + service.token } }).then(response => response.json())
  const authenticated = await fetch(origin + '/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(nonce) })
  assert.equal(authenticated.status, 200)
  const cookie = authenticated.headers.get('set-cookie').split(';')[0]
  const reused = await fetch(origin + '/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(nonce) })
  assert.equal(reused.status, 401)
  const reopened = await fetch(origin + '/session', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(nonce) })
  assert.equal(reopened.status, 200, 'Reopening a used link must reuse a valid browser session')
  assert.equal(reopened.headers.get('set-cookie'), null, 'Reopening must not rotate or extend the existing session')
  assert.equal((await reused.json()).error.code, 'AUTH_REQUIRED')
  const missingCode = { code: '0'.repeat(64) }
  assert.equal((await fetch(origin + '/session', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(missingCode) })).status, 200, 'A valid session remains usable after a link code disappears')
  assert.equal((await fetch(origin + '/session', { method: 'POST', headers: { cookie: 'harnessl3_session=' + '0'.repeat(64), origin, 'content-type': 'application/json' }, body: JSON.stringify(nonce) })).status, 401)
  assert.equal((await fetch(origin + '/session', { method: 'POST', headers: { cookie, origin: 'https://example.invalid', 'content-type': 'application/json' }, body: JSON.stringify(nonce) })).status, 403)
  const freshNonce = await fetch(origin + '/browser-session', { method: 'POST', headers: { authorization: 'Bearer ' + service.token } }).then(response => response.json())
  const loggedInFreshLink = await fetch(origin + '/session', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(freshNonce) })
  assert.equal(loggedInFreshLink.status, 200)
  assert.equal(loggedInFreshLink.headers.get('set-cookie'), null)
  assert.equal((await fetch(origin + '/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(freshNonce) })).status, 401, 'An already signed-in browser still consumes a new one-time code')
  const projects = await fetch(origin + '/rpc', { method: 'POST', headers: { cookie, origin, 'x-harness-web': '1', 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'project list', positionals: [], flags: {}, requestId: randomUUID() }) }).then(response => response.json())
  assert.equal(projects.ok, true, JSON.stringify(projects))
  assert.equal(projects.data.result.items[0].id, target.projectId)
  const endpoint = origin + '/view?' + new URLSearchParams({ worktree: target.worktreeId, task: taskId })
  assert.equal((await fetch(endpoint)).status, 401)
  const preview = await fetch(endpoint, { headers: { cookie } })
  assert.equal(preview.status, 200)
  const view = await preview.json()
  assert.equal(view.task.id, taskId)
  assert.equal(view.historical, true)
  assert.equal(view.model.revision, started.body.data.binding.modelRevision)
  assert.ok(view.model.views.length)
  assert.equal(view.task.lastReadAt, null)
  const repeated = await fetch(endpoint, { headers: { cookie } }).then(response => response.json())
  assert.equal(repeated.task.retentionBasisAt, view.task.retentionBasisAt)
  assert.equal(repeated.task.batches.length, 0)
  const command = { operation: 'task start', positionals: [], flags: { title: 'Web manual task', worktree: target.worktreeId }, requestId: randomUUID(), cwd: root }
  assert.equal((await fetch(origin + '/rpc', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(command) })).status, 401)
  const controller = new AbortController()
  t.after(() => controller.abort())
  const stream = await fetch(origin + '/events?' + new URLSearchParams({ worktree: target.worktreeId, after: String(view.seq) }), { headers: { cookie }, signal: controller.signal })
  assert.equal(stream.status, 200)
  assert.match(stream.headers.get('content-type'), /text\/event-stream/)
  const reader = stream.body.getReader()
  const first = new TextDecoder().decode((await reader.read()).value)
  assert.match(first, /event: (ready|reset)/)
  const response = await fetch(origin + '/rpc', { method: 'POST', headers: { cookie, origin, 'x-harness-web': '1', 'content-type': 'application/json' }, body: JSON.stringify(command) }).then(response => response.json())
  assert.equal(response.ok, true, JSON.stringify(response))
  const chunk = new TextDecoder().decode((await reader.read()).value)
  assert.match(chunk, /event: commit/)
  assert.ok(chunk.includes(target.worktreeId))
  await reader.cancel()
  const shown = await f.cli(['task', 'show', response.data.taskId], { cwd: root })
  assert.equal(shown.body.data.result.task.source, 'web')
  const frozen = await fetch(endpoint, { headers: { cookie } }).then(response => response.json())
  assert.equal(frozen.task.id, taskId)
  assert.equal(frozen.task.batches.length, 0)
})
