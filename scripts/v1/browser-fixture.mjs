import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile as callbackExecFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { writeLegacyFixture } from '../../tests/v1/legacy-fixture.mjs'

const execFile = promisify(callbackExecFile)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const binary = path.join(projectRoot, 'bin/harnessl3.mjs')
export const browserIds = Object.fromEntries(['app', 'network', 'client', 'state', 'download', 'task', 'output', 'dispatch', 'stateChange'].map((name, index) => [name, `50000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`]))
const evidenceIds = { 'network-source': '50000000-0000-4000-8000-000000000010', 'readme-source': '50000000-0000-4000-8000-000000000011' }
const metadata = (name, source = 'human', evidence = 'none') => `metadata { harness_id "${browserIds[name]}"; brief "${name} module brief"; source "${source}"; status "unknown"; evidence "${evidenceIds[evidence] ?? evidence}"; version "1" }`
const model = `specification {\n element system\n element component\n relationship calls\n}\nmodel {
app = system "Fixture application" { ${metadata('app')}
network = component "Network" { ${metadata('network')}
client = component "Client" { description "NETWORK CLIENT BODY" ${metadata('client', 'fact', 'network-source')} }
state = component "Connection state" { description "CONNECTION STATE BODY" ${metadata('state', 'inference')} }
}
download = component "Downloads" { ${metadata('download')}
task = component "Transfer task" { description "TRANSFER TASK BODY" ${metadata('task', 'human', 'readme-source')} }
output = component "Artifact" { description "ARTIFACT BODY" ${metadata('output')} }
}
}
app.download.task -[calls]-> app.network.client "Dispatch" { ${metadata('dispatch')} }
app.network.client -[calls]-> app.network.state "Update" { ${metadata('stateChange')} }
}\nviews {
view overview { include app.* }
view network { include app.network.* }
view transfer { include app.download.*, app.network.client }
}\n`
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

export async function createBrowserFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'harnessl3-browser-'))
  const dataRoot = path.join(directory, 'machine data')
  const root = path.join(directory, '中文 project')
  const git = (cwd, ...args) => execFile('git', ['-C', cwd, ...args], { windowsHide: true })
  const cli = async (args, cwd = root) => {
    let stdout
    try { ({ stdout } = await execFile(process.execPath, [binary, ...args, '--data-dir', dataRoot, '--json'], { cwd, env: { ...process.env, HARNESS_SKILLS_ROOT: '', HARNESSL3_HOME: '' }, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })) }
    catch (error) { throw new Error(`Fixture CLI failed: ${args.join(' ')}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`) }
    return JSON.parse(stdout)
  }
  const json = async (operation, taskId, input) => {
    const file = path.join(directory, randomUUID() + '.json')
    await writeFile(file, JSON.stringify(input))
    return cli([...operation.split(' '), taskId, '--file', file])
  }
  const repository = async location => {
    await mkdir(location, { recursive: true })
    await git(location, 'init', '-b', 'main')
    await git(location, 'config', 'user.name', 'HarnessL3 browser fixture')
    await git(location, 'config', 'user.email', 'fixture@example.invalid')
    await writeFile(path.join(location, 'README.md'), 'Synthetic browser fixture source\n')
    await git(location, 'add', 'README.md'); await git(location, 'commit', '-m', 'Initial fixture')
  }
  try {
    await repository(root)
    await mkdir(path.join(root, 'src'))
    await writeFile(path.join(root, 'src', 'network.ts'), 'export const networkState = "fixture"\n')
    const initialized = await cli(['init', '--name', 'Canvas fixture'])
    await writeFile(path.join(root, '.harness', 'model', 'main.c4'), model)
    const evidence = [
      { id: evidenceIds['network-source'], kind: 'source-code', claim: 'The fixture exports a state constant', location: { path: 'src/network.ts' }, hash: hash(await readFile(path.join(root, 'src', 'network.ts'))), observedAt: new Date().toISOString(), range: { startLine: 1, endLine: 1 } },
      { id: evidenceIds['readme-source'], kind: 'document', claim: 'The fixture is synthetic', location: { path: 'README.md' }, hash: hash(await readFile(path.join(root, 'README.md'))), observedAt: new Date().toISOString() },
    ]
    await writeFile(path.join(root, '.harness', 'evidence.json'), JSON.stringify({ schemaVersion: 1, evidence }))
    await git(root, 'add', '.harness', 'src'); await git(root, 'commit', '-m', 'Fixture model and evidence')
    const linkedRoot = path.join(directory, 'parallel worktree')
    await git(root, 'worktree', 'add', '-b', 'parallel', linkedRoot)
    const linked = await cli(['init'], linkedRoot)
    const otherRoot = path.join(directory, 'Other project')
    await repository(otherRoot)
    const other = await cli(['init', '--name', 'Other fixture'], otherRoot)
    const entry = (await cli(['task', 'start', '--title', 'Fixture: inspect transfer and network'])).data
    const selected = await json('task select', entry.taskId, { schemaVersion: 1, requestId: randomUUID(), binding: entry.binding, context: { expand: [browserIds.app, browserIds.network], read: [browserIds.task], known: {} }, skills: ['quality/diagnosing-bugs', 'quality/tdd', 'quality/code-review'].map(id => ({ id, reason: 'Synthetic browser verification selection' })) })
    const expanded = await json('context query', entry.taskId, { schemaVersion: 1, requestId: randomUUID(), expectedModelRevision: entry.binding.modelRevision, expand: [], read: [browserIds.client], known: {} })
    const current = (await cli(['task', 'start', '--title', 'Fixture: awaiting joint selection'])).data
    const legacySource = path.join(directory, 'synthetic legacy source')
    const legacy = await writeLegacyFixture(legacySource)
    await cli(['migrate', 'prototype', '--from', legacySource, '--worktree', initialized.target.worktreeId, '--apply'])
    const service = JSON.parse(await readFile(path.join(dataRoot, 'service.json'), 'utf8'))
    const url = async (taskId = entry.taskId, batchId) => {
      const { code } = await fetch(service.url + '/browser-session', { method: 'POST', headers: { authorization: 'Bearer ' + service.token } }).then(response => response.json())
      return service.url + '/#' + new URLSearchParams({ code, worktree: initialized.target.worktreeId, ...(taskId ? { task: taskId } : {}), ...(batchId ? { batch: batchId } : {}) })
    }
    const stop = async () => {
      await cli(['serve', 'stop'], directory)
      if (!path.isAbsolute(directory) || !path.basename(directory).startsWith('harnessl3-browser-')) throw new Error('Unsafe browser fixture cleanup target')
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
    return { directory, dataRoot, root, target: initialized.target, linked: linked.target, other: other.target, entry, selected: selected.data, expanded: expanded.data, current, legacy: legacy.task, cli, json, url, stop, origin: service.url }
  } catch (error) {
    await cli(['serve', 'stop'], directory).catch(() => {})
    if (path.isAbsolute(directory) && path.basename(directory).startsWith('harnessl3-browser-')) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    throw error
  }
}
