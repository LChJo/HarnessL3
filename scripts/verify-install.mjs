import { execFile as callbackExecFile } from 'node:child_process'
import { promisify, isDeepStrictEqual } from 'node:util'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { canonicalJson, parseJsonStrict } from '../build/core/json.js'
import { runtimeFingerprint, parsePackageBuild } from '../build/core/package.js'

const execFile = promisify(callbackExecFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const binary = path.join(root, 'bin/harnessl3.mjs')
const failure = (code, message, details = {}) => Object.assign(new Error(message), { code, details })
const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex')
const packet = data => ({ packet: data.packet, skillPlan: data.skillPlan, binding: data.binding })

export async function verifyInstallation(options = {}) {
  const started = Date.now(), timeoutMs = options.timeoutMs ?? 120_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw failure('INVALID_ARGUMENT', 'timeout-ms must be from 1 to 600000')
  const deadline = started + timeoutMs
  const report = { schemaVersion: 1, ok: false, stage: 'package', checks: [], historyCheck: 'not-requested', elapsedMs: 0 }
  const progress = message => process.stderr.write(`HarnessL3 verification (${Date.now() - started}ms): ${message}\n`)
  const command = async (args, requestId = randomUUID(), json = true) => {
    const arguments_ = [binary, ...args, ...(json ? ['--json', '--request-id', requestId, '--timeout-ms', String(Math.min(3_600_000, Math.max(1, deadline - Date.now())))] : []), ...(json && options.dataDir ? ['--data-dir', options.dataDir] : [])]
    let stdout
    try { ({ stdout } = await execFile(process.execPath, arguments_, { windowsHide: true, timeout: Math.max(1, deadline - Date.now()), maxBuffer: 32 * 1024 * 1024 })) }
    catch (error) {
      if (!error.killed && typeof error.stdout === 'string' && error.stdout.trim()) stdout = error.stdout
      else throw failure(error.killed ? 'VERIFICATION_TIMEOUT' : 'CLI_UNAVAILABLE', 'The installed CLI did not complete verification', { requestId, operation: args.join(' '), outcome: 'unknown' })
    }
    if (!json) return stdout.trim()
    let body
    try { body = parseJsonStrict(stdout) } catch { throw failure('INVALID_RESPONSE', 'The installed CLI did not return one JSON result', { requestId }) }
    if (body.requestId !== requestId) throw failure('INVALID_RESPONSE', 'The installed CLI returned a different requestId', { requestId })
    if (!body.ok) throw failure(body.error?.code ?? 'CLI_FAILED', body.error?.message ?? 'The installed CLI rejected verification', { requestId, ...body.error?.details })
    return body
  }
  try {
    const info = parseJsonStrict(await readFile(path.join(root, 'build/build-info.json'), 'utf8'))
    const installed = parseJsonStrict(await readFile(path.join(root, 'package.json'), 'utf8'))
    const build = parsePackageBuild(info)
    if (info.schemaVersion !== 1 || build?.packageVersion !== installed.version || build.runtimeHash === null || typeof info.lockHash !== 'string' || !/^[a-f0-9]{64}$/.test(info.lockHash) || typeof info.node !== 'string' || !/^v24\.\d+\.\d+$/.test(info.node)) throw failure('BUILD_INFO_INVALID', 'Installed build provenance is missing or incompatible')
    if (await runtimeFingerprint() !== info.runtimeHash) throw failure('RUNTIME_HASH_MISMATCH', 'Installed runtime files differ from their build fingerprint')
    if (options.expectedCommit && (info.sourceCommit !== options.expectedCommit || info.sourceDirty !== false)) throw failure('BUILD_SOURCE_MISMATCH', 'The installed build does not match the expected clean Git source', { expectedCommit: options.expectedCommit, actualCommit: info.sourceCommit, sourceDirty: info.sourceDirty })
    const version = await command(['--version'], undefined, false)
    if (version !== installed.version) throw failure('PACKAGE_VERSION_MISMATCH', 'The installed command and package versions differ')
    await command(['--help'], undefined, false)
    report.build = { schemaVersion: 1, ...build, lockHash: info.lockHash, node: info.node }
    report.checks.push('package', 'runtime-fingerprint', 'version', 'help')
    let baseline
    if (options.handoffBefore) {
      baseline = parseJsonStrict(await readFile(options.handoffBefore, 'utf8'))
      if (!baseline.ok || baseline.data?.kind !== 'handoff' || baseline.data.completeness !== 'complete' || !baseline.data.binding?.worktreeId) throw failure('INVALID_BASELINE', 'handoff-before must contain a successful complete task handoff')
    }
    report.stage = 'service'
    progress('checking service readiness')
    const startupRequestId = randomUUID()
    let service
    for (;;) {
      try { service = (await command(['serve', 'start'], startupRequestId)).data.result; break }
      catch (error) {
        // Starting/reusing the same singleton is safe. Unknown business requests
        // and failed archived reads are never automatically replayed here.
        if (error.code !== 'BUSY' || Date.now() >= deadline) throw error
        progress('service is still starting; waiting for the existing owner')
        await pause(Math.min(500, Math.max(1, deadline - Date.now())))
      }
    }
    const status = (await command(['serve', 'status'])).data.result
    const expectedBuild = { packageVersion: info.packageVersion, sourceCommit: info.sourceCommit, sourceDirty: info.sourceDirty, runtimeHash: info.runtimeHash }
    if (status.state !== 'running' || status.instanceId !== service.instanceId || !isDeepStrictEqual(status.build, expectedBuild)) throw failure('SERVICE_BUILD_MISMATCH', 'The running service does not match this installed build; stop the old service and verify again', { state: status.state, instanceId: status.instanceId })
    report.service = { state: status.state, instanceId: status.instanceId, build: status.build, recovery: status.diagnostic?.recovery ?? null }
    report.checks.push('service-ready', 'service-build')
    report.stage = 'rpc'
    progress('checking authenticated RPC')
    await command(['project', 'list'])
    report.checks.push('rpc')
    if (baseline) {
      report.stage = 'handoff'
      progress('checking archived task recovery')
      const restored = await command(['task', 'handoff', baseline.data.taskId, '--worktree', baseline.data.binding.worktreeId])
      if (restored.data?.kind !== 'handoff' || restored.data.completeness !== 'complete' || !isDeepStrictEqual(packet(restored.data), packet(baseline.data))) throw failure('HANDOFF_CHANGED', 'The archived packet, skill plan or binding differs from before the update')
      report.historyCheck = 'matched-before-update'
      report.handoff = { taskId: restored.data.taskId, worktreeId: restored.data.binding.worktreeId, contentHash: digest(packet(restored.data)), contexts: restored.data.packet.contexts.length, skills: restored.data.skillPlan?.skills.length ?? 0 }
      report.checks.push('archived-handoff')
    }
    report.ok = true
    report.stage = 'complete'
  } catch (error) {
    report.error = { code: error.code ?? 'VERIFICATION_FAILED', message: error.message, details: error.details ?? {} }
  }
  report.elapsedMs = Date.now() - started
  if (options.report) {
    const file = path.resolve(options.report), temporary = file + '.' + randomUUID() + '.tmp'
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', 'utf8')
    await rename(temporary, file)
  }
  return report
}

if (import.meta.main) {
  try {
    const options = {}, names = { '--data-dir': 'dataDir', '--expected-commit': 'expectedCommit', '--handoff-before': 'handoffBefore', '--report': 'report', '--timeout-ms': 'timeoutMs' }
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = names[process.argv[i]], value = process.argv[i + 1]
      if (!key || !value || Object.hasOwn(options, key)) throw failure('INVALID_ARGUMENT', 'Use --data-dir, --expected-commit, --handoff-before, --report or --timeout-ms with one value each')
      options[key] = key === 'timeoutMs' ? Number(value) : value
    }
    const report = await verifyInstallation(options)
    process.stdout.write(JSON.stringify(report) + '\n')
    if (!report.ok) process.exitCode = 1
  } catch (error) { process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: false, stage: 'arguments-or-report', error: { code: error.code ?? 'VERIFICATION_FAILED', message: error.message } }) + '\n'); process.exitCode = 1 }
}
