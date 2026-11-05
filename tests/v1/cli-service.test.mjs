import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { execFile, fixture, binary } from './helpers.mjs'
import path from 'node:path'

test('TC22 static help/version do not start a service; invalid flags return one JSON error', async t => {
  const f = await fixture(t)
  const help = await execFile(process.execPath, [binary, '--help'], { cwd: f.directory, windowsHide: true, env: { ...process.env, HARNESSL3_HOME: f.dataRoot } })
  assert.match(help.stdout, /task start/)
  await assert.rejects(access(f.dataRoot))
  for (const args of [['project', 'list', '--unknown'], ['project', 'list', '--project', randomUUID(), '--project', randomUUID()], ['serve', 'start', '--port', '65536']]) {
    const response = await f.cli(args)
    assert.equal(response.code, 2, response.stderr + response.stdout)
    assert.equal(response.body?.ok, false)
    assert.equal(response.body.error.code, 'INVALID_ARGUMENT')
    assert.equal(response.body.target, null)
    assert.match(response.body.requestId, /^[a-f0-9-]{36}$/)
  }
  await assert.rejects(access(path.join(f.dataRoot, 'service.json')))
})

test('TC01/03 CLI init and registrations survive daemon restart without changing source or user skills', async t => {
  const f = await fixture(t)
  const roots = [await f.repository('Example \u4e2d\u6587'), await f.repository('Another Example')]
  const first = await f.cli(['init', '--name', 'Example'], { cwd: roots[0] })
  assert.equal(first.code, 0, first.stderr + first.stdout)
  assert.equal(first.body.data.operation, 'init')
  const id = first.body.data.result.worktree.id
  const model = path.join(roots[0], '.harness/model/main.c4')
  const original = await readFile(model, 'utf8')
  const license = path.join(f.dataRoot, 'skills/LICENSE')
  await writeFile(license, 'User customized license note\n')
  const again = await f.cli(['init', '--name', 'Do not rename'], { cwd: roots[0] })
  assert.equal(again.code, 0, again.stderr + again.stdout)
  assert.equal(again.body.data.result.worktree.id, id)
  assert.equal(again.body.data.result.project.name, 'Example')
  assert.equal(await readFile(model, 'utf8'), original)
  assert.equal(await readFile(license, 'utf8'), 'User customized license note\n')
  assert.equal((await f.cli(['init'], { cwd: roots[1] })).code, 0)
  assert.equal((await f.cli(['project', 'list'])).body.data.result.items.length, 2)
  assert.equal((await f.cli(['serve', 'stop'])).body.data.result.state, 'stopped')
  const list = await f.cli(['worktree', 'list'])
  assert.equal(list.code, 0, list.stderr + list.stdout)
  assert.equal(list.body.data.result.items.length, 2)
  assert.ok(list.body.data.result.items.some(item => item.id === id))
  const conflict = await f.cli(['model', 'validate', '--worktree', id], { cwd: roots[1] })
  assert.equal(conflict.body.error.code, 'TARGET_CONFLICT')
})

test('TC23 concurrent first calls discover exactly one authenticated service on a dynamic port', async t => {
  const f = await fixture(t)
  const responses = await Promise.all(Array.from({ length: 6 }, () => f.cli(['project', 'list'])))
  assert.ok(responses.every(response => response.code === 0), responses.map(r => r.stderr + r.stdout).join('\n'))
  const statuses = await Promise.all(Array.from({ length: 3 }, () => f.cli(['serve', 'status'])))
  const ids = new Set(statuses.map(response => response.body.data.result.instanceId))
  assert.equal(ids.size, 1)
  assert.ok([...ids][0])
  const descriptor = JSON.parse(await readFile(path.join(f.dataRoot, 'service.json'), 'utf8'))
  assert.match(descriptor.url, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.notEqual(new URL(descriptor.url).port, '0')
  assert.ok(!statuses[0].stdout.includes(descriptor.token))
  const unauthorized = await fetch(descriptor.url + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(unauthorized.status, 401)
  const crossOrigin = await fetch(descriptor.url + '/rpc', { method: 'POST', headers: { authorization: 'Bearer ' + descriptor.token, origin: 'https://example.invalid', 'content-type': 'application/json' }, body: '{}' })
  assert.equal(crossOrigin.status, 403)
  const wrongVersion = await fetch(descriptor.url + '/health', { headers: { authorization: 'Bearer ' + descriptor.token, 'x-harness-protocol': '2' } })
  assert.equal(wrongVersion.status, 409)
  const page = await fetch(descriptor.url)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /HarnessL3/)
  assert.equal((await f.cli(['serve', 'stop'])).code, 0)
  assert.equal((await f.cli(['serve', 'status'])).body.data.result.state, 'stopped')
})

test('TC23 an occupied explicit port is diagnosed without joining the other HTTP server', async t => {
  const f = await fixture(t)
  const foreign = createServer((req, res) => res.end('foreign'))
  await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => foreign.close(resolve)))
  const result = await f.cli(['serve', 'start', '--port', String(foreign.address().port)])
  assert.equal(result.code, 3, result.stderr + result.stdout)
  assert.equal(result.body.error.code, 'SERVICE_CONFLICT')
  assert.equal((await f.cli(['serve', 'status'])).body.data.result.state, 'stopped')
})
