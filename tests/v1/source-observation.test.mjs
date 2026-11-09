import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { writeFile, mkdir, symlink, realpath } from 'node:fs/promises'
import { fixture, execFile, projectRoot } from './helpers.mjs'
import { observeSourcePaths, scanSource } from '../../build/core/source.js'
import { WorkspaceRegistry } from '../../build/core/workspace.js'
import { sha256 } from '../../build/core/json.js'

test('TC07 incremental leaf observation reads only requested bytes and matches the full source entry', async t => {
  const f = await fixture(t, 'harness-v1-source-delta-')
  const root = await f.repository()
  const registry = new WorkspaceRegistry(f.dataRoot, { seedRoot: path.join(projectRoot, 'skills') })
  const initialized = await registry.init(root)
  for (let i = 0; i < 64; i++) await writeFile(path.join(root, `unchanged-${i}.ts`), 'Unchanged\n')
  await writeFile(path.join(root, 'README.md'), 'Modified bytes\n')
  const input = path.join(f.directory, 'request.json')
  await writeFile(input, JSON.stringify({ worktree: initialized.worktree, paths: ['README.md'] }))
  const { stdout } = await execFile(process.execPath, [path.join(projectRoot, 'tests/v1/source-observation-probe.mjs'), input], { windowsHide: true })
  const { result, opened } = JSON.parse(stdout)
  // The registered worktree root is canonical, so byte capture opens the
  // resolved path rather than the caller's native temp spelling.
  const observedRoot = initialized.worktree.root
  assert.deepEqual(opened, [path.join(observedRoot, 'README.md'), path.join(observedRoot, 'README.md')])
  assert.equal(result.requiresFullScan, false)
  assert.equal(result.sourceEpoch, 7)
  const scan = await scanSource(initialized.worktree, await registry.readConfig(root), await registry.skillsRoot(initialized.worktree))
  assert.deepEqual(result.entries, scan.manifest.content.entries.filter(entry => entry.path === 'README.md'))
})

test('TC07 incremental additions, deletion and byte rollback remain scoped observations', async t => {
  const f = await fixture(t, 'harness-v1-source-leaves-')
  const root = await f.repository()
  // Registered worktrees always carry canonical paths; native temp aliases
  // (macOS /var, Windows 8.3 names) must not change the observation result.
  const worktree = { root: await realpath(root) }
  const file = path.join(root, 'new.ts')
  await writeFile(file, 'A')
  const a = await observeSourcePaths(worktree, ['new.ts'], 1)
  await writeFile(file, 'B')
  const b = await observeSourcePaths(worktree, ['new.ts'], 2)
  await writeFile(file, 'A')
  const rollback = await observeSourcePaths(worktree, ['new.ts'], 3)
  assert.equal(a.entries[0].contentHash, sha256(Buffer.from('A')))
  assert.notEqual(a.entries[0].contentHash, b.entries[0].contentHash)
  assert.deepEqual(a.entries, rollback.entries)
  assert.equal(rollback.sourceEpoch, 3)
  assert.equal('sourceVersion' in rollback, false)
  const missing = await observeSourcePaths(worktree, ['absent.ts'], 4)
  assert.deepEqual(missing.entries, [{ path: 'absent.ts', entryKind: 'deleted', contentHash: null }])
  await mkdir(path.join(root, 'directory'))
  assert.equal((await observeSourcePaths(worktree, ['directory'], 5)).requiresFullScan, true)
})

test('TC07 changed paths behind an ancestor link never read outside the worktree', async t => {
  const f = await fixture(t, 'harness-v1-source-link-delta-')
  const root = await f.repository()
  const outside = path.join(f.directory, 'outside')
  await mkdir(outside)
  await writeFile(path.join(outside, 'private.ts'), 'Do not read')
  await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  const input = path.join(f.directory, 'request.json')
  await writeFile(input, JSON.stringify({ worktree: { root: await realpath(root) }, paths: ['linked/private.ts'] }))
  const { stdout } = await execFile(process.execPath, [path.join(projectRoot, 'tests/v1/source-observation-probe.mjs'), input], { windowsHide: true })
  const { result, opened } = JSON.parse(stdout)
  assert.deepEqual(opened, [])
  assert.deepEqual(result.entries, [])
  assert.equal(result.requiresFullScan, true)
  assert.equal(result.diagnostics[0].code, 'SOURCE_ANCESTOR_LINK')
})
