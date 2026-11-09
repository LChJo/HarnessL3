import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { Runtime } from '../core/runtime.js'
import { ensureDir, isErrno, readJson, writeJson } from '../core/io.js'
import { canonicalJson, digest, parseJsonStrict } from '../core/json.js'
import { asHarnessError, HarnessError } from '../core/errors.js'
import { resolveDataRoot } from '../core/environment.js'
import { PACKAGE_ROOT, PACKAGE_BUILD } from '../core/package.js'
import { validateRpcRequest } from '../cli/args.js'
import { processAlive, removeOwnedFile, validateServiceFile, type ServiceDescriptor } from './controller.js'
import { resolveInside, safeRelative } from '../core/paths.js'
import { validateUuid } from '../cli/args.js'

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 32 * 1024 * 1024) throw new HarnessError('INVALID_ARGUMENT', 'Request body exceeds 32 MiB')
    chunks.push(buffer)
  }
  try { return parseJsonStrict(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))) }
  catch (error) { if (error instanceof HarnessError) throw error; throw new HarnessError('INVALID_JSON', 'Request body is not valid UTF-8 JSON') }
}
function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  response.end(canonicalJson(value) + '\n')
}
function secureEqual(left: string, right: string): boolean { const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b) }

export async function startServer(dataRoot: string, port = 0, onReady?: (record: ServiceDescriptor) => void): Promise<void> {
  // Per-invocation client environments travel in authenticated requests, never in daemon defaults.
  delete process.env.HARNESS_SKILLS_ROOT
  await ensureDir(dataRoot)
  const instanceId = randomUUID(), lockFile = path.join(dataRoot, 'service.lock'), descriptorFile = path.join(dataRoot, 'service.json')
  const lock = { schemaVersion: 1, pid: process.pid, instanceId, startedAt: new Date().toISOString() }
  let acquired = false
  for (let attempt = 0; attempt < 2; attempt++) {
    await validateServiceFile(lockFile)
    try {
      const handle = await open(lockFile, 'wx', 0o600)
      try { await handle.writeFile(canonicalJson(lock) + '\n'); await handle.sync() } finally { await handle.close() }
      acquired = true; break
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error
      let owner: typeof lock
      try { owner = await readJson(lockFile) } catch { throw new HarnessError('SERVICE_CONFLICT', 'The existing startup lock has an unknown owner') }
      if (!Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.instanceId !== 'string') throw new HarnessError('SERVICE_CONFLICT', 'The startup lock identity is invalid')
      if (processAlive(owner.pid)) throw new HarnessError('BUSY', 'Another live process owns this service startup lock', {}, true)
      await removeOwnedFile(lockFile, owner.instanceId)
    }
  }
  if (!acquired) throw new HarnessError('BUSY', 'Could not acquire the service startup lock', {}, true)
  const runtime = new Runtime(dataRoot)
  const token = randomBytes(32).toString('hex')
  let record: ServiceDescriptor
  let draining = false, active = 0, cancelledBeforeReady = false
  const drainWaiters: (() => void)[] = []
  const browserCodes = new Map<string, number>(), sessions = new Map<string, number>()
  const loginCodeTtlMs = 5 * 60_000, browserSessionTtlMs = 12 * 3600_000
  const streams = new Set<ServerResponse>()
  const bearer = (request: IncomingMessage) => secureEqual(request.headers.authorization ?? '', 'Bearer ' + token)
  const browser = (request: IncomingMessage) => {
    const cookie = /(?:^|;\s*)harnessl3_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie ?? '')?.[1]
    return !!cookie && (sessions.get(cookie) ?? 0) >= Date.now()
  }
  let finish: (() => void) | undefined
  let rejectFinish: ((error: unknown) => void) | undefined
  const done = new Promise<void>((resolve, reject) => { finish = resolve; rejectFinish = reject })
  const shutdown = async () => {
    if (draining) return
    draining = true
    for (const stream of streams) stream.end()
    if (active) await new Promise<void>(resolve => drainWaiters.push(resolve))
    await runtime.close()
    server.closeIdleConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await removeOwnedFile(descriptorFile, instanceId)
    await removeOwnedFile(lockFile, instanceId)
    finish?.()
  }
  const server = createServer((request, response) => {
    void (async () => {
      if (!record) return json(response, { error: 'Starting' }, 503)
      const host = new URL(record.url).host
      if (request.headers.host !== host || (request.headers.origin && request.headers.origin !== record.url)) return json(response, { error: 'Forbidden origin or host' }, 403)
      const endpoint = new URL(request.url ?? '/', record.url)
      const auth = bearer(request), web = browser(request)
      if (request.headers['x-harness-protocol'] && request.headers['x-harness-protocol'] !== '1') return json(response, { error: 'Incompatible protocolVersion', protocolVersion: 1 }, 409)
      if ((request.headers['x-harness-instance'] && request.headers['x-harness-instance'] !== instanceId) || (request.headers['x-harness-data-root'] && request.headers['x-harness-data-root'] !== record.dataRootHash)) return json(response, { error: 'Incompatible service identity' }, 409)
      if (endpoint.pathname === '/health') {
        if (!auth) return json(response, { error: 'Unauthorized' }, 401)
        return json(response, { state: draining ? 'draining' : 'running', instanceId, pid: process.pid, dataRootHash: record.dataRootHash, protocolVersion: 1, build: record.build, recovery: runtime.recoveryStatus() })
      }
      if (endpoint.pathname === '/stop' && request.method === 'POST') {
        if (!auth) return json(response, { error: 'Unauthorized' }, 401)
        json(response, { state: 'draining' })
        void shutdown().catch(rejectFinish)
        return
      }
      if (endpoint.pathname === '/browser-session' && request.method === 'POST') {
        if (!auth) return json(response, { error: 'Unauthorized' }, 401)
        const code = randomBytes(32).toString('hex')
        const expires = Date.now() + loginCodeTtlMs
        browserCodes.set(code, expires)
        return json(response, { code, expiresAt: new Date(expires).toISOString(), browserSessionTtlMs })
      }
      if (endpoint.pathname === '/session' && request.method === 'POST') {
        if (request.headers.origin !== record.url) return json(response, { error: 'Forbidden origin' }, 403)
        const value = await body(request) as { code?: string }
        if (web) {
          if (typeof value?.code === 'string') browserCodes.delete(value.code)
          return json(response, { authenticated: true })
        }
        if (!value || typeof value.code !== 'string' || (browserCodes.get(value.code) ?? 0) < Date.now()) return json(response, { error: { code: 'AUTH_REQUIRED', message: '访问凭证已失效，请让当前 agent 重新生成访问链接。' } }, 401)
        browserCodes.delete(value.code)
        const cookie = randomBytes(32).toString('hex'); sessions.set(cookie, Date.now() + browserSessionTtlMs)
        response.setHeader('set-cookie', `harnessl3_session=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${browserSessionTtlMs / 1000}`)
        return json(response, { authenticated: true })
      }
      if (endpoint.pathname === '/rpc' && request.method === 'POST') {
        if (!auth && !(web && request.headers['x-harness-web'] === '1' && request.headers.origin === record.url)) return json(response, { error: 'Unauthorized' }, 401)
        if (draining) return json(response, { error: 'Service draining' }, 503)
        active++
        try {
          let supplied = await body(request)
          if (!auth && supplied && typeof supplied === 'object' && !Array.isArray(supplied) && !Object.hasOwn(supplied, 'cwd')) supplied = { ...supplied, cwd: dataRoot }
          const command = validateRpcRequest(supplied)
          command.source = auth ? 'cli' : 'web'
          if (!auth && !/^(?:project list|worktree (?:list|show)|model validate|skills (?:list|refresh)|task (?:start|prompt|select|show|list|handoff|read|close)|context query|history (?:list|show)|agent status|sync status)$/.test(command.operation)) return json(response, { error: 'This operation requires the CLI' }, 403)
          return json(response, await runtime.execute(command))
        } finally { active--; if (!active) for (const waiter of drainWaiters.splice(0)) waiter() }
      }
      if (request.method === 'GET' && (endpoint.pathname === '/view' || endpoint.pathname === '/events')) {
        if (!auth && !web) return json(response, { error: 'Unauthorized' }, 401)
        if (draining) return json(response, { error: 'Service draining' }, 503)
        const worktreeId = endpoint.searchParams.get('worktree') ?? ''
        validateUuid(worktreeId, 'worktreeId')
        if (endpoint.pathname === '/view') {
          active++
          try { return json(response, await runtime.view(worktreeId, endpoint.searchParams.get('task') ?? undefined, endpoint.searchParams.get('batch') ?? undefined)) }
          finally { active--; if (!active) for (const waiter of drainWaiters.splice(0)) waiter() }
        }
        const worktree = await runtime.registry().worktree(worktreeId)
        const resource = await runtime.worktreeResources(worktree)
        const after = endpoint.searchParams.get('after') ?? request.headers['last-event-id'] ?? '0'
        if (typeof after !== 'string' || !/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))) throw new HarnessError('INVALID_ARGUMENT', 'The event cursor must be a nonnegative integer')
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'connection': 'keep-alive', 'x-content-type-options': 'nosniff' })
        streams.add(response)
        const send = (kind: string, data: { worktreeId: string; seq: number; kind?: string }) => { if (!response.destroyed && !response.writableEnded) response.write(`id: ${data.seq}\nevent: ${kind}\ndata: ${canonicalJson(data)}\n\n`) }
        const changed = (event: { worktreeId: string; seq: number; kind: string }) => { if (event.worktreeId === worktreeId) send('commit', event) }
        runtime.on('commit', changed)
        send(Number(after) === resource.archive.seq ? 'ready' : 'reset', { worktreeId, seq: resource.archive.seq })
        const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': keep-alive\n\n') }, 15_000)
        heartbeat.unref()
        response.once('close', () => { clearInterval(heartbeat); runtime.off('commit', changed); streams.delete(response) })
        return
      }
      if (request.method !== 'GET') return json(response, { error: 'Not found' }, 404)
      // Compiled offline UI replaces the M1 empty-state shell during Web integration.
      if (endpoint.pathname === '/') {
        let html: string
        try { html = await readFile(path.join(PACKAGE_ROOT, 'build/web/index.html'), 'utf8') }
        catch (error) { if (!isErrno(error, 'ENOENT')) throw error; html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HarnessL3</title><style>body{background:#35404d;color:#e0e6ed;font:16px system-ui;padding:4rem}h1{font-size:24px}p{color:#9eacbf}</style><h1>HarnessL3</h1><p>项目上下文 · 使用 web open 打开已登记的工作区。</p></html>' }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' }); response.end(html); return
      }
      if (endpoint.pathname.startsWith('/assets/')) {
        let file: string
        try { file = await resolveInside(path.join(PACKAGE_ROOT, 'build/web'), safeRelative(decodeURIComponent(endpoint.pathname.slice(1))), { noSymlinks: true }) }
        catch { return json(response, { error: 'Not found' }, 404) }
        const types: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
        const type = types[path.extname(file)]
        if (!type) return json(response, { error: 'Not found' }, 404)
        const content = await readFile(file)
        response.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' }); response.end(content); return
      }
      return json(response, { error: 'Not found' }, 404)
    })().catch(error => {
      const failure = asHarnessError(error)
      if (!response.headersSent) json(response, { schemaVersion: 1, requestId: randomUUID(), target: null, replayed: false, ok: false, error: { code: failure.code, message: failure.message, retryable: failure.retryable, details: failure.details } }, 400)
      else response.destroy()
    })
  })
  const signal = () => { if (!record) cancelledBeforeReady = true; else void shutdown().catch(rejectFinish) }
  process.once('SIGINT', signal); process.once('SIGTERM', signal)
  try {
    await runtime.preflight()
    if (cancelledBeforeReady) throw new HarnessError('CANCELLED', 'Service startup cancelled before readiness')
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) })
    if (cancelledBeforeReady) throw new HarnessError('CANCELLED', 'Service startup cancelled before readiness')
    record = { schemaVersion: 1, protocolVersion: 1, pid: process.pid, instanceId, startedAt: lock.startedAt, dataRootHash: digest('data-root', dataRoot), url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token, build: PACKAGE_BUILD }
    await writeJson(descriptorFile, record)
    void runtime.ready().catch(error => { process.stderr.write(JSON.stringify({ code: 'STARTUP_RECOVERY_FAILED', cause: asHarnessError(error).code }) + '\n') })
    onReady?.(record)
    await done
  } catch (error) {
    server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    await runtime.close().catch(() => {})
    await removeOwnedFile(descriptorFile, instanceId); await removeOwnedFile(lockFile, instanceId)
    if (isErrno(error, 'EADDRINUSE')) throw new HarnessError('SERVICE_CONFLICT', 'The requested port belongs to another process')
    throw error
  } finally { process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const index = process.argv.indexOf('--data-dir'), portIndex = process.argv.indexOf('--port')
    const root = await resolveDataRoot(index >= 0 ? process.argv[index + 1] : undefined)
    const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 0
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new HarnessError('INVALID_ARGUMENT', 'Invalid local service port')
    await startServer(root, port)
  } catch (error) { const failure = asHarnessError(error); process.stderr.write(failure.code + ': ' + failure.message + '\n'); process.exitCode = failure.exitCode }
}
