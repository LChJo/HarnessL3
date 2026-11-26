import { DatabaseSync } from 'node:sqlite';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, digest, parseJsonStrict, sha256 } from './json.js';
import { HarnessError } from './errors.js';
import { atomicWrite, isErrno } from './io.js';
import type { CommitRecord, CommitHeader, ArchiveReference, RecordFilter } from './archive.js';

export const PACK_FILE = 'runtime-archive.sqlite';
export const PACK_FORMAT_FILE = 'runtime-format.json';
export const PACK_FORMAT = { schemaVersion: 1, format: 'packed-sqlite/1' } as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hex = /^[0-9a-f]{64}$/;
type Row = Record<string, unknown>;
type FileKind = 'snapshot' | 'blob';
export interface PackedHeader extends CommitHeader { hash: string; requestHash: string; archives: ArchiveReference[]; offset: number; length: number }

const corruption = (message: string, details: Record<string, unknown> = {}) => new HarnessError('ARCHIVE_CORRUPT', message, details);
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
function unpack(row: Row): Buffer {
  const length = Number(row.raw_size), hash = row.raw_hash;
  if (!Number.isSafeInteger(length) || length < 0 || typeof hash !== 'string' || !hex.test(hash) || !(row.packed instanceof Uint8Array)) throw corruption('Packed content metadata is invalid.');
  try {
    const bytes = inflateRawSync(row.packed, { maxOutputLength: Math.max(length, 1) });
    if (bytes.length !== length || sha256(bytes) !== hash) throw corruption('Packed original bytes failed fingerprint verification.', { hash });
    return bytes;
  } catch (error) { if (error instanceof HarnessError) throw error; throw corruption('Packed content could not be decoded.', { hash, cause: String(error) }); }
}

// Content-defined blocks recover the same boundaries after a small insertion
// or deletion in a large canonical document. Repeated pending path arrays and
// accumulated receipts share unchanged blocks rather than only identical files.
const gear = (() => { const table = new Uint32Array(256); let n = 0x9e3779b9; for (let i = 0; i < 256; i++) { n ^= n << 13; n ^= n >>> 17; n ^= n << 5; table[i] = n >>> 0; } return table; })();
function* blocks(bytes: Uint8Array): IterableIterator<Uint8Array> {
  let start = 0, rolling = 0;
  for (let i = 0; i < bytes.length; i++) {
    rolling = ((rolling << 1) + gear[bytes[i]!]!) >>> 0;
    const size = i + 1 - start;
    if (size >= 16 * 1024 && ((rolling & 0x7fff) === 0 || size >= 128 * 1024)) { yield bytes.subarray(start, i + 1); start = i + 1; rolling = 0; }
  }
  if (start < bytes.length) yield bytes.subarray(start);
}

/** Compact authoritative machine archive. Each content row reconstructs the
 * exact old file bytes; each logical path and commit retains worktree identity.
 * The database itself is not a project knowledge store or derived index. */
export class PackedArchiveStore {
  readonly file: string;
  private readonly db: DatabaseSync;
  private writing = false;
  constructor(file: string, create = false) {
    this.file = file;
    if (existsSync(file)) {
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink()) throw corruption('Packed archive is not a regular local file.', { file });
      if (create) throw new HarnessError('TARGET_CONFLICT', 'A packed archive already exists. Resume it explicitly.', { file });
    } else if (!create) throw corruption('Packed archive database is missing.', { file });
    this.db = new DatabaseSync(file);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL');
      if (create) this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE content(raw_hash TEXT PRIMARY KEY, raw_size INTEGER NOT NULL, packed BLOB NOT NULL, blocks TEXT);
        CREATE TABLE content_blocks(raw_hash TEXT PRIMARY KEY, raw_size INTEGER NOT NULL, packed BLOB NOT NULL);
        CREATE TABLE files(worktree TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, raw_hash TEXT NOT NULL REFERENCES content(raw_hash), PRIMARY KEY(worktree,kind,name));
        CREATE TABLE commits(worktree TEXT NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL, previous_hash TEXT, scope TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, operation_id TEXT NOT NULL, committed_at TEXT NOT NULL, kind TEXT, task_id TEXT, operation TEXT, source TEXT, receipt_hash TEXT NOT NULL, archives TEXT NOT NULL, transient INTEGER NOT NULL, raw_hash TEXT NOT NULL, raw_size INTEGER NOT NULL, packed BLOB NOT NULL, PRIMARY KEY(worktree,seq), UNIQUE(worktree,scope,request_id));
        CREATE TABLE journal_heads(worktree TEXT PRIMARY KEY, seq INTEGER NOT NULL, hash TEXT NOT NULL);
        CREATE INDEX commits_kind ON commits(worktree,kind,seq);
        CREATE INDEX commits_task ON commits(worktree,task_id,seq);
        CREATE INDEX commits_request ON commits(worktree,request_id,seq);
        CREATE INDEX commits_business ON commits(worktree,transient,seq);
        CREATE TABLE migration_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        PRAGMA user_version=1;
        COMMIT;
      `);
      if (this.db.prepare('PRAGMA user_version').get()?.user_version !== 1) throw new Error('Unsupported packed archive format');
      this.db.prepare('SELECT seq,hash FROM commits LIMIT 0').all();
      this.db.prepare('SELECT raw_hash,raw_size,packed,blocks FROM content LIMIT 0').all();
    } catch (error) { this.db.close(); throw corruption('Packed archive schema is invalid.', { file, cause: String(error) }); }
  }
  close(): void { this.db.close(); }
  batch<T>(operation: () => T): T {
    if (this.writing) return operation();
    this.db.exec('BEGIN IMMEDIATE'); this.writing = true;
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.writing = false; }
  }
  private unpackContent(row: Row): Buffer {
    if (row.blocks === null || row.blocks === undefined) return unpack(row);
    const keys = parseJsonStrict(String(row.blocks)) as unknown;
    const size = Number(row.raw_size);
    if (!Number.isSafeInteger(size) || size < 0 || !Array.isArray(keys) || keys.length > Math.ceil(size / (16 * 1024)) + 1 || keys.some(key => typeof key !== 'string' || !hex.test(key))) throw corruption('Packed content block manifest is invalid.');
    const chunks: Buffer[] = []; let length = 0;
    for (const key of keys) {
      const block = this.db.prepare('SELECT raw_hash,raw_size,packed FROM content_blocks WHERE raw_hash=?').get(key);
      if (!block) throw corruption('A packed content block is missing.', { hash: key });
      const raw = unpack(block); length += raw.length;
      if (length > size) throw corruption('Packed content block length exceeds its manifest.');
      chunks.push(raw);
    }
    const result = Buffer.concat(chunks, length);
    if (length !== size || sha256(result) !== row.raw_hash) throw corruption('Reconstructed original content fingerprint differs.');
    return result;
  }
  putFile(worktree: string, kind: FileKind, name: string, bytes: Uint8Array): string {
    const rawHash = sha256(bytes);
    return this.batch(() => {
      const existing = this.db.prepare('SELECT raw_hash FROM files WHERE worktree=? AND kind=? AND name=?').get(worktree, kind, name);
      if (existing) {
        if (existing.raw_hash !== rawHash) throw corruption('An immutable logical archive file already has different bytes.', { worktree, kind, name });
        return rawHash;
      }
      const content = this.db.prepare('SELECT raw_size,raw_hash,packed,blocks FROM content WHERE raw_hash=?').get(rawHash);
      if (content) { if (!this.unpackContent(content).equals(Buffer.from(bytes))) throw corruption('Packed content collision.', { rawHash }); }
      else if (bytes.length >= 64 * 1024) {
        const keys: string[] = [];
        for (const block of blocks(bytes)) {
          const key = sha256(block); keys.push(key);
          const existing = this.db.prepare('SELECT raw_size FROM content_blocks WHERE raw_hash=?').get(key);
          if (existing && Number(existing.raw_size) !== block.length) throw corruption('Packed block length differs.', { key });
          if (!existing) this.db.prepare('INSERT INTO content_blocks(raw_hash,raw_size,packed) VALUES(?,?,?)').run(key, block.length, deflateRawSync(block, { level: 1 }));
        }
        this.db.prepare('INSERT INTO content(raw_hash,raw_size,packed,blocks) VALUES(?,?,?,?)').run(rawHash, bytes.byteLength, Buffer.alloc(0), canonicalJson(keys));
      } else this.db.prepare('INSERT INTO content(raw_hash,raw_size,packed,blocks) VALUES(?,?,?,NULL)').run(rawHash, bytes.byteLength, deflateRawSync(bytes, { level: 1 }));
      this.db.prepare('INSERT INTO files(worktree,kind,name,raw_hash) VALUES(?,?,?,?)').run(worktree, kind, name, rawHash);
      return rawHash;
    });
  }
  getFile(worktree: string, kind: FileKind, name: string): Buffer | null {
    const row = this.db.prepare('SELECT content.raw_hash,raw_size,packed,blocks FROM files JOIN content ON content.raw_hash=files.raw_hash WHERE worktree=? AND kind=? AND name=?').get(worktree, kind, name);
    return row ? this.unpackContent(row) : null;
  }
  fileHash(worktree: string, kind: FileKind, name: string): string | null {
    return this.db.prepare('SELECT raw_hash FROM files WHERE worktree=? AND kind=? AND name=?').get(worktree, kind, name)?.raw_hash as string ?? null;
  }
  latest(worktree: string): { seq: number; hash: string | null } {
    const row = this.db.prepare('SELECT seq,hash FROM commits WHERE worktree=? ORDER BY seq DESC LIMIT 1').get(worktree);
    const head = this.db.prepare('SELECT seq,hash FROM journal_heads WHERE worktree=?').get(worktree);
    if (!!head !== !!row || head && row && (head.seq !== row.seq || head.hash !== row.hash)) throw corruption('The committed packed journal head is missing or inconsistent.', { worktree });
    return row ? { seq: Number(row.seq), hash: String(row.hash) } : { seq: 0, hash: null };
  }
  private header(row: Row): PackedHeader {
    return { seq: Number(row.seq), hash: String(row.hash), requestHash: String(row.request_hash), receiptHash: String(row.receipt_hash), scope: String(row.scope), operationId: String(row.operation_id), requestId: String(row.request_id), committedAt: String(row.committed_at), kind: row.kind === null ? null : String(row.kind), taskId: row.task_id === null ? null : String(row.task_id), operation: row.operation === null ? null : String(row.operation), source: row.source === null ? null : String(row.source), archives: parseJsonStrict(String(row.archives)) as ArchiveReference[], offset: 0, length: Number(row.raw_size) - 1 };
  }
  private columns = 'seq,hash,request_hash,receipt_hash,scope,operation_id,request_id,committed_at,kind,task_id,operation,source,archives,raw_size';
  private filter(worktree: string, filter: RecordFilter): { where: string; args: (string | number)[] } {
    const conditions = ['worktree=?'], args: (string | number)[] = [worktree];
    if (filter.kind !== undefined) { conditions.push('kind=?'); args.push(filter.kind); }
    if (filter.taskId !== undefined) { conditions.push('task_id=?'); args.push(filter.taskId); }
    if (filter.afterSeq !== undefined) { conditions.push('seq>?'); args.push(filter.afterSeq); }
    if (filter.requestId !== undefined) { conditions.push('request_id=?'); args.push(filter.requestId); }
    if (filter.excludeKinds?.length) { conditions.push(`(kind IS NULL OR kind NOT IN (${filter.excludeKinds.map(() => '?').join(',')}))`); args.push(...filter.excludeKinds); }
    if (filter.businessOnly) conditions.push('transient=0');
    return { where: conditions.join(' AND '), args };
  }
  *headers(worktree: string, filter: RecordFilter = {}): IterableIterator<PackedHeader> {
    const { where, args } = this.filter(worktree, filter);
    for (const row of this.db.prepare(`SELECT ${this.columns} FROM commits WHERE ${where} ORDER BY seq`).iterate(...args)) yield this.header(row);
  }
  lastHeader(worktree: string, filter: RecordFilter = {}): PackedHeader | null {
    const { where, args } = this.filter(worktree, filter);
    const row = this.db.prepare(`SELECT ${this.columns} FROM commits WHERE ${where} ORDER BY seq DESC LIMIT 1`).get(...args);
    return row ? this.header(row) : null;
  }
  byRequest(worktree: string, scope: string, id: string): PackedHeader | null {
    const row = this.db.prepare(`SELECT ${this.columns} FROM commits WHERE worktree=? AND scope=? AND request_id=?`).get(worktree, scope, id);
    return row ? this.header(row) : null;
  }
  bySeq(worktree: string, seq: number): PackedHeader | null {
    const row = this.db.prepare(`SELECT ${this.columns} FROM commits WHERE worktree=? AND seq=?`).get(worktree, seq);
    return row ? this.header(row) : null;
  }
  rawRecord(worktree: string, seq: number): Buffer {
    const row = this.db.prepare('SELECT raw_hash,raw_size,packed FROM commits WHERE worktree=? AND seq=?').get(worktree, seq);
    if (!row) throw new HarnessError('NOT_FOUND', 'Packed committed sequence is unavailable.', { seq });
    return unpack(row);
  }
  record(worktree: string, seq: number): CommitRecord {
    const header = this.bySeq(worktree, seq);
    if (!header) throw new HarnessError('NOT_FOUND', 'Packed committed sequence is unavailable.', { seq });
    const record = parseJsonStrict(decode(this.rawRecord(worktree, seq))) as CommitRecord;
    const { hash, ...content } = record;
    const payload = record.payload as { kind?: string; task?: { id?: string }; operation?: string; source?: string } | null;
    if (record.seq !== seq || hash !== header.hash || digest('commit', content) !== hash || record.requestId !== header.requestId || record.scope !== header.scope || record.requestHash !== header.requestHash || record.receiptHash !== header.receiptHash || record.operationId !== header.operationId || record.committedAt !== header.committedAt || (payload?.kind ?? null) !== header.kind || (payload?.kind === 'task' ? payload.task?.id ?? null : null) !== header.taskId || (payload?.operation ?? null) !== header.operation || (payload?.source ?? null) !== header.source || canonicalJson(record.archives) !== canonicalJson(header.archives)) throw corruption('Packed commit metadata differs from its original record.', { seq });
    return record;
  }
  putRecord(worktree: string, record: CommitRecord, raw = Buffer.from(canonicalJson(record) + '\n', 'utf8')): void {
    const payload = record.payload as { kind?: string; task?: { id?: string }; operation?: string; source?: string } | null;
    const kind = typeof payload?.kind === 'string' ? payload.kind : null;
    const transient = kind === 'freshness-state' && record.scope.startsWith('freshness-state:') ? 1 : 0;
    this.batch(() => {
      const previous = this.latest(worktree);
      if (record.seq !== previous.seq + 1 || record.previousHash !== previous.hash) throw corruption('Packed journal append does not match its previous sequence/hash.', { worktree, seq: record.seq });
      this.db.prepare('INSERT INTO commits(worktree,seq,hash,previous_hash,scope,request_id,request_hash,operation_id,committed_at,kind,task_id,operation,source,receipt_hash,archives,transient,raw_hash,raw_size,packed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(worktree, record.seq, record.hash, record.previousHash, record.scope, record.requestId, record.requestHash, record.operationId, record.committedAt, kind, kind === 'task' ? payload?.task?.id ?? null : null, payload?.operation ?? null, payload?.source ?? null, record.receiptHash, canonicalJson(record.archives), transient, sha256(raw), raw.length, deflateRawSync(raw, { level: 1 }));
      this.db.prepare('INSERT INTO journal_heads(worktree,seq,hash) VALUES(?,?,?) ON CONFLICT(worktree) DO UPDATE SET seq=excluded.seq,hash=excluded.hash').run(worktree, record.seq, record.hash);
    });
  }
  counts(): { files: number; uniqueContents: number; commits: number; rawBytes: number; uniqueBlocks: number; packedBytes: number } {
    return { files: Number(this.db.prepare('SELECT count(*) AS n FROM files').get()!.n), uniqueContents: Number(this.db.prepare('SELECT count(*) AS n FROM content').get()!.n), commits: Number(this.db.prepare('SELECT count(*) AS n FROM commits').get()!.n), rawBytes: Number(this.db.prepare('SELECT COALESCE(sum(raw_size),0) AS n FROM content').get()!.n), uniqueBlocks: Number(this.db.prepare('SELECT count(*) AS n FROM content_blocks').get()!.n), packedBytes: Number(this.db.prepare('SELECT (SELECT COALESCE(sum(length(packed)+COALESCE(length(blocks),0)),0) FROM content)+(SELECT COALESCE(sum(length(packed)),0) FROM content_blocks) AS n').get()!.n) };
  }
  *fileManifest(worktree: string, kind: FileKind): IterableIterator<{ name: string; rawHash: string; bytes: number }> {
    for (const row of this.db.prepare('SELECT name,files.raw_hash,raw_size FROM files JOIN content ON content.raw_hash=files.raw_hash WHERE worktree=? AND kind=? ORDER BY name COLLATE BINARY').iterate(worktree, kind)) yield { name: String(row.name), rawHash: String(row.raw_hash), bytes: Number(row.raw_size) };
  }
  verifyContents(onProgress?: (count: number) => void): number {
    let count = 0;
    for (const row of this.db.prepare('SELECT raw_hash,raw_size,packed,blocks FROM content').iterate()) { this.unpackContent(row); count++; if (count % 1000 === 0) onProgress?.(count); }
    const orphan = this.db.prepare('PRAGMA foreign_key_check').get();
    if (orphan) throw corruption('Packed content contains an invalid logical reference.');
    return count;
  }
  setMeta(key: string, value: unknown): void { this.db.prepare('INSERT INTO migration_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, canonicalJson(value)); }
  meta<T>(key: string): T | null { const row = this.db.prepare('SELECT value FROM migration_meta WHERE key=?').get(key); return row ? parseJsonStrict(String(row.value)) as T : null; }
}

const stores = new Map<string, PackedArchiveStore>();
export function packedFormat(dataRoot: string): boolean {
  const marker = path.join(dataRoot, PACK_FORMAT_FILE);
  if (!existsSync(marker)) return false;
  const info = lstatSync(marker);
  if (!info.isFile() || info.isSymbolicLink() || canonicalJson(parseJsonStrict(decode(readFileSync(marker)))) !== canonicalJson(PACK_FORMAT)) throw corruption('Unknown or invalid machine archive format.', { path: marker });
  return true;
}
/** Called while the real service owns the exclusive data-root lock. Existing
 * legacy registries are never silently converted; incomplete migrations must
 * be resumed explicitly rather than being opened as empty workspaces. */
export async function initializeNewPackedRoot(dataRoot: string): Promise<void> {
  if (packedFormat(dataRoot)) return;
  const exists = async (name: string) => { try { return await lstat(path.join(dataRoot, name)); } catch (error) { if (isErrno(error, 'ENOENT')) return null; throw error; } };
  if (await exists('migration-state.json')) throw new HarnessError('BUSY', 'This data root contains an unpublished offline migration. Complete and verify it before starting the service.');
  const registryPath = path.join(dataRoot, 'registry.json'), registryInfo = await exists('registry.json');
  if (registryInfo) {
    if (!registryInfo.isFile() || registryInfo.isSymbolicLink()) throw corruption('Machine registry is not a regular local file.');
    const registry = parseJsonStrict(decode(readFileSync(registryPath))) as { schemaVersion?: number; projects?: unknown[]; worktrees?: unknown[] };
    if (registry.schemaVersion === 1) return;
    if (registry.schemaVersion !== 2 || registry.projects?.length !== 0 || registry.worktrees?.length !== 0 || await exists('worktrees') || !await exists(PACK_FILE)) throw corruption('Unpublished packed registry is not an empty interrupted initialization.');
  } else if (await exists('worktrees')) return;
  const file = path.join(dataRoot, PACK_FILE), prior = await exists(PACK_FILE);
  const store = new PackedArchiveStore(file, !prior);
  try { const counts = store.counts(); if (counts.files || counts.commits) throw corruption('Unpublished packed data exists without a registry; refusing to initialize over history.'); }
  finally { store.close(); }
  if (!registryInfo) await atomicWrite(registryPath, canonicalJson({ schemaVersion: 2, projects: [], worktrees: [] }) + '\n');
  await atomicWrite(path.join(dataRoot, PACK_FORMAT_FILE), canonicalJson(PACK_FORMAT) + '\n');
}
export function packedArchive(root: string): { store: PackedArchiveStore; worktree: string } | null {
  const worktree = path.basename(root), parent = path.dirname(root);
  if (!uuid.test(worktree) || path.basename(parent) !== 'worktrees') return null;
  const dataRoot = path.dirname(parent);
  if (!packedFormat(dataRoot)) return null;
  let store = stores.get(dataRoot);
  if (!store) { store = new PackedArchiveStore(path.join(dataRoot, PACK_FILE)); stores.set(dataRoot, store); }
  return { store, worktree };
}
export function closePackedArchive(dataRoot: string): void { const store = stores.get(dataRoot); if (store) { stores.delete(dataRoot); store.close(); } }
export function packedArchiveMetrics(dataRoot: string): ReturnType<PackedArchiveStore['counts']> | null {
  if (!packedFormat(dataRoot)) return null;
  let store = stores.get(dataRoot);
  if (!store) { store = new PackedArchiveStore(path.join(dataRoot, PACK_FILE)); stores.set(dataRoot, store); }
  return store.counts();
}
