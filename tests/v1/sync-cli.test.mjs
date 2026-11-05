import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
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
