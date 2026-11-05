import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContextReader } from '../server/context-reader.mjs'
import { createSkillLibrary } from '../server/skill-library.mjs'
import { referenceSelection } from '../server/skill-hub.mjs'

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'harness-routing-')), root = join(dir, 'skills'), skill = join(root, 'engineering/debug')
  await mkdir(skill, { recursive: true })
  await writeFile(join(skill, 'SKILL.md'), '---\nname: debug\ndescription: Diagnose a reproducible failure\n---\n# Frozen diagnosis instructions\n')
  const snapshot = { modelStatus: 'valid', revision: 'r1', elements: [{ id: 'p', title: 'Project', description: 'Root', metadata: {} }, { id: 'p.a', title: 'A', description: 'Selected context', metadata: {} }], relationships: [] }
  const options = { getSnapshot: () => snapshot, stateDir: join(dir, 'state'), worktreeId: 'one', projectId: 'p', skillLibrary: createSkillLibrary({ root }) }
  const reader = await createContextReader(options)
  return { dir, skill, options, reader }
}

test('one entrance prompt lets the caller select context and skills together, freezes real bodies and restores them by batch', async () => {
  const f = await fixture(), { task, result: rootBatch } = await f.reader.startTask({ title: 'Diagnose failure', client: 'cli' })
  const entrance = await f.reader.prepareTask(task.id)
  assert.ok(entrance.prompt.includes('Skill Hub')); assert.ok(entrance.prompt.includes('p.a')); assert.ok(entrance.prompt.includes('engineering/debug'))
  assert.ok(!entrance.prompt.includes('Frozen diagnosis instructions'), 'unselected full skill body must not enter routing prompt')
  const result = await f.reader.selectTask(task.id, { modelRevision: 'r1', catalogRevision: entrance.catalog.revision, expand: [], read: ['p.a'], skills: [{ id: 'engineering/debug', reason: 'Need to reproduce and diagnose this failure' }] }, 'cli')
  assert.deepEqual(result.task.packet.contexts.map(c => c.id), ['p.a'])
  assert.equal(result.task.skillPlan.skills.length, 1); assert.equal(result.task.skillPlan.observation, 'selection-recorded; execution-unknown')
  assert.ok(!result.handoff.includes('Frozen diagnosis instructions'), 'handoff returns references rather than eagerly loading every file')
  assert.ok(result.handoff.includes('harness.mjs read'))
  assert.ok(!JSON.stringify(referenceSelection(result)).includes('Frozen diagnosis instructions'), 'JSON entrance also returns references, not archive bodies')
  assert.equal((await f.reader.getTask(task.id, { batchId: rootBatch.batchId })).skillPlan, null)
  await rm(f.skill, { recursive: true })
  const restarted = await createContextReader(f.options), historical = await restarted.getTask(task.id)
  assert.ok(historical.skillPlan.skills[0].files[0].content.includes('Frozen diagnosis instructions'))
  assert.ok(!(await restarted.handoff(task.id)).includes('Frozen diagnosis instructions'))
  const files = await restarted.readSkills(task.id, { files: [{ skillId: 'engineering/debug', path: 'SKILL.md' }] })
  assert.ok(files.files[0].content.includes('Frozen diagnosis instructions'))
  assert.equal(files.files[0].hash, historical.skillPlan.skills[0].files[0].hash)
  assert.equal((await restarted.getTask(task.id)).updatedAt, historical.updatedAt, 'archive reads never renew the 60-day retention clock')
  await assert.rejects(restarted.readSkills(task.id, { files: [{ skillId: 'engineering/debug', path: 'SKILL.md', hash: 'wrong' }] }), /指纹|一致/)
  await assert.rejects(restarted.readSkills(task.id, { files: [{ skillId: 'engineering/debug', path: '../SKILL.md' }] }), /路径|文件|无效/)
  await assert.rejects(restarted.readSkills(task.id, { files: [{ skillId: 'engineering/absent', path: 'SKILL.md' }] }), /选择|文件|未知/)
  await assert.rejects(restarted.readSkills(task.id, { batchId: rootBatch.batchId, files: [{ skillId: 'engineering/debug', path: 'SKILL.md' }] }), /确认|选择/)
  await assert.rejects(restarted.selectTask(task.id, { ...result.selection }), /已|选择/)
})

test('changed catalogs reject a joint selection without adding context or fake skills, and an empty skill set is explicit', async () => {
  const f = await fixture(), { task } = await f.reader.startTask({ title: 'Only context', client: 'cli' }), entrance = await f.reader.prepareTask(task.id)
  const selection = { modelRevision: 'r1', catalogRevision: entrance.catalog.revision, expand: [], read: ['p.a'], skills: [] }
  await writeFile(join(f.skill, 'extra.md'), '# New instructions')
  await assert.rejects(f.reader.selectTask(task.id, selection), /变化|版本/)
  assert.equal((await f.reader.getTask(task.id)).batches.length, 1)
  assert.equal((await f.reader.getTask(task.id)).packet.contexts.length, 0)
  const fresh = await f.reader.prepareTask(task.id)
  assert.notEqual(fresh.catalog.revision, entrance.catalog.revision, 'pending entrance automatically rebuilds from the current catalog')
  const result = await f.reader.selectTask(task.id, { ...selection, catalogRevision: fresh.catalog.revision })
  assert.deepEqual(result.task.skillPlan.skills, []); assert.ok(result.handoff.includes('不需要额外技能'))
})

test('concurrent choices cannot overwrite one plan, and partial context failures remain visible in the handoff', async () => {
  const f = await fixture(), { task } = await f.reader.startTask({ title: 'Partial context', client: 'cli' }), entrance = await f.reader.prepareTask(task.id)
  const input = { modelRevision: 'r1', catalogRevision: entrance.catalog.revision, expand: [], read: ['p.a', 'p.missing'], skills: [{ id: 'engineering/debug', reason: 'Diagnose the reported failure' }] }
  const results = await Promise.allSettled([f.reader.selectTask(task.id, input), f.reader.selectTask(task.id, input)])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const selected = results.find(result => result.status === 'fulfilled').value
  assert.equal(selected.task.batches.length, 2); assert.equal(selected.task.batches.at(-1).status, 'partial')
  assert.ok(selected.handoff.includes('p.missing')); assert.equal(selected.task.skillPlan.skills.length, 1)
})

test('an explicit empty context and skill selection still records a choice distinct from missing history', async () => {
  const f = await fixture(), { task } = await f.reader.startTask({ title: 'No extra resources', client: 'cli' }), entrance = await f.reader.prepareTask(task.id)
  const selected = await f.reader.selectTask(task.id, { modelRevision: 'r1', catalogRevision: entrance.catalog.revision, expand: [], read: [], skills: [] })
  assert.equal(selected.task.batches.length, 2); assert.equal(selected.task.batches.at(-1).status, 'complete')
  assert.deepEqual(selected.task.skillPlan.skills, []); assert.equal(selected.task.packet.contexts.length, 0)
})

test('an interrupted joint batch remains unknown after restart and cannot be handed off as a confirmed skill plan', async () => {
  const f = await fixture(), { task } = await f.reader.startTask({ title: 'Interrupted selection', client: 'cli' }), entrance = await f.reader.prepareTask(task.id)
  await f.reader.selectTask(task.id, { modelRevision: 'r1', catalogRevision: entrance.catalog.revision, expand: [], read: ['p.a'], skills: [{ id: 'engineering/debug', reason: 'Diagnose failure' }] })
  const path = join(f.options.stateDir, 'context-tasks', task.id + '.json'), record = JSON.parse(await readFile(path, 'utf8'))
  record.batches.at(-1).status = 'requested'; await writeFile(path, JSON.stringify(record))
  const restarted = await createContextReader(f.options), state = await restarted.getTask(task.id)
  assert.equal(state.batches.at(-1).status, 'unknown'); assert.equal(state.skillRouting.status, 'unknown'); assert.equal(state.skillPlan, null)
  assert.equal(state.packet.contexts.length, 0); await assert.rejects(restarted.handoff(task.id), /尚无|确认/)
})

test('corrupted archived skill bytes cannot be displayed or handed off with the original fingerprint', async () => {
  const f = await fixture(), { task } = await f.reader.startTask({ title: 'Archive integrity', client: 'cli' }), entrance = await f.reader.prepareTask(task.id)
  await f.reader.selectTask(task.id, { modelRevision: 'r1', catalogRevision: entrance.catalog.revision, expand: [], read: [], skills: [{ id: 'engineering/debug', reason: 'Need diagnosis' }] })
  const path = join(f.options.stateDir, 'context-tasks', task.id + '.json'), record = JSON.parse(await readFile(path, 'utf8'))
  record.batches.at(-1).skillPlan.skills[0].files[0].content = '# Corrupted instructions'
  await writeFile(path, JSON.stringify(record))
  const restarted = await createContextReader(f.options)
  await assert.rejects(restarted.getTask(task.id), /指纹|损坏/)
  await assert.rejects(restarted.handoff(task.id), /指纹|损坏/)
})
