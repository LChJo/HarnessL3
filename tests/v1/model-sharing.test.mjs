import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fixture } from './helpers.mjs'
import { loadModel, modelSharingMetrics } from '../../build/core/model.js'

test('TC02/17 identical worktrees reuse immutable model structure; local evidence and edits remain independent', async t => {
  const f = await fixture(t, 'harness-model-sharing-', { legacy: false })
  const main = await f.repository()
  await f.git(main, 'config', 'core.autocrlf', 'false')
  const modelPath = root => path.join(root, '.harness/model/main.c4')
  await mkdir(path.dirname(modelPath(main)), { recursive: true })
  const objects = Array.from({ length: 120 }, (_, i) => `  o${i} = component "Component ${i}" {
    metadata {
      harness_id "10000000-0000-4000-8000-${String(i).padStart(12, '0')}"
      brief "Component ${i}"
      source "human"
      status "unknown"
      evidence "none"
      version "1"
    }
  }`).join('\n')
  const model = 'specification { element component }\nmodel {\n' + objects + '\n}\nviews { view overview { include o0 } }\n'
  await writeFile(modelPath(main), model)
  const proof = { id: '30000000-0000-4000-8000-000000000001', kind: 'document', claim: 'Fixture', location: { path: 'README.md' }, hash: createHash('sha256').update(await readFile(path.join(main, 'README.md'))).digest('hex'), observedAt: '2026-01-01T00:00:00.000Z' }
  const secondProof = { ...proof, id: '30000000-0000-4000-8000-000000000002' }
  await writeFile(path.join(main, '.harness/evidence.json'), JSON.stringify({ schemaVersion: 1, evidence: [proof, secondProof] }))
  await writeFile(path.join(main, '.harness/project.json'), JSON.stringify({ schemaVersion: 1, projectId: '40000000-0000-4000-8000-000000000001', name: 'Shared model fixture', source: { excludePatterns: [] } }))
  await writeFile(path.join(main, '.harness/aliases.json'), '{"schemaVersion":1,"aliases":{}}')
  await f.git(main, 'add', '.harness'); await f.git(main, 'commit', '-m', 'Shared model')
  const roots = [main]
  for (let i = 1; i < 8; i++) {
    const root = path.join(f.directory, 'worktree-' + i)
    await f.git(main, 'worktree', 'add', '-b', 'feature-' + i, root)
    roots.push(root)
  }
  await writeFile(path.join(roots[1], 'README.md'), 'Local evidence differs')
  global.gc?.()
  const before = process.memoryUsage()
  const initialMetrics = modelSharingMetrics()
  const samples = [], snapshots = []
  let firstMemory
  for (const root of roots) {
    const start = performance.now()
    snapshots.push(await loadModel(root))
    samples.push(performance.now() - start)
    if (snapshots.length === 1) { global.gc?.(); firstMemory = process.memoryUsage() }
  }
  global.gc?.()
  const after = process.memoryUsage()
  const metrics = modelSharingMetrics()
  t.diagnostic(JSON.stringify({ samplesMs: samples, firstRssDelta: firstMemory.rss - before.rss, firstHeapDelta: firstMemory.heapUsed - before.heapUsed, rssDelta: after.rss - before.rss, heapDelta: after.heapUsed - before.heapUsed, modelBytes: Buffer.byteLength(model), uniqueStructures: new Set(snapshots.map(item => item.entities)).size, metrics }))
  assert.equal(metrics.parses - initialMetrics.parses, 1)
  assert.equal(metrics.hits - initialMetrics.hits, 7)
  assert.equal(metrics.evidenceReads - initialMetrics.evidenceReads, 8)
  assert.equal(new Set(snapshots.map(item => item.entities)).size, 1)
  assert.equal(new Set(snapshots.map(item => item.views)).size, 1)
  assert.ok(Object.isFrozen(snapshots[0].entities[0]))
  assert.equal(snapshots[1].diagnostics.filter(item => item.code === 'EVIDENCE_CHANGED').length, 2)
  assert.ok(!snapshots[0].diagnostics.some(item => item.code === 'EVIDENCE_CHANGED'))
  await writeFile(modelPath(roots[2]), model.replace('Component 0', 'Local component'))
  const changed = await loadModel(roots[2])
  assert.notEqual(changed.revision, snapshots[0].revision)
  assert.equal(changed.entities[0].title, 'Local component')
  assert.equal(snapshots[0].entities[0].title, 'Component 0')
  await writeFile(modelPath(roots[2]), model)
  assert.equal((await loadModel(roots[2])).entities, snapshots[0].entities)
  const concurrentModel = model + '\n// concurrent version\n'
  await Promise.all(roots.map(root => writeFile(modelPath(root), concurrentModel)))
  const concurrentBefore = modelSharingMetrics()
  const simultaneous = await Promise.all(roots.map(root => loadModel(root)))
  assert.equal(new Set(simultaneous.map(item => item.entities)).size, 1)
  assert.equal(modelSharingMetrics().parses - concurrentBefore.parses, 1)
  // Normal task entry and history use the exact worktree binding.
  const startTask = async root => {
    const registered = await f.cli(['worktree', 'register', root], { cwd: root })
    assert.equal(registered.code, 0, registered.stdout)
    const startedAt = performance.now()
    const started = await f.cli(['task', 'start', '--title', 'Shared model'], { cwd: root })
    taskStartSamples.push(performance.now() - startedAt)
    assert.equal(started.code, 0, started.stdout)
    return started.body.data
  }
  const taskStartSamples = []
  const first = await startTask(roots[0])
  const firstDiagnostic = await f.cli(['runtime', 'diagnostics'], { cwd: main })
  assert.equal(firstDiagnostic.code, 0, firstDiagnostic.stdout)
  const second = await startTask(roots[1])
  for (const root of roots.slice(2)) await startTask(root)
  assert.equal(first.binding.modelRevision, second.binding.modelRevision)
  assert.notEqual(first.binding.worktreeId, second.binding.worktreeId)
  assert.equal(first.binding.sourceVersion.status, 'unknown')
  const diagnostic = await f.cli(['runtime', 'diagnostics'], { cwd: main })
  assert.equal(diagnostic.code, 0, diagnostic.stdout)
  const runtime = diagnostic.body.data.result
  t.diagnostic(JSON.stringify({ taskStartSamplesMs: taskStartSamples, firstServiceMemory: firstDiagnostic.body.data.result.memory, serviceMemory: runtime.memory, loadedWorktrees: runtime.loadedWorktrees, modelSharing: runtime.modelSharing }))
  assert.equal(runtime.loadedWorktrees, 8)
  assert.equal(runtime.modelSharing.parses, 1)
  assert.ok(runtime.modelSharing.hits >= 7)
  const restored = await f.cli(['task', 'handoff', first.taskId], { cwd: main })
  assert.equal(restored.code, 0, restored.stdout)
  assert.equal(restored.body.data.binding.worktreeId, first.binding.worktreeId)
  await writeFile(modelPath(roots[2]), 'invalid model syntax')
  await assert.rejects(loadModel(roots[2]), { code: 'MODEL_INVALID' })
  await writeFile(modelPath(roots[2]), concurrentModel)
  assert.equal((await loadModel(roots[2])).entities, simultaneous[0].entities)
  for (let i = 0; i < 17; i++) {
    await writeFile(modelPath(roots[2]), model + '\n// bounded version ' + i)
    await loadModel(roots[2])
  }
  assert.ok(modelSharingMetrics().retainedVersions <= 16)
  assert.ok(modelSharingMetrics().estimatedSerializedBytes <= 32 * 1024 * 1024)
  assert.notEqual((await loadModel(main)).entities, simultaneous[0].entities)
})
