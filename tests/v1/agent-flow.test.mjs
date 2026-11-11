import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fixture } from './helpers.mjs'

test('TC07/18 lightweight entry reads its captured model despite unrelated source changes; verified mode stays strict', async t => {
  const f = await fixture(t, 'harness-agent-snapshot-')
  const root = await f.repository()
  const init = await f.cli(['init'], { cwd: root })
  assert.equal(init.code, 0, init.stdout)
  // An independent nested repository prevents a complete source proof, but must not block model discovery.
  const nested = path.join(root, 'reference')
  await mkdir(nested)
  await f.git(nested, 'init', '-b', 'main')
  const start = await f.cli(['task', 'start', '--title', 'Read the project model'], { cwd: root })
  assert.equal(start.code, 0, start.stdout)
  const entry = start.body.data
  assert.equal(entry.binding.mode, 'snapshot')
  assert.equal(entry.binding.sourceVersion.status, 'unknown')
  assert.equal(entry.binding.sourceScanRevision, null)
  assert.ok(!start.stderr.includes('scanning-source'))
  const modelId = entry.directory.items[0].id
  await writeFile(path.join(root, 'README.md'), 'An unrelated parallel edit\n')
  const selected = await f.cli(['task', 'select', entry.taskId, '--file', '-'], { cwd: root, input: JSON.stringify({
    schemaVersion: 1, requestId: randomUUID(), binding: entry.binding,
    context: { expand: [], read: [modelId], known: {} }, skills: [],
  }) })
  assert.equal(selected.code, 0, selected.stdout)
  assert.equal(selected.body.data.packet.contexts[0].sourceVersion.status, 'unknown')
  const verified = await f.cli(['task', 'start', '--title', 'Require complete source proof', '--mode', 'verified'], { cwd: root })
  assert.equal(verified.body.error.code, 'SOURCE_CHANGED', verified.stdout)
  assert.ok(verified.body.error.details.diagnostics.some(item => item.code === 'SOURCE_NESTED_REPOSITORY'))
})

test('TC06/19/27 agent shortcuts resolve references and append skill stages without replacing earlier batches', async t => {
  const f = await fixture(t, 'harness-agent-stages-')
  const root = await f.repository()
  const skillsRoot = path.join(f.directory, 'methods')
  for (const [id, body] of [['planning/plan', 'ORIGINAL PLAN'], ['development/build', 'BUILD METHOD']]) {
    await mkdir(path.join(skillsRoot, id), { recursive: true })
    await writeFile(path.join(skillsRoot, id, 'SKILL.md'), `---\nname: ${id.split('/')[1]}\ndescription: A method for this stage\n---\n${body}\n`)
  }
  const call = (args, input) => f.cli(args, { cwd: root, env: { HARNESS_SKILLS_ROOT: skillsRoot }, input: input && JSON.stringify(input) })
  assert.equal((await call(['init'])).code, 0)
  const entry = (await call(['task', 'start', '--title', 'Plan and build'])).body.data
  const selected = await call(['task', 'select', entry.taskId, '--read', entry.directory.items[0].id, '--skill', 'planning/plan', '--reason', 'Plan the approved work'])
  assert.equal(selected.code, 0, selected.stdout)
  const firstBatch = selected.body.data.result.batchId
  const original = (await call(['task', 'show', entry.taskId, '--batch', firstBatch])).body.data.result.task
  const firstRead = await call(['task', 'read', entry.taskId, '--skill', 'planning/plan'])
  assert.equal(firstRead.code, 0, firstRead.stdout)
  assert.ok(firstRead.body.data.files[0].file.content.includes('ORIGINAL PLAN'))
  const duplicate = await call(['task', 'select', entry.taskId, '--skill', 'development/build', '--reason', 'Build the approved plan'])
  assert.equal(duplicate.body.error.code, 'SELECTION_EXISTS')
  const requestId = randomUUID()
  const next = await call(['task', 'select', entry.taskId, '--stage', '--skill', 'development/build', '--reason', 'Build the approved plan', '--request-id', requestId])
  assert.equal(next.code, 0, next.stdout)
  assert.equal(next.body.data.taskId, entry.taskId)
  assert.deepEqual(next.body.data.skillPlan.skills.map(skill => skill.id), ['development/build'])
  const replay = await call(['task', 'select', entry.taskId, '--stage', '--skill', 'development/build', '--reason', 'Build the approved plan', '--request-id', requestId])
  assert.equal(replay.body.replayed, true)
  assert.deepEqual(replay.body.data, next.body.data)
  const current = await call(['task', 'read', entry.taskId, '--skill', 'development/build'])
  assert.ok(current.body.data.files[0].file.content.includes('BUILD METHOD'))
  await writeFile(path.join(skillsRoot, 'planning/plan/SKILL.md'), 'changed live bytes')
  const previous = await call(['task', 'read', entry.taskId, '--batch', firstBatch, '--skill', 'planning/plan'])
  assert.ok(previous.body.data.files[0].file.content.includes('ORIGINAL PLAN'))
  const historical = (await call(['task', 'show', entry.taskId, '--batch', firstBatch])).body.data.result.task
  assert.deepEqual(historical, original)
  assert.equal((await call(['task', 'list'])).body.data.result.total, 1)
})
