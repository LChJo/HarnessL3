import { open, readFile, mkdir, lstat } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { openSync, closeSync, readSync, lstatSync } from 'node:fs';
import { checkAuditCancellation, reportProgress } from './progress.js';
import { HarnessError, asHarnessError, permissionError } from './errors.js';
import { canonicalJson, digest, parseJsonStrict, sha256 } from './json.js';
import { atomicWrite, ensureDir, isErrno, requireWriteCapacity } from './io.js';
import { packedArchive } from './packed-archive.js';

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MATERIALIZATION = /^(tasks|checkpoints)\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/i;
type Snapshot = { schemaVersion: 1; kind: string; content: unknown; hash: string };
export type ArchiveReference = { kind: 'snapshot' | 'blob'; hash: string };
export type Materialization = { path: string; content: unknown; contentHash: string };
export type ArchiveDiagnostic = { code: string; message: string; path?: string; seq?: number; verifiedThrough?: number };
export type CommitRecord = {
  schemaVersion: 1;
  seq: number;
  operationId: string;
  scope: string;
  requestId: string;
  requestHash: string;
  committedAt: string;
  previousHash: string | null;
  payload: unknown;
  receiptHash: string;
  archives: ArchiveReference[];
  materializations: Materialization[];
  hash: string;
};
export type CommitInput<T> = {
  scope: string;
  requestId: string;
  request: unknown;
  payload: unknown;
  receipt: T;
  archives?: ArchiveReference[];
  materializations?: { path: string; content: unknown }[];
};
export type CommitResult<T> = { receipt: T; replayed: boolean; seq: number };
export interface RecordFilter { kind?: string; taskId?: string; excludeKinds?: readonly string[]; afterSeq?: number; businessOnly?: boolean; requestId?: string }
export interface CommitHeader { seq: number; operationId: string; committedAt: string; scope: string; requestId: string; receiptHash: string; kind: string | null; taskId: string | null; operation: string | null; source: string | null }
interface StoredRecord extends CommitHeader { hash: string; requestHash: string; archives: ArchiveReference[]; offset: number; length: number }

function corrupt(message: string, details: Record<string, unknown> = {}): HarnessError {
  return new HarnessError('ARCHIVE_CORRUPT', message, details);
}
function validateHash(hash: string): void {
  if (typeof hash !== 'string' || !HASH.test(hash)) throw new HarnessError('INVALID_ARGUMENT', 'Expected a lowercase SHA-256 archive reference.');
}
function validateRequest(scope: string, requestId: string): void {
  if (typeof scope !== 'string' || !scope.length || scope.length > 1024 || /[\u0000-\u001f]/.test(scope) || !UUID.test(requestId)) {
    throw new HarnessError('INVALID_ARGUMENT', 'Archive request scope and UUID requestId are required.');
  }
}
function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
function recordContent(record: CommitRecord): Omit<CommitRecord, 'hash'> {
  const { hash: _hash, ...content } = record;
  return content;
}

/** Shared format verifier for the legacy reader, packed writer and explicit migration. */
export function validateCommitRecord(record: CommitRecord, previousSeq: number, previousHash: string | null, hasRequest: (scope: string, requestId: string) => boolean): void {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw corrupt('Commit must be an object.');
  const fields = ['schemaVersion', 'seq', 'operationId', 'scope', 'requestId', 'requestHash', 'committedAt', 'previousHash', 'payload', 'receiptHash', 'archives', 'materializations', 'hash'];
  if (Object.keys(record).length !== fields.length || fields.some(key => !Object.hasOwn(record, key))) throw corrupt('Commit fields are invalid.');
  if (record.schemaVersion !== 1 || record.seq !== previousSeq + 1 || !Number.isSafeInteger(record.seq) || !UUID.test(record.operationId)) throw corrupt('Commit schema or sequence is invalid.');
  validateRequest(record.scope, record.requestId);
  validateHash(record.requestHash); validateHash(record.receiptHash); validateHash(record.hash);
  if (record.previousHash !== previousHash) throw corrupt('Commit hash chain is broken.');
  if (typeof record.committedAt !== 'string' || !Number.isFinite(Date.parse(record.committedAt))) throw corrupt('Commit time is invalid.');
  if (digest('commit', recordContent(record)) !== record.hash) throw corrupt('Commit fingerprint does not match.');
  if (hasRequest(record.scope, record.requestId)) throw corrupt('Duplicate committed request.');
  if (!Array.isArray(record.archives) || !Array.isArray(record.materializations)) throw corrupt('Commit archive references must be arrays.');
  for (const reference of record.archives) {
    if (!reference || Object.keys(reference).length !== 2 || !['snapshot', 'blob'].includes(reference.kind)) throw corrupt('Invalid archive reference.');
    validateHash(reference.hash);
  }
  if (!record.archives.some(reference => reference.kind === 'snapshot' && reference.hash === record.receiptHash)) throw corrupt('Commit receipt archive is not referenced.');
  const paths = new Set<string>();
  for (const item of record.materializations) {
    if (!item || Object.keys(item).length !== 3 || !MATERIALIZATION.test(item.path) || paths.has(item.path)) throw corrupt('Invalid materialization path.');
    paths.add(item.path);
    if (digest('materialization', { path: item.path, content: item.content }) !== item.contentHash) throw corrupt('Materialization fingerprint does not match.');
  }
}

export function verifySnapshotBytes(hash: string, bytes: Uint8Array): unknown {
  validateHash(hash);
  const text = decode(bytes);
  // Most immutable snapshots were emitted in canonical JSON. The fast path
  // proves native round-trip byte equality (no collapsed duplicate keys or
  // normalized numbers/escapes), lexical key order at every object and no
  // potentially unpaired escaped surrogate. Any noncanonical form uses the
  // original strict parser and JCS encoder, not a weaker checksum shortcut.
  const lexical = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return true;
    if (Array.isArray(value)) return value.every(lexical);
    const keys = Object.keys(value);
    for (let i = 1; i < keys.length; i++) if (keys[i - 1]! > keys[i]!) return false;
    return keys.every(key => lexical((value as Record<string, unknown>)[key]));
  };
  if (!/\\u[dD][89a-fA-F][0-9a-fA-F]{2}/.test(text)) {
    try {
      const candidate = JSON.parse(text) as Snapshot;
      if (candidate && typeof candidate === 'object' && Object.keys(candidate).length === 4 && Object.hasOwn(candidate, 'content') && candidate.schemaVersion === 1 && typeof candidate.kind === 'string' && candidate.kind && candidate.hash === hash && lexical(candidate)) {
        const encoded = JSON.stringify(candidate);
        if ((text === encoded || text === encoded + '\n') && sha256(JSON.stringify({ content: candidate.content, kind: candidate.kind, schemaVersion: 1 })) === hash) return candidate.content;
      }
    } catch { /* Strict verification below preserves all old rejection behavior. */ }
  }
  const snapshot = parseJsonStrict(text) as Snapshot;
  if (!snapshot || typeof snapshot !== 'object' || Object.keys(snapshot).length !== 4 || snapshot.schemaVersion !== 1 || typeof snapshot.kind !== 'string' || !snapshot.kind || snapshot.hash !== hash || digest(snapshot.kind, snapshot.content) !== hash) throw corrupt('Snapshot fingerprint or schema is invalid.', { hash });
  return snapshot.content;
}

/** The durable file journal is authoritative. No command is executed during recovery. */
export class Archive {
  readonly root: string;
  readonly readOnly: boolean;
  private loaded?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private commits: StoredRecord[] = [];
  private readonly bySequence = new Map<number, StoredRecord>();
  private requests = new Map<string, StoredRecord>();
  private byKind = new Map<string, StoredRecord[]>();
  private byTask = new Map<string, StoredRecord[]>();
  private journalBytes = 0;
  private state: 'ready' | 'recovery-required' = 'ready';
  private problems: ArchiveDiagnostic[] = [];
  private journalKindsOnly = false;
  private readonly packed: ReturnType<typeof packedArchive>;
  private readonly capacity: typeof requireWriteCapacity;
  private readonly counters = { recordReads: 0, snapshotReads: 0, blobReads: 0, logicalReadBytes: 0, logicalWriteBytes: 0, newSnapshots: 0, newBlobs: 0, businessCommits: 0 };
  readonly verificationScope: 'workspace' | 'requested' | 'operational';

  constructor(root: string, options: { readOnly?: boolean; verification?: 'requested' | 'operational'; packedSource?: NonNullable<ReturnType<typeof packedArchive>>; capacity?: typeof requireWriteCapacity } = {}) {
    if (!isAbsolute(root)) throw new HarnessError('INVALID_ARGUMENT', 'Archive root must be absolute.');
    this.root = resolve(root);
    if (options.packedSource && !options.readOnly) throw new HarnessError('INVALID_ARGUMENT', 'An unpublished packed source is read-only.');
    this.packed = options.packedSource ?? packedArchive(this.root);
    this.capacity = options.capacity ?? requireWriteCapacity;
    this.readOnly = options.readOnly === true;
    this.verificationScope = options.verification ?? 'workspace';
    if (this.verificationScope === 'requested' && !this.readOnly) throw new HarnessError('INVALID_ARGUMENT', 'Scoped archive browsing must be read-only.');
    this.journalKindsOnly = this.verificationScope === 'requested';
  }
  get status(): 'ready' | 'recovery-required' { return this.state; }
  get diagnostics(): ArchiveDiagnostic[] { return structuredClone(this.problems); }
  get seq(): number { return this.packed ? this.packed.store.latest(this.packed.worktree).seq : this.commits.at(-1)?.seq ?? 0; }
  get format(): 'loose-v1' | 'packed-sqlite/1' { return this.packed ? 'packed-sqlite/1' : 'loose-v1'; }
  metrics() { return { ...this.counters, format: this.format, seq: this.seq, bytesScope: 'logical-archive-payloads; not physical disk I/O' }; }
  private previousHash(): string | null { return this.packed ? this.packed.store.latest(this.packed.worktree).hash : this.commits.at(-1)?.hash ?? null; }
  /** Routing hint only: validates the journal chain, never attests to archived bodies. */
  static async committedKind(root: string, kind: string): Promise<'present' | 'absent' | 'unknown'> {
    const inspection = new Archive(root, { readOnly: true });
    inspection.journalKindsOnly = true;
    await inspection.ready();
    if (inspection.status !== 'ready') return 'unknown';
    return inspection.hasKind(kind) ? 'present' : 'absent';
  }
  records(filter: RecordFilter = {}): CommitRecord[] { return [...this.scan(filter)]; }
  scan(filter: RecordFilter = {}): IterableIterator<CommitRecord> {
    const records = this.matching(filter);
    const archive = this;
    return (function* () { for (const record of records) yield archive.recordSync(record.seq); })();
  }
  async *scanAsync(filter: RecordFilter = {}): AsyncIterableIterator<CommitRecord> {
    const boundary = this.headers(filter);
    for (let i = 0; i < boundary.length; i++) {
      checkAuditCancellation(); yield await this.record(boundary[i].seq);
      if (i % 128 === 127) await setImmediate();
    }
  }
  headers(filter: RecordFilter = {}): CommitHeader[] { return Array.from(this.matching(filter), record => {
    const { hash: _hash, requestHash: _requestHash, archives: _archives, offset: _offset, length: _length, ...header } = record;
    return { ...header };
  }); }
  lastHeader(filter: RecordFilter = {}): CommitHeader | undefined {
    if (!this.packed) return this.headers(filter).at(-1);
    const record = this.packed.store.lastHeader(this.packed.worktree, filter);
    if (!record) return undefined;
    const { hash: _hash, requestHash: _requestHash, archives: _archives, offset: _offset, length: _length, ...header } = record;
    return header;
  }
  async record(seq: number): Promise<CommitRecord> { await this.ready(); return this.readRecord(this.stored(seq)); }
  async receipt(seq: number): Promise<unknown> {
    const record = await this.record(seq);
    await this.verifyReferences(record);
    return this.readSnapshot(record.receiptHash);
  }
  recordSync(seq: number): CommitRecord {
    const stored = this.stored(seq), file = join(this.root, 'journal.jsonl');
    this.counters.recordReads++; this.counters.logicalReadBytes += stored.length;
    if (this.packed) return this.packed.store.record(this.packed.worktree, seq);
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) throw corrupt('Journal is not a regular local file.');
    const descriptor = openSync(file, 'r');
    try {
      const bytes = Buffer.alloc(stored.length);
      let read = 0;
      while (read < bytes.length) { const count = readSync(descriptor, bytes, read, bytes.length - read, stored.offset + read); if (!count) throw corrupt('A committed journal record is truncated.'); read += count; }
      return this.decodeStored(bytes, stored);
    } finally { closeSync(descriptor); }
  }
  private stored(seq: number): StoredRecord {
    const record = this.packed ? this.packed.store.bySeq(this.packed.worktree, seq) : this.bySequence.get(seq);
    if (!Number.isSafeInteger(seq) || !record || record.seq !== seq) throw new HarnessError('NOT_FOUND', 'This committed sequence is not in the verified journal.', { seq });
    return record;
  }
  private decodeStored(bytes: Buffer, stored: StoredRecord): CommitRecord {
    try {
      const record = parseJsonStrict(decode(bytes)) as CommitRecord;
      if (record.hash !== stored.hash || record.seq !== stored.seq || digest('commit', recordContent(record)) !== stored.hash) throw corrupt('Committed journal bytes changed after recovery.', { seq: stored.seq });
      return record;
    } catch (error) { if (error instanceof HarnessError && error.code === 'ARCHIVE_CORRUPT') throw error; throw corrupt('Committed journal bytes are invalid.', { seq: stored.seq }); }
  }
  private async readRecord(stored: StoredRecord): Promise<CommitRecord> {
    this.counters.recordReads++; this.counters.logicalReadBytes += stored.length;
    if (this.packed) return this.packed.store.record(this.packed.worktree, stored.seq);
    const file = join(this.root, 'journal.jsonl');
    await this.regularFile(file);
    const handle = await open(file, 'r');
    try {
      const bytes = Buffer.alloc(stored.length);
      let read = 0;
      while (read < bytes.length) { const { bytesRead } = await handle.read(bytes, read, bytes.length - read, stored.offset + read); if (!bytesRead) throw corrupt('A committed journal record is truncated.'); read += bytesRead; }
      return this.decodeStored(bytes, stored);
    } finally { await handle.close(); }
  }
  references(filter: RecordFilter = {}): ArchiveReference[] {
    const references = new Map<string, ArchiveReference>();
    for (const record of this.matching(filter)) for (const reference of record.archives) references.set(`${reference.kind}:${reference.hash}`, { ...reference });
    return [...references.values()];
  }
  hasKind(kind: string): boolean { return this.packed ? !!this.packed.store.lastHeader(this.packed.worktree, { kind }) : this.byKind.has(kind); }
  hasRequest(scope: string, requestId: string): boolean { return this.packed ? !!this.packed.store.byRequest(this.packed.worktree, scope, requestId) : this.requests.has(this.key(scope, requestId)); }
  ready(): Promise<void> { return this.loaded ??= this.load(); }

  private header(record: CommitRecord): CommitHeader {
    const payload = record.payload as { kind?: unknown; task?: { id?: unknown }; operation?: unknown; source?: unknown } | null;
    return { seq: record.seq, operationId: record.operationId, committedAt: record.committedAt, scope: record.scope, requestId: record.requestId, receiptHash: record.receiptHash,
      kind: typeof payload?.kind === 'string' ? payload.kind : null,
      taskId: payload?.kind === 'task' && typeof payload.task?.id === 'string' ? payload.task.id : null,
      operation: typeof payload?.operation === 'string' ? payload.operation : null, source: typeof payload?.source === 'string' ? payload.source : null };
  }
  private matching(filter: RecordFilter): IterableIterator<StoredRecord> {
    if (this.packed) return this.packed.store.headers(this.packed.worktree, filter);
    const { kind, taskId } = filter, excluded = new Set(filter.excludeKinds);
    const records = taskId !== undefined ? this.byTask.get(taskId) ?? [] : kind !== undefined ? this.byKind.get(kind) ?? [] : this.commits;
    const length = records.length;
    return (function* () {
      for (let i = 0; i < length; i++) {
        const record = records[i], meta = record;
        if (record.seq <= (filter.afterSeq ?? 0) || kind !== undefined && meta.kind !== kind || taskId !== undefined && meta.taskId !== taskId || meta.kind !== null && excluded.has(meta.kind) || filter.requestId !== undefined && meta.requestId !== filter.requestId || filter.businessOnly && meta.kind === 'freshness-state' && meta.scope.startsWith('freshness-state:')) continue;
        yield record;
      }
    })();
  }
  private remember(record: CommitRecord, offset: number, length: number): void {
    const header = this.header(record);
    const stored: StoredRecord = { ...header, hash: record.hash, requestHash: record.requestHash, archives: record.archives.map(reference => ({ ...reference })), offset, length };
    this.commits.push(stored);
    this.bySequence.set(stored.seq, stored);
    this.requests.set(this.key(record.scope, record.requestId), stored);
    for (const [index, key] of [[this.byKind, header.kind], [this.byTask, header.taskId]] as const) if (key !== null) {
      let records = index.get(key);
      if (!records) { records = []; index.set(key, records); }
      records.push(stored);
    }
  }

  private key(scope: string, requestId: string): string { return `${scope}\0${requestId}`; }

  private async directory(name: string, create = true): Promise<string> {
    const dir = join(this.root, name);
    try { if (create && !this.readOnly) await mkdir(dir, { recursive: true, mode: 0o700 }); }
    catch (error) { throw new HarnessError('IO_ERROR', 'Cannot create archive directory.', { ...asHarnessError(error).details, path: dir, cause: String(error) }); }
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw corrupt('Archive directory is not a regular local directory.', { path: dir });
    return dir;
  }

  private async regularFile(file: string): Promise<void> {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw corrupt('Archive file is not a regular file.', { path: file });
  }

  private async load(): Promise<void> {
    if (this.packed) {
      if (!this.readOnly) await ensureDir(this.root);
      const { store, worktree } = this.packed;
      const end = store.latest(worktree).seq;
      if (this.verificationScope !== 'workspace' || this.journalKindsOnly) {
        if (end) {
          const head = store.record(worktree, end), previous = end > 1 ? store.bySeq(worktree, end - 1) : null;
          if (head.previousHash !== (previous?.hash ?? null)) throw corrupt('The current packed journal head does not link to its predecessor.');
        }
        return;
      }
      // Explicit audit of the migrated format walks original records, not
      // derived materializations. Ordinary operations use indexed locators.
      const verified = new Set<string>(), requests = new Set<string>();
      let seq = 0, previousHash: string | null = null;
      reportProgress({ phase: 'verifying-archives', completed: 0, total: end });
      try {
        for (let next = 1; next <= end; next++) {
          const record = store.record(worktree, next);
          validateCommitRecord(record, seq, previousHash, (scope, id) => requests.has(this.key(scope, id)));
          for (const reference of record.archives) {
            const key = `${reference.kind}:${reference.hash}`;
            if (verified.has(key)) continue;
            if (reference.kind === 'snapshot') await this.readSnapshot(reference.hash); else await this.readBlob(reference.hash);
            verified.add(key);
          }
          seq = record.seq; previousHash = record.hash; requests.add(this.key(record.scope, record.requestId));
          if (seq % 16 === 0) { checkAuditCancellation(); if (seq % 1000 === 0) reportProgress({ phase: 'verifying-archives', completed: seq, total: end }); await setImmediate(); }
        }
        if (seq !== end) throw corrupt('Packed journal has an incomplete sequence during audit.');
        checkAuditCancellation();
      } catch (error) { if (error instanceof HarnessError && error.code === 'CANCELLED') throw error; this.state = 'recovery-required'; this.problems.push({ code: 'ARCHIVE_CORRUPT', message: String(error), seq: seq + 1, verifiedThrough: seq }); }
      if (store.latest(worktree).seq !== end) throw new HarnessError('BUSY', 'The packed journal changed during the explicit audit; retry after writes settle.', {}, true);
      return;
    }
    if (!this.readOnly) {
      await ensureDir(this.root);
      for (const dir of ['snapshots', 'skill-blobs', 'tasks', 'checkpoints', 'diagnostics']) await this.directory(dir);
    }
    const journal = join(this.root, 'journal.jsonl');
    try { await this.regularFile(journal); }
    catch (error) {
      if (isErrno(error, 'ENOENT')) return;
      throw error;
    }
    if (this.verificationScope === 'requested' && await this.loadBrowseIndex() && (await this.journalStamp()).size === this.journalBytes) return;
    const latest = new Map<string, { seq: number; index: number }>();
    let offset = this.journalBytes, yieldedThrough = offset, pendingBytes = 0;
    let pending: Buffer[] = [];
    const reader = await open(journal, 'r');
    const total = (await reader.stat()).size;
    reportProgress({ phase: 'recovering-history', completed: 0, total });
    try {
      chunks: for await (const chunk of reader.createReadStream({ start: offset, autoClose: false, highWaterMark: 256 * 1024 })) {
        const bytes = chunk as Buffer;
        let start = 0, newline: number;
        while ((newline = bytes.indexOf(10, start)) >= 0) {
          const part = bytes.subarray(start, newline);
          const line = pending.length ? Buffer.concat([...pending, part], pendingBytes + part.length) : part;
          try {
            const record = parseJsonStrict(decode(line)) as CommitRecord;
            this.validateRecord(record);
            this.remember(record, offset, line.length);
            record.materializations.forEach((item, index) => latest.set(item.path, { seq: record.seq, index }));
          } catch (error) {
            const permission = permissionError(error);
            if (permission) throw permission;
            this.state = 'recovery-required';
            this.problems.push({ code: 'JOURNAL_CORRUPT', message: `Commit validation failed at byte ${offset}: ${String(error)}`, path: journal, verifiedThrough: this.seq });
            break chunks;
          }
          offset += line.length + 1;
          pending = []; pendingBytes = 0; start = newline + 1;
          if (offset - yieldedThrough >= 1024 * 1024) {
            yieldedThrough = offset;
            reportProgress({ phase: 'recovering-history', completed: offset, total });
            await setImmediate();
          }
        }
        if (start < bytes.length) { const rest = Buffer.from(bytes.subarray(start)); pending.push(rest); pendingBytes += rest.length; }
      }
    } finally { await reader.close(); }
    this.journalBytes = offset;
    // Only an unterminated suffix following a fully verified prefix is uncommitted.
    if (this.state === 'ready' && pendingBytes > 0) {
      if (this.readOnly) this.problems.push({ code: 'JOURNAL_INCOMPLETE_TAIL', message: 'Uncommitted incomplete tail remains unchanged during read-only inspection.', path: journal, verifiedThrough: this.seq });
      else {
        const path = join(await this.directory('diagnostics'), `${randomUUID()}.journal-tail`);
        await atomicWrite(path, Buffer.concat(pending, pendingBytes));
        const handle = await open(journal, 'r+');
        try { await handle.truncate(offset); await handle.sync(); } finally { await handle.close(); }
        this.problems.push({ code: 'JOURNAL_INCOMPLETE_TAIL', message: 'Uncommitted incomplete tail was preserved before truncation.', path, verifiedThrough: this.seq });
      }
    }
    pending = [];
    if (this.journalKindsOnly) { if (this.state === 'ready') await this.saveBrowseIndex(); return; }
    // Operational use establishes the actual journal chain and request index,
    // not the integrity of every historical body. Each requested transaction,
    // receipt or referenced object is verified at its operation seam. Full
    // archive audit remains the default for an explicitly opened Archive.
    if (this.verificationScope === 'operational') {
      if (this.state === 'ready') await this.saveBrowseIndex();
      return;
    }
    // Recovery shares verification work, not decoded bodies or a lifetime trust cache.
    const verified = new Map<string, Promise<void>>();
    // Independent immutable references share one pass-local verification map.
    // Bound outstanding I/O rather than allocating one promise per journal row.
    let nextReference = 0, completedReferences = 0;
    const failures: { seq: number; error: unknown }[] = [];
    reportProgress({ phase: 'verifying-archives', completed: 0, total: this.commits.length });
    await Promise.all(Array.from({ length: Math.min(8, this.commits.length) }, async () => {
      while (nextReference < this.commits.length) {
        const record = this.commits[nextReference++];
        try { await this.verifyReferences(record, verified); }
        catch (error) { failures.push({ seq: record.seq, error }); }
        if (++completedReferences % 1000 === 0) {
          reportProgress({ phase: 'verifying-archives', completed: completedReferences, total: this.commits.length });
          await setImmediate();
        }
      }
    }));
    for (const { seq, error } of failures.sort((a, b) => a.seq - b.seq)) {
      const permission = permissionError(error);
      if (permission) throw permission;
      this.state = 'recovery-required';
      this.problems.push({ code: 'ARCHIVE_CORRUPT', message: String(error), seq, verifiedThrough: this.seq });
    }
    reportProgress({ phase: 'verifying-archives', completed: completedReferences, total: this.commits.length });
    // Do not replace current projections from a journal with an unverifiable suffix.
    if (this.state === 'ready' && !this.readOnly) {
      try { for (const item of latest.values()) await this.materialize((await this.readRecord(this.stored(item.seq))).materializations[item.index]); }
      catch (error) {
        this.state = 'recovery-required';
        this.problems.push({ code: 'MATERIALIZATION_FAILED', message: String(error), verifiedThrough: this.seq });
      }
    }
  }

  /** Derived locators never replace journal bytes or a complete recovery proof. */
  private async journalStamp() {
    const info = await lstat(join(this.root, 'journal.jsonl'));
    if (!info.isFile() || info.isSymbolicLink()) throw corrupt('Journal is not a regular local file.');
    return { dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
  }
  private async saveBrowseIndex(): Promise<void> {
    try {
      if (this.state !== 'ready') return;
      const journal = await this.journalStamp();
      if (journal.size !== this.journalBytes) return;
      const lastFreshness = this.byKind.get('freshness-state')?.at(-1)?.seq;
      const records = this.commits.filter(record => ['task', 'legacy-migration', 'legacy-read', 'observation-state'].includes(record.kind ?? '') || record.seq === lastFreshness || record.seq === 1 || record.seq === this.seq);
      const content = { version: 1, journal, records };
      await atomicWrite(join(this.root, 'browse-index.json'), JSON.stringify({ ...content, hash: digest('browse-index', content) }) + '\n');
    } catch { /* Cache failure must not change a durable commit or recovery result. */ }
  }
  private async loadBrowseIndex(): Promise<boolean> {
    try {
      const journal = await this.journalStamp();
      const file = join(this.root, 'browse-index.json');
      await this.regularFile(file);
      const { hash, ...content } = parseJsonStrict(decode(await readFile(file))) as { hash: string; version: number; journal: Awaited<ReturnType<Archive['journalStamp']>>; records: StoredRecord[] };
      if (content.version !== 1 || digest('browse-index', content) !== hash || !Array.isArray(content.records)) return false;
      const prior = content.journal;
      const appended = prior && journal.size > prior.size && ['dev', 'ino', 'birthtimeMs'].every(key => journal[key as keyof typeof journal] === prior[key as keyof typeof prior]);
      if (!appended && canonicalJson(prior) !== canonicalJson(journal)) return false;
      let previous = 0;
      for (const record of content.records) {
        if (!Number.isSafeInteger(record.seq) || record.seq <= previous || !Number.isSafeInteger(record.offset) || !Number.isSafeInteger(record.length) || record.offset < 0 || record.length < 1 || record.offset + record.length >= prior.size || !HASH.test(record.hash) || !Array.isArray(record.archives)) return false;
        previous = record.seq;
      }
      if (prior.size && (!content.records.length || content.records[0].seq !== 1 || content.records.at(-1)!.offset + content.records.at(-1)!.length + 1 !== prior.size)) return false;
      for (const record of [content.records[0], content.records.at(-1)].filter((item): item is StoredRecord => !!item)) {
        const actual = await this.readRecord(record);
        const header = Object.fromEntries(Object.entries(record).filter(([key]) => !['hash', 'requestHash', 'archives', 'offset', 'length'].includes(key)));
        if (canonicalJson(this.header(actual)) !== canonicalJson(header)) return false;
      }
      if (canonicalJson(await this.journalStamp()) !== canonicalJson(journal)) return false;
      for (const record of content.records) {
        this.commits.push(record); this.bySequence.set(record.seq, record);
        this.requests.set(this.key(record.scope, record.requestId), record);
        for (const [index, key] of [[this.byKind, record.kind], [this.byTask, record.taskId]] as const) if (key !== null) {
          const values = index.get(key) ?? []; values.push(record); index.set(key, values);
        }
      }
      this.journalBytes = prior.size;
      return true;
    } catch { return false; }
  }

  private validateRecord(record: CommitRecord): void {
    validateCommitRecord(record, this.seq, this.previousHash(), (scope, requestId) => this.hasRequest(scope, requestId));
  }

  async snapshot(kind: string, content: unknown): Promise<string> {
    if (this.readOnly) throw new HarnessError('IO_ERROR', 'This archive is open for read-only inspection.');
    if (typeof kind !== 'string' || !kind.length || kind.length > 128) throw new HarnessError('INVALID_ARGUMENT', 'Snapshot kind is required.');
    const captured = parseJsonStrict(canonicalJson(content));
    const hash = digest(kind, captured);
    await this.ready();
    if (this.state !== 'ready') throw corrupt('New snapshots are blocked until archive recovery is complete.', { diagnostics: this.diagnostics });
    try { await this.readSnapshot(hash); }
    catch (error) {
      if (!(error instanceof HarnessError && error.code === 'ARCHIVE_CORRUPT' && error.details.missing === true)) throw error;
      const raw = Buffer.from(`${canonicalJson({ schemaVersion: 1, kind, content: captured, hash })}\n`, 'utf8');
      await this.capacity(this.root, raw.length);
      if (this.packed) this.packed.store.putFile(this.packed.worktree, 'snapshot', `${hash}.json`, raw);
      else await atomicWrite(join(await this.directory('snapshots'), `${hash}.json`), raw);
      this.counters.newSnapshots++; this.counters.logicalWriteBytes += raw.length;
    }
    return hash;
  }

  async readSnapshot<T = unknown>(hash: string): Promise<T> {
    validateHash(hash);
    const file = join(this.root, 'snapshots', `${hash}.json`);
    try {
      if (this.packed) {
        const bytes = this.packed.store.getFile(this.packed.worktree, 'snapshot', `${hash}.json`);
        if (!bytes) throw corrupt('Packed snapshot is missing.', { hash, missing: true });
        this.counters.snapshotReads++; this.counters.logicalReadBytes += bytes.length;
        return verifySnapshotBytes(hash, bytes) as T;
      }
      await this.directory('snapshots', false); await this.regularFile(file);
      const bytes = await readFile(file); this.counters.snapshotReads++; this.counters.logicalReadBytes += bytes.length;
      return verifySnapshotBytes(hash, bytes) as T;
    } catch (error) {
      const permission = permissionError(error);
      if (permission) throw permission;
      if (error instanceof HarnessError && error.code === 'ARCHIVE_CORRUPT') throw error;
      throw corrupt('Snapshot is missing or invalid.', { path: file, hash, missing: isErrno(error, 'ENOENT'), cause: String(error) });
    }
  }

  async blob(bytes: Uint8Array): Promise<string> {
    if (this.readOnly) throw new HarnessError('IO_ERROR', 'This archive is open for read-only inspection.');
    if (!(bytes instanceof Uint8Array)) throw new HarnessError('INVALID_ARGUMENT', 'Blob must contain raw bytes.');
    const captured = Buffer.from(bytes);
    const hash = sha256(captured);
    await this.ready();
    if (this.state !== 'ready') throw corrupt('New skill archives are blocked until archive recovery is complete.', { diagnostics: this.diagnostics });
    try { await this.readBlob(hash); }
    catch (error) {
      if (!(error instanceof HarnessError && error.code === 'ARCHIVE_CORRUPT' && error.details.missing === true)) throw error;
      await this.capacity(this.root, captured.length);
      if (this.packed) this.packed.store.putFile(this.packed.worktree, 'blob', hash, captured);
      else await atomicWrite(join(await this.directory('skill-blobs'), hash), captured);
      this.counters.newBlobs++; this.counters.logicalWriteBytes += captured.length;
    }
    return hash;
  }

  async readBlob(hash: string): Promise<Buffer> {
    validateHash(hash);
    const file = join(this.root, 'skill-blobs', hash);
    try {
      let bytes: Buffer;
      if (this.packed) {
        const raw = this.packed.store.getFile(this.packed.worktree, 'blob', hash);
        if (!raw) throw corrupt('Packed skill bytes are missing.', { hash, missing: true });
        bytes = raw;
      } else { await this.directory('skill-blobs', false); await this.regularFile(file); bytes = await readFile(file); }
      this.counters.blobReads++; this.counters.logicalReadBytes += bytes.length;
      if (sha256(bytes) !== hash) throw corrupt('Archived skill bytes do not match their fingerprint.', { path: file, hash });
      return bytes;
    } catch (error) {
      const permission = permissionError(error);
      if (permission) throw permission;
      if (error instanceof HarnessError && error.code === 'ARCHIVE_CORRUPT') throw error;
      throw corrupt('Archived skill bytes are missing or unreadable.', { path: file, hash, missing: isErrno(error, 'ENOENT'), cause: String(error) });
    }
  }

  private async verifyReferences(record: Pick<CommitRecord, 'archives'>, verified?: Map<string, Promise<void>>): Promise<void> {
    for (const reference of record.archives) {
      const key = `${reference.kind}:${reference.hash}`;
      let pending = verified?.get(key);
      if (!pending) {
        pending = (async () => {
          if (reference.kind === 'snapshot') await this.readSnapshot(reference.hash);
          else await this.readBlob(reference.hash);
        })();
        verified?.set(key, pending);
      }
      await pending;
    }
  }

  async replay<T = unknown>(scope: string, requestId: string, request: unknown): Promise<{ receipt: T; replayed: true; seq: number } | null> {
    validateRequest(scope, requestId);
    const requestHash = digest('request', request);
    await this.ready();
    const record = this.packed ? this.packed.store.byRequest(this.packed.worktree, scope, requestId) : this.requests.get(this.key(scope, requestId));
    if (!record) {
      if (this.state !== 'ready') throw corrupt('The journal cannot prove whether this request committed.', { verifiedThrough: this.seq, diagnostics: this.diagnostics });
      return null;
    }
    const actual = await this.readRecord(record);
    if (actual.requestHash !== requestHash) throw new HarnessError('REQUEST_ID_CONFLICT', 'requestId was already committed with different request content.', { requestId, seq: record.seq });
    await this.verifyReferences(actual);
    return { receipt: await this.readSnapshot<T>(actual.receiptHash), replayed: true, seq: record.seq };
  }

  commit<T>(input: CommitInput<T>): Promise<CommitResult<T>> {
    if (this.readOnly) return Promise.reject(new HarnessError('IO_ERROR', 'This archive is open for read-only inspection.'));
    // Capture at invocation, before a prior queued write can yield to caller mutation.
    let captured: CommitInput<T>;
    try { captured = parseJsonStrict(canonicalJson(input)) as CommitInput<T>; }
    catch (error) { return Promise.reject(error); }
    const pending = this.queue.then(() => this.commitQueued(captured));
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private async commitQueued<T>(input: CommitInput<T>): Promise<CommitResult<T>> {
    validateRequest(input.scope, input.requestId);
    const captured = input;
    const replayed = await this.replay<T>(captured.scope, captured.requestId, captured.request);
    if (replayed) return replayed;
    const materializations: Materialization[] = [];
    const seenPaths = new Set<string>();
    for (const item of captured.materializations ?? []) {
      if (!MATERIALIZATION.test(item.path) || seenPaths.has(item.path)) throw new HarnessError('INVALID_ARGUMENT', 'Only unique tasks/<UUID>.json or checkpoints/<UUID>.json projections are allowed.');
      seenPaths.add(item.path);
      materializations.push({ ...item, contentHash: digest('materialization', { path: item.path, content: item.content }) });
    }
    const references = new Map<string, ArchiveReference>();
    for (const reference of captured.archives ?? []) {
      if (!reference || !['snapshot', 'blob'].includes(reference.kind)) throw new HarnessError('INVALID_ARGUMENT', 'Unknown archive reference kind.');
      validateHash(reference.hash);
      references.set(`${reference.kind}:${reference.hash}`, reference);
      if (reference.kind === 'snapshot') await this.readSnapshot(reference.hash); else await this.readBlob(reference.hash);
    }
    const receiptHash = await this.snapshot('receipt', captured.receipt);
    references.set(`snapshot:${receiptHash}`, { kind: 'snapshot', hash: receiptHash });
    const content: Omit<CommitRecord, 'hash'> = {
      schemaVersion: 1, seq: this.seq + 1, operationId: randomUUID(), scope: captured.scope, requestId: captured.requestId,
      requestHash: digest('request', captured.request), committedAt: new Date().toISOString(),
      previousHash: this.previousHash(), payload: captured.payload, receiptHash,
      archives: [...references.values()].sort((a, b) => `${a.kind}:${a.hash}` < `${b.kind}:${b.hash}` ? -1 : 1), materializations,
    };
    const record: CommitRecord = { ...content, hash: digest('commit', content) };
    this.validateRecord(record);
    const bytes = Buffer.from(`${canonicalJson(record)}\n`, 'utf8');
    await this.capacity(this.root, bytes.length);
    if (this.packed) {
      this.packed.store.putRecord(this.packed.worktree, record, bytes);
      this.counters.businessCommits++; this.counters.logicalWriteBytes += bytes.length;
      return { receipt: await this.readSnapshot<T>(receiptHash), replayed: false, seq: record.seq };
    }
    const journal = join(this.root, 'journal.jsonl');
    try { await this.regularFile(journal); } catch (error) { if (!isErrno(error, 'ENOENT')) throw error; }
    const handle = await open(journal, 'a', 0o600);
    try {
      if ((await handle.stat()).size !== this.journalBytes) throw corrupt('The journal length changed outside the current writer.');
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      this.state = 'recovery-required';
      this.problems.push({ code: 'JOURNAL_WRITE_FAILED', message: String(error), path: journal, verifiedThrough: this.seq });
      throw new HarnessError('IO_ERROR', 'Journal append did not complete; restart recovery is required.', { ...asHarnessError(error).details, requestId: captured.requestId, outcome: 'unknown', nextAction: 'query-request', cause: String(error) });
    } finally { await handle.close(); }
    this.remember(record, this.journalBytes, bytes.length - 1);
    this.journalBytes += bytes.length;
    this.counters.businessCommits++; this.counters.logicalWriteBytes += bytes.length;
    try { for (const item of materializations) await this.materialize(item); }
    catch (error) {
      this.problems.push({ code: 'MATERIALIZATION_FAILED', message: String(error), seq: record.seq });
      throw new HarnessError('IO_ERROR', 'Commit is durable but its materialized projection needs recovery.', { ...asHarnessError(error).details, committed: true, seq: record.seq, requestId: record.requestId, outcome: 'committed', nextAction: 'query-request', cause: String(error) });
    }
    await this.saveBrowseIndex();
    return { receipt: await this.readSnapshot<T>(receiptHash), replayed: false, seq: record.seq };
  }

  private async materialize(item: Materialization): Promise<void> {
    const [dir, name] = item.path.split('/');
    const file = join(await this.directory(dir), name);
    const bytes = `${canonicalJson(item.content)}\n`;
    try {
      await this.regularFile(file);
      if ((await readFile(file, 'utf8')) === bytes) return;
    } catch (error) { if (!isErrno(error, 'ENOENT')) throw error; }
    await atomicWrite(file, bytes);
  }
}
