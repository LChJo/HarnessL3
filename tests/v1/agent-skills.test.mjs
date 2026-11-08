import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile as callbackExecFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { installAgentSkills, resolveSkillTargets } from '../../scripts/install-agent-skills.mjs'

const execFile = promisify(callbackExecFile)
const installer = fileURLToPath(new URL('../../scripts/install-agent-skills.mjs', import.meta.url))
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'harnessl3-agent-skills-'))
  t.after(async () => {
    if (!path.isAbsolute(root) || path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('harnessl3-agent-skills-')) throw new Error('Unsafe skill fixture cleanup target')
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const source = path.join(root, 'runtime-skill')
  await mkdir(path.join(source, 'references'), { recursive: true })
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: harnessl3\ndescription: Use the installed CLI.\n---\nVersion one\n')
  await writeFile(path.join(source, 'references', 'install-update.md'), 'Read only when installing or updating.\n')
  await writeFile(path.join(source, 'references', 'project-init.md'), 'Read only when initializing a project.\n')
  const codexSkillsDir = path.join(root, '用户 codex', 'skills')
  const claudeSkillsDir = path.join(root, '用户 claude', 'skills')
  return { root, source, codexSkillsDir, claudeSkillsDir }
}

test('global skill roots use Codex user scope and the configured Claude home', () => {
  const home = path.join(tmpdir(), 'agent home')
  const customClaude = path.join(tmpdir(), 'custom claude')
  assert.deepEqual(resolveSkillTargets({ home, env: {} }), {
    codexSkillsDir: path.join(home, '.agents', 'skills'),
    claudeSkillsDir: path.join(home, '.claude', 'skills'),
  })
  assert.equal(resolveSkillTargets({ home, env: { CLAUDE_CONFIG_DIR: customClaude } }).claudeSkillsDir, path.join(customClaude, 'skills'))
})

test('copies the runtime skill and on-demand references to both roots; repeated installation is unchanged', async t => {
  const f = await fixture(t)
  const first = await installAgentSkills(f)
  assert.deepEqual(first.map(item => [item.agent, item.status]), [['codex', 'installed'], ['claude-code', 'installed']])
  for (const item of first) {
    assert.equal(await readFile(item.path, 'utf8'), await readFile(path.join(f.source, 'SKILL.md'), 'utf8'))
    assert.equal(item.files.length, 3)
    for (const relative of ['references/install-update.md', 'references/project-init.md']) {
      assert.deepEqual(await readFile(path.join(path.dirname(item.path), relative)), await readFile(path.join(f.source, relative)))
    }
  }
  const repeated = await installAgentSkills(f)
  assert.ok(repeated.every(item => item.status === 'unchanged' && !item.backup))
  assert.deepEqual((await readdir(path.join(f.codexSkillsDir, 'harnessl3'))).sort(), ['SKILL.md', 'references'])
})

for (const linkedRoot of [false, true]) test('updating preserves customized skill bytes in backups and leaves other files and skills alone' + (linkedRoot ? ' through a linked skills root' : ''), async t => {
  const f = await fixture(t)
  if (linkedRoot) {
    await mkdir(f.codexSkillsDir, { recursive: true })
    const alias = path.join(f.root, 'linked codex skills')
    try { await symlink(f.codexSkillsDir, alias, process.platform === 'win32' ? 'junction' : 'dir') }
    catch (error) { if (error.code === 'EPERM') { t.skip('Host cannot create directory links'); return }; throw error }
    f.codexSkillsDir = alias
  }
  await installAgentSkills(f)
  const entry = path.join(f.codexSkillsDir, 'harnessl3', 'SKILL.md')
  const note = path.join(f.codexSkillsDir, 'harnessl3', 'user-note.txt')
  const other = path.join(f.codexSkillsDir, 'other-skill', 'SKILL.md')
  const guide = path.join(f.codexSkillsDir, 'harnessl3', 'references', 'project-init.md')
  await writeFile(entry, 'User edited runtime instructions\r\n')
  await writeFile(note, 'Keep my attachment')
  await mkdir(path.dirname(other)); await writeFile(other, 'Keep other skill')
  await writeFile(guide, 'User edited project setup\r\n')
  await writeFile(path.join(f.source, 'SKILL.md'), 'Updated runtime skill\n')
  await writeFile(path.join(f.source, 'references', 'project-init.md'), 'Updated project setup\n')
  const updated = await installAgentSkills(f)
  assert.ok(updated.every(item => item.status === 'updated' && item.backup))
  assert.equal(await readFile(updated[0].backup, 'utf8'), 'User edited runtime instructions\r\n')
  assert.equal(await readFile(entry, 'utf8'), 'Updated runtime skill\n')
  assert.equal(await readFile(note, 'utf8'), 'Keep my attachment')
  assert.equal(await readFile(other, 'utf8'), 'Keep other skill')
  const updatedGuide = updated[0].files.find(item => item.relativePath === 'references/project-init.md')
  assert.ok(updatedGuide)
  assert.equal(updatedGuide.path, path.join(path.dirname(updated[0].path), 'references', 'project-init.md'))
  assert.equal(updatedGuide.status, 'updated')
  assert.equal(await readFile(updatedGuide.backup, 'utf8'), 'User edited project setup\r\n')
  assert.equal(await readFile(guide, 'utf8'), 'Updated project setup\n')
  const backupRelative = path.relative(f.codexSkillsDir, updated[0].backup)
  assert.ok(backupRelative.startsWith('..' + path.sep), 'Backups must stay outside skill discovery roots')
})

test('preflights nested attachment directory links before replacing any installed files', async t => {
  const f = await fixture(t)
  const outside = path.join(f.root, 'unrelated attachments')
  const skillDirectory = path.join(f.codexSkillsDir, 'harnessl3')
  await mkdir(outside)
  await writeFile(path.join(outside, 'project-init.md'), 'Do not replace attachment')
  await mkdir(skillDirectory, { recursive: true })
  await writeFile(path.join(skillDirectory, 'SKILL.md'), 'Keep existing skill')
  try { await symlink(outside, path.join(skillDirectory, 'references'), process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) { if (error.code === 'EPERM') { t.skip('Host cannot create directory links'); return }; throw error }
  await assert.rejects(installAgentSkills(f), /symbolic link|junction/i)
  assert.equal(await readFile(path.join(outside, 'project-init.md'), 'utf8'), 'Do not replace attachment')
  assert.equal(await readFile(path.join(skillDirectory, 'SKILL.md'), 'utf8'), 'Keep existing skill')
})

test('does not follow an existing skill directory junction or symlink', async t => {
  const f = await fixture(t)
  const outside = path.join(f.root, 'unrelated')
  await mkdir(outside); await writeFile(path.join(outside, 'SKILL.md'), 'Do not replace')
  await mkdir(f.codexSkillsDir, { recursive: true })
  try { await symlink(outside, path.join(f.codexSkillsDir, 'harnessl3'), process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) { if (error.code === 'EPERM') { t.skip('Host cannot create directory links'); return }; throw error }
  await assert.rejects(installAgentSkills(f), /symbolic link|junction/i)
  assert.equal(await readFile(path.join(outside, 'SKILL.md'), 'utf8'), 'Do not replace')
})

test('a second destination failure reports the first completed copy as partial', async t => {
  const f = await fixture(t)
  await mkdir(path.dirname(f.claudeSkillsDir), { recursive: true })
  await writeFile(f.claudeSkillsDir, 'Not a directory')
  await assert.rejects(installAgentSkills(f), error => {
    assert.equal(error.results.length, 1)
    assert.equal(error.results[0].agent, 'codex')
    return true
  })
  assert.equal(await readFile(f.claudeSkillsDir, 'utf8'), 'Not a directory')
})

test('packaged installer supports explicit global directories and rejects unknown flags', async t => {
  const f = await fixture(t)
  const { stdout } = await execFile(process.execPath, [installer, '--codex-skills-dir', f.codexSkillsDir, '--claude-skills-dir', f.claudeSkillsDir], { windowsHide: true })
  const result = JSON.parse(stdout)
  assert.equal(result.ok, true)
  assert.equal(result.results.length, 2)
  assert.match(await readFile(result.results[0].path, 'utf8'), /name: harnessl3/)
  await assert.rejects(execFile(process.execPath, [installer, '--unknown']), error => {
    assert.equal(error.code, 1)
    assert.equal(JSON.parse(error.stderr).ok, false)
    return true
  })
  for (const inherited of ['toString', 'constructor', '__proto__']) {
    await assert.rejects(execFile(process.execPath, [installer, inherited, f.root, '--codex-skills-dir', f.codexSkillsDir, '--claude-skills-dir', f.claudeSkillsDir]), error => {
      assert.equal(error.code, 1)
      assert.equal(JSON.parse(error.stderr).ok, false)
      return true
    })
  }
})

test('packaged installer invoked through a directory alias emits JSON and installs both hosts', async t => {
  const f = await fixture(t)
  const alias = path.join(f.root, 'linked package 中文')
  const packageRoot = path.resolve(path.dirname(installer), '..')
  try { await symlink(packageRoot, alias, process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) { if (error.code === 'EPERM') { t.skip('Host cannot create directory links'); return }; throw error }
  const args = [path.join(alias, 'scripts', 'install-agent-skills.mjs'), '--codex-skills-dir', f.codexSkillsDir, '--claude-skills-dir', f.claudeSkillsDir]
  const { stdout } = await execFile(process.execPath, args, { windowsHide: true })
  assert.ok(stdout.trim(), 'Invoking the installer through an alias must execute its CLI and return JSON')
  const result = JSON.parse(stdout)
  assert.equal(result.ok, true)
  assert.deepEqual(result.results.map(item => [item.agent, item.status]), [['codex', 'installed'], ['claude-code', 'installed']])
  for (const item of result.results) {
    assert.equal(item.files.length, 5)
    for (const file of item.files) assert.deepEqual(await readFile(file.path), await readFile(path.join(packageRoot, 'agent-skills', 'harnessl3', file.relativePath)))
  }
  const repeated = JSON.parse((await execFile(process.execPath, args, { windowsHide: true })).stdout)
  assert.ok(repeated.results.every(item => item.status === 'unchanged'))
  await assert.rejects(execFile(process.execPath, [args[0], '--unknown'], { windowsHide: true }), error => {
    assert.equal(error.code, 1)
    assert.equal(JSON.parse(error.stderr).ok, false)
    return true
  })
})
