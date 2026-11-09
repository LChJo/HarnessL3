// Opt-in read-only comparison: all recovery/index writes use a verified temporary copy.
import { mkdtemp, mkdir, readFile, writeFile, readdir, copyFile, lstat, realpath, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { Runtime } from '../../build/core/runtime.js'
import { observeSourcePaths } from '../../build/core/source.js'
import { sha256 } from '../../build/core/json.js'

const [sourceDataRoot, worktreeId] = process.argv.slice(2)
if (!sourceDataRoot || !/^[a-f0-9-]{36}$/.test(worktreeId ?? '')) throw new Error('Usage: observe-benchmark.mjs <existing-data-root> <worktree-id>')
const temporary = await mkdtemp(path.join(tmpdir(), 'harnessl3-observe-bench-'))
const temporaryReal = await realpath(temporary)
const dataRoot = path.join(temporaryReal, 'data')
const original = path.join(sourceDataRoot, 'worktrees', worktreeId)
const copied = path.join(dataRoot, 'worktrees', worktreeId)
const output = '.harness-local/validation/observe-incremental'
let runtime
const result = { platform: process.platform, node: process.version, samples: [], setup: {}, limitations: ['One sample per operation; copied archive with a newly rebuilt compact index, not an in-place update of the installed service.'] }
async function measure(name, operation) {
  const start = performance.now(), details = await operation()
  const sample = { name, ms: Math.round(performance.now() - start), details }
  result.samples.push(sample); console.log(JSON.stringify(sample))
  return details
}
async function regular(file) { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Only regular archive files may be copied'); }
try {
  await mkdir(copied, { recursive: true })
  await regular(path.join(sourceDataRoot, 'registry.json'))
  await copyFile(path.join(sourceDataRoot, 'registry.json'), path.join(dataRoot, 'registry.json'))
  await regular(path.join(original, 'journal.jsonl'))
  const journal = await readFile(path.join(original, 'journal.jsonl'))
  await writeFile(path.join(copied, 'journal.jsonl'), journal)
  result.setup = { journalBytes: journal.length, journalHash: sha256(journal), copiedFiles: 0 }
  for (const directory of ['snapshots', 'skill-blobs']) {
    const from = path.join(original, directory)
    if ((await lstat(from)).isSymbolicLink()) throw new Error('Archive directory links are not copied')
    await mkdir(path.join(copied, directory))
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Unexpected archive entry')
      await copyFile(path.join(from, entry.name), path.join(copied, directory, entry.name))
      result.setup.copiedFiles++
    }
  }
  runtime = new Runtime(dataRoot)
  const worktree = await runtime.registry().worktree(worktreeId)
  await measure('cold-copied-workspace-view', async () => { const view = await runtime.view(worktreeId); return { seq: view.seq, model: view.modelState.state } })
  const resource = await runtime.worktreeResources(worktree)
  resource.freshness.status = () => { throw new Error('Browsing attempted a complete source scan') }
  const before = sha256(await readFile(path.join(copied, 'journal.jsonl')))
  await measure('warm-workspace-view', async () => { const view = await runtime.view(worktreeId); return { seq: view.seq } })
  const task = resource.tasks.tasks().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  if (task) await measure('warm-recorded-task-view', async () => { const view = await runtime.view(worktreeId, task.id); return { taskId: view.task.id, batches: view.task.batches.length } })
  await measure('compact-task-list', async () => { const response = await runtime.execute({ operation: 'task list', positionals: [], flags: { worktree: worktreeId }, cwd: dataRoot, requestId: crypto.randomUUID() }); if (!response.ok) throw new Error(response.error.message); return { tasks: response.data.result.items.length } })
  result.compactIndexBytes = (await stat(path.join(copied, 'index.sqlite'))).size
  result.copiedJournalUnchanged = sha256(await readFile(path.join(copied, 'journal.jsonl'))) === before
  result.originalJournalUnchanged = sha256(await readFile(path.join(original, 'journal.jsonl'))) === result.setup.journalHash
  await measure('targeted-readme-observation', async () => { const observed = await observeSourcePaths(worktree, ['README.md'], resource.freshness.currentState().sourceEpoch); return { paths: observed.paths.length, entries: observed.entries.length, requiresFullScan: observed.requiresFullScan } })
  await mkdir(output, { recursive: true })
  await writeFile(path.join(output, 'copied-history-benchmark.json'), JSON.stringify(result, null, 2) + '\n')
} finally {
  await runtime?.close()
  if (await realpath(temporary) !== temporaryReal || path.dirname(temporaryReal) !== await realpath(tmpdir()) || !path.basename(temporaryReal).startsWith('harnessl3-observe-bench-')) throw new Error('Unsafe benchmark cleanup target')
  await rm(temporaryReal, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
