import { open, unlink, lstat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'
import path from 'node:path'
import { readJson, ensureDir, isErrno } from '../core/io.js'
import { digest } from '../core/json.js'
import { HarnessError } from '../core/errors.js'
import { PACKAGE_ROOT } from '../core/package.js'
import type { Envelope } from '../core/types.js'
import type { CommandRequest } from '../cli/args.js'

export interface ServiceDescriptor { schemaVersion: 1; protocolVersion: 1; pid: number; instanceId: string; startedAt: string; dataRootHash: string; url: string; token: string }
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
export async function healthy(dataRoot: string, record: ServiceDescriptor): Promise<boolean> {
  if (!processAlive(record.pid)) return false
  try {
    const response = await fetch(record.url + '/health', { headers: { authorization: 'Bearer ' + record.token, 'x-harness-protocol': '1' }, signal: AbortSignal.timeout(1000) })
    if (!response.ok) return false
    const result = await response.json() as { instanceId?: string; pid?: number; dataRootHash?: string; protocolVersion?: number; state?: string }
    return result.instanceId === record.instanceId && result.pid === record.pid && result.dataRootHash === digest('data-root', dataRoot) && result.protocolVersion === 1 && result.state === 'running'
  } catch { return false }
}
export async function serviceStatus(dataRoot: string): Promise<ServiceDescriptor | null> {
  const record = await descriptor(dataRoot)
  if (!record) return null
  if (await healthy(dataRoot, record)) return record
  if (!processAlive(record.pid)) return null
  throw new HarnessError('SERVICE_CONFLICT', 'The recorded live process failed its authenticated service identity check', { pid: record.pid })
}
export async function ensureService(dataRoot: string, port = 0, signal?: AbortSignal): Promise<ServiceDescriptor> {
  const current = await serviceStatus(dataRoot)
  if (current) {
    if (port && Number(new URL(current.url).port) !== port) throw new HarnessError('SERVICE_CONFLICT', 'This data root already has a service on a different port')
    return current
  }
  await ensureDir(dataRoot)
  await validateServiceFile(path.join(dataRoot, 'service.log'))
  const log = await open(path.join(dataRoot, 'service.log'), 'a', 0o600)
  let child: ReturnType<typeof spawn>
  try {
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
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new HarnessError('CANCELLED', 'The CLI request was cancelled; check the service state before retrying')
    const record = await descriptor(dataRoot)
    if (record && await healthy(dataRoot, record)) {
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
  throw new HarnessError('BUSY', 'The service did not become ready within the startup deadline', { log: path.join(dataRoot, 'service.log') }, true)
}
export async function rpc(record: ServiceDescriptor, request: CommandRequest, signal?: AbortSignal): Promise<Envelope> {
  let response: Response
  try { response = await fetch(record.url + '/rpc', { method: 'POST', headers: { authorization: 'Bearer ' + record.token, 'x-harness-protocol': '1', 'content-type': 'application/json' }, body: JSON.stringify(request), signal }) }
  catch { throw new HarnessError(signal?.aborted ? 'CANCELLED' : 'IO_ERROR', 'The local service connection was interrupted; committed requests are not cancelled', { requestId: request.requestId }, true) }
  if (!response.ok) throw new HarnessError(response.status === 409 ? 'VERSION_CONFLICT' : 'SERVICE_CONFLICT', 'The local service rejected the connection')
  return response.json() as Promise<Envelope>
}
export async function stopService(dataRoot: string): Promise<void> {
  const record = await serviceStatus(dataRoot)
  if (!record) return
  const response = await fetch(record.url + '/stop', { method: 'POST', headers: { authorization: 'Bearer ' + record.token, 'x-harness-protocol': '1' } })
  if (!response.ok) throw new HarnessError('SERVICE_CONFLICT', 'The authenticated service could not be stopped')
  for (let attempt = 0; attempt < 200; attempt++) {
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
