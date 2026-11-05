import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { parseArgs, flag, validateUuid, type CommandRequest } from './args.js'
import { canonicalJson, parseJsonStrict } from '../core/json.js'
import { HarnessError, asHarnessError } from '../core/errors.js'
import { resolveDataRoot } from '../core/environment.js'
import { PACKAGE_VERSION } from '../core/package.js'
import { validateContract } from '../core/contract.js'
import { descriptor, ensureService, serviceStatus, stopService, rpc, type ServiceDescriptor } from '../service/controller.js'
import type { Envelope } from '../core/types.js'

const help = `HarnessL3 ${PACKAGE_VERSION}
Usage: harnessl3 <command> [arguments] [--json]

  init [--name <name>]
  project register|list|show|unregister
  worktree register|list|show|unregister
  task start --title <purpose>
  task prompt|select|show|list|handoff|read|close
  context query <task-id> --file <query.json|->
  history list|show
  skills list|refresh
  agent bind|unbind|status
  sync status|verify
  model validate
  serve start|status|stop
  web open [--task <task-id>]
  gc [--dry-run|--apply]
  migrate prototype --from <directory> --worktree <UUID> [--dry-run|--apply]

Global: --project <UUID> --worktree <UUID> --data-dir <absolute-path> --request-id <UUID>
The current agent calls HarnessL3. It does not start agents, run skills, or install Hooks.
`
function serviceResult(operation: string, record: ServiceDescriptor | null) {
  return { kind: 'command-result', status: 'complete', operation, result: { state: record ? 'running' : 'stopped', url: record?.url ?? null, instanceId: record?.instanceId ?? null, protocolVersion: 1 } }
}
function success(request: CommandRequest, data: unknown): Envelope { return { schemaVersion: 1, requestId: request.requestId, target: null, replayed: false, ok: true, data } }
function output(response: Envelope, jsonMode: boolean): void {
  validateContract('response', response)
  if (jsonMode) process.stdout.write(canonicalJson(response) + '\n')
  else if (!response.ok) process.stderr.write(`${response.error.code}: ${response.error.message}\n${Object.keys(response.error.details).length ? JSON.stringify(response.error.details, null, 2) + '\n' : ''}`)
  else {
    const data = response.data as Record<string, unknown>
    if (typeof data.routingPrompt === 'string') process.stdout.write(data.routingPrompt + '\n')
    process.stdout.write(JSON.stringify(data, null, 2) + '\n')
  }
  const legacyRead = response.ok && (response.data as { kind?: string }).kind === 'legacy-archive' ? (response.data as { record?: { legacyRead?: { files: unknown[]; errors: unknown[] } } }).record?.legacyRead : undefined
  process.exitCode = response.ok ? ((typeof response.data === 'object' && response.data !== null && 'status' in response.data && response.data.status === 'partial') || (legacyRead?.files.length && legacyRead.errors.length) ? 4 : 0)
    : new HarnessError(response.error.code, response.error.message).exitCode
}
async function loadInput(request: CommandRequest, signal: AbortSignal): Promise<void> {
  const file = flag(request, 'file')
  if (!file) return
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
  const schema = request.operation === 'task select' ? 'selection' : request.operation === 'task read' ? 'file-read' : request.operation === 'sync verify' ? 'sync-proof' : 'query'
  request.input = validateContract(schema, input)
}
async function openBrowser(url: string): Promise<void> {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: 'ignore', detached: true })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('The browser launcher failed')))
  })
}
export async function runCli(args: string[]): Promise<void> {
  const jsonMode = args.some(argument => argument === '--json' || argument.startsWith('--json='))
  let request: CommandRequest | undefined
  let alreadyPrinted = false
  const cancellation = new AbortController()
  const cancel = () => { if (!alreadyPrinted) { cancellation.abort(); if (request && flag(request, 'file') === '-') process.stdin.destroy() } }
  process.once('SIGINT', cancel)
  try {
    request = parseArgs(args)
    if (request.operation === 'help') { process.stdout.write(help); return }
    if (request.operation === 'version') { process.stdout.write(PACKAGE_VERSION + '\n'); return }
    const dataRoot = await resolveDataRoot(flag(request, 'data-dir'))
    if (process.env.HARNESS_SKILLS_ROOT) {
      if (!path.isAbsolute(process.env.HARNESS_SKILLS_ROOT)) throw new HarnessError('INVALID_ARGUMENT', 'HARNESS_SKILLS_ROOT must be absolute')
      request.skillsRoot = process.env.HARNESS_SKILLS_ROOT
    }
    await loadInput(request, cancellation.signal)
    if (cancellation.signal.aborted) throw new HarnessError('CANCELLED', 'CLI request cancelled before dispatch')
    let response: Envelope
    if (request.operation === 'serve status') response = success(request, serviceResult(request.operation, await serviceStatus(dataRoot)))
    else if (request.operation === 'serve stop') { await stopService(dataRoot); response = success(request, serviceResult(request.operation, null)) }
    else if (request.operation === 'serve start' && request.flags.foreground) {
      if (await serviceStatus(dataRoot)) throw new HarnessError('SERVICE_CONFLICT', 'A service is already running; use serve status or stop it before foreground mode')
      const { startServer } = await import('../service/main.js')
      if (cancellation.signal.aborted) throw new HarnessError('CANCELLED', 'Service startup cancelled before readiness')
      await startServer(dataRoot, Number(flag(request, 'port') ?? 0), record => { output(success(request!, serviceResult('serve start', record)), jsonMode); alreadyPrinted = true })
      return
    } else {
      const record = await ensureService(dataRoot, request.operation === 'serve start' ? Number(flag(request, 'port') ?? 0) : 0, cancellation.signal)
      response = request.operation === 'serve start' ? success(request, serviceResult(request.operation, record)) : await rpc(record, request, cancellation.signal)
      if (request.operation === 'web open' && response.ok) {
        const session = await fetch(record.url + '/browser-session', { method: 'POST', headers: { authorization: 'Bearer ' + record.token, 'x-harness-protocol': '1' } })
        if (!session.ok) throw new HarnessError('SERVICE_CONFLICT', 'Could not create a local browser session')
        const { code } = await session.json() as { code: string }
        const parameters = new URLSearchParams({ code })
        if (response.target) parameters.set('worktree', response.target.worktreeId)
        if (flag(request, 'task')) parameters.set('task', flag(request, 'task')!)
        const url = record.url + '/#' + parameters
        try { await openBrowser(url) } catch { throw new HarnessError('BROWSER_OPEN_FAILED', 'Could not open a browser; copy the URL from details', { url }) }
        response.data = { kind: 'command-result', status: 'complete', operation: 'web open', result: { url, opened: true } }
      }
    }
    output(response, jsonMode)
  } catch (error) {
    const failure = cancellation.signal.aborted && !alreadyPrinted ? new HarnessError('CANCELLED', 'The CLI request was cancelled; committed work is retained', request ? { requestId: request.requestId } : {}) : asHarnessError(error)
    if (alreadyPrinted) { process.stderr.write(failure.code + ': ' + failure.message + '\n'); process.exitCode = failure.exitCode; return }
    output({ schemaVersion: 1, requestId: request?.requestId ?? randomUUID(), target: null, replayed: false, ok: false, error: { code: failure.code, message: failure.message, retryable: failure.retryable, details: failure.details } }, jsonMode)
  } finally { process.removeListener('SIGINT', cancel) }
}
