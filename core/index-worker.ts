import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, lstat, rename } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IndexDocument, IndexStatus, SearchOptions, SearchResult } from './index.js';
import { HarnessError } from './errors.js';
import { canonicalJson, parseJsonStrict } from './json.js';

const kinds = new Set(['task', 'entity', 'batch', 'skill', 'event']);
let db: DatabaseSync | undefined;
let state: IndexStatus = { state: 'rebuilding', seq: 0, schemaVersion: 1, projectorVersion: 1 };

function invalid(message: string): never { throw new HarnessError('INVALID_ARGUMENT', message); }
function utcDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function calendarDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) && utcDate(`${value}T00:00:00.000Z`);
}
function sequence(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid('Index seq must be a nonnegative safe integer.');
}
function documents(value: unknown): asserts value is IndexDocument[] {
  if (!Array.isArray(value)) invalid('Index documents must be an array.');
  const seen = new Set<string>();
  for (const document of value) {
    if (!document || typeof document !== 'object' || typeof document.id !== 'string' || !document.id.length || !kinds.has(document.kind) || !Object.hasOwn(document, 'data')) invalid('Index document identity, kind and data are required.');
    if (Object.keys(document).some(key => !['id', 'kind', 'title', 'text', 'activityAt', 'expiresAt', 'data'].includes(key))) invalid('Unknown index document field.');
    if ((document.title !== undefined && typeof document.title !== 'string') || (document.text !== undefined && typeof document.text !== 'string')) invalid('Index title/text must be strings.');
    if ((document.activityAt != null && !utcDate(document.activityAt)) || (document.expiresAt != null && !utcDate(document.expiresAt))) invalid('Index activity dates must be UTC instants or null.');
    canonicalJson(document.data);
    const key = `${document.kind}\0${document.id}`;
    if (seen.has(key)) invalid('An index projection contains duplicate identities.');
    seen.add(key);
  }
}
function revisions(value: unknown): asserts value is Record<string, string | null> | undefined {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(item => item !== null && typeof item !== 'string'))) invalid('Index input revisions must be a string/null map.');
}
function database(): DatabaseSync {
  if (!db) throw new HarnessError('INDEX_UNAVAILABLE', 'The SQLite index is not open.', {}, true);
  return db;
}
function meta(): Record<string, string> {
  return Object.fromEntries(database().prepare('SELECT key, value FROM metadata').all().map(row => [String(row.key), String(row.value)]));
}
function setMeta(key: string, value: string): void { database().prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
function initialize(): void {
  database().exec(`
    PRAGMA journal_mode=DELETE;
    PRAGMA busy_timeout=5000;
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE documents(
      id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL,
      activity_at TEXT, expires_at TEXT, data TEXT NOT NULL, UNIQUE(kind,id)
    );
    CREATE INDEX documents_history ON documents(kind,expires_at,activity_at DESC,id);
    CREATE VIRTUAL TABLE document_fts USING fts5(id,title,text,tokenize='unicode61');
  `);
  setMeta('schemaVersion', '1'); setMeta('projectorVersion', '1'); setMeta('seq', '0'); setMeta('ready', '0'); setMeta('inputRevisions', '{}');
}
async function openIndex(file: string): Promise<void> {
  if (db) invalid('Index already open.');
  if (!isAbsolute(file)) invalid('Index path must be absolute.');
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  let existing = false;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new HarnessError('INDEX_UNAVAILABLE', 'Index is not a regular local file.', { path: file });
    existing = info.size > 0;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let quarantinedPath: string | undefined;
  if (existing) {
    try {
      db = new DatabaseSync(file);
      const check = db.prepare('PRAGMA quick_check').all();
      if (check.length !== 1 || Object.values(check[0])[0] !== 'ok') throw new Error('SQLite integrity check failed.');
      const values = meta();
      if (values.schemaVersion !== '1' || values.projectorVersion !== '1' || !/^\d+$/.test(values.seq) || !['0', '1'].includes(values.ready)) throw new Error('Incompatible SQLite index schema.');
      const seq = Number(values.seq); sequence(seq);
      // Check the actual tables/FTS interface, not only an editable metadata label.
      db.prepare('SELECT id,kind,title,text,activity_at,expires_at,data FROM documents LIMIT 0').all();
      db.prepare('SELECT rowid FROM document_fts WHERE document_fts MATCH ? LIMIT 0').all('"probe"');
      const inputRevisions = parseJsonStrict(values.inputRevisions); revisions(inputRevisions);
      state = { ...state, state: values.ready === '1' ? 'ready' : 'rebuilding', seq, inputRevisions };
      db.exec('PRAGMA busy_timeout=5000');
      return;
    } catch (error) {
      try { db?.close(); } finally { db = undefined; }
      quarantinedPath = `${file}.invalid-${randomUUID()}`;
      try { await rename(file, quarantinedPath); }
      catch (renameError) { throw new HarnessError('INDEX_UNAVAILABLE', 'Cannot quarantine an invalid derived index.', { path: file, cause: String(error), quarantineError: String(renameError) }, true); }
    }
  }
  db = new DatabaseSync(file);
  initialize();
  state = { state: 'rebuilding', seq: 0, schemaVersion: 1, projectorVersion: 1, inputRevisions: {}, ...(quarantinedPath ? { quarantinedPath } : {}) };
}

function upsert(document: IndexDocument): void {
  const connection = database();
  const prior = connection.prepare('SELECT rowid FROM documents WHERE kind=? AND id=?').get(document.kind, document.id);
  if (prior) connection.prepare('DELETE FROM document_fts WHERE rowid=?').run(prior.rowid);
  connection.prepare(`INSERT INTO documents(id,kind,title,text,activity_at,expires_at,data) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(kind,id) DO UPDATE SET title=excluded.title,text=excluded.text,activity_at=excluded.activity_at,expires_at=excluded.expires_at,data=excluded.data`).run(
    document.id, document.kind, document.title ?? '', document.text ?? '', document.activityAt ?? null, document.expiresAt ?? null, canonicalJson(document.data),
  );
  const row = connection.prepare('SELECT rowid FROM documents WHERE kind=? AND id=?').get(document.kind, document.id)!;
  connection.prepare('INSERT INTO document_fts(rowid,id,title,text) VALUES(?,?,?,?)').run(row.rowid, document.id, document.title ?? '', document.text ?? '');
}
function project(args: { documents: unknown; seq: unknown; inputRevisions?: unknown; fromSeq?: unknown }, replace: boolean): void {
  documents(args.documents); sequence(args.seq); revisions(args.inputRevisions);
  const connection = database();
  if (!replace && state.state !== 'ready') throw new HarnessError('INDEX_UNAVAILABLE', 'Index rebuild is required before incremental projection.', { state: state.state }, true);
  if (!replace && args.seq <= state.seq) return;
  if (args.fromSeq !== undefined) { sequence(args.fromSeq); if (args.fromSeq > args.seq) invalid('The catch-up range is reversed.'); }
  if (!replace && (args.fromSeq ?? args.seq) !== state.seq + 1) throw new HarnessError('INDEX_SEQUENCE_GAP', 'Index projection missed a commit; rebuild from authoritative records.', { expected: state.seq + 1, received: args.fromSeq ?? args.seq }, true);
  connection.exec('BEGIN IMMEDIATE');
  try {
    if (replace) connection.exec('DELETE FROM document_fts; DELETE FROM documents;');
    for (const document of args.documents) upsert(document);
    setMeta('seq', String(args.seq)); setMeta('ready', '1');
    if (args.inputRevisions !== undefined) setMeta('inputRevisions', canonicalJson(args.inputRevisions));
    connection.exec('COMMIT');
    state = { ...state, state: 'ready', seq: args.seq, ...(args.inputRevisions !== undefined ? { inputRevisions: args.inputRevisions } : {}) };
  } catch (error) { try { connection.exec('ROLLBACK'); } catch {} throw error; }
}

function search(options: SearchOptions): SearchResult {
  if (!options || typeof options !== 'object' || Object.keys(options).some(key => !['query', 'from', 'to', 'kind', 'limit', 'offset', 'now'].includes(key))) invalid('Invalid index search options.');
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 200 || !Number.isSafeInteger(options.offset) || options.offset < 0) invalid('Search limit must be 1–200 and offset nonnegative.');
  if (!utcDate(options.now) || (options.query !== undefined && typeof options.query !== 'string') || (options.kind !== undefined && !kinds.has(options.kind))) invalid('Invalid search time, query or kind.');
  if ((options.from !== undefined && !calendarDate(options.from)) || (options.to !== undefined && !calendarDate(options.to)) || (options.from && options.to && options.from > options.to)) invalid('Search date bounds must be valid ordered UTC calendar dates.');
  if (state.state !== 'ready') throw new HarnessError('INDEX_UNAVAILABLE', 'Derived index is rebuilding; history search is unavailable.', { state: state.state }, true);
  const kind = options.kind ?? 'task';
  const clauses = ['d.kind=?'];
  const parameters: (string | number)[] = [kind];
  if (kind === 'task') {
    clauses.push('d.activity_at IS NOT NULL', 'd.expires_at IS NOT NULL', 'd.expires_at>=?');
    parameters.push(options.now);
  }
  if (options.from) { clauses.push('d.activity_at>=?'); parameters.push(`${options.from}T00:00:00.000Z`); }
  if (options.to) {
    const exclusive = new Date(Date.parse(`${options.to}T00:00:00.000Z`) + 86400000).toISOString();
    clauses.push('d.activity_at<?'); parameters.push(exclusive);
  }
  const query = options.query?.trim();
  if (query) {
    // MATCH receives a quoted literal phrase; SQL metacharacters never become SQL/FTS grammar.
    const phrase = `"${query.replaceAll('"', '""')}"`;
    // LIKE additionally supports literal substrings, including task UUID and CJK fragments.
    const pattern = `%${query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    clauses.push(`(d.rowid IN (SELECT rowid FROM document_fts WHERE document_fts MATCH ?) OR d.id LIKE ? ESCAPE '\\' OR d.title LIKE ? ESCAPE '\\' OR d.text LIKE ? ESCAPE '\\')`);
    parameters.push(phrase, pattern, pattern, pattern);
  }
  const where = clauses.join(' AND ');
  const connection = database();
  const total = Number(connection.prepare(`SELECT count(*) AS total FROM documents d WHERE ${where}`).get(...parameters)!.total);
  const rows = connection.prepare(`SELECT d.id,d.kind,d.title,d.text,d.activity_at,d.expires_at,d.data FROM documents d WHERE ${where} ORDER BY d.activity_at DESC,d.id ASC LIMIT ? OFFSET ?`).all(...parameters, options.limit, options.offset);
  const items = rows.map(row => ({ id: String(row.id), kind: row.kind as IndexDocument['kind'], title: String(row.title), text: String(row.text), activityAt: row.activity_at === null ? null : String(row.activity_at), expiresAt: row.expires_at === null ? null : String(row.expires_at), data: parseJsonStrict(String(row.data)) }));
  return { items, total, limit: options.limit, offset: options.offset, hasMore: options.offset + items.length < total, seq: state.seq };
}

if (!parentPort) throw new Error('SQLite index must run in a worker.');
let queue = Promise.resolve();
parentPort.on('message', (message: { id: number; type: string; args: any }) => {
  // Async opening/quarantine and all synchronous SQL remain ordered on this single worker.
  queue = queue.then(async () => {
    try {
      let result: unknown = null;
      switch (message.type) {
        case 'open': await openIndex(message.args.file); break;
        case 'rebuild': project(message.args, true); break;
        case 'project': project(message.args, false); break;
        case 'catch-up': if (message.args.fromSeq === undefined) invalid('A catch-up range is required.'); project(message.args, false); break;
        case 'search': result = search(message.args); break;
        case 'close': db?.close(); db = undefined; state = { ...state, state: 'closed' }; break;
        default: invalid('Unknown SQLite worker operation.');
      }
      parentPort!.postMessage({ id: message.id, ok: true, result, status: state });
    } catch (error) {
      const failure = error instanceof HarnessError ? error : new HarnessError('INDEX_UNAVAILABLE', 'SQLite operation failed; rebuild the derived index.', { cause: String(error) }, true);
      if (failure.code === 'INDEX_UNAVAILABLE') state = { ...state, state: state.state === 'rebuilding' ? 'rebuilding' : 'degraded' };
      parentPort!.postMessage({ id: message.id, ok: false, error: { code: failure.code, message: failure.message, details: failure.details, retryable: failure.retryable }, status: state });
    }
  });
});
