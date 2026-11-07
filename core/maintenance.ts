import { lstat, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Archive, type ArchiveReference } from './archive.js';
import { HarnessError } from './errors.js';
import { canonicalJson, digest, parseJsonStrict, sha256 } from './json.js';
import { canonicalPath, isWithin, resolveInside, safeRelative } from './paths.js';
import { isErrno } from './io.js';
import type { WorktreeRecord } from './types.js';

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
type Completeness = 'complete' | 'partial' | 'unknown';
type ManifestEntry = { path: string; hash: string; bytes: number };
type Diagnostic = { code: string; path: string; taskId?: string };
type RawFile = ManifestEntry & { data: Buffer };
type Capture = { source: string; manifestHash: string; manifest: { schemaVersion: 1; sourceIdentity: string; files: ManifestEntry[] }; files: Map<string, RawFile>; tasks: SourceTask[]; diagnostics: Diagnostic[] };
type SourceTask = { id: string; record: any; sourcePath: string; sourceHash: string; closureHash: string; completeness: Completeness; snapshots: string[]; blobs: Map<string, Buffer>; diagnostics: Diagnostic[] };
type RawReference = { path: string; hash: string; rawHash: string; bytes: number };
type StoredLegacy = {
  schemaVersion: 1; kind: 'legacy-archive'; format: 'prototype-v0.16'; taskId: string;
  sourceHash: string; closureHash: string; sourcePath: string; sourceIdentity: string; manifestHash: string;
  legacyBinding: { projectId: unknown; worktreeId: unknown; sourceVersion: unknown; sourceScanRevision: null };
  legacyRetentionAt: string | null; createdAt: string | null; expiresAt: string | null; completeness: Completeness;
  rawTask: RawReference; snapshots: Record<string, RawReference>; blobs: string[];
};
type MigrationTask = { id: string; sourceHash: string; closureHash: string; archiveHash: string; rawRefs: RawReference[] };
type MigrationPayload = { kind: 'legacy-migration'; migrationId: string; manifestHash: string; manifestArchiveHash: string; sourceIdentity: string; tasks: MigrationTask[] };
export type LegacyArchive = { kind: 'legacy-archive'; status: 'complete'; format: 'prototype-v0.16'; taskId: string; binding: { projectId: string; worktreeId: string; modelRevision: string | null; catalogRevision: string | null; sourceVersion: null; sourceScanRevision: null }; throughBatchId: string | null; completeness: Completeness; record: any };
export type MigrationResult = {
  mode: 'dry-run' | 'apply'; migrationId: string; manifestHash: string; source: string; target: { projectId: string; worktreeId: string };
  tasks: { id: string; action: 'copy' | 'skip' | 'conflict'; completeness: Completeness }[];
  sourcePreserved: true; diagnostics: Diagnostic[]; replayed: boolean;
};
type MigrationOptions = { worktree: WorktreeRecord; archive: Archive; serial: <T>(work: () => Promise<T>) => Promise<T>; onCommit?: (seq: number) => unknown | Promise<unknown>; now?: () => string };
type MigrationInput = { source: string; mode?: 'dry-run' | 'apply'; requestId?: string; expectedManifest?: string };
function originalHash(value: unknown): string { return sha256(JSON.stringify(value)); }
function instant(value: unknown): string | null { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? value : null; }
function decode(bytes: Buffer, file: string): any {
  try { return parseJsonStrict(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new HarnessError('ARCHIVE_CORRUPT', 'Legacy JSON is invalid; current data cannot repair it.', { path: file }); }
}
function fileBytes(file: any): Buffer | null {
  if (!file || typeof file.path !== 'string') throw new Error('invalid-file');
  safeRelative(file.path);
  if (!HASH.test(file.hash) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !['utf8', 'base64'].includes(file.encoding)) throw new Error('invalid-file');
  if (file.content === undefined) return null;
  if (typeof file.content !== 'string') throw new Error('invalid-content');
  const bytes = Buffer.from(file.content, file.encoding);
  if (file.encoding === 'base64' && bytes.toString('base64') !== file.content || bytes.length !== file.bytes || sha256(bytes) !== file.hash) throw new Error('file-hash');
  if (file.encoding === 'utf8' && bytes.toString('utf8') !== file.content) throw new Error('invalid-unicode');
  return bytes;
}
function plans(record: any): any[] { return [record.skillPlan, ...(Array.isArray(record.batches) ? record.batches.map((batch: any) => batch?.skillPlan) : [])].filter(Boolean); }
function verifyTask(record: any, snapshots: Map<string, RawFile>, sourcePath: string): { snapshotIds: string[]; blobs: Map<string, Buffer>; completeness: Completeness; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  if (!record || typeof record !== 'object' || !UUID.test(record.id) || typeof record.title !== 'string' || !Array.isArray(record.batches)) throw new Error('invalid-task');
  const snapshotIds = new Set<string>();
  if (record.initialSnapshotId != null) { if (!HASH.test(record.initialSnapshotId)) throw new Error('invalid-snapshot-reference'); snapshotIds.add(record.initialSnapshotId); }
  const batchIds = new Set<string>();
  for (const batch of record.batches) {
    if (!batch || !UUID.test(batch.id) || batchIds.has(batch.id)) throw new Error('invalid-batch');
    batchIds.add(batch.id);
    if (batch.result && (!Array.isArray(batch.result.contexts) || !Array.isArray(batch.result.directories))) throw new Error('invalid-batch-result');
    if (batch.snapshotId != null) { if (!HASH.test(batch.snapshotId)) throw new Error('invalid-snapshot-reference'); snapshotIds.add(batch.snapshotId); }
    for (const body of batch.result?.contexts ?? []) {
      if (body?.contentHash !== undefined) { const { contentHash, ...content } = body; if (!HASH.test(contentHash) || originalHash(content) !== contentHash) throw new Error('context-hash'); }
    }
  }
  for (const snapshotId of snapshotIds) {
    const file = snapshots.get(snapshotId);
    if (!file) throw new Error('missing-referenced-snapshot');
    const saved = decode(file.data, file.path);
    if (saved?.id !== snapshotId || originalHash(saved.snapshot) !== snapshotId) throw new Error('snapshot-hash');
  }
  const blobs = new Map<string, Buffer>();
  let missingFiles = false;
  for (const plan of plans(record)) {
    if (!plan || plan.status !== 'selected' || !Array.isArray(plan.skills)) throw new Error('invalid-skill-plan');
    const skillIds = new Set<string>();
    for (const skill of plan.skills) {
      if (!skill || typeof skill.id !== 'string' || !skill.id || skillIds.has(skill.id) || typeof skill.group !== 'string' || !Array.isArray(skill.files) || !skill.files.length) throw new Error('invalid-skill');
      skillIds.add(skill.id);
      const paths = new Set<string>();
      for (const file of skill.files) {
        if (paths.has(file.path)) throw new Error('duplicate-skill-file');
        paths.add(file.path);
        const bytes = fileBytes(file);
        if (bytes) blobs.set(file.hash, bytes);
        else { missingFiles = true; diagnostics.push({ code: 'LEGACY_SKILL_BYTES_UNKNOWN', path: sourcePath, taskId: record.id }); }
      }
      if (skill.contentHash !== undefined && (!HASH.test(skill.contentHash) || originalHash(skill.files.map((file: any) => [file.path, file.hash])) !== skill.contentHash)) throw new Error('skill-set-hash');
    }
  }
  const known = record.packet && typeof record.packet === 'object' || record.batches.some((batch: any) => batch.result) || plans(record).length;
  const completeness = snapshotIds.size && !missingFiles ? 'complete' : known ? 'partial' : 'unknown';
  return { snapshotIds: [...snapshotIds], blobs, completeness, diagnostics };
}
function scrubSkills(record: any): any {
  const copy = structuredClone(record);
  for (const plan of plans(copy)) for (const skill of plan.skills ?? []) for (const file of skill.files ?? []) delete file.content;
  return copy;
}

/** Prototype inputs are copied as immutable raw-byte snapshots; they are never rewritten. */
export class MigrationService {
  private readonly options: MigrationOptions;
  constructor(options: MigrationOptions) { this.options = options; }
  private scope(): string { return `migration:${this.options.worktree.id}`; }
  private target() { return { projectId: this.options.worktree.projectId, worktreeId: this.options.worktree.id }; }
  private inspector(): Archive { return new Archive(this.options.archive.root, { readOnly: true }); }
  private async capture(source: string): Promise<Capture> {
    const canonical = await realpath(source).catch(() => { throw new HarnessError('IO_ERROR', 'The explicit prototype source is unavailable.'); });
    if (!(await lstat(canonical)).isDirectory()) throw new HarnessError('INVALID_ARGUMENT', 'Prototype source must be a directory.');
    const files = new Map<string, RawFile>();
    const diagnostics: Diagnostic[] = [];
    for (const directory of ['context-tasks', 'context-snapshots']) {
      const root = path.join(canonical, directory);
      let entries;
      try { const info = await lstat(root); if (!info.isDirectory() || info.isSymbolicLink()) throw new HarnessError('INVALID_ARGUMENT', 'Prototype archive directories cannot follow links.', { path: root }); entries = await readdir(root, { withFileTypes: true }); }
      catch (error) { if (directory === 'context-snapshots' && isErrno(error, 'ENOENT')) continue; throw error; }
      for (const entry of entries) {
        const relative = `${directory}/${entry.name}`;
        if (entry.isSymbolicLink()) throw new HarnessError('INVALID_ARGUMENT', 'Prototype archive entries cannot follow links.', { path: relative });
        const pattern = directory === 'context-tasks' ? /^[a-f0-9-]{36}\.json$/ : /^[a-f0-9]{64}\.json$/;
        if (!entry.isFile() || !pattern.test(entry.name)) { diagnostics.push({ code: 'UNKNOWN_SOURCE_ENTRY_PRESERVED', path: relative }); continue; }
        const absolute = await resolveInside(canonical, relative, { noSymlinks: true });
        const info = await lstat(absolute);
        const bytes = await readFile(absolute);
        const after = await lstat(absolute);
        if (info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ino !== after.ino || bytes.length !== after.size) throw new HarnessError('VERSION_CONFLICT', 'Prototype source changed while it was being captured.', { path: relative });
        files.set(relative, { path: relative, hash: sha256(bytes), bytes: bytes.length, data: bytes });
      }
    }
    const entries: ManifestEntry[] = [...files.values()].map(({ data: _data, ...entry }) => entry).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const manifest = { schemaVersion: 1 as const, sourceIdentity: digest('prototype-source', { canonicalPath: canonical }), files: entries };
    const snapshots = new Map([...files.values()].filter(file => file.path.startsWith('context-snapshots/')).map(file => [path.basename(file.path, '.json'), file]));
    const tasks: SourceTask[] = [];
    for (const file of [...files.values()].filter(file => file.path.startsWith('context-tasks/'))) {
      const taskId = path.basename(file.path, '.json');
      try {
        const record = decode(file.data, file.path);
        if (record.id !== taskId) throw new Error('task-id');
        const verified = verifyTask(record, snapshots, file.path);
        const closure = { task: { path: file.path, hash: file.hash, bytes: file.bytes }, snapshots: verified.snapshotIds.map(id => { const snapshot = snapshots.get(id)!; return { path: snapshot.path, hash: snapshot.hash, bytes: snapshot.bytes }; }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), blobs: [...verified.blobs.keys()].sort() };
        tasks.push({ id: taskId, record, sourcePath: file.path, sourceHash: file.hash, closureHash: digest('legacy-task-closure', closure), completeness: verified.completeness, snapshots: verified.snapshotIds, blobs: verified.blobs, diagnostics: verified.diagnostics });
      } catch {
        tasks.push({ id: taskId, record: null, sourcePath: file.path, sourceHash: file.hash, closureHash: '', completeness: 'unknown', snapshots: [], blobs: new Map(), diagnostics: [{ code: 'LEGACY_ARCHIVE_CORRUPT', path: file.path, taskId }] });
      }
    }
    return { source: canonical, manifestHash: digest('legacy-manifest', manifest), manifest, files, tasks, diagnostics };
  }
  private async entries(inspector: Archive): Promise<Map<string, MigrationTask>> {
    await inspector.ready();
    if (inspector.status !== 'ready') throw new HarnessError('ARCHIVE_CORRUPT', 'The target journal requires recovery before migration or legacy discovery.', { diagnostics: inspector.diagnostics });
    const entries = new Map<string, MigrationTask>();
    for (const record of inspector.records()) {
      const payload = record.payload as any;
      if (payload?.kind === 'legacy-migration') for (const item of payload.tasks ?? []) entries.set(item.id, item);
      else if (payload?.kind === 'task' && payload.task?.id) entries.set(payload.task.id, { id: payload.task.id, sourceHash: '', closureHash: '', archiveHash: '', rawRefs: [] });
    }
    return entries;
  }
  private report(capture: Capture, existing: Map<string, MigrationTask>, mode: MigrationResult['mode']): MigrationResult {
    return { mode, migrationId: digest('legacy-migration', { sourceIdentity: capture.manifest.sourceIdentity, manifestHash: capture.manifestHash, target: this.target() }), manifestHash: capture.manifestHash, source: capture.source, target: this.target(), tasks: capture.tasks.map(task => ({ id: task.id, action: task.record === null ? 'conflict' : existing.has(task.id) ? existing.get(task.id)!.sourceHash === task.sourceHash && existing.get(task.id)!.closureHash === task.closureHash ? 'skip' : 'conflict' : 'copy', completeness: task.completeness })), sourcePreserved: true, diagnostics: [...capture.diagnostics, ...capture.tasks.flatMap(task => task.diagnostics)], replayed: false };
  }
  async run(input: MigrationInput): Promise<MigrationResult> {
    const mode = input.mode ?? 'dry-run';
    if (!['dry-run', 'apply'].includes(mode) || typeof input.source !== 'string' || !path.isAbsolute(input.source) || input.expectedManifest !== undefined && !HASH.test(input.expectedManifest)) throw new HarnessError('INVALID_ARGUMENT', 'Migration requires an absolute source and valid mode/manifest.');
    const source = await canonicalPath(input.source);
    const normalized = { operation: 'migrate prototype', source, target: this.target(), expectedManifest: input.expectedManifest ?? null };
    const inspector = this.inspector();
    if (mode === 'apply') {
      if (!input.requestId || !UUID.test(input.requestId)) throw new HarnessError('INVALID_ARGUMENT', 'Migration apply requires a UUID requestId.');
      await inspector.ready();
      const replay = await inspector.replay<MigrationResult>(this.scope(), input.requestId, normalized);
      if (replay) return { ...replay.receipt, replayed: true };
    }
    const captured = await this.capture(source);
    if (input.expectedManifest && input.expectedManifest !== captured.manifestHash) throw new HarnessError('VERSION_CONFLICT', 'Prototype source no longer matches the reviewed manifest.', { expectedManifest: input.expectedManifest, actualManifest: captured.manifestHash });
    const preview = this.report(captured, await this.entries(inspector), mode);
    if (mode === 'dry-run') return preview;
    if (preview.diagnostics.some(diagnostic => diagnostic.code === 'LEGACY_ARCHIVE_CORRUPT')) throw new HarnessError('ARCHIVE_CORRUPT', 'One or more prototype records or their referenced bytes are corrupt.', { tasks: preview.tasks, diagnostics: preview.diagnostics });
    if (preview.tasks.some(task => task.action === 'conflict')) throw new HarnessError('VERSION_CONFLICT', 'A target task ID already contains different archived content.', { tasks: preview.tasks });
    return this.options.serial(async () => {
      await this.options.archive.ready();
      const replay = await this.options.archive.replay<MigrationResult>(this.scope(), input.requestId!, normalized);
      if (replay) return { ...replay.receipt, replayed: true };
      const current = await this.capture(source);
      if (current.manifestHash !== captured.manifestHash) throw new HarnessError('VERSION_CONFLICT', 'Prototype source changed before migration apply.');
      const report = this.report(current, await this.entries(this.options.archive), 'apply');
      if (report.tasks.some(task => task.action === 'conflict')) throw new HarnessError('VERSION_CONFLICT', 'Target task content changed after migration preview.', { tasks: report.tasks });
      const references = new Map<string, ArchiveReference>();
      const raw = new Map<string, RawReference>();
      const captureRaw = async (file: RawFile): Promise<RawReference> => {
        const previous = raw.get(file.path); if (previous) return previous;
        const rawHash = await this.options.archive.snapshot('legacy-raw', { path: file.path, hash: file.hash, bytes: file.bytes, encoding: 'base64', content: file.data.toString('base64') });
        const ref = { path: file.path, hash: file.hash, bytes: file.bytes, rawHash }; raw.set(file.path, ref); references.set(`snapshot:${rawHash}`, { kind: 'snapshot', hash: rawHash }); return ref;
      };
      const imported: MigrationTask[] = [];
      for (const task of current.tasks) {
        if (report.tasks.find(item => item.id === task.id)!.action !== 'copy') continue;
        const rawTask = await captureRaw(current.files.get(task.sourcePath)!);
        const snapshots: Record<string, RawReference> = {};
        for (const snapshotId of task.snapshots) snapshots[snapshotId] = await captureRaw(current.files.get(`context-snapshots/${snapshotId}.json`)!);
        for (const [hash, bytes] of task.blobs) { const actual = await this.options.archive.blob(bytes); if (actual !== hash) throw new HarnessError('ARCHIVE_CORRUPT', 'Legacy skill bytes changed while capturing.'); references.set(`blob:${hash}`, { kind: 'blob', hash }); }
        const legacyRetentionAt = instant(task.record.updatedAt);
        const stored: StoredLegacy = { schemaVersion: 1, kind: 'legacy-archive', format: 'prototype-v0.16', taskId: task.id, sourceHash: task.sourceHash, closureHash: task.closureHash, sourcePath: task.sourcePath, sourceIdentity: current.manifest.sourceIdentity, manifestHash: current.manifestHash, legacyBinding: { projectId: task.record.projectId ?? null, worktreeId: task.record.worktreeId ?? null, sourceVersion: task.record.sourceVersion ?? null, sourceScanRevision: null }, legacyRetentionAt, createdAt: instant(task.record.createdAt), expiresAt: legacyRetentionAt ? new Date(Date.parse(legacyRetentionAt) + 60 * 86400000).toISOString() : null, completeness: task.completeness, rawTask, snapshots, blobs: [...task.blobs.keys()] };
        const archiveHash = await this.options.archive.snapshot('legacy-archive', stored);
        references.set(`snapshot:${archiveHash}`, { kind: 'snapshot', hash: archiveHash });
        imported.push({ id: task.id, sourceHash: task.sourceHash, closureHash: task.closureHash, archiveHash, rawRefs: [rawTask, ...Object.values(snapshots)] });
      }
      const manifestArchiveHash = await this.options.archive.snapshot('legacy-manifest', current.manifest);
      references.set(`snapshot:${manifestArchiveHash}`, { kind: 'snapshot', hash: manifestArchiveHash });
      const final = await this.capture(source);
      if (final.manifestHash !== current.manifestHash) throw new HarnessError('VERSION_CONFLICT', 'Prototype source changed during migration; no migration commit was created.');
      const payload: MigrationPayload = { kind: 'legacy-migration', migrationId: report.migrationId, manifestHash: current.manifestHash, manifestArchiveHash, sourceIdentity: current.manifest.sourceIdentity, tasks: imported };
      const result = await this.options.archive.commit({ scope: this.scope(), requestId: input.requestId!, request: normalized, payload, receipt: report, archives: [...references.values()] });
      await this.options.onCommit?.(result.seq);
      return { ...result.receipt, replayed: result.replayed };
    });
  }
  private async raw(inspector: Archive, reference: RawReference): Promise<Buffer> {
    const content = await inspector.readSnapshot<any>(reference.rawHash);
    if (content?.path !== reference.path || content.hash !== reference.hash || content.bytes !== reference.bytes || content.encoding !== 'base64' || typeof content.content !== 'string') throw new HarnessError('ARCHIVE_CORRUPT', 'Legacy raw archive reference does not match.');
    const bytes = Buffer.from(content.content, 'base64');
    if (bytes.toString('base64') !== content.content || bytes.length !== reference.bytes || sha256(bytes) !== reference.hash) throw new HarnessError('ARCHIVE_CORRUPT', 'Legacy raw archive bytes are corrupt.');
    return bytes;
  }
  private async load(taskId: string, context?: { inspector: Archive; entries: Map<string, MigrationTask> }): Promise<{ inspector: Archive; stored: StoredLegacy; record: any; snapshots: Map<string, RawFile> }> {
    if (!UUID.test(taskId)) throw new HarnessError('INVALID_ARGUMENT', 'Legacy task ID must retain its original UUID.');
    const inspector = context?.inspector ?? this.inspector();
    const entries = context?.entries ?? await this.entries(inspector);
    const entry = entries.get(taskId);
    if (!entry?.archiveHash) throw new HarnessError('NOT_FOUND', 'No imported legacy task belongs to this worktree.', { taskId });
    const stored = await inspector.readSnapshot<StoredLegacy>(entry.archiveHash);
    if (stored.schemaVersion !== 1 || stored.kind !== 'legacy-archive' || stored.taskId !== taskId || stored.sourceHash !== entry.sourceHash || stored.closureHash !== entry.closureHash) throw new HarnessError('ARCHIVE_CORRUPT', 'Legacy envelope identity is invalid.');
    const record = decode(await this.raw(inspector, stored.rawTask), stored.rawTask.path);
    const snapshots = new Map<string, RawFile>();
    for (const [snapshotId, reference] of Object.entries(stored.snapshots)) snapshots.set(snapshotId, { path: reference.path, hash: reference.hash, bytes: reference.bytes, data: await this.raw(inspector, reference) });
    try { verifyTask(record, snapshots, stored.sourcePath); } catch { throw new HarnessError('ARCHIVE_CORRUPT', 'Imported prototype record no longer has a valid original reference closure.'); }
    return { inspector, stored, record, snapshots };
  }
  async has(taskId: string): Promise<boolean> {
    // The owning runtime has already verified and loaded this journal. Format
    // routing must not reopen every unrelated snapshot on each task/view read.
    // Explicit migration inspection and requested archive reads keep their checks.
    return (await this.entries(this.options.archive)).get(taskId)?.archiveHash ? true : false;
  }
  async list(): Promise<any[]> {
    const inspector = this.inspector();
    const result = [];
    const entries = await this.entries(inspector);
    for (const entry of entries.values()) {
      if (!entry.archiveHash) continue;
      const { stored, record } = await this.load(entry.id, { inspector, entries });
      const plan = [...record.batches].reverse().find((batch: any) => ['complete', 'partial'].includes(batch.status) && batch.skillPlan)?.skillPlan ?? record.skillPlan ?? null;
      result.push({ id: stored.taskId, title: record.title, binding: { ...this.target(), modelRevision: HASH.test(record.modelRevision) ? record.modelRevision : null, catalogRevision: HASH.test(plan?.catalogRevision) ? plan.catalogRevision : null, sourceVersion: null, sourceScanRevision: null }, createdAt: stored.createdAt, lastReadAt: stored.legacyRetentionAt, retentionBasisAt: stored.legacyRetentionAt, expiresAt: stored.expiresAt, closedAt: null, declaredSession: record.sessionId ?? null, contextCount: record.packet?.contexts?.length ?? 0, skillCount: plan?.skills?.length ?? 0, completeness: stored.completeness, format: 'prototype-v0.16', legacyBinding: stored.legacyBinding });
    }
    return result;
  }
  async show(taskId: string, throughBatchId?: string): Promise<LegacyArchive> {
    const { stored, record, snapshots } = await this.load(taskId);
    const originalBatches = record.batches;
    const index = throughBatchId ? originalBatches.findIndex((batch: any) => batch.id === throughBatchId) : originalBatches.length - 1;
    if (throughBatchId && index < 0) throw new HarnessError('NOT_FOUND', 'The requested legacy batch is not in this task.');
    record.batches = originalBatches.slice(0, index + 1);
    const selected = [...record.batches].reverse().find((batch: any) => ['complete', 'partial'].includes(batch.status) && batch.result && batch.skillPlan)?.skillPlan ?? (!throughBatchId ? record.skillPlan ?? null : null);
    record.skillPlan = selected;
    if (throughBatchId) {
      const contexts = new Map();
      for (const batch of record.batches) if (['complete', 'partial'].includes(batch.status) && batch.result) for (const body of batch.result.contexts ?? []) contexts.set(body.id, body);
      record.packet = { ...(record.packet ?? {}), contexts: [...contexts.values()] };
    }
    const snapshotId = [...record.batches].reverse().find((batch: any) => batch.snapshotId)?.snapshotId ?? record.initialSnapshotId ?? null;
    record.legacyContextSnapshot = snapshotId && snapshots.has(snapshotId) ? decode(snapshots.get(snapshotId)!.data, snapshots.get(snapshotId)!.path).snapshot : null;
    record.legacyArchive = { legacyBinding: stored.legacyBinding, legacyRetentionAt: stored.legacyRetentionAt, sourceManifestHash: stored.manifestHash, sourceRawHash: stored.sourceHash, snapshotId, unknown: ['sourceScanRevision', 'full-source-tree-version', ...(snapshotId ? [] : ['complete-model-snapshot'])] };
    const completeness = snapshotId ? stored.completeness : record.packet || record.batches.some((batch: any) => batch.result) ? 'partial' : 'unknown';
    return { kind: 'legacy-archive', status: 'complete', format: 'prototype-v0.16', taskId, binding: { ...this.target(), modelRevision: HASH.test(record.modelRevision) ? record.modelRevision : null, catalogRevision: HASH.test(selected?.catalogRevision) ? selected.catalogRevision : null, sourceVersion: null, sourceScanRevision: null }, throughBatchId: throughBatchId ?? (index >= 0 && UUID.test(record.batches[index]?.id) ? record.batches[index].id : null), completeness, record: scrubSkills(record) };
  }
  async read(taskId: string, input: { files: { skillId: string; path: string; expectedHash?: string }[]; throughBatchId?: string }): Promise<LegacyArchive> {
    if (!input || !Array.isArray(input.files) || !input.files.length) throw new HarnessError('INVALID_ARGUMENT', 'Legacy file reads require explicit selected file references.');
    const wrapper = await this.show(taskId, input.throughBatchId);
    const { inspector, record } = await this.load(taskId);
    const through = wrapper.throughBatchId ? record.batches.findIndex((batch: any) => batch.id === wrapper.throughBatchId) : record.batches.length - 1;
    const plan = [...record.batches.slice(0, through + 1)].reverse().find((batch: any) => ['complete', 'partial'].includes(batch.status) && batch.result && batch.skillPlan)?.skillPlan ?? (!input.throughBatchId ? record.skillPlan : null);
    const files = [], errors = [];
    for (const requested of input.files) {
      try {
        safeRelative(requested.path);
        const skill = plan?.skills?.find((item: any) => item.id === requested.skillId);
        if (!skill) throw new HarnessError('SKILL_NOT_SELECTED', 'The legacy skill was not selected by this batch.');
        const file = skill.files.find((item: any) => item.path === requested.path);
        if (!file) throw new HarnessError('FILE_NOT_ARCHIVED', 'The requested file was not retained in the legacy plan.');
        if (file.content === undefined) throw new HarnessError('FILE_NOT_ARCHIVED', 'The legacy record retained a reference without the original file bytes.');
        if (requested.expectedHash !== undefined && requested.expectedHash !== file.hash) throw new HarnessError('HASH_MISMATCH', 'The expected fingerprint differs from the original legacy bytes.');
        const bytes = await inspector.readBlob(file.hash);
        if (bytes.length !== file.bytes || sha256(bytes) !== file.hash) throw new HarnessError('ARCHIVE_CORRUPT', 'Legacy skill bytes do not match their original reference.');
        files.push({ skillId: skill.id, file: { path: file.path, hash: file.hash, bytes: file.bytes, encoding: file.encoding, content: bytes.toString(file.encoding) } });
      } catch (error) {
        if (error instanceof HarnessError && error.code === 'ARCHIVE_CORRUPT') throw error;
        errors.push({ skillId: requested.skillId, path: requested.path, code: error instanceof HarnessError ? error.code : 'FILE_NOT_ARCHIVED' });
      }
    }
    wrapper.record.legacyRead = { files, errors, observation: 'archived-files-returned; execution-and-understanding-unknown' };
    return wrapper;
  }
}

type Candidate = { path: string; kind: 'expired-cache' | 'rebuildable-index' | 'uncommitted-staging'; bytes: number; reason: string; worktreeId: string; hash: string };
type GCOptions = { dataRoot: string; worktrees?: WorktreeRecord[]; isLeased?: (path: string) => boolean | undefined | Promise<boolean | undefined>; isReferenced?: (path: string) => boolean | undefined | Promise<boolean | undefined>; now?: () => string };
export type GCResult = { mode: 'dry-run' | 'apply'; planHash: string; candidates: Omit<Candidate, 'hash'>[]; totalBytes: number; removed: string[]; skipped: { path: string; reason: string }[] };

/** Deletes individual positively identified derived files, never history or unknown data. */
export class GarbageCollector {
  private readonly options: GCOptions;
  constructor(options: GCOptions) { if (!path.isAbsolute(options.dataRoot)) throw new HarnessError('INVALID_ARGUMENT', 'GC data root must be absolute.'); this.options = options; }
  private async lease(file: string): Promise<boolean | undefined> { return this.options.isLeased?.(file); }
  private async enumerate(): Promise<{ root: string; candidates: Candidate[] }> {
    const root = await canonicalPath(this.options.dataRoot);
    let worktrees = this.options.worktrees;
    if (!worktrees) {
      try { const registry = decode(await readFile(path.join(root, 'registry.json')), 'registry.json'); worktrees = registry.schemaVersion === 1 && Array.isArray(registry.worktrees) ? registry.worktrees : []; }
      catch (error) { if (!isErrno(error, 'ENOENT')) throw error; worktrees = []; }
    }
    const candidates: Candidate[] = [];
    const seenWorktrees = new Set<string>();
    for (const worktree of worktrees ?? []) {
      if (!UUID.test(worktree.id) || seenWorktrees.has(worktree.id)) continue;
      seenWorktrees.add(worktree.id);
      let worktreeRoot: string;
      try { worktreeRoot = await resolveInside(root, `worktrees/${worktree.id}`, { noSymlinks: true }); }
      catch { continue; }
      const inspector = new Archive(worktreeRoot, { readOnly: true });
      try { await inspector.ready(); if (inspector.status !== 'ready') continue; }
      catch { continue; }
      const add = async (file: string, kind: Candidate['kind'], reason: string) => {
        try {
          const info = await lstat(file);
          if (!info.isFile() || info.isSymbolicLink() || await this.lease(file) !== false || this.options.isReferenced && await this.options.isReferenced(file) !== false) return;
          const relative = path.relative(root, file).replaceAll('\\', '/');
          await resolveInside(root, relative, { noSymlinks: true });
          const bytes = await readFile(file);
          if (bytes.length !== info.size) return;
          candidates.push({ path: file, kind, bytes: bytes.length, reason, worktreeId: worktree.id, hash: sha256(bytes) });
        } catch { /* Unknown, changing and inaccessible files are retained. */ }
      };
      let rootEntries: string[];
      try { rootEntries = await readdir(worktreeRoot); } catch { continue; }
      for (const entry of rootEntries) {
        if (entry === 'index.sqlite' || entry.startsWith('index.sqlite.invalid-') && UUID.test(entry.slice('index.sqlite.invalid-'.length))) {
          const file = path.join(worktreeRoot, entry);
          if (entry === 'index.sqlite') { try { const info = await lstat(file); if (info.isSymbolicLink() || !(await readFile(file)).subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) continue; } catch { continue; } }
          await add(file, 'rebuildable-index', 'Closed derived SQLite index; authoritative files and journal are retained.');
        }
      }
      for (const directory of ['snapshots', 'skill-blobs', 'tasks', 'checkpoints']) {
        let base: string;
        try { base = await resolveInside(root, `worktrees/${worktree.id}/${directory}`, { noSymlinks: true }); }
        catch { continue; }
        for (const entry of await readdir(base, { withFileTypes: true })) {
          const pattern = directory === 'snapshots' ? /^\.([a-f0-9]{64})\.json\.([a-f0-9-]{36})\.tmp$/ : directory === 'skill-blobs' ? /^\.([a-f0-9]{64})\.([a-f0-9-]{36})\.tmp$/ : /^\.([a-f0-9-]{36})\.json\.([a-f0-9-]{36})\.tmp$/;
          const match = entry.name.match(pattern);
          if (entry.isFile() && !entry.isSymbolicLink() && match && UUID.test(match[2]) && (directory === 'snapshots' || directory === 'skill-blobs' || UUID.test(match[1]))) await add(path.join(base, entry.name), 'uncommitted-staging', 'Recognized atomic-write staging path with no active lease and no valid journal reference.');
        }
      }
      const visitCache = async (directory: string, depth: number): Promise<void> => {
        if (depth > 8) return;
        let entries;
        try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) { await visitCache(file, depth + 1); continue; }
          if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
          try {
            const info = decode(await readFile(file), file);
            if (info.schemaVersion === 1 && ['harness-cache', 'model-cache', 'catalog-cache', 'query-cache', 'layout-cache'].includes(info.kind) && info.rebuildable === true && typeof info.generator === 'string' && instant(info.expiresAt) && Date.parse(info.expiresAt) <= Date.parse(this.options.now?.() ?? new Date().toISOString())) await add(file, 'expired-cache', 'Explicitly rebuildable cache metadata has expired.');
          } catch { /* A filename alone never makes an unknown cache file disposable. */ }
        }
      };
      try { const cache = await resolveInside(root, `worktrees/${worktree.id}/cache`, { noSymlinks: true }); await visitCache(cache, 0); } catch {}
    }
    return { root, candidates: candidates.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
  }
  async run(input: { mode?: 'dry-run' | 'apply'; expectedPlan?: string } = {}): Promise<GCResult> {
    const mode = input.mode ?? 'dry-run';
    if (!['dry-run', 'apply'].includes(mode) || input.expectedPlan !== undefined && !HASH.test(input.expectedPlan)) throw new HarnessError('INVALID_ARGUMENT', 'Invalid GC mode or plan fingerprint.');
    const { root, candidates } = await this.enumerate();
    const planHash = digest('gc-plan', { root, candidates });
    if (input.expectedPlan && input.expectedPlan !== planHash) throw new HarnessError('VERSION_CONFLICT', 'The GC candidate set changed after its preview.');
    const result: GCResult = { mode, planHash, candidates: candidates.map(({ hash: _hash, ...item }) => item), totalBytes: candidates.reduce((sum, item) => sum + item.bytes, 0), removed: [], skipped: [] };
    if (mode === 'dry-run') return result;
    for (const candidate of candidates) {
      try {
        const relative = path.relative(root, candidate.path).replaceAll('\\', '/');
        if (!isWithin(root, candidate.path, false)) throw new Error('out-of-root');
        await resolveInside(root, relative, { noSymlinks: true });
        const info = await lstat(candidate.path);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== candidate.bytes || sha256(await readFile(candidate.path)) !== candidate.hash) throw new Error('changed-content');
        const inspector = new Archive(path.join(root, 'worktrees', candidate.worktreeId), { readOnly: true });
        await inspector.ready();
        if (inspector.status !== 'ready') throw new Error('archive-reference-status-unknown');
        if (await this.lease(candidate.path) !== false) throw new Error('active-or-unknown-lease');
        if (this.options.isReferenced && await this.options.isReferenced(candidate.path) !== false) throw new Error('referenced-or-unknown');
        // Callbacks may yield to an editor or a newly accepted request. Check again last.
        await resolveInside(root, relative, { noSymlinks: true });
        const finalInfo = await lstat(candidate.path);
        if (!finalInfo.isFile() || finalInfo.isSymbolicLink() || finalInfo.ino !== info.ino || finalInfo.size !== candidate.bytes || sha256(await readFile(candidate.path)) !== candidate.hash) throw new Error('changed-content-after-lease');
        // Unlink a single regular file; no directory recursion or link traversal.
        await unlink(candidate.path);
        result.removed.push(candidate.path);
      } catch { result.skipped.push({ path: candidate.path, reason: 'Content, path, archive references or lease changed; retained.' }); }
    }
    return result;
  }
}
