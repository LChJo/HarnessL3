import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fixture, execFile } from './helpers.mjs'
import { loadModel } from '../../build/core/model.js'

const usage = (await readFile(new URL('../../docs/USAGE.md', import.meta.url), 'utf8')).replaceAll('\r\n', '\n')

test('TC03 the installed guide model example passes the actual model validator', async t => {
  const f = await fixture(t, 'harnessl3-init-contract-')
  const root = path.join(f.directory, 'model example')
  await mkdir(path.join(root, '.harness', 'model'), { recursive: true })
  const example = usage.match(/```likec4\n([\s\S]*?)\n```/)?.[1]
  assert.ok(example)
  await writeFile(path.join(root, '.harness/model/main.c4'), example)
  await writeFile(path.join(root, '.harness/evidence.json'), JSON.stringify({ schemaVersion: 1, evidence: [] }))
  await writeFile(path.join(root, '.harness/aliases.json'), JSON.stringify({ schemaVersion: 1, aliases: {} }))
  const snapshot = await loadModel(root)
  assert.equal(snapshot.entities.length, 3)
  assert.equal(snapshot.entities.find(entity => entity.entityType === 'relation').kind, 'calls')
  assert.equal(snapshot.views.length, 1)
})

test('TC03/07 failed task entry preserves diagnostics and has no data; explicit boundary exclusion recovers', async t => {
  const f = await fixture(t, 'harnessl3-init-contract-')
  const root = await f.repository()
  const nested = path.join(root, 'reference', 'historical')
  await mkdir(nested, { recursive: true })
  await f.git(nested, 'init')
  await writeFile(path.join(nested, 'README.md'), 'Separate repository\n')
  const initialized = await f.cli(['init'], { cwd: root })
  assert.equal(initialized.code, 0, initialized.stdout)
  const failed = await f.cli(['task', 'start', '--title', 'Nested repository review'], { cwd: root })
  assert.equal(failed.code, 3, failed.stdout)
  assert.equal(failed.body.ok, false)
  assert.equal(Object.hasOwn(failed.body, 'data'), false)
  assert.equal(failed.body.error.code, 'SOURCE_CHANGED')
  assert.ok(failed.body.error.details.diagnostics.some(d => d.code === 'SOURCE_NESTED_REPOSITORY' && d.file === 'reference/historical'))
  const configPath = path.join(root, '.harness/project.json')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  assert.deepEqual(config.source.excludePatterns, [])
  config.source.excludePatterns.push('reference/historical')
  await writeFile(configPath, JSON.stringify(config))
  const recovered = await f.cli(['task', 'start', '--title', 'Explicit source scope'], { cwd: root })
  assert.equal(recovered.code, 0, recovered.stdout)
  assert.equal(recovered.body.ok, true)
  assert.equal(await readFile(path.join(nested, 'README.md'), 'utf8'), 'Separate repository\n')
})

test('TC22 the documented result reader preserves failure and partial exit codes', async t => {
  const f = await fixture(t, 'harnessl3-init-contract-')
  const reader = usage.match(/```javascript\n(import \{ readFileSync \}[\s\S]*?)\n```/)?.[1]
  assert.ok(reader)
  const script = path.join(f.directory, 'read-result.mjs')
  const response = path.join(f.directory, 'response.json')
  await writeFile(script, reader)
  const failed = { schemaVersion: 1, ok: false, error: { code: 'SOURCE_CHANGED', details: { diagnostics: [{ code: 'SOURCE_NESTED_REPOSITORY', file: 'reference/historical' }] } } }
  await writeFile(response, JSON.stringify(failed))
  await assert.rejects(execFile(process.execPath, [script, '3', response], { windowsHide: true }), error => {
    assert.equal(error.code, 3)
    assert.equal(error.stdout, '')
    assert.deepEqual(JSON.parse(error.stderr), failed)
    return true
  })
  await writeFile(response, JSON.stringify({ ok: true, data: { status: 'partial', contexts: [] } }))
  await assert.rejects(execFile(process.execPath, [script, '4', response], { windowsHide: true }), error => {
    assert.equal(error.code, 4)
    assert.equal(JSON.parse(error.stdout).status, 'partial')
    return true
  })
})

test('TC22 PowerShell guard stops before dependent data access on a failed envelope', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, 'harnessl3-init-contract-')
  const guard = usage.match(/```powershell\n(\$response = \(\$responseText[\s\S]*?)\n```/)?.[1]
  assert.ok(guard)
  const script = path.join(f.directory, 'guard.ps1')
  await writeFile(script, `$responseText = '{"ok":false,"error":{"code":"SOURCE_CHANGED"}}'\n$cliCode = 3\n${guard}\nWrite-Output 'DEPENDENT-DATA-ACCESS'\n`)
  await assert.rejects(execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script], { windowsHide: true }), error => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /SOURCE_CHANGED/)
    assert.ok(!error.stdout.includes('DEPENDENT-DATA-ACCESS'))
    assert.ok(!error.stderr.includes('Get-Member'))
    return true
  })
})
