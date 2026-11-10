import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile, cp, rm, rmdir, symlink, realpath } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fixture, projectRoot, execFile } from './helpers.mjs'
import { WorkspaceRegistry, DIRECTORY_EXCLUDES } from '../../build/core/workspace.js'
import { scanSource, changedSourcePaths, isDirectoryPathIgnored } from '../../build/core/source.js'
import { sha256 } from '../../build/core/json.js'
import { validateContract } from '../../build/core/contract.js'
import { Runtime } from '../../build/core/runtime.js'

async function plain(t) {
  const f = await fixture(t, 'harness-v1-directory-')
  const root = path.join(f.directory, 'plain \u4e2d\u6587 project')
  await mkdir(root)
  const registry = new WorkspaceRegistry(f.dataRoot, { seedRoot: path.join(projectRoot, 'skills') })
  const registration = await registry.init(root)
  const scan = async () => scanSource(await registry.worktree(registration.worktree.id), await registry.readConfig(root), await registry.skillsRoot(await registry.worktree(registration.worktree.id)))
  return { ...f, root, registry, registration, scan }
}

test('TC01/03 directory identities, nearest boundaries, editable defaults and copy conflicts', async t => {
  const f = await plain(t)
  const { worktree, project } = f.registration
  assert.equal(worktree.kind, 'directory')
  assert.equal(project.kind, 'directory')
  assert.equal(project.gitCommonDir, null)
  assert.equal(worktree.branch, null)
  assert.deepEqual((await f.registry.readConfig(f.root)).source.excludePatterns, DIRECTORY_EXCLUDES)
  await mkdir(path.join(f.root, 'deep', 'child'), { recursive: true })
  assert.equal((await f.registry.resolve({ cwd: path.join(f.root, 'deep', 'child') })).id, worktree.id)
  const nested = path.join(f.root, 'nested')
  await mkdir(path.join(nested, '.harness'), { recursive: true })
  await writeFile(path.join(nested, '.harness', 'project.json'), JSON.stringify({ schemaVersion: 1, projectId: randomUUID(), name: 'nested', source: { excludePatterns: [] } }))
  // Onboarding reports the canonical boundary, which differs from a native
  // macOS /private alias or a Windows 8.3 temp spelling.
  const canonicalNested = await realpath(nested)
  await assert.rejects(f.registry.resolve({ cwd: nested }), error => error.code === 'TARGET_REQUIRED' && error.details.onboarding.worktreeRoot === canonicalNested)
  await assert.rejects(f.registry.resolve({ cwd: nested, worktreeId: worktree.id }), { code: 'TARGET_CONFLICT' })
  const registered = await f.registry.register(nested)
  assert.notEqual(registered.project.id, project.id)
  const copied = path.join(f.directory, 'copied')
  await cp(f.root, copied, { recursive: true })
  await assert.rejects(f.registry.register(copied), { code: 'PROJECT_ID_CONFLICT' })
  const config = await f.registry.readConfig(f.root)
  config.source.excludePatterns = []
  await writeFile(f.registration.paths.config, JSON.stringify(config))
  assert.deepEqual((await f.registry.init(f.root)).createdFiles, [])
  assert.deepEqual((await f.registry.readConfig(f.root)).source.excludePatterns, [])
  const restarted = new WorkspaceRegistry(f.dataRoot)
  assert.equal((await restarted.resolve({ cwd: f.root })).id, worktree.id)
  await assert.rejects(new WorkspaceRegistry(path.join(f.root, 'data')).init(f.root), { code: 'INVALID_ARGUMENT' })
})

test('TC07 directory scans apply hierarchical gitignore, negation, glob and directory rules consistently', async t => {
  const f = await plain(t)
  const put = async (file, contents = 'bytes') => { await mkdir(path.dirname(path.join(f.root, file)), { recursive: true }); await writeFile(path.join(f.root, file), contents) }
  await put('.gitignore', '*.log\n!keep.log\nblocked/\n!blocked/child.txt\nsub/*.tmp\n/root-only\n')
  await put('sub/.gitignore', '!keep.tmp\n*.bin\n!ok.bin\n')
  for (const name of ['a.log', 'keep.log', 'blocked/child.txt', 'sub/skip.tmp', 'sub/keep.tmp', 'sub/no.bin', 'root-only', 'sub/root-only', 'sub/ok.bin', 'node_modules/pkg/index.js', 'deep/.venv/x', 'dist/x', 'build/x']) await put(name)
  const binary = Buffer.from([0, 255, 1, 13, 10])
  await put('\u4e2d\u6587.bin', binary)
  await mkdir(path.join(f.root, 'empty'))
  const first = await f.scan()
  assert.equal(first.sourceVersion.status, 'unversioned', JSON.stringify(first.diagnostics))
  assert.equal(first.sourceVersion.head, null)
  assert.equal(first.policy.content.scannerVersion, 'directory-scanner/1')
  assert.equal(first.policy.content.candidateSet, 'filesystem')
  assert.equal(first.policy.content.gitIgnoreMode, 'directory-files')
  validateContract('workspace', f.registration.worktree)
  validateContract('source-policy', first.policy)
  assert.throws(() => validateContract('workspace', { ...f.registration.worktree, branch: 'main' }), { code: 'SCHEMA_INVALID' })
  assert.throws(() => validateContract('source-policy', { ...first.policy, content: { ...first.policy.content, gitIgnoreMode: 'untracked-only' } }), { code: 'SCHEMA_INVALID' })
  assert.deepEqual(first.manifest.content.entries.map(item => item.path), ['.gitignore', 'keep.log', 'sub/.gitignore', 'sub/keep.tmp', 'sub/ok.bin', 'sub/root-only', '\u4e2d\u6587.bin'].sort())
  assert.equal(first.manifest.content.entries.find(item => item.path === '\u4e2d\u6587.bin').contentHash, sha256(binary))
  assert.deepEqual(first.ignoreRules.content.sources.map(item => item.path), ['.gitignore', 'sub/.gitignore'])
  for (const [name, directory, expected] of [['a.log', false, true], ['keep.log', false, false], ['blocked', true, true], ['blocked/new.txt', false, true], ['sub/new.tmp', false, true], ['sub/keep.tmp', false, false], ['new.log', false, true]]) assert.equal(await isDirectoryPathIgnored(f.root, name, directory), expected, name)
  const config = await f.registry.readConfig(f.root)
  config.source.excludePatterns = config.source.excludePatterns.filter(item => item !== '**/dist')
  await writeFile(f.registration.paths.config, JSON.stringify(config))
  const next = await f.scan()
  assert.ok(next.manifest.content.entries.some(item => item.path === 'dist/x'))
  assert.notEqual(next.sourceScanRevision, first.sourceScanRevision)
  await put('new.txt')
  await rm(path.join(f.root, 'keep.log'))
  await put('\u4e2d\u6587.bin', 'edited')
  const changed = await f.scan()
  assert.deepEqual(changedSourcePaths(next, changed), ['keep.log', 'new.txt', '\u4e2d\u6587.bin'])
  await put('sub/.gitignore', '!keep.tmp\n*.bin\n!ok.bin\n# changed rules\n')
  assert.notEqual((await f.scan()).sourceScanRevision, changed.sourceScanRevision)
})

test('TC02/07 directory scans diagnose nested repositories/projects and never follow junctions', async t => {
  const f = await plain(t)
  const outside = path.join(f.directory, 'outside')
  await mkdir(outside)
  await writeFile(path.join(outside, 'secret.txt'), 'outside content')
  await symlink(outside, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  const links = await f.scan()
  assert.equal(links.sourceVersion.status, 'unversioned')
  assert.deepEqual(links.manifest.content.entries.map(item => [item.path, item.entryKind]), [['linked', 'symlink']])
  const nested = path.join(f.root, 'nested')
  await mkdir(path.join(nested, '.git'), { recursive: true })
  let failed = await f.scan()
  assert.equal(failed.sourceVersion.status, 'unknown')
  assert.equal(failed.diagnostics[0].code, 'SOURCE_NESTED_REPOSITORY')
  await assert.rejects(f.registry.resolve({ cwd: nested }), { code: 'INVALID_ARGUMENT' })
  await rmdir(path.join(nested, '.git'))
  await mkdir(path.join(nested, '.harness'))
  await writeFile(path.join(nested, '.harness', 'project.json'), '{}')
  failed = await f.scan()
  assert.equal(failed.diagnostics[0].code, 'SOURCE_NESTED_PROJECT')
  const config = await f.registry.readConfig(f.root)
  config.source.excludePatterns.push('nested')
  await writeFile(f.registration.paths.config, JSON.stringify(config))
  assert.equal((await f.scan()).sourceVersion.status, 'unversioned')
})

test('TC07 repeated byte/enumeration races and unreadable files never produce a complete directory fingerprint', async t => {
  const f = await plain(t)
  await writeFile(path.join(f.root, 'changing.txt'), 'A')
  const input = path.join(f.directory, 'probe.json')
  await writeFile(input, JSON.stringify({ worktree: f.registration.worktree, config: await f.registry.readConfig(f.root), skillsRoot: await f.registry.skillsRoot(f.registration.worktree) }))
  for (const mode of ['bytes', 'enumeration', 'rules', 'late-rule', 'unreadable']) {
    const { stdout } = await execFile(process.execPath, [path.join(projectRoot, 'tests/v1/directory-scan-probe.mjs'), input, mode], { windowsHide: true })
    const scan = JSON.parse(stdout)
    assert.equal(scan.sourceVersion.status, 'unknown', mode)
    assert.equal(scan.sourceVersion.treeHash, null)
    assert.equal(scan.manifest, null)
    assert.equal(scan.diagnostics[0].code, mode === 'unreadable' ? 'SOURCE_SCAN_UNAVAILABLE' : 'SOURCE_SCAN_RACE')
  }
})

test('TC01/03/07/08/21 directory CLI lifecycle runs with no Git in PATH and upgrades in the same service', async t => {
  const f = await fixture(t, 'harness-v1-directory-cli-')
  const root = path.join(f.directory, 'plain project')
  await mkdir(path.join(root, 'child'), { recursive: true })
  await writeFile(path.join(root, 'README.md'), 'Directory project')
  const call = async (args, options = {}) => {
    const result = await f.cli(args, { cwd: root, env: { PATH: '' }, ...options })
    return result
  }
  const initialized = await call(['init'])
  assert.equal(initialized.code, 0, initialized.stdout + initialized.stderr)
  const target = initialized.body.target
  const entry = await call(['task', 'start', '--title', 'No Git lifecycle'], { cwd: path.join(root, 'child') })
  assert.equal(entry.code, 0, entry.stdout)
  assert.equal(entry.body.data.binding.sourceVersion.status, 'unversioned')
  assert.match(entry.body.data.routingPrompt, /Back up/)
  const skill = entry.body.data.catalog.find(item => item.id === 'development/implement')
  const selected = await call(['task', 'select', entry.body.data.taskId, '--file', '-'], { input: JSON.stringify({ schemaVersion: 1, requestId: randomUUID(), binding: entry.body.data.binding, context: { expand: [], read: [entry.body.data.directory.items[0].id], known: {} }, skills: [{ id: skill.id, reason: 'Implement directory support' }] }) })
  assert.equal(selected.code, 0, selected.stdout)
  const read = await call(['task', 'read', entry.body.data.taskId, '--file', '-'], { input: JSON.stringify({ schemaVersion: 1, requestId: randomUUID(), files: [{ skillId: skill.id, path: 'SKILL.md', expectedHash: skill.files.find(item => item.path === 'SKILL.md').hash }] }) })
  assert.equal(read.code, 0, read.stdout)
  const state = (await call(['sync', 'status'])).body.data.result
  const proof = { schemaVersion: 1, requestId: randomUUID(), target, phaseId: randomUUID(), sourceEpoch: state.sourceEpoch, expectedSourceVersion: state.sourceVersion, expectedModelRevision: state.modelRevision, scope: { paths: ['README.md'], entities: [] }, disposition: 'no-semantic-change', reason: 'Reviewed fixture bytes', checks: [{ name: 'Fixture review', status: 'passed', evidence: ['README.md'] }] }
  const verified = await call(['sync', 'verify', '--file', '-'], { input: JSON.stringify(proof) })
  assert.equal(verified.code, 0, verified.stdout)
  assert.equal(verified.body.data.result.state, 'verified')
  await writeFile(path.join(root, 'README.md'), 'Changed')
  const change = (await call(['sync', 'status'])).body.data.result
  await writeFile(path.join(root, 'README.md'), 'Directory project')
  const rollback = (await call(['sync', 'status'])).body.data.result
  assert.ok(rollback.sourceEpoch > change.sourceEpoch)
  assert.deepEqual(rollback.sourceVersion, state.sourceVersion)
  const stale = await call(['sync', 'verify', '--file', '-'], { input: JSON.stringify({ ...proof, requestId: randomUUID() }) })
  assert.equal(stale.body.error.code, 'SYNC_RACE')
  const handoff = await call(['task', 'handoff', entry.body.data.taskId])
  assert.equal(handoff.code, 0, handoff.stdout)
  assert.equal((await call(['serve', 'stop'])).code, 0)
  const restored = await call(['task', 'handoff', entry.body.data.taskId])
  assert.deepEqual(restored.body.data, handoff.body.data)
  assert.equal((await call(['history', 'list'])).code, 0)
  // Restart once with Git available, then convert while this same service is alive.
  await call(['serve', 'stop'])
  assert.equal((await f.cli(['sync', 'status'], { cwd: root })).code, 0)
  const before = (await f.cli(['serve', 'status'])).body.data.result.instanceId
  await f.git(root, 'init', '-b', 'main')
  const upgraded = await f.cli(['task', 'start', '--title', 'After git init'], { cwd: root })
  assert.equal(upgraded.code, 0, upgraded.stdout)
  assert.deepEqual(upgraded.body.target, target)
  assert.notEqual(upgraded.body.data.binding.sourceScanRevision, entry.body.data.binding.sourceScanRevision)
  assert.equal(upgraded.body.data.binding.sourceVersion.status, 'dirty')
  assert.equal((await f.cli(['serve', 'status'])).body.data.result.instanceId, before)
  const gitState = (await f.cli(['sync', 'status'], { cwd: root })).body.data.result
  assert.equal(gitState.state, 'pending')
  assert.ok(gitState.sourceEpoch > rollback.sourceEpoch)
  const preGitProof = await f.cli(['sync', 'verify', '--file', '-'], { cwd: root, input: JSON.stringify({ ...proof, requestId: randomUUID() }) })
  assert.equal(preGitProof.body.error.code, 'SYNC_RACE')
  const oldQuery = await f.cli(['context', 'query', entry.body.data.taskId, '--file', '-'], { cwd: root, input: JSON.stringify({ schemaVersion: 1, requestId: randomUUID(), expectedModelRevision: entry.body.data.binding.modelRevision, expand: [], read: [entry.body.data.directory.items[0].id], known: {} }) })
  assert.equal(oldQuery.body.error.code, 'SOURCE_CHANGED')
  const current = await f.cli(['worktree', 'list'])
  assert.equal(current.body.data.result.items[0].kind, 'git')
  assert.deepEqual((await f.cli(['task', 'handoff', entry.body.data.taskId], { cwd: root })).body.data, handoff.body.data)
  await f.cli(['serve', 'stop'])
  const afterRestart = await f.cli(['worktree', 'list'])
  assert.equal(afterRestart.body.data.result.items[0].id, target.worktreeId)
  assert.equal(afterRestart.body.data.result.items[0].kind, 'git')
  await f.cli(['serve', 'stop'])
  const missingGit = await call(['sync', 'status'])
  assert.equal(missingGit.body.ok, false)
  assert.equal((await call(['worktree', 'list'])).body.data.result.items[0].kind, 'git')
  const archivedWithoutGit = await call(['task', 'handoff', entry.body.data.taskId, '--worktree', target.worktreeId])
  assert.equal(archivedWithoutGit.code, 0, archivedWithoutGit.stdout)
  assert.deepEqual(archivedWithoutGit.body.data, handoff.body.data)
})

test('TC01/07 runtime adopts Git without replacing resources or treating a retained proof as current', async t => {
  const f = await plain(t)
  await writeFile(path.join(f.root, 'README.md'), 'Adoption fixture')
  const runtime = new Runtime(f.dataRoot)
  try {
    const resource = await runtime.worktreeResources(f.registration.worktree)
    const skills = await f.registry.skillsRoot(f.registration.worktree)
    const before = await resource.freshness.status(skills)
    await f.git(f.root, 'init', '-b', 'main')
    const adopted = await f.registry.worktree(f.registration.worktree.id)
    assert.equal(adopted.kind, 'git')
    const original = resource.freshness.status
    resource.freshness.status = () => { throw new Error('Navigation must not start a full scan') }
    assert.equal(await runtime.worktreeResources(adopted), resource)
    resource.freshness.status = original
    assert.equal(resource.worktree.kind, 'git')
    assert.equal(resource.freshness.currentState().state, 'pending')
    assert.equal(resource.freshness.currentState().scanPending, true)
    assert.ok(resource.freshness.currentState().sourceEpoch > before.sourceEpoch)
    const adoptedScan = await resource.freshness.status(skills)
    assert.equal(adoptedScan.sourceVersion.status, 'dirty', JSON.stringify(adoptedScan.diagnostics))
    const registryFile = path.join(f.dataRoot, 'registry.json')
    const registry = JSON.parse(await readFile(registryFile, 'utf8'))
    for (const item of [...registry.projects, ...registry.worktrees]) delete item.kind
    await writeFile(registryFile, JSON.stringify(registry))
    const legacyBytes = await readFile(registryFile)
    assert.equal((await new WorkspaceRegistry(f.dataRoot).worktree(adopted.id)).kind, 'git')
    assert.deepEqual(await readFile(registryFile), legacyBytes, 'Reading old registrations cannot rewrite them')
  } finally { await runtime.close() }
})

test('TC07 directory watcher classifies new paths with the scan rules and excluded rule files still invalidate policy', async t => {
  const f = await plain(t)
  await writeFile(path.join(f.root, '.gitignore'), '*.log\n!keep.log\nignored/\n')
  const config = await f.registry.readConfig(f.root)
  config.source.excludePatterns.push('.gitignore')
  await writeFile(f.registration.paths.config, JSON.stringify(config))
  const runtime = new Runtime(f.dataRoot)
  try {
    const resource = await runtime.worktreeResources(f.registration.worktree)
    const skills = await f.registry.skillsRoot(f.registration.worktree)
    await resource.freshness.status(skills)
    // Feed deterministic native notifications; background scheduling and OS duplicate events are excluded from this seam.
    resource.freshness.watcher?.close()
    clearInterval(resource.freshness.timer)
    clearTimeout(resource.freshness.debounce)
    t.mock.method(resource.freshness, 'schedule', () => {})
    const epoch = resource.freshness.currentState().sourceEpoch
    await resource.freshness.classifyNewPath('new.log')
    assert.equal(resource.freshness.currentState().sourceEpoch, epoch)
    await mkdir(path.join(f.root, 'ignored'))
    await resource.freshness.classifyNewPath('ignored')
    assert.equal(resource.freshness.currentState().sourceEpoch, epoch)
    await writeFile(path.join(f.root, 'keep.log'), 'included')
    await resource.freshness.classifyNewPath('keep.log')
    assert.ok(resource.freshness.currentState().sourceEpoch > epoch)
    assert.equal(resource.freshness.currentState().state, 'pending')
    const beforeRules = await resource.freshness.status(skills)
    resource.freshness.watchEvent('.gitignore')
    assert.ok(resource.freshness.currentState().sourceEpoch > beforeRules.sourceEpoch)
    assert.equal(resource.freshness.fullRequired, true)
  } finally { await runtime.close() }
})
