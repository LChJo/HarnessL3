import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, symlink, realpath } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFile as callbackExecFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID, createHash } from 'node:crypto'
import { npm } from './npm-tool.mjs'

const execFile = promisify(callbackExecFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export async function packageSmoke() {
  const temporary = await mkdtemp(path.join(tmpdir(), 'harnessl3-package-'))
  const dataRoot = path.join(temporary, 'machine data')
  const consumer = path.join(temporary, '中文 package consumer')
  const consumerFiles = path.join(temporary, '中文 package files')
  const project = path.join(temporary, 'isolated project')
  let installedBinary
  const cli = (args, input) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [installedBinary, ...args, '--json', '--data-dir', dataRoot], { cwd: project, windowsHide: true, env: { ...process.env, HARNESSL3_HOME: '', HARNESS_SKILLS_ROOT: '' } })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => { if (code) reject(new Error(`Installed CLI failed (${code}): ${args.join(' ')}\n${stdout}\n${stderr}`)); else { try { resolve(JSON.parse(stdout)) } catch (error) { reject(error) } } })
    child.stdin.end(input ? JSON.stringify(input) : '')
  })
  try {
    const { stdout } = await npm(['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], { cwd: root })
    const [manifest] = JSON.parse(stdout)
    const files = manifest.files.map(file => file.path)
    for (const required of ['bin/harnessl3.mjs', 'build/cli/main.js', 'build/cli/help.js', 'build/core/index-worker.js', 'build/web/index.html', 'skills/LICENSE', 'agent-skills/harnessl3/SKILL.md', 'agent-skills/harnessl3/references/install-update.md', 'agent-skills/harnessl3/references/project-init.md', 'agent-skills/harnessl3/references/runtime.md', 'agent-skills/harnessl3/references/subagent.md', 'scripts/install-agent-skills.mjs', 'INSTALL.md', 'docs/USAGE.md', 'docs/spec/contracts/response.schema.json', 'docs/spec/contracts/examples/selection.json']) assert.ok(files.includes(required), `Missing packaged resource: ${required}`)
    assert.equal(files.filter(file => file.endsWith('/SKILL.md') && file.startsWith('skills/')).length, 21)
    assert.ok(files.every(file => (file === 'scripts/install-agent-skills.mjs' || !/^(?:\.git|\.harness-local|node_modules|src|server|tests|examples|scripts)\//.test(file)) && !file.endsWith('.map')), 'Only the explicit skill installer may ship from development scripts')
    const tarball = path.join(temporary, manifest.filename)
    const bytes = await readFile(tarball)
    assert.equal('sha512-' + createHash('sha512').update(bytes).digest('base64'), manifest.integrity)
    await mkdir(consumerFiles); await mkdir(project)
    await symlink(consumerFiles, consumer, process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ private: true, name: 'harnessl3-package-consumer', version: '1.0.0' }))
    await npm(['install', tarball, '--prefix', consumer, '--global=false', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: consumer })
    const shim = await npm(['exec', '--offline', '--', 'harnessl3', '--version'], { cwd: consumer })
    assert.equal(shim.stdout.trim(), '0.1.0', 'The installed npm bin shim must resolve and run the packaged entry')
    installedBinary = path.join(consumer, 'node_modules', 'harnessl3', 'bin', 'harnessl3.mjs')
    const skillInstaller = path.join(consumer, 'node_modules', 'harnessl3', 'scripts', 'install-agent-skills.mjs')
    assert.deepEqual(await readFile(skillInstaller), await readFile(path.join(root, 'scripts', 'install-agent-skills.mjs')))
    const skillArguments = [skillInstaller, '--codex-skills-dir', path.join(temporary, 'codex skills'), '--claude-skills-dir', path.join(temporary, 'claude skills')]
    const copiedSkills = JSON.parse((await execFile(process.execPath, skillArguments, { cwd: consumer, windowsHide: true })).stdout)
    assert.equal(copiedSkills.ok, true)
    assert.equal(copiedSkills.results.length, 2)
    for (const entry of copiedSkills.results) {
      assert.equal(entry.files.length, 5)
      for (const file of entry.files) assert.deepEqual(await readFile(file.path), await readFile(path.join(root, 'agent-skills', 'harnessl3', file.relativePath)))
    }
    const repeatedSkills = JSON.parse((await execFile(process.execPath, skillArguments, { cwd: consumer, windowsHide: true })).stdout)
    assert.ok(repeatedSkills.results.every(entry => entry.status === 'unchanged'))
    const help = await execFile(process.execPath, [installedBinary, '--help'], { cwd: project, windowsHide: true })
    assert.match(help.stdout, /HarnessL3 0\.1\.0/)
    const selectHelp = (await execFile(process.execPath, [installedBinary, 'task', 'select', '--help'], { cwd: project, windowsHide: true })).stdout
    assert.match(selectHelp, /Usage: harnessl3 task select \[<task-id>\] --file/)
    const installedSchema = selectHelp.match(/^Request schema: (.+)$/m)?.[1]
    assert.ok(installedSchema && path.isAbsolute(installedSchema), 'Installed help must expose an absolute Schema path')
    assert.equal(await realpath(installedSchema), await realpath(path.join(consumer, 'node_modules', 'harnessl3', 'docs', 'spec', 'contracts', 'selection.schema.json')))
    assert.equal(JSON.parse(await readFile(installedSchema, 'utf8')).type, 'object')
    const webHelp = (await execFile(process.execPath, [installedBinary, 'web', 'open', '--help'], { cwd: project, windowsHide: true })).stdout
    assert.match(webHelp, /--no-open/)
    const git = (...args) => execFile('git', ['-C', project, ...args], { windowsHide: true })
    await git('init', '-b', 'main'); await git('config', 'user.name', 'Package fixture'); await git('config', 'user.email', 'fixture@example.invalid')
    await writeFile(path.join(project, 'README.md'), 'Isolated installed-package fixture\n')
    await git('add', 'README.md'); await git('commit', '-m', 'Fixture source')
    const firstLink = await cli(['web', 'open', '--no-open'])
    assert.equal(firstLink.data.result.opened, false)
    assert.equal(firstLink.target, null)
    assert.match(new URL(firstLink.data.result.url).hash, /^#code=[a-f0-9]{64}$/)
    const initialized = await cli(['init'])
    assert.equal(initialized.ok, true)
    assert.equal(initialized.data.result.initialization.stage, 'scaffold-ready')
    assert.equal(initialized.data.result.initialization.semanticStatus, 'not-assessed')
    assert.equal(initialized.data.result.initialization.nextAction, 'model-project')
    const started = await cli(['task', 'start', '--title', 'Installed package task'])
    const entry = started.data
    const taskLink = await cli(['web', 'open', '--no-open', '--task', entry.taskId])
    const linkParameters = new URLSearchParams(new URL(taskLink.data.result.url).hash.slice(1))
    assert.equal(taskLink.data.result.opened, false)
    assert.equal(taskLink.data.result.service.lifetime, 'until-stopped')
    assert.equal(taskLink.data.result.service.scope, 'user-data-root')
    assert.equal(taskLink.data.result.login.oneTime, true)
    assert.equal(taskLink.data.result.login.browserSessionTtlMs, 43_200_000)
    assert.equal(linkParameters.get('worktree'), started.target.worktreeId)
    assert.equal(linkParameters.get('task'), entry.taskId)
    assert.equal(entry.catalog.length, 21)
    for (const value of [entry.taskId, entry.binding.modelRevision, entry.binding.catalogRevision]) assert.ok(!entry.routingPrompt.includes(value), 'Routing text must refer to the structured task data')
    const skill = entry.catalog[0]
    const selected = await cli(['task', 'select', entry.taskId, '--file', '-'], { schemaVersion: 1, requestId: randomUUID(), binding: entry.binding, context: { expand: [], read: [entry.directory.items[0].id], known: {} }, skills: [{ id: skill.id, reason: 'Validate packaged file references' }] })
    assert.equal(selected.data.packet.contexts.length, 1)
    const file = selected.data.skillPlan.skills[0].files.find(file => file.path === 'SKILL.md')
    const read = await cli(['task', 'read', entry.taskId, '--file', '-'], { schemaVersion: 1, requestId: randomUUID(), files: [{ skillId: skill.id, path: file.path, expectedHash: file.hash }] })
    assert.equal(createHash('sha256').update(read.data.files[0].file.content).digest('hex'), file.hash)
    assert.equal((await cli(['task', 'close', entry.taskId])).ok, true)
    const descriptor = JSON.parse(await readFile(path.join(dataRoot, 'service.json'), 'utf8'))
    const html = await fetch(descriptor.url).then(response => response.text())
    assert.ok(html.includes('type="module"'))
    assert.ok(!/https?:\/\//.test(html), 'Web entry must use packaged local assets')
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match => match[1])
    assert.ok(assets.length >= 2)
    for (const asset of assets) { const response = await fetch(descriptor.url + asset); assert.equal(response.status, 200, asset); assert.ok((await response.arrayBuffer()).byteLength > 0) }
    const artifacts = path.join(root, '.harness-local', 'artifacts')
    await mkdir(artifacts, { recursive: true })
    const output = path.join(artifacts, manifest.filename)
    await copyFile(tarball, output)
    const report = { platform: process.platform, node: process.version, package: manifest.name, version: manifest.version, bytes: manifest.size, unpackedBytes: manifest.unpackedSize, files: files.length, skillCount: 21, runtimeSkillCopies: copiedSkills.results.length, runtimeSkillFilesPerHost: copiedSkills.results[0].files.length, runtimeSkillReinstall: true, sha512: manifest.integrity, assets: assets.length, installedBinShim: true, installedTaskRoundtrip: true, installedNoOpenLinks: true, installedScaffoldHandoff: true, installedServiceLoginLifetimes: true, tarball: output }
    await writeFile(path.join(artifacts, 'package-smoke-' + process.platform + '.json'), JSON.stringify(report, null, 2) + '\n')
    return report
  } finally {
    if (installedBinary) await cli(['serve', 'stop']).catch(() => {})
    if (!path.isAbsolute(temporary) || !path.basename(temporary).startsWith('harnessl3-package-')) throw new Error('Unsafe package fixture cleanup target')
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await packageSmoke()))
