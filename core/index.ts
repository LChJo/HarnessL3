import { Worker } from 'node:worker_threads';
import { isAbsolute } from 'node:path';
import { HarnessError } from './errors.js';
import { canonicalJson } from './json.js';

export type IndexDocument = {
  id: string;
  kind: 'task' | 'entity' | 'batch' | 'skill' | 'event';
  title?: string;
  text?: string;
  activityAt?: string | null;
  expiresAt?: string | null;
  data: unknown;
};
export type IndexStatus = {
  state: 'rebuilding' | 'ready' | 'degraded' | 'closed';
  seq: number;
  schemaVersion: 1;
  projectorVersion: 1;
  quarantinedPath?: string;
  inputRevisions?: Record<string, string | null>;
};
export type SearchOptions = {
  query?: string;
  from?: string;
  to?: string;
  kind?: IndexDocument['kind'];
  limit: number;
  offset: number;
  now: string;
};
export type SearchResult = {
  items: IndexDocument[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  seq: number;
};
type Response = {
  id: number;
  ok: boolean;
  result?: unknown;
  status?: IndexStatus;
  error?: { code: string; message: string; details: Record<string, unknown>; retryable?: boolean };
};

/** Fixed typed messages keep synchronous SQLite calls off the service event loop. */
export class SearchIndex {
  readonly file: string;
  private worker?: Worker;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  private nextId = 0;
  private pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: unknown) => void }>();
  private state: IndexStatus = { state: 'rebuilding', seq: 0, schemaVersion: 1, projectorVersion: 1 };
  private failed?: HarnessError;

  constructor(file: string) {
    if (!isAbsolute(file)) throw new HarnessError('INVALID_ARGUMENT', 'SQLite index path must be absolute.');
    this.file = file;
  }
  get status(): IndexStatus { return structuredClone(this.state); }

  ready(): Promise<void> {
    if (this.closed) return Promise.reject(new HarnessError('INDEX_UNAVAILABLE', 'The index worker is closed.'));
    if (this.failed) return Promise.reject(this.failed);
    return this.starting ??= this.start();
  }

  private async start(): Promise<void> {
    // The shipped worker is compiled JS and needs no CLI/test/loader flags.
    this.worker = new Worker(new URL('./index-worker.js', import.meta.url), { execArgv: [] });
    this.worker.on('message', (response: Response) => {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.status) this.state = response.status;
      if (response.ok) pending.resolve(response.result);
      else {
        const error = response.error;
        pending.reject(new HarnessError(error?.code ?? 'INDEX_UNAVAILABLE', error?.message ?? 'SQLite worker request failed.', error?.details ?? {}, error?.retryable ?? false));
      }
    });
    this.worker.on('error', error => this.fail(error));
    this.worker.on('exit', code => { if (!this.closed) this.fail(new Error(`SQLite worker exited unexpectedly (${code}).`)); });
    await this.send('open', { file: this.file });
  }

  private fail(error: unknown): void {
    this.failed = new HarnessError('INDEX_UNAVAILABLE', 'SQLite worker failed; authoritative archives remain available.', { cause: String(error) }, true);
    this.state = { ...this.state, state: 'degraded' };
    for (const pending of this.pending.values()) pending.reject(this.failed);
    this.pending.clear();
  }

  private send(type: string, args: unknown): Promise<unknown> {
    if (!this.worker || this.failed || this.closed) return Promise.reject(this.failed ?? new HarnessError('INDEX_UNAVAILABLE', 'The index worker is unavailable.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker!.postMessage({ id, type, args }); }
      catch (error) { this.pending.delete(id); reject(new HarnessError('INVALID_ARGUMENT', 'Index input cannot be serialized.', { cause: String(error) })); }
    });
  }

  async rebuild(documents: IndexDocument[], seq: number, inputRevisions?: Record<string, string | null>): Promise<void> {
    canonicalJson(documents);
    await this.ready();
    await this.send('rebuild', { documents, seq, inputRevisions });
  }
  async project(seq: number, documents: IndexDocument[], inputRevisions?: Record<string, string | null>): Promise<void> {
    canonicalJson(documents);
    await this.ready();
    await this.send('project', { documents, seq, inputRevisions });
  }
  async search(options: SearchOptions): Promise<SearchResult> {
    await this.ready();
    return await this.send('search', options) as SearchResult;
  }
  close(): Promise<void> { return this.closing ??= this.stop(); }
  private async stop(): Promise<void> {
    if (this.closed) return;
    if (!this.worker) { this.closed = true; this.state = { ...this.state, state: 'closed' }; return; }
    try {
      try { await this.starting; } catch { /* The failure was reported to pending callers. */ }
      if (!this.failed) await this.send('close', {});
    } finally {
      this.closed = true;
      this.state = { ...this.state, state: 'closed' };
      for (const pending of this.pending.values()) pending.reject(new HarnessError('INDEX_UNAVAILABLE', 'The index worker was closed.'));
      this.pending.clear();
      await this.worker.terminate();
    }
  }
}
