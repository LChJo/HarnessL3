import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { Archive, type ArchiveReference, type CommitRecord } from './archive.js'
import { SearchIndex, type IndexDocument } from './index.js'
import { loadModel, modelBody, modelDirectory } from './model.js'
import { captureSkills, scanSkills } from './skills.js'
import { canonicalJson, digest, sha256 } from './json.js'
import { HarnessError, asHarnessError } from './errors.js'
import { validateContract } from './contract.js'
import { readJson } from './io.js'
import { flag, validateUuid, type CommandRequest } from '../cli/args.js'
import type { BatchResult, Binding, Envelope, FileReadRequest, ItemError, ModelSnapshot, Packet, ProjectConfig, QueryFields, QueryRequest, SelectionRequest, SkillBrief, SkillCatalog, SourceVersion, Target, TaskBatch, TaskRecord, WorktreeRecord } from './types.js'

const RETENTION = 60 * 86400000
const ROUTER_VERSION = 'skill-hub/1'
const hashPattern = /^[a-f0-9]{64}$/
interface SourceState { sourceVersion: SourceVersion; sourceScanRevision: string; archives?: ArchiveReference[] }
interface FrozenTask extends TaskRecord { sourceArchives?: ArchiveReference[] }
interface FrozenBatch extends TaskBatch { binding: Binding; catalog: SkillBrief[] }
interface TaskPayload { kind: 'task'; task: TaskRecord; operation?: string; source?: 'cli' | 'web' }
interface Options {
  worktree: WorktreeRecord; archive: Archive; index: SearchIndex
  source: (skillsRoot: string) => Promise<SourceState>
  now?: () => Date; onCommit?: (seq: number) => void; syncStatus?: () => unknown | Promise<unknown>; beforeLive?: (skillsRoot: string) => Promise<void>
  externalDocuments?: () => IndexDocument[]
}
const emptyPacket = (): Packet => ({ scope: 'returned-entities-only', contexts: [], evidence: [] })
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b)
const commandResult = (operation: string, result: unknown) => ({ kind: 'command-result', status: 'complete', operation, result })
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
function expired(task: TaskRecord, now: Date): boolean { return now.getTime() > Date.parse(task.expiresAt) }

/** Worktree-local tasks use the file journal as authority; SQLite only projects committed state. */
export class TaskService {
  readonly worktree: WorktreeRecord
  readonly archive: Archive
  readonly index: SearchIndex
  private readonly source: Options['source']
  private readonly now: () => Date
  private readonly onCommit?: Options['onCommit']
  private readonly synchronization?: Options['syncStatus']
  private readonly beforeLive?: Options['beforeLive']
  private readonly externalDocuments?: Options['externalDocuments']
  private loading?: Promise<void>
  private queue: Promise<unknown> = Promise.resolve()
  private records = new Map<string, TaskRecord>()
  private indexProblem: unknown

  constructor(options: Options) {
    this.worktree = options.worktree
    this.archive = options.archive
    this.index = options.index
    this.source = options.source
    this.now = options.now ?? (() => new Date())
    this.onCommit = options.onCommit
    this.synchronization = options.syncStatus
    this.beforeLive = options.beforeLive
    this.externalDocuments = options.externalDocuments
  }
  ready(): Promise<void> { return this.loading ??= this.load() }
  async close(): Promise<void> { await this.queue.catch(() => {}); await this.index.close() }
  serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation)
    this.queue = next.catch(() => undefined)
    return next
  }
  tasks(): TaskRecord[] { return [...this.records.values()].map(task => structuredClone(task)) }
  status() { return { archive: { state: this.archive.status, seq: this.archive.seq, diagnostics: this.archive.diagnostics }, index: this.index.status, indexError: this.indexProblem ? String(this.indexProblem) : null } }

  private target(): Target { return { projectId: this.worktree.projectId, worktreeId: this.worktree.id } }
  private instant(): Date {
    const date = this.now()
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new HarnessError('INTERNAL_ERROR', 'The task clock did not produce a valid instant.')
    return new Date(date)
  }
  private envelope(request: CommandRequest, data: unknown): Envelope {
    return validateContract<Envelope>('response', { schemaVersion: 1, requestId: request.requestId, target: this.target(), replayed: false, ok: true, data })
  }
  private failure(request: CommandRequest, error: unknown): Envelope {
    const failure = asHarnessError(error)
    return validateContract<Envelope>('response', { schemaVersion: 1, requestId: request.requestId, target: failure.code === 'TARGET_CONFLICT' ? null : this.target(), replayed: false, ok: false, error: { code: failure.code, message: failure.message, details: failure.details, retryable: failure.retryable } })
  }
  private async load(): Promise<void> {
    await this.archive.ready()
    this.restore()
    if (this.archive.status !== 'ready') { this.indexProblem = new HarnessError('INDEX_UNAVAILABLE', 'The journal has an unverified region; history search is unavailable.', { diagnostics: this.archive.diagnostics }, true); return }
    try {
      await this.index.ready()
      if (this.index.status.state !== 'ready' || this.index.status.seq !== this.archive.seq) await this.index.rebuild(this.projection(), this.archive.seq)
    } catch (error) { this.indexProblem = error }
  }
  private restore(): void {
    const restored = new Map<string, TaskRecord>()
    for (const record of this.archive.records()) {
      const payload = record.payload as Partial<TaskPayload> | null
      if (payload?.kind !== 'task') continue
      const task = this.checkedTask(payload.task)
      restored.set(task.id, task)
    }
    this.records = restored
  }
  private checkedTask(value: unknown): TaskRecord {
    try {
      if (!value || typeof value !== 'object') throw new Error('Task payload is absent.')
      const task = value as TaskRecord
      validateUuid(task.id, 'task.id')
      if (task.schemaVersion !== 1 || !task.title?.trim() || !['cli', 'web'].includes(task.source) || (task.declaredSession !== null && typeof task.declaredSession !== 'string') || task.binding?.projectId !== this.worktree.projectId || task.binding?.worktreeId !== this.worktree.id || !hashPattern.test(task.modelSnapshotHash) || !timestamp(task.createdAt) || !timestamp(task.updatedAt) || (task.lastReadAt !== null && !timestamp(task.lastReadAt)) || !timestamp(task.retentionBasisAt) || !timestamp(task.expiresAt) || (task.closedAt !== null && !timestamp(task.closedAt)) || !Array.isArray(task.batches) || !Array.isArray(task.catalog)) throw new Error('Task identity, timestamps or archive binding are invalid.')
      if (task.retentionBasisAt !== (task.lastReadAt ?? task.createdAt) || Date.parse(task.expiresAt) !== Date.parse(task.retentionBasisAt) + RETENTION) throw new Error('Task retention metadata is inconsistent.')
      validateContract('response', { schemaVersion: 1, requestId: task.id, target: this.target(), replayed: false, ok: true, data: { kind: 'task-entry', status: 'complete', taskId: task.id, binding: task.binding, routerVersion: ROUTER_VERSION, routingPrompt: 'Stored entry validation', directory: task.initialDirectory, catalog: task.catalog, observation: 'routing-material-produced; selection-not-recorded' } })
      validateContract('response', { schemaVersion: 1, requestId: task.id, target: this.target(), replayed: false, ok: true, data: this.handoffData(task, task.batches.at(-1)?.id ?? null) })
      this.checkPacket(task.packet)
      for (const batch of task.batches) {
        validateUuid(batch.id, 'batch.id'); validateUuid(batch.requestId, 'batch.requestId')
        if (!timestamp(batch.createdAt)) throw new Error('Batch time is invalid.')
        if (batch.source !== undefined && !['cli', 'web'].includes(batch.source)) throw new Error('Batch origin is invalid.')
        this.checkPacket(batch.packet)
        validateContract('response', { schemaVersion: 1, requestId: batch.requestId, target: this.target(), replayed: false, ok: true, data: this.handoffData({ ...task, binding: (batch as FrozenBatch).binding ?? task.binding, packet: batch.packet, skillPlan: batch.skillPlan }, batch.id) })
        if (batch.result && batch.result.batchId !== batch.id) throw new Error('Batch identity differs from its result.')
        if (batch.result) validateContract('response', { schemaVersion: 1, requestId: batch.requestId, target: this.target(), replayed: false, ok: true, data: { kind: 'context-batch', status: batch.result.errors.length ? 'partial' : 'complete', taskId: task.id, binding: (batch as FrozenBatch).binding ?? task.binding, result: batch.result } })
      }
      return structuredClone(task)
    } catch (error) { throw new HarnessError('ARCHIVE_CORRUPT', 'The committed task payload does not match the v1 contract.', { cause: String(error) }) }
  }
  private checkPacket(packet: Packet): void {
    const entities = new Set<string>()
    const references = new Set<string>()
    for (const body of packet.contexts) {
      if (entities.has(body.entity.id)) throw new Error('Packet contains the same entity more than once.')
      entities.add(body.entity.id)
      const { contentHash, ...content } = body
      if (digest('context-body', content) !== contentHash) throw new Error('Context body fingerprint does not match.')
      for (const id of body.evidenceIds) references.add(id)
    }
    if (packet.evidence.length !== references.size || packet.evidence.some(proof => !references.has(proof.id)) || new Set(packet.evidence.map(proof => proof.id)).size !== packet.evidence.length) throw new Error('Packet evidence must contain only the exact returned entity and boundary references.')
  }

  /** Task and generic committed-event documents are safe to rebuild from the verified journal. */
  projection(): IndexDocument[] {
    const documents = [...this.records.values()].flatMap(task => this.taskDocuments(task)).concat(this.externalDocuments?.() ?? [])
    for (const record of this.archive.records()) {
      const payload = record.payload as Partial<TaskPayload> | null
      if (payload?.kind === 'task') {
        if (payload.operation === 'task read' && payload.task) documents.push(this.fileReceiptDocument(payload.task.id, record.requestId, record.receiptHash, payload.source ?? 'cli'))
        continue
      }
      documents.push({ id: record.operationId, kind: 'event', title: typeof payload?.kind === 'string' ? payload.kind : 'committed-event', text: canonicalJson(record.payload), activityAt: record.committedAt, data: { seq: record.seq, payload: record.payload } })
    }
    return documents
  }
  private taskDocuments(task: TaskRecord): IndexDocument[] {
    const documents: IndexDocument[] = [{ id: task.id, kind: 'task', title: task.title, text: [task.id, task.title, task.declaredSession ?? '', task.binding.modelRevision].join('\n'), activityAt: task.retentionBasisAt, expiresAt: task.expiresAt, data: this.summary(task) }]
    const directories = new Map<string, IndexDocument>()
    const briefs = new Map<string, IndexDocument>()
    for (const batch of task.batches) {
      documents.push({ id: batch.id, kind: 'batch', title: batch.operation, text: task.id, activityAt: batch.createdAt, data: { taskId: task.id, batch } })
      for (const directory of batch.result?.directories ?? []) {
        directories.set(`${task.id}:directory:${directory.parentId}`, { id: `${task.id}:directory:${directory.parentId}`, kind: 'entity', title: 'Expanded directory', text: directory.parentId ?? '', data: { taskId: task.id, batchId: batch.id, parentId: directory.parentId, childIds: directory.items.map(item => item.id), scope: 'direct-child-directory' } })
        for (const item of directory.items) briefs.set(`${task.id}:brief:${item.id}`, { id: `${task.id}:brief:${item.id}`, kind: 'entity', title: item.title, text: `${item.locator}\n${item.brief}`, data: { taskId: task.id, batchId: batch.id, entityId: item.id, scope: 'direct-child-brief' } })
      }
    }
    documents.push(...directories.values(), ...briefs.values())
    for (const body of task.packet.contexts) documents.push({ id: `${task.id}:${body.entity.id}`, kind: 'entity', title: body.entity.title, text: `${body.entity.locator}\n${body.entity.brief}`, data: { taskId: task.id, entityId: body.entity.id, contentHash: body.contentHash, scope: 'exact-entity' } })
    for (const skill of task.skillPlan?.skills ?? []) documents.push({ id: `${task.id}:${skill.id}`, kind: 'skill', title: skill.name, text: skill.description, data: { taskId: task.id, skill } })
    return documents
  }
  private fileReceiptDocument(taskId: string, requestId: string, receiptHash: string, source: 'cli' | 'web'): IndexDocument {
    return { id: `skill-read:${taskId}:${requestId}`, kind: 'event', title: 'task read', text: taskId, data: { taskId, requestId, receiptHash, source, observation: 'archived-receipt; inspect-success-and-item-errors' } }
  }
  private summary(task: TaskRecord) {
    return { id: task.id, title: task.title, binding: task.binding, createdAt: task.createdAt, lastReadAt: task.lastReadAt, retentionBasisAt: task.retentionBasisAt, expiresAt: task.expiresAt, closedAt: task.closedAt, contextCount: task.packet.contexts.length, skillCount: task.skillPlan?.skills.length ?? 0, completeness: 'complete', format: 'v1' }
  }
  private async ensureIndex(): Promise<void> {
    if (this.archive.status !== 'ready') throw new HarnessError('INDEX_UNAVAILABLE', 'The journal requires recovery; history discovery cannot claim full coverage.', { diagnostics: this.archive.diagnostics }, true)
    try {
      await this.index.ready()
      if (this.index.status.state !== 'ready' || this.index.status.seq !== this.archive.seq) await this.index.rebuild(this.projection(), this.archive.seq)
      this.indexProblem = undefined
    } catch (error) { this.indexProblem = error; throw new HarnessError('INDEX_UNAVAILABLE', 'The derived history index is unavailable; tasks remain accessible by known ID.', { cause: String(error) }, true) }
  }
  private task(id: string): TaskRecord {
    validateUuid(id, 'taskId')
    const task = this.records.get(id)
    if (!task) throw new HarnessError('NOT_FOUND', 'No task with this ID is archived in the selected worktree.', { taskId: id })
    return structuredClone(task)
  }
  private async verifyTask(task: TaskRecord): Promise<void> {
    const references = new Map<string, ArchiveReference>()
    for (const record of this.archive.records()) {
      const payload = record.payload as Partial<TaskPayload> | null
      if (payload?.kind !== 'task' || payload.task?.id !== task.id) continue
      for (const reference of record.archives) references.set(`${reference.kind}:${reference.hash}`, reference)
    }
    references.set(`snapshot:${task.modelSnapshotHash}`, { kind: 'snapshot', hash: task.modelSnapshotHash })
    for (const reference of references.values()) {
      if (reference.kind === 'snapshot') await this.archive.readSnapshot(reference.hash)
      else await this.archive.readBlob(reference.hash)
    }
  }
  async snapshot(taskId: string): Promise<ModelSnapshot> {
    await this.ready()
    const task = this.task(taskId)
    await this.verifyTask(task)
    const model = await this.archive.readSnapshot<ModelSnapshot>(task.modelSnapshotHash)
    if (model.revision !== task.binding.modelRevision || !Array.isArray(model.entities) || !Array.isArray(model.views)) throw new HarnessError('ARCHIVE_CORRUPT', 'The archived model snapshot does not match its task binding.')
    return model
  }
  async archivedTask(taskId: string, throughBatchId?: string): Promise<TaskRecord> {
    await this.ready()
    const task = this.task(taskId)
    await this.verifyTask(task)
    return this.atBatch(task, throughBatchId)
  }
  private atBatch(task: TaskRecord, batchId?: string): TaskRecord {
    if (!batchId) return structuredClone(task)
    validateUuid(batchId, 'batchId')
    const position = task.batches.findIndex(batch => batch.id === batchId)
    if (position < 0) throw new HarnessError('NOT_FOUND', 'The requested batch does not belong to this task.', { taskId: task.id, batchId })
    const batch = task.batches[position] as FrozenBatch
    const copy = structuredClone(task)
    copy.batches = copy.batches.slice(0, position + 1)
    copy.packet = structuredClone(batch.packet)
    copy.skillPlan = structuredClone(batch.skillPlan)
    copy.binding = structuredClone(batch.binding ?? task.binding)
    copy.catalog = structuredClone(batch.catalog ?? task.catalog)
    copy.lastReadAt = copy.batches.filter(item => (item.result?.contexts.length ?? 0) + (item.result?.directories.length ?? 0) > 0).at(-1)?.createdAt ?? null
    copy.retentionBasisAt = copy.lastReadAt ?? copy.createdAt
    copy.expiresAt = new Date(Date.parse(copy.retentionBasisAt) + RETENTION).toISOString()
    copy.updatedAt = batch.createdAt
    if (copy.closedAt && copy.closedAt > batch.createdAt) copy.closedAt = null
    return copy
  }
  private handoffData(task: TaskRecord, throughBatchId: string | null) {
    return { kind: 'handoff', status: 'complete', taskId: task.id, binding: task.binding, throughBatchId, completeness: 'complete', packet: task.packet, skillPlan: task.skillPlan, observation: 'archived-resources; understanding-and-execution-unknown' }
  }
  private active(task?: TaskRecord): void {
    if (!this.worktree.active || !this.worktree.available) throw new HarnessError('TARGET_CONFLICT', 'This worktree is inactive or unavailable; only archived reads are allowed.')
    if (task?.closedAt) throw new HarnessError('TASK_CLOSED', 'The context task is closed; create a new task to retrieve current context.')
    if (task && expired(task, this.instant())) throw new HarnessError('TASK_EXPIRED', 'This task has exceeded its 60-day activity window; create a new task.')
  }
  private async current(skillsRoot: string, withCatalog: boolean): Promise<{ model: ModelSnapshot; source: SourceState; catalog?: SkillCatalog }> {
    this.active()
    const config = validateContract<ProjectConfig>('project-config', await readJson(path.join(this.worktree.root, '.harness', 'project.json')))
    if (config.projectId !== this.worktree.projectId) throw new HarnessError('TARGET_CONFLICT', 'The live project identity differs from the registered worktree.')
    const [model, source, catalog] = await Promise.all([loadModel(this.worktree.root), this.source(skillsRoot), withCatalog ? scanSkills(skillsRoot) : Promise.resolve(undefined)])
    if (!source || !hashPattern.test(source.sourceScanRevision) || source.sourceVersion?.status === 'unknown' || !hashPattern.test(source.sourceVersion?.treeHash ?? '')) throw new HarnessError('SOURCE_CHANGED', 'A complete current source fingerprint is required before retrieving live context.', { source })
    if (catalog && (!catalog.valid || !catalog.revision)) throw new HarnessError('CATALOG_INVALID', 'The current skill directory is invalid.', { diagnostics: catalog.diagnostics })
    return { model, source, catalog }
  }
  private versions(task: TaskRecord, current: Awaited<ReturnType<TaskService['current']>>, catalog = false): void {
    if (task.binding.modelRevision !== current.model.revision) throw new HarnessError('VERSION_CONFLICT', 'The model changed; start a new task instead of appending current content to an old snapshot.')
    if (!same(task.binding.sourceVersion, current.source.sourceVersion) || task.binding.sourceScanRevision !== current.source.sourceScanRevision) throw new HarnessError('SOURCE_CHANGED', 'The source or its scan policy changed; start a new task.', { expected: { sourceVersion: task.binding.sourceVersion, sourceScanRevision: task.binding.sourceScanRevision }, current: current.source })
    if (catalog && task.binding.catalogRevision !== current.catalog!.revision) throw new HarnessError('CATALOG_CHANGED', 'The skill catalog changed; refresh this unselected task prompt before selection.')
  }
  private async replay(request: CommandRequest, scope: string, normalized: unknown, readOnly = false): Promise<Envelope | null> {
    if (readOnly && this.archive.status !== 'ready' && !this.archive.records().some(record => record.scope === scope && record.requestId === request.requestId)) return null
    const replay = await this.archive.replay<Envelope>(scope, request.requestId, normalized)
    if (!replay) return null
    return validateContract<Envelope>('response', { ...replay.receipt, replayed: true })
  }
  private async persist(request: CommandRequest, scope: string, normalized: unknown, task: TaskRecord, receipt: Envelope, references: ArchiveReference[] = []): Promise<Envelope> {
    const archives = new Map<string, ArchiveReference>(references.map(reference => [`${reference.kind}:${reference.hash}`, reference]))
    for (const reference of (task as FrozenTask).sourceArchives ?? []) archives.set(`${reference.kind}:${reference.hash}`, reference)
    archives.set(`snapshot:${task.modelSnapshotHash}`, { kind: 'snapshot', hash: task.modelSnapshotHash })
    for (const skill of task.skillPlan?.skills ?? []) for (const file of skill.files) archives.set(`blob:${file.hash}`, { kind: 'blob', hash: file.hash })
    let seq: number
    try {
      const lastAppliedSeq = this.archive.seq + 1
      const materialized = { schemaVersion: 1, lastAppliedSeq, task, contentHash: digest('task-projection', { lastAppliedSeq, task }) }
      const result = await this.archive.commit({ scope, requestId: request.requestId, request: normalized, payload: { kind: 'task', task, operation: request.operation, source: request.source ?? 'cli' } satisfies TaskPayload, receipt, archives: [...archives.values()], materializations: [{ path: `tasks/${task.id}.json`, content: materialized }] })
      seq = result.seq
      if (result.replayed) this.restore()
      else this.records.set(task.id, this.checkedTask(task))
      receipt = validateContract<Envelope>('response', { ...result.receipt, replayed: result.replayed })
    } catch (error) {
      // Commit may be durable even when replacing its derived task file failed.
      this.restore()
      throw error
    }
    try {
      if (this.index.status.state !== 'ready' || this.index.status.seq + 1 !== seq) await this.index.rebuild(this.projection(), this.archive.seq)
      else await this.index.project(seq, [...this.taskDocuments(task), ...(request.operation === 'task read' ? [this.fileReceiptDocument(task.id, request.requestId, digest('receipt', receipt), request.source ?? 'cli')] : [])])
      this.indexProblem = undefined
    } catch (error) { this.indexProblem = error }
    try { this.onCommit?.(seq) } catch { /* Notification failure cannot undo or replace a durable CLI receipt. */ }
    return receipt
  }
  private route(): string {
    return [
      `Skill Hub ${ROUTER_VERSION}`,
      "Use this response's structured taskId, binding, directory and catalog fields as the task-specific source; preserve the exact binding when selecting. Discover command options and request contracts through the installed CLI help.",
      'Select all necessary context and methods together in one task select request. Independent targets can be requested together; read UUIDs may cross hierarchy levels. Expand returns direct child briefs; read returns only the exact entity and boundary references. A directory count does not mean its full content was read.',
      'Skills are editable file references, not automatic dependencies or executed tools. Select actual catalog IDs with a reason; related entries are optional suggestions. Empty context and skill collections are valid when no extra resources are required. Read selected skill files later using their exact archived path and expectedHash; choosing or reading a skill does not execute it. The current agent continues its standard workflow; HarnessL3 does not start a model or agent.',
      'When retaining, editing, moving or deleting project documents, maintain affected model briefs, relationships and evidence with ordinary file tools, even without source-code changes. Preserve stable identities, repair current references and retain archived history; verify the actual phase scope before closing. Use established artifact and retention conventions for specs, local tickets, decisions, research and handoffs; distinguish durable project documents from temporary drafts and machine-local task journals. A .scratch path does not decide Git ownership. Read referenced document bodies explicitly when needed.',
      "In Git projects, version .harness/model/ (.c4 and .likec4, including specification and views), .harness/project.json, .harness/evidence.json and .harness/aliases.json with related source changes. Include referenced project documentation and project-owned skill files, attachments and licenses kept as real files in this repository. Keep machine-local data roots, registrations, task journals/history/snapshots and archived skill bytes, SQLite indexes, caches/layouts, logs, machine paths/configuration and access credentials out of Git; preserve user skills and history. Do not copy global skill libraries or follow symlinks/junctions to external targets for a commit. Review diffs and follow the user's existing commit authorization; this advice does not authorize staging, committing or pushing.",
    ].join('\n')
  }
  private entry(request: CommandRequest, task: TaskRecord): Envelope {
    return this.envelope(request, { kind: 'task-entry', status: 'complete', taskId: task.id, binding: task.binding, routerVersion: ROUTER_VERSION, routingPrompt: this.route(), directory: task.initialDirectory, catalog: task.catalog, observation: 'routing-material-produced; selection-not-recorded' })
  }
  private normalized(request: CommandRequest): { scope: string; value: Record<string, unknown>; input?: SelectionRequest | QueryRequest | FileReadRequest } {
    validateUuid(request.requestId, 'requestId')
    for (const [name, expected] of [['project', this.worktree.projectId], ['worktree', this.worktree.id]]) if (flag(request, name!) && flag(request, name!) !== expected) throw new HarnessError('TARGET_CONFLICT', 'The command target differs from this worktree service.')
    const operation = request.operation
    if (operation === 'task start') {
      const title = flag(request, 'title')?.trim()
      if (!title) throw new HarnessError('INVALID_ARGUMENT', 'A nonempty task title is required.')
      return { scope: `worktree:${this.worktree.id}`, value: { operation, title, session: flag(request, 'session') ?? null } }
    }
    if (operation === 'task list' || operation === 'history list') return { scope: `worktree:${this.worktree.id}`, value: { operation, flags: request.flags } }
    const taskId = request.positionals[0]
    validateUuid(taskId, 'taskId')
    const value: Record<string, unknown> = { operation, taskId }
    const schema = operation === 'task select' ? 'selection' : operation === 'context query' ? 'query' : operation === 'task read' ? 'file-read' : null
    let input: SelectionRequest | QueryRequest | FileReadRequest | undefined
    if (schema) {
      input = validateContract<SelectionRequest | QueryRequest | FileReadRequest>(schema, request.input)
      if (input.requestId !== request.requestId) throw new HarnessError('INVALID_ARGUMENT', 'The JSON requestId and command requestId differ.')
      value.input = input
    }
    const batch = flag(request, 'batch')
    if (batch) { validateUuid(batch, 'batchId'); value.batch = batch }
    if (operation === 'task read' && (input as FileReadRequest).throughBatchId && batch && (input as FileReadRequest).throughBatchId !== batch) throw new HarnessError('INVALID_ARGUMENT', 'The command batch and JSON throughBatchId must match.')
    return { scope: `task:${taskId}`, value, input }
  }
  private result(task: TaskRecord, model: ModelSnapshot, fields: QueryFields, batchId: string): BatchResult {
    const result: BatchResult = { batchId, directories: [], contexts: [], unchanged: [], errors: [], observation: 'reader-response-produced' }
    for (const id of fields.expand) {
      try { result.directories.push(modelDirectory(model, id)) }
      catch (error) { const failure = asHarnessError(error); result.errors.push({ operation: 'expand', id, code: failure.code, message: failure.message }) }
    }
    for (const id of fields.read) {
      try {
        const body = modelBody(model, id, task.binding.sourceVersion)
        const retained = task.packet.contexts.find(item => item.entity.id === id && item.contentHash === body.contentHash)
        if (fields.known[id] === body.contentHash && retained) result.unchanged.push({ id, contentHash: body.contentHash, reason: 'retained-in-this-task' })
        else result.contexts.push(body)
      } catch (error) { const failure = asHarnessError(error); result.errors.push({ operation: 'read', id, code: failure.code, message: failure.message }) }
    }
    return result
  }
  private addBatch(task: TaskRecord, request: CommandRequest, input: unknown, result: BatchResult, model: ModelSnapshot, at: string): void {
    const contexts = new Map(task.packet.contexts.map(body => [body.entity.id, body]))
    for (const body of result.contexts) contexts.set(body.entity.id, body)
    const evidenceIds = new Set([...contexts.values()].flatMap(body => body.evidenceIds))
    task.packet = { scope: 'returned-entities-only', contexts: [...contexts.values()], evidence: model.evidence.filter(proof => evidenceIds.has(proof.id)) }
    task.updatedAt = at
    if (result.directories.length || result.contexts.length) { task.lastReadAt = at; task.retentionBasisAt = at; task.expiresAt = new Date(Date.parse(at) + RETENTION).toISOString() }
    const batch: FrozenBatch = { id: result.batchId, requestId: request.requestId, operation: request.operation, request: input, result, createdAt: at, packet: structuredClone(task.packet), skillPlan: structuredClone(task.skillPlan), binding: structuredClone(task.binding), catalog: structuredClone(task.catalog), source: request.source ?? 'cli' }
    task.batches.push(batch)
  }

  async execute(request: CommandRequest, skills: string | (() => Promise<string>)): Promise<Envelope> {
    try {
      await this.ready()
      const normalized = this.normalized(request)
      const operation = request.operation
      const readOnly = ['task show', 'history show', 'task handoff', 'task list', 'history list', 'task read'].includes(operation)
      const prior = await this.replay(request, normalized.scope, normalized.value, readOnly)
      if (prior) return prior
      if (operation === 'task list' || operation === 'history list') return await this.list(request)
      if (['task show', 'history show', 'task handoff'].includes(operation)) {
        const task = await this.archivedTask(request.positionals[0], flag(request, 'batch'))
        const throughBatchId = task.batches.at(-1)?.id ?? null
        if (operation === 'task handoff') return this.envelope(request, this.handoffData(task, throughBatchId))
        return this.envelope(request, commandResult(operation, { task, throughBatchId, completeness: 'complete', expired: expired(task, this.instant()) }))
      }
      if (operation === 'task read') return await this.readFiles(request, normalized, '')
      this.active()
      const skillsRoot = typeof skills === 'string' ? skills : await skills()
      await this.beforeLive?.(skillsRoot)
      if (operation === 'task close') return await this.serial(async () => {
        const replay = await this.replay(request, normalized.scope, normalized.value)
        if (replay) return replay
        this.active()
        const task = this.task(request.positionals[0])
        await this.verifyTask(task)
        if (!task.closedAt) { task.closedAt = this.instant().toISOString(); task.updatedAt = task.closedAt }
        const receipt = this.envelope(request, commandResult(operation, { taskId: task.id, closedAt: task.closedAt, syncStatus: this.synchronization ? await this.synchronization() : { state: 'unknown' } }))
        return this.persist(request, normalized.scope, normalized.value, task, receipt)
      })
      if (operation === 'task start') return await this.start(request, normalized, skillsRoot)
      if (!['task prompt', 'task select', 'context query'].includes(operation)) throw new HarnessError('INVALID_ARGUMENT', 'Unknown task operation.', { operation })
      const initial = this.task(request.positionals[0])
      this.active(initial)
      await this.verifyTask(initial)
      if (operation === 'task prompt' && initial.skillPlan) throw new HarnessError('SELECTION_EXISTS', 'This task already has a skill plan; use task handoff.')
      if (operation === 'task select' && initial.skillPlan) throw new HarnessError('SELECTION_EXISTS', 'This task already has its one joint selection.')
      if (operation === 'task select') {
        const input = normalized.input as SelectionRequest
        if (input.binding.projectId !== this.worktree.projectId || input.binding.worktreeId !== this.worktree.id) throw new HarnessError('TARGET_CONFLICT', 'Selection binding belongs to another project or worktree.')
        if (input.binding.modelRevision !== initial.binding.modelRevision) throw new HarnessError('VERSION_CONFLICT', 'Selection model binding does not match the task entry.')
        if (!same(input.binding.sourceVersion, initial.binding.sourceVersion) || input.binding.sourceScanRevision !== initial.binding.sourceScanRevision) throw new HarnessError('SOURCE_CHANGED', 'Selection source binding does not match the task entry.')
        if (input.binding.catalogRevision !== initial.binding.catalogRevision) throw new HarnessError('CATALOG_CHANGED', 'Selection catalog binding does not match the latest unselected prompt.')
      }
      if (operation === 'context query' && (normalized.input as QueryRequest).expectedModelRevision !== initial.binding.modelRevision) throw new HarnessError('VERSION_CONFLICT', 'The query expectedModelRevision differs from the task binding.')
      const captured = await this.current(skillsRoot, operation !== 'context query')
      this.versions(initial, captured, operation === 'task select')
      const selected = operation === 'task select' ? captureSkills(captured.catalog!, (normalized.input as SelectionRequest).skills) : undefined
      return await this.serial(async () => {
        const replay = await this.replay(request, normalized.scope, normalized.value)
        if (replay) return replay
        const task = this.task(initial.id)
        this.active(task)
        if (task.skillPlan && (operation === 'task select' || operation === 'task prompt')) throw new HarnessError('SELECTION_EXISTS', 'This task already has its one joint selection; use handoff.')
        const current = await this.current(skillsRoot, operation !== 'context query')
        this.versions(task, current, operation === 'task select')
        if (current.model.revision !== captured.model.revision || !same(current.source.sourceVersion, captured.source.sourceVersion) || current.source.sourceScanRevision !== captured.source.sourceScanRevision) throw new HarnessError('SOURCE_CHANGED', 'Context changed before the batch could commit.')
        if (operation !== 'context query' && current.catalog!.revision !== captured.catalog!.revision) throw new HarnessError('CATALOG_CHANGED', 'The skill catalog changed before selection could commit.')
        if (operation === 'task prompt') {
          task.binding.catalogRevision = current.catalog!.revision!
          task.catalog = current.catalog!.skills
          task.updatedAt = this.instant().toISOString()
          return this.persist(request, normalized.scope, normalized.value, task, this.entry(request, task), current.source.archives)
        }
        const batchId = randomUUID()
        const query = operation === 'task select' ? (normalized.input as SelectionRequest).context : normalized.input as QueryRequest
        const result = this.result(task, captured.model, query, batchId)
        const references: ArchiveReference[] = [...current.source.archives ?? []]
        if (selected) {
          for (const bytes of selected.blobs.values()) references.push({ kind: 'blob', hash: await this.archive.blob(bytes) })
          task.skillPlan = { id: randomUUID(), batchId, routerVersion: ROUTER_VERSION, catalogRevision: task.binding.catalogRevision, skills: selected.skills, observation: 'selection-recorded; execution-unknown' }
        }
        this.addBatch(task, request, normalized.input, result, captured.model, this.instant().toISOString())
        let receipt: Envelope
        if (operation === 'context query' && !result.contexts.length && !result.directories.length && !result.unchanged.length) receipt = this.failure(request, new HarnessError('CONTEXT_TARGETS_FAILED', 'No requested context target could be returned.', { itemErrors: result.errors, batchId }))
        else if (operation === 'task select') receipt = this.envelope(request, { kind: 'selection', status: result.errors.length ? 'partial' : 'complete', taskId: task.id, binding: task.binding, result, skillPlan: task.skillPlan, packet: task.packet })
        else receipt = this.envelope(request, { kind: 'context-batch', status: result.errors.length ? 'partial' : 'complete', taskId: task.id, binding: task.binding, result })
        return this.persist(request, normalized.scope, normalized.value, task, receipt, references)
      })
    } catch (error) { return this.failure(request, error) }
  }
  private async start(request: CommandRequest, normalized: ReturnType<TaskService['normalized']>, skillsRoot: string): Promise<Envelope> {
    const captured = await this.current(skillsRoot, true)
    return this.serial(async () => {
      const replay = await this.replay(request, normalized.scope, normalized.value)
      if (replay) return replay
      const current = await this.current(skillsRoot, true)
      if (captured.model.revision !== current.model.revision) throw new HarnessError('VERSION_CONFLICT', 'The model changed while task creation was in progress.')
      if (!same(captured.source.sourceVersion, current.source.sourceVersion) || captured.source.sourceScanRevision !== current.source.sourceScanRevision) throw new HarnessError('SOURCE_CHANGED', 'The source changed while task creation was in progress.')
      if (captured.catalog!.revision !== current.catalog!.revision) throw new HarnessError('CATALOG_CHANGED', 'The skills changed while task creation was in progress.')
      const at = this.instant().toISOString()
      const modelSnapshotHash = await this.archive.snapshot('model', captured.model)
      const task: FrozenTask = { schemaVersion: 1, id: randomUUID(), title: String(normalized.value.title), binding: { ...this.target(), modelRevision: captured.model.revision, catalogRevision: captured.catalog!.revision!, sourceVersion: captured.source.sourceVersion, sourceScanRevision: captured.source.sourceScanRevision }, createdAt: at, updatedAt: at, lastReadAt: null, retentionBasisAt: at, expiresAt: new Date(Date.parse(at) + RETENTION).toISOString(), closedAt: null, declaredSession: typeof normalized.value.session === 'string' ? normalized.value.session : null, source: request.source ?? 'cli', initialDirectory: modelDirectory(captured.model), modelSnapshotHash, catalog: captured.catalog!.skills, batches: [], packet: emptyPacket(), skillPlan: null, sourceArchives: current.source.archives ?? [] }
      return this.persist(request, normalized.scope, normalized.value, task, this.entry(request, task))
    })
  }
  private async list(request: CommandRequest): Promise<Envelope> {
    await this.serial(() => this.ensureIndex())
    const limit = Number(flag(request, 'limit') ?? (request.operation === 'task list' ? 50 : 20))
    const offset = Number(flag(request, 'offset') ?? 0)
    const results = await this.index.search({ kind: 'task', query: flag(request, 'query'), from: flag(request, 'from'), to: flag(request, 'to'), limit, offset, now: this.instant().toISOString() })
    return this.envelope(request, commandResult(request.operation, { items: results.items.map(item => item.data), total: results.total, limit, offset, hasMore: results.hasMore, retentionDays: 60 }))
  }
  private async readFiles(request: CommandRequest, normalized: ReturnType<TaskService['normalized']>, _skillsRoot: string): Promise<Envelope> {
    const original = this.task(request.positionals[0])
    // Archive reads do not require the live checkout, skill directory, or an active task.
    const input = normalized.input as FileReadRequest
    const task = this.atBatch(original, flag(request, 'batch') ?? input.throughBatchId)
    const throughBatchId = task.batches.at(-1)?.id ?? null
    const files: { skillId: string; file: { path: string; hash: string; bytes: number; encoding: 'utf8' | 'base64'; content: string } }[] = []
    const errors: ItemError[] = []
    for (const requested of input.files) {
      try {
        const skill = task.skillPlan?.skills.find(item => item.id === requested.skillId)
        if (!skill) throw new HarnessError('SKILL_NOT_SELECTED', 'This skill was not selected by the requested batch boundary.')
        const file = skill.files.find(item => item.path === requested.path)
        if (!file) throw new HarnessError('FILE_NOT_ARCHIVED', 'This path is not in the selected skill archive.')
        if (file.hash !== requested.expectedHash) throw new HarnessError('HASH_MISMATCH', 'expectedHash differs from the selected archive reference.')
        const bytes = await this.archive.readBlob(file.hash)
        if (bytes.length !== file.bytes || sha256(bytes) !== file.hash || (file.encoding === 'utf8' && !Buffer.from(bytes.toString('utf8')).equals(bytes))) throw new HarnessError('ARCHIVE_CORRUPT', 'The archived skill encoding or byte count is invalid.')
        files.push({ skillId: skill.id, file: { ...file, content: bytes.toString(file.encoding) } })
      } catch (error) { const failure = asHarnessError(error); errors.push({ operation: 'skill-file', id: requested.skillId, path: requested.path, code: failure.code, message: failure.message }) }
    }
    const receipt = files.length ? this.envelope(request, { kind: 'skill-files', status: errors.length ? 'partial' : 'complete', taskId: task.id, throughBatchId, files, errors, observation: 'archived-files-returned; execution-unknown' }) : this.failure(request, new HarnessError('SKILL_FILES_FAILED', 'No requested archived skill file could be returned.', { itemErrors: errors, batchId: throughBatchId }))
    if (this.archive.status !== 'ready') return receipt
    return this.serial(async () => {
      const replay = await this.replay(request, normalized.scope, normalized.value, true)
      if (replay) return replay
      const latest = this.task(original.id)
      latest.updatedAt = this.instant().toISOString()
      return this.persist(request, normalized.scope, normalized.value, latest, receipt)
    })
  }
}
