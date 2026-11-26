// Actual CLI/service process soak, with isolated data and workspace roots.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { PackedArchiveStore, PACK_FILE, PACK_FORMAT, PACK_FORMAT_FILE } from '../../build/core/packed-archive.js';
import { canonicalJson } from '../../build/core/json.js';
import { atomicWrite } from '../../build/core/io.js';
import { canonicalPath, isWithin } from '../../build/core/paths.js';

const args = process.argv.slice(2), opt = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const rootArg = opt('--root'), duration = Number(opt('--duration-ms', 24 * 60 * 60_000)), interval = Number(opt('--interval-ms', 60_000)), count = Number(opt('--worktrees', 25));
const exec = promisify(execFile), bin = path.resolve('bin/harnessl3.mjs');
async function snapshot(root) {
  const rows = [];
  async function visit(dir) {
    for (const name of (await readdir(dir)).sort()) {
      if (['service.json', 'service.lock', 'service.log'].includes(name) && dir === root) continue;
      const file = path.join(dir, name), info = await lstat(file);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) { await visit(file); continue; }
      if (info.isFile()) { const raw = await readFile(file); rows.push({ path: path.relative(root, file), bytes: raw.length, hash: createHash('sha256').update(raw).digest('hex') }); }
    }
  }
  await visit(root); return { files: rows.length, bytes: rows.reduce((n, row) => n + row.bytes, 0), fingerprint: createHash('sha256').update(canonicalJson(rows)).digest('hex'), rows };
}
async function main() {
  assert.ok(rootArg && path.isAbsolute(rootArg), '--root must be an explicit absolute new fixture directory');
  assert.ok(Number.isSafeInteger(duration) && duration > 0 && Number.isSafeInteger(interval) && interval >= 1000 && Number.isSafeInteger(count) && count > 0 && count <= 100);
  const root = await canonicalPath(rootArg), project = await canonicalPath(process.cwd());
  assert.ok(!isWithin(project, root) && !isWithin(root, project), 'Fixture root must be outside the product worktree');
  await mkdir(root, { recursive: false });
  const dataRoot = path.join(root, 'data'), fixtures = path.join(root, 'projects'); await mkdir(dataRoot); await mkdir(fixtures);
  new PackedArchiveStore(path.join(dataRoot, PACK_FILE), true).close();
  await atomicWrite(path.join(dataRoot, PACK_FORMAT_FILE), canonicalJson(PACK_FORMAT) + '\n');
  const report = { status: 'initializing', platform: process.platform, node: process.version, count, duration, interval, root, dataRoot, samples: [], startedAt: new Date().toISOString() };
  const reportFile = path.join(root, 'soak-report.json');
  const save = async () => { await atomicWrite(reportFile, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ status: report.status, samples: report.samples.length, elapsedMs: report.elapsedMs ?? 0, report: reportFile })); };
  async function cli(cwd, ...command) {
    const result = await exec(process.execPath, [bin, ...command, '--data-dir', dataRoot, '--json', '--timeout-ms', '120000'], { cwd, windowsHide: true, timeout: 150000, maxBuffer: 16 * 1024 * 1024 });
    const body = JSON.parse(result.stdout); assert.equal(body.ok, true, JSON.stringify(body)); return body.data.result ?? body.data;
  }
  try {
    await save();
    for (let i = 0; i < count; i++) {
      const project = path.join(fixtures, `workspace-${i}`); await mkdir(project); await writeFile(path.join(project, 'README.md'), `Passive workspace ${i}\n`);
      await cli(project, 'init');
      if (!args.includes('--passive-only')) await cli(project, 'sync', 'status');
    }
    report.status = 'waiting-for-passive'; await save();
    const deadline = Date.now() + 10 * 60_000;
    let initial;
    while (true) {
      initial = await cli(root, 'runtime', 'diagnostics');
      if (initial.loadedWorktrees === 0 && initial.worktrees.every(w => !w.freshness.activeLease && !w.observation.polling)) break;
      assert.ok(Date.now() < deadline, 'Previously active workspaces did not release their idle resources'); await delay(10_000);
    }
    const baseline = await snapshot(dataRoot);
    report.build = (await cli(root, 'serve', 'status')).build;
    report.baseline = { ...baseline, diagnostics: initial }; report.status = 'running'; report.passiveStartedAt = new Date().toISOString(); const start = Date.now(); await save();
    do {
      await delay(Math.min(interval, Math.max(1, duration - (Date.now() - start))));
      const diagnostic = await cli(root, 'runtime', 'diagnostics'), current = await snapshot(dataRoot);
      assert.equal(diagnostic.registeredWorktrees, count); assert.equal(diagnostic.loadedWorktrees, 0);
      assert.equal(diagnostic.packed.commits, initial.packed.commits); assert.equal(diagnostic.packed.files, initial.packed.files);
      assert.equal(current.fingerprint, baseline.fingerprint, 'Passive runtime data bytes changed');
      report.elapsedMs = Date.now() - start;
      report.samples.push({ at: new Date().toISOString(), elapsedMs: report.elapsedMs, fileCount: current.files, bytes: current.bytes, fingerprint: current.fingerprint, memory: diagnostic.memory, loaded: diagnostic.loadedWorktrees });
      await save();
    } while (report.elapsedMs < duration);
    assert.deepEqual((await cli(root, 'serve', 'status')).build, report.build, 'Service build changed during the soak');
    report.status = 'passed'; report.completedAt = new Date().toISOString(); await save();
  } catch (error) { report.status = 'failed'; report.error = String(error); await save(); throw error; }
  finally { try { await cli(root, 'serve', 'stop'); } catch (error) { report.stopError = String(error); await save(); } }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
