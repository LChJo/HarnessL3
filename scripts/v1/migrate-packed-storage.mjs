// Explicit offline conversion. Never removes or overwrites the legacy root.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, statfs, symlink, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { PackedArchiveStore, PACK_FILE, PACK_FORMAT, PACK_FORMAT_FILE } from '../../build/core/packed-archive.js';
import { Archive, validateCommitRecord, verifySnapshotBytes } from '../../build/core/archive.js';
import { TaskService } from '../../build/core/context.js';
import { SearchIndex } from '../../build/core/index.js';
import { FreshnessManager } from '../../build/core/freshness.js';
import { CurrentStateStore } from '../../build/core/current-state.js';
import { ObservationManager } from '../../build/core/observation.js';
import { canonicalJson, parseJsonStrict, sha256 } from '../../build/core/json.js';
import { atomicWrite } from '../../build/core/io.js';
import { canonicalPath, isWithin, samePath } from '../../build/core/paths.js';

const args = process.argv.slice(2);
const option = name => { const found = args.indexOf(name); return found < 0 ? undefined : args[found + 1]; };
const sourceArg = option('--source'), targetArg = option('--target');
const apply = args.includes('--apply'), resume = args.includes('--resume');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, HASH = /^[0-9a-f]{64}$/;
const notFound = error => error?.code === 'ENOENT';
const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const emit = value => console.log(JSON.stringify(value));
const abort = message => { throw new Error(message); };
const exists = async file => { try { return await lstat(file); } catch (error) { if (notFound(error)) return null; throw error; } };
const signature = info => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
async function hashFile(file) { const h = createHash('sha256'); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest('hex'); }
async function readStable(file) {
  const before = await lstat(file); if (!before.isFile() || before.isSymbolicLink()) abort(`Not a regular source file: ${file}`);
  const bytes = await readFile(file), after = await lstat(file);
  if (signature(before) !== signature(after) || after.size !== bytes.length) abort(`Source changed while reading: ${file}`);
  return bytes;
}
async function serviceStopped(root, ownGuard) {
  for (const name of ['service.lock', 'service.json']) {
    const file = path.join(root, name), info = await exists(file); if (!info) continue;
    const value = parseJsonStrict(decode(await readStable(file)));
    if (name === 'service.lock' && ownGuard && value.pid === process.pid && value.instanceId === ownGuard) continue;
    if (!Number.isInteger(value.pid) || value.pid <= 0) abort(`Unknown service owner: ${file}`);
    try { process.kill(value.pid, 0); } catch (error) { if (error.code === 'ESRCH') continue; throw error; }
    abort(`The source/target still has a live service owner (PID ${value.pid}); stop it before conversion.`);
  }
}
async function copyVerified(source, target) {
  const before = await lstat(source);
  if (!before.isFile() || before.isSymbolicLink()) abort(`Non-regular copy input: ${source}`);
  await mkdir(path.dirname(target), { recursive: true });
  const prior = await exists(target);
  if (prior && (!prior.isFile() || prior.isSymbolicLink())) abort(`Refusing to replace an existing non-file: ${target}`);
  if (!prior) await copyFile(source, target, constants.COPYFILE_EXCL);
  const originHash = await hashFile(source), outputHash = await hashFile(target);
  if (signature(before) !== signature(await lstat(source)) || originHash !== outputHash) abort(`Copy verification failed: ${source}`);
  return { bytes: before.size, hash: originHash };
}
async function copyTree(sourceRoot, targetRoot, input, output, rows) {
  const info = await lstat(input);
  if (info.isSymbolicLink()) {
    // Keep external links as links, never traverse user data outside the root.
    const raw = await readlink(input), resolved = await canonicalPath(path.resolve(path.dirname(input), raw));
    const mapped = isWithin(sourceRoot, resolved) ? path.join(targetRoot, path.relative(sourceRoot, resolved)) : resolved;
    const previous = await exists(output);
    if (!previous) { await mkdir(path.dirname(output), { recursive: true }); const destinationType = process.platform === 'win32' ? (await exists(resolved))?.isDirectory() ? 'junction' : 'file' : undefined; await symlink(mapped, output, destinationType); }
    else if (!previous.isSymbolicLink() || !samePath(await canonicalPath(path.resolve(path.dirname(output), await readlink(output))), mapped)) abort(`Link destination conflict: ${output}`);
    rows.push({ path: path.relative(sourceRoot, input), kind: 'link', target: raw }); return;
  }
  if (info.isDirectory()) {
    const previous = await exists(output); if (previous && (!previous.isDirectory() || previous.isSymbolicLink())) abort(`Directory conflict: ${output}`);
    await mkdir(output, { recursive: true });
    for (const name of (await readdir(input)).sort(compare)) await copyTree(sourceRoot, targetRoot, path.join(input, name), path.join(output, name), rows);
    return;
  }
  if (!info.isFile()) abort(`Unsupported source entry: ${input}`);
  rows.push({ path: path.relative(sourceRoot, input), kind: 'file', ...await copyVerified(input, output) });
}
async function scanMetadata(root, dir, totals) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name); if (entry.isSymbolicLink()) { totals.links++; continue; }
    if (entry.isDirectory()) { await scanMetadata(root, file, totals); continue; }
    if (!entry.isFile()) { totals.other++; continue; }
    const s = await lstat(file); totals.files++; totals.bytes += s.size;
    const category = path.relative(root, file).split(path.sep)[1];
    if (category === 'snapshots' || category === 'skill-blobs') { totals[category] ??= { files: 0, bytes: 0 }; totals[category].files++; totals[category].bytes += s.size; }
  }
}
async function* lines(file) {
  let pending = Buffer.alloc(0);
  for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    let start = 0, end;
    while ((end = chunk.indexOf(10, start)) >= 0) {
      const next = chunk.subarray(start, end + 1); yield { raw: pending.length ? Buffer.concat([pending, next]) : Buffer.from(next), complete: true };
      pending = Buffer.alloc(0); start = end + 1;
    }
    if (start < chunk.length) pending = Buffer.concat([pending, chunk.subarray(start)]);
  }
  if (pending.length) yield { raw: pending, complete: false };
}
function manifestDigest(rows) { const h = createHash('sha256'); let count = 0, bytes = 0; for (const row of rows) { h.update(canonicalJson(row) + '\n'); count++; bytes += row.bytes; } return { count, bytes, hash: h.digest('hex') }; }

async function main() {
  if (!sourceArg || !targetArg || !path.isAbsolute(sourceArg) || !path.isAbsolute(targetArg)) abort('Usage: node scripts/v1/migrate-packed-storage.mjs --source <absolute> --target <absolute> [--apply [--resume]]');
  const source = await realpath(sourceArg), target = await canonicalPath(targetArg);
  if (isWithin(source, target) || isWithin(target, source)) abort('Source and destination must be independent local directories.');
  const registryBytes = await readStable(path.join(source, 'registry.json')), registryHash = sha256(registryBytes), registry = parseJsonStrict(decode(registryBytes));
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.worktrees) || !Array.isArray(registry.projects)) abort('Only a legacy v1 registry may be converted by this tool.');
  for (const w of registry.worktrees) if (!UUID.test(w.id) || !path.isAbsolute(w.root) || isWithin(await canonicalPath(w.root), target) || isWithin(target, await canonicalPath(w.root))) abort(`Data destination overlaps a registered worktree: ${w.id}`);
  const worktreeRoot = path.join(source, 'worktrees');
  if (!apply) {
    const totals = { files: 0, bytes: 0, links: 0, other: 0 };
    if (await exists(worktreeRoot)) await scanMetadata(worktreeRoot, worktreeRoot, totals);
    let freeBytes = null; try { const stat = await statfs(path.dirname(target), { bigint: true }); freeBytes = Number(stat.bavail * stat.bsize); } catch { /* The actual free-space check remains deployment evidence. */ }
    emit({ mode: 'dry-run', source, target, registryHash, registeredWorktrees: registry.worktrees.length, totals, targetFreeBytes: freeBytes, sourceModified: false, targetCreated: false }); return;
  }
  await serviceStopped(source);
  const sourceGuardFile = path.join(source, 'service.lock'), guardId = randomUUID();
  if (await exists(sourceGuardFile)) abort('A stale source service lock must be archived by the operator after confirming its owner is gone. No migration may race another writer.');
  const sourceGuard = await open(sourceGuardFile, 'wx');
  try { await sourceGuard.writeFile(canonicalJson({ schemaVersion: 1, pid: process.pid, instanceId: guardId, startedAt: new Date().toISOString() }) + '\n'); await sourceGuard.sync(); }
  finally { await sourceGuard.close(); }
  try { await serviceStopped(source, guardId);
  const prior = await exists(target);
  if (!prior) await mkdir(target, { recursive: false });
  else if (!prior.isDirectory() || prior.isSymbolicLink() || !resume) abort('Target exists; only use --resume for the same verified prepared migration.');
  if (await exists(path.join(target, PACK_FORMAT_FILE))) abort('The target is already a published packed runtime. Do not overwrite it.');
  await serviceStopped(target);
  const markerFile = path.join(target, 'migration-state.json'), state = { schemaVersion: 1, source, target, registryHash };
  if (prior) {
    const prepared = parseJsonStrict(decode(await readStable(markerFile)));
    if (canonicalJson(prepared) !== canonicalJson(state)) abort('Resume target/source identity differs from the prepared migration.');
  } else await atomicWrite(markerFile, canonicalJson(state) + '\n');
  const lockFile = path.join(target, 'migration.lock');
  if (await exists(lockFile)) {
    if (!resume) abort('A migration lock already exists.');
    const lock = parseJsonStrict(decode(await readStable(lockFile)));
    if (!Number.isInteger(lock.pid) || lock.pid <= 0) abort('Unknown migration lock owner.');
    try { process.kill(lock.pid, 0); abort(`Migration owner ${lock.pid} is still alive.`); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await rename(lockFile, path.join(target, `migration-lock-${randomUUID()}.stale`));
  }
  const lock = await open(lockFile, 'wx'); await lock.writeFile(canonicalJson({ pid: process.pid, startedAt: new Date().toISOString() })); await lock.sync(); await lock.close();
  const dbPath = path.join(target, PACK_FILE), store = new PackedArchiveStore(dbPath, !(await exists(dbPath)));
  try {
    const previous = store.meta('migration-source');
    if (previous && canonicalJson(previous) !== canonicalJson(state)) abort('Packed database belongs to another migration.');
    if (!previous) store.setMeta('migration-source', state);
    const copies = [], skippedDerived = [], results = [];
    for (const name of (await readdir(source)).sort(compare)) {
      if (['worktrees', 'registry.json', 'service.lock', 'service.json'].includes(name)) continue;
      await copyTree(source, target, path.join(source, name), path.join(target, name), copies);
    }
    await copyVerified(path.join(source, 'registry.json'), path.join(target, 'migration-original', 'registry.json'));
    const dirs = await exists(worktreeRoot) ? (await readdir(worktreeRoot, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name)) : [];
    for (const entry of dirs) {
      const id = entry.name, input = path.join(worktreeRoot, id), output = path.join(target, 'worktrees', id);
      if (!entry.isDirectory() || entry.isSymbolicLink() || !UUID.test(id)) { await copyTree(source, target, input, path.join(target, 'migration-original', 'worktrees', id), copies); continue; }
      await mkdir(output, { recursive: true });
      const registered = registry.worktrees.find(w => w.id === id), stateMeta = new Map();
      const invalid = new Set(), manifests = {};
      for (const [dirName, kind] of [['snapshots', 'snapshot'], ['skill-blobs', 'blob']]) {
        const dir = path.join(input, dirName), names = (await exists(dir)) ? (await readdir(dir)).sort(compare) : [];
        const directoryInfo = await exists(dir); if (directoryInfo && (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())) abort(`Invalid archive directory: ${dir}`);
        let batch = [], batchBytes = 0, count = 0, rawBytes = 0; const manifest = createHash('sha256');
        const flush = () => { if (!batch.length) return; store.batch(() => { for (const item of batch) store.putFile(id, kind, item.name, item.raw); }); batch = []; batchBytes = 0; };
        for (const name of names) {
          const raw = await readStable(path.join(dir, name)); const expected = kind === 'snapshot' && name.endsWith('.json') ? name.slice(0, -5) : name;
          try {
            if (!HASH.test(expected)) throw new Error('Unknown file name');
            if (kind === 'snapshot') {
              const content = verifySnapshotBytes(expected, raw);
              if (content && typeof content === 'object' && 'sourceEpoch' in content) stateMeta.set(expected, { schemaVersion: content.schemaVersion, target: content.target, sourceEpoch: content.sourceEpoch, pendingPaths: Array.isArray(content.pendingPaths) });
            } else if (sha256(raw) !== expected) throw new Error('Invalid blob');
          }
          catch { invalid.add(`${kind}:${name}`); }
          const rawHash = sha256(raw); manifest.update(canonicalJson({ name, rawHash, bytes: raw.length }) + '\n'); count++; rawBytes += raw.length;
          batch.push({ name, raw }); batchBytes += raw.length; if (batch.length >= 128 || batchBytes >= 32 * 1024 * 1024) flush();
          if (count % 1000 === 0) emit({ phase: 'packing-content', worktree: id, kind, count, total: names.length, bytes: rawBytes });
        }
        flush();
        const expected = { count, bytes: rawBytes, hash: manifest.digest('hex') }, actual = manifestDigest(store.fileManifest(id, kind));
        if (canonicalJson(expected) !== canonicalJson(actual)) abort(`Packed file manifest differs for ${id}/${dirName}`);
        manifests[kind] = expected;
      }
      const journal = path.join(input, 'journal.jsonl'), sourceJournal = createHash('sha256'), targetJournal = createHash('sha256');
      let seq = 0, previousHash = null, tail = null, journalBytes = 0, previousEpoch = 0; const journalInfo = await exists(journal);
      if (journalInfo) {
        if (!journalInfo.isFile() || journalInfo.isSymbolicLink()) abort(`Invalid journal: ${journal}`);
        let batch = [], batchBytes = 0;
        const flush = () => { if (!batch.length) return; store.batch(() => { for (const item of batch) {
          const existing = store.bySeq(id, item.record.seq);
          if (existing) { if (!store.rawRecord(id, item.record.seq).equals(item.raw)) abort(`Resumed record differs: ${id}/${item.record.seq}`); }
          else store.putRecord(id, item.record, item.raw);
        } }); batch = []; batchBytes = 0; };
        for await (const { raw, complete } of lines(journal)) {
          sourceJournal.update(raw); journalBytes += raw.length;
          if (!complete) { tail = { bytes: raw.length, hash: sha256(raw) }; await atomicWrite(path.join(output, 'diagnostics', 'migration-original-tail'), raw); continue; }
          const record = parseJsonStrict(decode(raw));
          validateCommitRecord(record, seq, previousHash, (scope, requestId) => { const prior = store.byRequest(id, scope, requestId); return prior ? prior.seq !== record.seq : false; });
          for (const ref of record.archives) {
            const name = ref.kind === 'snapshot' ? ref.hash + '.json' : ref.hash;
            if (invalid.has(`${ref.kind}:${name}`) || !store.fileHash(id, ref.kind, name)) abort(`Missing or corrupt referenced original: ${id}/${record.seq}/${ref.kind}/${name}`);
          }
          if (record.payload?.kind === 'freshness-state') {
            const state = record.payload.state ? { ...record.payload.state, pendingPaths: Array.isArray(record.payload.state.pendingPaths) } : stateMeta.get(record.payload.stateHash);
            if (!registered || !state || state.schemaVersion !== 1 || state.target?.projectId !== registered.projectId || state.target?.worktreeId !== id || !Number.isSafeInteger(state.sourceEpoch) || state.sourceEpoch < previousEpoch || state.pendingPaths !== true) abort(`Invalid original synchronization identity/epoch: ${id}/${record.seq}`);
            previousEpoch = state.sourceEpoch;
          }
          seq = record.seq; previousHash = record.hash; batch.push({ record, raw }); batchBytes += raw.length;
          if (batch.length >= 128 || batchBytes >= 32 * 1024 * 1024) flush();
          if (seq % 1000 === 0) emit({ phase: 'packing-journal', worktree: id, seq, bytes: journalBytes });
        }
        flush();
        if (signature(journalInfo) !== signature(await lstat(journal))) abort(`Journal changed while converting: ${journal}`);
      }
      if (store.latest(id).seq !== seq || store.latest(id).hash !== previousHash) abort(`Packed journal boundary differs: ${id}`);
      for (let n = 1; n <= seq; n++) { const raw = store.rawRecord(id, n); store.record(id, n); targetJournal.update(raw); }
      if (tail) targetJournal.update(await readStable(path.join(output, 'diagnostics', 'migration-original-tail')));
      const journalHash = sourceJournal.digest('hex'); if (journalHash !== targetJournal.digest('hex')) abort(`Original journal byte hash differs: ${id}`);
      for (const name of (await readdir(input)).sort(compare)) {
        if (['snapshots', 'skill-blobs', 'journal.jsonl'].includes(name)) continue;
        if (['index.sqlite', 'browse-index.json'].includes(name)) { const info = await lstat(path.join(input, name)); if (!info.isFile() || info.isSymbolicLink()) abort(`Unexpected derived file type: ${id}/${name}`); skippedDerived.push({ worktree: id, name, bytes: info.size, reason: 'rebuildable-query-projection; original remains in source' }); continue; }
        const dest = ['tasks', 'checkpoints'].includes(name) ? path.join(target, 'migration-original', 'worktrees', id, name) : path.join(output, name);
        await copyTree(source, target, path.join(input, name), dest, copies);
      }
      let semantic = { status: 'unregistered-unknown', taskRecords: 0 };
      if (registered) {
        const archive = new Archive(output, { readOnly: true, verification: 'operational', packedSource: { store, worktree: id } });
        const tasks = new TaskService({ worktree: registered, archive, index: new SearchIndex(path.join(output, 'index.sqlite')), source: async () => abort('Migration cannot scan current source') });
        const freshness = new FreshnessManager({ worktree: registered, archive, stateStore: new CurrentStateStore(output), serial: fn => fn() });
        const observation = new ObservationManager({ worktree: registered, archive, readOnly: true, pollIntervalMs: 0, serial: fn => fn() });
        try { const taskRecords = await tasks.auditHistory(); await freshness.ready(); await observation.ready(); semantic = { status: 'checked-task-state-observation', taskRecords }; }
        finally { await freshness.close(); await observation.close(); await tasks.close(); }
      }
      const summary = { worktree: id, manifests, journal: { seq, bytes: journalBytes, hash: journalHash, tail }, semantic, unreferencedOrUnknown: [...invalid].sort(compare) };
      results.push(summary); store.setMeta(`workspace:${id}`, summary); emit({ phase: 'worktree-verified', ...summary, unreferencedOrUnknown: invalid.size });
    }
    if (sha256(await readStable(path.join(source, 'registry.json'))) !== registryHash) abort('Source registry changed during conversion.');
    await serviceStopped(source, guardId);
    const verifiedContentCount = store.verifyContents(count => emit({ phase: 'verify-packed-content', count }));
    const packedCounts = store.counts();
    const converted = { ...registry, schemaVersion: 2 };
    await atomicWrite(path.join(target, 'registry.json'), canonicalJson(converted) + '\n');
    const measured = { files: 0, bytes: 0, links: 0, other: 0 }; await scanMetadata(target, target, measured);
    const report = { schemaVersion: 1, format: PACK_FORMAT.format, status: 'verified-copy', source, target, registryHash, packedCounts, verifiedContentCount, worktrees: results, copiedFiles: copies, skippedDerived, packedArchiveFileBytes: (await lstat(dbPath)).size, targetBeforeReportAndFormat: measured, verifiedOriginalContentBytes: results.reduce((sum, item) => sum + item.manifests.snapshot.bytes + item.manifests.blob.bytes, 0), verifiedOriginalJournalBytes: results.reduce((sum, item) => sum + item.journal.bytes, 0), completedAt: new Date().toISOString(), sourceDeleted: false };
    await atomicWrite(path.join(target, 'migration-report.json'), canonicalJson(report) + '\n');
    store.setMeta('migration-complete', { registryHash, worktrees: results.length, packedCounts });
    // Publish the format only after every source/target hash and reference has
    // passed. Old runtimes reject the converted v2 registry before writing.
    await atomicWrite(path.join(target, PACK_FORMAT_FILE), canonicalJson(PACK_FORMAT) + '\n');
    const finalSize = { files: 0, bytes: 0, links: 0, other: 0 }; await scanMetadata(target, target, finalSize);
    emit({ phase: 'complete', status: report.status, report: path.join(target, 'migration-report.json'), packedCounts, target: finalSize, worktrees: results.length, sourceRetained: true });
  } finally {
    store.close();
    // Keep the lock as evidence rather than deleting an unknown file. A later
    // resume checks the exact recorded owner and archives a stale lock.
    await rename(lockFile, path.join(target, `migration-lock-${randomUUID()}.finished`)).catch(() => {});
  }
  } finally {
    // Release only the temporary, exclusive guard owned by this process. The
    // authoritative legacy contents remain unchanged and the operator can roll back.
    const owner = parseJsonStrict(decode(await readStable(sourceGuardFile)));
    if (owner.pid === process.pid && owner.instanceId === guardId) await unlink(sourceGuardFile);
  }
}
main().catch(error => { console.error(JSON.stringify({ status: 'failed', code: error?.code ?? 'MIGRATION_FAILED', message: error?.message, details: error?.details })); process.exitCode = 1; });
