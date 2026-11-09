import { execFile as callbackExecFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, writeFile, mkdir, lstat, realpath, rm } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { setTimeout as pause } from 'node:timers/promises'
import { createFixture, summarizeSamples } from './benchmark.mjs'

const execFile = promisify(callbackExecFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ownFile = fileURLToPath(import.meta.url)
const hashFile = async file => { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex') }
const peakRSS = () => Math.max(process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024)
const importCore = name => import(pathToFileURL(path.join(root, 'build/core', name + '.js')))

async function seedHistory(fixture, perWorktreeBytes, batches) {
  const { Archive } = await importCore('archive'), { TaskService } = await importCore('context'), { SearchIndex } = await importCore('index'), { digest, canonicalJson } = await importCore('json')
  const histories = []
  for (const worktree of [fixture.worktree, fixture.secondWorktree]) {
    const archive = new Archive(path.join(fixture.dataRoot, 'worktrees', worktree.id))
    const index = new SearchIndex(path.join(archive.root, 'index.sqlite'))
    const service = new TaskService({ worktree, archive, index, source: async () => ({ sourceVersion: { head: 'a'.repeat(40), treeHash: 'b'.repeat(64), status: 'clean' }, sourceScanRevision: 'c'.repeat(64) }) })
    const call = async (operation, taskId, input, flags = {}) => {
      const result = await service.execute({ schemaVersion: 1, operation, cwd: worktree.root, requestId: input?.requestId ?? randomUUID(), positionals: taskId ? [taskId] : [], flags, ...(input ? { input } : {}) }, fixture.skillsRoot)
      if (!result.ok) throw Object.assign(new Error('Synthetic task preparation failed'), { code: result.error.code, details: result.error.details })
      return result
    }
    let seed
    try {
      const entry = await call('task start', null, null, { title: 'Synthetic cumulative history' })
      const target = entry.data.directory.items[0].id
      await call('task select', entry.data.taskId, { schemaVersion: 1, requestId: randomUUID(), binding: entry.data.binding, context: { expand: [target], read: [target], known: {} }, skills: [{ id: entry.data.catalog[0].id, reason: 'Synthetic archive fixture' }] })
      for (let i = 1; i < batches; i++) await call('context query', entry.data.taskId, { schemaVersion: 1, requestId: randomUUID(), expectedModelRevision: entry.data.binding.modelRevision, expand: [target], read: [target], known: {} })
      await call('task close', entry.data.taskId)
      seed = await service.archivedTask(entry.data.taskId)
    } finally { await service.close() }
    const receipts = new Set(archive.headers({ kind: 'task', taskId: seed.id }).map(header => header.receiptHash))
    const references = archive.references({ kind: 'task', taskId: seed.id }).filter(reference => !receipts.has(reference.hash))
    const journal = path.join(archive.root, 'journal.jsonl')
    let bytes = (await lstat(journal)).size, tasks = 1, targetTask = seed
    while (bytes < perWorktreeBytes) {
      const task = structuredClone(seed)
      task.id = randomUUID()
      task.title = `Synthetic archived task ${tasks}`
      const batchIds = new Map(task.batches.map(batch => [batch.id, randomUUID()]))
      const planId = randomUUID()
      const remapPlan = plan => { if (plan) { plan.id = planId; plan.batchId = batchIds.get(plan.batchId) ?? plan.batchId } }
      for (const batch of task.batches) {
        batch.id = batchIds.get(batch.id); batch.requestId = randomUUID()
        if (batch.request && typeof batch.request === 'object') batch.request.requestId = batch.requestId
        if (batch.result) batch.result.batchId = batch.id
        remapPlan(batch.skillPlan)
      }
      remapPlan(task.skillPlan)
      const requestId = randomUUID(), seq = archive.seq + 1
      const materialized = { schemaVersion: 1, lastAppliedSeq: seq, task, contentHash: digest('task-projection', { lastAppliedSeq: seq, task }) }
      const receipt = { schemaVersion: 1, requestId, target: { projectId: worktree.projectId, worktreeId: worktree.id }, replayed: false, ok: true, data: { kind: 'handoff', status: 'complete', taskId: task.id, binding: task.binding, throughBatchId: task.batches.at(-1).id, completeness: 'complete', packet: task.packet, skillPlan: task.skillPlan, observation: 'archived-resources; understanding-and-execution-unknown' } }
      await archive.commit({ scope: `task:${task.id}`, requestId, request: { operation: 'synthetic-history-fixture', ordinal: tasks }, payload: { kind: 'task', task, operation: 'task close', source: 'cli' }, receipt, archives: references, materializations: [{ path: `tasks/${task.id}.json`, content: materialized }] })
      bytes = (await lstat(journal)).size
      tasks++; targetTask = task
    }
    histories.push({ worktreeId: worktree.id, tasks, batchesPerTask: batches, commits: archive.seq, journal, journalBytes: bytes, journalHash: await hashFile(journal), targetTaskId: targetTask.id, packetHash: createHash('sha256').update(canonicalJson({ packet: targetTask.packet, skillPlan: targetTask.skillPlan, binding: targetTask.binding })).digest('hex') })
  }
  return histories
}

async function probe(fixture, implementationRoot, warmSamples) {
  const startup = performance.now()
  const { startServer } = await import(pathToFileURL(path.join(implementationRoot, 'build/service/main.js')))
  let lifecycle
  const record = await new Promise((resolve, reject) => { lifecycle = startServer(fixture.dataRoot, 0, resolve); lifecycle.catch(reject) })
  const startupMs = performance.now() - startup
  const headers = { authorization: 'Bearer ' + record.token, 'x-harness-protocol': '1', 'content-type': 'application/json' }
  const cold = [], warm = []
  let firstHandoffFromStartMs = null
  let backgroundRecoveryWaitMs = 0
  try {
    const target = fixture.histories[0]
    const request = { operation: 'task handoff', cwd: fixture.root, positionals: [target.targetTaskId], flags: { worktree: target.worktreeId } }
    const { canonicalJson } = await import(pathToFileURL(path.join(implementationRoot, 'build/core/json.js')))
    for (let i = 0; i <= warmSamples; i++) {
      if (i === 1) {
        const waiting = performance.now()
        for (;;) {
          const health = await fetch(record.url + '/health', { headers, signal: AbortSignal.timeout(5000) }).then(response => response.json())
          if (health.recovery?.state === 'degraded' || health.recovery?.failures > 0) throw Object.assign(new Error('Background archive recovery is degraded'), { code: 'ARCHIVE_CORRUPT' })
          if (!health.recovery || health.recovery.state === 'complete') break
          await pause(100)
        }
        backgroundRecoveryWaitMs = performance.now() - waiting
      }
      const before = performance.now()
      const response = await fetch(record.url + '/rpc', { method: 'POST', headers, body: JSON.stringify({ ...request, requestId: randomUUID() }) })
      const body = await response.json()
      if (!body.ok || body.data?.kind !== 'handoff') throw Object.assign(new Error(body.error?.message ?? 'Historical RPC did not return a handoff'), { code: body.error?.code ?? 'HANDOFF_FAILED' })
      const actualHash = createHash('sha256').update(canonicalJson({ packet: body.data.packet, skillPlan: body.data.skillPlan, binding: body.data.binding })).digest('hex')
      if (actualHash !== target.packetHash) throw Object.assign(new Error('Historical RPC changed the original packet'), { code: 'HANDOFF_CHANGED' })
      ;(i === 0 ? cold : warm).push({ iteration: Math.max(0, i - 1), ok: true, ms: performance.now() - before, peakRSSBytes: peakRSS() })
      if (i === 0) firstHandoffFromStartMs = performance.now() - startup
    }
    return { ok: true, startupMs, firstHandoffFromStartMs, backgroundRecoveryWaitMs, cold, warm, peakRSSBytes: peakRSS() }
  } finally {
    const stopped = await fetch(record.url + '/stop', { method: 'POST', headers })
    await stopped.arrayBuffer()
    await lifecycle
  }
}

export async function runHistoryBenchmark(options = {}) {
  const historyMiB = options.historyMiB ?? 32, samples = options.samples ?? 3, batches = options.batches ?? 8
  if (!Number.isFinite(historyMiB) || historyMiB < 1 || historyMiB > 1024 || !Number.isSafeInteger(samples) || samples < 3 || samples > 10 || !Number.isSafeInteger(batches) || batches < 1 || batches > 50) throw new Error('history-mib: 1..1024, samples: 3..10, batches: 1..50')
  const base = await mkdtemp(path.join(os.tmpdir(), 'harnessl3-history-benchmark-'))
  const report = { schemaVersion: 1, synthetic: true, startedAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, totalMemoryBytes: os.totalmem(), freeMemoryBytesAtStart: os.freemem() }, methodology: { scope: 'Real service startup and authenticated HTTP handoff in a new Node process; not CLI adapter or browser latency.', cold: 'Fresh service process, existing derived index and warm OS caches after an unmeasured preparation run.', warm: 'Three further read-only requests after background recovery completes; its separate wait is excluded from warm timing.', input: 'Complete TaskService task/batch/catalog/packet/skill state fabricated from a real synthetic seed; no user history copied. Model size fixed at 40 objects; two real Git worktrees.', memory: 'Child process lifetime peak RSS includes imports, recovery and preceding requests; parent fixture construction is excluded.', sla: null }, histories: [], implementations: [] }
  let succeeded = false
  const output = path.resolve(options.output ?? path.join(root, '.harness-local/validation/history-benchmark.json'))
  const checkpoint = async () => { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n') }
  try {
    const { fixture } = await createFixture(base, 40)
    report.histories = await seedHistory(fixture, historyMiB * 1024 * 1024 / 2, batches)
    fixture.histories = report.histories
    const fixtureFile = path.join(base, 'history-fixture.json')
    await writeFile(fixtureFile, JSON.stringify(fixture))
    const implementations = options.compareRoot ? [path.resolve(options.compareRoot), root] : [root]
    for (const implementationRoot of implementations) {
      const group = { root: implementationRoot, runtimeFingerprint: null, preparation: null, runs: [], startup: null, readyAndFirstHandoff: null, coldHandoff: null, warmHandoff: null }
      try { group.runtimeFingerprint = JSON.parse(await readFile(path.join(implementationRoot, 'build/build-info.json'), 'utf8')).runtimeHash } catch { /* Older builds predate provenance metadata. */ }
      report.implementations.push(group)
      for (let i = -1; i < samples; i++) {
        process.stderr.write(`History benchmark: ${path.basename(implementationRoot)}, ${i < 0 ? 'preparation' : 'sample ' + (i + 1)}\n`)
        let run
        try {
          const { stdout } = await execFile(process.execPath, [ownFile, '--probe', fixtureFile, '--implementation-root', implementationRoot], { windowsHide: true, timeout: options.timeoutMs ?? 300_000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, HARNESSL3_HOME: '', HARNESS_SKILLS_ROOT: '' } })
          run = JSON.parse(stdout)
        } catch (error) {
          try { run = JSON.parse(error.stdout) }
          catch { run = { ok: false, errorCode: error.killed ? 'TIMEOUT' : error.code ?? 'PROBE_FAILED', message: error.message } }
        }
        if (i < 0) group.preparation = run
        else group.runs.push(run)
        await checkpoint()
        if (!run.ok) throw new Error('Historical service probe failed; fixture retained')
      }
      group.startup = summarizeSamples(group.runs.map((run, iteration) => ({ iteration, ok: true, ms: run.startupMs, peakRSSBytes: run.peakRSSBytes })))
      group.readyAndFirstHandoff = summarizeSamples(group.runs.map((run, iteration) => ({ iteration, ok: true, ms: run.firstHandoffFromStartMs, peakRSSBytes: run.peakRSSBytes })))
      group.coldHandoff = summarizeSamples(group.runs.flatMap(run => run.cold))
      group.warmHandoff = summarizeSamples(group.runs.flatMap(run => run.warm))
      for (const history of report.histories) if (await hashFile(history.journal) !== history.journalHash) throw new Error('Read-only benchmark changed authoritative history')
      await checkpoint()
    }
    report.finishedAt = new Date().toISOString(); report.authoritativeHistoryUnchanged = true; succeeded = true
    return report
  } finally {
    if (succeeded) {
      const actual = await realpath(base), relative = path.relative(await realpath(os.tmpdir()), actual)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(actual).startsWith('harnessl3-history-benchmark-')) throw new Error('Unsafe history benchmark cleanup target')
      try { await lstat(path.join(actual, 'scale-40/machine-data/service.lock')); throw new Error('Owned service has not stopped; fixture retained') } catch (error) { if (error.code !== 'ENOENT') throw error }
      await rm(actual, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } else report.retainedFixture = base
    await checkpoint()
  }
}

if (import.meta.main) {
  const args = {}
  for (let i = 2; i < process.argv.length; i += 2) { if (!process.argv[i]?.startsWith('--') || process.argv[i + 1] === undefined || Object.hasOwn(args, process.argv[i])) throw new Error('Use --name value arguments'); args[process.argv[i]] = process.argv[i + 1] }
  if (args['--probe']) {
    try { const fixture = JSON.parse(await readFile(args['--probe'], 'utf8')); console.log(JSON.stringify(await probe(fixture, path.resolve(args['--implementation-root']), 3))) }
    catch (error) { console.log(JSON.stringify({ ok: false, errorCode: error.code ?? 'PROBE_FAILED', message: error.message })); process.exitCode = 1 }
  } else {
    const report = await runHistoryBenchmark({ historyMiB: Number(args['--history-mib'] ?? 32), samples: Number(args['--samples'] ?? 3), batches: Number(args['--batches'] ?? 8), compareRoot: args['--compare-root'], output: args['--output'] })
    console.log(JSON.stringify({ output: args['--output'] ?? '.harness-local/validation/history-benchmark.json', journalBytes: report.histories.reduce((sum, history) => sum + history.journalBytes, 0), implementations: report.implementations.map(group => ({ root: group.root, startup: group.startup, readyAndFirstHandoff: group.readyAndFirstHandoff, coldHandoff: group.coldHandoff, warmHandoff: group.warmHandoff })) }))
  }
}
