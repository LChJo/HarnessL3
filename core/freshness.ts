import { watch, type FSWatcher } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { execFile as callbackExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { Archive, type ArchiveReference } from './archive.js';
import { HarnessError } from './errors.js';
import { validateContract } from './contract.js';
import { canonicalJson } from './json.js';
import { loadModel } from './model.js';
import { readConfig } from './workspace.js';
import { resolveInside, safeRelative } from './paths.js';
import { isErrno } from './io.js';
import { scanSource, observeSourcePaths, changedSourcePaths, isSourcePathIncluded, type SourceObservation, type SourceScan, type SourceManifest, type SourcePolicy, type IgnoreRules, type IgnoreRuleFile } from './source.js';
import type { Diagnostic, ModelSnapshot, SourceVersion, Target, WorktreeRecord } from './types.js';

const execFile = promisify(callbackExecFile);
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();
const prefix = (parent: string, child: string) => child === parent || child.startsWith(parent + '/');
const referenceKey = (relative: string) => process.platform === 'win32' ? relative.toLowerCase() : relative;
const evidenceFailures = new Set(['EVIDENCE_CHANGED', 'EVIDENCE_MISSING', 'EVIDENCE_UNREADABLE']);
function referencedEvidenceProblems(model: ModelSnapshot): Diagnostic[] {
  const referenced = new Set(model.entities.flatMap(entity => entity.evidenceIds));
  return model.diagnostics.filter(item => item.evidenceId && referenced.has(item.evidenceId) && evidenceFailures.has(item.code ?? ''));
}
type FreshnessKind = 'unknown' | 'pending' | 'verifying' | 'verified' | 'failed';
interface SourceReferences { manifest: string; policy: string; ignoreRules: string; ruleBytes: string }
interface CompleteSource { sourceVersion: SourceVersion; sourceScanRevision: string; references: SourceReferences }
export interface FreshnessState {
  schemaVersion: 1; target: Target; state: FreshnessKind; sourceEpoch: number; sourceVersion: SourceVersion;
  sourceScanRevision: string | null; modelRevision: string | null; attemptedModelRevision: string | null;
  modelState: 'unknown' | 'parsing' | 'valid' | 'invalid'; pendingPaths: string[]; modelPending: boolean; scanPending: boolean;
  proofId: string | null; verifiedAt: string | null; lastCheckedAt: string | null; diagnostics: Diagnostic[];
  lastCompleteSource: CompleteSource | null; lastValidModelSnapshotHash: string | null;
  sourceObservation?: SourceObservation;
}
interface SyncProof {
  schemaVersion: 1; requestId: string; target: Target; phaseId: string; sourceEpoch: number;
  expectedSourceVersion: SourceVersion; expectedModelRevision: string; scope: { paths: string[]; entities: string[] };
  disposition: 'updated' | 'no-semantic-change' | 'unresolved'; reason: string;
  checks: { name: string; status: 'passed' | 'failed' | 'unknown'; evidence: string[] }[];
}
export interface VerificationResult extends FreshnessState {
  declaration: SyncProof; automaticChecks: { name: string; status: 'passed' | 'failed'; scope: string[] }[];
  replayed: boolean; seq: number;
}
interface VerifyReceipt { result: Omit<VerificationResult, 'replayed' | 'seq'>; error: { code: string; message: string } | null }
interface Capture { source: SourceScan; model: ModelSnapshot | null; modelDiagnostics: Diagnostic[]; attemptedModelRevision: string | null; epoch: number; generation: number }
interface Options {
  worktree: WorktreeRecord; archive: Archive; serial: <T>(operation: () => Promise<T>) => Promise<T>;
  onCommit?: (seq: number) => void; now?: () => Date; pollIntervalMs?: number;
  background?: (operation: () => Promise<void>) => Promise<void>;
}

/** Records scoped declarations and mechanical checks; it never infers semantics. */
export class FreshnessManager {
  private readonly worktree: WorktreeRecord;
  private readonly archive: Archive;
  private readonly serial: Options['serial'];
  private readonly onCommit?: Options['onCommit'];
  private readonly now: () => Date;
  private readonly pollIntervalMs: number;
  private state: FreshnessState;
  private lastScan: SourceScan | null = null;
  private referencePaths = new Map<string, Set<string>>();
  private referenceTargets = new Map<string, string>();
  private loading?: Promise<void>;
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private debounce?: NodeJS.Timeout;
  private activeSkillsRoot?: string;
  private running?: Promise<void>;
  private readonly classifiers = new Set<Promise<void>>();
  private readonly writes = new Set<Promise<unknown>>();
  private closed = false;
  private closing?: Promise<void>;
  private changeGeneration = 0;
  private observedWrite?: Promise<unknown>;
  private readonly refreshes = new Map<string, Promise<FreshnessState>>();
  private readonly dirtyPaths = new Set<string>();
  private fullRequired = true;
  private lastFullCheck = 0;
  private observedModel: ModelSnapshot | null = null;
  private watchHealthy = false;
  private watchDiagnostic?: Diagnostic;
  private readonly background: NonNullable<Options['background']>;

  constructor(options: Options) {
    this.worktree = options.worktree; this.archive = options.archive; this.serial = options.serial;
    this.onCommit = options.onCommit; this.now = options.now ?? (() => new Date());
    this.pollIntervalMs = Math.max(100, options.pollIntervalMs ?? 2000);
    this.background = options.background ?? (operation => operation());
    this.state = {
      schemaVersion: 1, target: { projectId: options.worktree.projectId, worktreeId: options.worktree.id }, state: 'unknown', sourceEpoch: 0,
      sourceVersion: { head: null, treeHash: null, status: 'unknown' }, sourceScanRevision: null, modelRevision: null, attemptedModelRevision: null,
      modelState: 'unknown', pendingPaths: [], modelPending: true, scanPending: true, proofId: null, verifiedAt: null, lastCheckedAt: null,
      diagnostics: [], lastCompleteSource: null, lastValidModelSnapshotHash: null,
    };
  }

  ready(): Promise<void> { return this.loading ??= this.restore(); }
  currentState(): FreshnessState { return structuredClone(this.state); }
  currentModel(): ModelSnapshot | null { return structuredClone(this.observedModel); }
  private instant(): string {
    const current = this.now();
    if (!(current instanceof Date) || !Number.isFinite(current.getTime())) throw new HarnessError('INTERNAL_ERROR', 'The synchronization clock must return a valid Date.');
    return current.toISOString();
  }

  private async restore(): Promise<void> {
    await this.archive.ready();
    for (const record of this.archive.scan({ kind: 'freshness-state' })) {
      const payload = record.payload as { kind?: string; state?: FreshnessState; stateHash?: string } | null;
      if (payload?.kind !== 'freshness-state') continue;
      if (payload.stateHash !== undefined && (typeof payload.stateHash !== 'string' || !/^[a-f0-9]{64}$/.test(payload.stateHash))) throw new HarnessError('ARCHIVE_CORRUPT', 'A synchronization state reference is invalid.');
      let state = payload.state;
      try { state ??= payload.stateHash ? await this.archive.readSnapshot<FreshnessState>(payload.stateHash) : undefined; }
      catch (error) { if (this.archive.status !== 'ready') break; throw error; }
      if (!state || state.schemaVersion !== 1 || !same(state.target, this.state.target) || !Number.isSafeInteger(state.sourceEpoch) || state.sourceEpoch < this.state.sourceEpoch || !Array.isArray(state.pendingPaths)) {
        throw new HarnessError('ARCHIVE_CORRUPT', 'A synchronization record has an invalid identity or source epoch.');
      }
      this.state = structuredClone(state);
    }
    if (this.archive.status !== 'ready') {
      this.state.state = 'unknown'; this.state.scanPending = true; this.state.modelState = 'unknown';
      this.state.diagnostics = [{ code: 'ARCHIVE_CORRUPT', severity: 'error', message: 'Synchronization archives need recovery; independently intact history remains read-only.' }];
      return;
    }
    const last = this.state.lastCompleteSource;
    if (last) {
      this.lastScan = {
        sourceVersion: structuredClone(last.sourceVersion), sourceScanRevision: last.sourceScanRevision, diagnostics: [],
        manifest: { schemaVersion: 1, kind: 'source-manifest', content: await this.archive.readSnapshot<SourceManifest['content']>(last.references.manifest) },
        policy: { schemaVersion: 1, kind: 'source-scan-policy', content: await this.archive.readSnapshot<SourcePolicy['content']>(last.references.policy) },
        ignoreRules: { schemaVersion: 1, kind: 'git-ignore-rules', content: await this.archive.readSnapshot<IgnoreRules['content']>(last.references.ignoreRules) },
        ignoreRuleFiles: await this.archive.readSnapshot<IgnoreRuleFile[]>(last.references.ruleBytes),
      };
    }
    if (this.state.lastValidModelSnapshotHash) {
      this.observedModel = await this.archive.readSnapshot<ModelSnapshot>(this.state.lastValidModelSnapshotHash);
      await this.rememberModel(this.observedModel);
    }
    // A stopped watcher cannot attest to the downtime. Retain the actual epoch,
    // but require a new declaration before treating an old proof as current.
    if (this.state.lastCompleteSource) {
      this.state.state = 'pending'; this.state.scanPending = true;
      this.state.pendingPaths = sorted([...this.state.pendingPaths, ...(this.lastScan?.manifest?.content.entries.map(entry => entry.path) ?? [])]);
    }
  }

  private async resolvedRelative(relative: string): Promise<string> {
    const actual = await resolveInside(this.worktree.root, relative, { allowMissing: true });
    return path.relative(this.worktree.root, actual).split(path.sep).join('/');
  }

  private async rememberModel(model: ModelSnapshot): Promise<void> {
    const referenced = new Set(model.entities.flatMap(entity => entity.evidenceIds));
    const local = sorted(model.evidence.flatMap(evidence => referenced.has(evidence.id) && 'path' in evidence.location ? [evidence.location.path] : []));
    const locations = await Promise.all(local.map(async relative => {
      let target: string | undefined;
      try { target = await this.resolvedRelative(relative); }
      catch { target = this.referenceTargets.get(relative); } // Retain the last safe target while a link is missing or unreadable.
      return { relative, target };
    }));
    const paths = new Map<string, Set<string>>(), targets = new Map<string, string>();
    const add = (location: string, relative: string) => {
      const parts = location.split('/');
      for (let length = 1; length <= parts.length; length++) {
        const ancestor = referenceKey(parts.slice(0, length).join('/'));
        const references = paths.get(ancestor) ?? new Set<string>();
        references.add(relative);
        paths.set(ancestor, references);
      }
    };
    for (const { relative, target } of locations) {
      add(relative, relative);
      if (target) { add(target, relative); targets.set(relative, target); }
    }
    this.referencePaths = paths;
    this.referenceTargets = targets;
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.writes.add(promise);
    void promise.finally(() => this.writes.delete(promise)).catch(() => {});
    return promise;
  }

  private references(): ArchiveReference[] {
    const hashes = this.state.lastCompleteSource ? Object.values(this.state.lastCompleteSource.references) : [];
    if (this.state.lastValidModelSnapshotHash) hashes.push(this.state.lastValidModelSnapshotHash);
    return sorted(hashes).map(hash => ({ kind: 'snapshot', hash }));
  }

  private async persist(reason: string, proof?: SyncProof, receipt?: VerifyReceipt): Promise<{ seq: number; receipt: VerifyReceipt | FreshnessState }> {
    const captured = this.currentState();
    const archives = this.references();
    // Ordinary state commits already archive this exact receipt. Reference its
    // bytes rather than repeating the entire pending-path set in every journal row.
    const stateHash = await this.archive.snapshot('receipt', captured);
    archives.push({ kind: 'snapshot', hash: stateHash });
    if (proof) archives.push({ kind: 'snapshot', hash: await this.archive.snapshot('sync-proof', proof) });
    const result = await this.archive.commit({
      scope: proof ? 'sync-verify:' + this.worktree.id : 'freshness-state:' + this.worktree.id,
      requestId: proof?.requestId ?? randomUUID(), request: proof ?? { reason, state: captured },
      payload: { kind: 'freshness-state', stateHash, reason, declaration: proof ?? null }, receipt: receipt ?? captured, archives,
    });
    this.onCommit?.(result.seq);
    return { seq: result.seq, receipt: result.receipt };
  }

  private persistObserved(reason: string): void {
    if (this.closed || this.observedWrite) return;
    let capturedFacts: string | undefined;
    const pending = this.track(this.serial(async () => { capturedFacts = this.facts(); return this.persist(reason); }));
    this.observedWrite = pending;
    void pending.then(() => {
      this.observedWrite = undefined;
      // Burst notifications may share one durable state, but an event arriving
      // during the write still gets a subsequent commit with the newer epoch.
      if (!this.closed && capturedFacts !== this.facts()) this.persistObserved('observed-after-commit');
    }, () => {
      this.observedWrite = undefined;
      this.state.state = 'unknown'; this.state.scanPending = true;
      this.state.diagnostics = [{ code: 'FRESHNESS_PERSIST_FAILED', severity: 'error', message: 'Observed changes could not be committed; synchronization remains unknown.' }];
    });
  }

  private activate(skillsRoot: string): void {
    this.activeSkillsRoot = skillsRoot;
    if (this.closed || this.watcher || !this.worktree.active || !this.worktree.available) return;
    try {
      this.watcher = watch(this.worktree.root, { recursive: true, persistent: false, encoding: 'buffer' }, (_event, filename) => {
        if (this.closed) return;
        if (filename === null) { this.gap(); return; }
        let relative: string;
        try {
          // Native recursive watchers can return a decoded string despite encoding: 'buffer'.
          const decoded = typeof filename === 'string' ? filename : new TextDecoder('utf-8', { fatal: true }).decode(filename);
          relative = decoded.split(path.sep).join('/'); safeRelative(relative);
        }
        catch { this.gap(); return; }
        this.watchEvent(relative);
      });
      this.watchHealthy = true; this.watchDiagnostic = undefined;
      this.watcher.on('error', () => {
        this.watcher?.close(); this.watcher = undefined; this.watchHealthy = false;
        this.watchDiagnostic = { code: 'SOURCE_WATCH_ERROR', severity: 'error', message: 'Source watcher coverage is incomplete; reconciliation remains active.' };
        this.gap();
        this.state.state = 'unknown'; this.state.scanPending = true;
        this.state.diagnostics = [this.watchDiagnostic];
        this.persistObserved('watch-error');
      });
    } catch {
      this.watchHealthy = false;
      this.watchDiagnostic = { code: 'SOURCE_WATCH_UNAVAILABLE', severity: 'warning', message: 'Native source watching is unavailable; periodic reconciliation remains active.' };
      this.state.diagnostics = [this.watchDiagnostic];
    }
    this.timer ??= setInterval(() => this.schedule(0), this.pollIntervalMs);
    this.timer.unref();
  }

  private schedule(milliseconds = 150): void {
    if (this.closed || !this.activeSkillsRoot || this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      if (this.running || this.closed || !this.activeSkillsRoot) return;
      const root = this.activeSkillsRoot;
      this.running = this.background(async () => { if (!this.closed) await this.observe(root); }).catch(() => undefined).finally(() => {
        this.running = undefined;
        if (this.dirtyPaths.size) this.schedule();
      });
    }, milliseconds);
    this.debounce.unref();
  }

  private watchEvent(relative: string): void {
    if (prefix('.git', relative)) { this.gap(); return; }
    const referenced = this.referencePaths.get(referenceKey(relative));
    if (referenced) this.markReferences(referenced);
    if (prefix('.harness', relative)) {
      if (relative === '.harness/project.json') { this.gap(); return; }
      if (prefix('.harness/model', relative) || ['.harness/evidence.json', '.harness/aliases.json'].includes(relative)) {
        this.fullRequired = true; this.changeGeneration++; this.state.modelPending = true; this.state.modelState = 'parsing'; this.state.state = 'pending'; this.state.scanPending = true;
        this.persistObserved('model-event'); this.schedule();
      }
      return;
    }
    if (referenced) return;
    if (this.lastScan?.policy && !isSourcePathIncluded(relative, this.lastScan.policy)) return;
    if (relative.split('/').at(-1) === '.gitignore' && !this.lastScan?.ignoredDirectoryPrefixes?.some(ignored => prefix(ignored, relative))) { this.fullRequired = true; this.markSource([relative]); return; }
    if (this.lastScan?.manifest?.content.entries.some(entry => prefix(relative, entry.path))) { this.markSource([relative]); return; }
    // Keep native Git's last observed directory classification after deletion;
    // checking a missing `build` as a file loses a `build/` ignore rule.
    if (this.lastScan?.ignoredDirectoryPrefixes?.some(ignored => prefix(ignored, relative))) return;
    const pending = this.classifyNewPath(relative).finally(() => this.classifiers.delete(pending));
    this.classifiers.add(pending);
    void pending.catch(() => {});
  }

  private markReferences(references: Iterable<string>): void {
    // Directory notifications invalidate the affected evidence files, not an
    // extra ancestor scope that a file-level declaration could never clear.
    this.markSource(references);
    this.state.modelPending = true;
  }

  private markSource(paths: Iterable<string>): void {
    if (this.closed) return;
    if (this.state.sourceEpoch >= Number.MAX_SAFE_INTEGER) { this.state.state = 'unknown'; return; }
    this.changeGeneration++; this.state.sourceEpoch++; this.state.state = 'pending'; this.state.scanPending = true;
    this.state.pendingPaths = sorted([...this.state.pendingPaths, ...paths]);
    for (const relative of paths) this.dirtyPaths.add(relative);
    this.persistObserved('source-event'); this.schedule();
  }

  private async classifyNewPath(relative: string): Promise<void> {
    try {
      await resolveInside(this.worktree.root, relative, { allowMissing: true });
      let directory = false;
      try { directory = (await lstat(path.join(this.worktree.root, ...relative.split('/')))).isDirectory(); }
      catch (error) { if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTDIR')) throw error; }
      const environment: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
      for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM']) delete environment[key];
      try {
        await execFile('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', this.worktree.root, 'check-ignore', '--no-index', '--quiet', '--', relative + (directory ? '/' : '')], { env: environment, windowsHide: true });
        if (directory && this.lastScan) this.lastScan.ignoredDirectoryPrefixes = sorted([...(this.lastScan.ignoredDirectoryPrefixes ?? []), relative]);
        return;
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 1)) throw error;
      }
      if (directory) this.gap(); else this.markSource([relative]);
    } catch { this.gap(); }
  }

  private gap(): void {
    this.fullRequired = true; this.changeGeneration++; this.state.scanPending = true;
    if (this.state.sourceEpoch < Number.MAX_SAFE_INTEGER) this.state.sourceEpoch++;
    this.state.pendingPaths = sorted([...this.state.pendingPaths, ...(this.lastScan?.manifest?.content.entries.map(entry => entry.path) ?? [])]);
    this.state.state = 'pending'; this.persistObserved('observation-gap'); this.schedule();
  }

  async observe(skillsRoot: string): Promise<FreshnessState> {
    await this.ready();
    if (this.closed) return this.currentState();
    // Periodic full reconciliation compensates for missed native notifications.
    // The two-second scheduler itself does no I/O when nothing needs updating.
    if (this.fullRequired || !this.watchHealthy || performance.now() - this.lastFullCheck >= 60_000) return this.status(skillsRoot);
    const paths = [...this.dirtyPaths];
    if (!paths.length) return this.currentState();
    for (const relative of paths) this.dirtyPaths.delete(relative);
    const generation = this.changeGeneration;
    const selected = paths.filter(relative => this.lastScan?.policy && isSourcePathIncluded(relative, this.lastScan.policy));
    const observation = await observeSourcePaths(this.worktree, selected, this.state.sourceEpoch);
    // Explicit evidence can be excluded from the source manifest but still needs validation.
    const modelNeeded = paths.some(relative => this.referencePaths.has(referenceKey(relative)));
    const model = modelNeeded ? await loadModel(this.worktree.root).catch(() => null) : null;
    return this.serial(async () => {
      if (this.closed) return this.currentState();
      if (generation !== this.changeGeneration) {
        for (const relative of paths) this.dirtyPaths.add(relative);
        return this.currentState();
      }
      this.state.sourceObservation = observation;
      this.state.scanPending = true; this.state.state = 'pending';
      if (model) {
        this.observedModel = model; this.state.diagnostics = model.diagnostics;
        this.state.lastValidModelSnapshotHash = await this.archive.snapshot('model-snapshot', model);
      } else if (modelNeeded) { this.fullRequired = true; this.state.modelState = 'unknown'; }
      if (observation.requiresFullScan) this.fullRequired = true;
      await this.persist('incremental-observation');
      return this.currentState();
    });
  }

  private async capture(skillsRoot: string): Promise<Capture> {
    const epoch = this.state.sourceEpoch;
    const generation = this.changeGeneration;
    let source: SourceScan;
    try { source = await scanSource(this.worktree, await readConfig(this.worktree.root), skillsRoot); }
    catch { source = { sourceVersion: { head: null, treeHash: null, status: 'unknown' }, sourceScanRevision: null, manifest: null, policy: null, diagnostics: [{ code: 'SOURCE_CONFIG_UNAVAILABLE', severity: 'error', message: 'Current source configuration is unavailable.' }], ignoreRules: null, ignoreRuleFiles: [] }; }
    let model: ModelSnapshot | null = null;
    let modelDiagnostics: Diagnostic[] = [];
    let attemptedModelRevision: string | null = null;
    try { model = await loadModel(this.worktree.root); attemptedModelRevision = model.revision; modelDiagnostics = model.diagnostics; }
    catch (error) {
      if (error instanceof HarnessError) {
        if (Array.isArray(error.details.diagnostics)) modelDiagnostics = error.details.diagnostics as Diagnostic[];
        if (typeof error.details.attemptedModelRevision === 'string') attemptedModelRevision = error.details.attemptedModelRevision;
      }
      if (!modelDiagnostics.length) modelDiagnostics = [{ code: 'MODEL_INVALID', severity: 'error', message: 'The current model could not be parsed and validated.' }];
    }
    return { source, model, modelDiagnostics, attemptedModelRevision, epoch, generation };
  }

  private facts(): string {
    const { lastCheckedAt: _checked, ...content } = this.state;
    return canonicalJson(content);
  }

  private async apply(captured: Capture): Promise<void> {
    const next = captured.source;
    const previous = this.lastScan;
    this.state.lastCheckedAt = this.instant();
    this.state.attemptedModelRevision = captured.attemptedModelRevision;
    this.state.modelState = captured.model ? 'valid' : 'invalid';
    const validSource = next.sourceVersion.status !== 'unknown' && next.manifest && next.policy && next.sourceScanRevision && next.ignoreRules;
    if (validSource) {
      const changes = previous?.manifest && previous.sourceVersion.status !== 'unknown' ? changedSourcePaths(previous, next) : next.manifest!.content.entries.map(entry => entry.path);
      const policyChanged = previous !== null && previous.sourceScanRevision !== next.sourceScanRevision;
      const versionChanged = previous !== null && !same(previous.sourceVersion, next.sourceVersion);
      if (previous && (changes.length || policyChanged)) this.state.sourceEpoch++;
      if (!previous || changes.length || policyChanged || versionChanged) {
        this.state.state = 'pending';
        this.state.pendingPaths = sorted([...this.state.pendingPaths, ...changes, ...(policyChanged || versionChanged ? [...(previous?.manifest?.content.entries.map(entry => entry.path) ?? []), ...next.manifest!.content.entries.map(entry => entry.path)] : [])]);
      }
      const refs = await Promise.all([
        this.archive.snapshot('source-manifest', next.manifest!.content), this.archive.snapshot('source-scan-policy', next.policy!.content),
        this.archive.snapshot('git-ignore-rules', next.ignoreRules!.content), this.archive.snapshot('source-rule-bytes', next.ignoreRuleFiles),
      ]);
      this.state.sourceVersion = structuredClone(next.sourceVersion); this.state.sourceScanRevision = next.sourceScanRevision;
      this.state.lastCompleteSource = { sourceVersion: structuredClone(next.sourceVersion), sourceScanRevision: next.sourceScanRevision!, references: { manifest: refs[0]!, policy: refs[1]!, ignoreRules: refs[2]!, ruleBytes: refs[3]! } };
      this.lastScan = structuredClone(next);
    } else {
      this.state.sourceVersion = structuredClone(next.sourceVersion); this.state.sourceScanRevision = next.sourceScanRevision; this.state.state = 'unknown';
    }
    if (captured.model) {
      this.observedModel = captured.model;
      if (this.state.modelRevision !== captured.model.revision) { this.state.modelPending = true; if (validSource) this.state.state = 'pending'; }
      this.state.modelRevision = captured.model.revision;
      this.state.lastValidModelSnapshotHash = await this.archive.snapshot('model-snapshot', captured.model);
      await this.rememberModel(captured.model);
    } else this.state.state = 'failed';
    this.state.scanPending = this.changeGeneration !== captured.generation;
    this.state.diagnostics = [...next.diagnostics, ...captured.modelDiagnostics, ...(this.watchDiagnostic ? [this.watchDiagnostic] : [])];
    if (captured.model) {
      const problems = referencedEvidenceProblems(captured.model);
      if (problems.length) {
        this.state.pendingPaths = sorted([...this.state.pendingPaths, ...problems.flatMap(item => item.file ? [item.file] : [])]);
        this.state.modelPending = true;
        if (validSource && this.state.state !== 'failed') this.state.state = 'pending';
      }
    }
  }

  status(skillsRoot: string): Promise<FreshnessState> {
    const existing = this.refreshes.get(skillsRoot);
    if (existing) return existing.then(state => structuredClone(state));
    const pending = this.reconcile(skillsRoot).finally(() => { this.refreshes.delete(skillsRoot); });
    this.refreshes.set(skillsRoot, pending);
    return pending.then(state => structuredClone(state));
  }

  private async reconcile(skillsRoot: string): Promise<FreshnessState> {
    await this.ready();
    if (this.closed) return this.currentState();
    if (this.archive.status !== 'ready') throw new HarnessError('ARCHIVE_CORRUPT', 'Synchronization cannot refresh until archive recovery completes.', { diagnostics: this.archive.diagnostics });
    this.activate(skillsRoot);
    const captured = await this.capture(skillsRoot);
    return this.serial(async () => {
      const before = this.facts();
      await this.apply(captured.generation === this.changeGeneration ? captured : await this.capture(skillsRoot));
      if (!this.state.scanPending && this.state.sourceVersion.status !== 'unknown') {
        this.fullRequired = false; this.lastFullCheck = performance.now(); this.dirtyPaths.clear();
        delete this.state.sourceObservation;
      }
      if (this.facts() !== before) await this.persist('reconciliation');
      return this.currentState();
    });
  }

  private outcome(receipt: VerifyReceipt, replayed: boolean, seq: number): VerificationResult {
    const result: VerificationResult = { ...structuredClone(receipt.result), replayed, seq };
    if (receipt.error) throw new HarnessError(receipt.error.code, receipt.error.message, { result, replayed, seq }, receipt.error.code === 'SYNC_RACE');
    return result;
  }

  private pathScope(paths: string[]): (relative: string) => boolean {
    const declared = sorted(paths.map(referenceKey));
    const references = new Set(declared.flatMap(location => [...(this.referencePaths.get(location) ?? [])].map(referenceKey)));
    return relative => {
      const key = referenceKey(relative);
      return references.has(key) || declared.some(location => prefix(location, key));
    };
  }

  private async validateScope(proof: SyncProof, model: ModelSnapshot): Promise<string[]> {
    const paths: string[] = [];
    for (const relative of proof.scope.paths) {
      safeRelative(relative);
      if (prefix('.git', referenceKey(relative))) throw new HarnessError('INVALID_ARGUMENT', 'Git metadata cannot be declared as source verification scope.');
      const actual = await this.resolvedRelative(relative);
      if (prefix('.git', referenceKey(actual))) throw new HarnessError('INVALID_ARGUMENT', 'Git metadata cannot be declared as source verification scope.');
      const locations = [relative, actual];
      paths.push(...locations);
      try { await lstat(path.join(this.worktree.root, ...relative.split('/'))); }
      catch (error) { if (!(isErrno(error, 'ENOENT') && this.state.pendingPaths.some(this.pathScope(locations)))) throw new HarnessError('NOT_FOUND', 'A declared verification path does not exist or cover a pending deletion.', { path: relative }); }
    }
    for (const id of proof.scope.entities) if (!model.entities.some(entity => entity.id === id)) throw new HarnessError('INVALID_ARGUMENT', 'A declared model UUID does not exist in the current model.', { id });
    return paths;
  }

  async verify(input: unknown, skillsRoot: string, requestId?: string): Promise<VerificationResult> {
    const proof = structuredClone(validateContract<SyncProof>('sync-proof', input));
    if (requestId !== undefined && requestId !== proof.requestId) throw new HarnessError('INVALID_ARGUMENT', 'Proof and command request IDs must match.');
    if (!same(proof.target, this.state.target)) throw new HarnessError('TARGET_CONFLICT', 'The proof target does not match this worktree.');
    await this.ready();
    const scope = 'sync-verify:' + this.worktree.id;
    const replay = await this.archive.replay<VerifyReceipt>(scope, proof.requestId, proof);
    if (replay) return this.outcome(replay.receipt, true, replay.seq);
    if (this.closed) throw new HarnessError('BUSY', 'The synchronization manager is stopping.');
    this.activate(skillsRoot);
    this.state.state = 'verifying';
    const preflight = await this.capture(skillsRoot);
    return this.serial(async () => {
      const repeated = await this.archive.replay<VerifyReceipt>(scope, proof.requestId, proof);
      if (repeated) return this.outcome(repeated.receipt, true, repeated.seq);
      const current = await this.capture(skillsRoot);
      await Promise.allSettled([...this.classifiers]);
      await this.apply(current);
      let error: VerifyReceipt['error'] = null;
      let scopeValid = false;
      const evidenceProblems = current.model ? referencedEvidenceProblems(current.model) : [];
      const scopedEntities = new Set(proof.scope.entities);
      const scopedEvidence = new Set(current.model?.entities.filter(entity => scopedEntities.has(entity.id)).flatMap(entity => entity.evidenceIds));
      let pathInScope = this.pathScope(proof.scope.paths);
      const problemsInScope = () => evidenceProblems.filter(item => (item.file && pathInScope(item.file)) || scopedEvidence.has(item.evidenceId!));
      let scopedEvidenceProblems = problemsInScope();
      if (!current.model) error = { code: 'MODEL_INVALID', message: 'The current model is invalid; no successful verification was recorded.' };
      else if (current.source.sourceVersion.status === 'unknown' || !current.source.sourceScanRevision) error = { code: 'SYNC_UNRESOLVED', message: 'The current source scope is unknown.' };
      else if (proof.sourceEpoch !== this.state.sourceEpoch || this.changeGeneration !== current.generation || preflight.generation !== current.generation || !same(proof.expectedSourceVersion, current.source.sourceVersion) || proof.expectedModelRevision !== current.model.revision || preflight.epoch !== current.epoch || !same(preflight.source.sourceVersion, current.source.sourceVersion) || preflight.source.sourceScanRevision !== current.source.sourceScanRevision || preflight.model?.revision !== current.model.revision) {
        error = { code: 'SYNC_RACE', message: 'Source/model/epoch changed before verification could commit.' };
      } else {
        try { pathInScope = this.pathScope(await this.validateScope(proof, current.model)); scopeValid = true; scopedEvidenceProblems = problemsInScope(); }
        catch (failure) { error = { code: failure instanceof HarnessError ? failure.code : 'INVALID_ARGUMENT', message: failure instanceof Error ? failure.message : 'The declared scope could not be validated.' }; }
        if (!error && this.changeGeneration !== current.generation) error = { code: 'SYNC_RACE', message: 'Source/model/epoch changed before verification could commit.' };
        if (!error && scopedEvidenceProblems.length) error = { code: 'SYNC_UNRESOLVED', message: 'Referenced evidence in the declared scope is changed, missing or unreadable; repair its current references before verifying.' };
        if (!error && (proof.disposition === 'unresolved' || proof.checks.some(check => check.status !== 'passed'))) error = { code: 'SYNC_UNRESOLVED', message: 'The declaration or its checks leave unresolved work.' };
      }
      const successful = error === null;
      this.state.proofId = randomUUID();
      if (successful) {
        this.state.pendingPaths = this.state.pendingPaths.filter(pending => !pathInScope(pending));
        this.state.modelPending = evidenceProblems.length > 0; this.state.scanPending = false;
        this.state.state = this.state.pendingPaths.length || this.state.modelPending ? 'pending' : 'verified';
        if (this.state.state === 'verified') this.state.verifiedAt = this.instant();
      } else this.state.state = error!.code === 'SYNC_RACE' ? 'pending' : 'failed';
      const receipt: VerifyReceipt = {
        result: { ...this.currentState(), declaration: proof, automaticChecks: [
          { name: 'current-model', status: current.model ? 'passed' : 'failed', scope: ['.harness/model', '.harness/evidence.json', '.harness/aliases.json'] },
          { name: 'source-model-epoch-cas', status: !current.model || error?.code === 'SYNC_RACE' || current.source.sourceVersion.status === 'unknown' ? 'failed' : 'passed', scope: [...proof.scope.paths] },
          { name: 'declared-scope', status: scopeValid ? 'passed' : 'failed', scope: [...proof.scope.paths, ...proof.scope.entities] },
          { name: 'referenced-evidence', status: current.model && !scopedEvidenceProblems.length ? 'passed' : 'failed', scope: [...proof.scope.paths, ...proof.scope.entities] },
        ] }, error,
      };
      const committed = await this.persist('verification', proof, receipt);
      return this.outcome(committed.receipt as VerifyReceipt, false, committed.seq);
    });
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true; this.watcher?.close();
      if (this.timer) clearInterval(this.timer);
      if (this.debounce) clearTimeout(this.debounce);
      await Promise.allSettled([...this.classifiers]);
      await this.running;
      await Promise.allSettled([...this.refreshes.values()]);
      await Promise.allSettled([...this.writes]);
      await this.serial(async () => undefined);
    })();
  }
}
