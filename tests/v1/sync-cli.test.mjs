import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fixture } from './helpers.mjs'

test('TC07–08 CLI source proofs record declarations, reject stale versions and preserve pending on close', async t => {
  const f = await fixture(t, 'harness-v1-sync-cli-')
  const root = await f.repository()
  const initialized = await f.cli(['init'], { cwd: root })
  assert.equal(initialized.code, 0, initialized.stdout)
  const status = await f.cli(['sync', 'status'], { cwd: root })
  assert.equal(status.code, 0, status.stdout)
  const first = status.body.data.result
  assert.equal(first.modelState, 'valid')
  assert.equal(first.state, 'pending')
  const proof = { schemaVersion: 1, requestId: randomUUID(), target: initialized.body.target, phaseId: randomUUID(), sourceEpoch: first.sourceEpoch, expectedSourceVersion: first.sourceVersion, expectedModelRevision: first.modelRevision, scope: { paths: ['README.md'], entities: [] }, disposition: 'no-semantic-change', reason: 'The fixture README has no semantic changes', checks: [{ name: 'Reviewed the selected source', status: 'passed', evidence: ['README.md'] }] }
  const verify = input => f.cli(['sync', 'verify', '--file', '-'], { cwd: root, input: JSON.stringify(input) })
  const verified = await verify(proof)
  assert.equal(verified.code, 0, verified.stdout)
  assert.equal(verified.body.data.result.state, 'verified')
  assert.deepEqual(verified.body.data.result.declaration, proof)
  const task = await f.cli(['task', 'start', '--title', 'Check pending close'], { cwd: root })
  assert.equal(task.code, 0, task.stdout)
  await writeFile(path.join(root, 'README.md'), 'A changed source requires a new scoped proof\n')
  const changed = await f.cli(['sync', 'status'], { cwd: root })
  assert.equal(changed.body.data.result.state, 'pending')
  assert.ok(changed.body.data.result.sourceEpoch > first.sourceEpoch)
  const stale = await verify({ ...proof, requestId: randomUUID() })
  assert.equal(stale.body.error.code, 'SYNC_RACE')
  const replay = await verify(proof)
  assert.equal(replay.body.replayed, true)
  assert.equal(replay.body.data.result.state, 'verified')
  const closed = await f.cli(['task', 'close', task.body.data.taskId], { cwd: root })
  assert.equal(closed.code, 0, closed.stdout)
  assert.equal(closed.body.data.result.syncStatus.state, 'pending')
  const handoff = await f.cli(['task', 'handoff', task.body.data.taskId], { cwd: root })
  assert.equal(handoff.code, 0, handoff.stdout)
  assert.deepEqual(handoff.body.data.packet.contexts, [])
})

test('TC06–08 CLI exposes document Git advice and evidence failures, then verifies repaired current references', async t => {
  const f = await fixture(t, 'harness-v1-document-cli-')
  const root = await f.repository()
  const initialized = await f.cli(['init'], { cwd: root })
  assert.equal(initialized.code, 0, initialized.stdout)
  const document = path.join(root, 'decision.md'), evidenceId = randomUUID()
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  await writeFile(document, 'Confirmed decision\n')
  const evidence = { schemaVersion: 1, evidence: [{ id: evidenceId, kind: 'document', claim: 'Confirmed fixture decision', location: { path: 'decision.md' }, hash: hash(await readFile(document)), observedAt: new Date().toISOString() }] }
  const evidencePath = path.join(root, '.harness', 'evidence.json')
  await writeFile(evidencePath, JSON.stringify(evidence))
  const modelPath = path.join(root, '.harness', 'model', 'main.c4')
  await writeFile(modelPath, (await readFile(modelPath, 'utf8')).replace('evidence "none"', `evidence "${evidenceId}"`))
  const status = async () => {
    const response = await f.cli(['sync', 'status'], { cwd: root })
    assert.equal(response.code, 0, response.stdout)
    return response.body.data.result
  }
  const proofFor = state => ({ schemaVersion: 1, requestId: randomUUID(), target: initialized.body.target, phaseId: randomUUID(), sourceEpoch: state.sourceEpoch, expectedSourceVersion: state.sourceVersion, expectedModelRevision: state.modelRevision, scope: { paths: state.pendingPaths.length ? state.pendingPaths : ['decision.md'], entities: [] }, disposition: 'updated', reason: 'Reviewed current fixture document and its evidence.', checks: [{ name: 'Document review', status: 'passed', evidence: ['decision.md'] }] })
  const verify = input => f.cli(['sync', 'verify', '--file', '-'], { cwd: root, input: JSON.stringify(input) })
  const initial = await status()
  assert.ok(initial.diagnostics.some(item => item.code === 'EVIDENCE_UNTRACKED'))
  const healthy = await verify(proofFor(initial))
  assert.equal(healthy.code, 0, healthy.stdout)
  assert.equal(healthy.body.data.result.state, 'verified')
  await writeFile(document, 'Changed decision\n')
  const changed = await status()
  assert.ok(changed.diagnostics.some(item => item.code === 'EVIDENCE_CHANGED' && item.evidenceId === evidenceId))
  const failedRequest = proofFor(changed)
  const failed = await verify(failedRequest)
  assert.equal(failed.body.error.code, 'SYNC_UNRESOLVED', failed.stdout)
  assert.ok(failed.body.error.details.result.diagnostics.some(item => item.code === 'EVIDENCE_CHANGED'))
  assert.equal(failed.body.error.details.result.automaticChecks.find(item => item.name === 'referenced-evidence').status, 'failed')
  evidence.evidence[0].hash = hash(await readFile(document))
  evidence.evidence[0].observedAt = new Date().toISOString()
  evidence.evidence[0].claim = 'Reviewed changed fixture decision'
  await writeFile(evidencePath, JSON.stringify(evidence))
  const repaired = await status()
  const verified = await verify(proofFor(repaired))
  assert.equal(verified.code, 0, verified.stdout)
  assert.equal(verified.body.data.result.state, 'verified')
  const replay = await verify(failedRequest)
  assert.equal(replay.body.error.details.replayed, true)
  assert.equal(replay.body.error.code, 'SYNC_UNRESOLVED')
  assert.ok(replay.body.error.details.result.diagnostics.some(item => item.code === 'EVIDENCE_CHANGED'))
  assert.equal((await status()).state, 'verified', 'Replaying the old failure preserves the repaired current state')
})
