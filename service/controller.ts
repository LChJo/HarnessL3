import { open, unlink, lstat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'
import path from 'node:path'
import { readJson, ensureDir, isErrno } from '../core/io.js'
import { digest } from '../core/json.js'
import { HarnessError } from '../core/errors.js'
import { PACKAGE_ROOT } from '../core/package.js'
import { validateContract } from '../core/contract.js'
import type { Envelope } from '../core/types.js'
import type { CommandRequest } from '../cli/args.js'

export interface ServiceDescriptor { schemaVersion: 1; protocolVersion: 1; pid: number; instanceId: string; startedAt: string; dataRootHash: string; url: string; token: string }
function serviceHeaders(record: ServiceDescriptor): Record<string, string> {
  return { authorization: 'Bearer ' + record.token, 'x-harness-protocol': '1', 'x-harness-instance': record.instanceId, 'x-harness-data-root': record.dataRootHash }
}
export async function validateServiceFile(file: string): Promise<void> {
  try { const entry = await lstat(file); if (!entry.isFile() || entry.isSymbolicLink()) throw new HarnessError('SERVICE_CONFLICT', 'A service metadata path is not a regular private file', { file }) }
  catch (error) { if (!isErrno(error, 'ENOENT')) throw error }
}
export function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true } catch (error) { return !isErrno(error, 'ESRCH') && !isErrno(error, 'EINVAL') } }
export async function descriptor(dataRoot: string): Promise<ServiceDescriptor | null> {
  await validateServiceFile(path.join(dataRoot, 'service.json'))
  let value: ServiceDescriptor
  try { value = await readJson<ServiceDescriptor>(path.join(dataRoot, 'service.json')) } catch (error) { if (isErrno(error, 'ENOENT')) return null; throw new HarnessError('SERVICE_CONFLICT', 'The service descriptor is unreadable; no unknown process will be contacted') }
  if (value.schemaVersion !== 1 || value.protocolVersion !== 1 || !Number.isInteger(value.pid) || value.pid <= 0 || typeof value.instanceId !== 'string' || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(value.url) || value.dataRootHash !== digest('data-root', dataRoot)) throw new HarnessError('SERVICE_CONFLICT', 'The service descriptor has an incompatible identity')
  return value
}
export interface ServiceProbe {
  state: 'running' | 'draining' | 'unavailable' | 'conflict'
  reason?: string
  httpStatus?: number
  systemCode?: string
}
export interface ServiceInspection { record: ServiceDescriptor | null; state: ServiceProbe['state'] | 'stopped'; diagnostic?: ServiceProbe }
function systemCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = error as { code?: unknown; cause?: unknown }
  return typeof value.code === 'string' ? value.code : systemCode(value.cause)
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new HarnessError('CANCELLED', 'The CLI request was cancelled; committed requests are retained', {}, true)
}
async function pause(signal?: AbortSignal): Promise<void> {
  cancelled(signal)
  try { await setTimeout(150, undefined, { signal }) } catch { cancelled(signal) }
}
function sameService(left: ServiceDescriptor, right: ServiceDescriptor): boolean {
  return left.instanceId === right.instanceId && left.url === right.url && left.token === right.token && left.dataRootHash === right.dataRootHash
}
export async function probeService(dataRoot: string, record: ServiceDescriptor, signal?: AbortSignal): Promise<ServiceProbe> {
  cancelled(signal)
  try {
    const timeout = AbortSignal.timeout(2000)
    const response = await fetch(record.url + '/health', { headers: serviceHeaders(record), signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    if (!response.ok) {
      await response.body?.cancel()
      return { state: [401, 403, 409].includes(response.status) ? 'conflict' : 'unavailable', reason: response.status === 409 ? 'protocol-or-identity-mismatch' : [401, 403].includes(response.status) ? 'authentication-rejected' : 'http-unavailable', httpStatus: response.status }
    }
    const result = await response.json() as { instanceId?: string; pid?: number; dataRootHash?: string; protocolVersion?: number; state?: string }
    if (result.protocolVersion !== 1) return { state: 'conflict', reason: 'protocol-mismatch' }
    if (result.instanceId !== record.instanceId || result.dataRootHash !== digest('data-root', dataRoot)) return { state: 'conflict', reason: 'identity-mismatch' }
    if (result.state === 'running' || result.state === 'draining') return { state: result.state }
    return { state: 'unavailable', reason: 'not-ready' }
  } catch (error) {
    cancelled(signal)
    const code = systemCode(error)
    return { state: 'unavailable', reason: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : error instanceof SyntaxError ? 'invalid-health-response' : code === 'ECONNREFUSED' ? 'connection-refused' : 'connection-error', ...(code ? { systemCode: code } : {}) }
  }
}
export async function healthy(dataRoot: string, record: ServiceDescriptor): Promise<boolean> {
  return (await probeService(dataRoot, record)).state === 'running'
}
export async function inspectService(dataRoot: string, signal?: AbortSignal): Promise<ServiceInspection> {
  let record = await descriptor(dataRoot)
  if (!record) return { record: null, state: 'stopped' }
  let diagnostic: ServiceProbe = { state: 'unavailable', reason: 'not-ready' }
  for (let attempt = 0; attempt < 3; attempt++) {
    diagnostic = await probeService(dataRoot, record, signal)
    if (diagnostic.state === 'running') return { record, state: 'running' }
    const current = await descriptor(dataRoot)
    if (!current) return { record: null, state: 'stopped' }
    if (!sameService(current, record)) { record = current; diagnostic = { state: 'unavailable', reason: 'descriptor-changed' }; continue }
    if (diagnostic.state === 'conflict') break
    // PID is a recovery hint, never a prerequisite for contacting the endpoint.
    if (diagnostic.reason === 'connection-refused' && !processAlive(record.pid)) return { record: null, state: 'stopped' }
    if (attempt < 2) await pause(signal)
  }
  return { record, state: diagnostic.state, diagnostic }
}
export async function serviceStatus(dataRoot: string, signal?: AbortSignal): Promise<ServiceDescriptor | null> {
  const inspected = await inspectService(dataRoot, signal)
  if (inspected.state === 'stopped' || inspected.state === 'running') return inspected.record
  const conflict = inspected.state === 'conflict'
  throw new HarnessError(conflict ? 'SERVICE_CONFLICT' : 'BUSY', conflict ? 'The local service returned an incompatible identity or protocol' : 'The local service is temporarily unavailable; retry this command', { pid: inspected.record?.pid, ...inspected.diagnostic }, !conflict)
}
export async function ensureService(dataRoot: string, port = 0, signal?: AbortSignal): Promise<ServiceDescriptor> {
  cancelled(signal)
  const current = await serviceStatus(dataRoot, signal)
  if (current) {
    if (port && Number(new URL(current.url).port) !== port) throw new HarnessError('SERVICE_CONFLICT', 'This data root already has a service on a different port')
    return current
  }
  await ensureDir(dataRoot)
  await validateServiceFile(path.join(dataRoot, 'service.log'))
  const log = await open(path.join(dataRoot, 'service.log'), 'a', 0o600)
  let child: ReturnType<typeof spawn>
  try {
    cancelled(signal)
    child = spawn(process.execPath, [path.join(PACKAGE_ROOT, 'build/service/main.js'), '--data-dir', dataRoot, '--port', String(port)], {
      detached: true, windowsHide: true, stdio: ['ignore', 'ignore', log.fd],
    })
    child.unref()
  } finally { await log.close() }
  let exited: number | null = null
  let failure: Error | null = null
  child.once('exit', code => { exited = code ?? 1 })
  child.once('error', error => { failure = error })
  const deadline = Date.now() + 20_000
  let lastProbe: ServiceProbe | undefined
  while (Date.now() < deadline) {
    cancelled(signal)
    const record = await descriptor(dataRoot)
    if (record) lastProbe = await probeService(dataRoot, record, signal)
    if (record && lastProbe?.state === 'running') {
      if (port && Number(new URL(record.url).port) !== port) throw new HarnessError('SERVICE_CONFLICT', 'Concurrent service startup selected another port')
      return record
    }
    if (failure) throw new HarnessError('IO_ERROR', 'Could not launch the local service')
    if (exited !== null && exited !== 0) {
      // Another process may own the startup lock; give its bounded initialization time to finish.
      const lock = await readJson<{ pid: number }>(path.join(dataRoot, 'service.lock')).catch(() => null)
      if (!lock || !processAlive(lock.pid)) throw new HarnessError('SERVICE_CONFLICT', 'Service startup failed; inspect the local service log', { log: path.join(dataRoot, 'service.log') })
    }
    await setTimeout(60)
  }
  throw new HarnessError('BUSY', 'The service did not become ready within the startup deadline', { log: path.join(dataRoot, 'service.log'), ...(lastProbe ? { diagnostic: lastProbe } : {}) }, true)
}
export async function rpc(record: ServiceDescriptor, request: CommandRequest, signal?: AbortSignal): Promise<Envelope> {
  cancelled(signal)
  let response: Response
  try { response = await fetch(record.url + '/rpc', { method: 'POST', headers: { ...serviceHeaders(record), 'content-type': 'application/json' }, body: JSON.stringify(request), signal }) }
  catch (error) {
    cancelled(signal)
    const code = systemCode(error), refused = code === 'ECONNREFUSED'
    throw new HarnessError(refused ? 'BUSY' : 'IO_ERROR', refused ? 'The local service is temporarily unreachable; retry this command' : 'The local service response was lost; check the request result before retrying', { requestId: request.requestId, reason: refused ? 'connection-refused' : 'response-lost', outcome: refused ? 'not-executed' : 'unknown', ...(code ? { systemCode: code } : {}) }, true)
  }
  if (!response.ok) {
    await response.body?.cancel()
    const temporary = response.status === 503
    const rejected = [401, 403, 409, 503].includes(response.status)
    const reason = temporary ? 'not-accepting-requests' : response.status === 409 ? 'protocol-or-identity-mismatch' : [401, 403].includes(response.status) ? 'authentication-rejected' : 'http-error'
    throw new HarnessError(temporary ? 'BUSY' : response.status === 409 ? 'VERSION_CONFLICT' : rejected ? 'SERVICE_CONFLICT' : 'IO_ERROR', temporary ? 'The local service is not accepting requests yet; retry this command' : rejected ? 'The local service rejected the request before execution' : 'The local service returned an unexpected HTTP error; check the request result before retrying', { requestId: request.requestId, httpStatus: response.status, reason, outcome: rejected ? 'not-executed' : 'unknown' }, temporary || !rejected)
  }
  try {
    const result = validateContract<Envelope>('response', await response.json())
    if (result.requestId !== request.requestId) throw new Error('Mismatched requestId')
    return result
  } catch {
    cancelled(signal)
    throw new HarnessError('IO_ERROR', 'The local service response is incomplete or invalid; check the request result before retrying', { requestId: request.requestId, reason: 'invalid-response', outcome: 'unknown' }, true)
  }
}
export async function executeRpc(dataRoot: string, request: CommandRequest, signal?: AbortSignal): Promise<{ record: ServiceDescriptor; response: Envelope }> {
  cancelled(signal)
  let record = await descriptor(dataRoot) ?? await ensureService(dataRoot, 0, signal)
  for (let attempt = 0; ; attempt++) {
    try { return { record, response: await rpc(record, request, signal) } }
    catch (error) {
      // Only failures known to precede execution may be automatically resent.
      // A lost response may follow a committed write, even on a healthy daemon.
      if (!(error instanceof HarnessError) || error.details.outcome !== 'not-executed' || attempt >= 2) throw error
      const current = await descriptor(dataRoot)
      if (current && !sameService(current, record)) { record = current; continue }
      if (!current || (error.details.reason === 'connection-refused' && !processAlive(record.pid))) {
        record = await ensureService(dataRoot, 0, signal); continue
      }
      if (!error.retryable) throw error
      await pause(signal)
    }
  }
}
export async function stopService(dataRoot: string, signal?: AbortSignal): Promise<void> {
  let record = await descriptor(dataRoot)
  if (!record) return
  for (let attempt = 0; ; attempt++) {
    cancelled(signal)
    let failure: HarnessError | undefined
    try {
      const timeout = AbortSignal.timeout(5000)
      const response = await fetch(record.url + '/stop', { method: 'POST', headers: serviceHeaders(record), signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
      await response.body?.cancel()
      if (response.ok) break
      const temporary = response.status === 503
      failure = new HarnessError(temporary ? 'BUSY' : 'SERVICE_CONFLICT', 'The local service could not accept the stop request', { httpStatus: response.status, reason: temporary ? 'not-accepting-requests' : 'request-rejected' }, temporary)
    } catch (error) {
      cancelled(signal)
      if (systemCode(error) === 'ECONNREFUSED' && !processAlive(record.pid)) return
      failure = new HarnessError('BUSY', 'The local service could not be reached for stopping; retry this command', { reason: systemCode(error) === 'ECONNREFUSED' ? 'connection-refused' : 'connection-error' }, true)
    }
    const current = await descriptor(dataRoot)
    if (!current) return
    if (attempt >= 2) throw failure
    if (!sameService(current, record)) { record = current; continue }
    if (!failure.retryable) throw failure
    await pause(signal)
  }
  for (let attempt = 0; attempt < 200; attempt++) {
    cancelled(signal)
    const current = await descriptor(dataRoot)
    if (!current || current.instanceId !== record.instanceId) return
    await setTimeout(25)
  }
  throw new HarnessError('BUSY', 'The service is still draining accepted requests', {}, true)
}
export async function removeOwnedFile(file: string, instanceId: string): Promise<void> {
  await validateServiceFile(file)
  const current = await readJson<{ instanceId?: string }>(file).catch(error => { if (isErrno(error, 'ENOENT')) return null; throw error })
  if (current?.instanceId === instanceId) await unlink(file)
}
