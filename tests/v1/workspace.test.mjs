import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, cp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile as callbackExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { WorkspaceRegistry } from '../../build/core/workspace.js';

const execFile = promisify(callbackExecFile);
const git = (root, ...args) => execFile('git', ['-C', root, ...args], { windowsHide: true });
const code = (expected) => (error) => error?.code === expected;

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'harnessl3-workspace-'));
  t.after(async () => {
    assert.ok(path.isAbsolute(root));
    assert.ok(path.basename(root).startsWith('harnessl3-workspace-'));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const dataRoot = path.join(root, 'machine data');
  const seedRoot = path.join(root, 'package seed');
  await mkdir(path.join(seedRoot, 'engineering', 'sample'), { recursive: true });
  await writeFile(path.join(seedRoot, 'engineering', 'sample', 'SKILL.md'), '---\nname: Sample\ndescription: Test method\n---\nOriginal body.\n');
  await writeFile(path.join(seedRoot, 'LICENSE'), 'test license\n');
  let count = 0;
  const repository = async (label = `repo-${++count}`) => {
    const location = path.join(root, label);
    await mkdir(location, { recursive: true });
    await git(location, 'init', '-b', 'main');
    await git(location, 'config', 'user.name', 'Harness Fixture');
    await git(location, 'config', 'user.email', 'fixture@example.invalid');
    await writeFile(path.join(location, 'README.md'), 'Workspace test fixture\n');
    await git(location, 'add', 'README.md');
    await git(location, 'commit', '-m', 'Fixture initial commit');
    return location;
  };
  return { root, dataRoot, seedRoot, repository, registry: () => new WorkspaceRegistry(dataRoot, { seedRoot }) };
}

test('TC03 init creates portable missing templates and a seed once; repeat preserves editable bytes', async (t) => {
  const f = await fixture(t);
  const location = await f.repository('Chinese \u4e2d\u6587 with spaces');
  const registry = f.registry();
  const first = await registry.init(location, 'Example SDK');
  assert.equal(first.project.name, 'Example SDK');
  assert.equal(first.skillSeed, 'created');
  assert.equal(first.worktree.projectId, first.project.id);
  assert.equal(first.worktree.available, true);
  assert.equal(first.worktree.active, true);
  assert.equal(first.paths.config, path.join(first.worktree.root, '.harness', 'project.json'));
  assert.ok(first.createdFiles.includes('.harness/project.json'));
  const config = JSON.parse(await readFile(first.paths.config, 'utf8'));
  assert.deepEqual(Object.keys(config).sort(), ['name', 'projectId', 'schemaVersion', 'source']);
  assert.equal(config.projectId, first.project.id);
  assert.deepEqual(config.source.excludePatterns, []);
  assert.deepEqual(JSON.parse(await readFile(path.join(location, '.harness', 'evidence.json'), 'utf8')), { schemaVersion: 1, evidence: [] });
  assert.deepEqual(JSON.parse(await readFile(path.join(location, '.harness', 'aliases.json'), 'utf8')), { schemaVersion: 1, aliases: {} });
  const modelFiles = await readdir(path.join(location, '.harness', 'model'));
  assert.ok(modelFiles.some((name) => /\.(?:c4|likec4)$/.test(name)));
  const model = path.join(location, '.harness', 'model', modelFiles.find((name) => /\.(?:c4|likec4)$/.test(name)));
  await writeFile(model, 'user-owned model bytes\n');
  await writeFile(path.join(f.dataRoot, 'skills', 'LICENSE'), 'user license edit\n');
  const repeated = await registry.init(location, 'Must not rename');
  assert.equal(repeated.project.id, first.project.id);
  assert.equal(repeated.worktree.id, first.worktree.id);
  assert.equal(repeated.project.name, 'Example SDK');
  assert.equal(repeated.skillSeed, 'already-present');
  assert.deepEqual(repeated.createdFiles, []);
  assert.equal(await readFile(model, 'utf8'), 'user-owned model bytes\n');
  assert.equal(await readFile(path.join(f.dataRoot, 'skills', 'LICENSE'), 'utf8'), 'user license edit\n');
  assert.equal((await f.registry().worktrees())[0].id, first.worktree.id);
});

test('TC03 an existing empty user skills directory is preserved; init never initializes a Git repository', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.dataRoot, 'skills'), { recursive: true });
  const location = await f.repository();
  assert.equal((await f.registry().init(location)).skillSeed, 'already-present');
  assert.deepEqual(await readdir(path.join(f.dataRoot, 'skills')), []);
  const nonGit = path.join(f.root, 'not a repository');
  await mkdir(nonGit);
  const plain = await f.registry().init(nonGit);
  assert.equal(plain.worktree.kind, 'directory');
  assert.equal(plain.worktree.gitCommonDir, null);
  assert.equal(plain.worktree.branch, null);
  await assert.rejects(readFile(path.join(nonGit, '.git')), { code: 'ENOENT' });
});

test('TC01 independent repositories with identical names retain independent IDs after restart and unregister', async (t) => {
  const f = await fixture(t);
  const a = await f.repository('a/project');
  const b = await f.repository('b/project');
  const first = await f.registry().init(a);
  const second = await f.registry().init(b);
  assert.notEqual(first.project.id, second.project.id);
  assert.notEqual(first.worktree.id, second.worktree.id);
  const registry = f.registry();
  assert.equal((await registry.projects()).length, 2);
  assert.equal((await registry.worktrees()).length, 2);
  const archive = path.join(f.dataRoot, 'worktrees', first.worktree.id, 'tasks', 'preserved.json');
  await mkdir(path.dirname(archive), { recursive: true });
  await writeFile(archive, 'immutable fixture history');
  const stopped = await registry.unregisterProject(first.project.id);
  assert.equal(stopped.archivesRetained, true);
  assert.ok(stopped.unregisteredIds.includes(first.project.id));
  assert.ok(stopped.unregisteredIds.includes(first.worktree.id));
  assert.equal((await registry.project(first.project.id)).active, false);
  assert.equal((await registry.worktree(first.worktree.id)).active, false);
  assert.equal((await registry.project(second.project.id)).active, true);
  assert.equal(await readFile(archive, 'utf8'), 'immutable fixture history');
  assert.equal(await readFile(path.join(a, 'README.md'), 'utf8'), 'Workspace test fixture\n');
});

test('TC02 existing linked worktrees share a project but have isolated stable UUIDs and strict explicit targets', async (t) => {
  const f = await fixture(t);
  const a = await f.repository('main checkout');
  const registry = f.registry();
  const first = await registry.init(a);
  await git(a, 'add', '.harness');
  await git(a, 'commit', '-m', 'Fixture managed model');
  const b = path.join(f.root, 'feature checkout');
  await git(a, 'worktree', 'add', '-b', 'feature', b);
  const second = await registry.register(b);
  assert.equal(second.project.id, first.project.id);
  assert.notEqual(second.worktree.id, first.worktree.id);
  assert.equal(second.worktree.gitCommonDir, first.worktree.gitCommonDir);
  assert.equal(second.worktree.branch, 'feature');
  assert.equal((await registry.register(path.join(b, '.harness'))).worktree.id, second.worktree.id);
  assert.equal((await registry.worktrees(first.project.id)).length, 2);
  assert.equal((await registry.resolve({ cwd: b })).id, second.worktree.id);
  await assert.rejects(registry.resolve({ cwd: a, worktreeId: second.worktree.id }), code('TARGET_CONFLICT'));
  await assert.rejects(registry.resolve({ cwd: a, projectId: first.project.id }), code('TARGET_REQUIRED'));
  assert.equal((await registry.resolve({ cwd: f.root, worktreeId: second.worktree.id })).id, second.worktree.id);
  await assert.rejects(registry.resolve({ cwd: f.root }), code('TARGET_REQUIRED'));
  const before = (await git(a, 'branch', '--show-current')).stdout.trim();
  await registry.unregisterWorktree(second.worktree.id);
  assert.equal((await git(a, 'branch', '--show-current')).stdout.trim(), before);
  assert.equal((await git(b, 'branch', '--show-current')).stdout.trim(), 'feature');
  const reactivated = await registry.register(b);
  assert.equal(reactivated.worktree.id, second.worktree.id);
});

test('TC22 explicit project/worktree ownership and UUIDs are validated without a last-active fallback', async (t) => {
  const f = await fixture(t);
  const a = await f.repository('a');
  const b = await f.repository('b');
  const registry = f.registry();
  const x = await registry.init(a);
  const y = await registry.init(b);
  await assert.rejects(registry.resolve({ cwd: f.root, projectId: x.project.id, worktreeId: y.worktree.id }), code('TARGET_CONFLICT'));
  await assert.rejects(registry.resolve({ cwd: a, projectId: y.project.id, worktreeId: y.worktree.id }), code('TARGET_CONFLICT'));
  await assert.rejects(registry.resolve({ cwd: f.root, projectId: x.project.id }), code('TARGET_REQUIRED'));
  await assert.rejects(registry.resolve({ cwd: a, worktreeId: 'invalid' }), code('INVALID_ARGUMENT'));
  await assert.rejects(registry.resolve({ cwd: f.root, worktreeId: randomUUID() }), code('NOT_FOUND'));
});

test('TC01 copied project IDs conflict across Git common directories; replaced roots cannot reuse identity', async (t) => {
  const f = await fixture(t);
  const a = await f.repository('original');
  const b = await f.repository('copied configuration');
  const registry = f.registry();
  const x = await registry.init(a);
  await cp(path.join(a, '.harness'), path.join(b, '.harness'), { recursive: true });
  await assert.rejects(registry.register(b), code('PROJECT_ID_CONFLICT'));
  const changed = JSON.parse(await readFile(x.paths.config, 'utf8'));
  changed.projectId = randomUUID();
  await writeFile(x.paths.config, JSON.stringify(changed));
  await assert.rejects(registry.resolve({ cwd: a }), code('WORKTREE_MOVED'));
  await assert.rejects(registry.register(a), code('WORKTREE_MOVED'));
});

test('TC01 inactive targets allow explicitly bound read-only history after their checkout disappears', async (t) => {
  const f = await fixture(t);
  const a = await f.repository();
  const registry = f.registry();
  const x = await registry.init(a);
  await registry.unregisterWorktree(x.worktree.id);
  await rm(a, { recursive: true });
  const historical = await registry.resolve({ cwd: f.root, worktreeId: x.worktree.id, allowInactive: true });
  assert.equal(historical.id, x.worktree.id);
  assert.equal(historical.active, false);
  assert.equal(historical.available, false);
  await assert.rejects(registry.resolve({ cwd: f.root, worktreeId: x.worktree.id }), code('TARGET_CONFLICT'));
  await assert.rejects(registry.resolve({ cwd: f.root, allowInactive: true }), code('TARGET_REQUIRED'));
});

test('TC03 data roots are disjoint from checkouts in either direction, including links and future directories', async (t) => {
  const f = await fixture(t);
  const a = await f.repository();
  await assert.rejects(new WorkspaceRegistry(path.join(a, 'future', 'data'), { seedRoot: f.seedRoot }).init(a), code('INVALID_ARGUMENT'));
  await assert.rejects(new WorkspaceRegistry(f.root, { seedRoot: f.seedRoot }).init(a), code('INVALID_ARGUMENT'));
  await assert.rejects(new WorkspaceRegistry(a, { seedRoot: f.seedRoot }).init(a), code('INVALID_ARGUMENT'));
  const linked = path.join(f.root, 'linked checkout');
  await symlink(a, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new WorkspaceRegistry(path.join(linked, 'future data'), { seedRoot: f.seedRoot }).init(a), code('INVALID_ARGUMENT'));
  assert.deepEqual((await readdir(a)).sort(), ['.git', 'README.md']);
});

test('TC03 project skill roots reject traversal, metadata, runtime overlap and escaping directory links', async (t) => {
  const f = await fixture(t);
  const a = await f.repository();
  const registry = f.registry();
  const x = await registry.init(a);
  const config = JSON.parse(await readFile(x.paths.config, 'utf8'));
  for (const root of ['../escape', '.harness', '.git', '/', '.', 'C:/escape', 'bad\\path']) {
    await writeFile(x.paths.config, JSON.stringify({ ...config, skills: { root } }));
    await assert.rejects(registry.register(a), (error) => ['INVALID_ARGUMENT', 'SCHEMA_INVALID'].includes(error?.code), root);
  }
  const external = path.join(f.root, 'external skill library');
  await mkdir(external);
  await symlink(external, path.join(a, 'linked-skills'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(x.paths.config, JSON.stringify({ ...config, skills: { root: 'linked-skills' } }));
  await assert.rejects(registry.register(a), code('INVALID_ARGUMENT'));
  await writeFile(x.paths.config, JSON.stringify({ ...config, skills: { root: 'project-skills' } }));
  assert.equal((await registry.register(a)).worktree.id, x.worktree.id);
  await assert.rejects(new WorkspaceRegistry(f.dataRoot, { skillsRoot: a, seedRoot: f.seedRoot }).register(a), code('INVALID_ARGUMENT'));
  await assert.rejects(new WorkspaceRegistry(f.dataRoot, { skillsRoot: path.join(f.dataRoot, 'worktrees'), seedRoot: f.seedRoot }).register(a), code('INVALID_ARGUMENT'));
});

test('TC03 managed metadata never follows an external .harness directory and invalid JSON remains untouched', async (t) => {
  const f = await fixture(t);
  const a = await f.repository();
  const external = path.join(f.root, 'external metadata');
  await mkdir(external);
  await symlink(external, path.join(a, '.harness'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.registry().init(a), code('INVALID_ARGUMENT'));
  assert.deepEqual(await readdir(external), []);
  await rm(path.join(a, '.harness'));
  await mkdir(path.join(a, '.harness'));
  const duplicate = '{"schemaVersion":1,"projectId":"' + randomUUID() + '","name":"First","name":"Second","source":{"excludePatterns":[]}}';
  const configPath = path.join(a, '.harness', 'project.json');
  await writeFile(configPath, duplicate);
  await assert.rejects(f.registry().init(a), code('INVALID_JSON'));
  assert.equal(await readFile(configPath, 'utf8'), duplicate);
});

test('TC01 concurrent registrations use a shared short atomic registry queue', async (t) => {
  const f = await fixture(t);
  const locations = await Promise.all([f.repository('one'), f.repository('two'), f.repository('three')]);
  const records = await Promise.all(locations.map((location) => f.registry().init(location)));
  assert.equal(new Set(records.map((item) => item.project.id)).size, 3);
  assert.equal((await f.registry().projects()).length, 3);
  assert.equal((await f.registry().worktrees()).length, 3);
  const parsed = JSON.parse(await readFile(path.join(f.dataRoot, 'registry.json'), 'utf8'));
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.projects.length, 3);
  assert.equal(parsed.worktrees.length, 3);
});

test('TC01 damaged registry records fail explicitly and do not get silently replaced', async (t) => {
  const f = await fixture(t);
  await mkdir(f.dataRoot, { recursive: true });
  const file = path.join(f.dataRoot, 'registry.json');
  const original = JSON.stringify({ schemaVersion: 1, projects: [{ id: randomUUID(), name: 'Broken', active: true }], worktrees: [] });
  await writeFile(file, original);
  await assert.rejects(f.registry().projects(), code('ARCHIVE_CORRUPT'));
  assert.equal(await readFile(file, 'utf8'), original);
});

test('TC01 registry reads and updates never follow a registry file link outside the data root', async (t) => {
  const f = await fixture(t);
  await mkdir(f.dataRoot, { recursive: true });
  const external = path.join(f.root, 'external-registry.json');
  const original = JSON.stringify({ schemaVersion: 1, projects: [], worktrees: [] });
  await writeFile(external, original);
  const file = path.join(f.dataRoot, 'registry.json');
  try { await symlink(external, file, 'file'); } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return t.skip('Windows file symlink privilege is unavailable; directory-junction guards are covered separately.');
    throw error;
  }
  await assert.rejects(f.registry().projects(), code('INVALID_ARGUMENT'));
  assert.equal(await readFile(external, 'utf8'), original);
});

test('TC02 init in an unconfigured linked worktree preserves the registered project UUID', async (t) => {
  const f = await fixture(t);
  const a = await f.repository('original checkout');
  const b = path.join(f.root, 'unconfigured linked checkout');
  await git(a, 'worktree', 'add', '-b', 'fresh', b);
  const registry = f.registry();
  const first = await registry.init(a, 'Original project name');
  const second = await registry.init(b);
  assert.equal(second.project.id, first.project.id);
  assert.equal(second.project.name, 'Original project name');
  assert.notEqual(second.worktree.id, first.worktree.id);
  assert.equal(JSON.parse(await readFile(second.paths.config, 'utf8')).projectId, first.project.id);
});

test('TC02 a different project ID in the same Git common directory is rejected rather than repaired', async (t) => {
  const f = await fixture(t);
  const a = await f.repository('original checkout');
  const registry = f.registry();
  const first = await registry.init(a);
  const b = path.join(f.root, 'unregistered linked checkout');
  await git(a, 'worktree', 'add', '-b', 'different', b);
  await cp(path.join(a, '.harness'), path.join(b, '.harness'), { recursive: true });
  const configPath = path.join(b, '.harness', 'project.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.projectId = randomUUID();
  const original = JSON.stringify(config);
  await writeFile(configPath, original);
  await assert.rejects(registry.register(b), code('PROJECT_ID_CONFLICT'));
  await assert.rejects(registry.init(b), code('PROJECT_ID_CONFLICT'));
  assert.equal(await readFile(configPath, 'utf8'), original);
  assert.equal((await registry.projects()).length, 1);
  assert.equal((await registry.worktrees()).length, 1);
  assert.equal((await registry.project(first.project.id)).id, first.project.id);
});

test('TC22 ambient Git override variables cannot redirect registration to another checkout', async (t) => {
  const f = await fixture(t);
  const a = await f.repository('requested checkout');
  const b = await f.repository('ambient checkout');
  const registry = f.registry();
  const first = await registry.init(a);
  const previous = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = path.join(b, '.git');
  process.env.GIT_WORK_TREE = b;
  try {
    assert.equal((await registry.register(a)).worktree.id, first.worktree.id);
    assert.equal((await registry.resolve({ cwd: a })).id, first.worktree.id);
    await assert.rejects(readFile(path.join(b, '.harness', 'project.json')), { code: 'ENOENT' });
  } finally {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('TC01 explicitly bound archived reads remain available when an active target loses current metadata', async (t) => {
  const f = await fixture(t);
  const a = await f.repository('archive owner');
  const b = await f.repository('another current checkout');
  const registry = f.registry();
  const first = await registry.init(a);
  await registry.init(b);
  await rm(first.paths.config);
  const archived = await registry.resolve({ cwd: f.root, worktreeId: first.worktree.id, allowInactive: true });
  assert.equal(archived.id, first.worktree.id);
  assert.equal(archived.projectId, first.project.id);
  assert.equal(archived.active, true);
  assert.equal(archived.available, false);
  await assert.rejects(registry.resolve({ cwd: f.root, worktreeId: first.worktree.id }), code('WORKTREE_MOVED'));
  await assert.rejects(registry.resolve({ cwd: a, allowInactive: true }), code('WORKTREE_MOVED'));
  await assert.rejects(registry.resolve({ cwd: b, worktreeId: first.worktree.id, allowInactive: true }), code('TARGET_CONFLICT'));
  await assert.rejects(readFile(first.paths.config), { code: 'ENOENT' });
});

test('TC02 identity preserves unborn and detached branches without borrowing an outer target for nested Git roots', async (t) => {
  const f = await fixture(t);
  const unborn = path.join(f.root, 'unborn');
  await mkdir(unborn);
  await git(unborn, 'init', '-b', 'unborn-main');
  const registry = f.registry();
  const first = await registry.init(unborn);
  assert.equal((await registry.resolve({ cwd: unborn })).branch, 'unborn-main');
  assert.equal(first.worktree.branch, 'unborn-main');

  const outer = await f.repository('outer');
  const registered = await registry.init(outer);
  await git(outer, 'checkout', '--detach');
  assert.equal((await registry.resolve({ cwd: outer })).branch, null);
  assert.equal((await registry.worktree(registered.worktree.id)).branch, null);

  const nested = path.join(outer, 'nested');
  await mkdir(nested);
  await git(nested, 'init', '-b', 'nested-main');
  await assert.rejects(registry.resolve({ cwd: nested }), code('TARGET_REQUIRED'));
  const nestedRegistration = await registry.init(nested);
  assert.notEqual(nestedRegistration.project.id, registered.project.id);
  await assert.rejects(registry.resolve({ cwd: nested, worktreeId: registered.worktree.id }), code('TARGET_CONFLICT'));
  assert.equal((await registry.resolve({ cwd: nested })).id, nestedRegistration.worktree.id);
});
