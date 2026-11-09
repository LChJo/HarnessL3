import path from 'node:path'
import { lstat, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { WorkspaceRegistry } from './workspace.js'
import { SEED_ROOT } from './package.js'
import { loadModel } from './model.js'
import { scanSkills } from './skills.js'
import { Archive, type ArchiveReference } from './archive.js'
import { SearchIndex, type IndexDocument } from './index.js'
import { TaskService } from './context.js'
import { scanSource } from './source.js'
import { ObservationManager } from './observation.js'
import { FreshnessManager } from './freshness.js'
import { GarbageCollector, MigrationService } from './maintenance.js'
import { asHarnessError, HarnessError } from './errors.js'
import { canonicalPath, isWithin, samePath } from './paths.js'
import { flag, validateUuid } from '../cli/args.js'
import { validateContract } from './contract.js'
import { isErrno } from './io.js'
import type { CommandRequest } from '../cli/args.js'
import type { Envelope, FileReadRequest, ModelSnapshot, Target, WorktreeRecord } from './types.js'

export function commandResult(operation: string, result: unknown) { return { kind: 'command-result' as const, status: 'complete' as const, operation, result } }
interface WorktreeResources { worktree: WorktreeRecord; archive: Archive; index: SearchIndex; tasks: TaskService; observation: ObservationManager; freshness: FreshnessManager; migration: MigrationService }
export interface RecoveryStatus { state: 'not-started' | 'recovering' | 'complete' | 'degraded' | 'stopping'; totalWorktrees: number; completedWorktrees: number; failures: number }
const archivedOperations = new Set(['task show', 'history show', 'task handoff', 'task list', 'history list', 'task read'])
const taskOperations = new Set([...archivedOperations, 'task start', 'task prompt', 'task select', 'task close', 'context query'])
export class Runtime extends EventEmitter {
  readonly dataRoot: string
  private readonly resources = new Map<string, Promise<WorktreeResources>>()
  private readonly archives = new Map<string, Promise<Archive>>()
  private readonly lastValidModel = new Map<string, ModelSnapshot>()
  private bindingQueue: Promise<unknown> = Promise.resolve()
  private gcApplying = false
  private activeOperations = 0
  private startup?: Promise<void>
  private closing = false
  private readonly recovery: RecoveryStatus = { state: 'not-started', totalWorktrees: 0, completedWorktrees: 0, failures: 0 }
  private bindingSerial<T>(operation: () => Promise<T>): Promise<T> { const next = this.bindingQueue.then(operation); this.bindingQueue = next.catch(() => {}); return next }
  constructor(dataRoot: string) { super(); this.dataRoot = dataRoot }
  registry(request?: CommandRequest): WorkspaceRegistry { return new WorkspaceRegistry(this.dataRoot, { seedRoot: SEED_ROOT, skillsRoot: request?.skillsRoot }) }
  async preflight(): Promise<WorktreeRecord[]> {
    const worktrees = await this.registry().worktrees()
    for (const worktree of worktrees) {
      const root = await canonicalPath(worktree.root)
      if (isWithin(root, this.dataRoot) || isWithin(this.dataRoot, root)) throw new HarnessError('INVALID_ARGUMENT', 'The data root overlaps a registered worktree')
    }
    return worktrees
  }
  recoveryStatus(): RecoveryStatus { return { ...this.recovery } }
  ready(): Promise<void> {
    if (!this.startup) {
      this.recovery.state = 'recovering'
      this.startup = this.resume().catch(error => { this.recovery.state = 'degraded'; this.recovery.failures++; throw error })
    }
    return this.startup
  }
  private async resume(): Promise<void> {
    const worktrees = (await this.preflight()).filter(worktree => worktree.active && worktree.available)
    this.recovery.totalWorktrees = worktrees.length
    for (const worktree of worktrees) {
      if (this.closing) break
      try {
        // Resume explicit subscriptions after restart. No session discovery or log-directory scan occurs.
        try { await lstat(path.join(this.dataRoot, 'worktrees', worktree.id, 'journal.jsonl')) } catch (error) { if (isErrno(error, 'ENOENT')) continue; throw error }
        const archive = await this.worktreeArchive(worktree)
        if (archive.status !== 'ready') throw new HarnessError('ARCHIVE_CORRUPT', 'The worktree archive requires recovery')
        if (!this.closing && archive.hasKind('observation-state')) await this.bindingSerial(async () => {
          const current = await this.registry().worktree(worktree.id)
          if (!this.closing && current.active && current.available) await this.worktreeResources(current)
        })
      } catch (error) { this.recovery.failures++; this.emit('diagnostic', { worktreeId: worktree.id, code: asHarnessError(error).code }) }
      finally { this.recovery.completedWorktrees++ }
    }
    this.recovery.state = this.closing ? 'stopping' : this.recovery.failures ? 'degraded' : 'complete'
  }
  private worktreeArchive(worktree: WorktreeRecord): Promise<Archive> {
    let pending = this.archives.get(worktree.id)
    if (!pending) {
      const archive = new Archive(path.join(this.dataRoot, 'worktrees', worktree.id))
      pending = archive.ready().then(() => archive)
      this.archives.set(worktree.id, pending)
      const captured = pending
      pending.catch(() => { if (this.archives.get(worktree.id) === captured) this.archives.delete(worktree.id) })
    }
    return pending
  }
  async resolve(request: CommandRequest, allowInactive = false): Promise<WorktreeRecord> {
    return this.registry(request).resolve({ cwd: request.cwd, projectId: flag(request, 'project'), worktreeId: flag(request, 'worktree'), allowInactive })
  }
  async worktreeResources(worktree: WorktreeRecord): Promise<WorktreeResources> {
    if (this.closing) throw new HarnessError('BUSY', 'The runtime is stopping', {}, true)
    let pending = this.resources.get(worktree.id)
    if (!pending) {
      if (this.gcApplying) throw new HarnessError('BUSY', 'GC is applying its verified plan; retry opening this worktree.', {}, true)
      pending = this.openWorktree(worktree)
      this.resources.set(worktree.id, pending)
      pending.catch(() => { if (this.resources.get(worktree.id) === pending) this.resources.delete(worktree.id) })
    }
    let current = await pending
    if (!current.worktree.active && worktree.active) {
      const replacement = (async () => { await current.observation.close(); await current.freshness.close(); await current.tasks.close(); this.archives.delete(worktree.id); return this.openWorktree(worktree) })()
      this.resources.set(worktree.id, replacement)
      current = await replacement
    }
    // Registry activity/availability is resolved for each request; archived resources keep no live identity authority.
    Object.assign(current.worktree, worktree)
    return current
  }
  private async openWorktree(worktree: WorktreeRecord): Promise<WorktreeResources> {
    const record = { ...worktree }
    const root = path.join(this.dataRoot, 'worktrees', record.id)
    const archive = await this.worktreeArchive(worktree)
    const index = new SearchIndex(path.join(root, 'index.sqlite'))
    let freshness: FreshnessManager
    let migration: MigrationService
    let legacyDocuments: IndexDocument[] = []
    const refreshLegacyDocuments = async () => {
      legacyDocuments = (await migration.list()).filter(item => typeof item.retentionBasisAt === 'string' && typeof item.expiresAt === 'string').map(item => ({ id: item.id, kind: 'task', title: item.title, text: [item.id, item.title, item.declaredSession ?? ''].join('\n'), activityAt: item.retentionBasisAt, expiresAt: item.expiresAt, data: item }))
    }
    const tasks = new TaskService({
      worktree: record, archive, index,
      source: async skillsRoot => {
        await new WorkspaceRegistry(this.dataRoot, { seedRoot: SEED_ROOT, skillsRoot }).resolve({ cwd: this.dataRoot, worktreeId: record.id })
        const config = await this.registry().readConfig(record.root)
        const scanned = await scanSource(record, config, skillsRoot)
        if (!scanned.sourceScanRevision || !scanned.manifest || !scanned.policy || !scanned.ignoreRules || scanned.sourceVersion.status === 'unknown') throw new HarnessError('SOURCE_CHANGED', 'The current source cannot be fingerprinted completely.', { diagnostics: scanned.diagnostics, sourceVersion: scanned.sourceVersion }, true)
        const hashes = await Promise.all([
          archive.snapshot('source-manifest', scanned.manifest.content),
          archive.snapshot('source-scan-policy', scanned.policy.content),
          archive.snapshot('git-ignore-rules', scanned.ignoreRules.content),
          archive.snapshot('source-rule-bytes', scanned.ignoreRuleFiles),
        ])
        return { sourceVersion: scanned.sourceVersion, sourceScanRevision: scanned.sourceScanRevision, archives: hashes.map(hash => ({ kind: 'snapshot' as const, hash })) }
      },
      onCommit: seq => this.emit('commit', { worktreeId: record.id, seq, kind: 'task' }),
      beforeLive: async skillsRoot => { await freshness.status(skillsRoot) },
      syncStatus: () => freshness.currentState(),
      externalDocuments: () => legacyDocuments,
    })
    migration = new MigrationService({ worktree: record, archive, serial: operation => tasks.serial(operation), onCommit: async seq => { await refreshLegacyDocuments(); await index.rebuild(tasks.projection(), seq); this.emit('commit', { worktreeId: record.id, seq, kind: 'migration' }) } })
    freshness = new FreshnessManager({ worktree: record, archive, serial: operation => tasks.serial(operation), onCommit: seq => { this.emit('commit', { worktreeId: record.id, seq, kind: 'freshness' }) } })
    const observation = new ObservationManager({ worktree: record, archive, serial: operation => tasks.serial(operation), onCommit: () => { this.emit('commit', { worktreeId: record.id, seq: archive.seq, kind: 'observation' }) } })
    try { await archive.ready(); await refreshLegacyDocuments(); await tasks.ready(); await freshness.ready(); await observation.ready(); return { worktree: record, archive, index, tasks, observation, freshness, migration } }
    catch (error) { await index.close().catch(() => {}); throw error }
  }
  private async stopObservations(ids: string[]): Promise<void> {
    for (const id of ids) {
      const worktree = await this.registry().worktree(id)
      const resource = await this.worktreeResources(worktree)
      const { bindings } = await resource.observation.status()
      for (const binding of bindings) if (binding.stoppedAt === null) await resource.observation.unbind(binding.id, randomUUID())
      await resource.freshness.close()
      await resource.tasks.serial(async () => { resource.worktree.active = false })
    }
  }
  private async agentCommand(request: CommandRequest, resource: WorktreeResources): Promise<Envelope> {
    let result: unknown, replayed = false
    if (request.operation === 'agent status') {
      await resource.observation.poll()
      result = await resource.observation.status(flag(request, 'binding'))
    } else if (request.operation === 'agent unbind') {
      const response = await resource.observation.unbind(request.positionals[0], request.requestId)
      replayed = response.replayed; result = { bindings: response.bindings }
    } else {
      const agent = flag(request, 'agent') as 'codex' | 'claude-code', sessionId = flag(request, 'session')!, taskId = flag(request, 'task')
      const requestedLogFile = path.resolve(flag(request, 'log-file')!)
      const normalized = { operation: 'agent bind', agent, sessionId, logFile: requestedLogFile, taskId: taskId ?? null }
      const prior = await resource.archive.replay<{ bindings: unknown[] }>(`observation:${resource.worktree.id}`, request.requestId, normalized)
      if (prior) { replayed = true; result = prior.receipt }
      else {
        if (taskId) await resource.tasks.archivedTask(taskId)
        const logFile = await canonicalPath(requestedLogFile)
        const info = await stat(logFile)
        const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`
        for (const worktree of await this.registry().worktrees()) {
          if (worktree.id === resource.worktree.id) continue
          const other = this.archives.has(worktree.id) ? await this.archives.get(worktree.id)! : new Archive(path.join(this.dataRoot, 'worktrees', worktree.id), { readOnly: true })
          try { await lstat(path.join(other.root, 'journal.jsonl')) } catch (error) { if (isErrno(error, 'ENOENT')) continue; throw error }
          await other.ready()
          if (other.status !== 'ready') throw new HarnessError('ARCHIVE_CORRUPT', 'Cannot verify session ownership while another worktree journal requires recovery.', { worktreeId: worktree.id })
          const latest = new Map<string, { id: string; active: boolean; agent: string; sessionId: string; logFile: string; cursor: { sourceIdentity: string } }>()
          for (const record of other.scan({ kind: 'observation-state' })) {
            const payload = record.payload as { kind?: string; binding?: ReturnType<typeof latest.get> }
            if (payload?.kind === 'observation-state' && payload.binding) latest.set(payload.binding.id, payload.binding)
          }
          if ([...latest.values()].some(binding => binding.active && binding.agent === agent && binding.sessionId === sessionId && (samePath(binding.logFile, logFile) || binding.cursor.sourceIdentity === identity))) throw new HarnessError('TARGET_CONFLICT', 'This declared session and log identity are already bound to another worktree.', { worktreeId: worktree.id })
        }
        const response = await resource.observation.bind({ agent, sessionId, logFile: requestedLogFile, taskId, requestId: request.requestId })
        replayed = response.replayed; result = { bindings: response.bindings }
      }
    }
    return validateContract<Envelope>('response', { schemaVersion: 1, requestId: request.requestId, target: { projectId: resource.worktree.projectId, worktreeId: resource.worktree.id }, replayed, ok: true, data: commandResult(request.operation, result) })
  }
  private async legacyCommand(request: CommandRequest, resource: WorktreeResources): Promise<Envelope> {
    const target = { projectId: resource.worktree.projectId, worktreeId: resource.worktree.id }
    const taskId = request.positionals[0]
    if (['task show', 'history show', 'task handoff'].includes(request.operation)) return validateContract<Envelope>('response', { schemaVersion: 1, requestId: request.requestId, target, replayed: false, ok: true, data: await resource.migration.show(taskId, flag(request, 'batch')) })
    if (request.operation !== 'task read') throw new HarnessError('INVALID_ARGUMENT', 'Imported prototype tasks are read-only; start a formal task for new context requests.', { taskId, format: 'prototype-v0.16' })
    const input = validateContract<FileReadRequest>('file-read', request.input)
    if (input.requestId !== request.requestId) throw new HarnessError('INVALID_ARGUMENT', 'The command and file request IDs differ')
    const batch = flag(request, 'batch')
    if (batch && input.throughBatchId && batch !== input.throughBatchId) throw new HarnessError('INVALID_ARGUMENT', 'The command and file batch boundaries differ')
    const normalized = { operation: request.operation, taskId, input, batch: batch ?? null }
    return resource.tasks.serial(async () => {
      const prior = await resource.archive.replay<Envelope>(`task:${taskId}`, request.requestId, normalized)
      if (prior) return { ...prior.receipt, replayed: true }
      const data = await resource.migration.read(taskId, { files: input.files, throughBatchId: batch ?? input.throughBatchId })
      const returned = data.record.legacyRead as { files: { file: { hash: string } }[]; errors: unknown[] }
      const receipt: Envelope = returned.files.length ? { schemaVersion: 1, requestId: request.requestId, target, replayed: false, ok: true, data } : { schemaVersion: 1, requestId: request.requestId, target, replayed: false, ok: false, error: { code: 'SKILL_FILES_FAILED', message: 'No requested archived legacy skill file could be returned.', retryable: false, details: { itemErrors: returned.errors } } }
      validateContract('response', receipt)
      const references = new Map<string, ArchiveReference>()
      const add = (kind: ArchiveReference['kind'], hash: string) => references.set(kind + ':' + hash, { kind, hash })
      for (const commit of resource.archive.scan({ kind: 'legacy-migration' })) {
        const payload = commit.payload as { kind?: string; tasks?: { id: string; archiveHash: string; rawRefs: { rawHash: string }[] }[] }
        const archived = payload?.kind === 'legacy-migration' ? payload.tasks?.find(task => task.id === taskId) : undefined
        if (archived) { add('snapshot', archived.archiveHash); for (const raw of archived.rawRefs) add('snapshot', raw.rawHash) }
      }
      for (const file of returned.files) add('blob', file.file.hash)
      const committed = await resource.archive.commit({ scope: `task:${taskId}`, requestId: request.requestId, request: normalized, payload: { kind: 'legacy-read', taskId, source: request.source ?? 'cli', files: returned.files.map(item => item.file.hash), errors: returned.errors }, receipt, archives: [...references.values()] })
      try { await resource.index.rebuild(resource.tasks.projection(), committed.seq) } catch { /* A committed receipt remains authoritative if its derived index fails. */ }
      this.emit('commit', { worktreeId: resource.worktree.id, seq: committed.seq, kind: 'skill-read' })
      return { ...committed.receipt, replayed: committed.replayed }
    })
  }
  async view(worktreeId: string, taskId?: string, batchId?: string): Promise<unknown> {
    if (this.gcApplying) throw new HarnessError('BUSY', 'GC is applying its plan; retry this view.', {}, true)
    this.activeOperations++
    try { return await this.buildView(worktreeId, taskId, batchId) } finally { this.activeOperations-- }
  }
  private async buildView(worktreeId: string, taskId?: string, batchId?: string): Promise<unknown> {
    validateUuid(worktreeId, 'worktreeId')
    if (taskId) validateUuid(taskId, 'taskId')
    if (batchId) { validateUuid(batchId, 'batchId'); if (!taskId) throw new HarnessError('INVALID_ARGUMENT', 'A historical batch requires its task') }
    const worktree = await this.registry().resolve({ cwd: this.dataRoot, worktreeId, allowInactive: !!taskId })
    const resource = await this.worktreeResources(worktree)
    if (taskId && await resource.migration.has(taskId)) {
      const legacy = await resource.migration.show(taskId, batchId)
      return { schemaVersion: 1, target: { projectId: worktree.projectId, worktreeId }, worktree, seq: resource.archive.seq, historical: true, task: null, model: null, legacy, modelState: { state: 'unknown', currentRevision: null, displayRevision: legacy.binding.modelRevision, diagnostics: [] }, catalog: { root: null, revision: legacy.binding.catalogRevision, skills: [], valid: false, diagnostics: [], checkedAt: null }, freshness: { state: 'unknown', historical: true }, observation: { bindings: [], events: [] }, archive: resource.tasks.status() }
    }
    const task = taskId ? await resource.tasks.archivedTask(taskId, batchId) : null
    let model: ModelSnapshot | null = null
    let modelState: { state: 'valid' | 'invalid' | 'unknown'; currentRevision: string | null; displayRevision: string | null; diagnostics: unknown[] }
    if (task) {
      model = await resource.tasks.snapshot(task.id)
      modelState = { state: 'valid', currentRevision: null, displayRevision: model.revision, diagnostics: model.diagnostics }
    } else {
      try {
        model = await loadModel(worktree.root)
        this.lastValidModel.set(worktreeId, model)
        modelState = { state: 'valid', currentRevision: model.revision, displayRevision: model.revision, diagnostics: model.diagnostics }
      } catch (error) {
        const failure = asHarnessError(error)
        model = this.lastValidModel.get(worktreeId) ?? null
        if (!model) {
          for (const saved of resource.tasks.tasks().reverse()) {
            try { model = await resource.tasks.snapshot(saved.id); break } catch { /* A broken archive cannot become a fallback model. */ }
          }
        }
        modelState = { state: failure.code === 'MODEL_INVALID' ? 'invalid' : 'unknown', currentRevision: typeof failure.details.attemptedModelRevision === 'string' ? failure.details.attemptedModelRevision : null, displayRevision: model?.revision ?? null, diagnostics: Array.isArray(failure.details.diagnostics) ? failure.details.diagnostics : [{ code: failure.code, message: failure.message }] }
      }
    }
    let catalog: { root: string | null; revision: string | null; skills: unknown[]; valid: boolean; diagnostics: unknown[]; checkedAt: string | null }
    if (task) catalog = { root: null, revision: task.binding.catalogRevision, skills: task.catalog, valid: true, diagnostics: [], checkedAt: null }
    else {
      try {
        const loaded = await scanSkills(await this.registry().skillsRoot(worktree))
        catalog = { root: loaded.root, revision: loaded.revision, skills: loaded.skills, valid: loaded.valid, diagnostics: loaded.diagnostics, checkedAt: loaded.checkedAt }
      } catch (error) { const failure = asHarnessError(error); catalog = { root: null, revision: null, skills: [], valid: false, diagnostics: [{ code: failure.code, message: failure.message }], checkedAt: null } }
    }
    const observation = await resource.observation.status()
    const freshness = task ? { state: 'unknown', historical: true, sourceVersion: task.binding.sourceVersion } : await resource.freshness.status(await this.registry().skillsRoot(worktree))
    return { schemaVersion: 1, target: { projectId: worktree.projectId, worktreeId }, worktree, seq: resource.archive.seq, historical: !!taskId, task, model, modelState, catalog, freshness, observation, archive: resource.tasks.status() }
  }
  async execute(request: CommandRequest): Promise<Envelope> {
    let target: Target | null = null
    if (this.gcApplying) return { schemaVersion: 1, requestId: request.requestId, target, replayed: false, ok: false, error: { code: 'BUSY', message: 'GC is applying its verified plan; retry this command.', retryable: true, details: {} } }
    this.activeOperations++
    try {
      const registry = this.registry(request)
      if (request.operation.startsWith('sync ')) {
        const worktree = await this.resolve(request)
        target = { projectId: worktree.projectId, worktreeId: worktree.id }
        const resource = await this.worktreeResources(worktree)
        const skillsRoot = await registry.skillsRoot(worktree)
        let result: unknown, replayed = false
        if (request.operation === 'sync status') result = await resource.freshness.status(skillsRoot)
        else { const verified = await resource.freshness.verify(request.input, skillsRoot, request.requestId); const { replayed: replay, ...state } = verified; replayed = replay; result = state }
        return validateContract<Envelope>('response', { schemaVersion: 1, requestId: request.requestId, target, replayed, ok: true, data: commandResult(request.operation, result) })
      }
      if (request.operation.startsWith('agent ')) {
        const worktree = await this.resolve(request, request.operation === 'agent status')
        target = { projectId: worktree.projectId, worktreeId: worktree.id }
        const resource = await this.worktreeResources(worktree)
        return await this.bindingSerial(() => this.agentCommand(request, resource))
      }
      if (taskOperations.has(request.operation)) {
        const worktree = await this.resolve(request, true)
        target = { projectId: worktree.projectId, worktreeId: worktree.id }
        const resource = await this.worktreeResources(worktree)
        const taskId = request.positionals[0]
        if (taskId && await resource.migration.has(taskId)) return await this.legacyCommand(request, resource)
        const skillsRoot = archivedOperations.has(request.operation) ? request.skillsRoot ?? path.join(this.dataRoot, 'skills') : () => registry.skillsRoot(worktree)
        return resource.tasks.execute(request, skillsRoot)
      }
      const id = request.positionals[0]
      let result: unknown
      switch (request.operation) {
        case 'gc': {
          if (request.flags.apply && this.recovery.state === 'recovering') throw new HarnessError('BUSY', 'Archive recovery is still in progress; retry cleanup after recovery', {}, true)
          const collector = new GarbageCollector({ dataRoot: this.dataRoot, worktrees: await registry.worktrees(), isLeased: file => {
            if (this.activeOperations > 1) return true
            for (const id of this.resources.keys()) if (isWithin(path.join(this.dataRoot, 'worktrees', id), file)) return true
            return false
          } })
          this.gcApplying = request.flags.apply === true
          try { result = await collector.run({ mode: request.flags.apply ? 'apply' : 'dry-run' }) } finally { this.gcApplying = false }
          break
        }
        case 'migrate prototype': {
          const worktree = await this.resolve(request)
          target = { projectId: worktree.projectId, worktreeId: worktree.id }
          const mode = request.flags.apply ? 'apply' : 'dry-run'
          const migration = mode === 'apply' ? (await this.worktreeResources(worktree)).migration : new MigrationService({ worktree, archive: new Archive(path.join(this.dataRoot, 'worktrees', worktree.id), { readOnly: true }), serial: operation => operation() })
          const { replayed, ...migrated } = await migration.run({ source: path.resolve(request.cwd, flag(request, 'from')!), mode, requestId: request.requestId })
          return validateContract<Envelope>('response', { schemaVersion: 1, requestId: request.requestId, target, replayed, ok: true, data: commandResult(request.operation, migrated) })
        }
        case 'init': {
          const initialized = await registry.init(request.cwd, flag(request, 'name'))
          target = { projectId: initialized.worktree.projectId, worktreeId: initialized.worktree.id }
          const model = await loadModel(initialized.worktree.root)
          const modelCreated = initialized.createdFiles.some(file => /\.(?:c4|likec4)$/.test(file))
          result = { ...initialized, initialization: {
            stage: 'scaffold-ready', semanticStatus: 'not-assessed', modelCreated,
            nextAction: modelCreated ? 'model-project' : 'review-project-model',
            model: { objects: model.entities.filter(entity => entity.entityType === 'object').length, relations: model.entities.filter(entity => entity.entityType === 'relation').length, views: model.views.length },
            agentGuidance: 'Use the current agent and existing file tools to inspect the project and author or review LikeC4 objects, relationships and evidence. Report reading, modeling and validation progress. Check the model and structure views before reporting project initialization complete, and disclose unmodeled scope.',
          } }; break
        }
        case 'project register': result = await registry.register(path.resolve(request.cwd, id)); break
        case 'project list': result = { items: await registry.projects() }; break
        case 'project show': { const project = await registry.project(id); result = { project, paths: { config: project.configPath } }; break }
        case 'project unregister': result = await this.bindingSerial(async () => { await this.stopObservations((await registry.worktrees(id)).map(item => item.id)); return registry.unregisterProject(id) }); break
        case 'worktree register': {
          const registered = await registry.register(path.resolve(request.cwd, id))
          target = { projectId: registered.worktree.projectId, worktreeId: registered.worktree.id }
          result = { worktree: registered.worktree }; break
        }
        case 'worktree list': result = { items: await registry.worktrees(flag(request, 'project')) }; break
        case 'worktree show': { const worktree = await registry.worktree(id); result = { worktree }; target = { projectId: worktree.projectId, worktreeId: worktree.id }; break }
        case 'worktree unregister': result = await this.bindingSerial(async () => { await this.stopObservations([id]); return registry.unregisterWorktree(id) }); break
        case 'model validate': {
          const worktree = await this.resolve(request)
          target = { projectId: worktree.projectId, worktreeId: worktree.id }
          const model = await loadModel(worktree.root)
          result = { valid: true, modelRevision: model.revision, objectCount: model.entities.filter(entity => entity.entityType === 'object').length, relationCount: model.entities.filter(entity => entity.entityType === 'relation').length, diagnostics: model.diagnostics }; break
        }
        case 'web open': {
          try { const worktree = await this.resolve(request, true); target = { projectId: worktree.projectId, worktreeId: worktree.id } }
          catch (error) { if (!(error instanceof HarnessError) || error.code !== 'TARGET_REQUIRED' || flag(request, 'worktree') || flag(request, 'project') || flag(request, 'task')) throw error }
          result = { target }; break
        }
        case 'skills list': case 'skills refresh': {
          let root = request.skillsRoot ?? path.join(this.dataRoot, 'skills')
          try {
            const worktree = await this.resolve(request)
            target = { projectId: worktree.projectId, worktreeId: worktree.id }
            root = await registry.skillsRoot(worktree)
          } catch (error) { if (!(error instanceof HarnessError) || error.code !== 'TARGET_REQUIRED' || flag(request, 'worktree') || flag(request, 'project')) throw error }
          const catalog = await scanSkills(root)
          result = { root: catalog.root, revision: catalog.revision, skills: catalog.skills, diagnostics: catalog.diagnostics, checkedAt: catalog.checkedAt, valid: catalog.valid }; break
        }
        default: throw new HarnessError('INVALID_ARGUMENT', 'This command has not yet been connected to the formal runtime', { operation: request.operation })
      }
      return validateContract<Envelope>('response', { schemaVersion: 1, requestId: request.requestId, target, replayed: false, ok: true, data: commandResult(request.operation, result) })
    } catch (error) {
      const failure = asHarnessError(error)
      return { schemaVersion: 1, requestId: request.requestId, target, replayed: failure.details.replayed === true, ok: false, error: { code: failure.code, message: failure.message, retryable: failure.retryable, details: failure.details } }
    } finally { this.activeOperations-- }
  }
  async close(): Promise<void> {
    this.closing = true
    this.recovery.state = 'stopping'
    await this.startup?.catch(() => {})
    await this.bindingQueue.catch(() => {})
    const settled = await Promise.allSettled([...this.resources.values()])
    await Promise.all(settled.flatMap(result => result.status === 'fulfilled' ? [result.value.observation.close()] : []))
    await Promise.all(settled.flatMap(result => result.status === 'fulfilled' ? [result.value.freshness.close()] : []))
    await Promise.all(settled.flatMap(result => result.status === 'fulfilled' ? [result.value.tasks.close()] : []))
    this.resources.clear()
    this.archives.clear()
  }
}
