import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fixture, execFile, binary } from './helpers.mjs'

const rootId = '20000000-0000-4000-8000-000000000001'
const leafId = '20000000-0000-4000-8000-000000000002'
const metadata = id => `metadata { harness_id "${id}"; brief "A bounded module"; source "human"; status "unknown"; evidence "none"; version "1" }`
const model = `specification {\n element system\n element component\n}\nmodel { app = system "Application" { ${metadata(rootId)}\n worker = component "Worker" { description "EXACT WORKER CONTEXT" ${metadata(leafId)} } } }\nviews { view overview { include * } }\n`

async function setup(t) {
  const f = await fixture(t, 'harness-v1-task-cli-')
  const root = await f.repository()
  const skills = path.join(f.directory, 'methods')
  await mkdir(path.join(skills, 'quality', 'check'), { recursive: true })
  await writeFile(path.join(skills, 'quality', 'check', 'SKILL.md'), '---\nname: check\ndescription: Check a bounded change\n---\nORIGINAL METHOD\n')
  const call = (args, options = {}) => f.cli(args, { cwd: root, env: { HARNESS_SKILLS_ROOT: skills }, ...options })
  const initialized = await call(['init'])
  assert.equal(initialized.code, 0, initialized.stdout)
  await writeFile(path.join(root, '.harness', 'model', 'main.c4'), model)
  const modelFiles = await import('node:fs/promises').then(fs => fs.readdir(path.join(root, '.harness', 'model')))
  for (const file of modelFiles) if (file !== 'main.c4') await rm(path.join(root, '.harness', 'model', file))
  const target = initialized.body.target
  const start = async (requestId = randomUUID()) => call(['task', 'start', '--title', 'Inspect exact worker', '--request-id', requestId])
  const json = (operation, taskId, input) => call([...operation.split(' '), taskId, '--file', '-'], { input: JSON.stringify(input) })
  return { ...f, root, skills, call, target, start, json }
}

test('TC22 text routing is displayed once while structured entry data remains available', async t => {
  const f = await setup(t)
  const started = await f.start()
  const entry = started.body.data
  const { stdout } = await execFile(process.execPath, [binary, 'task', 'prompt', entry.taskId], { cwd: f.root, env: { ...process.env, HARNESSL3_HOME: f.dataRoot, HARNESS_SKILLS_ROOT: f.skills }, windowsHide: true })
  const marker = stdout.indexOf('\n{\n')
  assert.ok(marker > 0)
  assert.equal(stdout.slice(0, marker), entry.routingPrompt)
  const displayed = JSON.parse(stdout.slice(marker + 1))
  assert.equal(Object.hasOwn(displayed, 'routingPrompt'), false, 'The rules are already displayed above the structured data')
  for (const field of ['taskId', 'binding', 'directory', 'catalog']) assert.deepEqual(displayed[field], entry[field])
})

test('TC22 UTF-8 file and byte stdin preserve multilingual skill reasons through restart', async t => {
  const f = await setup(t)
  const reason = '与 HEAD 比较，核对规格、標準和实现 🙂'
  const tasks = []
  for (const mode of ['file', 'stdin']) {
    const entry = (await f.start()).body.data
    const request = { schemaVersion: 1, requestId: randomUUID(), binding: entry.binding, context: { expand: [], read: [], known: {} }, skills: [{ id: 'quality/check', reason }] }
    const requestFile = path.join(f.directory, '中文 请求.json')
    if (mode === 'file') await writeFile(requestFile, '\uFEFF' + JSON.stringify(request), 'utf8')
    const result = await f.call(['task', 'select', entry.taskId, '--file', mode === 'file' ? requestFile : '-'], mode === 'stdin' ? { input: Buffer.from(JSON.stringify(request), 'utf8') } : {})
    assert.equal(result.code, 0, result.stdout)
    assert.equal(result.body.data.skillPlan.skills[0].reason, reason)
    tasks.push(entry.taskId)
  }
  await f.call(['serve', 'stop'])
  for (const taskId of tasks) {
    const shown = await f.call(['task', 'show', taskId])
    assert.equal(shown.code, 0, shown.stdout)
    assert.equal(shown.body.data.result.task.skillPlan.skills[0].reason, reason)
  }
})

test('TC06 task select omits the positional task ID when the request JSON carries it', async t => {
  const f = await setup(t)
  const entry = (await f.start()).body.data
  const request = { schemaVersion: 1, requestId: randomUUID(), binding: entry.binding, context: { expand: [], read: [], known: {} }, skills: [], taskId: entry.taskId }
  const result = await f.call(['task', 'select', '--file', '-'], { input: JSON.stringify(request) })
  assert.equal(result.code, 0, result.stdout)
  assert.equal(result.body.data.taskId, entry.taskId)
})

test('TC06 CLI selects context and file references, reads archived bytes, and restores after restart', async t => {
  const f = await setup(t)
  const requestId = randomUUID()
  const started = await f.start(requestId)
  assert.equal(started.code, 0, started.stdout)
  const entry = started.body.data
  assert.equal(entry.kind, 'task-entry')
  assert.equal(entry.directory.items[0].id, rootId)
  assert.equal(entry.catalog[0].id, 'quality/check')
  assert.ok(!started.stdout.includes('ORIGINAL METHOD'))
  const selected = await f.json('task select', entry.taskId, { schemaVersion: 1, requestId: randomUUID(), binding: entry.binding, context: { expand: [rootId], read: [leafId], known: {} }, skills: [{ id: 'quality/check', reason: 'Check the requested module' }] })
  assert.equal(selected.code, 0, selected.stdout)
  assert.equal(selected.body.data.packet.contexts[0].entity.description, 'EXACT WORKER CONTEXT')
  assert.ok(!selected.stdout.includes('ORIGINAL METHOD'))
  const file = selected.body.data.skillPlan.skills[0].files.find(file => file.path === 'SKILL.md')
  const shown = await f.call(['task', 'show', entry.taskId])
  const retention = shown.body.data.result.task.retentionBasisAt
  await writeFile(path.join(f.skills, 'quality', 'check', 'SKILL.md'), '---\nname: check\ndescription: Changed method\n---\nNEW METHOD\n')
  const replay = await f.start(requestId)
  assert.equal(replay.body.replayed, true)
  assert.equal(replay.body.data.taskId, entry.taskId)
  await f.call(['serve', 'stop'])
  const files = await f.json('task read', entry.taskId, { schemaVersion: 1, requestId: randomUUID(), files: [{ skillId: 'quality/check', path: file.path, expectedHash: file.hash }] })
  assert.equal(files.code, 0, files.stdout)
  assert.ok(files.body.data.files[0].file.content.includes('ORIGINAL METHOD'))
  const after = await f.call(['history', 'show', entry.taskId])
  assert.equal(after.body.data.result.task.retentionBasisAt, retention)
  const handoff = await f.call(['task', 'handoff', entry.taskId])
  assert.equal(handoff.body.data.throughBatchId, selected.body.data.result.batchId)
  const listed = await f.call(['history', 'list', '--query', 'worker'])
  assert.equal(listed.code, 0, listed.stdout)
  assert.equal(listed.body.data.result.items[0].id, entry.taskId)
  const journal = await readFile(path.join(f.dataRoot, 'worktrees', f.target.worktreeId, 'journal.jsonl'), 'utf8')
  // Archive references, rather than live files, must support every later read.
  assert.ok(handoff.body.data.packet.contexts.length === 1)
  assert.ok(!journal.includes('NEW METHOD'))
})

test('TC27 consecutive skill stages reuse conversation context, return each turns skill and preserve earlier archives', async t => {
  const f = await setup(t)
  const methods = [
    { id: 'planning/to-tickets', body: 'TICKET WRITING METHOD' },
    { id: 'development/implement', body: 'IMPLEMENTATION METHOD' },
  ]
  for (const method of methods) {
    await mkdir(path.join(f.skills, method.id), { recursive: true })
    await writeFile(path.join(f.skills, method.id, 'SKILL.md'), `---\nname: ${method.id.split('/')[1]}\ndescription: A stage-specific method\n---\n${method.body}\n`)
  }
  const select = (entry, skills, read = []) => f.json('task select', entry.taskId, {
    schemaVersion: 1, requestId: randomUUID(), binding: entry.binding,
    context: { expand: [], read, known: {} }, skills: skills.map(id => ({ id, reason: 'Required by this turn' })),
  })
  const readMethod = async (selected, method) => {
    const reference = selected.skillPlan.skills.find(skill => skill.id === method.id).files.find(file => file.path === 'SKILL.md')
    const response = await f.json('task read', selected.taskId, {
      schemaVersion: 1, requestId: randomUUID(),
      files: [{ skillId: method.id, path: reference.path, expectedHash: reference.hash }],
    })
    assert.equal(response.code, 0, response.stdout)
    assert.equal(response.body.replayed, false)
    assert.ok(response.body.data.files[0].file.content.includes(method.body))
    assert.ok(!response.stdout.includes('EXACT WORKER CONTEXT'))
    return response.body
  }
  const ticketsEntry = (await f.start()).body.data
  const tickets = await select(ticketsEntry, [methods[0].id], [leafId])
  assert.equal(tickets.code, 0, tickets.stdout)
  const retainedContext = tickets.body.data.packet.contexts[0]
  assert.equal(retainedContext.entity.description, 'EXACT WORKER CONTEXT')
  await readMethod(tickets.body.data, methods[0])
  const original = (await f.call(['task', 'show', ticketsEntry.taskId])).body.data.result.task

  const rejected = await select(ticketsEntry, [methods[1].id])
  assert.equal(rejected.body.error.code, 'SELECTION_EXISTS', rejected.stdout)
  const started = await f.call(['task', 'start', '--title', 'Implement approved ticket'])
  assert.equal(started.code, 0, started.stdout)
  assert.ok(!started.stdout.includes('EXACT WORKER CONTEXT'))
  const implementEntry = started.body.data
  assert.notEqual(implementEntry.taskId, ticketsEntry.taskId)
  assert.equal(implementEntry.binding.worktreeId, ticketsEntry.binding.worktreeId)
  const implement = await select(implementEntry, [methods[1].id])
  assert.equal(implement.code, 0, implement.stdout)
  assert.deepEqual(implement.body.data.result.contexts, [])
  assert.deepEqual(implement.body.data.result.directories, [])
  assert.deepEqual(implement.body.data.packet.contexts, [])
  assert.deepEqual(implement.body.data.skillPlan.skills.map(skill => skill.id), [methods[1].id])
  assert.ok(!implement.stdout.includes('EXACT WORKER CONTEXT'))
  const before = (await f.call(['task', 'show', implementEntry.taskId])).body.data.result.task
  const firstTurn = await readMethod(implement.body.data, methods[1])
  const nextTurn = await readMethod(implement.body.data, methods[1])
  assert.notEqual(nextTurn.requestId, firstTurn.requestId)
  assert.deepEqual(nextTurn.data.files, firstTurn.data.files)
  const after = (await f.call(['task', 'show', implementEntry.taskId])).body.data.result.task
  for (const field of ['binding', 'packet', 'skillPlan', 'batches', 'lastReadAt', 'retentionBasisAt', 'expiresAt', 'closedAt']) {
    assert.deepEqual(after[field], before[field], field)
  }

  const emptyEntry = (await f.call(['task', 'start', '--title', 'No additional skill needed'])).body.data
  const empty = await select(emptyEntry, [])
  assert.equal(empty.code, 0, empty.stdout)
  assert.deepEqual(empty.body.data.skillPlan.skills, [])
  assert.deepEqual(empty.body.data.packet.contexts, [])
  assert.equal(retainedContext.entity.description, 'EXACT WORKER CONTEXT', 'the caller can retain earlier returned context')
  const preserved = (await f.call(['task', 'show', ticketsEntry.taskId])).body.data.result.task
  assert.deepEqual(preserved, original, 'later skill stages cannot rewrite the earlier task')
})

test('TC02 two worktrees keep task identity, source versions and reads isolated', async t => {
  const f = await setup(t)
  const second = path.join(f.directory, 'second worktree')
  await f.git(f.root, 'worktree', 'add', '-b', 'parallel', second)
  const initialized = await f.call(['init'], { cwd: second })
  assert.equal(initialized.code, 0, initialized.stdout)
  assert.equal(initialized.body.target.projectId, f.target.projectId)
  assert.notEqual(initialized.body.target.worktreeId, f.target.worktreeId)
  const entry = (await f.start()).body.data
  const wrong = await f.call(['task', 'show', entry.taskId], { cwd: second })
  assert.equal(wrong.body.ok, false)
  assert.equal(wrong.body.error.code, 'NOT_FOUND')
  const conflict = await f.call(['task', 'show', entry.taskId, '--worktree', f.target.worktreeId], { cwd: second })
  assert.equal(conflict.body.error.code, 'TARGET_CONFLICT')
  await writeFile(path.join(f.root, 'README.md'), 'Source changed\n')
  const changed = await f.json('context query', entry.taskId, { schemaVersion: 1, requestId: randomUUID(), expectedModelRevision: entry.binding.modelRevision, expand: [], read: [leafId], known: {} })
  assert.equal(changed.body.error.code, 'SOURCE_CHANGED')
  const before = await f.call(['task', 'handoff', entry.taskId])
  assert.equal(before.code, 0, before.stdout)
  assert.deepEqual(before.body.data.packet.contexts, [])
})

test('TC09 explicit archived task remains readable after unregister and checkout removal', async t => {
  const f = await setup(t)
  const started = await f.start()
  assert.equal(started.code, 0, started.stdout)
  const taskId = started.body.data.taskId
  const removed = await f.call(['worktree', 'unregister', f.target.worktreeId])
  assert.equal(removed.code, 0, removed.stdout)
  await rm(path.join(f.root, '.harness'), { recursive: true })
  const shown = await f.call(['history', 'show', taskId, '--worktree', f.target.worktreeId], { cwd: f.directory })
  assert.equal(shown.code, 0, shown.stdout)
  assert.equal(shown.body.data.result.task.id, taskId)
  const live = await f.call(['task', 'start', '--title', 'Disallowed live task', '--worktree', f.target.worktreeId], { cwd: f.directory })
  assert.equal(live.body.ok, false)
  assert.equal(live.body.error.code, 'TARGET_CONFLICT')
})
