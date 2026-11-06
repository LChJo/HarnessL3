import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { replaceFile } from './atomic-file.mjs'

export const RETENTION_DAYS = 60
const DAY = 86400000
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const error = (message, status = 400) => Object.assign(new Error(message), { status })
export function retention(task, now = new Date()) {
  const activity = Date.parse(task.updatedAt ?? task.createdAt)
  return { retentionDays: RETENTION_DAYS, expiresAt: Number.isFinite(activity) ? new Date(activity + RETENTION_DAYS * DAY).toISOString() : null, expired: !Number.isFinite(activity) || activity < +now - RETENTION_DAYS * DAY, basis: 'last-recorded-read-activity; viewing-does-not-renew' }
}
export function historyPage(tasks, options = {}, now = new Date()) {
  const limit = Number(options.limit ?? 20), offset = Number(options.offset ?? 0), query = String(options.query ?? '').trim().toLowerCase()
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || query.length > 500) throw error('分页 limit 应为 1–100，offset 为非负整数')
  const date = (value, end) => value ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value + (end ? 'T23:59:59.999Z' : 'T00:00:00Z') : value) : end ? Infinity : -Infinity
  const from = date(options.from, false), to = date(options.to, true)
  if (Number.isNaN(from) || Number.isNaN(to) || from > to) throw error('历史日期范围无效')
  const matches = tasks.filter(task => !retention(task, now).expired && Date.parse(task.updatedAt) >= from && Date.parse(task.updatedAt) <= to && (!query || [task.id, task.title, task.sessionId ?? '', task.modelRevision].join(' ').toLowerCase().includes(query))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
  return { tasks: matches.slice(offset, offset + limit), total: matches.length, offset, limit, hasMore: offset + limit < matches.length, retentionDays: RETENTION_DAYS, windowStart: new Date(+now - RETENTION_DAYS * DAY).toISOString(), expiryAction: 'outside-default-window; local-files-not-permanently-deleted' }
}
export function taskAtBatch(task, batchId) {
  const view = structuredClone(task)
  if (batchId) { const index = view.batches.findIndex(batch => batch.id === batchId); if (index < 0) throw error('历史批次不存在', 404); view.batches = view.batches.slice(0, index + 1) }
  return view
}
export function snapshotIdFor(task) { return [...task.batches].reverse().find(batch => batch.snapshotId)?.snapshotId ?? task.initialSnapshotId }

export async function createHistoryArchive({ stateDir, projectId, sourceRoot, now }) {
  const directory = join(stateDir, 'context-snapshots'), pending = new Map()
  await mkdir(directory, { recursive: true })
  function payload(snapshot) {
    return { modelStatus: snapshot.modelStatus, revision: snapshot.revision, elements: snapshot.elements, relationships: snapshot.relationships ?? [], evidence: snapshot.source?.evidence ?? [], sourceVersion: snapshot.sourceVersion ?? {}, source: { status: snapshot.source?.status ?? 'unknown', scope: 'referenced-evidence-only' }, runtime: { sourceRoot: sourceRoot ?? '历史来源路径未记录' }, c4Views: Object.values(snapshot.data?.views ?? {}) }
  }
  async function load(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw error('历史快照标识无效', 404)
    let record
    try { record = JSON.parse(await readFile(join(directory, id + '.json'), 'utf8')) } catch { throw error('历史快照缺失或损坏；不会以当前模型代替', 409) }
    if (record.id !== id || digest(record.snapshot) !== id) throw error('历史快照内容指纹不匹配', 409)
    return record
  }
  return {
    async capture(snapshot) {
      const data = payload(snapshot), id = digest(data)
      if (!pending.has(id)) {
        const promise = (async () => {
          try { await readFile(join(directory, id + '.json')); await load(id); return id } catch (e) { if (e.code !== 'ENOENT') throw e }
          const record = { id, capturedAt: now().toISOString(), snapshot: data }, path = join(directory, id + '.json'), temp = path + '.' + randomUUID() + '.tmp'
          await writeFile(temp, JSON.stringify(record), 'utf8'); await replaceFile(temp, path); return id
        })()
        pending.set(id, promise); promise.catch(() => pending.delete(id))
      }
      return pending.get(id)
    },
    async forTask(task) {
      const id = snapshotIdFor(task)
      if (id) return { status: 'complete', ...await load(id) }
      // Older tasks did not archive the model. Reconstruct only what their real responses retained.
      const nodes = new Map(), relationships = new Map(), evidence = new Map()
      const add = (id, title, description = '', metadata = {}) => { if (!nodes.has(id)) nodes.set(id, { id, title, description, metadata, kind: 'module' }) }
      add(projectId, projectId)
      let sourceVersion = {}
      for (const batch of task.batches) {
        if (!['complete', 'partial'].includes(batch.status) || !batch.result) continue
        for (const directory of batch.result.directories) { add(directory.id, directory.title); for (const brief of directory.items) add(brief.id, brief.title, brief.brief) }
        for (const body of batch.result.contexts) {
          for (const ancestor of body.ancestors ?? []) add(ancestor.id, ancestor.title)
          nodes.set(body.id, structuredClone(body)); sourceVersion = body.sourceVersion ?? sourceVersion
          for (const relation of body.relationships) relationships.set(relation.id, relation)
          for (const id of (Array.isArray(body.metadata.evidence) ? body.metadata.evidence : [body.metadata.evidence]).filter(Boolean)) evidence.set(id, { id, path: body.metadata.path ?? '', claim: '历史返回的引用；未归档源码片段' })
        }
      }
      return { status: 'partial', id: null, capturedAt: null, note: '旧任务未归档完整模型，仅恢复当时已保留的简述、正文和引用；未记录的区域未知。', snapshot: { modelStatus: 'historical-record', revision: task.modelRevision, elements: [...nodes.values()], relationships: [...relationships.values()], evidence: [...evidence.values()], sourceVersion, source: { status: 'unknown', scope: 'recorded-responses-only' }, runtime: { sourceRoot: '历史来源路径未记录' }, c4Views: [] } }
    },
  }
}
