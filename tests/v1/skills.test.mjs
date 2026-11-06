import test from 'node:test'
import assert from 'node:assert/strict'
import fsPromises, { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm, lstat, realpath } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFile as callbackExecFile } from 'node:child_process'
import { promisify } from 'node:util'
import { scanSkills, captureSkills, seedSkills } from '../../build/core/skills.js'
import { WorkspaceRegistry } from '../../build/core/workspace.js'

const hash = value => createHash('sha256').update(value).digest('hex')
const execFile = promisify(callbackExecFile)
const body = (name, description = 'Choose a limited method', related = '') => `---\nname: ${name}\ndescription: ${description}\n${related}---\n# ${name}\nSecret method body; never execute this file.\n`
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'harness-v1-skills-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
async function skill(root, id, content, files = {}) {
  await mkdir(join(root, id), { recursive: true })
  await writeFile(join(root, id, 'SKILL.md'), content)
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(join(root, id, path, '..'), { recursive: true })
    await writeFile(join(root, id, path), bytes)
  }
}

test('catalog derives group/name/file references from the same captured raw bytes', async t => {
  const root = await fixture(t)
  const raw = Buffer.from(body('method', 'First description').replaceAll('\n', '\r\n'))
  await skill(root, 'quality/folder', raw, { 'references/extra.md': 'Attachment body', 'sample.bin': Buffer.from([0xff, 0, 0x7f]) })
  const catalog = await scanSkills(root)
  assert.equal(catalog.valid, true)
  assert.match(catalog.revision, /^[a-f0-9]{64}$/)
  assert.equal(catalog.skills.length, 1)
  const brief = catalog.skills[0]
  assert.equal(brief.id, 'quality/folder')
  assert.equal(brief.name, 'method', 'metadata display name is separate from directory identity')
  assert.equal(brief.group, 'quality')
  assert.equal(brief.description, 'First description')
  assert.equal(brief.files.find(file => file.path === 'SKILL.md').hash, hash(raw))
  assert.equal(brief.files.find(file => file.path === 'sample.bin').encoding, 'base64')
  assert.equal(brief.files.find(file => file.path === 'references/extra.md').encoding, 'utf8')
  assert.ok(!JSON.stringify(catalog).includes('Secret method body'))
  assert.ok(!JSON.stringify(catalog).includes('Attachment body'))
  assert.deepEqual(catalog.files.get('quality/folder/SKILL.md'), raw)
  await writeFile(join(root, 'quality/folder/SKILL.md'), body('method', 'Second description'))
  assert.equal(brief.description, 'First description', 'existing capture stays immutable while files change')
  const changed = await scanSkills(root)
  assert.equal(changed.skills[0].description, 'Second description')
  assert.notEqual(changed.revision, catalog.revision)
})

test('one capture selects only explicit methods and retains exact files by hash', async t => {
  const root = await fixture(t)
  await skill(root, 'quality/debug', body('debug', 'Diagnose', 'related:\n  - ../review/SKILL.md\n'), { 'helper.sh': 'echo MUST_NOT_RUN' })
  await skill(root, 'quality/review', body('review'))
  const catalog = await scanSkills(root)
  const captured = captureSkills(catalog, [{ id: 'quality/debug', reason: 'Inspect the actual failure' }])
  assert.deepEqual(captured.skills.map(item => item.id), ['quality/debug'])
  assert.equal(captured.skills[0].reason, 'Inspect the actual failure')
  assert.equal(captured.blobs.size, 2)
  for (const file of captured.skills[0].files) assert.equal(hash(captured.blobs.get(file.hash)), file.hash)
  assert.ok(!('related' in captured.skills[0]))
  assert.ok(!('diagnostics' in captured.skills[0]))
  assert.deepEqual(captureSkills(catalog, []), { skills: [], blobs: new Map() })
})

test('missing related methods diagnose without automatically selecting or invalidating valid files', async t => {
  const root = await fixture(t)
  await skill(root, 'quality/debug', body('debug', 'Diagnose', 'related:\n  - ../missing/SKILL.md\n  - ../../../../outside/SKILL.md\n'))
  const catalog = await scanSkills(root)
  assert.equal(catalog.valid, true)
  assert.deepEqual(catalog.skills[0].related, [])
  assert.equal(catalog.skills[0].diagnostics.length, 2)
  assert.equal(catalog.diagnostics.length, 2)
})

test('actual library includes 7 categories and 21 editable methods without built-in router files', async () => {
  const catalog = await scanSkills(resolve('skills'))
  assert.equal(catalog.valid, true, JSON.stringify(catalog.diagnostics))
  assert.equal(catalog.skills.length, 21)
  assert.equal(new Set(catalog.skills.map(item => item.group)).size, 7)
  assert.ok(catalog.skills.every(item => !['ask-matt', 'skill-hub', 'grill-me'].includes(item.name)))
  assert.ok(catalog.skills.find(item => item.id === 'quality/tdd').files.some(file => file.path === 'tests.md'))
})

test('empty existing root is a valid empty catalog and missing root is invalid', async t => {
  const root = await fixture(t)
  const empty = await scanSkills(root)
  assert.equal(empty.valid, true)
  assert.deepEqual(empty.skills, [])
  assert.match(empty.revision, /^[a-f0-9]{64}$/)
  const missing = await scanSkills(join(root, 'absent'))
  assert.equal(missing.valid, false)
  assert.equal(missing.revision, null)
  assert.deepEqual(missing.skills, [])
})

for (const [name, content] of [
  ['missing frontmatter', '# Plain document'],
  ['missing description', '---\nname: debug\n---\n'],
  ['duplicate keys', '---\nname: debug\nname: other\ndescription: text\n---\n'],
  ['invalid related shape', body('debug', 'text', 'related: wrong\n')],
  ['reserved name', body('skill-hub')],
  ['invalid utf8', Buffer.from([0xff])],
]) {
  test(`invalid skill ${name} clears all current candidates with diagnostics`, async t => {
    const root = await fixture(t)
    await skill(root, 'quality/good', body('good'))
    await skill(root, 'quality/bad', content)
    const catalog = await scanSkills(root)
    assert.equal(catalog.valid, false)
    assert.equal(catalog.revision, null)
    assert.deepEqual(catalog.skills, [])
    assert.ok(catalog.diagnostics.length)
    assert.throws(() => captureSkills(catalog, []), { code: 'CATALOG_INVALID' })
  })
}

test('duplicate display names are diagnosed rather than silently shadowing candidates', async t => {
  const root = await fixture(t)
  await skill(root, 'quality/one', body('same'))
  await skill(root, 'planning/two', body('same'))
  assert.equal((await scanSkills(root)).valid, false)
})

test('capture rejects unknown IDs, repeated IDs and empty reasons before freezing bytes', async t => {
  const root = await fixture(t)
  await skill(root, 'quality/debug', body('debug'))
  const catalog = await scanSkills(root)
  assert.throws(() => captureSkills(catalog, [{ id: 'quality/missing', reason: 'x' }]), { code: 'INVALID_ARGUMENT' })
  assert.throws(() => captureSkills(catalog, [{ id: 'quality/debug', reason: 'x' }, { id: 'quality/debug', reason: 'other' }]), { code: 'INVALID_ARGUMENT' })
  assert.throws(() => captureSkills(catalog, [{ id: 'quality/debug', reason: ' ' }]), { code: 'INVALID_ARGUMENT' })
})

test('hidden attachments participate in byte fingerprint and file ordering is code-unit stable', async t => {
  const root = await fixture(t)
  await skill(root, 'quality/debug', body('debug'), { '.reference': 'first', 'Z.md': 'Z', 'a.md': 'a' })
  const first = await scanSkills(root)
  assert.deepEqual(first.skills[0].files.map(file => file.path), ['.reference', 'SKILL.md', 'Z.md', 'a.md'])
  await writeFile(join(root, 'quality/debug/.reference'), 'second')
  assert.notEqual((await scanSkills(root)).revision, first.revision)
})

test('unsafe attachment names or symbolic links never escape root', async t => {
  const root = await fixture(t)
  const outside = await fixture(t)
  await skill(root, 'quality/debug', body('debug'))
  await writeFile(join(outside, 'secret.txt'), 'outside secret')
  try { await symlink(join(outside, 'secret.txt'), join(root, 'quality/debug/escape.txt')) }
  catch (error) { if (error.code === 'EPERM') return t.skip('OS does not grant symlink creation'); throw error }
  const catalog = await scanSkills(root)
  assert.equal(catalog.valid, false)
  assert.ok(catalog.diagnostics.some(item => /link|boundary|outside/i.test(item.message)))
  assert.equal(catalog.files.size, 0)
})

test('seed publishes all original files once and preserves any existing directory, including empty', async t => {
  const root = await fixture(t)
  const target = join(root, 'new-library')
  assert.equal(await seedSkills(resolve('skills'), target), 'created')
  assert.equal((await lstat(target)).isSymbolicLink(), true)
  const physical = await realpath(target)
  assert.equal(dirname(physical), await realpath(root))
  assert.match(basename(physical), /^\.new-library-library-[0-9a-f-]{36}$/)
  assert.equal((await scanSkills(target)).skills.length, 21)
  assert.deepEqual(await readFile(join(target, 'LICENSE')), await readFile(resolve('skills/LICENSE')))
  await writeFile(join(target, 'quality/tdd/SKILL.md'), 'user edits')
  assert.equal(await seedSkills(resolve('skills'), target), 'already-present')
  assert.equal(await readFile(join(target, 'quality/tdd/SKILL.md'), 'utf8'), 'user edits')
  const empty = join(root, 'empty')
  await mkdir(empty)
  assert.equal(await seedSkills(resolve('skills'), empty), 'already-present')
  assert.deepEqual(await readdir(empty), [])
})

test('concurrent seed publication leaves one complete seed and no partially merged library', async t => {
  const root = await fixture(t)
  const target = join(root, 'seeded')
  const result = await Promise.all([seedSkills(resolve('skills'), target), seedSkills(resolve('skills'), target)])
  assert.deepEqual(result.sort(), ['already-present', 'created'])
  assert.equal((await scanSkills(target)).skills.length, 21)
  assert.deepEqual((await readdir(root)).sort(), [basename(await realpath(target)), 'seeded'].sort())
})

test('seed errors leave no incomplete destination and a verified dead owner can recover', async t => {
  const root = await fixture(t)
  const target = join(root, 'seeded')
  await assert.rejects(seedSkills(join(root, 'missing-seed'), target))
  assert.deepEqual(await readdir(root), [])
  const lock = join(root, '.seeded.seed-lock')
  await mkdir(lock)
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ version: 1, token: randomUUID(), pid: 2147483647, target }))
  assert.equal(await seedSkills(resolve('skills'), target), 'created')
  assert.deepEqual((await readdir(root)).sort(), [basename(await realpath(target)), 'seeded'].sort())
})

test('seed never replaces an uncooperative publisher empty target created at publication', async t => {
  const root = await fixture(t)
  const target = join(root, 'seeded')
  const originalRename = fsPromises.rename
  const originalSymlink = fsPromises.symlink
  let foreign
  const introduceForeignRoot = async destination => {
    if (resolve(String(destination)) !== target) return
    await mkdir(target)
    foreign = await lstat(target)
  }
  fsPromises.rename = async (source, destination) => { await introduceForeignRoot(destination); return originalRename(source, destination) }
  fsPromises.symlink = async (source, destination, type) => { await introduceForeignRoot(destination); return originalSymlink(source, destination, type) }
  syncBuiltinESMExports()
  let result
  try { result = await seedSkills(resolve('skills'), target) }
  finally { fsPromises.rename = originalRename; fsPromises.symlink = originalSymlink; syncBuiltinESMExports() }
  assert.ok(foreign, 'The real OS publication boundary was reached after the final existence check.')
  assert.equal(result, 'already-present')
  const after = await lstat(target)
  assert.equal(after.ino, foreign.ino, 'The competing user directory must retain its original identity.')
  assert.equal(after.dev, foreign.dev)
  assert.equal(after.isSymbolicLink(), false)
  assert.deepEqual(await readdir(target), [])
  assert.deepEqual(await readdir(root), ['seeded'], 'An unpublished private copy is the only disposable tree.')
})

test('a publication error cannot delete a complete entity already referenced by the logical root', async t => {
  const root = await fixture(t)
  const target = join(root, 'seeded')
  const original = fsPromises.symlink
  fsPromises.symlink = async (source, destination, type) => {
    await original(source, destination, type)
    throw Object.assign(new Error('Injected acknowledgement failure after actual publication'), { code: 'EIO' })
  }
  syncBuiltinESMExports()
  try { assert.equal(await seedSkills(resolve('skills'), target), 'already-present') }
  finally { fsPromises.symlink = original; syncBuiltinESMExports() }
  assert.equal((await scanSkills(target)).skills.length, 21)
  assert.deepEqual(await readFile(join(target, 'LICENSE')), await readFile(resolve('skills/LICENSE')))
  assert.deepEqual((await readdir(root)).sort(), [basename(await realpath(target)), 'seeded'].sort())
})

test('failed publication preserves an entity when a competing logical entry references its subtree', async t => {
  const root = await fixture(t)
  const target = join(root, 'seeded')
  const original = fsPromises.symlink
  let entity
  fsPromises.symlink = async (source, destination) => {
    entity = resolve(dirname(String(destination)), String(source))
    const referenced = join(entity, 'quality')
    await original(referenced, destination, process.platform === 'win32' ? 'junction' : 'dir')
    throw Object.assign(new Error('Competing publisher retained a subtree'), { code: 'EEXIST' })
  }
  syncBuiltinESMExports()
  try { assert.equal(await seedSkills(resolve('skills'), target), 'already-present') }
  finally { fsPromises.symlink = original; syncBuiltinESMExports() }
  assert.equal(await realpath(target), await realpath(join(entity, 'quality')))
  assert.deepEqual(await readFile(join(entity, 'LICENSE')), await readFile(resolve('skills/LICENSE')))
  assert.ok((await readFile(join(target, 'tdd', 'SKILL.md'), 'utf8')).includes('name:'))
})

test('the default linked library passes workspace canonical guards and stays editable across init', async t => {
  const root = await fixture(t)
  const worktree = join(root, 'project')
  const dataRoot = join(root, 'machine-data')
  await mkdir(worktree)
  await execFile('git', ['-C', worktree, 'init', '-b', 'main'], { windowsHide: true })
  const inherited = process.env.HARNESS_SKILLS_ROOT
  process.env.HARNESS_SKILLS_ROOT = ''
  let registry
  try { registry = new WorkspaceRegistry(dataRoot, { seedRoot: resolve('skills') }) }
  finally { if (inherited === undefined) delete process.env.HARNESS_SKILLS_ROOT; else process.env.HARNESS_SKILLS_ROOT = inherited }
  const initialized = await registry.init(worktree)
  assert.equal(initialized.skillSeed, 'created')
  const logical = join(dataRoot, 'skills')
  const actual = await registry.skillsRoot(initialized.worktree)
  assert.equal(actual, await realpath(logical))
  assert.equal((await lstat(logical)).isSymbolicLink(), true)
  assert.equal((await scanSkills(actual)).skills.length, 21)
  const edit = body('tdd', 'User-edited default method')
  await writeFile(join(logical, 'quality/tdd/SKILL.md'), edit)
  const repeated = await registry.init(worktree)
  assert.equal(repeated.skillSeed, 'already-present')
  assert.equal(await registry.skillsRoot(repeated.worktree), actual)
  assert.equal(await readFile(join(actual, 'quality/tdd/SKILL.md'), 'utf8'), edit)
  const updated = await scanSkills(logical)
  assert.equal(updated.valid, true, JSON.stringify(updated.diagnostics))
  assert.equal(updated.skills.find(item => item.id === 'quality/tdd').description, 'User-edited default method')
})
