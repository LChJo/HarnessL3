import { watch, type FSWatcher } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { execFile as callbackExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import path from 'node:path';
import { Archive, type ArchiveReference } from './archive.js';
import type { CurrentStateStore } from './current-state.js';
import { checkAuditCancellation, reportProgress } from './progress.js';
import { HarnessError, permissionError } from './errors.js';
import { validateContract } from './contract.js';
import { canonicalJson, digest } from './json.js';
import { loadModel } from './model.js';
import { readConfig } from './workspace.js';
import { resolveInside, safeRelative } from './paths.js';
import { isErrno } from './io.js';
import { scanSource, observeSourcePaths, changedSourcePaths, isSourcePathIncluded, isDirectoryPathIgnored, type SourceObservation, type SourceScan, type SourceManifest, type SourcePolicy, type IgnoreRules, type IgnoreRuleFile } from './source.js';
import type { Diagnostic, ModelSnapshot, SourceVersion, Target, WorktreeRecord } from './types.js';

const execFile = promisify(callbackExecFile);
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();
const prefix = (parent: string, child: string) => child === parent || child.startsWith(parent + '/');
const referenceKey = (relative: string) => process.platform === 'win32' ? relative.toLowerCase() : relative;
const gitBookkeeping = (relative: string) => relative.endsWith('.lock') || prefix('.git/logs', relative) ||
  /^\.git\/objects\/(?:[a-f0-9]{2}(?:\/|$)|pack(?:\/|$))/.test(relative) ||
  ['.git/FETCH_HEAD', '.git/ORIG_HEAD', '.git/COMMIT_EDITMSG'].includes(relative);
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
  pendingWorkspace?: boolean;
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
  scopeStatus?: 'passed' | 'failed';
  replayed: boolean; seq: number;
}
interface VerifyReceipt { result: Omit<VerificationResult, 'replayed' | 'seq'>; error: { code: string; message: string; details?: Record<string, unknown> } | null }
interface Capture { source: SourceScan; model: ModelSnapshot | null; modelDiagnostics: Diagnostic[]; attemptedModelRevision: string | null; epoch: number; generation: number }
interface Options {
  worktree: WorktreeRecord; archive: Archive; serial: <T>(operation: () => Promise<T>) => Promise<T>;
  onCommit?: (seq: number) => void; onObserved?: () => void; now?: () => Date; leaseMs?: number;
  stateStore?: CurrentStateStore;
  background?: (operation: () => Promise<void>) => Promise<void>;
}

/** Records scoped declarations and mechanical checks; it never infers semantics. */
export class FreshnessManager {
  private readonly worktree: WorktreeRecord;
  private readonly archive: Archive;
  private readonly serial: Options['serial'];
  private readonly onCommit?: Options['onCommit'];
  private readonly onObserved?: Options['onObserved'];
  private readonly stateStore?: CurrentStateStore;
  private readonly now: () => Date;
  private readonly leaseMs: number;
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
  private readonly classifiers = new Map<string, Promise<void>>();
  private closed = false;
  private closing?: Promise<void>;
  private changeGeneration = 0;
  private observedNotification?: NodeJS.Timeout;
  private lastPersistedFacts?: string;
  private readonly refreshes = new Map<string, { identity: number; pending: Promise<FreshnessState> }>();
  private identityGeneration = 0;
  private readonly dirtyPaths = new Set<string>();
  private fullRequired = true;
  private pendingArray?: string[];
  private pendingSet = new Set<string>();
  private pendingDirty = false;
  private pendingLimit = 4096;
  private manifestSource?: SourceScan;
  private manifestPaths = new Set<string>();
  private observedModel: ModelSnapshot | null = null;
  private modelEventGeneration = 0;
  private capturedModelEvent = 0;
  private modelEpoch = -1;
  private readonly modelRevisions = new Set<string>();
  private watchHealthy = false;
  private watchDiagnostic?: Diagnostic;
  private readonly background: NonNullable<Options['background']>;
  private readonly counters = { nativeEvents: 0, sourceEvents: 0, coverageGaps: 0, classifiedPaths: 0, incrementalBatches: 0, completeCaptures: 0, checkpointWrites: 0 };

  constructor(options: Options) {
    this.worktree = options.worktree; this.archive = options.archive; this.serial = options.serial;
    this.onCommit = options.onCommit; this.now = options.now ?? (() => new Date());
    this.onObserved = options.onObserved;
    this.stateStore = options.stateStore;
    this.leaseMs = Math.max(100, options.leaseMs ?? 5 * 60_000);
    this.background = options.background ?? (operation => operation());
    this.state = {
      schemaVersion: 1, target: { projectId: options.worktree.projectId, worktreeId: options.worktree.id }, state: 'unknown', sourceEpoch: 0,
      sourceVersion: { head: null, treeHash: null, status: 'unknown' }, sourceScanRevision: null, modelRevision: null, attemptedModelRevision: null,
      modelState: 'unknown', pendingPaths: [], modelPending: true, scanPending: true, proofId: null, verifiedAt: null, lastCheckedAt: null,
      diagnostics: [], lastCompleteSource: null, lastValidModelSnapshotHash: null,
    };
  }

  ready(): Promise<void> { return this.loading ??= this.restore(); }
  currentState(): FreshnessState { this.materializePending(); return structuredClone(this.state); }
  currentModel(): ModelSnapshot | null { return structuredClone(this.observedModel); }
  metrics() { this.syncPendingSet(); return { ...this.counters, activeLease: !!this.activeSkillsRoot && !!this.timer, watcher: !!this.watcher, pendingWorkspace: this.state.pendingWorkspace === true, pendingPaths: this.pendingSet.size, dirtyPaths: this.dirtyPaths.size, classifiers: this.classifiers.size, backgroundRunning: !!this.running }; }
  /** Registration changed adapters; retained observations are no longer a current proof. */
  identityChanged(): void { this.identityGeneration++; this.gap(); }
  /** Persist invalidation before an explicit identity repair can restore old bytes. No source scan. */
  async identityRepairPending(): Promise<void> {
    await this.ready();
    if (this.closed) throw new HarnessError('BUSY', 'Synchronization is closed; retry identity repair after reactivating the workspace.');
    this.identityChanged();
    await this.serial(() => this.persist('identity-repair'));
  }
  private instant(): string {
    const current = this.now();
    if (!(current instanceof Date) || !Number.isFinite(current.getTime())) throw new HarnessError('INTERNAL_ERROR', 'The synchronization clock must return a valid Date.');
    return current.toISOString();
  }

  private async restore(): Promise<void> {
    await this.archive.ready();
    const lastHeader = this.archive.lastHeader({ kind: 'freshness-state' });
    const headers = this.archive.verificationScope === 'operational' ? (lastHeader ? [lastHeader] : []) : this.archive.headers({ kind: 'freshness-state' });
    recovery: for (let offset = 0; offset < headers.length; offset += 8) {
      checkAuditCancellation();
      const states = await Promise.all(headers.slice(offset, offset + 8).map(async header => {
        if (this.archive.verificationScope === 'operational') await this.archive.receipt(header.seq);
        const record = await this.archive.record(header.seq);
        const payload = record.payload as { kind?: string; state?: FreshnessState; stateHash?: string } | null;
        if (payload?.kind !== 'freshness-state') throw new HarnessError('ARCHIVE_CORRUPT', 'A synchronization record has an invalid kind.');
        if (payload.stateHash !== undefined && (typeof payload.stateHash !== 'string' || !/^[a-f0-9]{64}$/.test(payload.stateHash))) throw new HarnessError('ARCHIVE_CORRUPT', 'A synchronization state reference is invalid.');
        let state = payload.state;
        try { state ??= payload.stateHash ? await this.archive.readSnapshot<FreshnessState>(payload.stateHash) : undefined; }
        catch (error) { if (this.archive.status !== 'ready') return undefined; throw error; }
        return state;
      }));
      // Consume in journal order: parallel reads must not weaken epoch checks.
      for (const state of states) {
        if (!state && this.archive.status !== 'ready') break recovery;
        if (!state || state.schemaVersion !== 1 || !same(state.target, this.state.target) || !Number.isSafeInteger(state.sourceEpoch) || state.sourceEpoch < this.state.sourceEpoch || !Array.isArray(state.pendingPaths)) {
          throw new HarnessError('ARCHIVE_CORRUPT', 'A synchronization record has an invalid identity or source epoch.');
        }
        this.state = structuredClone(state);
      }
      if (offset % 1000 === 0) reportProgress({ phase: 'restoring-synchronization', completed: Math.min(offset + 8, headers.length), total: headers.length });
      if (offset % 128 === 120) await setImmediate();
    }
    if (this.archive.status !== 'ready') {
      this.state.state = 'unknown'; this.state.scanPending = true; this.state.modelState = 'unknown';
      this.state.diagnostics = [{ code: 'ARCHIVE_CORRUPT', severity: 'error', message: 'Synchronization archives need recovery; independently intact history remains read-only.' }];
      return;
    }
    const checkpoint = await this.stateStore?.load();
    let currentCheckpoint = false;
    if (checkpoint) {
      if (checkpoint.seq > this.archive.seq) throw new HarnessError('ARCHIVE_CORRUPT', 'Current state points past the committed archive.');
      if (checkpoint.seq >= (headers.at(-1)?.seq ?? 0)) {
        const state = checkpoint.state;
        if (!state || state.schemaVersion !== 1 || !same(state.target, this.state.target) || !Number.isSafeInteger(state.sourceEpoch) || state.sourceEpoch < this.state.sourceEpoch || !Array.isArray(state.pendingPaths)) throw new HarnessError('ARCHIVE_CORRUPT', 'Current synchronization checkpoint has an invalid identity or epoch.');
        this.state = structuredClone(state);
        currentCheckpoint = true;
      }
    }
    this.lastPersistedFacts = this.facts();
    const last = this.state.lastCompleteSource;
    if (last) {
      const saved = currentCheckpoint ? checkpoint?.source : null;
      if (saved) {
        if (!same(saved.sourceVersion, last.sourceVersion) || saved.sourceScanRevision !== last.sourceScanRevision || !saved.manifest || !saved.policy || !saved.ignoreRules || !same(this.sourceReferences(saved), last.references)) throw new HarnessError('ARCHIVE_CORRUPT', 'The current source manifest does not match its checkpoint reference.');
        this.lastScan = saved;
      } else this.lastScan = {
        sourceVersion: structuredClone(last.sourceVersion), sourceScanRevision: last.sourceScanRevision, diagnostics: [],
        manifest: { schemaVersion: 1, kind: 'source-manifest', content: await this.archive.readSnapshot<SourceManifest['content']>(last.references.manifest) },
        policy: { schemaVersion: 1, kind: 'source-scan-policy', content: await this.archive.readSnapshot<SourcePolicy['content']>(last.references.policy) },
        ignoreRules: { schemaVersion: 1, kind: 'git-ignore-rules', content: await this.archive.readSnapshot<IgnoreRules['content']>(last.references.ignoreRules) },
        ignoreRuleFiles: await this.archive.readSnapshot<IgnoreRuleFile[]>(last.references.ruleBytes),
      };
    }
    if (this.state.lastValidModelSnapshotHash) {
      const saved = currentCheckpoint ? checkpoint?.model : null;
      if (saved && digest('model-snapshot', saved) !== this.state.lastValidModelSnapshotHash) throw new HarnessError('ARCHIVE_CORRUPT', 'The current model does not match its checkpoint reference.');
      this.observedModel = saved ?? await this.archive.readSnapshot<ModelSnapshot>(this.state.lastValidModelSnapshotHash);
      await this.rememberModel(this.observedModel);
    }
    // A stopped watcher cannot attest to the downtime. Retain the actual epoch,
    // but require a new declaration before treating an old proof as current.
    if (headers.length || checkpoint) {
      // Every returned status/verification binding has a committed epoch. A
      // downtime gap invalidates even a declaration whose bytes reverted.
      this.gap();
      this.state.modelState = 'unknown';
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

  private references(): ArchiveReference[] {
    const hashes = this.state.lastCompleteSource ? Object.values(this.state.lastCompleteSource.references) : [];
    if (this.state.lastValidModelSnapshotHash) hashes.push(this.state.lastValidModelSnapshotHash);
    return sorted(hashes).map(hash => ({ kind: 'snapshot', hash }));
  }

  private sourceReferences(scan: SourceScan): SourceReferences {
    return { manifest: digest('source-manifest', scan.manifest!.content), policy: digest('source-scan-policy', scan.policy!.content), ignoreRules: digest('git-ignore-rules', scan.ignoreRules!.content), ruleBytes: digest('source-rule-bytes', scan.ignoreRuleFiles) };
  }

  private async archiveCurrentFacts(): Promise<void> {
    const scan = this.lastScan;
    if (this.state.lastCompleteSource && scan?.manifest && scan.policy && scan.ignoreRules) {
      const hashes = await Promise.all([
        this.archive.snapshot('source-manifest', scan.manifest.content), this.archive.snapshot('source-scan-policy', scan.policy.content),
        this.archive.snapshot('git-ignore-rules', scan.ignoreRules.content), this.archive.snapshot('source-rule-bytes', scan.ignoreRuleFiles),
      ]);
      if (!same(this.state.lastCompleteSource.references, { manifest: hashes[0], policy: hashes[1], ignoreRules: hashes[2], ruleBytes: hashes[3] })) throw new HarnessError('ARCHIVE_CORRUPT', 'Source checkpoint references changed before verification commit.');
    }
    if (this.observedModel && this.state.lastValidModelSnapshotHash && await this.archive.snapshot('model-snapshot', this.observedModel) !== this.state.lastValidModelSnapshotHash) throw new HarnessError('ARCHIVE_CORRUPT', 'Model checkpoint reference changed before verification commit.');
  }

  private async persist(reason: string, proof?: SyncProof, receipt?: VerifyReceipt): Promise<{ seq: number; receipt: VerifyReceipt | FreshnessState }> {
    const captured = this.currentState();
    if (!proof && this.stateStore) {
      // Status and identity invalidation update a current transactional value;
      // they are not immutable business receipts. Only an explicit proof
      // creates a committed verification record.
      const seq = this.archive.seq;
      try { await this.stateStore.save({ seq, state: captured, source: this.lastScan, model: this.observedModel }); }
      catch (error) { this.gap(); this.state.state = 'unknown'; throw error; }
      this.counters.checkpointWrites++;
      this.lastPersistedFacts = this.facts(captured);
      this.notifyObserved();
      return { seq, receipt: captured };
    }
    if (this.stateStore) await this.archiveCurrentFacts();
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
    this.lastPersistedFacts = this.facts(captured);
    this.onCommit?.(result.seq);
    return { seq: result.seq, receipt: result.receipt };
  }

  private notifyObserved(): void {
    // Native events have no durable business receipt. Invalidation is immediate
    // in memory; an explicit status persists its issued binding. On downtime
    // recovery always advances that persisted epoch before accepting a proof.
    if (this.closed || !this.onObserved || this.observedNotification) return;
    this.observedNotification = setTimeout(() => {
      this.observedNotification = undefined;
      if (!this.closed) this.onObserved?.();
    }, 250);
    this.observedNotification.unref();
  }

  private activate(skillsRoot: string): void {
    this.activeSkillsRoot = skillsRoot;
    if (this.closed || !this.worktree.active || !this.worktree.available) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.refreshes.size || this.state.state === 'verifying') { this.activate(skillsRoot); return; }
      // Only explicit live work renews coverage; idle workspaces stop watching.
      this.watcher?.close(); this.watcher = undefined; this.watchHealthy = false;
      this.activeSkillsRoot = undefined;
      this.gap();
    }, this.leaseMs);
    this.timer.unref();
    if (this.watcher) return;
    try {
      const watcher = watch(this.worktree.root, { recursive: true, persistent: false, encoding: 'buffer' }, (_event, filename) => {
        if (this.closed || this.watcher !== watcher) return;
        let relative: string;
        try {
          // Native recursive watchers can return a decoded string despite encoding: 'buffer'.
          if (filename === null) throw new Error('Native notification has no path');
          const decoded = typeof filename === 'string' ? filename : new TextDecoder('utf-8', { fatal: true }).decode(filename);
          relative = decoded.split(path.sep).join('/'); safeRelative(relative);
        }
        catch {
          // Windows can repeatedly emit the absolute, extended-length root after
          // deletion. Release incomplete coverage before invalidating once;
          // explicit synchronization can reattach when the directory returns.
          watcher.close(); this.watcher = undefined; this.watchHealthy = false;
          this.watchDiagnostic = { code: 'SOURCE_WATCH_ERROR', severity: 'warning', message: 'Source watcher coverage is incomplete; refresh synchronization before reviewing changes.' };
          this.gap(); return;
        }
        this.watchEvent(relative);
      });
      this.watcher = watcher;
      this.watchHealthy = true; this.watchDiagnostic = undefined;
      this.watcher.on('error', () => {
        if (this.closed || this.watcher !== watcher) return;
        this.watcher?.close(); this.watcher = undefined; this.watchHealthy = false;
        this.watchDiagnostic = { code: 'SOURCE_WATCH_ERROR', severity: 'error', message: 'Source watcher coverage is incomplete; refresh synchronization before reviewing changes.' };
        this.gap();
        this.state.state = 'unknown'; this.state.scanPending = true;
        this.state.diagnostics = [this.watchDiagnostic];
        this.notifyObserved();
      });
    } catch {
      this.watchHealthy = false;
      this.watchDiagnostic = { code: 'SOURCE_WATCH_UNAVAILABLE', severity: 'warning', message: 'Native source watching is unavailable; refresh synchronization before reviewing changes.' };
      this.state.diagnostics = [this.watchDiagnostic];
    }
  }

  private async sourceRootAvailable(): Promise<boolean> {
    try {
      const info = await lstat(this.worktree.root);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Workspace root is no longer its registered directory');
      return true;
    } catch (error) {
      const permission = permissionError(error);
      if (permission) throw permission;
      const before = this.facts();
      this.watcher?.close(); this.watcher = undefined; this.watchHealthy = false;
      if (this.watchDiagnostic?.code !== 'SOURCE_ROOT_UNAVAILABLE') this.gap();
      this.watchDiagnostic = { code: 'SOURCE_ROOT_UNAVAILABLE', severity: 'warning', message: 'The registered workspace directory is unavailable. History is preserved; restore the directory and refresh synchronization before reviewing changes.' };
      this.state.state = 'unknown'; this.state.scanPending = true;
      this.state.diagnostics = [this.watchDiagnostic]; this.dirtyPaths.clear();
      if (before !== this.facts()) this.notifyObserved();
      return false;
    }
  }

  private schedule(milliseconds = 150): void {
    if (this.closed || !this.activeSkillsRoot || this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      if (this.running || this.closed || !this.activeSkillsRoot) return;
      const root = this.activeSkillsRoot;
      this.running = this.background(async () => { if (!this.closed) await this.observe(root); }).catch(() => undefined).finally(() => {
        this.running = undefined;
        if (this.dirtyPaths.size && !this.fullRequired) this.schedule();
      });
    }, milliseconds);
    this.debounce.unref();
  }

  private watchEvent(relative: string): void {
    this.counters.nativeEvents++;
    if (prefix('.git', relative)) {
      // Git locks, reflogs and content-addressed object writes do not select the
      // current worktree version. HEAD, refs, index, config, ignore rules and
      // unknown/aggregate Git notifications still invalidate the declaration.
      if (!gitBookkeeping(relative) || this.referencePaths.has(referenceKey(relative))) this.gap();
      return;
    }
    const referenced = this.referencePaths.get(referenceKey(relative));
    if (referenced) this.markReferences(referenced);
    if (prefix('.harness', relative)) {
      if (relative === '.harness/project.json') { this.gap(); return; }
      if (prefix('.harness/model', relative) || ['.harness/evidence.json', '.harness/aliases.json'].includes(relative)) {
        this.fullRequired = true; this.changeGeneration++; this.modelEventGeneration++; this.state.modelPending = true; this.state.modelState = 'parsing'; this.state.state = 'pending'; this.state.scanPending = true;
        this.notifyObserved(); this.schedule();
      }
      return;
    }
    if (referenced) return;
    if (relative.split('/').at(-1) === '.gitignore' && (!relative.includes('/') || !this.lastScan?.policy || isSourcePathIncluded(relative.slice(0, relative.lastIndexOf('/')), this.lastScan.policy)) && !this.lastScan?.ignoredDirectoryPrefixes?.some(ignored => prefix(ignored, relative))) { this.fullRequired = true; this.markSource([relative]); return; }
    if (this.lastScan?.policy && !isSourcePathIncluded(relative, this.lastScan.policy)) return;
    if (this.hasManifestPath(relative)) { this.markSource([relative]); return; }
    // Keep native Git's last observed directory classification after deletion;
    // checking a missing `build` as a file loses a `build/` ignore rule.
    if (this.lastScan?.ignoredDirectoryPrefixes?.some(ignored => prefix(ignored, relative))) return;
    if (this.state.pendingWorkspace) { this.gap(); return; }
    // One active classification covers a burst on the same unknown path. The
    // classifier checks the path type again before accepting an ignored result
    // so a directory/file replacement cannot invalidate that conclusion.
    if (this.classifiers.has(relative)) return;
    if (this.classifiers.size >= 32) { this.gap(); return; }
    const pending = this.classifyNewPath(relative).finally(() => this.classifiers.delete(relative));
    this.counters.classifiedPaths++;
    this.classifiers.set(relative, pending);
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
    this.counters.sourceEvents++;
    if (this.state.sourceEpoch >= Number.MAX_SAFE_INTEGER) { this.state.state = 'unknown'; this.state.scanPending = true; return; }
    this.changeGeneration++; this.state.sourceEpoch++; this.state.state = 'pending'; this.state.scanPending = true;
    const changes = [...paths];
    if (!this.state.pendingWorkspace) {
      this.mergePendingPaths(changes);
      if (this.pendingSet.size > this.pendingLimit) this.gap();
    }
    if (!this.fullRequired) for (const relative of changes) {
      if (this.dirtyPaths.size >= 4096) { this.gap(); break; }
      this.dirtyPaths.add(relative);
    }
    this.notifyObserved(); this.schedule();
  }

  private mergePendingPaths(paths: Iterable<string>): void {
    this.syncPendingSet();
    for (const relative of paths) if (!this.pendingSet.has(relative)) { this.pendingSet.add(relative); this.pendingDirty = true; }
  }

  private syncPendingSet(): void {
    if (this.pendingArray !== this.state.pendingPaths) {
      this.pendingArray = this.state.pendingPaths;
      this.pendingSet = new Set(this.pendingArray);
      this.pendingDirty = false;
      this.pendingLimit = Math.max(this.pendingSet.size, this.lastScan?.manifest?.content.entries.length ?? 0) + 4096;
    }
  }

  private materializePending(): void {
    this.syncPendingSet();
    if (this.pendingDirty) {
      this.pendingArray = this.state.pendingPaths = [...this.pendingSet].sort();
      this.pendingDirty = false;
    }
  }

  private hasManifestPath(relative: string): boolean {
    if (this.manifestSource !== (this.lastScan ?? undefined)) {
      this.manifestSource = this.lastScan ?? undefined;
      this.manifestPaths = new Set();
      for (const entry of this.lastScan?.manifest?.content.entries ?? []) {
        const parts = entry.path.split('/');
        for (let i = 1; i <= parts.length; i++) this.manifestPaths.add(parts.slice(0, i).join('/'));
      }
    }
    return this.manifestPaths.has(relative);
  }

  private async classifyNewPath(relative: string): Promise<void> {
    try {
      await resolveInside(this.worktree.root, relative, { allowMissing: true });
      const pathKind = async (): Promise<'directory' | 'file' | 'missing'> => {
        try { return (await lstat(path.join(this.worktree.root, ...relative.split('/')))).isDirectory() ? 'directory' : 'file'; }
        catch (error) { if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTDIR')) throw error; return 'missing'; }
      };
      const initialKind = await pathKind(), directory = initialKind === 'directory';
      if (this.worktree.kind === 'directory') {
        if (await isDirectoryPathIgnored(this.worktree.root, relative, directory)) {
          const after = await pathKind();
          if (after !== initialKind && after !== 'missing') { this.gap(); return; }
          if (directory && this.lastScan) this.lastScan.ignoredDirectoryPrefixes = sorted([...(this.lastScan.ignoredDirectoryPrefixes ?? []), relative]);
          return;
        }
        if (directory) this.gap(); else this.markSource([relative]);
        return;
      }
      const environment: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
      for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM']) delete environment[key];
      try {
        await execFile('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', this.worktree.root, 'check-ignore', '--no-index', '--quiet', '--', relative + (directory ? '/' : '')], { env: environment, windowsHide: true });
        const after = await pathKind();
        if (after !== initialKind && after !== 'missing') { this.gap(); return; }
        if (directory && this.lastScan) this.lastScan.ignoredDirectoryPrefixes = sorted([...(this.lastScan.ignoredDirectoryPrefixes ?? []), relative]);
        return;
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 1)) throw error;
      }
      if (directory) this.gap(); else this.markSource([relative]);
    } catch { this.gap(); }
  }

  private gap(): void {
    this.counters.coverageGaps++;
    this.fullRequired = true; this.changeGeneration++; this.state.scanPending = true;
    if (this.state.sourceEpoch < Number.MAX_SAFE_INTEGER) this.state.sourceEpoch++;
    // Defer expansion of a whole-workspace gap until an explicit complete
    // capture. Repeated ambiguous events cannot copy the entire path universe.
    this.state.pendingWorkspace = true;
    this.dirtyPaths.clear();
    this.state.state = 'pending'; this.notifyObserved();
  }

  async observe(skillsRoot: string): Promise<FreshnessState> {
    await this.ready();
    if (this.closed) return this.currentState();
    if (!await this.sourceRootAvailable()) return this.currentState();
    // Coverage gaps require explicit full verification, never a background
    // recursive scan. Keep the previous observed model and pending state.
    if (this.fullRequired || !this.watchHealthy) return this.currentState();
    const paths = [...this.dirtyPaths].slice(0, 128);
    if (!paths.length) return this.currentState();
    for (const relative of paths) this.dirtyPaths.delete(relative);
    const generation = this.changeGeneration;
    const selected = paths.filter(relative => this.lastScan?.policy && isSourcePathIncluded(relative, this.lastScan.policy));
    this.counters.incrementalBatches++;
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
        this.state.diagnostics = model.diagnostics;
        // A transient observation does not publish an immutable model archive.
      } else if (modelNeeded) { this.fullRequired = true; this.state.modelState = 'unknown'; }
      if (observation.requiresFullScan) this.fullRequired = true;
      this.notifyObserved();
      return this.currentState();
    });
  }

  private async capture(skillsRoot: string): Promise<Capture> {
    this.counters.completeCaptures++;
    const epoch = this.state.sourceEpoch;
    const generation = this.changeGeneration;
    let source: SourceScan;
    try { source = await scanSource(this.worktree, await readConfig(this.worktree.root), skillsRoot); }
    catch (error) {
      const permission = permissionError(error);
      if (permission) { this.state.state = 'unknown'; this.state.scanPending = true; throw permission; }
      source = { sourceVersion: { head: null, treeHash: null, status: 'unknown' }, sourceScanRevision: null, manifest: null, policy: null, diagnostics: [{ code: 'SOURCE_CONFIG_UNAVAILABLE', severity: 'error', message: 'Current source configuration is unavailable.' }], ignoreRules: null, ignoreRuleFiles: [] };
    }
    let model: ModelSnapshot | null = null;
    let modelDiagnostics: Diagnostic[] = [];
    let attemptedModelRevision: string | null = null;
    try { model = await loadModel(this.worktree.root); attemptedModelRevision = model.revision; modelDiagnostics = model.diagnostics; }
    catch (error) {
      const permission = permissionError(error);
      if (permission) { this.state.state = 'unknown'; this.state.scanPending = true; throw permission; }
      if (error instanceof HarnessError) {
        if (Array.isArray(error.details.diagnostics)) modelDiagnostics = error.details.diagnostics as Diagnostic[];
        if (typeof error.details.attemptedModelRevision === 'string') attemptedModelRevision = error.details.attemptedModelRevision;
      }
      if (!modelDiagnostics.length) modelDiagnostics = [{ code: 'MODEL_INVALID', severity: 'error', message: 'The current model could not be parsed and validated.' }];
    }
    return { source, model, modelDiagnostics, attemptedModelRevision, epoch, generation };
  }

  private facts(state = this.state): string {
    if (state === this.state) this.materializePending();
    const { lastCheckedAt: _checked, ...content } = state;
    return canonicalJson(content);
  }

  private async apply(captured: Capture): Promise<void> {
    this.materializePending();
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
      if (this.state.pendingWorkspace) {
        this.mergePendingPaths([...(previous?.manifest?.content.entries.map(entry => entry.path) ?? []), ...next.manifest!.content.entries.map(entry => entry.path)]);
        this.materializePending();
      }
      const refs = this.stateStore ? Object.values(this.sourceReferences(next)) : await Promise.all([
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
      if (this.modelEpoch !== this.state.sourceEpoch) { this.modelEpoch = this.state.sourceEpoch; this.modelRevisions.clear(); }
      const hadModel = this.state.modelRevision;
      if (hadModel && ((this.modelEventGeneration !== this.capturedModelEvent && captured.model.revision === hadModel) || (captured.model.revision !== hadModel && this.modelRevisions.has(captured.model.revision)) || this.modelRevisions.size >= 128)) {
        if (this.state.sourceEpoch < Number.MAX_SAFE_INTEGER) this.state.sourceEpoch++;
        this.modelEpoch = this.state.sourceEpoch; this.modelRevisions.clear(); this.state.modelPending = true;
      }
      this.capturedModelEvent = this.modelEventGeneration;
      this.modelRevisions.add(captured.model.revision);
      if (this.state.modelRevision !== captured.model.revision) { this.state.modelPending = true; if (validSource) this.state.state = 'pending'; }
      this.state.modelRevision = captured.model.revision;
      this.state.lastValidModelSnapshotHash = this.stateStore ? digest('model-snapshot', captured.model) : await this.archive.snapshot('model-snapshot', captured.model);
      await this.rememberModel(captured.model);
    } else this.state.state = 'failed';
    this.state.scanPending = this.changeGeneration !== captured.generation;
    if (validSource && !this.state.scanPending) delete this.state.pendingWorkspace;
    this.state.diagnostics = [...next.diagnostics, ...captured.modelDiagnostics, ...(this.watchDiagnostic ? [this.watchDiagnostic] : [])];
    if (captured.model) {
      const problems = referencedEvidenceProblems(captured.model);
      this.materializePending();
      if (problems.length) {
        this.state.pendingPaths = sorted([...this.state.pendingPaths, ...problems.flatMap(item => item.file ? [item.file] : [])]);
        this.state.modelPending = true;
        if (validSource && this.state.state !== 'failed') this.state.state = 'pending';
      }
    }
  }

  status(skillsRoot: string): Promise<FreshnessState> {
    const existing = this.refreshes.get(skillsRoot);
    if (existing) return existing.identity === this.identityGeneration
      ? existing.pending.then(state => structuredClone(state))
      : existing.pending.then(() => this.status(skillsRoot));
    const pending = this.reconcile(skillsRoot).finally(() => { this.refreshes.delete(skillsRoot); });
    this.refreshes.set(skillsRoot, { identity: this.identityGeneration, pending });
    return pending.then(state => structuredClone(state));
  }

  private async reconcile(skillsRoot: string): Promise<FreshnessState> {
    await this.ready();
    if (this.closed) return this.currentState();
    if (this.archive.status !== 'ready') throw new HarnessError('ARCHIVE_CORRUPT', 'Synchronization cannot refresh until archive recovery completes.', { diagnostics: this.archive.diagnostics });
    if (!await this.sourceRootAvailable()) return this.currentState();
    this.activate(skillsRoot);
    let captured = await this.capture(skillsRoot);
    return this.serial(async () => {
      // A read may safely acquire a newer binding; an existing semantic proof
      // may not. Each retry repeats the complete scan, never just its epoch.
      for (let attempt = 0; attempt < 3; attempt++) {
        await Promise.allSettled([...this.classifiers.values()]);
        if (captured.generation !== this.changeGeneration && attempt < 2) {
          captured = await this.capture(skillsRoot);
          continue;
        }
        await this.apply(captured);
        await Promise.allSettled([...this.classifiers.values()]);
        if (captured.generation !== this.changeGeneration) this.state.scanPending = true;
        if (!this.state.scanPending || attempt === 2) break;
        captured = await this.capture(skillsRoot);
      }
      if (!this.state.scanPending && this.state.sourceVersion.status !== 'unknown') {
        this.fullRequired = false; this.dirtyPaths.clear();
        delete this.state.sourceObservation;
      }
      if (this.state.scanPending && this.state.sourceVersion.status !== 'unknown') {
        this.state.diagnostics.push({ code: 'SOURCE_CHANGING', severity: 'warning', message: 'Files are still changing during synchronization checks. Changes are preserved as pending; wait for current edits or builds to finish, then refresh sync status before reviewing and submitting a new declaration.' });
      }
      // The returned epoch must be a durable binding, not a newer epoch from
      // a notification arriving while the checkpoint is being committed.
      const issued = this.facts() !== this.lastPersistedFacts
        ? (await this.persist('reconciliation')).receipt as FreshnessState
        : this.currentState();
      if (this.facts(issued) !== this.facts()) return { ...issued, state: 'pending', scanPending: true };
      return issued;
    });
  }

  private outcome(receipt: VerifyReceipt, replayed: boolean, seq: number): VerificationResult {
    const result: VerificationResult = { ...structuredClone(receipt.result), replayed, seq };
    if (receipt.error) throw new HarnessError(receipt.error.code, receipt.error.message, { ...receipt.error.details, result, replayed, seq }, receipt.error.code === 'SYNC_RACE');
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
      await Promise.allSettled([...this.classifiers.values()]);
      await this.apply(current);
      let error: VerifyReceipt['error'] = null;
      const race = (): NonNullable<VerifyReceipt['error']> => {
        const comparisons = [
          ['sourceEpoch', proof.sourceEpoch, this.state.sourceEpoch],
          ['sourceVersion', proof.expectedSourceVersion, current.source.sourceVersion],
          ['modelRevision', proof.expectedModelRevision, current.model?.revision ?? null],
          ['captureGeneration', current.generation, this.changeGeneration],
          ['preflightGeneration', preflight.generation, current.generation],
          ['preflightEpoch', preflight.epoch, current.epoch],
          ['preflightSourceVersion', preflight.source.sourceVersion, current.source.sourceVersion],
          ['sourceScanRevision', preflight.source.sourceScanRevision, current.source.sourceScanRevision],
          ['preflightModelRevision', preflight.model?.revision ?? null, current.model?.revision ?? null],
        ] as const;
        const cause = !same(proof.expectedSourceVersion, current.source.sourceVersion) ? 'source-version-changed'
          : proof.expectedModelRevision !== current.model?.revision ? 'model-changed' : 'observation-changed';
        const changed = cause === 'source-version-changed' ? 'Files or the Git revision changed'
          : cause === 'model-changed' ? 'The project model or its evidence changed' : 'A new file or Git notification arrived';
        return { code: 'SYNC_RACE', message: `${changed} after review. Synchronization is still pending. Refresh the current state, review the declared scope, then submit a new declaration.`, details: {
          conflicts: comparisons.filter(([, expected, actual]) => !same(expected, actual)).map(([field, expected, actual]) => ({ field, expected, actual })),
          recovery: {
            nextAction: 'refresh-review-and-submit-new-proof', statusCommand: ['harnessl3', 'sync', 'status', '--json'], reuseRequestId: false,
            cause, reviewRequired: true, reviewScope: structuredClone(proof.scope),
            current: { sourceEpoch: this.state.sourceEpoch, sourceVersion: structuredClone(current.source.sourceVersion), modelRevision: current.model?.revision ?? null, sourceScanRevision: current.source.sourceScanRevision },
          },
        } };
      };
      let scopeValid = false;
      const evidenceProblems = current.model ? referencedEvidenceProblems(current.model) : [];
      const scopedEntities = new Set(proof.scope.entities);
      const scopedEvidence = new Set(current.model?.entities.filter(entity => scopedEntities.has(entity.id)).flatMap(entity => entity.evidenceIds));
      let pathInScope = this.pathScope(proof.scope.paths);
      const problemsInScope = () => evidenceProblems.filter(item => (item.file && pathInScope(item.file)) || scopedEvidence.has(item.evidenceId!));
      let scopedEvidenceProblems = problemsInScope();
      if (!current.model) error = { code: 'MODEL_INVALID', message: 'The current model is invalid; no successful verification was recorded.' };
      else if (current.source.sourceVersion.status === 'unknown' || !current.source.sourceScanRevision || this.state.sourceEpoch >= Number.MAX_SAFE_INTEGER) error = { code: 'SYNC_UNRESOLVED', message: 'The current source scope or invalidation epoch is unknown.' };
      else if (proof.sourceEpoch !== this.state.sourceEpoch || this.changeGeneration !== current.generation || preflight.generation !== current.generation || !same(proof.expectedSourceVersion, current.source.sourceVersion) || proof.expectedModelRevision !== current.model.revision || preflight.epoch !== current.epoch || !same(preflight.source.sourceVersion, current.source.sourceVersion) || preflight.source.sourceScanRevision !== current.source.sourceScanRevision || preflight.model?.revision !== current.model.revision) {
        error = race();
      } else {
        try { pathInScope = this.pathScope(await this.validateScope(proof, current.model)); scopeValid = true; scopedEvidenceProblems = problemsInScope(); }
        catch (failure) { error = { code: failure instanceof HarnessError ? failure.code : 'INVALID_ARGUMENT', message: failure instanceof Error ? failure.message : 'The declared scope could not be validated.' }; }
        if (!error && this.changeGeneration !== current.generation) error = race();
        if (!error && scopedEvidenceProblems.length) error = { code: 'SYNC_UNRESOLVED', message: 'Referenced evidence in the declared scope is changed, missing or unreadable; repair its current references before verifying.' };
        if (!error && (proof.disposition === 'unresolved' || proof.checks.some(check => check.status !== 'passed'))) error = { code: 'SYNC_UNRESOLVED', message: 'The declaration or its checks leave unresolved work.' };
      }
      const successful = error === null;
      this.state.proofId = randomUUID();
      if (successful) {
        this.materializePending();
        this.state.pendingPaths = this.state.pendingPaths.filter(pending => !pathInScope(pending));
        this.state.modelPending = evidenceProblems.length > 0; this.state.scanPending = false;
        this.state.state = this.state.pendingPaths.length || this.state.modelPending ? 'pending' : 'verified';
        if (this.state.state === 'verified') this.state.verifiedAt = this.instant();
      } else this.state.state = error!.code === 'SYNC_RACE' ? 'pending' : 'failed';
      const receipt: VerifyReceipt = {
        result: { ...this.currentState(), declaration: proof, scopeStatus: successful ? 'passed' : 'failed', automaticChecks: [
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
      if (this.timer) clearTimeout(this.timer);
      if (this.debounce) clearTimeout(this.debounce);
      if (this.observedNotification) clearTimeout(this.observedNotification);
      await Promise.allSettled([...this.classifiers.values()]);
      await this.running;
      await Promise.allSettled([...this.refreshes.values()].map(refresh => refresh.pending));
      await this.serial(async () => undefined);
    })();
  }
}
