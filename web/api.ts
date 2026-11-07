import type { Envelope } from '../core/types'
import type { Rpc, ViewData } from './types'

export class ApiError extends Error {
  readonly code: string
  readonly details: Record<string, unknown>
  constructor(code: string, message: string, details: Record<string, unknown> = {}) { super(`${code}: ${message}`); this.code = code; this.details = details }
}
async function json(response: Response): Promise<unknown> {
  if (response.status === 401) throw new ApiError('AUTH_REQUIRED', '访问凭证已失效，请让当前 agent 重新生成访问链接。')
  let value: unknown
  try { value = await response.json() } catch { throw new ApiError('CONNECTION_ERROR', `本机服务返回无效数据（HTTP ${response.status}）`) }
  if (!response.ok) {
    const record = value as { error?: { code?: string; message?: string; details?: Record<string, unknown> } | string; code?: string; message?: string }
    const error = typeof record.error === 'object' ? record.error : record
    throw new ApiError(error.code ?? 'CONNECTION_ERROR', error.message ?? `本机服务不可用（HTTP ${response.status}）`, 'details' in error ? error.details as Record<string, unknown> : {})
  }
  return value
}
export async function session(): Promise<{ worktree?: string; task?: string; batch?: string }> {
  const url = new URL(location.href)
  const hash = new URLSearchParams(url.hash.slice(1))
  const code = hash.get('code')
  for (const name of ['worktree', 'task', 'batch']) if (hash.get(name)) url.searchParams.set(name, hash.get(name)!)
  url.hash = ''
  history.replaceState(null, '', url.pathname + url.search)
  if (code) await json(await fetch('/session', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Harness-Web': '1' }, body: JSON.stringify({ code }) }))
  return Object.fromEntries(['worktree', 'task', 'batch'].filter(name => url.searchParams.has(name)).map(name => [name, url.searchParams.get(name)!]))
}
export const rpc: Rpc = async (operation, options = {}) => {
  const supplied = options.input && typeof options.input === 'object' ? (options.input as { requestId?: string }).requestId : undefined
  const requestId = options.requestId ?? supplied ?? crypto.randomUUID()
  const flags = { ...(options.worktree ? { worktree: options.worktree } : {}), ...options.flags }
  if (options.input !== undefined && !('file' in flags)) Object.assign(flags, { file: '-' })
  const request = { operation, positionals: options.id ? [options.id] : [], flags, requestId, ...(options.input !== undefined ? { input: options.input } : {}) }
  const result = await json(await fetch('/rpc', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Harness-Web': '1' }, body: JSON.stringify(request) })) as Envelope
  if (!result.ok) throw new ApiError(result.error.code, result.error.message, result.error.details)
  return result.data as never
}
export async function view(worktree: string, task?: string, batch?: string, signal?: AbortSignal): Promise<ViewData> {
  const query = new URLSearchParams({ worktree })
  if (task) query.set('task', task)
  if (batch) query.set('batch', batch)
  return await json(await fetch('/view?' + query, { credentials: 'same-origin', signal })) as ViewData
}
