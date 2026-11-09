import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, realpath, readFile, writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fixture } from './helpers.mjs'
import { digest } from '../../build/core/json.js'
import { ensureService } from '../../build/service/controller.js'

test('TC23 startup callers wait for the existing owner without spawning another service', async t => {
  const f = await fixture(t)
  const e = await endpoint(t, f, (request, response, record) => health(response, record))
  const root = await realpath(f.dataRoot)
  await unlink(path.join(root, 'service.json'))
  const owner = JSON.stringify({ schemaVersion: 1, pid: process.pid, instanceId: e.record.instanceId, startedAt: e.record.startedAt })
  await writeFile(path.join(root, 'service.lock'), owner)
  const publish = setTimeout(() => { void e.publish() }, 100)
  try {
    const record = await ensureService(root)
    assert.equal(record.instanceId, e.record.instanceId)
    await assert.rejects(readFile(path.join(root, 'service.log')), { code: 'ENOENT' })
    assert.equal(await readFile(path.join(root, 'service.lock'), 'utf8'), owner)
  } finally { clearTimeout(publish); await unlink(path.join(root, 'service.lock')) }
})

async function endpoint(t, f, handler) {
  await mkdir(f.dataRoot, { recursive: true })
  const root = await realpath(f.dataRoot)
  const record = { schemaVersion: 1, protocolVersion: 1, pid: process.pid, instanceId: randomUUID(), startedAt: new Date().toISOString(), dataRootHash: digest('data-root', root), token: randomBytes(32).toString('hex') }
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === '/stop') {
        await unlink(path.join(root, 'service.json')).catch(() => {})
        response.end('{}'); return
      }
      await handler(request, response, record)
    })().catch(error => { response.destroy(error) })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  record.url = `http://127.0.0.1:${server.address().port}`
  const publish = () => writeFile(path.join(root, 'service.json'), JSON.stringify(record))
  await publish()
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return { record, server, publish }
}
function health(response, record, overrides = {}) {
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ state: 'running', instanceId: record.instanceId, pid: record.pid, dataRootHash: record.dataRootHash, protocolVersion: 1, ...overrides }))
}
async function command(request, response) {
  let text = ''
  for await (const chunk of request) text += chunk
  const supplied = JSON.parse(text)
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ schemaVersion: 1, requestId: supplied.requestId, target: null, replayed: false, ok: true, data: { kind: 'command-result', status: 'complete', operation: supplied.operation, result: { items: [] } } }))
  return supplied
}

test('TC23 CLI reaches RPC when health is unavailable, including initialization', async t => {
  const f = await fixture(t)
  let probes = 0, calls = 0
  await endpoint(t, f, async (request, response) => {
    if (request.url === '/health') { probes++; response.writeHead(503); response.end('{}'); return }
    calls++; await command(request, response)
  })
  for (const args of [['project', 'list'], ['init', '--name', 'Example']]) {
    const result = await f.cli(args)
    assert.equal(result.code, 0, result.stdout + result.stderr)
  }
  assert.equal(calls, 2)
  assert.equal(probes, 0, 'ordinary commands must not have a separate health gate')
  assert.equal((await f.cli(['serve', 'stop'])).code, 0)
  assert.equal(probes, 0, 'stop must not depend on a prior health check either')
})

test('TC23 status retries transient health failures and accepts a matching live endpoint independently of PID', async t => {
  const f = await fixture(t)
  let probes = 0
  const e = await endpoint(t, f, async (request, response, record) => {
    if (++probes === 1) { response.writeHead(503); response.end('{}'); return }
    health(response, record, { pid: process.pid })
  })
  e.record.pid = 2147483646
  await e.publish()
  const result = await f.cli(['serve', 'status'])
  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.equal(result.body.data.result.state, 'running')
  assert.ok(probes >= 2)
})

test('TC23 rejected RPC refreshes a rotated endpoint and preserves requestId before execution', async t => {
  const f = await fixture(t)
  const ids = [], requestId = randomUUID()
  let replacement, executions = 0
  const old = await endpoint(t, f, async (request, response, record) => {
    if (request.url === '/health') { health(response, record); return }
    let text = ''
    for await (const chunk of request) text += chunk
    ids.push(JSON.parse(text).requestId)
    await replacement.publish()
    response.writeHead(401); response.end('{}')
  })
  replacement = await endpoint(t, f, async (request, response, record) => {
    if (request.url === '/health') { health(response, record); return }
    executions++; ids.push((await command(request, response)).requestId)
  })
  await old.publish()
  const result = await f.cli(['init', '--request-id', requestId])
  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.deepEqual(ids, [requestId, requestId])
  assert.equal(executions, 1)
})

test('TC23 status distinguishes temporary unavailability from an identity conflict without exposing credentials', async t => {
  const f = await fixture(t)
  let mismatch = false
  const e = await endpoint(t, f, (request, response, record) => {
    if (mismatch) health(response, record, { instanceId: randomUUID() })
    else { response.writeHead(503); response.end('{}') }
  })
  e.record.build = { packageVersion: '0.1.0', sourceCommit: 'a'.repeat(40), sourceDirty: false, runtimeHash: 'b'.repeat(64), unexpected: e.record.token }
  await e.publish()
  const unavailable = await f.cli(['serve', 'status'])
  assert.equal(unavailable.code, 0, unavailable.stdout)
  assert.equal(unavailable.body.data.result.state, 'unavailable')
  assert.equal(unavailable.body.data.result.diagnostic.reason, 'http-unavailable')
  mismatch = true
  const conflict = await f.cli(['serve', 'status'])
  assert.equal(conflict.code, 0, conflict.stdout)
  assert.equal(conflict.body.data.result.state, 'conflict')
  assert.equal(conflict.body.data.result.diagnostic.reason, 'identity-mismatch')
  assert.ok(!unavailable.stdout.includes(e.record.token) && !conflict.stdout.includes(e.record.token))
  assert.equal(JSON.parse(await readFile(path.join(f.dataRoot, 'service.json'), 'utf8')).instanceId, e.record.instanceId)
})

test('TC23 a slow health response is accepted and RPC admission retries do not duplicate execution', async t => {
  const f = await fixture(t)
  let admissions = 0, executions = 0
  const ids = []
  await endpoint(t, f, async (request, response, record) => {
    if (request.url === '/health') { await new Promise(resolve => setTimeout(resolve, 1300)); health(response, record); return }
    let text = ''
    for await (const chunk of request) text += chunk
    const supplied = JSON.parse(text)
    ids.push(supplied.requestId)
    if (++admissions < 3) { response.writeHead(503); response.end('{}'); return }
    executions++
    response.end(JSON.stringify({ schemaVersion: 1, requestId: supplied.requestId, target: null, replayed: false, ok: true, data: { kind: 'command-result', status: 'complete', operation: supplied.operation, result: {} } }))
  })
  const status = await f.cli(['serve', 'status'])
  assert.equal(status.body.data.result.state, 'running', status.stdout)
  const requestId = randomUUID()
  const result = await f.cli(['init', '--request-id', requestId])
  assert.equal(result.code, 0, result.stdout)
  assert.deepEqual(ids, [requestId, requestId, requestId])
  assert.equal(executions, 1)
})

test('TC23 a refused live endpoint is retryable; a dead daemon is recovered under the startup lock', async t => {
  const f = await fixture(t)
  const e = await endpoint(t, f, (request, response, record) => health(response, record))
  e.server.closeAllConnections()
  await new Promise(resolve => e.server.close(resolve))
  const unavailable = await f.cli(['project', 'list'])
  assert.equal(unavailable.body.error.code, 'BUSY', unavailable.stdout)
  assert.equal(unavailable.body.error.retryable, true)
  assert.equal(unavailable.body.error.details.reason, 'connection-refused')
  e.record.pid = 2147483646
  await e.publish()
  const recovered = await f.cli(['project', 'list'])
  assert.equal(recovered.code, 0, recovered.stdout + recovered.stderr)
  const current = JSON.parse(await readFile(path.join(f.dataRoot, 'service.json'), 'utf8'))
  assert.notEqual(current.instanceId, e.record.instanceId)
  assert.equal((await f.cli(['serve', 'status'])).body.data.result.state, 'running')
})

test('TC23 a committed write with a lost response is not resent and can be recovered by the original requestId', async t => {
  const f = await fixture(t)
  const root = await f.repository()
  assert.equal((await f.cli(['init'], { cwd: root })).code, 0)
  const original = JSON.parse(await readFile(path.join(f.dataRoot, 'service.json'), 'utf8'))
  let deliveries = 0
  const proxy = await endpoint(t, f, async (request, response) => {
    if (request.url !== '/rpc') { response.writeHead(503); response.end('{}'); return }
    let text = ''
    for await (const chunk of request) text += chunk
    deliveries++
    const upstream = await fetch(original.url + '/rpc', { method: 'POST', headers: { authorization: 'Bearer ' + original.token, 'x-harness-protocol': '1', 'content-type': 'application/json' }, body: text })
    assert.equal(upstream.status, 200)
    await upstream.json() // The real daemon has committed before the response is lost.
    response.destroy()
  })
  const proxyUrl = proxy.record.url
  Object.assign(proxy.record, original, { url: proxyUrl })
  await proxy.publish()
  const requestId = randomUUID()
  let lost
  try { lost = await f.cli(['task', 'start', '--title', 'Lost response', '--request-id', requestId], { cwd: root }) }
  finally { await writeFile(path.join(f.dataRoot, 'service.json'), JSON.stringify(original)) }
  assert.equal(lost.body.error.code, 'IO_ERROR', lost.stdout)
  assert.equal(lost.body.error.details.outcome, 'unknown')
  assert.equal(lost.body.error.details.requestId, requestId)
  assert.equal(deliveries, 1)
  const list = await f.cli(['task', 'list'], { cwd: root })
  assert.equal(list.body.data.result.items.length, 1)
  const replay = await f.cli(['task', 'start', '--title', 'Lost response', '--request-id', requestId], { cwd: root })
  assert.equal(replay.code, 0, replay.stdout)
  assert.equal(replay.body.replayed, true)
  assert.equal(replay.body.data.taskId, list.body.data.result.items[0].id)
})

test('TC23 RPC rejects wrong instance, data root and protocol before creating a task', async t => {
  const f = await fixture(t)
  const root = await f.repository()
  assert.equal((await f.cli(['init'], { cwd: root })).code, 0)
  const record = JSON.parse(await readFile(path.join(f.dataRoot, 'service.json'), 'utf8'))
  for (const mismatch of [{ 'x-harness-instance': randomUUID() }, { 'x-harness-data-root': '0'.repeat(64) }, { 'x-harness-protocol': '2' }]) {
    const response = await fetch(record.url + '/rpc', { method: 'POST', headers: { authorization: 'Bearer ' + record.token, 'x-harness-protocol': '1', 'content-type': 'application/json', ...mismatch }, body: JSON.stringify({ schemaVersion: 1, requestId: randomUUID(), operation: 'task start', cwd: root, positionals: [], flags: { title: 'Must not execute' } }) })
    assert.equal(response.status, 409)
    await response.arrayBuffer()
  }
  assert.equal((await f.cli(['task', 'list'], { cwd: root })).body.data.result.items.length, 0)
})

test('TC23 stop follows a refreshed service record without requiring health', async t => {
  const f = await fixture(t)
  const replacement = await endpoint(t, f, (request, response) => { response.writeHead(503); response.end('{}') })
  // A stale endpoint rejects credentials while atomically publishing its successor.
  const server = createServer((request, response) => {
    void replacement.publish().then(() => { response.writeHead(401); response.end('{}') })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  await writeFile(path.join(f.dataRoot, 'service.json'), JSON.stringify({ ...replacement.record, url: `http://127.0.0.1:${server.address().port}` }))
  const result = await f.cli(['serve', 'stop'])
  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.equal(result.body.data.result.state, 'stopped')
})
