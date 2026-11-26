import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fixture } from './helpers.mjs'
import { Runtime } from '../../build/core/runtime.js'
import { Archive } from '../../build/core/archive.js'
import { FreshnessManager } from '../../build/core/freshness.js'

async function setup(t) {
  const cleanup = []
  const f = await fixture({ after: callback => cleanup.push(callback) }, 'harness-v1-browse-')
  const root = await f.repository()
  const writer = new Runtime(f.dataRoot)
  const call = (runtime, operation, positionals = [], flags = {}, source = 'cli') => runtime.execute({ operation, positionals, flags, source, cwd: root, requestId: randomUUID() })
  const init = await call(writer, 'init')
  assert.equal(init.ok, true, JSON.stringify(init))
  const started = await call(writer, 'task start', [], { title: 'Archived output' })
  assert.equal(started.ok, true, JSON.stringify(started))
  const id = init.target.worktreeId, taskId = started.data.taskId
  const resource = await writer.worktreeResources(await writer.registry().worktree(id))
  const unrelated = await resource.archive.snapshot('unrelated-history', { padding: 'x'.repeat(200_000) })
  for (let i = 0; i < 8; i++) await resource.archive.commit({ scope: 'browse-fixture', requestId: randomUUID(), request: { i }, payload: { kind: 'unrelated-history', i }, receipt: { i }, archives: [{ kind: 'snapshot', hash: unrelated }] })
  const modelHash = resource.tasks.tasks()[0].modelSnapshotHash
  const archiveRoot = resource.archive.root
  await writer.close()
  const runtime = new Runtime(f.dataRoot)
  t.after(async () => { await runtime.close(); for (const callback of cleanup) await callback() })
  return { ...f, root, id, taskId, archiveRoot, modelHash, unrelated, runtime, call: (...args) => call(runtime, ...args) }
}

test('TC17/21 cold project browsing never opens unrelated snapshot bodies or initializes synchronization', async t => {
  const f = await setup(t)
  const original = Archive.prototype.readSnapshot
  let unrelatedReads = 0
  t.mock.method(Archive.prototype, 'readSnapshot', function(hash) {
    if (hash === f.unrelated) { unrelatedReads++; throw Error('Unrelated history blocked browsing') }
    return original.call(this, hash)
  })
  t.mock.method(FreshnessManager.prototype, 'ready', () => { throw Error('Browsing initialized synchronization') })
  const before = await readFile(path.join(f.archiveRoot, 'journal.jsonl'))
  const listed = await f.call('task list', [], {}, 'web')
  assert.equal(listed.ok, true, JSON.stringify(listed))
  assert.equal(listed.data.result.items[0].id, f.taskId)
  const viewed = await f.runtime.view(f.id, f.taskId)
  assert.equal(viewed.task.id, f.taskId)
  assert.equal(viewed.archive.archive.verificationScope, 'requested')
  assert.equal(unrelatedReads, 0)
  assert.deepEqual(await readFile(path.join(f.archiveRoot, 'journal.jsonl')), before)
})

test('TC13/21 selected snapshot corruption is rejected even after a successful browse', async t => {
  const f = await setup(t)
  assert.equal((await f.runtime.view(f.id, f.taskId)).task.id, f.taskId)
  await writeFile(path.join(f.archiveRoot, 'snapshots', f.modelHash + '.json'), '{}')
  await assert.rejects(f.runtime.view(f.id, f.taskId), { code: 'ARCHIVE_CORRUPT' })
})

test('TC13/17 unrelated damage stays outside ordinary metadata reads and explicit CLI audit still detects it', async t => {
  const f = await setup(t)
  await writeFile(path.join(f.archiveRoot, 'snapshots', f.unrelated + '.json'), '{}')
  assert.equal((await f.runtime.view(f.id, f.taskId)).task.id, f.taskId)
  const listed = await f.call('task list')
  assert.equal(listed.ok, true)
  assert.equal(listed.data.result.workspaceIntegrity, 'unknown')
  const strict = await f.call('archive audit')
  assert.equal(strict.ok, false)
  assert.ok(['ARCHIVE_CORRUPT', 'INDEX_UNAVAILABLE'].includes(strict.error.code), JSON.stringify(strict))
})

test('TC16/21 a missing or malformed browse index is rebuilt from the journal without rewriting history', async t => {
  const f = await setup(t)
  const index = path.join(f.archiveRoot, 'browse-index.json')
  for (const content of [null, '{}']) {
    if (content === null) await rm(index, { force: true }); else await writeFile(index, content)
    const before = await readFile(path.join(f.archiveRoot, 'journal.jsonl'))
    assert.equal((await f.runtime.view(f.id, f.taskId)).task.id, f.taskId)
    assert.deepEqual(await readFile(path.join(f.archiveRoot, 'journal.jsonl')), before)
  }
  await rm(path.join(f.archiveRoot, 'journal.jsonl'))
  await assert.rejects(f.runtime.view(f.id, f.taskId), error => ['NOT_FOUND', 'ARCHIVE_CORRUPT'].includes(error.code))
})

test('TC17/21 browsing and new tasks do not wait for an in-flight explicit full archive audit', async t => {
  const f = await setup(t)
  const original = Archive.prototype.readSnapshot
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  t.mock.method(Archive.prototype, 'readSnapshot', async function(hash) {
    if (hash === f.unrelated && this.verificationScope === 'workspace') { entered(); await gate }
    return original.call(this, hash)
  })
  const strict = f.call('archive audit')
  try {
    await Promise.race([started, strict.then(result => { throw Error('Full restore did not enter the held reference: ' + JSON.stringify(result)) }), new Promise((_, reject) => setTimeout(() => reject(Error('Reference gate was never reached')), 3000))])
    const view = await Promise.race([f.runtime.view(f.id, f.taskId), new Promise((_, reject) => setTimeout(() => reject(Error('Browsing waited for unrelated recovery')), 3000))])
    assert.equal(view.task.id, f.taskId)
    assert.equal(await f.runtime.browseSequence(f.id), view.seq)
    const entry = await f.call('task start', [], { title: 'Independent new entry' })
    assert.equal(entry.ok, true, JSON.stringify(entry))
  } finally { release(); await strict }
})

test('TC16/21 a stale browse cursor catches a later committed task and a changed journal is rejected', async t => {
  const f = await setup(t)
  const file = path.join(f.archiveRoot, 'browse-index.json')
  const stale = await readFile(file)
  const next = await f.call('task start', [], { title: 'A later task' })
  assert.equal(next.ok, true, JSON.stringify(next))
  await writeFile(file, stale)
  await f.runtime.close()
  const reader = new Runtime(f.dataRoot)
  try {
    const listed = await reader.execute({ operation: 'task list', positionals: [], flags: { worktree: f.id }, cwd: f.directory, source: 'web', requestId: randomUUID() })
    assert.equal(listed.ok, true, JSON.stringify(listed))
    assert.equal(listed.data.result.items.length, 2)
    assert.equal(listed.data.result.items[0].id, next.data.taskId)
  } finally { await reader.close() }
  const journal = path.join(f.archiveRoot, 'journal.jsonl')
  const before = await readFile(journal, 'utf8')
  await writeFile(journal, before.replace('Archived output', 'Archived outpuX'))
  const cold = new Runtime(f.dataRoot)
  try { await assert.rejects(cold.view(f.id, f.taskId), { code: 'ARCHIVE_CORRUPT' }) }
  finally { await cold.close() }
})

test('TC14/21 browsing preserves session search, page defaults and invalid date rejection', async t => {
  const f = await setup(t)
  const session = 'session-' + randomUUID()
  const started = await f.call('task start', [], { title: 'Search fixture', session })
  assert.equal(started.ok, true, JSON.stringify(started))
  const flags = { query: '  ' + session + '  ' }
  const strict = await f.call('history list', [], flags)
  const browse = await f.call('history list', [], flags, 'web')
  assert.equal(browse.ok, true, JSON.stringify(browse))
  assert.deepEqual(browse.data.result, strict.data.result)
  const invalid = await f.call('history list', [], { from: '2026-02-31' }, 'web')
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'INVALID_ARGUMENT')
})
