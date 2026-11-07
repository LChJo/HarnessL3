import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { TaskService } from '../../build/core/context.js'
import { Archive } from '../../build/core/archive.js'
import { SearchIndex } from '../../build/core/index.js'
import { validateContract } from '../../build/core/contract.js'
import { digest, sha256 } from '../../build/core/json.js'

const ids = { project: '10000000-0000-4000-8000-000000000001', worktree: '10000000-0000-4000-8000-000000000002', app: '20000000-0000-4000-8000-000000000001', one: '20000000-0000-4000-8000-000000000002', two: '20000000-0000-4000-8000-000000000003', relation: '30000000-0000-4000-8000-000000000001', missing: '40000000-0000-4000-8000-000000000001' }
const metadata = (id, brief) => `metadata { harness_id "${id}"; brief "${brief}"; source "human"; status "unknown"; evidence "none"; version "1" }`
const dsl = `specification {\n element system\n element component\n relationship calls\n}\nmodel {
app = system "Application" { ${metadata(ids.app, 'Application boundary')}
one = component "One" { description "ONE LOCAL BODY" ${metadata(ids.one, 'First module')} }
two = component "Two" { description "TWO LOCAL BODY" ${metadata(ids.two, 'Second module')} }
}
app.one -[calls]-> app.two "Dispatch" { ${metadata(ids.relation, 'Dispatch boundary')} }
}\nviews { view overview { include * } }\n`
const DAY = 86400000
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-v1-context-'))
  const worktreeRoot = path.join(root, 'project')
  const skillsRoot = path.join(root, 'editable skills')
  const archiveRoot = path.join(root, 'data', 'worktrees', ids.worktree)
  await mkdir(path.join(worktreeRoot, '.harness', 'model'), { recursive: true })
  await writeFile(path.join(worktreeRoot, '.harness', 'model', 'main.c4'), dsl)
  await writeFile(path.join(worktreeRoot, '.harness', 'project.json'), JSON.stringify({ schemaVersion: 1, projectId: ids.project, name: 'Fixture', source: { excludePatterns: [] } }))
  await writeFile(path.join(worktreeRoot, '.harness', 'evidence.json'), JSON.stringify({ schemaVersion: 1, evidence: [] }))
  await writeFile(path.join(worktreeRoot, '.harness', 'aliases.json'), JSON.stringify({ schemaVersion: 1, aliases: {} }))
  await mkdir(path.join(skillsRoot, 'quality', 'debug'), { recursive: true })
  await writeFile(path.join(skillsRoot, 'quality', 'debug', 'SKILL.md'), '---\nname: debug\ndescription: Diagnose one failure\n---\nORIGINAL METHOD BODY\n')
  await writeFile(path.join(skillsRoot, 'quality', 'debug', 'binary.bin'), Buffer.from([0xff, 0, 1]))
  let instant = new Date('2026-01-01T00:00:00.000Z')
  let sourceState = { sourceVersion: { head: 'a'.repeat(40), treeHash: 'b'.repeat(64), status: 'clean' }, sourceScanRevision: 'c'.repeat(64) }
  let provider = async () => structuredClone(sourceState)
  const worktree = { id: ids.worktree, projectId: ids.project, root: worktreeRoot, gitCommonDir: path.join(worktreeRoot, '.git'), branch: 'main', active: true, available: true }
  let service, archive, index
  const open = async () => {
    archive = new Archive(archiveRoot)
    index = new SearchIndex(path.join(archiveRoot, 'index.sqlite'))
    service = new TaskService({ worktree, archive, index, source: (...args) => provider(...args), now: () => new Date(instant), onCommit: () => {} })
    await service.ready()
    return service
  }
  await open()
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const call = async (operation, id, input, flags = {}, requestId = input?.requestId ?? randomUUID(), source) => {
    const response = await service.execute({ operation, positionals: id ? [id] : [], flags, requestId, cwd: worktreeRoot, ...(input !== undefined ? { input } : {}), ...(source ? { source } : {}) }, skillsRoot)
    validateContract('response', response)
    return response
  }
  const start = async (title = 'Find exact context', requestId = randomUUID()) => call('task start', null, undefined, { title }, requestId)
  const selection = (entry, context = { expand: [], read: [], known: {} }, skills = []) => ({ schemaVersion: 1, requestId: randomUUID(), binding: entry.data.binding, context, skills })
  const query = (entry, expand = [], read = [], known = {}) => ({ schemaVersion: 1, requestId: randomUUID(), expectedModelRevision: entry.data.binding.modelRevision, expand, read, known })
  return { root, worktreeRoot, skillsRoot, archiveRoot, worktree, call, start, selection, query, get service() { return service }, get archive() { return archive }, get index() { return index }, setTime: value => { instant = new Date(value) }, setSource: value => { sourceState = value }, get sourceState() { return structuredClone(sourceState) }, provider: value => { provider = value }, restart: async () => { await service.close(); return open() } }
}
const expectError = (response, code) => { assert.equal(response.ok, false, JSON.stringify(response)); assert.equal(response.error.code, code); return response.error }

test('TC06 task entry provides bounded routing material and freezes actual model/C4 snapshot', async t => {
  const f = await fixture(t)
  const entry = await f.start()
  assert.equal(entry.ok, true)
  assert.equal(entry.data.kind, 'task-entry')
  assert.equal(entry.data.directory.items.length, 1)
  assert.equal(entry.data.directory.items[0].id, ids.app)
  assert.equal(entry.data.catalog[0].id, 'quality/debug')
  assert.ok(entry.data.routingPrompt.includes('Skill Hub'))
  assert.ok(!JSON.stringify(entry.data).includes('ORIGINAL METHOD BODY'))
  assert.ok(!JSON.stringify(entry.data).includes('ONE LOCAL BODY'))
  const shown = await f.call('task show', entry.data.taskId)
  assert.equal(shown.data.result.task.lastReadAt, null)
  assert.equal(shown.data.result.task.batches.length, 0)
  const snapshot = await f.service.snapshot(entry.data.taskId)
  assert.equal(snapshot.views[0].id, 'overview')
  assert.equal(snapshot.entities.length, 4)
  const materialized = JSON.parse(await readFile(path.join(f.archiveRoot, 'tasks', `${entry.data.taskId}.json`), 'utf8'))
  assert.equal(materialized.lastAppliedSeq, f.archive.seq)
  assert.equal(materialized.contentHash, digest('task-projection', { lastAppliedSeq: materialized.lastAppliedSeq, task: materialized.task }))
})

test('TC06/19 routing rules do not duplicate entry payloads; prompt refresh and archived replay keep their data', async t => {
  const f = await fixture(t)
  const requestId = randomUUID()
  const purpose = 'ROUTING_PAYLOAD_SENTINEL_PURPOSE'
  const entry = await f.start(purpose, requestId)
  const { routingPrompt, taskId, binding, directory, catalog } = entry.data
  t.diagnostic(JSON.stringify({ promptBytes: Buffer.byteLength(routingPrompt), entryBytes: Buffer.byteLength(JSON.stringify(entry)) }))
  for (const file of ['.harness/model/', '.c4', '.likec4', '.harness/project.json', '.harness/evidence.json', '.harness/aliases.json']) {
    assert.ok(routingPrompt.includes(file), `Git guidance must identify the portable context file ${file}`)
  }
  assert.match(routingPrompt, /Git projects/)
  assert.match(routingPrompt, /related source changes/)
  assert.match(routingPrompt, /project-owned skill files.*attachments.*licenses/)
  assert.match(routingPrompt, /machine-local.*journals.*snapshots.*SQLite.*credentials/)
  assert.match(routingPrompt, /preserve.*history/i)
  assert.match(routingPrompt, /commit authorization/)
  assert.match(routingPrompt, /symlinks.*junctions/)
  for (const value of [purpose, taskId, binding.modelRevision, binding.catalogRevision, directory.items[0].brief, catalog[0].description, JSON.stringify(binding), JSON.stringify(directory), JSON.stringify(catalog)]) {
    assert.ok(!routingPrompt.includes(value), 'Routing rules must refer to structured entry data instead of embedding it')
  }
  assert.equal((await f.call('task show', taskId)).data.result.task.title, purpose)
  await writeFile(path.join(f.skillsRoot, 'quality', 'debug', 'SKILL.md'), '---\nname: debug\ndescription: UPDATED CATALOG SENTINEL\n---\nUpdated method body\n')
  const refreshed = await f.call('task prompt', taskId)
  assert.equal(refreshed.ok, true)
  assert.equal(refreshed.data.catalog[0].description, 'UPDATED CATALOG SENTINEL')
  assert.notEqual(refreshed.data.binding.catalogRevision, binding.catalogRevision)
  assert.equal(refreshed.data.routingPrompt, routingPrompt)
  const different = await f.start('Another purpose')
  assert.notEqual(different.data.taskId, taskId)
  assert.equal(different.data.routingPrompt, routingPrompt)
  await f.restart()
  const replay = await f.start(purpose, requestId)
  assert.equal(replay.replayed, true)
  assert.deepEqual(replay.data, entry.data)
})

test('TC19/27 API slice: inherited handoff uses one selection; an independent child does not close its parent', async t => {
  const f = await fixture(t)
  const parent = await f.start('Parent task')
  const selected = await f.call('task select', parent.data.taskId, f.selection(parent, { expand: [], read: [ids.one], known: {} }, [{ id: 'quality/debug', reason: 'Shared method for this delegated scope' }]))
  assert.equal(selected.ok, true)
  const inherited = await f.call('task handoff', parent.data.taskId)
  const skill = inherited.data.skillPlan.skills[0]
  const file = skill.files.find(file => file.path === 'SKILL.md')
  const read = await f.call('task read', parent.data.taskId, { schemaVersion: 1, requestId: randomUUID(), files: [{ skillId: skill.id, path: file.path, expectedHash: file.hash }] })
  assert.equal(read.ok, true)
  assert.ok(read.data.files[0].file.content.includes('ORIGINAL METHOD BODY'))
  assert.equal(f.service.tasks().length, 1)
  const parentAfterRead = (await f.call('task show', parent.data.taskId)).data.result.task
  assert.equal(parentAfterRead.closedAt, null)
  assert.equal(parentAfterRead.skillPlan.id, selected.data.skillPlan.id)
  const independent = await f.start('Independent child scope')
  assert.notEqual(independent.data.taskId, parent.data.taskId)
  const emptySelection = await f.call('task select', independent.data.taskId, f.selection(independent))
  assert.equal(emptySelection.ok, true)
  assert.deepEqual(emptySelection.data.skillPlan.skills, [])
  assert.equal((await f.call('task close', independent.data.taskId)).ok, true)
  const parentAfterChild = (await f.call('task show', parent.data.taskId)).data.result.task
  assert.equal(parentAfterChild.closedAt, null)
  assert.equal(parentAfterChild.skillPlan.id, parentAfterRead.skillPlan.id)
})

test('TC06 mixed targets disclose exact bodies, direct children and explicit files in one selection', async t => {
  const f = await fixture(t)
  const entry = await f.start()
  const input = f.selection(entry, { expand: [ids.app], read: [ids.one], known: {} }, [{ id: 'quality/debug', reason: 'Inspect the failing behavior' }])
  const response = await f.call('task select', entry.data.taskId, input)
  assert.equal(response.ok, true)
  assert.equal(response.data.kind, 'selection')
  assert.deepEqual(response.data.result.directories[0].items.map(item => item.id), [ids.one, ids.two])
  assert.deepEqual(response.data.packet.contexts.map(item => item.entity.id), [ids.one])
  assert.ok(!JSON.stringify(response.data.packet).includes('TWO LOCAL BODY'))
  assert.equal(response.data.skillPlan.skills.length, 1)
  assert.ok(!JSON.stringify(response.data.skillPlan).includes('ORIGINAL METHOD BODY'))
  const shown = await f.call('task show', entry.data.taskId)
  assert.equal(shown.data.result.task.lastReadAt, '2026-01-01T00:00:00.000Z')
})

test('TC07 fake known cannot skip the first body, retained known only reuses this task', async t => {
  const f = await fixture(t)
  const entry = await f.start()
  const first = await f.call('context query', entry.data.taskId, f.query(entry, [], [ids.one], { [ids.one]: 'd'.repeat(64) }))
  assert.equal(first.data.result.contexts.length, 1)
  const contentHash = first.data.result.contexts[0].contentHash
  f.setTime('2026-01-02T00:00:00.000Z')
  const repeated = await f.call('context query', entry.data.taskId, f.query(entry, [], [ids.one], { [ids.one]: contentHash }))
  assert.deepEqual(repeated.data.result.contexts, [])
  assert.equal(repeated.data.result.unchanged[0].contentHash, contentHash)
  assert.equal((await f.call('task show', entry.data.taskId)).data.result.task.lastReadAt, '2026-01-01T00:00:00.000Z')
  const other = await f.start('Different task')
  assert.equal((await f.call('context query', other.data.taskId, f.query(other, [], [ids.one], { [ids.one]: contentHash }))).data.result.contexts.length, 1)
})

test('TC07 partial and total target failure preserve truthful batches without fake success or retention', async t => {
  const f = await fixture(t)
  const entry = await f.start()
  const partial = await f.call('context query', entry.data.taskId, f.query(entry, [ids.relation], [ids.one, ids.missing]))
  assert.equal(partial.ok, true)
  assert.equal(partial.data.status, 'partial')
  assert.deepEqual(partial.data.result.errors.map(item => item.code), ['NOT_EXPANDABLE', 'ENTITY_NOT_FOUND'])
  f.setTime('2026-01-03T00:00:00.000Z')
  const failed = await f.call('context query', entry.data.taskId, f.query(entry, [], [ids.missing]))
  expectError(failed, 'CONTEXT_TARGETS_FAILED')
  assert.match(failed.error.details.batchId, /^[0-9a-f-]{36}$/)
  const task = (await f.call('task show', entry.data.taskId)).data.result.task
  assert.equal(task.batches.length, 2)
  assert.equal(task.batches[1].result.errors[0].code, 'ENTITY_NOT_FOUND')
  assert.equal(task.lastReadAt, '2026-01-01T00:00:00.000Z')
  assert.equal(task.packet.contexts.length, 1)
})

test('TC08 explicit empty joint selection is final; failed context targets still record a selected skill plan', async t => {
  const f = await fixture(t)
  const empty = await f.start()
  const first = await f.call('task select', empty.data.taskId, f.selection(empty))
  assert.equal(first.data.status, 'complete')
  assert.deepEqual(first.data.skillPlan.skills, [])
  expectError(await f.call('task select', empty.data.taskId, f.selection(empty)), 'SELECTION_EXISTS')
  const entry = await f.start('Partial selected skill')
  const selected = await f.call('task select', entry.data.taskId, f.selection(entry, { expand: [], read: [ids.missing], known: {} }, [{ id: 'quality/debug', reason: 'Use the method' }]))
  assert.equal(selected.ok, true)
  assert.equal(selected.data.status, 'partial')
  assert.equal(selected.data.skillPlan.skills.length, 1)
})

test('TC08 task select accepts the task ID in the request JSON and rejects a missing one', async t => {
  const f = await fixture(t)
  const entry = await f.start()
  const input = f.selection(entry, { expand: [], read: [ids.one], known: {} }, [{ id: 'quality/debug', reason: 'Use diagnosis' }])
  const withoutPositional = await f.call('task select', null, { ...input, taskId: entry.data.taskId })
  assert.equal(withoutPositional.ok, true, JSON.stringify(withoutPositional))
  assert.equal(withoutPositional.data.taskId, entry.data.taskId)
  assert.equal(withoutPositional.data.skillPlan.skills[0].id, 'quality/debug')
  const replayed = await f.call('task select', null, { ...input, taskId: entry.data.taskId })
  assert.equal(replayed.replayed, true)
  expectError(await f.call('task select', null, f.selection(entry)), 'INVALID_ARGUMENT')
})

test('TC09 request replay precedes changed source/model, close and expiration checks and conflicts remain explicit', async t => {
  const f = await fixture(t)
  const startId = randomUUID()
  const entry = await f.start('Replay entry', startId)
  const input = f.selection(entry, { expand: [], read: [ids.one], known: {} }, [{ id: 'quality/debug', reason: 'Use diagnosis' }])
  const original = await f.call('task select', entry.data.taskId, input)
  const count = f.archive.seq
  await writeFile(path.join(f.worktreeRoot, '.harness/model/main.c4'), dsl + '// later model\n')
  f.setSource({ ...f.sourceState, sourceVersion: { ...f.sourceState.sourceVersion, treeHash: 'e'.repeat(64), status: 'dirty' } })
  f.setTime('2027-01-01T00:00:00.000Z')
  const repeated = await f.call('task select', entry.data.taskId, input)
  assert.equal(repeated.replayed, true)
  assert.deepEqual(repeated.data, original.data)
  assert.equal(f.archive.seq, count)
  const restarted = await f.start('Replay entry', startId)
  assert.equal(restarted.replayed, true)
  assert.equal(restarted.data.taskId, entry.data.taskId)
  expectError(await f.start('Different title', startId), 'REQUEST_ID_CONFLICT')
  const changed = structuredClone(input); changed.skills[0].reason = 'Different reason'
  expectError(await f.call('task select', entry.data.taskId, changed), 'REQUEST_ID_CONFLICT')
})

test('TC08 skill and model changes reject selection without writing or partially archiving a plan', async t => {
  const f = await fixture(t)
  const entry = await f.start()
  await writeFile(path.join(f.skillsRoot, 'quality/debug/SKILL.md'), '---\nname: debug\ndescription: Changed\n---\nChanged body\n')
  const before = f.archive.seq
  expectError(await f.call('task select', entry.data.taskId, f.selection(entry)), 'CATALOG_CHANGED')
  assert.equal(f.archive.seq, before)
  const prompt = await f.call('task prompt', entry.data.taskId)
  assert.notEqual(prompt.data.binding.catalogRevision, entry.data.binding.catalogRevision)
  assert.equal(prompt.data.catalog[0].description, 'Changed')
  await writeFile(path.join(f.worktreeRoot, '.harness/model/main.c4'), dsl + '// changed model\n')
  expectError(await f.call('context query', entry.data.taskId, f.query(entry, [], [ids.one])), 'VERSION_CONFLICT')
})

test('TC09 concurrent independent queries accumulate in durable order; identical concurrent retry commits once', async t => {
  const f = await fixture(t)
  const entry = await f.start()
  const one = f.query(entry, [], [ids.one]), two = f.query(entry, [], [ids.two])
  const results = await Promise.all([f.call('context query', entry.data.taskId, one), f.call('context query', entry.data.taskId, two)])
  assert.ok(results.every(result => result.ok))
  const task = (await f.call('task show', entry.data.taskId)).data.result.task
  assert.equal(task.batches.length, 2)
  assert.equal(new Set(task.packet.contexts.map(item => item.entity.id)).size, 2)
  const same = f.query(entry, [], [ids.app])
  const before = f.archive.seq
  const repeat = await Promise.all([f.call('context query', entry.data.taskId, same), f.call('context query', entry.data.taskId, same)])
  assert.deepEqual(repeat.map(item => item.replayed).sort(), [false, true])
  assert.equal(f.archive.seq, before + 1)
})

test('TC10 commit CAS detects source changes during preparation instead of recording stale output', async t => {
  const f = await fixture(t)
  const entry = await f.start()
  const base = f.sourceState
  let calls = 0
  f.provider(async () => ++calls === 1 ? base : { ...base, sourceVersion: { ...base.sourceVersion, treeHash: 'e'.repeat(64), status: 'dirty' } })
  const before = f.archive.seq
  expectError(await f.call('context query', entry.data.taskId, f.query(entry, [], [ids.one])), 'SOURCE_CHANGED')
  assert.equal(f.archive.seq, before)
})

test('TC11 historical batch truncation retains the original packet, plan and C4 after live changes', async t => {
  const f = await fixture(t)
  const entry = await f.start()
  const prior = await f.call('context query', entry.data.taskId, f.query(entry, [], [ids.one]))
  const selected = await f.call('task select', entry.data.taskId, f.selection(entry, { expand: [], read: [ids.two], known: {} }, [{ id: 'quality/debug', reason: 'Use method' }]))
  await rm(f.worktreeRoot, { recursive: true, force: true })
  await rm(f.skillsRoot, { recursive: true, force: true })
  const before = f.archive.seq
  const early = await f.call('task handoff', entry.data.taskId, undefined, { batch: prior.data.result.batchId })
  assert.deepEqual(early.data.packet.contexts.map(item => item.entity.id), [ids.one])
  assert.equal(early.data.skillPlan, null)
  const latest = await f.call('history show', entry.data.taskId)
  assert.equal(latest.data.result.task.packet.contexts.length, 2)
  assert.equal(latest.data.result.task.skillPlan.id, selected.data.skillPlan.id)
  assert.equal(f.archive.seq, before)
  assert.equal((await f.service.snapshot(entry.data.taskId)).views[0].id, 'overview')
})

test('TC12 archived skill UTF-8 and base64 files survive deletion without renewing context history', async t => {
  const f = await fixture(t)
  const entry = await f.start()
  const selected = await f.call('task select', entry.data.taskId, f.selection(entry, { expand: [], read: [], known: {} }, [{ id: 'quality/debug', reason: 'Use method' }]))
  await rm(f.skillsRoot, { recursive: true, force: true })
  await rm(f.worktreeRoot, { recursive: true, force: true })
  f.setTime('2026-01-20T00:00:00.000Z')
  const files = selected.data.skillPlan.skills[0].files
  const input = { schemaVersion: 1, requestId: randomUUID(), files: files.map(file => ({ skillId: 'quality/debug', path: file.path, expectedHash: file.hash })) }
  const read = await f.call('task read', entry.data.taskId, input)
  assert.equal(read.ok, true)
  for (const item of read.data.files) assert.equal(sha256(Buffer.from(item.file.content, item.file.encoding)), item.file.hash)
  assert.ok(read.data.files.find(item => item.file.path === 'SKILL.md').file.content.includes('ORIGINAL METHOD BODY'))
  assert.equal(read.data.files.find(item => item.file.path === 'binary.bin').file.encoding, 'base64')
  assert.equal(read.data.throughBatchId, selected.data.result.batchId)
  const task = (await f.call('task show', entry.data.taskId)).data.result.task
  assert.equal(task.lastReadAt, null)
  assert.equal(task.retentionBasisAt, task.createdAt)
  assert.equal(task.batches.length, 1)
  assert.equal((await f.call('task read', entry.data.taskId, input)).replayed, true)
})

test('TC12 selected-file failures are partial/all-failed and cannot leak unselected/current files', async t => {
  const f = await fixture(t)
  const entry = await f.start()
  const selected = await f.call('task select', entry.data.taskId, f.selection(entry, { expand: [], read: [], known: {} }, [{ id: 'quality/debug', reason: 'Use method' }]))
  const file = selected.data.skillPlan.skills[0].files[0]
  const good = { skillId: 'quality/debug', path: file.path, expectedHash: file.hash }
  const partial = await f.call('task read', entry.data.taskId, { schemaVersion: 1, requestId: randomUUID(), files: [good, { ...good, skillId: 'quality/unselected' }, { ...good, path: 'absent.md' }, { ...good, expectedHash: 'f'.repeat(64) }] })
  assert.equal(partial.data.status, 'partial')
  assert.deepEqual(partial.data.errors.map(error => error.code), ['SKILL_NOT_SELECTED', 'FILE_NOT_ARCHIVED', 'HASH_MISMATCH'])
  expectError(await f.call('task read', entry.data.taskId, { schemaVersion: 1, requestId: randomUUID(), files: [{ ...good, expectedHash: 'f'.repeat(64) }] }), 'SKILL_FILES_FAILED')
  expectError(await f.call('task read', entry.data.taskId, { schemaVersion: 1, requestId: randomUUID(), files: [good], throughBatchId: selected.data.result.batchId }, { batch: randomUUID() }), 'INVALID_ARGUMENT')
})

test('TC13 exact 60-day boundary stays visible; browse, files and close cannot extend it', async t => {
  const f = await fixture(t)
  const entry = await f.start()
  const expires = Date.parse('2026-01-01T00:00:00.000Z') + 60 * DAY
  f.setTime(expires)
  assert.equal((await f.call('history list')).data.result.total, 1)
  assert.equal((await f.call('history show', entry.data.taskId)).data.result.expired, false)
  const closed = await f.call('task close', entry.data.taskId)
  assert.equal(closed.data.result.closedAt, new Date(expires).toISOString())
  f.setTime(expires + 1)
  assert.equal((await f.call('history list')).data.result.total, 0)
  assert.equal((await f.call('history show', entry.data.taskId)).data.result.expired, true)
  expectError(await f.call('context query', entry.data.taskId, f.query(entry, [], [ids.one])), 'TASK_CLOSED')
  const open = await f.start('A new unclosed task')
  f.setTime(expires + 1 + 60 * DAY + 1)
  expectError(await f.call('context query', open.data.taskId, f.query(open, [], [ids.one])), 'TASK_EXPIRED')
})

test('TC13 returned directory/partial body renews retention while historical truncation and close do not', async t => {
  const f = await fixture(t)
  const entry = await f.start()
  f.setTime('2026-01-10T00:00:00.000Z')
  const expanded = await f.call('context query', entry.data.taskId, f.query(entry, [ids.one]))
  assert.equal(expanded.data.result.directories[0].items.length, 0)
  let task = (await f.call('task show', entry.data.taskId)).data.result.task
  assert.equal(task.lastReadAt, '2026-01-10T00:00:00.000Z')
  f.setTime('2026-01-20T00:00:00.000Z')
  const close = await f.call('task close', entry.data.taskId)
  const again = await f.call('task close', entry.data.taskId)
  assert.equal(again.data.result.closedAt, close.data.result.closedAt)
  task = (await f.call('task show', entry.data.taskId, undefined, { batch: expanded.data.result.batchId })).data.result.task
  assert.equal(task.lastReadAt, '2026-01-10T00:00:00.000Z')
  assert.equal(task.expiresAt, new Date(Date.parse(task.lastReadAt) + 60 * DAY).toISOString())
})

test('TC14 restart and missing/corrupt SQLite rebuild from journal without changing archived bytes', async t => {
  const f = await fixture(t)
  const entry = await f.start('Searchable cancellation task')
  await f.call('context query', entry.data.taskId, f.query(entry, [], [ids.one]))
  const journal = await readFile(path.join(f.archiveRoot, 'journal.jsonl'))
  const snapshots = await readdir(path.join(f.archiveRoot, 'snapshots'))
  await f.service.close()
  await writeFile(path.join(f.archiveRoot, 'index.sqlite'), 'invalid derived index')
  await f.restart()
  const history = await f.call('history list', null, undefined, { query: 'cancellation', limit: '1', offset: '0' })
  assert.equal(history.data.result.total, 1)
  assert.equal(history.data.result.items[0].id, entry.data.taskId)
  assert.deepEqual(await readFile(path.join(f.archiveRoot, 'journal.jsonl')), journal)
  assert.deepEqual(await readdir(path.join(f.archiveRoot, 'snapshots')), snapshots)
  assert.equal((await f.call('history show', entry.data.taskId)).data.result.task.packet.contexts.length, 1)
})

test('TC14 durable commit followed by failed materialization refreshes memory and replay is safe', async t => {
  const f = await fixture(t)
  const entry = await f.start()
  const input = f.query(entry, [], [ids.one])
  const materialized = path.join(f.archiveRoot, 'tasks', `${entry.data.taskId}.json`)
  await rm(materialized)
  await mkdir(materialized)
  const response = await f.call('context query', entry.data.taskId, input)
  expectError(response, 'IO_ERROR')
  assert.equal(response.error.details.committed, true)
  assert.equal(f.service.tasks()[0].packet.contexts.length, 1)
  await rm(materialized, { recursive: true })
  const replay = await f.call('context query', entry.data.taskId, input)
  assert.equal(replay.replayed, true)
  assert.equal(replay.data.result.contexts.length, 1)
})

test('TC14 missing archived model is corrupt and never backfilled from valid live files', async t => {
  const f = await fixture(t)
  const entry = await f.start()
  const task = f.service.tasks()[0]
  await rm(path.join(f.archiveRoot, 'snapshots', `${task.modelSnapshotHash}.json`))
  expectError(await f.call('history show', entry.data.taskId), 'ARCHIVE_CORRUPT')
  assert.equal((await readdir(path.join(f.archiveRoot, 'snapshots'))).includes(`${task.modelSnapshotHash}.json`), false)
})

test('TC22 mismatched target, input request ID and invalid schema are rejected before a batch', async t => {
  const f = await fixture(t)
  const entry = await f.start()
  const input = f.selection(entry)
  input.binding.projectId = ids.missing
  expectError(await f.call('task select', entry.data.taskId, input), 'TARGET_CONFLICT')
  const query = f.query(entry, [], [ids.one]); query.unknown = true
  expectError(await f.call('context query', entry.data.taskId, query), 'SCHEMA_INVALID')
  const valid = f.query(entry, [], [ids.one])
  expectError(await f.call('context query', entry.data.taskId, valid, {}, randomUUID()), 'INVALID_ARGUMENT')
  assert.equal(f.service.tasks()[0].batches.length, 0)
})

test('TC14 unavailable index reports an error instead of a fake empty list; exact task remains readable', async t => {
  const f = await fixture(t)
  const entry = await f.start()
  await f.index.close()
  expectError(await f.call('history list'), 'INDEX_UNAVAILABLE')
  assert.equal((await f.call('task show', entry.data.taskId)).ok, true)
})

test('TC09 failed query replays its original failure even after close without adding a batch', async t => {
  const f = await fixture(t)
  const entry = await f.start()
  const input = f.query(entry, [], [ids.missing])
  const failure = await f.call('context query', entry.data.taskId, input)
  expectError(failure, 'CONTEXT_TARGETS_FAILED')
  await f.call('task close', entry.data.taskId)
  const seq = f.archive.seq
  const replayed = await f.call('context query', entry.data.taskId, input)
  assert.equal(replayed.ok, false)
  assert.equal(replayed.replayed, true)
  assert.deepEqual(replayed.error, failure.error)
  assert.equal(f.archive.seq, seq)
  assert.equal(f.service.tasks()[0].batches.length, 1)
})

test('TC11 earlier batch freezes the catalog binding before a later prompt refresh', async t => {
  const f = await fixture(t)
  const entry = await f.start()
  const initial = await f.call('context query', entry.data.taskId, f.query(entry, [], [ids.one]))
  await writeFile(path.join(f.skillsRoot, 'quality/debug/SKILL.md'), '---\nname: debug\ndescription: New description\n---\nNew body\n')
  const prompt = await f.call('task prompt', entry.data.taskId)
  assert.notEqual(prompt.data.binding.catalogRevision, entry.data.binding.catalogRevision)
  await f.call('task select', entry.data.taskId, f.selection(prompt))
  const history = await f.call('task show', entry.data.taskId, undefined, { batch: initial.data.result.batchId })
  assert.equal(history.data.result.task.binding.catalogRevision, entry.data.binding.catalogRevision)
  assert.equal(history.data.result.task.catalog[0].description, 'Diagnose one failure')
  assert.equal(history.data.result.task.skillPlan, null)
})

test('TC14 a durable context receipt remains usable when its derived index projection is unavailable', async t => {
  const f = await fixture(t)
  const entry = await f.start()
  await f.index.close()
  const input = f.query(entry, [], [ids.one])
  const response = await f.call('context query', entry.data.taskId, input)
  assert.equal(response.ok, true)
  assert.equal(f.service.tasks()[0].packet.contexts.length, 1)
  assert.ok(f.service.status().indexError)
  expectError(await f.call('history list'), 'INDEX_UNAVAILABLE')
  assert.equal((await f.call('context query', entry.data.taskId, input)).replayed, true)
})

test('TC14 other journal payload kinds coexist with task recovery and index sequence gaps rebuild safely', async t => {
  const f = await fixture(t)
  const entry = await f.start()
  await f.service.serial(() => f.archive.commit({ scope: `worktree:${ids.worktree}`, requestId: randomUUID(), request: { operation: 'observe' }, payload: { kind: 'observed-event', event: { state: 'unknown' } }, receipt: { observed: true } }))
  const response = await f.call('context query', entry.data.taskId, f.query(entry, [], [ids.one]))
  assert.equal(response.ok, true)
  assert.equal(f.index.status.seq, f.archive.seq)
  assert.equal((await f.call('history list')).data.result.total, 1)
  await f.restart()
  assert.equal(f.service.tasks().length, 1)
  assert.equal((await f.call('history show', entry.data.taskId)).ok, true)
})

test('TC14 a corrupt task blocks new writes while another independently valid task remains readable', async t => {
  const f = await fixture(t)
  const affected = await f.start('Affected task')
  const selected = await f.call('task select', affected.data.taskId, f.selection(affected, { expand: [], read: [], known: {} }, [{ id: 'quality/debug', reason: 'Use the method' }]))
  const good = await f.start('Valid archived task')
  const file = selected.data.skillPlan.skills[0].files[0]
  await rm(path.join(f.archiveRoot, 'skill-blobs', file.hash))
  await f.restart()
  assert.equal(f.archive.status, 'recovery-required')
  expectError(await f.call('task show', affected.data.taskId), 'ARCHIVE_CORRUPT')
  assert.equal((await f.call('task show', good.data.taskId)).ok, true)
  assert.equal((await f.service.snapshot(good.data.taskId)).views.length, 1)
  expectError(await f.call('context query', good.data.taskId, f.query(good, [], [ids.one])), 'ARCHIVE_CORRUPT')
})

test('TC22 trusted service actor distinguishes Web task creation from CLI read batches', async t => {
  const f = await fixture(t)
  const entry = await f.call('task start', null, undefined, { title: 'Manual task' }, randomUUID(), 'web')
  const input = f.query(entry, [], [ids.one])
  await f.call('context query', entry.data.taskId, input)
  const task = (await f.call('task show', entry.data.taskId)).data.result.task
  assert.equal(task.source, 'web')
  assert.equal(task.batches[0].source, 'cli')
})

test('TC10 source manifests, rules and policies remain in every durable task reference closure', async t => {
  const f = await fixture(t)
  const archives = []
  for (const kind of ['source-manifest', 'source-scan-policy', 'git-ignore-rules', 'source-rule-bytes']) archives.push({ kind: 'snapshot', hash: await f.archive.snapshot(kind, { kind, captured: 'fixture bytes' }) })
  const source = f.sourceState
  f.provider(async () => ({ ...source, archives }))
  const entry = await f.start()
  assert.ok(!Object.hasOwn(entry.data.binding, 'archives'))
  const selected = await f.call('task select', entry.data.taskId, f.selection(entry, { expand: [], read: [ids.one], known: {} }, [{ id: 'quality/debug', reason: 'Use the method' }]))
  const file = selected.data.skillPlan.skills[0].files[0]
  await f.call('task read', entry.data.taskId, { schemaVersion: 1, requestId: randomUUID(), files: [{ skillId: 'quality/debug', path: file.path, expectedHash: file.hash }] })
  await f.call('task close', entry.data.taskId)
  for (const record of f.archive.records().filter(record => record.payload.kind === 'task')) {
    for (const reference of archives) assert.ok(record.archives.some(candidate => candidate.kind === reference.kind && candidate.hash === reference.hash))
  }
})
