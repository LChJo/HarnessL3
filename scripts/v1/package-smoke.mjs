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
  const cli = (args, input, { cwd = project, noGit = false } = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [installedBinary, ...args, '--json', '--data-dir', dataRoot], { cwd, windowsHide: true, env: { ...process.env, HARNESSL3_HOME: '', HARNESS_SKILLS_ROOT: '', ...(noGit ? { PATH: '' } : {}) } })
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
    for (const required of ['bin/harnessl3.mjs', 'build/build-info.json', 'build/cli/main.js', 'build/cli/help.js', 'build/core/index-worker.js', 'build/web/index.html', 'skills/LICENSE', 'agent-skills/harnessl3/SKILL.md', 'agent-skills/harnessl3/references/install-update.md', 'agent-skills/harnessl3/references/project-init.md', 'agent-skills/harnessl3/references/runtime.md', 'agent-skills/harnessl3/references/subagent.md', 'scripts/install-agent-skills.mjs', 'scripts/verify-install.mjs', 'INSTALL.md', 'docs/USAGE.md', 'docs/spec/contracts/response.schema.json', 'docs/spec/contracts/examples/selection.json']) assert.ok(files.includes(required), `Missing packaged resource: ${required}`)
    assert.equal(files.filter(file => file.endsWith('/SKILL.md') && file.startsWith('skills/')).length, 26)
    assert.ok(files.every(file => (['scripts/install-agent-skills.mjs', 'scripts/verify-install.mjs'].includes(file) || !/^(?:\.git|\.harness-local|node_modules|src|server|tests|examples|scripts)\//.test(file)) && !file.endsWith('.map')), 'Only the explicit installation tools may ship from development scripts')
    const tarball = path.join(temporary, manifest.filename)
    const bytes = await readFile(tarball)
    assert.equal('sha512-' + createHash('sha512').update(bytes).digest('base64'), manifest.integrity)
    await mkdir(consumerFiles); await mkdir(project)
    await symlink(consumerFiles, consumer, process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ private: true, name: 'harnessl3-package-consumer', version: '1.0.0' }))
    await npm(['install', tarball, '--prefix', consumer, '--global=false', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: consumer })
    const shim = await npm(['exec', '--offline', '--', 'harnessl3', '--version'], { cwd: consumer })
    assert.equal(shim.stdout.trim(), '0.1.1', 'The installed npm bin shim must resolve and run the packaged entry')
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
    assert.match(help.stdout, /HarnessL3 0\.1\.1/)
    const selectHelp = (await execFile(process.execPath, [installedBinary, 'task', 'select', '--help'], { cwd: project, windowsHide: true })).stdout
    assert.match(selectHelp, /Usage: harnessl3 task select \[<task-id>\] \[--file/)
    const installedSchema = selectHelp.match(/^Request schema: (.+)$/m)?.[1]
    assert.ok(installedSchema && path.isAbsolute(installedSchema), 'Installed help must expose an absolute Schema path')
    assert.equal(await realpath(installedSchema), await realpath(path.join(consumer, 'node_modules', 'harnessl3', 'docs', 'spec', 'contracts', 'selection.schema.json')))
    assert.equal(JSON.parse(await readFile(installedSchema, 'utf8')).type, 'object')
    const references = [...selectHelp.matchAll(/^Referenced schema: (.+)$/gm)].map(match => match[1])
    assert.ok(references.some(file => path.basename(file) === 'common.schema.json'))
    for (const file of references) assert.equal(typeof JSON.parse(await readFile(file, 'utf8')), 'object')
    const modelHelp = (await execFile(process.execPath, [installedBinary, 'model', 'validate', '--help'], { cwd: project, windowsHide: true })).stdout
    assert.match(modelHelp, /relationship calls.*-\[calls\]->/)
    const modelGuide = modelHelp.match(/^Usage guide: (.+)$/m)?.[1]
    assert.match(await readFile(modelGuide, 'utf8'), /relationship calls/)
    const maintainHelp = (await execFile(process.execPath, [installedBinary, 'model', 'maintain', '--help'], { cwd: project, windowsHide: true })).stdout
    assert.match(maintainHelp, /supplement\|revise\|rebuild/)
    const maintainSchema = maintainHelp.match(/^Result schema: (.+)$/m)?.[1]
    assert.ok(maintainSchema && path.isAbsolute(maintainSchema))
    assert.equal(JSON.parse(await readFile(maintainSchema, 'utf8')).title, 'Current-agent model maintenance guidance result')
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
    assert.equal(initialized.data.result.initialization.promptVersion, 'model-maintenance/1')
    const maintained = (await cli(['model', 'maintain', '--mode', 'rebuild'])).data.result
    assert.equal(maintained.stage, 'guidance-ready')
    assert.equal(maintained.sourceScan, 'not-requested')
    assert.equal(maintained.topology.objects, 1)
    assert.equal(maintained.semanticStatus, 'not-assessed')
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
    assert.equal(entry.catalog.length, 26)
    for (const value of [entry.taskId, entry.binding.modelRevision, entry.binding.catalogRevision]) assert.ok(!entry.routingPrompt.includes(value), 'Routing text must refer to the structured task data')
    const skill = entry.catalog[0]
    const selected = await cli(['task', 'select', entry.taskId, '--file', '-'], { schemaVersion: 1, requestId: randomUUID(), binding: entry.binding, context: { expand: [], read: [entry.directory.items[0].id], known: {} }, skills: [{ id: skill.id, reason: 'Validate packaged file references' }] })
    assert.equal(selected.data.packet.contexts.length, 1)
    const file = selected.data.skillPlan.skills[0].files.find(file => file.path === 'SKILL.md')
    const read = await cli(['task', 'read', entry.taskId, '--file', '-'], { schemaVersion: 1, requestId: randomUUID(), files: [{ skillId: skill.id, path: file.path, expectedHash: file.hash }] })
    assert.equal(createHash('sha256').update(read.data.files[0].file.content).digest('hex'), file.hash)
    assert.equal((await cli(['task', 'close', entry.taskId])).ok, true)
    const baseline = await cli(['task', 'handoff', entry.taskId])
    const baselineFile = path.join(temporary, 'before-update.json')
    await writeFile(baselineFile, JSON.stringify(baseline), 'utf8')
    await cli(['serve', 'stop'])
    const verifier = path.join(consumer, 'node_modules', 'harnessl3', 'scripts', 'verify-install.mjs')
    const verification = JSON.parse((await execFile(process.execPath, [verifier, '--data-dir', dataRoot, '--handoff-before', baselineFile, '--report', path.join(temporary, 'verified.json')], { cwd: project, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })).stdout)
    assert.equal(verification.ok, true)
    assert.equal(verification.historyCheck, 'matched-before-update')
    assert.equal(verification.handoff.taskId, entry.taskId)
    assert.ok(verification.checks.includes('runtime-fingerprint') && verification.checks.includes('service-build'))
    assert.equal(verification.build.sourceCommit, JSON.parse(await readFile(path.join(root, 'build/build-info.json'), 'utf8')).sourceCommit)
    const alteredBaseline = structuredClone(baseline)
    alteredBaseline.data.packet.contexts[0].entity.brief = 'Different before-update packet'
    await writeFile(baselineFile, JSON.stringify(alteredBaseline), 'utf8')
    const rejected = await execFile(process.execPath, [verifier, '--data-dir', dataRoot, '--handoff-before', baselineFile], { cwd: project, windowsHide: true }).then(() => assert.fail('Changed history must fail verification'), error => JSON.parse(error.stdout))
    assert.equal(rejected.ok, false)
    assert.equal(rejected.stage, 'handoff')
    assert.equal(rejected.error.code, 'HANDOFF_CHANGED')
    const runtimeFile = path.join(consumer, 'node_modules', 'harnessl3', 'build/core/errors.js')
    const runtimeBytes = await readFile(runtimeFile)
    try {
      await writeFile(runtimeFile, Buffer.concat([runtimeBytes, Buffer.from('\n// Synthetic installed-byte change\n')]))
      const changedRuntime = await execFile(process.execPath, [verifier, '--data-dir', dataRoot], { cwd: project, windowsHide: true }).then(() => assert.fail('Changed runtime bytes must fail verification'), error => JSON.parse(error.stdout))
      assert.equal(changedRuntime.error.code, 'RUNTIME_HASH_MISMATCH')
      assert.equal(changedRuntime.stage, 'package')
    } finally { await writeFile(runtimeFile, runtimeBytes) }
    const descriptor = JSON.parse(await readFile(path.join(dataRoot, 'service.json'), 'utf8'))
    const html = await fetch(descriptor.url).then(response => response.text())
    assert.ok(html.includes('type="module"'))
    assert.ok(!/https?:\/\//.test(html), 'Web entry must use packaged local assets')
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match => match[1])
    assert.ok(assets.length >= 2)
    for (const asset of assets) { const response = await fetch(descriptor.url + asset); assert.equal(response.status, 200, asset); assert.ok((await response.arrayBuffer()).byteLength > 0) }
    await cli(['serve', 'stop'])
    const plainRoot = path.join(temporary, '普通目录 no git')
    await mkdir(path.join(plainRoot, 'child'), { recursive: true })
    await writeFile(path.join(plainRoot, 'README.md'), 'Installed directory fixture')
    const plain = (args, input) => cli(args, input, { cwd: plainRoot, noGit: true })
    const directoryInit = await plain(['init'])
    assert.equal(directoryInit.data.result.worktree.kind, 'directory')
    const directoryMaintenance = (await plain(['model', 'maintain', '--mode', 'revise'])).data.result
    assert.equal(directoryMaintenance.modelState, 'valid')
    assert.equal(directoryMaintenance.sourceScan, 'not-requested')
    const directoryEntry = (await cli(['task', 'start', '--title', 'Installed no Git directory', '--mode', 'verified'], undefined, { cwd: path.join(plainRoot, 'child'), noGit: true })).data
    assert.equal(directoryEntry.binding.sourceVersion.status, 'unversioned')
    const directorySkill = directoryEntry.catalog.find(item => item.id === 'development/implement')
    const directorySelection = await plain(['task', 'select', directoryEntry.taskId, '--file', '-'], { schemaVersion: 1, requestId: randomUUID(), binding: directoryEntry.binding, context: { expand: [], read: [directoryEntry.directory.items[0].id], known: {} }, skills: [{ id: directorySkill.id, reason: 'Installed directory verification' }] })
    const directoryFile = directorySkill.files.find(item => item.path === 'SKILL.md')
    assert.equal((await plain(['task', 'read', directoryEntry.taskId, '--file', '-'], { schemaVersion: 1, requestId: randomUUID(), files: [{ skillId: directorySkill.id, path: directoryFile.path, expectedHash: directoryFile.hash }] })).data.files.length, 1)
    const directoryState = (await plain(['sync', 'status'])).data.result
    const directoryProof = { schemaVersion: 1, requestId: randomUUID(), target: directoryInit.target, phaseId: randomUUID(), sourceEpoch: directoryState.sourceEpoch, expectedSourceVersion: directoryState.sourceVersion, expectedModelRevision: directoryState.modelRevision, scope: { paths: ['README.md'], entities: [] }, disposition: 'no-semantic-change', reason: 'Reviewed installed directory fixture', checks: [{ name: 'Fixture source review', status: 'passed', evidence: ['README.md'] }] }
    assert.equal((await plain(['sync', 'verify', '--file', '-'], directoryProof)).data.result.state, 'verified')
    const directoryHandoff = (await plain(['task', 'handoff', directoryEntry.taskId])).data
    assert.equal(directorySelection.data.packet.contexts.length, 1)
    await plain(['serve', 'stop'])
    assert.deepEqual((await plain(['task', 'handoff', directoryEntry.taskId])).data, directoryHandoff)
    const directoryLink = (await plain(['web', 'open', '--no-open', '--task', directoryEntry.taskId])).data.result.url
    const { verifyDirectoryBrowser } = await import('./directory-browser.mjs')
    const directoryBrowser = await verifyDirectoryBrowser(directoryLink, directoryEntry.taskId)
    const shortcutId = randomUUID()
    const snapshot = (await plain(['task', 'start', '--title', 'Installed agent shortcuts', '--request-id', shortcutId])).data
    assert.equal(snapshot.binding.mode, 'snapshot')
    assert.equal(snapshot.binding.sourceVersion.status, 'unknown')
    assert.equal(snapshot.binding.sourceScanRevision, null)
    const quick = await plain(['task', 'select', snapshot.taskId, '--read', snapshot.directory.items[0].id, '--skill', 'development/implement', '--reason', 'Verify packaged shortcuts'])
    const firstStage = quick.data.result.batchId
    assert.equal((await plain(['task', 'read', snapshot.taskId, '--skill', 'development/implement'])).data.files.length, 1)
    await plain(['task', 'select', snapshot.taskId, '--stage', '--skill', 'quality/code-review', '--reason', 'Review packaged behavior'])
    assert.equal((await plain(['task', 'read', snapshot.taskId, '--batch', firstStage, '--skill', 'development/implement'])).data.files.length, 1)
    await plain(['serve', 'stop'])
    const restoredRequest = await plain(['request', 'status', shortcutId])
    assert.equal(restoredRequest.data.result.state, 'completed')
    assert.equal(restoredRequest.data.result.receipt.data.taskId, snapshot.taskId)
    const artifacts = path.join(root, '.harness-local', 'artifacts')
    await mkdir(artifacts, { recursive: true })
    const output = path.join(artifacts, manifest.filename)
    await copyFile(tarball, output)
    const report = { platform: process.platform, node: process.version, package: manifest.name, version: manifest.version, bytes: manifest.size, unpackedBytes: manifest.unpackedSize, files: files.length, skillCount: 26, runtimeSkillCopies: copiedSkills.results.length, runtimeSkillFilesPerHost: copiedSkills.results[0].files.length, runtimeSkillReinstall: true, sha512: manifest.integrity, assets: assets.length, installedBinShim: true, installedTaskRoundtrip: true, installedNoOpenLinks: true, installedScaffoldHandoff: true, installedServiceLoginLifetimes: true, installedVerification: verification, alteredHandoffRejected: true, directoryWithoutGit: { lifecycle: true, restartHandoff: true, browser: directoryBrowser }, tarball: output }
    await writeFile(path.join(artifacts, 'package-smoke-' + process.platform + '.json'), JSON.stringify(report, null, 2) + '\n')
    return report
  } finally {
    if (installedBinary) await cli(['serve', 'stop']).catch(() => {})
    if (!path.isAbsolute(temporary) || !path.basename(temporary).startsWith('harnessl3-package-')) throw new Error('Unsafe package fixture cleanup target')
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await packageSmoke()))
