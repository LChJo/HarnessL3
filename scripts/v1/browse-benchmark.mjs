// Explicit read-only source histories are copied into a new isolated data root.
// Usage: node scripts/v1/browse-benchmark.mjs <existing-data-root> <report-directory> <baseline-runtime.js> <worktree-UUID>...
import { cp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Runtime } from '../../build/core/runtime.js'
import { randomUUID, createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { canonicalPath, isWithin } from '../../build/core/paths.js'

const [sourceRoot, reportRoot, oldPackage, ...targets] = process.argv.slice(2)
if (!sourceRoot || !reportRoot || !oldPackage || !targets.length || ![sourceRoot, reportRoot, oldPackage].every(path.isAbsolute)) throw Error('Supply explicit absolute source/report/baseline paths and target worktree UUIDs')
if (new Set(targets).size !== targets.length || targets.some(id => !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))) throw Error('Supply unique worktree UUIDs')
const sourcePath = await canonicalPath(sourceRoot), reportPath = await canonicalPath(reportRoot)
if (isWithin(sourcePath, reportPath) || isWithin(reportPath, sourcePath)) throw Error('Report and original history roots must be disjoint')
const registry = JSON.parse(await readFile(path.join(sourceRoot, 'registry.json'), 'utf8'))
const directory = path.join(reportRoot, 'isolated-' + randomUUID())
const selected = registry.worktrees.filter(item => targets.includes(item.id))
if (selected.length !== targets.length) throw Error('Every explicit target must exist in the source registry')
await mkdir(directory, { recursive: true })
await writeFile(path.join(directory, 'registry.json'), JSON.stringify({ ...registry, worktrees: selected, projects: registry.projects.filter(item => selected.some(tree => tree.projectId === item.id)) }))
const reports = []
const hashFile = async file => { const h=createHash('sha256'); for await (const b of createReadStream(file)) h.update(b); return h.digest('hex') }
const save = () => writeFile(path.join(reportRoot, 'benchmark.json'), JSON.stringify({ directory, conditions: 'Actual explicit history copies; one sample per condition, sequential execution with warm OS cache. Preparation is excluded; no SLA or cross-platform claim.', reports }, null, 2))
const { Runtime: BaselineRuntime } = await import(pathToFileURL(oldPackage).href)
for (const target of selected) {
  const original = path.join(sourceRoot, 'worktrees', target.id), copied = path.join(directory, 'worktrees', target.id)
  console.log(JSON.stringify({ stage: 'copy', id: target.id }))
  await mkdir(copied, { recursive: true })
  for (const name of ['journal.jsonl', 'snapshots', 'skill-blobs']) await cp(path.join(original, name), path.join(copied, name), { recursive: true, errorOnExist: true })
  const sourceHash = await hashFile(path.join(original, 'journal.jsonl'))
  const report = { id: target.id, journalBytes: (await stat(path.join(copied, 'journal.jsonl'))).size, sourceHash, samples: [] }
  reports.push(report); await save()
  for (const [label, Constructor] of [['baseline-first-list-and-view', BaselineRuntime], ['candidate-no-locator-cache', Runtime], ['candidate-cold-runtime-with-locators', Runtime]]) {
    const runtime = new Constructor(directory)
    if (label === 'candidate-no-locator-cache') await rm(path.join(copied, 'browse-index.json'), { force: true })
    const pulse = setInterval(() => console.log(JSON.stringify({ stage: 'working', id: target.id, label })), 10000); pulse.unref()
    try {
      const request = { operation: 'task list', positionals: [], flags: { worktree: target.id, limit: '50' }, source: 'web', cwd: directory, requestId: randomUUID() }
      const start = performance.now(), listed = await runtime.execute(request), listMs = performance.now() - start
      if (!listed.ok) throw Error(JSON.stringify(listed))
      const task = listed.data.result.items[0]
      if (!task) throw Error('No currently visible task for the explicit history')
      const viewStart = performance.now(), viewed = await runtime.view(target.id, task.id), viewMs = performance.now() - viewStart
      report.samples.push({ label, taskId: task.id, listMs, viewMs, totalMs: performance.now() - start, modelRevision: viewed.model.revision, taskHash: createHash('sha256').update(JSON.stringify(viewed.task)).digest('hex'), contexts: viewed.task.packet.contexts.length })
      console.log(JSON.stringify({ stage: 'sample', id: target.id, ...report.samples.at(-1) })); await save()
    } finally { clearInterval(pulse); await runtime.close() }
  }
  report.copyUnchanged = sourceHash === await hashFile(path.join(copied, 'journal.jsonl'))
  report.sourceUnchanged = sourceHash === await hashFile(path.join(original, 'journal.jsonl'))
  await save()
}
console.log(JSON.stringify({ stage: 'complete', report: path.join(reportRoot, 'benchmark.json') }))
