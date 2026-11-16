import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, copyFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { usageReport } from '../../scripts/v1/usage-report.mjs'
import { execFile } from './helpers.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harnessl3-usage-report-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const envelope = data => ({ schemaVersion: 1, requestId: randomUUID(), target: null, ok: true, replayed: false, data })
  const save = async (file, data) => { await writeFile(path.join(root, file), JSON.stringify(data)); return file }
  return { root, envelope, save }
}
test('TC26 the measurement command executes through a linked installation path', async t => {
  const f = await fixture(t)
  const tools = path.join(f.root, 'tool files'), linked = path.join(f.root, 'linked tools')
  await mkdir(tools)
  await copyFile(new URL('../../scripts/v1/usage-report.mjs', import.meta.url), path.join(tools, 'usage-report.mjs'))
  await symlink(tools, linked, process.platform === 'win32' ? 'junction' : 'dir')
  const stdout = await f.save('sample.json', f.envelope({ kind: 'context-batch', result: { contexts: [] } }))
  const manifest = await f.save('manifest.json', { schemaVersion: 1, samples: [{ pairId: 'linked', condition: 'candidate', operation: 'context query', elapsedMs: 10, exitCode: 0, stdout }] })
  const output = path.join(f.root, 'report.json')
  await execFile(process.execPath, [path.join(linked, 'usage-report.mjs'), '--manifest', path.join(f.root, manifest), '--out', output], { windowsHide: true })
  assert.equal(JSON.parse(await readFile(output, 'utf8')).summary.candidate.calls, 1)
})
test('TC17 usage measurement separates scoped success, pending workspace and unknown task effects', async t => {
  const f = await fixture(t)
  const stdout = await f.save('proof.json', f.envelope({ kind: 'command-result', result: { state: 'pending', scopeStatus: 'passed', declaration: {}, pendingPaths: ['other.ts'] } }))
  const before = await readFile(path.join(f.root, stdout))
  const report = await usageReport({ schemaVersion: 1, samples: [{ pairId: 'proof', condition: 'candidate', operation: 'sync verify', elapsedMs: 12, exitCode: 0, stdout }] }, f.root)
  assert.equal(report.summary.candidate.scopedProofsPassed, 1)
  assert.equal(report.summary.candidate.workspacesVerified, 0)
  assert.equal(report.pairs[0].comparable, false)
  assert.equal(report.pairs[0].elapsedDeltaMs, null)
  assert.equal(report.interpretation.causalBusinessImprovement, 'unknown')
  assert.deepEqual(await readFile(path.join(f.root, stdout)), before)
})
test('TC17 measurement compares explicit pairs and rejects invalid, duplicate or changed evidence', async t => {
  const f = await fixture(t)
  const stdout = await f.save('sample.json', f.envelope({ kind: 'context-batch', result: { contexts: [{}] } }))
  const baseline = { pairId: 'same-work', condition: 'baseline', operation: 'context query', elapsedMs: 100, exitCode: 0, stdout }
  const candidate = { ...baseline, condition: 'candidate', elapsedMs: 25 }
  const manifest = { schemaVersion: 1, samples: [baseline, candidate] }
  const report = await usageReport(manifest, f.root)
  assert.equal(report.pairs[0].comparable, true)
  assert.equal(report.pairs[0].elapsedDeltaMs, -75)
  await assert.rejects(usageReport({ ...manifest, samples: [baseline, baseline] }, f.root), /Duplicate/)
  await assert.rejects(usageReport({ ...manifest, samples: [{ ...baseline, exitCode: 1 }] }, f.root), /exit code/)
  const bytes = Buffer.from('acceptance result')
  await writeFile(path.join(f.root, 'acceptance.txt'), bytes)
  const outcome = { pairId: 'business', condition: 'candidate', taskId: randomUUID(), status: 'passed', evidence: [{ path: 'acceptance.txt', sha256: createHash('sha256').update(bytes).digest('hex') }] }
  const declared = await usageReport({ ...manifest, outcomes: [outcome] }, f.root)
  assert.equal(declared.outcomePairs[0].comparable, false)
  assert.equal(declared.outcomes[0].observation, 'declared-outcome; artifact-bytes-matched; causality-unknown')
  await writeFile(path.join(f.root, 'acceptance.txt'), 'changed')
  await assert.rejects(usageReport({ ...manifest, outcomes: [outcome] }, f.root), /bytes changed/)
})
