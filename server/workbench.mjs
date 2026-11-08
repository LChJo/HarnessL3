import { LikeC4 } from 'likec4'
import { FqnRef } from '@likec4/core'
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import { watch as watchFiles } from 'node:fs'
import { join, relative } from 'node:path'
import { EventEmitter } from 'node:events'
import { sha256, verifyEvidence } from './evidence.mjs'
import { validateModelContract } from './model-contract.mjs'

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(entries.map(e => e.isDirectory() ? listFiles(join(dir, e.name)) : /\.(?:likec4|c4)$/.test(e.name) ? [join(dir, e.name)] : []))
  return nested.flat().sort()
}
async function modelSources(dir) {
  return Promise.all((await listFiles(dir)).map(async path => ({ path: relative(dir, path).replaceAll('\\', '/'), content: await readFile(path, 'utf8') })))
}
const plain = value => typeof value === 'string' ? value : value?.txt ?? value?.md ?? value?.text ?? ''

export async function createWorkbench({ modelDir, sourceRoot, stateDir, evidenceFile, watch = true }) {
  await mkdir(stateDir, { recursive: true })
  const emitter = new EventEmitter()
  let state = { modelStatus: 'loading', revision: null, attemptedRevision: null, data: null, elements: [], relationships: [], views: [], diagnostics: [], modelFiles: [], source: { status: 'unknown', scope: 'evidence-files-only' } }
  try { state = { ...state, ...JSON.parse(await readFile(join(stateDir, 'last-valid.json'), 'utf8')), modelStatus: 'loading' } } catch {}
  let busy = false, queued = false, closed = false, timer, poll, reconciliation, modelWatcher, sourceWatcher
  async function refresh() {
    if (closed) return
    if (busy) { queued = true; return }
    busy = true
    const started = performance.now()
    let parser
    try {
      const sources = await modelSources(modelDir)
      const attemptedRevision = sha256(JSON.stringify(sources))
      state = { ...state, attemptedRevision, modelFiles: sources.map(s => ({ path: s.path, lines: s.content.split('\n').length, bytes: Buffer.byteLength(s.content) })) }
      parser = await LikeC4.fromWorkspace(modelDir, { logger: false, printErrors: false, watch: false })
      const errors = parser.getErrors()
      if (errors.length) {
        state = { ...state, modelStatus: 'invalid', diagnostics: errors.map(e => ({ message: e.message ?? String(e), file: e.sourceFsPath ? relative(modelDir, e.sourceFsPath) : e.path ?? '', line: e.line ?? e.range?.start?.line ?? null })) }
      } else {
        const model = await parser.layoutedModel()
        const data = JSON.parse(JSON.stringify(model.$data))
        if (evidenceFile) {
          const contract = validateModelContract(data, JSON.parse(await readFile(evidenceFile, 'utf8')))
          if (contract.length) throw new Error(contract.map(d => d.message).join('\n'))
        }
        const after = await modelSources(modelDir)
        if (sha256(JSON.stringify(after)) !== attemptedRevision) { queued = true; state = { ...state, modelStatus: 'loading' }; return }
        const elements = Object.values(data.elements).map(e => ({ id: e.id, title: e.title, kind: e.kind, description: plain(e.description), technology: e.technology, metadata: e.metadata ?? {}, tags: e.tags ?? [] }))
        const relationships = Object.values(data.relations).map(r => ({ id: r.id, source: FqnRef.flatten(r.source), target: FqnRef.flatten(r.target), kind: r.kind, title: r.title ?? '', metadata: r.metadata ?? {}, description: plain(r.description) }))
        const views = Object.values(data.views).map(v => ({ id: v.id, title: v.title ?? v.id, description: plain(v.description), nodes: v.nodes.length, edges: v.edges.length }))
        state = { ...state, data, elements, relationships, views, revision: attemptedRevision, modelStatus: 'valid', diagnostics: [], parsedAt: new Date().toISOString() }
        await writeFile(join(stateDir, 'last-valid.json'), JSON.stringify({ data, elements, relationships, views, revision: attemptedRevision }))
      }
      if (evidenceFile) {
        const manifest = JSON.parse(await readFile(evidenceFile, 'utf8'))
        state = { ...state, project: manifest.project, sourceVersion: manifest.version, source: await verifyEvidence(sourceRoot, manifest), review: manifest.review }
      }
    } catch (error) { state = { ...state, modelStatus: 'invalid', diagnostics: [{ message: error.message }] } }
    finally {
      await parser?.dispose()
      state = { ...state, refreshMs: Math.round(performance.now() - started), updatedAt: new Date().toISOString() }
      busy = false
      emitter.emit('change', state)
      if (queued) { queued = false; await refresh() }
    }
  }
  await refresh()
  const schedule = () => { if (!closed) { clearTimeout(timer); timer = setTimeout(refresh, 250) } }
  if (watch) {
    modelWatcher = watchFiles(modelDir, { recursive: true }, schedule)
    try {
      sourceWatcher = watchFiles(sourceRoot, { recursive: true }, (_event, filename) => {
        const path = String(filename ?? '').replaceAll('\\', '/')
        if (!/^(src\/|tools\/|tests\/|README\.md|CMakeLists\.txt|AGENTS\.md)/.test(path) || /\/(?:build|bin|node_modules|\.git)\//.test(path)) return
        state = { ...state, source: { ...state.source, status: 'pending', changedPath: path } }
        emitter.emit('change', state)
        schedule()
      })
    } catch { state.source.watchStatus = 'unavailable' }
    // Native notifications can be coalesced or lost. Reconcile bytes without
    // rerunning the parser or publishing changes when the model is unchanged.
    const reconcile = async () => {
      if (closed || busy) return
      let revision
      try { revision = sha256(JSON.stringify(await modelSources(modelDir))) }
      catch { if (!closed) await refresh(); return }
      if (!closed && revision !== state.attemptedRevision) await refresh()
    }
    poll = setInterval(() => {
      if (!reconciliation) reconciliation = reconcile().catch(error => {
        if (!closed) {
          state = { ...state, modelStatus: 'invalid', diagnostics: [{ message: error.message }] }
          emitter.emit('change', state)
        }
      }).finally(() => { reconciliation = undefined })
    }, 1000)
    poll.unref?.()
  }
  return { snapshot: () => state, refresh, onChange: handler => { emitter.on('change', handler); return () => emitter.off('change', handler) },
    close: async () => { closed = true; clearTimeout(timer); clearInterval(poll); modelWatcher?.close(); sourceWatcher?.close(); await reconciliation; emitter.removeAllListeners() } }
}
