const argumentCodes = new Set(['INVALID_ARGUMENT', 'INVALID_JSON', 'SCHEMA_INVALID', 'UNSUPPORTED_SCHEMA'])
const conflictCodes = new Set(['TARGET_REQUIRED', 'TARGET_CONFLICT', 'PROJECT_ID_CONFLICT', 'WORKTREE_MOVED', 'VERSION_CONFLICT', 'SOURCE_CHANGED', 'CATALOG_CHANGED', 'REQUEST_ID_CONFLICT', 'SELECTION_EXISTS', 'SELECTION_UNKNOWN', 'TASK_CLOSED', 'TASK_EXPIRED', 'SYNC_RACE', 'SERVICE_CONFLICT', 'BUSY'])

export class HarnessError extends Error {
  readonly code: string
  readonly details: Record<string, unknown>
  readonly retryable: boolean
  readonly exitCode: number
  constructor(code: string, message: string, details: Record<string, unknown> = {}, retryable = false) {
    super(message)
    this.name = 'HarnessError'
    this.code = code
    this.details = details
    this.retryable = retryable
    this.exitCode = code === 'CANCELLED' ? 130 : argumentCodes.has(code) ? 2 : conflictCodes.has(code) ? 3 : 1
  }
}

export function asHarnessError(error: unknown): HarnessError {
  if (error instanceof HarnessError) return error
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : null
  return new HarnessError(code && ['ENOENT', 'EACCES', 'EPERM', 'EIO', 'ENOSPC'].includes(code) ? 'IO_ERROR' : 'INTERNAL_ERROR',
    error instanceof Error ? error.message : 'Unexpected internal failure', code ? { systemCode: code } : {})
}
