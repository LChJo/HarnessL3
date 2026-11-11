import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fixture } from './helpers.mjs'
import { parseArgs } from '../../build/cli/args.js'
import { Archive } from '../../build/core/archive.js'

const ids = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003']
const metadata = (id, brief) => `metadata { harness_id "${id}" brief "${brief}" source "human" status "unknown" evidence "none" version "1" }`
const model = (expanded = false) => `specification { element system element component }
model { app = system "Example" { ${metadata(ids[0], 'Project boundary')}
  api = component "API" { ${metadata(ids[1], 'Public API')} }
  worker = component "Worker" { ${metadata(ids[2], 'Background worker')} }
} }
views { view overview { include * } ${expanded ? 'view modules of app { include app.* }' : ''} }
`

test('TC03/22 model maintenance has independent modes and preserves task start mode validation', () => {
  for (const mode of ['supplement', 'revise', 'rebuild']) assert.equal(parseArgs(['model', 'maintain', '--mode', mode]).flags.mode, mode)
  assert.equal(parseArgs(['model', 'maintain']).operation, 'model maintain')
  assert.throws(() => parseArgs(['model', 'maintain', '--mode', 'snapshot']), /mode/)
  assert.throws(() => parseArgs(['task', 'start', '--title', 'Task', '--mode', 'rebuild']), /mode/)
})

test('TC03/27 init and maintain return actionable guidance without scanning source or rewriting authority', async t => {
  const f = await fixture(t, 'harnessl3-model-maintain-')
  const root = await f.repository()
  const initialized = await f.cli(['init'], { cwd: root })
  assert.equal(initialized.code, 0, initialized.stdout)
  assert.match(initialized.body.data.result.initialization.agentGuidance, /view coverage/i)
  assert.deepEqual(initialized.body.data.result.initialization.maintenanceCommand, ['harnessl3', 'model', 'maintain', '--mode', 'supplement'])
  const nested = path.join(root, 'separate-repository')
  await mkdir(nested)
  await f.git(nested, 'init')
  const files = ['project.json', 'model/main.c4', 'evidence.json', 'aliases.json']
  const before = await Promise.all(files.map(file => readFile(path.join(root, '.harness', file))))
  for (const mode of ['supplement', 'revise', 'rebuild']) {
    const response = await f.cli(['model', 'maintain', '--mode', mode], { cwd: root })
    assert.equal(response.code, 0, response.stdout)
    const result = response.body.data.result
    assert.equal(result.mode, mode)
    assert.equal(result.stage, 'guidance-ready')
    assert.equal(result.semanticStatus, 'not-assessed')
    assert.equal(result.sourceScan, 'not-requested')
    assert.equal(result.observedSource, null, 'No live observation exists; do not restore archives just for a modeling brief')
    assert.equal(result.topology.objects, 1)
    assert.ok(result.coverage.hints.some(hint => hint.code === 'ROOT_ONLY_MODEL'))
    assert.match(result.agentPrompt, /preserve.*harness_id/i)
    assert.match(result.agentPrompt, /planned.*implemented/i)
    assert.match(result.agentPrompt, /sync verify/)
  }
  assert.deepEqual(await Promise.all(files.map(file => readFile(path.join(root, '.harness', file)))), before)
  await assert.rejects(access(path.join(f.dataRoot, 'worktrees', initialized.body.data.result.worktree.id, 'journal.jsonl')))
  assert.deepEqual((await f.cli(['task', 'list'], { cwd: root })).body.data.result.items, [])
  const help = await f.cli(['model', 'maintain', '--help'])
  assert.match(help.stdout, /supplement\|revise\|rebuild/)
  assert.match(help.stdout, /Result schema: .+model-maintenance\.schema\.json/)
})

test('TC03/10/21 model coverage detects hidden leaves; agent edits evolve new snapshots while old graphs stay fixed', async t => {
  const f = await fixture(t, 'harnessl3-model-evolve-')
  const root = await f.repository()
  await f.cli(['init'], { cwd: root })
  const file = path.join(root, '.harness/model/main.c4')
  await writeFile(file, model())
  const old = await f.cli(['task', 'start', '--title', 'Before structural evolution'], { cwd: root })
  assert.equal(old.code, 0, old.stdout)
  const before = await f.cli(['model', 'maintain'], { cwd: root })
  assert.equal(before.code, 0, before.stdout)
  assert.deepEqual(before.body.data.result.coverage.unrepresentedLeaves.map(item => item.id).sort(), ids.slice(1))
  assert.equal(before.body.data.result.topology.views[0].nodes, 1)
  await writeFile(file, model(true))
  const after = await f.cli(['model', 'maintain', '--mode', 'revise'], { cwd: root })
  assert.equal(after.code, 0, after.stdout)
  assert.deepEqual(after.body.data.result.coverage.unrepresentedLeaves, [])
  assert.equal(after.body.data.result.topology.views.find(view => view.id === 'modules').nodes, 2)
  assert.notEqual(before.body.data.result.modelRevision, after.body.data.result.modelRevision)
  const current = await f.cli(['task', 'start', '--title', 'After structural evolution'], { cwd: root })
  assert.equal(current.code, 0, current.stdout)
  assert.equal(current.body.data.binding.modelRevision, after.body.data.result.modelRevision)
  const restored = await f.cli(['task', 'show', old.body.data.taskId], { cwd: root })
  assert.equal(restored.code, 0, restored.stdout)
  const originalTask = restored.body.data.result.task
  assert.equal(originalTask.binding.modelRevision, old.body.data.binding.modelRevision)
  assert.notEqual(originalTask.binding.modelRevision, current.body.data.binding.modelRevision)
  const archive = new Archive(path.join(f.dataRoot, 'worktrees', originalTask.binding.worktreeId), { readOnly: true })
  await archive.ready()
  const oldModel = await archive.readSnapshot(originalTask.modelSnapshotHash)
  assert.equal(oldModel.views.length, 1)
  assert.equal(oldModel.views[0].nodes.length, 1)
  const rebuild = await f.cli(['model', 'maintain', '--mode', 'rebuild'], { cwd: root })
  assert.equal(rebuild.code, 0, rebuild.stdout)
  assert.equal(await readFile(file, 'utf8'), model(true))
})

test('TC03 invalid models can receive repair/rebuild guidance without becoming valid', async t => {
  const f = await fixture(t, 'harnessl3-model-repair-')
  const root = await f.repository()
  await f.cli(['init'], { cwd: root })
  const file = path.join(root, '.harness/model/main.c4')
  await writeFile(file, 'model { broken =')
  const response = await f.cli(['model', 'maintain', '--mode', 'rebuild'], { cwd: root })
  assert.equal(response.code, 0, response.stdout)
  assert.equal(response.body.data.result.modelState, 'invalid')
  assert.equal(response.body.data.result.topology, null)
  assert.equal(response.body.data.result.semanticStatus, 'not-assessed')
  assert.ok(response.body.data.result.diagnostics.some(item => item.severity === 'error'))
  assert.equal((await f.cli(['model', 'validate'], { cwd: root })).body.ok, false)
  assert.equal(await readFile(file, 'utf8'), 'model { broken =')
})

test('TC07/08 sync surfaces model evolution review without claiming semantic updates', async t => {
  const f = await fixture(t, 'harnessl3-model-sync-')
  const root = await f.repository()
  await f.cli(['init'], { cwd: root })
  await f.cli(['sync', 'status'], { cwd: root })
  await writeFile(path.join(root, 'new-module.ts'), 'export const newModule = true\n')
  const response = await f.cli(['sync', 'status'], { cwd: root })
  assert.equal(response.code, 0, response.stdout)
  const result = response.body.data.result
  assert.ok(result.pendingPaths.includes('new-module.ts'))
  assert.equal(result.modelMaintenance.state, 'review-required')
  assert.equal(result.modelMaintenance.semanticStatus, 'not-assessed')
  assert.deepEqual(result.modelMaintenance.command, ['harnessl3', 'model', 'maintain', '--mode', 'supplement'])
  const maintained = (await f.cli(['model', 'maintain'], { cwd: root })).body.data.result
  assert.equal(maintained.observedSource.scope, 'last-observed')
  assert.equal(maintained.observedSource.sourceEpoch, result.sourceEpoch)
  assert.deepEqual(maintained.observedSource.sourceVersion, result.sourceVersion)
  assert.ok(maintained.observedSource.pendingPaths.includes('new-module.ts'))
  const entry = await f.cli(['task', 'start', '--title', 'Continue development'], { cwd: root })
  assert.match(entry.body.data.routingPrompt, /model maintain/)
  assert.match(entry.body.data.routingPrompt, /structural changes/i)
})
