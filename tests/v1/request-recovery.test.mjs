import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, realpath, writeFile, unlink, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fixture } from './helpers.mjs'
import { digest } from '../../build/core/json.js'
import { RequestTracker, reportProgress } from '../../build/core/progress.js'
import { execFile, binary } from './helpers.mjs'

test('TC22 a silent RPC has a bounded wait, an early request ID and an actionable unknown result', async t => {
  const f = await fixture(t, 'harness-request-deadline-')
  await mkdir(f.dataRoot)
  const root = await realpath(f.dataRoot)
  let deliveries = 0
  const server = createServer(async (request, response) => {
    if (request.url === '/stop') { await unlink(path.join(root, 'service.json')); response.end('{}'); return }
    if (request.url !== '/rpc') { response.writeHead(404); response.end('{}'); return }
    for await (const _ of request) { /* Accept the request but deliberately retain its response. */ }
    deliveries++
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  await writeFile(path.join(root, 'service.json'), JSON.stringify({
    schemaVersion: 1, protocolVersion: 1, pid: process.pid, instanceId: randomUUID(),
    startedAt: new Date().toISOString(), dataRootHash: digest('data-root', root),
    token: randomBytes(32).toString('hex'), url: `http://127.0.0.1:${server.address().port}`,
  }))
  const requestId = randomUUID(), before = Date.now()
  const result = await f.cli(['project', 'list', '--request-id', requestId, '--timeout-ms', '400'])
  assert.equal(result.body?.error.code, 'REQUEST_TIMEOUT', result.stdout + result.stderr)
  assert.equal(result.body.error.details.requestId, requestId)
  assert.equal(result.body.error.details.outcome, 'unknown')
  assert.equal(result.body.error.details.nextAction, 'query-request')
  assert.equal(result.body.error.retryable, false, 'an unknown write result must not invite blind retries')
  assert.match(result.stderr, new RegExp(requestId))
  assert.equal(deliveries, 1)
  assert.ok(Date.now() - before < 10_000)
  assert.equal(result.stdout.trim().split('\n').length, 1)
})

test('TC22/23 request status recovers a committed task receipt across restart and preserves unknown outcomes', async t => {
  const f = await fixture(t, 'harness-request-receipt-')
  const root = await f.repository()
  assert.equal((await f.cli(['init'], { cwd: root })).code, 0)
  const requestId = randomUUID()
  const started = await f.cli(['task', 'start', '--title', 'Recover this result', '--request-id', requestId], { cwd: root })
  assert.equal(started.code, 0, started.stdout)
  for (const restart of [false, true]) {
    if (restart) assert.equal((await f.cli(['serve', 'stop'])).code, 0)
    const status = await f.cli(['request', 'status', requestId], { cwd: root })
    assert.equal(status.code, 0, status.stdout + status.stderr)
    assert.equal(status.body.data.result.state, 'completed')
    assert.equal(status.body.data.result.receipt.requestId, requestId)
    assert.deepEqual(status.body.data.result.receipt.data, started.body.data)
  }
  const unknown = await f.cli(['request', 'status', randomUUID()], { cwd: root })
  assert.equal(unknown.body.data.result.state, 'unknown')
  assert.equal(unknown.body.data.result.outcome, 'unknown')
  const second = await f.repository('other-project')
  assert.equal((await f.cli(['init'], { cwd: second })).code, 0)
  const other = await f.cli(['request', 'status', requestId], { cwd: second })
  assert.equal(other.body.data.result.receipt, undefined, 'receipt lookup must stay inside the resolved target')
})

test('TC22/23 progress tracking joins in-flight retries, rejects changed intent and bounds concurrent work', async () => {
  const tracker = new RequestTracker(1, 4096, 1)
  const target = { projectId: randomUUID(), worktreeId: randomUUID() }
  const request = { operation: 'task start', positionals: [], flags: { title: 'Tracked' }, requestId: randomUUID(), cwd: '/isolated-project' }
  let release, calls = 0
  const gate = new Promise(resolve => { release = resolve })
  const operation = async () => { calls++; reportProgress({ phase: 'scanning-source', completed: 2, total: 10, target }); await gate; return { schemaVersion: 1, requestId: request.requestId, target, replayed: false, ok: true, data: {} } }
  const first = tracker.run(request, operation)
  const second = tracker.run(request, operation)
  assert.equal(tracker.progress(request.requestId).phase, 'scanning-source')
  assert.equal(tracker.progress(request.requestId).completed, 2)
  await assert.rejects(tracker.run({ ...request, flags: { title: 'Different' } }, operation), { code: 'REQUEST_ID_CONFLICT' })
  await assert.rejects(tracker.run({ ...request, requestId: randomUUID() }, operation), error => error.code === 'BUSY' && error.details.outcome === 'not-executed')
  release()
  assert.equal((await first).replayed, false)
  assert.equal((await second).replayed, true)
  assert.equal(calls, 1)
  assert.equal(tracker.result(request.requestId, { ...target, worktreeId: randomUUID() }, request.cwd), null)
})

test('TC17 refused admission cannot make completed response retention exceed its byte budget', async () => {
  const tracker = new RequestTracker(10, 1000, 1)
  const target = { projectId: randomUUID(), worktreeId: randomUUID() }, cwd = '/isolated-project'
  const first = { operation: 'task start', flags: { title: 'First' }, positionals: [], requestId: randomUUID(), cwd }
  const second = { ...first, requestId: randomUUID(), flags: { title: 'Second' } }
  const response = request => ({ schemaVersion: 1, requestId: request.requestId, target, replayed: false, ok: true, data: { padding: 'x'.repeat(650) } })
  await tracker.run(first, async () => response(first))
  let release
  const pending = tracker.run(second, () => new Promise(resolve => { release = () => resolve(response(second)) }))
  for (let i = 0; i < 3; i++) await assert.rejects(tracker.run(first, async () => response(first)), { code: 'BUSY' })
  release(); await pending
  const retained = [first, second].filter(request => tracker.result(request.requestId, target, cwd)?.receipt)
  assert.equal(retained.length, 1, 'the two original responses cannot both fit the configured byte budget')
})

test('TC22 bootstrap import failures retain one JSON envelope and the supplied request ID', async t => {
  const f = await fixture(t, 'harness-request-bootstrap-')
  const entry = path.join(f.directory, 'bin/harnessl3.mjs')
  await mkdir(path.dirname(entry))
  await writeFile(entry, await readFile(binary))
  const id = randomUUID()
  const result = await execFile(process.execPath, [entry, '--json', '--request-id', id], { windowsHide: true }).catch(error => error)
  assert.equal(result.code, 1)
  assert.equal(JSON.parse(result.stdout).error.code, 'CLI_LOAD_FAILED')
  assert.equal(JSON.parse(result.stdout).requestId, id)
  assert.equal(result.stderr, '')
})

test('TC22/23 a timed-out committed write is recovered by status without dispatching a second write', async t => {
  const f = await fixture(t, 'harness-request-committed-')
  const root = await f.repository()
  assert.equal((await f.cli(['init'], { cwd: root })).code, 0)
  const file = path.join(f.dataRoot, 'service.json')
  const original = JSON.parse(await readFile(file, 'utf8'))
  let committed, release, deliveries = 0
  const commit = new Promise(resolve => { committed = resolve })
  const hold = new Promise(resolve => { release = resolve })
  const proxy = createServer((request, response) => {
    void (async () => {
      if (request.url !== '/rpc') { response.writeHead(404); response.end('{}'); return }
      let bytes = ''
      for await (const chunk of request) bytes += chunk
      deliveries++
      const upstream = await fetch(original.url + '/rpc', { method: 'POST', headers: { authorization: 'Bearer ' + original.token, 'x-harness-protocol': '1', 'content-type': 'application/json' }, body: bytes })
      const receipt = await upstream.json()
      committed(receipt)
      await hold
      response.end(JSON.stringify(receipt))
    })().catch(error => response.destroy(error))
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  t.after(async () => { release(); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)) })
  await writeFile(file, JSON.stringify({ ...original, url: `http://127.0.0.1:${proxy.address().port}` }))
  const id = randomUUID()
  let result
  try { result = await f.cli(['task', 'start', '--title', 'Keep this committed task', '--request-id', id, '--timeout-ms', '1500'], { cwd: root }) }
  finally { await writeFile(file, JSON.stringify(original)); release() }
  assert.equal(result.body.error.code, 'REQUEST_TIMEOUT', result.stdout)
  assert.equal(result.body.error.details.outcome, 'unknown')
  const receipt = await commit
  assert.equal(receipt.ok, true)
  const status = await f.cli(['request', 'status', id], { cwd: root })
  assert.deepEqual(status.body.data.result.receipt, receipt)
  assert.equal(deliveries, 1)
  assert.equal((await f.cli(['task', 'list'], { cwd: root })).body.data.result.total, 1)
})
