import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile, writeFile, cp } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fixture, binary, execFile } from './helpers.mjs'
import { WorkspaceRegistry, gitRepositoryKey } from '../../build/core/workspace.js'

test('TC01 Git association normalizes equivalent transports without merging ports, case or unrelated origins', async () => {
  const root = process.cwd(), key = value => gitRepositoryKey(value, root)
  const expected = await key('git@EXAMPLE.invalid:Team/repo.git')
  assert.equal(expected, await key('https://user:password@example.invalid/Team/repo.git'))
  assert.equal(expected, await key('ssh://git@example.invalid:22/Team/repo'))
  for (const value of ['ssh://example.invalid:2/Team/repo', 'ssh://example.invalid:2222/Team/repo', 'https://example.invalid/team/repo', 'https://other.invalid/Team/repo']) assert.notEqual(await key(value), expected)
  assert.equal(await key('https://example.invalid/Team/repo?token=secret'), undefined)
  assert.equal(await key(''), undefined)
  assert.ok(!expected.includes('password') && !expected.includes('git@'))
})

test('TC01/27 a fresh machine registers committed context and starts a task without init or project writes', async t => {
  const f = await fixture(t), a = await f.repository('shared project')
  await f.git(a, 'remote', 'add', 'origin', 'git@example.invalid:team/project.git')
  const initialized = await f.cli(['init'], { cwd: a }); assert.equal(initialized.code, 0, initialized.stdout)
  await f.git(a, 'add', '.harness'); await f.git(a, 'commit', '-m', 'Shared context')
  const b = path.join(f.directory, 'new user clone')
  await execFile('git', ['clone', a, b], { windowsHide: true })
  await f.git(b, 'remote', 'set-url', 'origin', 'https://example.invalid/team/project.git')
  const before = await readFile(path.join(b, '.harness/project.json')), model = await readFile(path.join(b, '.harness/model/main.c4'))
  const dataRoot = path.join(f.directory, 'new machine state')
  const cli = async args => {
    const result = await execFile(process.execPath, [binary, ...args, '--data-dir', dataRoot, '--json'], { cwd: b, windowsHide: true, env: { ...process.env, HARNESS_SKILLS_ROOT: '', HARNESSL3_HOME: '' }, maxBuffer: 16 * 1024 * 1024 })
    const body = JSON.parse(result.stdout); assert.equal(body.ok, true, result.stdout); return body.data
  }
  try {
    const registered = await cli(['worktree', 'register', b])
    assert.equal(registered.result.worktree.projectId, initialized.body.data.result.project.id)
    const entry = await cli(['task', 'start', '--title', 'Use existing shared context'])
    assert.ok(entry.catalog.some(skill => skill.id === 'discovery/grill-me'))
    const selected = await cli(['task', 'select', entry.taskId])
    assert.equal(selected.status, 'complete')
    await cli(['task', 'handoff', entry.taskId])
    assert.deepEqual(await readFile(path.join(b, '.harness/project.json')), before)
    assert.deepEqual(await readFile(path.join(b, '.harness/model/main.c4')), model)
    assert.equal((await f.git(b, 'status', '--porcelain')).stdout.trim(), '')
    const legacyConfig = JSON.parse(before); legacyConfig.projectId = randomUUID()
    await writeFile(path.join(b, '.harness/project.json'), JSON.stringify(legacyConfig))
    await f.git(b, 'add', '.harness/project.json')
    await f.git(b, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Simulate a legacy shared ID change')
    const sharedBytes = await readFile(path.join(b, '.harness/project.json'))
    const associated = await cli(['worktree', 'register', b])
    assert.equal(associated.result.worktree.id, registered.result.worktree.id)
    assert.equal(associated.result.worktree.projectId, registered.result.worktree.projectId)
    assert.equal(associated.result.worktree.configProjectId, legacyConfig.projectId)
    const verified = await cli(['task', 'start', '--mode', 'verified', '--title', 'Read a locally associated legacy identity'])
    assert.equal(verified.binding.projectId, registered.result.worktree.projectId)
    assert.equal(verified.binding.sourceVersion.status, 'clean')
    await cli(['serve', 'stop'])
    assert.equal((await cli(['task', 'handoff', entry.taskId])).binding.projectId, registered.result.worktree.projectId)
    assert.deepEqual(await readFile(path.join(b, '.harness/project.json')), sharedBytes)
    assert.equal((await f.git(b, 'status', '--porcelain')).stdout.trim(), '')
  } finally { await cli(['serve', 'stop']).catch(() => {}) }
})

test('TC02 ordinary re-registration records a legacy ID locally and leaves shared branch files intact', async t => {
  const f = await fixture(t), a = await f.repository()
  await f.git(a, 'remote', 'add', 'origin', 'git@example.invalid:team/project.git')
  const registry = new WorkspaceRegistry(f.dataRoot), original = await registry.init(a)
  const file = path.join(a, '.harness/project.json'), originalBytes = await readFile(file)
  const changed = JSON.parse(originalBytes), alias = randomUUID(); changed.projectId = alias
  await writeFile(file, JSON.stringify(changed))
  const branchBytes = await readFile(file)
  const registered = await registry.register(a)
  assert.equal(registered.project.id, original.project.id)
  assert.equal(registered.worktree.id, original.worktree.id)
  assert.deepEqual(await readFile(file), branchBytes)
  assert.equal((await registry.resolve({ cwd: a })).id, original.worktree.id)
  await registry.skillsRoot(registered.worktree)
  assert.equal((await registry.project(alias)).id, original.project.id)
  assert.equal((await registry.worktrees(alias)).length, 1)
  await writeFile(file, originalBytes)
  assert.equal((await registry.resolve({ cwd: a })).id, original.worktree.id)
})

test('TC01 Git association refuses remote drift and UUID reuse by another repository without changing records', async t => {
  const f = await fixture(t), a = await f.repository(), b = await f.repository()
  await f.git(a, 'remote', 'add', 'origin', 'git@example.invalid:team/original.git')
  await f.git(b, 'remote', 'add', 'origin', 'git@example.invalid:team/fork.git')
  const registry = new WorkspaceRegistry(f.dataRoot), original = await registry.init(a)
  await cp(path.join(a, '.harness'), path.join(b, '.harness'), { recursive: true })
  const before = await readFile(path.join(f.dataRoot, 'registry.json'))
  await assert.rejects(registry.register(b), { code: 'PROJECT_ID_CONFLICT' })
  await f.git(a, 'remote', 'set-url', 'origin', 'git@example.invalid:team/fork.git')
  await assert.rejects(registry.register(a), { code: 'PROJECT_ID_CONFLICT' })
  assert.deepEqual(await readFile(path.join(f.dataRoot, 'registry.json')), before)
  assert.equal((await registry.worktree(original.worktree.id)).available, false)
})

test('TC01 grouped unregister retains legacy ownership and rejects aliases shared across unrelated repositories', async t => {
  const f = await fixture(t), a = await f.repository(), b = await f.repository()
  for (const root of [a, b]) await f.git(root, 'remote', 'add', 'origin', 'git@example.invalid:team/shared.git')
  const registry = new WorkspaceRegistry(f.dataRoot), first = await registry.init(a), second = await registry.init(b)
  const bytes = await Promise.all([a, b].map(root => readFile(path.join(root, '.harness/project.json'))))
  assert.equal((await new WorkspaceRegistry(f.dataRoot).projects()).length, 1)
  const result = await registry.unregisterProject(second.project.id)
  assert.deepEqual(new Set(result.unregisteredIds), new Set([first.project.id, second.project.id, first.worktree.id, second.worktree.id]))
  for (const item of [first, second]) {
    const old = await registry.resolve({ cwd: f.directory, worktreeId: item.worktree.id, allowInactive: true })
    assert.equal(old.projectId, item.project.id)
    assert.equal(old.active, false)
  }
  assert.deepEqual(await Promise.all([a, b].map(root => readFile(path.join(root, '.harness/project.json')))), bytes)
  const file = path.join(f.dataRoot, 'registry.json'), data = JSON.parse(await readFile(file))
  const alias = randomUUID()
  data.projects[0].configProjectIds = [alias]
  data.projects[1].configProjectIds = [alias]
  data.projects[1].gitRepository = 'network:other.invalid/team/shared'
  await writeFile(file, JSON.stringify(data))
  await assert.rejects(registry.projects(), { code: 'ARCHIVE_CORRUPT' })
})
