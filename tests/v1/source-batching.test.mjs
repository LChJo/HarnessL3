import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkspaceRegistry } from '../../build/core/workspace.js'
import { fixture, execFile } from './helpers.mjs'

const probeFile = fileURLToPath(new URL('./source-batch-probe.mjs', import.meta.url))
const sha = text => createHash('sha256').update(text).digest('hex')
async function setup(t) {
  const f = await fixture(t, 'harnessl3-source-batch-')
  const root = await f.repository('source Unicode paths')
  const seed = path.join(f.directory, 'seed')
  await mkdir(seed); await writeFile(path.join(seed, 'LICENSE'), 'Fixture seed\n')
  const registry = new WorkspaceRegistry(f.dataRoot, { seedRoot: seed })
  const registered = await registry.init(root, 'Batch fixture')
  const config = await registry.readConfig(root)
  const probe = async (mode = 'record', extra = {}) => {
    const file = path.join(f.directory, 'probe-' + mode + '.json')
    await writeFile(file, JSON.stringify({ worktree: registered.worktree, config, skillsRoot: path.join(f.dataRoot, 'skills'), mode, ...extra }))
    const result = await execFile(process.execPath, [probeFile, file], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
    return JSON.parse(result.stdout)
  }
  return { ...f, root, probe }
}

test('TC07/17 source queries batch wide Unicode trees with bounded stdin and unchanged inclusion', async t => {
  const f = await setup(t)
  await writeFile(path.join(f.root, '.gitignore'), '*.tmp\n')
  await mkdir(path.join(f.root, 'tracked'))
  const tracked = []
  for (let i = 0; i < 420; i++) {
    const relative = 'tracked/' + '源'.repeat(70) + '-' + i + '.txt'
    await writeFile(path.join(f.root, relative), 'tracked ' + i + '\n')
    tracked.push(relative)
  }
  await writeFile(path.join(f.root, 'tracked', 'kept.tmp'), 'Tracked despite ignore\n')
  await f.git(f.root, 'add', '-f', '--', 'tracked')
  const expected = ['README.md', '.gitignore', ...tracked, 'tracked/kept.tmp']
  for (let i = 0; i < 48; i++) {
    const directory = 'tree/dir-' + i
    await mkdir(path.join(f.root, directory), { recursive: true })
    await writeFile(path.join(f.root, directory, 'keep.txt'), 'untracked\n')
    await writeFile(path.join(f.root, directory, 'skip.tmp'), 'ignored\n')
    expected.push(directory + '/keep.txt')
  }
  const result = await f.probe()
  assert.notEqual(result.scan.sourceVersion.status, 'unknown', JSON.stringify(result.scan.diagnostics))
  const entries = result.scan.manifest.content.entries
  assert.deepEqual(entries.map(item => item.path), expected.sort())
  assert.equal(entries.find(item => item.path === tracked[0]).contentHash, sha('tracked 0\n'))
  assert.ok(result.commands.filter(item => item.command === 'check-ignore').length < 20, 'Do not start one Git ignore process per directory')
  assert.ok(result.commands.filter(item => item.command === 'check-attr').length <= 6, 'stdin queries should not use small argv chunks')
  assert.ok(result.commands.every(item => item.inputBytes <= 64 * 1024), 'Pending UTF-8 query bytes stay bounded')
})

for (const mode of ['write-once', 'write-always']) test('TC07 raw file mutation during capture remains detectable: ' + mode, async t => {
  const f = await setup(t)
  const result = await f.probe(mode)
  if (mode === 'write-once') {
    assert.equal(result.mutations, 1)
    assert.notEqual(result.scan.sourceVersion.status, 'unknown')
    assert.equal(result.scan.manifest.content.entries.find(item => item.path === 'README.md').contentHash, sha(await readFile(path.join(f.root, 'README.md'))))
  } else {
    assert.equal(result.mutations, 2, 'The existing retry remains bounded')
    assert.equal(result.scan.sourceVersion.status, 'unknown')
    assert.equal(result.scan.sourceVersion.treeHash, null)
    assert.equal(result.scan.manifest, null)
    assert.equal(result.scan.diagnostics[0].code, 'SOURCE_SCAN_RACE')
  }
})

test('TC07 ignore changes during directory classification cannot publish the old candidate set', async t => {
  const f = await setup(t)
  await writeFile(path.join(f.root, '.gitignore'), 'future/\n')
  await mkdir(path.join(f.root, 'future'))
  await writeFile(path.join(f.root, 'future', 'keep.txt'), 'Include after rule change\n')
  const result = await f.probe('ignore-change')
  assert.equal(result.mutations, 1)
  assert.notEqual(result.scan.sourceVersion.status, 'unknown')
  assert.ok(result.scan.manifest.content.entries.some(item => item.path === 'future/keep.txt'))
})

for (const mode of ['ancestor-link', 'pending-ancestor-link']) test('TC07 directory replacement remains unknown before Git or source descent: ' + mode, async t => {
  const f = await setup(t)
  await mkdir(path.join(f.root, 'tree'))
  await writeFile(path.join(f.root, 'tree', 'keep.txt'), 'Inside\n')
  await mkdir(path.join(f.root, 'z-sibling'))
  await writeFile(path.join(f.root, 'z-sibling', 'keep.txt'), 'Sibling\n')
  const outside = path.join(f.directory, 'outside')
  await mkdir(outside); await writeFile(path.join(outside, 'secret.txt'), 'Outside\n')
  const result = await f.probe(mode, { outside, savedTree: path.join(f.directory, 'saved-tree') })
  assert.equal(result.mutations, 1)
  assert.equal(result.scan.sourceVersion.status, 'unknown')
  assert.equal(result.scan.diagnostics[0].code, 'SOURCE_ANCESTOR_LINK')
  assert.equal(result.openedTreeFiles, 0)
  assert.equal(result.queriedLinkedDescendant, false)
})

test('TC07 failed Git stdin returns unknown without crashing the scanner process', async t => {
  const f = await setup(t)
  await writeFile(path.join(f.root, 'untracked.txt'), 'For ignore query\n')
  const result = await f.probe('pipe-error')
  assert.equal(result.pipeFailure, true)
  assert.equal(result.scan.sourceVersion.status, 'unknown')
  assert.equal(result.scan.sourceVersion.treeHash, null)
  assert.equal(result.scan.diagnostics[0].code, 'SOURCE_GIT_ERROR')
})
