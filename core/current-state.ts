import { DatabaseSync } from 'node:sqlite';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, digest, parseJsonStrict } from './json.js';
import { atomicWrite, isErrno, requireWriteCapacity } from './io.js';
import { HarnessError, permissionError } from './errors.js';
import type { FreshnessState } from './freshness.js';
import type { SourceScan } from './source.js';
import type { ModelSnapshot } from './types.js';

export interface CurrentCheckpoint { seq: number; state: FreshnessState; source?: SourceScan | null; model?: ModelSnapshot | null }
const marker = 'harnessl3-current-state/1\n';

/** A single transactional current value, never an event log. The archive
 * sequence binds it to the most recent committed business facts. Connections
 * are short-lived; idle workspaces do not retain a SQLite writer or poll. */
export class CurrentStateStore {
  private readonly file: string;
  private readonly format: string;
  constructor(root: string) {
    this.file = path.join(root, 'current-state.sqlite');
    this.format = path.join(root, 'current-state.format');
  }
  private async regular(file: string): Promise<boolean> {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new HarnessError('ARCHIVE_CORRUPT', 'Current state must be a regular local file.', { path: file });
      return true;
    } catch (error) { if (isErrno(error, 'ENOENT')) return false; throw error; }
  }
  private async exists(): Promise<{ file: boolean; marker: boolean }> {
    const [file, formatted] = await Promise.all([this.regular(this.file), this.regular(this.format)]);
    if (formatted && (await readFile(this.format, 'utf8')) !== marker) throw new HarnessError('ARCHIVE_CORRUPT', 'Unknown current-state format.', { path: this.format });
    if (formatted && !file) throw new HarnessError('ARCHIVE_CORRUPT', 'The current-state database is missing; issued verification bindings cannot be recovered safely.', { path: this.file });
    return { file, marker: formatted };
  }
  async load(): Promise<CurrentCheckpoint | null> {
    if (!(await this.exists()).file) return null;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(this.file, { readOnly: true });
      if (db.prepare('PRAGMA user_version').get()?.user_version !== 1) throw new Error('Unsupported current-state schema');
      const row = db.prepare('SELECT seq, state, hash FROM current_state WHERE id=1').get();
      if (!row || !Number.isSafeInteger(row.seq) || Number(row.seq) < 0 || typeof row.state !== 'string' || typeof row.hash !== 'string') throw new Error('Missing or invalid checkpoint row');
      const content = parseJsonStrict(row.state) as CurrentCheckpoint;
      if (!content || content.seq !== Number(row.seq) || !content.state) throw new Error('Checkpoint identity differs');
      if (digest('current-state', content) !== row.hash) throw new Error('Current-state fingerprint differs');
      return content;
    } catch (error) { throw permissionError(error) ?? new HarnessError('ARCHIVE_CORRUPT', 'Current synchronization state could not be verified.', { path: this.file, cause: String(error) }); }
    finally { db?.close(); }
  }
  async save(checkpoint: CurrentCheckpoint): Promise<void> {
    const existing = await this.exists();
    const serialized = canonicalJson(checkpoint);
    await requireWriteCapacity(path.dirname(this.file), Buffer.byteLength(serialized));
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(this.file);
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
      db.exec('BEGIN IMMEDIATE');
      try {
        if (!existing.file) db.exec('CREATE TABLE current_state(id INTEGER PRIMARY KEY CHECK(id=1), seq INTEGER NOT NULL, state TEXT NOT NULL, hash TEXT NOT NULL); PRAGMA user_version=1');
        else if (db.prepare('PRAGMA user_version').get()?.user_version !== 1) throw new Error('Unsupported current-state schema');
        const prior = db.prepare('SELECT seq FROM current_state WHERE id=1').get();
        if (prior && Number(prior.seq) > checkpoint.seq) throw new Error('Checkpoint sequence regressed');
        db.prepare('INSERT INTO current_state(id,seq,state,hash) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET seq=excluded.seq,state=excluded.state,hash=excluded.hash')
          .run(checkpoint.seq, serialized, digest('current-state', checkpoint));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } catch (error) { throw permissionError(error) ?? new HarnessError('IO_ERROR', 'Current-state transaction was not committed.', { path: this.file, cause: String(error) }); }
    finally { db?.close(); }
    // An issued binding may never silently fall back to a deleted database.
    if (!existing.marker) await atomicWrite(this.format, marker);
  }
}
