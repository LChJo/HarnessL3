import { AsyncLocalStorage } from 'node:async_hooks'
import { canonicalJson, digest } from './json.js'
import { HarnessError } from './errors.js'
import type { CommandRequest } from '../cli/args.js'
import type { Envelope, Target } from './types.js'

export interface Progress { phase: string; completed?: number; total?: number; target?: Target }
export interface RequestStatus {
  requestId: string; operation: string; state: 'running' | 'completed'; phase: string
  startedAt: string; updatedAt: string; target: Target | null; completed?: number; total?: number
}
const context = new AsyncLocalStorage<(progress: Progress) => void>()
export function reportProgress(progress: Progress): void { context.getStore()?.(progress) }
interface Tracked { status: RequestStatus; cwd: string; hash: string; promise?: Promise<Envelope>; response?: string }
const archivedOperation = (operation: string) => /^(?:task (?:start|select|read|close|prompt)|context query|sync verify|agent (?:bind|unbind))$/.test(operation)

/** Ephemeral progress and bounded response cache. Durable task receipts remain in their original journals. */
export class RequestTracker {
  private readonly entries = new Map<string, Tracked>()
  private responseBytes = 0
  constructor(private readonly maxCompleted = 128, private readonly maxResponseBytes = 4 * 1024 * 1024, private readonly maxRunning = 32) {}
  progress(id: string, cwd?: string): RequestStatus | null {
    const matches = [...this.entries.values()].filter(record => record.status.requestId === id && (cwd === undefined || record.cwd === cwd))
    return structuredClone(matches.length === 1 ? matches[0].status : null)
  }
  result(id: string, target: Target | null, cwd: string): { status: RequestStatus; receipt?: Envelope } | null {
    const matches = [...this.entries.values()].filter(record => record.status.requestId === id && (record.status.target ? target && record.status.target.worktreeId === target.worktreeId && record.status.target.projectId === target.projectId : record.cwd === cwd))
    if (matches.length !== 1) return null
    const record = matches[0]
    return { status: structuredClone(record.status), ...(record.response ? { receipt: JSON.parse(record.response) as Envelope } : {}) }
  }
  async run(request: CommandRequest, operation: () => Promise<Envelope>): Promise<Envelope> {
    const flags = Object.fromEntries(Object.entries(request.flags).filter(([key]) => !['json', 'request-id', 'data-dir', 'file', 'timeout-ms', 'quiet-progress'].includes(key)))
    const hash = digest('rpc-request', { operation: request.operation, positionals: request.positionals, flags, cwd: request.cwd, input: request.input ?? null, skillsRoot: request.skillsRoot ?? null, source: request.source ?? 'cli' })
    const key = request.requestId + '\0' + request.cwd
    const previous = this.entries.get(key)
    if (previous) {
      if (previous.hash !== hash) throw new HarnessError('REQUEST_ID_CONFLICT', 'This request ID is already associated with a different command')
      if (previous.promise) return { ...await previous.promise, replayed: true }
      if (previous.response && !archivedOperation(request.operation)) return { ...JSON.parse(previous.response) as Envelope, replayed: true }
      // Large task receipts can be replayed from their existing authoritative archive.
      if (!archivedOperation(request.operation)) throw new HarnessError('IO_ERROR', 'The earlier result is no longer in the transient response cache; inspect the request before repeating this operation', { requestId: request.requestId, outcome: 'unknown', nextAction: 'query-request' })
    }
    if ([...this.entries.values()].filter(entry => entry.status.state === 'running').length >= this.maxRunning) throw new HarnessError('BUSY', 'The service is at its concurrent request limit', { outcome: 'not-executed', nextAction: 'retry-same-request' }, true)
    const at = new Date().toISOString()
    const record: Tracked = { cwd: request.cwd, hash, status: { requestId: request.requestId, operation: request.operation, state: 'running', phase: 'accepted', startedAt: at, updatedAt: at, target: null } }
    this.responseBytes -= previous?.response ? Buffer.byteLength(previous.response) : 0
    this.entries.set(key, record)
    const promise = context.run(progress => {
      const { phase, completed, total, target } = progress
      record.status = { ...record.status, phase, updatedAt: new Date().toISOString(), ...(target ? { target } : {}) }
      delete record.status.completed; delete record.status.total
      if (completed !== undefined) record.status.completed = completed
      if (total !== undefined) record.status.total = total
    }, operation)
    record.promise = promise
    try {
      const response = await promise
      record.status = { ...record.status, state: 'completed', phase: response.ok ? 'completed' : 'failed', target: response.target ?? record.status.target, updatedAt: new Date().toISOString() }
      const bytes = canonicalJson(response)
      if (Buffer.byteLength(bytes) <= this.maxResponseBytes) { record.response = bytes; this.responseBytes += Buffer.byteLength(bytes) }
      return response
    } catch (error) {
      this.entries.delete(key)
      throw error
    } finally {
      delete record.promise
      let completed = [...this.entries.values()].filter(entry => entry.status.state === 'completed').length
      for (const [id, entry] of this.entries) {
        if (completed <= this.maxCompleted && this.responseBytes <= this.maxResponseBytes) break
        if (entry.status.state !== 'completed') continue
        this.responseBytes -= entry.response ? Buffer.byteLength(entry.response) : 0
        this.entries.delete(id); completed--
      }
    }
  }
}
