import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { fixture, execFile, binary } from './helpers.mjs'
import { WorkspaceRegistry } from '../../build/core/workspace.js'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const repairOptions = recovery => ({ repairProjectId: recovery.registeredProjectId, expectedConfigHash: recovery.configHash })
async function conflict(action) {
  let caught
  await assert.rejects(action, error => { caught = error; return error.code === 'PROJECT_ID_CONFLICT' })
  assert.equal(caught.details.recovery?.reason, 'same-git-common-dir')
  return caught.details.recovery
}

test('TC02 same-repository identity repair backs up exact bytes and preserves workspace isolation', async t => {
  const f = await fixture(t)
  const a = await f.repository('original')
  const other = await f.repository('independent clone')
  const registry = new WorkspaceRegistry(f.dataRoot)
  const first = await registry.init(a)
  const foreign = await registry.init(other)
  const otherBytes = await readFile(foreign.paths.config)
  const b = path.join(f.directory, 'linked checkout')
  await f.git(a, 'worktree', 'add', '-b', 'feature', b)
  await mkdir(path.join(b, '.harness'))
  const configPath = path.join(b, '.harness/project.json')
  const config = { ...JSON.parse(otherBytes), name: 'Worktree settings', source: { excludePatterns: ['generated/**'] }, skills: { root: 'methods' } }
  const original = Buffer.from(JSON.stringify(config, null, 4) + '\n')
  await writeFile(configPath, original)
  const registryBytes = await readFile(path.join(f.dataRoot, 'registry.json'))
  const recovery = await conflict(() => registry.register(b))
  await conflict(() => registry.init(b))
  assert.equal(recovery.registeredProjectId, first.project.id)
  assert.equal(recovery.configProjectId, foreign.project.id)
  assert.equal(recovery.configHash, hash(original))
  assert.deepEqual(await readFile(configPath), original)
  assert.deepEqual(await readFile(path.join(f.dataRoot, 'registry.json')), registryBytes)
  const repaired = await registry.register(b, repairOptions(recovery))
  assert.equal(repaired.project.id, first.project.id)
  assert.notEqual(repaired.worktree.id, first.worktree.id)
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), { ...config, projectId: first.project.id })
  assert.deepEqual(await readFile(repaired.identityRepair.backupPath), original)
  assert.equal(JSON.parse(await readFile(repaired.identityRepair.recordPath, 'utf8')).status, 'applied')
  assert.deepEqual(await readFile(foreign.paths.config), otherBytes)
  assert.equal((await registry.projects()).length, 2)
  assert.equal((await registry.register(b)).worktree.id, repaired.worktree.id)
  assert.equal((await new WorkspaceRegistry(f.dataRoot).resolve({ cwd: b })).id, repaired.worktree.id)
})

test('TC01/02 repair rejects independent repositories, stale configuration and wrong target IDs', async t => {
  const f = await fixture(t)
  const registry = new WorkspaceRegistry(f.dataRoot)
  const a = await f.repository('registered')
  const b = await f.repository('copied UUID')
  const first = await registry.init(a)
  await mkdir(path.join(b, '.harness'))
  const copied = await readFile(first.paths.config)
  await writeFile(path.join(b, '.harness/project.json'), copied)
  await assert.rejects(registry.register(b, { repairProjectId: first.project.id, expectedConfigHash: hash(copied) }), { code: 'PROJECT_ID_CONFLICT' })
  const poisoned = JSON.stringify({ ...JSON.parse(copied), projectId: randomUUID() })
  await writeFile(first.paths.config, poisoned)
  const recovery = await conflict(() => registry.resolve({ cwd: a }))
  await assert.rejects(registry.register(a, { ...repairOptions(recovery), repairProjectId: randomUUID() }), { code: 'PROJECT_ID_CONFLICT' })
  await writeFile(first.paths.config, poisoned + '\n')
  await assert.rejects(registry.register(a, repairOptions(recovery)), { code: 'VERSION_CONFLICT' })
  assert.equal(await readFile(first.paths.config, 'utf8'), poisoned + '\n')
  await assert.rejects(readdir(path.join(f.dataRoot, 'identity-repairs')), { code: 'ENOENT' })
})

test('TC02/22 CLI recovery preserves registered worktree UUID, old task bytes and restart behavior', async t => {
  const f = await fixture(t)
  const root = await f.repository('live checkout')
  const initial = await f.cli(['init'], { cwd: root })
  assert.equal(initial.code, 0, initial.stderr + initial.stdout)
  const { project, worktree, paths } = initial.body.data.result
  const start = await f.cli(['task', 'start', '--title', 'Original context'], { cwd: root })
  assert.equal(start.code, 0, start.stderr + start.stdout)
  const taskId = start.body.data.taskId
  const baseline = await f.cli(['sync', 'status'], { cwd: root })
  assert.equal(baseline.code, 0, baseline.stderr + baseline.stdout)
  const state = baseline.body.data.result
  const proof = { schemaVersion: 1, requestId: randomUUID(), target: initial.body.target, phaseId: randomUUID(), sourceEpoch: state.sourceEpoch,
    expectedSourceVersion: state.sourceVersion, expectedModelRevision: state.modelRevision, scope: { paths: ['README.md'], entities: [] },
    disposition: 'no-semantic-change', reason: 'Fixture source reviewed', checks: [{ name: 'fixture', status: 'passed', evidence: ['Fixture README inspected'] }] }
  const verified = await f.cli(['sync', 'verify', '--file', '-'], { cwd: root, input: JSON.stringify(proof) })
  assert.equal(verified.code, 0, verified.stderr + verified.stdout)
  assert.equal(verified.body.data.result.state, 'verified')
  const taskPath = path.join(f.dataRoot, 'worktrees', worktree.id, 'tasks', taskId + '.json')
  const history = await readFile(taskPath)
  const config = JSON.parse(await readFile(paths.config, 'utf8'))
  const original = JSON.stringify({ ...config, projectId: randomUUID() })
  await writeFile(paths.config, original)
  const blocked = await f.cli(['task', 'start', '--title', 'Blocked current context'], { cwd: root })
  assert.equal(blocked.code, 3, blocked.stderr + blocked.stdout)
  const recovery = blocked.body.error.details.recovery
  assert.equal(recovery?.registeredProjectId, project.id)
  const archived = await f.cli(['task', 'show', taskId, '--worktree', worktree.id], { cwd: root })
  assert.equal(archived.code, 0, archived.stderr + archived.stdout)
  const invalid = await f.cli(['worktree', 'register', root, '--repair-project-id', project.id], { cwd: root })
  assert.equal(invalid.code, 2)
  assert.equal((await f.cli(['serve', 'stop'])).code, 0)
  const repairedResponse = await execFile(process.execPath, [binary, ...recovery.command, '--json'], { cwd: root, windowsHide: true })
  const repaired = JSON.parse(repairedResponse.stdout)
  assert.equal(repaired.ok, true, repairedResponse.stderr + repairedResponse.stdout)
  assert.equal(repaired.data.result.worktree.id, worktree.id)
  assert.equal(await readFile(repaired.data.result.identityRepair.backupPath, 'utf8'), original)
  assert.deepEqual(await readFile(taskPath), history)
  assert.equal((await f.cli(['serve', 'stop'])).code, 0)
  const current = await f.cli(['task', 'start', '--title', 'Recovered current context'], { cwd: root })
  assert.equal(current.code, 0, current.stderr + current.stdout)
  assert.equal(current.body.data.binding.projectId, project.id)
  assert.equal(current.body.data.binding.worktreeId, worktree.id)
  const pending = await f.cli(['sync', 'status'], { cwd: root })
  assert.equal(pending.code, 0, pending.stderr + pending.stdout)
  assert.equal(pending.body.data.result.state, 'pending')
  assert.ok(pending.body.data.result.sourceEpoch > baseline.body.data.result.sourceEpoch)
  const stale = await f.cli(['sync', 'verify', '--file', '-'], { cwd: root, input: JSON.stringify({ ...proof, requestId: randomUUID() }) })
  assert.equal(stale.body.error?.code, 'SYNC_RACE', stale.stderr + stale.stdout)
  assert.deepEqual(await readFile(taskPath), history)
})

test('TC02 repair stops on failed backup and never overwrites current bytes', async t => {
  const f = await fixture(t)
  const registry = new WorkspaceRegistry(f.dataRoot)
  const root = await f.repository('guarded repair')
  const initial = await registry.init(root)
  const config = JSON.parse(await readFile(initial.paths.config, 'utf8'))
  const original = JSON.stringify({ ...config, projectId: randomUUID() })
  await writeFile(initial.paths.config, original)
  const recovery = await conflict(() => registry.register(root))
  const bytes = await readFile(path.join(f.dataRoot, 'registry.json'))
  await writeFile(path.join(f.dataRoot, 'identity-repairs'), 'blocked backup path')
  await assert.rejects(registry.register(root, repairOptions(recovery)))
  assert.equal(await readFile(initial.paths.config, 'utf8'), original)
  assert.deepEqual(await readFile(path.join(f.dataRoot, 'registry.json')), bytes)
})

test('TC02 repair rechecks configuration after durable invalidation before publishing', async t => {
  const f = await fixture(t)
  const registry = new WorkspaceRegistry(f.dataRoot)
  const root = await f.repository('concurrent edits')
  const initial = await registry.init(root)
  const config = JSON.parse(await readFile(initial.paths.config, 'utf8'))
  const original = JSON.stringify({ ...config, projectId: randomUUID() })
  await writeFile(initial.paths.config, original)
  const recovery = await conflict(() => registry.register(root))
  await assert.rejects(registry.register(root, { ...repairOptions(recovery), beforeIdentityRepair: async () => {
    await writeFile(initial.paths.config, original + '\n')
  } }), { code: 'VERSION_CONFLICT' })
  assert.equal(await readFile(initial.paths.config, 'utf8'), original + '\n')
  assert.equal((await registry.worktrees()).length, 1)
})
