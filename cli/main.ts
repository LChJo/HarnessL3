import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { parseArgs, flag, validateUuid, type CommandRequest } from './args.js'
import { renderHelp } from './help.js'
import { canonicalJson, parseJsonStrict } from '../core/json.js'
import { HarnessError, asHarnessError } from '../core/errors.js'
import { resolveDataRoot } from '../core/environment.js'
import { PACKAGE_VERSION } from '../core/package.js'
import { validateContract } from '../core/contract.js'
import { ensureService, serviceStatus, inspectService, stopService, executeRpc, type ServiceDescriptor } from '../service/controller.js'
import type { Envelope } from '../core/types.js'

const serviceLifetime = { scope: 'user-data-root', lifetime: 'until-stopped' } as const
function serviceResult(operation: string, record: ServiceDescriptor | null) {
  return { kind: 'command-result', status: 'complete', operation, result: { state: record ? 'running' : 'stopped', url: record?.url ?? null, instanceId: record?.instanceId ?? null, protocolVersion: 1, startedAt: record?.startedAt ?? null, build: record?.build ?? null, ...serviceLifetime } }
}
function success(request: CommandRequest, data: unknown): Envelope { return { schemaVersion: 1, requestId: request.requestId, target: null, replayed: false, ok: true, data } }
function output(response: Envelope, jsonMode: boolean): void {
  validateContract('response', response)
  if (jsonMode) process.stdout.write(canonicalJson(response) + '\n')
  else if (!response.ok) process.stderr.write(`${response.error.code}: ${response.error.message}\n${Object.keys(response.error.details).length ? JSON.stringify(response.error.details, null, 2) + '\n' : ''}`)
  else {
    const data = response.data as Record<string, unknown>
    const display = { ...data }
    if (typeof data.routingPrompt === 'string') { process.stdout.write(data.routingPrompt + '\n'); delete display.routingPrompt }
    process.stdout.write(JSON.stringify(display, null, 2) + '\n')
  }
  const legacyRead = response.ok && (response.data as { kind?: string }).kind === 'legacy-archive' ? (response.data as { record?: { legacyRead?: { files: unknown[]; errors: unknown[] } } }).record?.legacyRead : undefined
  process.exitCode = response.ok ? ((typeof response.data === 'object' && response.data !== null && 'status' in response.data && response.data.status === 'partial') || (legacyRead?.files.length && legacyRead.errors.length) ? 4 : 0)
    : new HarnessError(response.error.code, response.error.message).exitCode
}
async function loadInput(request: CommandRequest, signal: AbortSignal): Promise<void> {
  const file = flag(request, 'file')
  if (!file) {
    const list = (name: string) => flag(request, name)?.split(',') ?? []
    const base = { schemaVersion: 1, requestId: request.requestId }
    if (request.operation === 'task select') request.input = { ...base, context: { expand: list('expand'), read: list('read'), known: {} }, skills: list('skill').map(id => ({ id, reason: flag(request, 'reason')! })), ...(request.flags.stage ? { stage: true } : {}) }
    else if (request.operation === 'context query') request.input = { ...base, expand: list('expand'), read: list('read'), known: {} }
    else if (request.operation === 'task read') request.input = { ...base, files: list('skill').map(skillId => ({ skillId, path: flag(request, 'path') ?? 'SKILL.md' })) }
    else return
    validateContract(request.operation === 'task select' ? 'selection-input' : request.operation === 'context query' ? 'query-input' : 'file-read', request.input)
    return
  }
  let bytes: Buffer
  if (file === '-') {
    const chunks: Buffer[] = []
    let count = 0
    for await (const chunk of process.stdin) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); count += buffer.length; if (count > 32 * 1024 * 1024) throw new HarnessError('INVALID_ARGUMENT', 'Input exceeds 32 MiB'); chunks.push(buffer) }
    bytes = Buffer.concat(chunks)
  } else bytes = await readFile(path.resolve(request.cwd, file), { signal })
  if (signal.aborted) throw new HarnessError('CANCELLED', 'CLI input was cancelled')
  let value: unknown
  try { value = parseJsonStrict(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) }
  catch (error) { if (error instanceof HarnessError) throw error; throw new HarnessError('INVALID_JSON', 'Request file is not valid UTF-8 JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HarnessError('INVALID_JSON', 'A request file must contain a JSON object')
  const input = value as Record<string, unknown>
  if (input.requestId !== undefined) {
    if (typeof input.requestId !== 'string') throw new HarnessError('INVALID_ARGUMENT', 'requestId must be a UUID')
    validateUuid(input.requestId, 'requestId')
    if (flag(request, 'request-id') && request.requestId !== input.requestId) throw new HarnessError('INVALID_ARGUMENT', 'The requestId flag and JSON requestId differ')
    request.requestId = input.requestId
  } else input.requestId = request.requestId
  if (request.flags.stage) {
    if (input.stage === false) throw new HarnessError('INVALID_ARGUMENT', '--stage conflicts with stage:false in the request')
    input.stage = true
  }
  const schema = request.operation === 'task select' ? 'selection-input' : request.operation === 'task read' ? 'file-read' : request.operation === 'sync verify' ? 'sync-proof' : 'query-input'
  request.input = validateContract(schema, input)
}
async function openBrowser(url: string, signal: AbortSignal): Promise<void> {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: 'ignore', detached: true, signal })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('The browser launcher failed')))
  })
}
export async function runCli(args: string[]): Promise<void> {
  const jsonMode = args.some(argument => argument === '--json' || argument.startsWith('--json='))
  let request: CommandRequest | undefined
  let alreadyPrinted = false
  let deadline: ReturnType<typeof setTimeout> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let dispatched = false
  const cancellation = new AbortController()
  const cancel = () => { if (!alreadyPrinted) { cancellation.abort(); if (request && flag(request, 'file') === '-') process.stdin.destroy() } }
  process.once('SIGINT', cancel)
  try {
    request = parseArgs(args)
    if (request.operation === 'help') { process.stdout.write(renderHelp(request.positionals)); return }
    if (request.operation === 'version') { process.stdout.write(PACKAGE_VERSION + '\n'); return }
    const timeoutMs = Number(flag(request, 'timeout-ms') ?? 120_000)
    deadline = setTimeout(() => {
      cancellation.abort(new HarnessError('REQUEST_TIMEOUT', 'The CLI wait budget was exhausted; accepted server work may still complete', {
        requestId: request!.requestId, operation: request!.operation, timeoutMs,
        outcome: dispatched ? 'unknown' : 'not-executed', nextAction: dispatched ? 'query-request' : 'retry-same-request',
        command: ['harnessl3', 'request', 'status', request!.requestId],
      }))
      if (flag(request!, 'file') === '-') process.stdin.destroy()
    }, timeoutMs)
    deadline.unref()
    const dataRoot = await resolveDataRoot(flag(request, 'data-dir'))
    if (process.env.HARNESS_SKILLS_ROOT) {
      if (!path.isAbsolute(process.env.HARNESS_SKILLS_ROOT)) throw new HarnessError('INVALID_ARGUMENT', 'HARNESS_SKILLS_ROOT must be absolute')
      request.skillsRoot = process.env.HARNESS_SKILLS_ROOT
    }
    await loadInput(request, cancellation.signal)
    if (cancellation.signal.aborted) throw new HarnessError('CANCELLED', 'CLI request cancelled before dispatch')
    let latestProgress: Record<string, unknown> = { phase: 'connecting' }, lastProgress = '', lastProgressAt = 0
    const progress = (state: Record<string, unknown>) => {
      if (state.phase === 'dispatching') dispatched = true
      if (request!.flags['quiet-progress'] || alreadyPrinted) return
      latestProgress = state
      const serialized = canonicalJson(state)
      if (serialized === lastProgress && Date.now() - lastProgressAt < 5000) return
      lastProgress = serialized; lastProgressAt = Date.now()
      process.stderr.write(jsonMode ? canonicalJson({ kind: 'progress', requestId: request!.requestId, operation: request!.operation, ...state }) + '\n'
        : `HarnessL3 ${request!.requestId}: ${String(state.phase)}\n`)
    }
    progress({ phase: 'connecting' })
    heartbeat = setInterval(() => progress(latestProgress), 5_000)
    heartbeat.unref()
    let response: Envelope
    if (request.operation === 'serve status') {
      const inspected = await inspectService(dataRoot, cancellation.signal)
      const data = serviceResult(request.operation, inspected.record)
      response = success(request, { ...data, result: { ...data.result, state: inspected.state, ...(inspected.diagnostic ? { diagnostic: inspected.diagnostic } : {}) } })
    }
    else if (request.operation === 'serve stop') { await stopService(dataRoot, cancellation.signal); response = success(request, serviceResult(request.operation, null)) }
    else if (request.operation === 'serve start' && request.flags.foreground) {
      if (await serviceStatus(dataRoot)) throw new HarnessError('SERVICE_CONFLICT', 'A service is already running; use serve status or stop it before foreground mode')
      const { startServer } = await import('../service/main.js')
      if (cancellation.signal.aborted) throw new HarnessError('CANCELLED', 'Service startup cancelled before readiness')
      await startServer(dataRoot, Number(flag(request, 'port') ?? 0), record => { clearTimeout(deadline); clearInterval(heartbeat); output(success(request!, serviceResult('serve start', record)), jsonMode); alreadyPrinted = true })
      return
    } else {
      let record: ServiceDescriptor
      if (request.operation === 'serve start') {
        record = await ensureService(dataRoot, Number(flag(request, 'port') ?? 0), cancellation.signal)
        response = success(request, serviceResult(request.operation, record))
      } else {
        const connected = await executeRpc(dataRoot, request, cancellation.signal, progress)
        record = connected.record; response = connected.response
      }
      if (request.operation === 'web open' && response.ok) {
        const session = await fetch(record.url + '/browser-session', { method: 'POST', headers: { authorization: 'Bearer ' + record.token, 'x-harness-protocol': '1' }, signal: cancellation.signal })
        if (!session.ok) throw new HarnessError('SERVICE_CONFLICT', 'Could not create a local browser session')
        const { code, expiresAt, browserSessionTtlMs } = await session.json() as { code: string; expiresAt: string; browserSessionTtlMs: number }
        if (typeof expiresAt !== 'string' || typeof browserSessionTtlMs !== 'number') throw new HarnessError('SERVICE_CONFLICT', 'Restart the local service to refresh Web sign-in metadata')
        const parameters = new URLSearchParams({ code })
        if (response.target) parameters.set('worktree', response.target.worktreeId)
        if (flag(request, 'task')) parameters.set('task', flag(request, 'task')!)
        const url = record.url + '/#' + parameters
        const opened = !request.flags['no-open']
        if (opened) {
          try { await openBrowser(url, cancellation.signal) } catch { throw new HarnessError('BROWSER_OPEN_FAILED', 'Could not open a browser; copy the URL from details', { url }) }
        }
        response.data = { kind: 'command-result', status: 'complete', operation: 'web open', result: { url, opened,
          service: { instanceId: record.instanceId, ...serviceLifetime },
          login: { oneTime: true, expiresAt, browserSessionTtlMs },
        } }
      }
    }
    output(response, jsonMode)
  } catch (error) {
    const failure = cancellation.signal.aborted && !alreadyPrinted
      ? cancellation.signal.reason instanceof HarnessError ? cancellation.signal.reason
        : new HarnessError('CANCELLED', 'The CLI request was cancelled; committed work is retained', request ? { requestId: request.requestId, outcome: dispatched ? 'unknown' : 'not-executed', nextAction: dispatched ? 'query-request' : 'retry-same-request' } : {})
      : asHarnessError(error)
    if (alreadyPrinted) { process.stderr.write(failure.code + ': ' + failure.message + '\n'); process.exitCode = failure.exitCode; return }
    output({ schemaVersion: 1, requestId: request?.requestId ?? randomUUID(), target: null, replayed: false, ok: false, error: { code: failure.code, message: failure.message, retryable: failure.retryable, details: failure.details } }, jsonMode)
  } finally { clearTimeout(deadline); clearInterval(heartbeat); process.removeListener('SIGINT', cancel) }
}
