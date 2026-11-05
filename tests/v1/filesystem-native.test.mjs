import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execFile as callbackExecFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { atomicWrite } from '../../build/core/io.js';
import { canonicalPath, resolveInside } from '../../build/core/paths.js';
import { sha256 } from '../../build/core/json.js';
import { WorkspaceRegistry } from '../../build/core/workspace.js';
import { scanSource, changedSourcePaths } from '../../build/core/source.js';

const execFile = promisify(callbackExecFile);

async function fixture(t, beforeCleanup = async () => {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'harnessl3-native-filesystem-'));
  t.after(async () => {
    try { await beforeCleanup(); }
    finally {
      assert.ok(path.isAbsolute(root));
      assert.ok(path.basename(root).startsWith('harnessl3-native-filesystem-'));
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  return root;
}

async function bounded(promise, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out waiting for ' + description)), 20_000); }),
    ]);
  } finally { clearTimeout(timer); }
}

test('TC26 Windows external FileShare.None lock rejects atomic replacement, preserves bytes and releases explicitly', {
  skip: process.platform !== 'win32' ? 'Windows native file-sharing semantics require Windows.' : false,
}, async (t) => {
  let releaseHolder;
  const root = await fixture(t, async () => { await releaseHolder?.(); });
  const file = path.join(root, 'owned-state.bin');
  const oldBytes = Buffer.from([0, 1, 255, 13, 10, 42]);
  const nextBytes = Buffer.from([42, 10, 13, 254, 2, 0]);
  await writeFile(file, oldBytes);
  const helper = path.join(root, 'hold-file.ps1');
  await writeFile(helper, `param([Parameter(Mandatory=$true)][string]$TargetPath)
$ErrorActionPreference = 'Stop'
$held = [System.IO.File]::Open($TargetPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
try {
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()
  while (($instruction = [Console]::In.ReadLine()) -ne $null) {
    if ($instruction -eq 'release') { break }
    if ($instruction -ne 'inspect') { throw 'Unexpected instruction' }
    $held.Position = 0
    $bytes = New-Object byte[] ([int]$held.Length)
    $offset = 0
    while ($offset -lt $bytes.Length) {
      $count = $held.Read($bytes, $offset, $bytes.Length - $offset)
      if ($count -eq 0) { throw 'Unexpected end of held file' }
      $offset += $count
    }
    [Console]::Out.WriteLine('HELD:' + [Convert]::ToBase64String($bytes))
    [Console]::Out.Flush()
  }
} finally { $held.Dispose() }
[Console]::Out.WriteLine('RELEASED')
[Console]::Out.Flush()
`, 'utf8');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-TargetPath', file], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', () => { /* Exit status and stderr report a failed lock holder. */ });
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const lines = output[Symbol.asyncIterator]();
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  // Register release before waiting for readiness so assertion failures cannot leave a lock holder.
  releaseHolder = async () => {
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end('release\n');
    try { await bounded(exited, 'lock holder cleanup'); }
    catch (error) { child.kill(); await exited.catch(() => {}); throw error; }
    finally { output.close(); }
  };
  async function line(expected) {
    const next = await bounded(lines.next(), 'lock holder ' + expected);
    assert.equal(next.done, false, stderr);
    assert.equal(next.value, expected, stderr);
  }
  await line('READY');
  await assert.rejects(atomicWrite(file, nextBytes), (error) => ['EACCES', 'EPERM', 'EBUSY'].includes(error?.code));
  child.stdin.write('inspect\n');
  await line('HELD:' + oldBytes.toString('base64'));
  assert.deepEqual((await readdir(root)).sort(), ['hold-file.ps1', 'owned-state.bin']);
  child.stdin.end('release\n');
  await line('RELEASED');
  const status = await bounded(exited, 'lock holder exit after release');
  assert.equal(status.code, 0, stderr);
  assert.equal(status.signal, null);
  assert.deepEqual(await readFile(file), oldBytes);
  await atomicWrite(file, nextBytes);
  assert.deepEqual(await readFile(file), nextBytes);
});

test('TC26 POSIX case-distinct source paths retain independent bytes, hashes and changes in one Git directory', {
  skip: process.platform === 'win32' ? 'This acceptance requires a native case-sensitive POSIX filesystem.' : false,
}, async (t) => {
  const root = await fixture(t);
  const checkout = path.join(root, 'checkout');
  const dataRoot = path.join(root, 'machine-data');
  const seedRoot = path.join(root, 'empty-seed');
  await mkdir(path.join(checkout, 'src'), { recursive: true });
  await mkdir(seedRoot);
  const upper = 'src/Module.ts', lower = 'src/module.ts';
  const upperBytes = Buffer.from('export const upper = 1;\r\n');
  const lowerBytes = Buffer.from('export const lower = 2;\n');
  await writeFile(path.join(checkout, upper), upperBytes, { flag: 'wx' });
  try { await writeFile(path.join(checkout, lower), lowerBytes, { flag: 'wx' }); }
  catch (error) {
    if (error.code === 'EEXIST') return t.skip('The native POSIX volume is case-insensitive and cannot represent this fixture.');
    throw error;
  }
  const emptyGlobal = path.join(root, 'empty-git-config');
  await writeFile(emptyGlobal, '');
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (key.startsWith('GIT_')) delete environment[key];
  Object.assign(environment, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyGlobal });
  const git = (...args) => execFile('git', ['-C', checkout, ...args], { env: environment, windowsHide: true });
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Harness Filesystem Fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'core.autocrlf', 'false');
  await git('config', 'core.ignorecase', 'false');
  await git('config', 'core.excludesfile', emptyGlobal);
  await git('add', '--', upper, lower);
  await git('commit', '-m', 'Track native case-distinct files');
  const registry = new WorkspaceRegistry(dataRoot, { seedRoot });
  const { worktree } = await registry.init(checkout);
  const config = await registry.readConfig(checkout);
  const skillsRoot = await registry.skillsRoot(worktree);
  const original = await scanSource(worktree, config, skillsRoot);
  assert.equal(original.sourceVersion.status, 'clean', JSON.stringify(original.diagnostics));
  assert.deepEqual(original.manifest.content.entries, [
    { path: upper, entryKind: 'file', contentHash: sha256(upperBytes) },
    { path: lower, entryKind: 'file', contentHash: sha256(lowerBytes) },
  ]);
  const upperPath = await resolveInside(checkout, upper, { noSymlinks: true });
  const lowerPath = await resolveInside(checkout, lower, { noSymlinks: true });
  assert.notEqual(await canonicalPath(upperPath), await canonicalPath(lowerPath));
  assert.deepEqual(await readFile(upperPath), upperBytes);
  assert.deepEqual(await readFile(lowerPath), lowerBytes);
  const editedUpper = Buffer.from('export const upper = 3;\n');
  await atomicWrite(upperPath, editedUpper);
  const changed = await scanSource(worktree, config, skillsRoot);
  assert.equal(changed.sourceVersion.status, 'dirty', JSON.stringify(changed.diagnostics));
  assert.deepEqual(changedSourcePaths(original, changed), [upper]);
  assert.equal(changed.manifest.content.entries.find((entry) => entry.path === upper).contentHash, sha256(editedUpper));
  assert.equal(changed.manifest.content.entries.find((entry) => entry.path === lower).contentHash, sha256(lowerBytes));
  assert.deepEqual(await readFile(lowerPath), lowerBytes);
});
