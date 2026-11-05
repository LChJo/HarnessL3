import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createHistoryArchive, historyPage, retention, taskAtBatch, snapshotIdFor } from './task-history.mjs'
import { replaceFile } from './atomic-file.mjs'
import { ROUTER_VERSION, selectionPrompt, handoffText, skillReferences } from './skill-hub.mjs'
import { verifySkillPlan } from './skill-library.mjs'

const clone = value => structuredClone(value)
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const safeId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)
function ids(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 200 || value.some(id => typeof id !== 'string' || !id || id.length > 300)) throw fail(`${field} 应为最多 200 个对象 ID`)
  return [...new Set(value)]
}

export async function createContextReader({ getSnapshot, stateDir, worktreeId, projectId, sourceRoot, skillLibrary, now = () => new Date() }) {
  const timestamp = () => now().toISOString()
  const directory = join(stateDir, 'context-tasks')
  await mkdir(directory, { recursive: true })
  const archive = await createHistoryArchive({ stateDir, projectId, sourceRoot, now })
  const tasks = new Map(), writes = new Map(), selectionLocks = new Set(), emitter = new EventEmitter()
  let cachedRevision, index, bodyCache = new Map()
  function projection(snapshot) {
    const key = JSON.stringify([snapshot.revision, snapshot.source?.status, snapshot.sourceVersion])
    if (cachedRevision !== key) {
      cachedRevision = key
      index = new Map(snapshot.elements.map(node => [node.id, node])); bodyCache = new Map()
    }
    return { nodes: index, bodies: bodyCache }
  }
  async function persist(task) {
    const data = JSON.stringify(task), path = join(directory, task.id + '.json')
    const next = (writes.get(task.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const temp = path + '.' + randomUUID() + '.tmp'
      await writeFile(temp, data, 'utf8'); await replaceFile(temp, path)
    })
    writes.set(task.id, next); await next
  }
  for (const file of await readdir(directory)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue
    try {
      const task = JSON.parse(await readFile(join(directory, file), 'utf8'))
      if (task.worktreeId !== worktreeId || task.projectId !== projectId) continue
      let interrupted = false
      for (const batch of task.batches) if (batch.status === 'requested') { batch.status = 'unknown'; batch.error = '服务中断，未确认返回结果'; interrupted = true }
      tasks.set(task.id, task)
      if (interrupted) await persist(task)
    } catch { /* A damaged record is not converted into a fabricated successful task. */ }
  }
  function current() {
    const snapshot = getSnapshot()
    if (snapshot.modelStatus !== 'valid' || !snapshot.revision) throw fail('模型尚未通过校验，暂不提供新上下文', 409)
    return snapshot
  }
  async function taskFor(id) {
    if (!safeId(id)) throw fail('任务不存在', 404)
    let task = tasks.get(id)
    if (!task) {
      try { task = JSON.parse(await readFile(join(directory, id + '.json'), 'utf8')) }
      catch { throw fail('任务不存在或记录不可读取', 404) }
      if (task.worktreeId !== worktreeId || task.projectId !== projectId) throw fail('任务属于另一个 worktree 工作区', 409)
      tasks.set(id, task)
    }
    return task
  }
  const clients = task => [...new Set(task.batches.map(batch => batch.client))]
  const planFor = task => [...task.batches].reverse().find(batch => ['complete', 'partial'].includes(batch.status) && batch.result && batch.skillPlan)?.skillPlan ?? null
  const info = task => ({ id: task.id, title: task.title, projectId, worktreeId, modelRevision: task.modelRevision, sourceRoot: task.sourceRoot, sourceVersion: task.sourceVersion, createdAt: task.createdAt, updatedAt: task.updatedAt, client: task.client, clients: clients(task), selectionMode: task.selectionMode, sessionId: task.sessionId, batches: task.batches.length, batchCount: task.batches.length, contextCount: task.packet.contexts.length, skillCount: planFor(task)?.skills.length ?? null, history: { ...retention(task, now()), snapshotId: snapshotIdFor(task) ?? null, snapshotStatus: snapshotIdFor(task) ? 'complete' : 'partial' } })
  function rebuild(task) {
    const confirmed = task.batches.filter(batch => ['complete', 'partial'].includes(batch.status) && batch.result), contexts = new Map()
    for (const batch of confirmed) for (const body of batch.result.contexts) contexts.set(body.id, body)
    task.packet = { modelRevision: task.modelRevision, scope: 'exact-objects', contexts: [...contexts.values()] }
    task.disclosedIds = [...new Set(confirmed.flatMap(batch => batch.result.directories.flatMap(d => d.items.map(node => node.id))))]
  }
  const notify = (task, batch, phase) => emitter.emit('change', { taskId: task.id, batchId: batch?.id, worktreeId, phase, client: batch?.client ?? task.client, at: timestamp() })
  function bodyFor(node, snapshot, nodes, bodies) {
    if (bodies.has(node.id)) return bodies.get(node.id)
    const ancestors = [], parts = node.id.split('.')
    for (let size = 1; size < parts.length; size++) { const parent = nodes.get(parts.slice(0, size).join('.')); if (parent) ancestors.push({ id: parent.id, title: parent.title }) }
    const body = {
      id: node.id, title: node.title, kind: node.kind, description: node.description ?? '', metadata: clone(node.metadata ?? {}), ancestors,
      relationships: (snapshot.relationships ?? []).filter(r => r.source === node.id || r.target === node.id).map(r => ({ id: r.id, source: r.source, target: r.target, kind: r.kind, title: r.title ?? '', description: r.description ?? '', metadata: clone(r.metadata ?? {}), scope: 'boundary-reference' })),
      modelRevision: snapshot.revision, sourceVersion: clone(snapshot.sourceVersion ?? { status: 'unknown' }), sourceState: { scope: 'referenced-evidence-only', status: snapshot.source?.status ?? 'unknown' }, scope: 'exact-object',
    }
    const output = { ...body, contentHash: hash(body) }; bodies.set(node.id, output); return output
  }
  async function query(id, input = {}, client, skillPlan) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['expand', 'read', 'known', 'expectedRevision'].includes(key))) throw fail('请求仅支持 expand/read/known/expectedRevision')
    const task = await taskFor(id), snapshot = current()
    if (retention(task, now()).expired) throw fail('任务已超出 60 天活动窗口，请新建任务；原档案仍保留', 409)
    if (snapshot.revision !== task.modelRevision) throw fail('任务模型快照版本已变化，请新建检索任务；原结果仍保留', 409)
    if (input.expectedRevision && input.expectedRevision !== snapshot.revision) throw fail('请求的模型版本不匹配', 409)
    const expand = ids(input.expand, 'expand'), read = ids(input.read, 'read')
    if (!expand.length && !read.length && !skillPlan) throw fail('至少选择一个目录或正文目标')
    const known = input.known ?? {}
    if (!known || typeof known !== 'object' || Array.isArray(known) || Object.values(known).some(v => typeof v !== 'string')) throw fail('known 应为 ID 到内容指纹的对象')
    const { nodes, bodies } = projection(snapshot), started = performance.now()
    const snapshotId = await archive.capture(snapshot)
    const batch = { id: randomUUID(), status: 'requested', requestedAt: timestamp(), request: { expand, read, known: clone(known), ...(input.expectedRevision ? { expectedRevision: input.expectedRevision } : {}) }, client: ['web', 'cli', 'test', 'api'].includes(client) ? client : task.client, modelRevision: snapshot.revision, snapshotId }
    if (skillPlan) batch.skillPlan = skillPlan
    task.batches.push(batch); task.updatedAt = timestamp(); await persist(task); notify(task, batch, 'requested')
    const result = { taskId: task.id, batchId: batch.id, projectId, worktreeId, modelRevision: snapshot.revision, snapshotId, directories: [], contexts: [], unchanged: [], errors: [], outputScope: 'requested-objects-only', observation: 'reader-response-produced' }
    try {
      const directoryResults = await Promise.all(expand.map(async parentId => {
        const parent = nodes.get(parentId)
        if (!parent) return { error: { id: parentId, operation: 'expand', message: '对象不存在' } }
        const items = snapshot.elements.filter(node => node.id.substring(0, node.id.lastIndexOf('.')) === parentId).map(node => ({ id: node.id, title: node.title, brief: node.description ?? '', parentId, children: snapshot.elements.filter(child => child.id.substring(0, child.id.lastIndexOf('.')) === node.id).length }))
        return { directory: { id: parentId, title: parent.title, items } }
      }))
      const contextResults = await Promise.all(read.map(async nodeId => {
        const node = nodes.get(nodeId)
        if (!node) return { error: { id: nodeId, operation: 'read', message: '对象不存在' } }
        const body = bodyFor(node, snapshot, nodes, bodies)
        // Omit only when this task already retained the exact body, never from an unverified history claim.
        if (known[nodeId] === body.contentHash && task.packet.contexts.some(c => c.id === nodeId && c.contentHash === body.contentHash)) return { unchanged: { id: nodeId, contentHash: body.contentHash, reason: 'retained-in-this-task' } }
        return { context: clone(body) }
      }))
      for (const item of directoryResults) { if (item.error) result.errors.push(item.error); else result.directories.push(item.directory) }
      for (const item of contextResults) { if (item.error) result.errors.push(item.error); else if (item.unchanged) result.unchanged.push(item.unchanged); else result.contexts.push(item.context) }
      result.durationMs = Number((performance.now() - started).toFixed(2))
      batch.result = result; batch.completedAt = timestamp(); batch.status = result.errors.length ? result.contexts.length || result.directories.length || result.unchanged.length || skillPlan ? 'partial' : 'failed' : 'complete'
      rebuild(task)
      task.updatedAt = timestamp(); await persist(task); notify(task, batch, 'completed')
      return clone(result)
    } catch (error) {
      batch.status = 'unknown'; batch.error = '返回过程未完成：' + error.message; task.updatedAt = timestamp()
      rebuild(task)
      await persist(task).catch(() => {}); notify(task, batch, 'unknown'); throw error
    }
  }
  async function getTask(id, { batchId } = {}) {
    const original = await taskFor(id), task = taskAtBatch(original, batchId); rebuild(task)
    for (const batch of task.batches) if (batch.skillPlan) verifySkillPlan(batch.skillPlan)
    const lastSelection = [...task.batches].reverse().find(batch => batch.skillPlan), skillPlan = planFor(task)
    const routing = task.skillRouting && (!batchId || task.batches.length > task.skillRouting.preparedAfterBatchCount) ? { ...task.skillRouting, status: skillPlan ? 'selected' : lastSelection ? 'unknown' : 'awaiting-selection' } : null
    return clone({ ...task, skillRouting: routing, skillPlan, clients: clients(task), outdated: getSnapshot().revision !== task.modelRevision, history: { ...info(original).history, snapshotId: snapshotIdFor(task) ?? null, snapshotStatus: snapshotIdFor(task) ? 'complete' : 'partial', throughBatchId: batchId ?? null, totalBatches: original.batches.length }, observation: 'response-produced-for-caller; not-model-understanding-or-global-read-coverage' })
  }
  function active(task) {
    if (retention(task, now()).expired) throw fail('任务已超出 60 天窗口，请新建任务', 409)
    if (current().revision !== task.modelRevision) throw fail('任务模型版本已变化，请新建任务', 409)
  }
  async function prepareTask(id, { refreshCatalog = false } = {}) {
    if (!skillLibrary) throw fail('当前读取服务未配置技能目录', 409)
    const task = await taskFor(id); active(task)
    if (selectionLocks.has(id) || task.batches.some(batch => batch.skillPlan)) throw fail('本任务已有技能选择或结果未知，请查看交接包/记录，或新建任务', 409)
    selectionLocks.add(id)
    try {
      const catalog = await skillLibrary.catalog()
      if (!task.skillRouting || refreshCatalog || task.skillRouting.catalogRevision !== catalog.revision) {
        task.skillRouting = { routerVersion: ROUTER_VERSION, libraryRoot: catalog.root, catalogRevision: catalog.revision, catalog: catalog.skills, preparedAt: timestamp(), preparedAfterBatchCount: task.batches.length }
        await persist(task); notify(task, null, 'skills-prepared')
      }
    } finally { selectionLocks.delete(id) }
    const catalog = { root: task.skillRouting.libraryRoot, revision: task.skillRouting.catalogRevision, skills: task.skillRouting.catalog }
    const directories = task.batches.filter(batch => ['complete', 'partial'].includes(batch.status)).flatMap(batch => batch.result?.directories ?? []).filter(directory => directory.id === projectId)
    return { task: info(task), routerVersion: ROUTER_VERSION, catalog, prompt: selectionPrompt({ task, directories, catalog }), observation: 'routing-material-produced; model-selection-not-yet-recorded' }
  }
  async function selectTask(id, input, client) {
    if (!skillLibrary) throw fail('当前读取服务未配置技能目录', 409)
    const task = await taskFor(id); active(task)
    if (selectionLocks.has(id) || task.batches.some(batch => batch.skillPlan)) throw fail('本任务已有技能选择或结果未知，请查看记录/交接包，或新建任务', 409)
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['catalogRevision', 'modelRevision', 'expand', 'read', 'skills'].includes(key))) throw fail('联合选择仅支持 catalogRevision/modelRevision/expand/read/skills')
    if (!task.skillRouting || input.catalogRevision !== task.skillRouting.catalogRevision) throw fail('选择与任务入口的技能目录版本不一致，请重新获取入口提示', 409)
    if (input.modelRevision !== task.modelRevision) throw fail('选择的模型版本不匹配', 409)
    // Validate the context shape before reading skill bodies or creating a batch.
    ids(input.expand, 'expand'); ids(input.read, 'read')
    selectionLocks.add(id)
    try {
      const selected = await skillLibrary.select(input.skills, input.catalogRevision)
      const skillPlan = { id: randomUUID(), status: 'selected', routerVersion: ROUTER_VERSION, createdAt: timestamp(), ...selected, observation: 'selection-recorded; execution-unknown', client: ['web', 'cli', 'test', 'api'].includes(client) ? client : task.client }
      const result = await query(id, { expand: input.expand, read: input.read, expectedRevision: input.modelRevision }, client, skillPlan)
      const state = await getTask(id)
      return { task: state, result, selection: clone(input), handoff: handoffText(state) }
    } finally { selectionLocks.delete(id) }
  }
  return {
    async startTask(input = {}) {
      const snapshot = current(), title = typeof input.title === 'string' ? input.title.trim() : ''
      if (!title || title.length > 500) throw fail('请输入不超过 500 字的任务目的')
      const selectionMode = ['manual', 'preset', 'external', 'test'].includes(input.selectionMode) ? input.selectionMode : input.client === 'cli' ? 'external' : 'manual'
      const initialSnapshotId = await archive.capture(snapshot)
      const task = { id: randomUUID(), title, projectId, worktreeId, sourceRoot: sourceRoot ?? null, sourceVersion: clone(snapshot.sourceVersion ?? {}), modelRevision: snapshot.revision, initialSnapshotId, createdAt: timestamp(), updatedAt: timestamp(), client: ['web', 'cli', 'test', 'api'].includes(input.client) ? input.client : 'api', selectionMode, sessionId: typeof input.sessionId === 'string' ? input.sessionId.slice(0, 200) : null, batches: [], disclosedIds: [], packet: { modelRevision: snapshot.revision, scope: 'exact-objects', contexts: [] } }
      tasks.set(task.id, task); await persist(task); notify(task, null, 'created')
      const result = await query(task.id, { expand: [projectId] })
      return { task: info(task), result }
    },
    query,
    getTask, prepareTask, selectTask,
    async handoff(id, options) { return handoffText(await getTask(id, options)) },
    async readSkills(id, input = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['files', 'batchId'].includes(key)) || !Array.isArray(input.files) || !input.files.length || input.files.length > 200) throw fail('files 应为 1–200 个已选技能文件引用')
      const state = await getTask(id, { batchId: input.batchId }), references = skillReferences(state), files = [], seen = new Set()
      for (const request of input.files) {
        if (!request || Object.keys(request).some(key => !['skillId', 'path', 'hash'].includes(key)) || typeof request.skillId !== 'string' || typeof request.path !== 'string' || !request.path || request.path.startsWith('/') || request.path.includes('\\') || request.path.split('/').some(part => !part || part === '.' || part === '..')) throw fail('技能文件引用路径无效')
        const skill = state.skillPlan.skills.find(skill => skill.id === request.skillId), file = skill?.files.find(file => file.path === request.path)
        if (!file) throw fail('文件不在这次已确认的技能选择中：' + request.skillId + '/' + request.path, 404)
        if (request.hash !== undefined && request.hash !== file.hash) throw fail('技能引用指纹与选择时文件不一致', 409)
        const key = request.skillId + '/' + request.path
        if (!seen.has(key)) { seen.add(key); files.push({ skillId: skill.id, ...file, ref: references.find(item => item.id === skill.id).files.find(item => item.path === file.path).ref }) }
      }
      // This is a retrieval from an already recorded archive, not a new selection,
      // execution event, or activity that extends the historical retention window.
      return { taskId: state.id, planId: state.skillPlan.id, catalogRevision: state.skillPlan.catalogRevision, files, observation: 'archived-files-returned; execution-and-understanding-unknown' }
    },
    async getTaskSnapshot(id, { batchId } = {}) { return archive.forTask(taskAtBatch(await taskFor(id), batchId)) },
    history(options = {}) { const result = historyPage([...tasks.values()].filter(t => t.projectId === projectId && t.worktreeId === worktreeId), options, now()); return { ...result, tasks: result.tasks.map(info) } },
    listTasks() { return historyPage([...tasks.values()].filter(t => t.projectId === projectId && t.worktreeId === worktreeId), { limit: 50 }, now()).tasks.map(info) },
    onChange(listener) { emitter.on('change', listener); return () => emitter.off('change', listener) },
  }
}
