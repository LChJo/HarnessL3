import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { fixture, binary } from './helpers.mjs'

test('TC23 a live startup owner is unavailable, and stop cannot claim it has stopped', async t => {
  const f = await fixture(t)
  await mkdir(f.dataRoot, { recursive: true })
  const owner = { schemaVersion: 1, pid: process.pid, instanceId: randomUUID(), startedAt: new Date().toISOString() }
  const bytes = JSON.stringify(owner)
  const file = path.join(f.dataRoot, 'service.lock')
  await writeFile(file, bytes)
  const status = await f.cli(['serve', 'status'])
  assert.equal(status.code, 0, status.stdout + status.stderr)
  assert.equal(status.body.data.result.state, 'unavailable')
  assert.equal(status.body.data.result.diagnostic.reason, 'startup-in-progress')
  assert.equal(status.body.data.result.diagnostic.instanceId, owner.instanceId)
  const stopped = await f.cli(['serve', 'stop'])
  assert.equal(stopped.body.ok, false, stopped.stdout)
  assert.equal(stopped.body.error.code, 'BUSY')
  assert.equal(stopped.body.error.details.reason, 'startup-in-progress')
  assert.equal(await readFile(file, 'utf8'), bytes)
  assert.doesNotThrow(() => process.kill(owner.pid, 0))
})

test('TC23 a dead startup owner is recovered; an unknown live owner is never killed or replaced', async t => {
  const f = await fixture(t)
  await mkdir(f.dataRoot, { recursive: true })
  await writeFile(path.join(f.dataRoot, 'service.lock'), JSON.stringify({ schemaVersion: 1, pid: 2147483646, instanceId: randomUUID(), startedAt: '2000-01-01T00:00:00.000Z' }))
  const started = await f.cli(['serve', 'start'])
  assert.equal(started.code, 0, started.stderr + started.stdout)
  assert.equal((await f.cli(['serve', 'stop'])).code, 0)
  const foreign = { schemaVersion: 1, pid: process.pid, instanceId: randomUUID(), startedAt: new Date().toISOString() }
  const bytes = JSON.stringify(foreign)
  await writeFile(path.join(f.dataRoot, 'service.lock'), bytes)
  const refused = await f.cli(['serve', 'start'])
  assert.equal(refused.code, 3, refused.stderr + refused.stdout)
  assert.ok(['BUSY', 'SERVICE_CONFLICT'].includes(refused.body.error.code))
  assert.equal(await readFile(path.join(f.dataRoot, 'service.lock'), 'utf8'), bytes)
  assert.doesNotThrow(() => process.kill(process.pid, 0))
})

test('TC23 foreground readiness is one JSON object, and authenticated stop closes the same process', async t => {
  const f = await fixture(t)
  const child = spawn(process.execPath, [binary, 'serve', 'start', '--foreground', '--data-dir', f.dataRoot, '--json'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const exited = once(child, 'exit')
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Foreground not ready: ' + stderr)), 15_000)
    child.stdout.on('data', () => { if (stdout.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(stdout.trim())) } })
    child.once('error', error => { clearTimeout(timer); reject(error) })
  })
  assert.equal(ready.ok, true)
  assert.equal(ready.data.result.state, 'running')
  assert.equal((await f.cli(['serve', 'stop'])).code, 0)
  const [code] = await exited
  assert.equal(code, 0, stderr)
  assert.equal(stdout.trim().split('\n').length, 1)
  assert.equal((await f.cli(['serve', 'status'])).body.data.result.state, 'stopped')
})

test('TC23 service lock and descriptor links cannot redirect private runtime writes', async t => {
  const f = await fixture(t)
  await mkdir(f.dataRoot, { recursive: true })
  const outside = path.join(f.directory, 'outside-lock.json')
  const bytes = JSON.stringify({ schemaVersion: 1, pid: 2147483646, instanceId: randomUUID(), startedAt: '2000-01-01T00:00:00.000Z' })
  await writeFile(outside, bytes)
  await symlink(outside, path.join(f.dataRoot, 'service.lock'), 'file')
  const result = await f.cli(['serve', 'start'])
  assert.equal(result.code, 3, result.stderr + result.stdout)
  assert.equal(await readFile(outside, 'utf8'), bytes)
})

test('TC22 stdin is strict UTF-8 JSON; invalid input does not start a service', async t => {
  const f = await fixture(t)
  for (const input of ['{"schemaVersion":1,"schemaVersion":1}', '\ufeff\ufeff{}', '{"requestId":"bad"}', Buffer.from([0xff])]) {
    const result = await f.cli(['context', 'query', randomUUID(), '--file', '-'], { input })
    assert.equal(result.code, 2, result.stderr + result.stdout)
    assert.equal(result.body.ok, false)
  }
  assert.equal((await f.cli(['serve', 'status'])).body.data.result.state, 'stopped')
})
