import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, access, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile as callbackExecFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFile = promisify(callbackExecFile)
const binary = fileURLToPath(new URL('../../bin/harnessl3.mjs', import.meta.url))
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'harnessl3-cli-help-'))
  const dataRoot = path.join(root, 'unused data root')
  t.after(async () => {
    if (!path.isAbsolute(root) || path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('harnessl3-cli-help-')) throw new Error('Unsafe help fixture cleanup target')
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const help = async (...args) => (await execFile(process.execPath, [binary, ...args, '--help'], { cwd: root, env: { ...process.env, HARNESSL3_HOME: dataRoot }, windowsHide: true })).stdout
  return { root, dataRoot, help }
}

test('TC22 help discovers a command-specific request contract without starting the service', async t => {
  const f = await fixture(t)
  const top = await f.help()
  const selection = await f.help('task', 'select')
  assert.notEqual(selection, top)
  assert.match(selection, /Usage: harnessl3 task select \[<task-id>\] \[--file <path\|->\]/)
  assert.match(selection, /--read/)
  assert.match(selection, /Accepted input schema:/)
  assert.match(selection, /Returns:.*selection/)
  const common = JSON.parse(await readFile(new URL('../../docs/spec/contracts/common.schema.json', import.meta.url), 'utf8'))
  assert.ok(common.$defs.known.description)
  assert.ok(selection.includes('context.known: ' + common.$defs.known.description))
  assert.match(selection, /Check ok before reading data/)
  assert.match(selection, /stdout and stderr separate/)
  const schemaPath = selection.match(/^Request schema: (.+)$/m)?.[1]
  const examplePath = selection.match(/^Request example: (.+)$/m)?.[1]
  assert.ok(schemaPath && path.isAbsolute(schemaPath))
  assert.ok(examplePath && path.isAbsolute(examplePath))
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'))
  const references = [...selection.matchAll(/^Referenced schema: (.+)$/gm)].map(match => match[1])
  assert.ok(references.some(file => path.basename(file) === 'common.schema.json'))
  for (const file of references) assert.equal(typeof JSON.parse(await readFile(file, 'utf8')), 'object')
  const example = JSON.parse(await readFile(examplePath, 'utf8'))
  for (const required of schema.required) assert.ok(selection.includes(required), `Missing request field: ${required}`)
  assert.equal(example.schemaVersion, 1)
  const responsePath = selection.match(/^Response schema: (.+)$/m)?.[1]
  assert.ok(responsePath)
  await access(responsePath)
  assert.equal(await f.help('task', 'select', example.requestId), selection)
  await assert.rejects(access(f.dataRoot))
})

test('TC03/22 model help exposes authoring syntax in the installed usage guide', async t => {
  const f = await fixture(t)
  for (const operation of [['init'], ['model', 'validate']]) {
    const output = await f.help(...operation)
    assert.match(output, /evidence.*single space.*not commas/)
    assert.match(output, /relationship calls.*-\[calls\]->/)
    const guide = output.match(/^Usage guide: (.+)$/m)?.[1]
    assert.ok(guide)
    assert.match(await readFile(guide, 'utf8'), /relationship calls/)
  }
  await assert.rejects(access(f.dataRoot))
})

test('TC22 group help narrows discovery and sync help uses its own schema and parameters', async t => {
  const f = await fixture(t)
  const group = await f.help('task')
  assert.match(group, /task start.*--title/)
  assert.match(group, /task select.*--file/)
  assert.doesNotMatch(group, /migrate prototype/)
  const sync = await f.help('sync', 'verify')
  assert.match(sync, /Usage: harnessl3 sync verify --file <path\|->/)
  assert.match(sync, /sync-proof\.schema\.json/)
  assert.match(sync, /sourceEpoch/)
  assert.match(sync, /reviewScope/)
  assert.match(sync, /new requestId/)
  const status = await f.help('sync', 'status')
  assert.match(status, /SOURCE_CHANGING/)
  assert.match(status, /scanPending:true/)
  const query = await f.help('context', 'query')
  assert.match(query, /known: Use \{\}/)
  assert.doesNotMatch(sync, /known: Use \{\}/)
  const migration = await f.help('migrate', 'prototype')
  assert.match(migration, /--from.*required/i)
  assert.match(migration, /--worktree.*required/i)
  const web = await f.help('web', 'open')
  assert.match(web, /Usage: harnessl3 web open \[--task <UUID>\] \[--no-open\]/)
  assert.match(web, /opened:false/)
  await assert.rejects(access(f.dataRoot))
})

test('TC22 help stays static text with --json; unknown topics produce a structured error', async t => {
  const f = await fixture(t)
  const output = await f.help('task', 'start', '--json')
  assert.match(output, /Usage: harnessl3 task start --title <purpose>/)
  assert.match(output, /--session/)
  assert.ok(output.includes('Response schema:'))
  for (const topic of ['unknown-topic', 'toString']) {
    await assert.rejects(f.help(topic, '--json'), error => {
      assert.equal(error.code, 2)
      assert.equal(JSON.parse(error.stdout).error.code, 'INVALID_ARGUMENT')
      return true
    })
  }
  await assert.rejects(access(f.dataRoot))
})
