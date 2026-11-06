import { createServer } from 'node:http'
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { join, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createWorkbench } from './workbench.mjs'
import { readSourceFile, resolveEvidencePath, sha256 } from './evidence.mjs'
import { parseCodexRollout } from './agent-log.mjs'
import { resolveSourceRoot, resolveSkillRoot } from './config.mjs'
import { createContextReader } from './context-reader.mjs'
import { createSkillLibrary } from './skill-library.mjs'
import { createSkillHub } from './skill-hub-watch.mjs'
import { referenceSelection } from './skill-hub.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'examples/mgrp/evidence.json'), 'utf8'))
const sourceRoot = await resolveSourceRoot(root)
const modelDir = join(root, 'examples/mgrp/model')
const stateDir = join(root, '.harness-local', sha256(`${modelDir}|${sourceRoot}`).slice(0, 16))
await mkdir(stateDir, { recursive: true })
const wb = await createWorkbench({ modelDir, sourceRoot, stateDir, evidenceFile: join(root, 'examples/mgrp/evidence.json') })
const port = Number(process.env.PORT ?? 4317)
const production = process.argv.includes('--production')
const vite = production ? null : await (await import('vite')).createServer({ root, server: { middlewareMode: true }, appType: 'spa' })
const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)) }
const sse = new Set()
const skillRoot = await resolveSkillRoot(root)
const skillLibrary = createSkillLibrary({ root: skillRoot })
const skillHub = await createSkillHub({ root: skillRoot, library: skillLibrary })
const reader = await createContextReader({ getSnapshot: wb.snapshot, stateDir, worktreeId: sha256(`${modelDir}|${sourceRoot}`).slice(0, 16), projectId: 'mgrp', sourceRoot: sourceRoot.replaceAll('\\', '/'), skillLibrary: { ...skillLibrary, catalog: skillHub.catalog } })
skillHub.onChange(state => { for (const res of sse) res.write(`event: skills\ndata: ${JSON.stringify(state)}\n\n`) })
reader.onChange(event => { for (const res of sse) res.write(`event: context\ndata: ${JSON.stringify(event)}\n\n`) })
wb.onChange(state => { for (const res of sse) res.write(`event: model\ndata: ${JSON.stringify({ revision: state.revision, attemptedRevision: state.attemptedRevision, modelStatus: state.modelStatus, updatedAt: state.updatedAt })}\n\n`) })

async function requestBody(req) {
  let text = ''
  for await (const chunk of req) { text += chunk; if (text.length > 65536) throw Object.assign(new Error('请求正文过大'), { status: 413 }) }
  try { return text ? JSON.parse(text) : {} } catch { throw Object.assign(new Error('JSON 格式无效'), { status: 400 }) }
}

async function latestRollout() {
  if (process.env.CODEX_ROLLOUT_PATH) return process.env.CODEX_ROLLOUT_PATH
  const day = new Date().toLocaleDateString('en-CA').replaceAll('/', '-')
  const dirs = [join(homedir(), '.codex/sessions', ...day.split('-'))]
  const files = []
  for (const dir of dirs) {
    try { for (const name of await readdir(dir)) if (name.endsWith('.jsonl')) { const path = join(dir, name); files.push({ path, mtime: (await stat(path)).mtimeMs }) } } catch {}
  }
  return files.sort((a, b) => b.mtime - a.mtime)[0]?.path
}

let eventCache = { mtime: 0, result: null }
async function events() {
  const path = await latestRollout()
  let parsed = { events: [], coverage: { status: 'unknown', note: '没有可用的 Codex 工具日志来源；不据此推断未读取。' } }
  if (path) {
    const info = await stat(path)
    if (eventCache.path === path && eventCache.mtime === info.mtimeMs) parsed = eventCache.result
    else {
      parsed = parseCodexRollout(await readFile(path, 'utf8'), { roots: [sourceRoot, root] })
      parsed.events = parsed.events.filter(e => e.root.toLowerCase().replaceAll('\\', '/') === sourceRoot.toLowerCase().replaceAll('\\', '/') || e.path.startsWith('examples/mgrp/model/'))
      eventCache = { path, mtime: info.mtimeMs, result: parsed }
    }
  }
  let demos = []
  try { demos = (await readFile(join(stateDir, 'agent-example.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch {}
  const snapshot = wb.snapshot()
  const all = [...parsed.events, ...demos].map(e => ({ ...e, objects: snapshot.elements.filter(o => {
    const path = Array.isArray(o.metadata.path) ? o.metadata.path[0] : o.metadata.path
    return path && (path === e.path || path.startsWith(e.path + '/'))
  }).map(o => o.id) })).sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  return { ...parsed, events: all.slice(0, 180), demoCount: demos.length, coverage: { ...parsed.coverage, source: path ? '本机 Codex rollout（仅白名单操作，聊天内容不展示）' : '无可用来源',
    roots: [sourceRoot.replaceAll('\\', '/'), root.replaceAll('\\', '/')], demo: '脚本演示单独标注，不当作真实 LLM 轨迹' } }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    if (url.pathname.startsWith('/api/')) {
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(res, { error: '仅允许同源请求' }, 403)
      const contextClient = ['web', 'cli', 'test'].includes(req.headers['x-harness-client']) ? req.headers['x-harness-client'] : 'api'
      if (url.pathname === '/api/skills/catalog' && req.method === 'GET') { await skillHub.refresh('request'); return json(res, skillHub.status()) }
      if (url.pathname === '/api/skills/refresh' && req.method === 'POST') return json(res, await skillHub.refresh('manual'))
      if (url.pathname === '/api/harness/tasks' && req.method === 'POST') {
        // Check the editable catalog before creating an entrance that cannot route.
        await skillHub.catalog()
        const created = await reader.startTask({ ...await requestBody(req), client: contextClient })
        const entrance = await reader.prepareTask(created.task.id)
        return json(res, { ...created, entrance }, 201)
      }
      const entranceRoute = url.pathname.match(/^\/api\/harness\/tasks\/([^/]+)\/(prompt|select|handoff|read)$/)
      if (entranceRoute) {
        const [, id, action] = entranceRoute
        if (action === 'prompt' && req.method === 'POST') return json(res, await reader.prepareTask(id, await requestBody(req)))
        if (action === 'select' && req.method === 'POST') return json(res, referenceSelection(await reader.selectTask(id, await requestBody(req), contextClient)))
        if (action === 'read' && req.method === 'POST') return json(res, await reader.readSkills(id, await requestBody(req)))
        if (action === 'handoff' && req.method === 'GET') return json(res, { taskId: id, handoff: await reader.handoff(id, { batchId: url.searchParams.get('batch') }) })
        return json(res, { error: '不支持的方法' }, 405)
      }
      if (url.pathname === '/api/context/history' && req.method === 'GET') return json(res, reader.history(Object.fromEntries(url.searchParams)))
      if (url.pathname === '/api/context/structure' && req.method === 'GET') { const snapshot = wb.snapshot(); return json(res, { revision: snapshot.revision, modelStatus: snapshot.modelStatus, views: Object.values(snapshot.data?.views ?? {}) }) }
      if (url.pathname === '/api/context/overview' && req.method === 'GET') {
        const snapshot = wb.snapshot()
        return json(res, { modelStatus: snapshot.modelStatus, revision: snapshot.revision, elements: snapshot.elements, relationships: snapshot.relationships, evidence: snapshot.source.evidence?.map(({ id, path, claim, startLine, endLine }) => ({ id, path, claim, startLine, endLine })), sourceVersion: snapshot.sourceVersion, source: { status: snapshot.source.status, scope: snapshot.source.scope }, runtime: { sourceRoot: sourceRoot.replaceAll('\\', '/') } })
      }
      if (url.pathname === '/api/context/tasks') {
        if (req.method === 'GET') return json(res, { tasks: reader.listTasks() })
        if (req.method === 'POST') return json(res, await reader.startTask({ ...await requestBody(req), client: contextClient }), 201)
        return json(res, { error: '不支持的方法' }, 405)
      }
      const contextRoute = url.pathname.match(/^\/api\/context\/tasks\/([^/]+)(\/(?:query|snapshot))?$/)
      if (contextRoute) {
        if (contextRoute[2] === '/query' && req.method === 'POST') return json(res, await reader.query(contextRoute[1], await requestBody(req), contextClient))
        if (contextRoute[2] === '/snapshot' && req.method === 'GET') return json(res, await reader.getTaskSnapshot(contextRoute[1], { batchId: url.searchParams.get('batch') }))
        if (!contextRoute[2] && req.method === 'GET') return json(res, await reader.getTask(contextRoute[1], { batchId: url.searchParams.get('batch') }))
        return json(res, { error: '不支持的方法' }, 405)
      }
      if (url.pathname === '/api/snapshot') return json(res, { ...wb.snapshot(), runtime: { sourceRoot: sourceRoot.replaceAll('\\', '/'), modelDir: modelDir.replaceAll('\\', '/'), stateDir: stateDir.replaceAll('\\', '/'), mode: 'local-prototype' } })
      if (url.pathname === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
        res.write(`event: skills\ndata: ${JSON.stringify(skillHub.status())}\n\n`); sse.add(res)
        req.on('close', () => sse.delete(res))
        return
      }
      if (url.pathname === '/api/events') return json(res, await events())
      if (url.pathname === '/api/model-source') {
        let file = url.searchParams.get('file') ?? '01-project.c4'
        let line = null
        const object = url.searchParams.get('object')
        if (object) {
          if (!wb.snapshot().elements.some(e => e.id === object)) return json(res, { error: '未知模型对象' }, 404)
          for (const item of wb.snapshot().modelFiles) {
            const content = (await readSourceFile(modelDir, item.path)).toString('utf8')
            const index = content.split('\n').findIndex(text => text.includes(`stable_id "${object}"`))
            if (index >= 0) { file = item.path; line = index + 1; break }
          }
        }
        if (!wb.snapshot().modelFiles.some(f => f.path === file)) return json(res, { error: '模型文件不存在' }, 404)
        return json(res, { file, line, content: (await readSourceFile(modelDir, file)).toString('utf8'), revision: wb.snapshot().attemptedRevision })
      }
      if (url.pathname.startsWith('/api/evidence/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/evidence/'.length))
        const evidence = wb.snapshot().source.evidence?.find(e => e.id === id)
        if (!evidence) return json(res, { error: '未知证据 ID' }, 404)
        const bytes = await readSourceFile(sourceRoot, evidence.path)
        const lines = bytes.toString('utf8').split(/\r?\n/)
        return json(res, { ...evidence, currentHash: sha256(bytes), lines: lines.slice(evidence.startLine - 1, evidence.endLine).map((text, i) => ({ number: evidence.startLine + i, text })) })
      }
      if (url.pathname === '/api/refresh' && req.method === 'POST') { await wb.refresh(); return json(res, { status: wb.snapshot().modelStatus }) }
      if (url.pathname === '/api/reviews') {
        if (req.method === 'POST') {
          let body = ''
          for await (const chunk of req) { body += chunk; if (body.length > 16000) return json(res, { error: '审查记录过长' }, 413) }
          const review = JSON.parse(body)
          if (!['usable', 'needs-work', 'unknown'].includes(review.verdict) || typeof review.note !== 'string') return json(res, { error: '无效审查记录' }, 400)
          let reviews = []
          try { reviews = JSON.parse(await readFile(join(stateDir, 'reviews.json'), 'utf8')) } catch {}
          reviews.push({ ...review, revision: wb.snapshot().revision, timestamp: new Date().toISOString(), scope: 'local-review-record' })
          await writeFile(join(stateDir, 'reviews.json'), JSON.stringify(reviews, null, 2)); return json(res, reviews)
        }
        try { return json(res, JSON.parse(await readFile(join(stateDir, 'reviews.json'), 'utf8'))) } catch { return json(res, []) }
      }
      return json(res, { error: '接口不存在' }, 404)
    }
    if (vite) return vite.middlewares(req, res, () => { res.statusCode = 404; res.end('Not found') })
    const file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1))
    const path = resolveEvidencePath(join(root, 'dist'), file)
    try {
      const bytes = await readFile(path)
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
      res.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream' }); res.end(bytes)
    } catch { res.writeHead(404); res.end('Not found') }
  } catch (error) { json(res, { error: error.message }, error.status ?? 400) }
})
const heartbeat = setInterval(() => { for (const res of sse) res.write(': heartbeat\n\n') }, 20000)
server.listen(port, '127.0.0.1', () => console.log(`HarnessL3 model workbench: http://127.0.0.1:${port}\nSource: ${sourceRoot}\nModel: ${modelDir}\nState: ${stateDir}\nModel: ${wb.snapshot().modelStatus}`))
async function stop() { clearInterval(heartbeat); for (const res of sse) res.end(); await skillHub.close(); await wb.close(); await vite?.close(); server.close(); process.exit(0) }
process.on('SIGINT', stop); process.on('SIGTERM', stop)
