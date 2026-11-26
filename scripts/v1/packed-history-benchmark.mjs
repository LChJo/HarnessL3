// Synthetic history scale benchmark through the actual CLI/service. It does
// not copy or scan the user's original archive.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { PackedArchiveStore, PACK_FILE, PACK_FORMAT, PACK_FORMAT_FILE } from '../../build/core/packed-archive.js';
import { canonicalJson, digest } from '../../build/core/json.js';
import { atomicWrite } from '../../build/core/io.js';
import { Runtime } from '../../build/core/runtime.js';
import { canonicalPath, isWithin } from '../../build/core/paths.js';

const args = process.argv.slice(2), opt = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const exec = promisify(execFile), bin = path.resolve('bin/harnessl3.mjs');
async function main() {
  const rootArg = opt('--root'), count = Number(opt('--rows', 1_000_000));
  assert.ok(rootArg && path.isAbsolute(rootArg) && Number.isSafeInteger(count) && count > 0 && count <= 1_000_000);
  const root = await canonicalPath(rootArg), project = await canonicalPath(process.cwd()); assert.ok(!isWithin(root, project) && !isWithin(project, root));
  await mkdir(root, { recursive: false }); const dataRoot = path.join(root, 'data'), workspace = path.join(root, 'workspace'); await mkdir(dataRoot); await mkdir(workspace); await writeFile(path.join(workspace, 'README.md'), 'Synthetic history fixture\n');
  new PackedArchiveStore(path.join(dataRoot, PACK_FILE), true).close(); await atomicWrite(path.join(dataRoot, PACK_FORMAT_FILE), canonicalJson(PACK_FORMAT) + '\n');
  const runtime = new Runtime(dataRoot); let target, historicalTask;
  try {
    const call = (operation, flags = {}, positionals = [], requestId = randomUUID(), input) => runtime.execute({ operation, flags, positionals, cwd: workspace, requestId, ...(input ? { input } : {}) });
    const init = await call('init'); assert.equal(init.ok, true, JSON.stringify(init)); target = init.target;
    const entry = await call('task start', { title: 'Historical task before synthetic background records' }); assert.equal(entry.ok, true, JSON.stringify(entry));
    historicalTask = entry.data.taskId;
    const selectionId = randomUUID();
    const selected = await call('task select', {}, [historicalTask], selectionId, { schemaVersion: 1, requestId: selectionId, context: { expand: [], read: [entry.data.directory.items[0].id], known: {} }, skills: [] });
    assert.equal(selected.ok, true, JSON.stringify(selected));
  } finally { await runtime.close(); }
  const reportFile = path.join(root, 'packed-history-benchmark.json'), report = { status: 'generating', platform: process.platform, node: process.version, count, historicalTask, scope: 'synthetic metadata scale; shared small historical state interleaved with real task records; not physical user archive', root, dataRoot, samples: [] };
  const save = async () => { await atomicWrite(reportFile, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ status: report.status, generated: report.generated ?? 0, report: reportFile })); };
  const store = new PackedArchiveStore(path.join(dataRoot, PACK_FILE));
  try {
    const content = { schemaVersion: 1, target, state: 'pending', sourceEpoch: 0, sourceVersion: { head: null, treeHash: null, status: 'unknown' }, sourceScanRevision: null, modelRevision: null, attemptedModelRevision: null, modelState: 'unknown', pendingPaths: [], modelPending: true, scanPending: true, proofId: null, verifiedAt: null, lastCheckedAt: null, diagnostics: [], lastCompleteSource: null, lastValidModelSnapshotHash: null };
    const stateHash = digest('receipt', content); store.putFile(target.worktreeId, 'snapshot', stateHash + '.json', Buffer.from(canonicalJson({ schemaVersion: 1, kind: 'receipt', content, hash: stateHash }) + '\n'));
    const start = performance.now(), head = store.lastHeader(target.worktreeId), baseSeq = head?.seq ?? 0; let previousHash = head?.hash ?? null;
    for (let offset = 0; offset < count; offset += 1000) {
      store.batch(() => { for (let seq = baseSeq + offset + 1; seq <= baseSeq + Math.min(count, offset + 1000); seq++) {
        const record = { schemaVersion: 1, seq, operationId: randomUUID(), scope: `freshness-state:${target.worktreeId}`, requestId: randomUUID(), requestHash: digest('request', { seq }), committedAt: '2026-01-01T00:00:00.000Z', previousHash, payload: { kind: 'freshness-state', stateHash, reason: 'source-event', declaration: null }, receiptHash: stateHash, archives: [{ kind: 'snapshot', hash: stateHash }], materializations: [] };
        const finalized = { ...record, hash: digest('commit', record) }; store.putRecord(target.worktreeId, finalized); previousHash = finalized.hash;
      } });
      report.generated = Math.min(count, offset + 1000); if (report.generated % 10_000 === 0 || report.generated === count) await save();
    }
    report.generateMs = performance.now() - start; report.archiveCounts = store.counts();
  } finally { store.close(); }
  report.dbBytes = (await stat(path.join(dataRoot, PACK_FILE))).size;
  async function cli(...command) {
    const start = performance.now(); const result = await exec(process.execPath, [bin, ...command, '--data-dir', dataRoot, '--json', '--timeout-ms', '120000'], { cwd: workspace, windowsHide: true, timeout: 150000, maxBuffer: 16 * 1024 * 1024 });
    const body = JSON.parse(result.stdout); assert.equal(body.ok, true, JSON.stringify(body)); return { ms: performance.now() - start, body };
  }
  try {
    report.status = 'measuring'; await save();
    for (let i = 0; i < 5; i++) {
      const entry = await cli('task', 'start', '--title', `Scale task ${i}`), taskId = entry.body.data.taskId;
      report.samples.push({ operation: 'task start', mode: i === 0 ? 'cold-service' : 'hot', ms: entry.ms, taskId });
      const selected = await cli('task', 'select', taskId, '--read', entry.body.data.directory.items[0].id);
      report.samples.push({ operation: 'task select', mode: 'hot', ms: selected.ms, taskId });
      const handoff = await cli('task', 'handoff', taskId);
      assert.deepEqual(handoff.body.data.packet, selected.body.data.packet);
      report.samples.push({ operation: 'task handoff', mode: 'hot', ms: handoff.ms, taskId });
    }
    const prior = await cli('task', 'handoff', historicalTask); report.samples.push({ operation: 'historical task handoff', ms: prior.ms, taskId: historicalTask });
    report.build = (await cli('serve', 'status')).body.data.result.build;
    const d = (await cli('runtime', 'diagnostics')).body.data.result;
    report.diagnostics = d; assert.equal(d.packed.commits, count + 12); assert.ok(d.worktrees[0].archive.snapshotReads < 500, 'New task unexpectedly read historical bodies');
    report.status = 'passed'; await save();
  } catch (error) { report.status = 'failed'; report.error = String(error); await save(); throw error; }
  finally { await cli('serve', 'stop').catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
