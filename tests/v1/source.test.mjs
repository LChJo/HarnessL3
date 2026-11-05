import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile as callbackExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkspaceRegistry } from '../../build/core/workspace.js';
import { scanSource, changedSourcePaths, isSourcePathIncluded } from '../../build/core/source.js';
import { digest, sha256 } from '../../build/core/json.js';

const execFile = promisify(callbackExecFile);
const git = (root, ...args) => execFile('git', ['-C', root, ...args], { windowsHide: true });
const gitInput = (root, args, input) => new Promise((resolve, reject) => {
  const child = callbackExecFile('git', ['-C', root, ...args], { windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout));
  child.stdin.end(input);
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'harnessl3-source-'));
  t.after(async () => {
    assert.ok(path.basename(root).startsWith('harnessl3-source-'));
    await rm(root, { recursive: true, force: true });
  });
  const checkout = path.join(root, 'source \u4e2d\u6587 with spaces');
  const dataRoot = path.join(root, 'machine data');
  const seedRoot = path.join(root, 'packaged seed');
  const globalIgnore = path.join(root, 'global ignore');
  await mkdir(checkout);
  await mkdir(seedRoot);
  await writeFile(path.join(seedRoot, 'LICENSE'), 'Test seed\n');
  await writeFile(globalIgnore, '');
  await git(checkout, 'init', '-b', 'main');
  await git(checkout, 'config', 'user.name', 'Harness Fixture');
  await git(checkout, 'config', 'user.email', 'fixture@example.invalid');
  await git(checkout, 'config', 'core.autocrlf', 'false');
  await git(checkout, 'config', 'core.ignorecase', 'false');
  await git(checkout, 'config', 'core.excludesfile', globalIgnore);
  await writeFile(path.join(checkout, 'README.md'), 'Original bytes\n');
  await git(checkout, 'add', 'README.md');
  await git(checkout, 'commit', '-m', 'Initial source');
  const registry = new WorkspaceRegistry(dataRoot, { seedRoot });
  const registration = await registry.init(checkout, 'Source fixture');
  const configuration = () => registry.readConfig(checkout);
  const config = await configuration();
  const configure = async (next) => {
    await writeFile(registration.paths.config, JSON.stringify(next));
    return next;
  };
  const scan = async (activeConfig, skillsRoot = path.join(dataRoot, 'skills')) => scanSource(registration.worktree, activeConfig ?? await configuration(), skillsRoot);
  return { root, checkout, dataRoot, globalIgnore, registration, registry, config, configure, scan };
}

test('TC07 source manifest and policy use closed portable structures and shared canonical hashes', async (t) => {
  const f = await fixture(t);
  const result = await f.scan();
  assert.equal(result.sourceVersion.status, 'clean');
  assert.equal(result.sourceVersion.head, (await git(f.checkout, 'rev-parse', 'HEAD')).stdout.trim());
  assert.deepEqual(result.manifest, { schemaVersion: 1, kind: 'source-manifest', content: { entries: [{ path: 'README.md', entryKind: 'file', contentHash: sha256('Original bytes\n') }] } });
  assert.equal(result.sourceVersion.treeHash, digest('source-manifest', result.manifest.content));
  assert.deepEqual(result.policy, {
    schemaVersion: 1, kind: 'source-scan-policy', content: {
      scannerVersion: 'source-scanner/1', candidateSet: 'head-index-and-untracked', pathOrder: 'utf16-code-unit', ruleDialect: 'posix-glob-v1', caseSensitive: true,
      includePatterns: ['**'], fixedExcludePrefixes: ['.git', '.harness'], projectExcludePatterns: [], gitIgnoreMode: 'untracked-only',
      gitIgnoreRevision: digest('git-ignore-rules', result.ignoreRules.content), skillRootExcludePrefixes: [], linkHandling: 'record-readlink-utf8-no-follow', unsupportedEntryHandling: 'unknown',
    },
  });
  assert.equal(result.sourceScanRevision, digest('source-scan-policy', result.policy.content));
  assert.deepEqual(result.ignoreRules.content.sources.map(({ origin, path }) => ({ origin, path })), [{ origin: 'global', path: null }, { origin: 'info', path: null }]);
  assert.equal(result.ignoreRules.content.ignoreCase, false);
  assert.equal(result.diagnostics.length, 0);
  assert.ok(!JSON.stringify([result.manifest, result.policy, result.ignoreRules, result.ignoreRuleFiles]).includes(f.root));
});

test('TC07 raw worktree bytes include binary/untracked files with deterministic UTF-16 path ordering', async (t) => {
  const f = await fixture(t);
  const names = ['z.bin', '\ue000.dat', '\ud800\udc00.dat', '.dot-file'];
  for (const name of names) await writeFile(path.join(f.checkout, name), Buffer.from([0, 255, 13, 10, 42]));
  const previous = await f.scan();
  assert.equal(previous.sourceVersion.status, 'dirty');
  assert.deepEqual(previous.manifest.content.entries.map((entry) => entry.path), ['README.md', ...names].sort());
  for (const entry of previous.manifest.content.entries.filter((entry) => entry.path !== 'README.md')) assert.equal(entry.contentHash, sha256(Buffer.from([0, 255, 13, 10, 42])));
  await writeFile(path.join(f.checkout, 'README.md'), 'Changed\r\n');
  await rm(path.join(f.checkout, 'z.bin'));
  const next = await f.scan();
  assert.deepEqual(changedSourcePaths(previous, next), ['README.md', 'z.bin']);
  assert.equal(next.manifest.content.entries.find((entry) => entry.path === 'README.md').contentHash, sha256('Changed\r\n'));
  assert.ok(!next.manifest.content.entries.some((entry) => entry.path === 'z.bin'));
});

test('TC07 HEAD union index records both staged and unstaged tracked deletions', async (t) => {
  const f = await fixture(t);
  for (const name of ['staged.ts', 'unstaged.ts']) await writeFile(path.join(f.checkout, name), 'old\n');
  await git(f.checkout, 'add', 'staged.ts', 'unstaged.ts');
  await git(f.checkout, 'commit', '-m', 'Track deletion fixtures');
  await git(f.checkout, 'rm', 'staged.ts');
  await rm(path.join(f.checkout, 'unstaged.ts'));
  const scan = await f.scan();
  assert.equal(scan.sourceVersion.status, 'dirty');
  assert.deepEqual(scan.manifest.content.entries.filter((entry) => entry.entryKind === 'deleted'), [
    { path: 'staged.ts', entryKind: 'deleted', contentHash: null },
    { path: 'unstaged.ts', entryKind: 'deleted', contentHash: null },
  ]);
});

test('TC07 native Git ignore honors negation and does not hide tracked files', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.checkout, 'tracked.txt'), 'tracked\n');
  await git(f.checkout, 'add', 'tracked.txt');
  await git(f.checkout, 'commit', '-m', 'Track before ignoring');
  await writeFile(path.join(f.checkout, '.gitignore'), 'tracked.txt\nignored-*.txt\n!ignored-keep.txt\n');
  await writeFile(path.join(f.checkout, 'tracked.txt'), 'tracked modified\n');
  await writeFile(path.join(f.checkout, 'ignored-drop.txt'), 'invisible\n');
  await writeFile(path.join(f.checkout, 'ignored-keep.txt'), 'visible\n');
  const first = await f.scan();
  const names = first.manifest.content.entries.map((entry) => entry.path);
  assert.ok(names.includes('tracked.txt'));
  assert.ok(names.includes('ignored-keep.txt'));
  assert.ok(!names.includes('ignored-drop.txt'));
  await writeFile(path.join(f.checkout, 'ignored-drop.txt'), 'still invisible\n');
  const second = await f.scan();
  assert.deepEqual(second.sourceVersion, first.sourceVersion);
  assert.equal(second.sourceScanRevision, first.sourceScanRevision);
});

test('TC07 managed context, project skills and configured exclusions do not become source activity', async (t) => {
  const f = await fixture(t);
  const config = await f.configure({ ...f.config, skills: { root: 'local-skills' }, source: { excludePatterns: ['dist/**', 'generated'] } });
  const skillsRoot = path.join(f.checkout, 'local-skills');
  const first = await f.scan(config, skillsRoot);
  assert.deepEqual(first.policy.content.skillRootExcludePrefixes, ['local-skills']);
  for (const name of ['.harness/model/extra.c4', 'local-skills/group/method/SKILL.md', 'dist/output.any', 'generated/output.any']) {
    await mkdir(path.dirname(path.join(f.checkout, name)), { recursive: true });
    await writeFile(path.join(f.checkout, name), 'excluded bytes\n');
  }
  const second = await f.scan(config, skillsRoot);
  assert.deepEqual(second.sourceVersion, first.sourceVersion);
  assert.equal(second.sourceVersion.status, 'clean');
  assert.equal(second.sourceScanRevision, first.sourceScanRevision);
  assert.deepEqual(second.manifest.content.entries.map((entry) => entry.path), ['README.md']);
});

test('TC07 posix-glob-v1 matches zero-depth ** and single Unicode code points without extra wildcard dialects', async (t) => {
  const config = { source: { excludePatterns: ['src/**/test.ts', 'emoji-?.txt', 'literal', '.cache/**'] } };
  for (const file of ['src/test.ts', 'src/a/b/test.ts', 'emoji-\ud83d\ude00.txt', 'literal/child.ts', '.cache/output']) assert.equal(isSourcePathIncluded(file, config), false, file);
  for (const file of ['other/src/test.ts', 'emoji-xx.txt', 'emoji-/file.txt', 'literal-name.ts', 'src/Test.ts']) assert.equal(isSourcePathIncluded(file, config), true, file);
  assert.equal(isSourcePathIncluded('.harness/model/main.c4', config), false);
  assert.equal(isSourcePathIncluded('.git/config', config), false);
  assert.equal(isSourcePathIncluded('skills/group/a', config, ['skills']), false);
  const f = await fixture(t);
  const bad = { ...f.config, source: { excludePatterns: ['src/[ab].ts'] } };
  const result = await f.scan(bad);
  assert.equal(result.sourceVersion.status, 'unknown');
  assert.equal(result.sourceVersion.treeHash, null);
  assert.equal(result.sourceScanRevision, null);
  assert.ok(result.diagnostics.some((item) => item.code === 'SOURCE_PATTERN_INVALID'));
});

test('TC07 effective ignore rules retain raw bytes, origins and relative paths without machine paths', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.checkout, 'nested'));
  await writeFile(f.globalIgnore, 'global-excluded.txt\n');
  const info = path.join(f.registration.worktree.gitCommonDir, 'info', 'exclude');
  await writeFile(info, 'info-excluded.txt\n');
  await writeFile(path.join(f.checkout, '.gitignore'), 'root-excluded.txt\n');
  await writeFile(path.join(f.checkout, 'nested', '.gitignore'), 'nested-excluded.txt\n');
  for (const file of ['global-excluded.txt', 'info-excluded.txt', 'root-excluded.txt', 'nested/nested-excluded.txt', 'nested/visible.txt']) await writeFile(path.join(f.checkout, file), 'test\n');
  const result = await f.scan();
  assert.equal(result.sourceVersion.status, 'dirty');
  assert.deepEqual(result.ignoreRules.content.sources.map((item) => [item.origin, item.path]), [['global', null], ['info', null], ['worktree', '.gitignore'], ['worktree', 'nested/.gitignore']]);
  for (const source of result.ignoreRules.content.sources) {
    const bytes = result.ignoreRuleFiles.find((item) => item.origin === source.origin && item.path === source.path);
    assert.ok(bytes);
    assert.equal(sha256(Buffer.from(bytes.bytesBase64, 'base64')), source.hash);
  }
  assert.deepEqual(result.manifest.content.entries.map((entry) => entry.path), ['.gitignore', 'README.md', 'nested/.gitignore', 'nested/visible.txt']);
  const originalRevision = result.sourceScanRevision;
  await writeFile(f.globalIgnore, 'global-excluded.txt\n# policy edit\n');
  assert.notEqual((await f.scan()).sourceScanRevision, originalRevision);
});

test('TC07 symlink leaves hash the link target string and never substitute target bytes', async (t) => {
  const f = await fixture(t);
  const external = path.join(f.root, 'external secret');
  await writeFile(external, 'outside content\n');
  const link = path.join(f.checkout, 'source-link');
  try { await symlink(external, link, 'file'); } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return t.skip('Windows file symlink privilege unavailable.');
    throw error;
  }
  const first = await f.scan();
  assert.equal(first.sourceVersion.status, 'dirty');
  assert.deepEqual(first.manifest.content.entries.find((entry) => entry.path === 'source-link'), { path: 'source-link', entryKind: 'symlink', contentHash: sha256(await readlink(link)) });
  await writeFile(external, 'outside changed\n');
  assert.equal((await f.scan()).sourceVersion.treeHash, first.sourceVersion.treeHash);
});

test('TC07 a tracked descendant hidden by a directory link is unknown, never followed', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.checkout, 'tracked-directory'));
  await writeFile(path.join(f.checkout, 'tracked-directory', 'source.ts'), 'tracked\n');
  await git(f.checkout, 'add', 'tracked-directory');
  await git(f.checkout, 'commit', '-m', 'Track nested source');
  await rm(path.join(f.checkout, 'tracked-directory'), { recursive: true });
  const external = path.join(f.root, 'outside directory');
  await mkdir(external);
  await writeFile(path.join(external, 'source.ts'), 'outside content');
  await symlink(external, path.join(f.checkout, 'tracked-directory'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await f.scan();
  assert.equal(result.sourceVersion.status, 'unknown');
  assert.equal(result.sourceVersion.treeHash, null);
  assert.equal(result.manifest, null);
  assert.ok(result.diagnostics.some((item) => item.code === 'SOURCE_ANCESTOR_LINK'));
});

test('TC07 gitlinks and unresolved index stages are explicit unknown unless their scope is excluded', async (t) => {
  const f = await fixture(t);
  const head = (await git(f.checkout, 'rev-parse', 'HEAD')).stdout.trim();
  await git(f.checkout, 'update-index', '--add', '--cacheinfo', `160000,${head},vendor`);
  const gitlink = await f.scan();
  assert.equal(gitlink.sourceVersion.status, 'unknown');
  assert.ok(gitlink.diagnostics.some((item) => item.code === 'SOURCE_UNSUPPORTED_ENTRY'));
  const excluded = await f.configure({ ...f.config, source: { excludePatterns: ['vendor'] } });
  assert.equal((await f.scan(excluded)).sourceVersion.status, 'clean');
  await git(f.checkout, 'update-index', '--force-remove', 'vendor');
  const blob = (await git(f.checkout, 'rev-parse', 'HEAD:README.md')).stdout.trim();
  await gitInput(f.checkout, ['update-index', '--index-info'], `0 ${'0'.repeat(40)}\tREADME.md\n100644 ${blob} 1\tREADME.md\n100644 ${blob} 2\tREADME.md\n100644 ${blob} 3\tREADME.md\n`);
  const conflict = await f.scan(excluded);
  assert.equal(conflict.sourceVersion.status, 'unknown');
  assert.ok(conflict.diagnostics.some((item) => item.code === 'SOURCE_INDEX_CONFLICT'));
});

test('TC07 invalid UTF-8 filesystem paths are unknown rather than replacement-character hashes', { skip: process.platform === 'win32' ? 'Windows cannot create raw non-Unicode filename bytes; native POSIX CI fixture.' : false }, async (t) => {
  const f = await fixture(t);
  await writeFile(Buffer.concat([Buffer.from(f.checkout + path.sep + 'invalid-'), Buffer.from([255])]), 'bytes\n');
  const result = await f.scan();
  assert.equal(result.sourceVersion.status, 'unknown');
  assert.equal(result.sourceVersion.treeHash, null);
  assert.ok(result.diagnostics.some((item) => item.code === 'SOURCE_PATH_ENCODING'));
});

test('TC07 Git path overrides cannot redirect source scanning into another repository', async (t) => {
  const f = await fixture(t);
  const other = path.join(f.root, 'other repository');
  await mkdir(other);
  await git(other, 'init', '-b', 'main');
  const previous = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_LITERAL_PATHSPECS: process.env.GIT_LITERAL_PATHSPECS };
  process.env.GIT_DIR = path.join(other, '.git');
  process.env.GIT_WORK_TREE = other;
  process.env.GIT_LITERAL_PATHSPECS = '1';
  try {
    assert.equal((await f.scan()).sourceVersion.status, 'clean');
    await writeFile(path.join(f.checkout, 'README.md'), 'modified selected bytes\n');
    assert.equal((await f.scan()).sourceVersion.status, 'dirty');
  } finally {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('TC07 directory links are leaf entries even when their target is empty or has children', async (t) => {
  const f = await fixture(t);
  const external = path.join(f.root, 'outside directory');
  await mkdir(external);
  await writeFile(path.join(external, 'not-followed.txt'), 'outside bytes');
  const link = path.join(f.checkout, 'directory-link');
  await symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  const first = await f.scan();
  assert.equal(first.sourceVersion.status, 'dirty', JSON.stringify(first.diagnostics));
  assert.deepEqual(first.manifest.content.entries.find((entry) => entry.path === 'directory-link'), { path: 'directory-link', entryKind: 'symlink', contentHash: sha256(await readlink(link)) });
  assert.ok(!first.manifest.content.entries.some((entry) => entry.path.startsWith('directory-link/')));
  await rm(path.join(external, 'not-followed.txt'));
  const emptyTarget = await f.scan();
  assert.equal(emptyTarget.sourceVersion.treeHash, first.sourceVersion.treeHash);
});

test('TC07 unavailable Git ignore sources produce unknown without a synthetic policy revision', async (t) => {
  const f = await fixture(t);
  await rm(f.globalIgnore);
  await mkdir(f.globalIgnore);
  const result = await f.scan();
  assert.equal(result.sourceVersion.status, 'unknown');
  assert.equal(result.sourceVersion.treeHash, null);
  assert.equal(result.manifest, null);
  assert.equal(result.policy, null);
  assert.equal(result.sourceScanRevision, null);
  assert.ok(result.diagnostics.length > 0);
});

test('TC07 an unknown scan cannot be compared as an empty unchanged source set', () => {
  const unknown = { sourceVersion: { head: null, treeHash: null, status: 'unknown' }, manifest: null };
  assert.throws(() => changedSourcePaths(unknown, unknown), (error) => error?.code === 'SYNC_UNRESOLVED');
});

test('TC07 an unchanged tracked symlink is clean and target content changes stay outside the source scope', async (t) => {
  const f = await fixture(t);
  const external = path.join(f.root, 'outside tracked target');
  await writeFile(external, 'outside bytes\n');
  const link = path.join(f.checkout, 'tracked-link');
  await symlink(external, link, 'file');
  await git(f.checkout, 'config', 'core.symlinks', 'true');
  await git(f.checkout, 'add', 'tracked-link');
  await git(f.checkout, 'commit', '-m', 'Track a link leaf');
  const first = await f.scan();
  assert.equal(first.sourceVersion.status, 'clean');
  await writeFile(external, 'outside edited\n');
  const second = await f.scan();
  assert.deepEqual(second.sourceVersion, first.sourceVersion);
});

test('TC07 linked worktrees retain independent bytes with location-independent source fingerprints', async (t) => {
  const f = await fixture(t);
  await git(f.checkout, 'add', '.harness');
  await git(f.checkout, 'commit', '-m', 'Share portable project configuration');
  const other = path.join(f.root, 'linked checkout');
  await git(f.checkout, 'worktree', 'add', '-b', 'parallel', other);
  const record = await f.registry.register(other);
  const config = await f.registry.readConfig(other);
  const first = await f.scan();
  const parallel = await scanSource(record.worktree, config, path.join(f.dataRoot, 'skills'));
  assert.equal(parallel.sourceVersion.treeHash, first.sourceVersion.treeHash);
  assert.equal(parallel.sourceScanRevision, first.sourceScanRevision);
  await writeFile(path.join(other, 'README.md'), 'parallel bytes\n');
  assert.notEqual((await scanSource(record.worktree, config, path.join(f.dataRoot, 'skills'))).sourceVersion.treeHash, first.sourceVersion.treeHash);
  assert.deepEqual((await f.scan()).sourceVersion, first.sourceVersion);
});

test('TC07 unborn Git worktrees have a null head with a valid raw source manifest', async (t) => {
  const f = await fixture(t);
  const root = path.join(f.root, 'unborn repository');
  await mkdir(root);
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'core.excludesfile', f.globalIgnore);
  await git(root, 'config', 'core.ignorecase', 'false');
  const initialized = await f.registry.init(root);
  await writeFile(path.join(root, 'new.ts'), 'new source\n');
  const scan = await scanSource(initialized.worktree, await f.registry.readConfig(root), path.join(f.dataRoot, 'skills'));
  assert.equal(scan.sourceVersion.head, null);
  assert.equal(scan.sourceVersion.status, 'dirty');
  assert.equal(scan.sourceVersion.treeHash, digest('source-manifest', scan.manifest.content));
});

test('TC12 source scans do not execute applied external Git filters; excluding the scope permits scanning', async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.root, 'filter-executed.marker');
  const script = path.join(f.root, 'filter command.mjs');
  await writeFile(script, `import { writeFileSync } from 'node:fs';\nconst chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); writeFileSync(${JSON.stringify(marker)}, 'executed'); process.stdout.write(Buffer.concat(chunks));\n`);
  const command = '"' + process.execPath.replaceAll('\\', '/') + '" "' + script.replaceAll('\\', '/') + '"';
  await git(f.checkout, 'config', 'filter.fixture.clean', command);
  await writeFile(path.join(f.checkout, '.gitattributes'), 'README.md filter=fixture\n');
  await writeFile(path.join(f.checkout, 'README.md'), 'filter setup probe\n');
  await git(f.checkout, 'add', 'README.md');
  assert.equal(await readFile(marker, 'utf8'), 'executed', 'Fixture proves native Git would execute this applied driver.');
  await rm(marker);
  await writeFile(path.join(f.checkout, 'README.md'), 'filter scans probe\n');
  const result = await f.scan();
  const executed = await readFile(marker, 'utf8').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  assert.equal(executed, null, 'Read-only source scanning must not invoke an external clean driver.');
  assert.equal(result.sourceVersion.status, 'unknown');
  assert.equal(result.sourceVersion.treeHash, null);
  assert.ok(result.diagnostics.some((item) => item.code === 'SOURCE_FILTER_UNSUPPORTED'));
  const config = await f.configure({ ...f.config, source: { excludePatterns: ['README.md'] } });
  const excluded = await f.scan(config);
  assert.notEqual(excluded.sourceVersion.status, 'unknown');
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('TC12 unused Git filter drivers do not reject ordinary source scans and autocrlf stays native', async (t) => {
  const f = await fixture(t);
  await git(f.checkout, 'config', 'filter.unused.clean', 'this-command-must-never-run');
  const initial = await f.scan();
  assert.equal(initial.sourceVersion.status, 'clean');
  await git(f.checkout, 'config', 'core.autocrlf', 'true');
  await writeFile(path.join(f.checkout, 'README.md'), 'Original bytes\r\n');
  const normalizedStatus = await f.scan();
  const native = (await git(f.checkout, 'status', '--porcelain', '--untracked-files=no', '--', 'README.md')).stdout;
  assert.equal(normalizedStatus.sourceVersion.status, native.trim() ? 'dirty' : 'clean');
  assert.equal(normalizedStatus.manifest.content.entries.find((entry) => entry.path === 'README.md').contentHash, sha256('Original bytes\r\n'));
});
