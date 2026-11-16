import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

const fail = message => { throw new Error(message) }
const conditions = ['baseline', 'candidate']
const decode = bytes => bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : new TextDecoder('utf-8', { fatal: true }).decode(bytes)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const summarize = values => {
  if (!values.length) return { count: 0, p50: null, p95: null }
  const sorted = [...values].sort((a, b) => a - b)
  return { count: values.length, p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1] }
}

/** Reads only explicitly supplied artifacts. It never discovers sessions or modifies an archive. */
export async function usageReport(manifest, baseDirectory) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.samples) || !Array.isArray(manifest.outcomes ?? [])) fail('Expected schemaVersion:1, samples and optional outcomes arrays')
  const samples = [], seen = new Set()
  for (const sample of manifest.samples) {
    if (!conditions.includes(sample.condition) || typeof sample.pairId !== 'string' || !sample.pairId || typeof sample.operation !== 'string' || !sample.operation || !Number.isFinite(sample.elapsedMs) || sample.elapsedMs < 0 || !Number.isSafeInteger(sample.exitCode) || typeof sample.stdout !== 'string') fail('Invalid sample metadata')
    const key = sample.pairId + ':' + sample.condition
    if (seen.has(key)) fail('Duplicate sample pair and condition: ' + key)
    seen.add(key)
    const bytes = await readFile(path.resolve(baseDirectory, sample.stdout))
    let envelope
    try { envelope = JSON.parse(decode(bytes)) } catch { fail('Sample stdout is not one complete JSON envelope: ' + sample.stdout) }
    if (envelope?.schemaVersion !== 1 || typeof envelope.ok !== 'boolean' || typeof envelope.requestId !== 'string' || (envelope.ok ? !envelope.data : !envelope.error?.code)) fail('Invalid response envelope: ' + sample.stdout)
    const data = envelope.ok ? envelope.data : null
    const partial = data?.status === 'partial'
    if ((envelope.ok && sample.exitCode !== (partial ? 4 : 0)) || (!envelope.ok && sample.exitCode === 0)) fail('CLI exit code disagrees with response: ' + sample.stdout)
    const verification = sample.operation === 'sync verify' && data?.kind === 'command-result' ? data.result : null
    samples.push({ pairId: sample.pairId, condition: sample.condition, operation: sample.operation, elapsedMs: sample.elapsedMs,
      stdoutBytes: bytes.length, stdoutHash: hash(bytes), requestId: envelope.requestId, target: envelope.target,
      ok: envelope.ok, partial, errorCode: envelope.ok ? null : envelope.error.code,
      contextsReturned: data?.result?.contexts?.length ?? 0,
      skillFilesReturned: data?.kind === 'skill-files' ? data.files.length : 0,
      scopedProofPassed: Boolean(verification?.declaration && envelope.ok && verification.scopeStatus !== 'failed'),
      workspaceVerified: verification?.state === 'verified', remainingPendingPaths: verification?.pendingPaths?.length ?? null,
      sourceStatus: data?.binding?.sourceVersion?.status ?? null })
  }
  const pairs = []
  for (const pairId of new Set(samples.map(sample => sample.pairId))) {
    const baseline = samples.find(sample => sample.pairId === pairId && sample.condition === 'baseline')
    const candidate = samples.find(sample => sample.pairId === pairId && sample.condition === 'candidate')
    if (baseline && candidate && baseline.operation !== candidate.operation) fail('Paired operations differ: ' + pairId)
    pairs.push({ pairId, comparable: Boolean(baseline && candidate && baseline.ok && candidate.ok && !baseline.partial && !candidate.partial),
      elapsedDeltaMs: baseline && candidate ? candidate.elapsedMs - baseline.elapsedMs : null,
      byteDelta: baseline && candidate ? candidate.stdoutBytes - baseline.stdoutBytes : null })
  }
  const outcomes = [], outcomeKeys = new Set()
  for (const outcome of manifest.outcomes ?? []) {
    if (!conditions.includes(outcome.condition) || typeof outcome.pairId !== 'string' || !outcome.pairId || typeof outcome.taskId !== 'string' || !['passed', 'failed', 'unknown'].includes(outcome.status) || !Array.isArray(outcome.evidence)) fail('Invalid declared outcome')
    const key = outcome.pairId + ':' + outcome.condition
    if (outcomeKeys.has(key)) fail('Duplicate outcome: ' + key)
    outcomeKeys.add(key)
    const evidence = []
    for (const reference of outcome.evidence) {
      if (typeof reference.path !== 'string' || !/^[a-f0-9]{64}$/.test(reference.sha256 ?? '')) fail('Outcome evidence requires path and SHA-256')
      const bytes = await readFile(path.resolve(baseDirectory, reference.path))
      if (hash(bytes) !== reference.sha256) fail('Outcome evidence bytes changed: ' + reference.path)
      evidence.push(reference)
    }
    if (outcome.status !== 'unknown' && !evidence.length) fail('A known outcome requires an explicit acceptance artifact')
    outcomes.push({ ...outcome, evidence, observation: 'declared-outcome; artifact-bytes-matched; causality-unknown' })
  }
  const outcomePairs = [...new Set(outcomes.map(item => item.pairId))].map(pairId => {
    const baseline = outcomes.find(item => item.pairId === pairId && item.condition === 'baseline')
    const candidate = outcomes.find(item => item.pairId === pairId && item.condition === 'candidate')
    return { pairId, baseline: baseline?.status ?? 'unknown', candidate: candidate?.status ?? 'unknown', comparable: Boolean(baseline && candidate && baseline.status !== 'unknown' && candidate.status !== 'unknown') }
  })
  return { schemaVersion: 1, scope: 'explicit-artifacts-only', samples, pairs, outcomes, outcomePairs,
    summary: Object.fromEntries(conditions.map(condition => {
      const selected = samples.filter(sample => sample.condition === condition)
      return [condition, { calls: selected.length, successful: selected.filter(sample => sample.ok).length,
        contextsReturned: selected.reduce((sum, sample) => sum + sample.contextsReturned, 0), skillFilesReturned: selected.reduce((sum, sample) => sum + sample.skillFilesReturned, 0),
        scopedProofsPassed: selected.filter(sample => sample.scopedProofPassed).length, workspacesVerified: selected.filter(sample => sample.workspaceVerified).length,
        latencyMs: summarize(selected.map(sample => sample.elapsedMs)), stdoutBytes: selected.reduce((sum, sample) => sum + sample.stdoutBytes, 0) }]
    })),
    interpretation: { comprehension: 'unknown', execution: 'unknown', logCoverage: 'not-measured', causalBusinessImprovement: 'unknown',
      comparison: 'Pairs require caller-controlled equivalent workload and conditions. Missing baselines and failed calls cannot establish improvement. Durations and bytes are observations, not token or comprehension measurements.' } }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 4 || args[0] !== '--manifest' || args[2] !== '--out') fail('Usage: node scripts/v1/usage-report.mjs --manifest <UTF-8 JSON> --out <report.json>')
  const manifestFile = path.resolve(args[1]), output = path.resolve(args[3])
  if (manifestFile === output) fail('Output must not overwrite the input manifest')
  const report = await usageReport(JSON.parse(decode(await readFile(manifestFile))), path.dirname(manifestFile))
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  process.stdout.write(JSON.stringify({ ok: true, report: output, summary: report.summary }) + '\n')
}
if (import.meta.main) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1 })
