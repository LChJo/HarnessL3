import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile as callbackExecFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { createBrowserFixture, browserIds } from './browser-fixture.mjs'

const execFile = promisify(callbackExecFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixture = await createBrowserFixture()
let browser
try {
  const descriptor = path.join(fixture.directory, 'browser-fixture.json')
  await writeFile(descriptor, JSON.stringify({ directory: fixture.directory, dataRoot: fixture.dataRoot, root: fixture.root, crlfSeed: fixture.crlfSeed, target: fixture.target, linked: fixture.linked, other: fixture.other, entry: fixture.entry, current: fixture.current, legacy: fixture.legacy, origin: fixture.origin, firstBatch: fixture.selected.result.batchId }))
  const checked = await execFile(process.execPath, [path.join(root, 'web/verify-all.mjs'), descriptor], { cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
  const gates = JSON.parse(checked.stdout)
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const entry = (await fixture.cli(['task', 'start', '--title', 'Fixture: commit to painted output'])).data
  await page.goto(await fixture.url(entry.taskId))
  await page.getByTestId('app-shell').waitFor()
  await page.waitForFunction(id => document.querySelector('[data-task-id]')?.getAttribute('data-task-id') === id && !document.querySelector('.view-loading'), entry.taskId)
  const samples = []
  for (const [index, id] of [browserIds.client, browserIds.output, browserIds.task].entries()) {
    const requestId = randomUUID()
    await fixture.json('context query', entry.taskId, { schemaVersion: 1, requestId, expectedModelRevision: entry.binding.modelRevision, expand: [], read: [id], known: {} })
    await page.waitForFunction(count => Number(document.querySelector('[data-output-count]')?.getAttribute('data-output-count')) === count, index + 1)
    const paintedAt = await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(Date.now())))))
    const commits = (await readFile(path.join(fixture.dataRoot, 'worktrees', fixture.target.worktreeId, 'journal.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const commit = commits.find(record => record.requestId === requestId)
    assert.ok(commit)
    samples.push({ requestId, committedAt: commit.committedAt, paintedAt: new Date(paintedAt).toISOString(), milliseconds: paintedAt - Date.parse(commit.committedAt) })
  }
  const times = samples.map(sample => sample.milliseconds).sort((a, b) => a - b)
  const report = { platform: process.platform, node: process.version, browser: await browser.version(), crlfSeed: fixture.crlfSeed, gates, eventDisplay: { definition: 'journal committedAt to two requestAnimationFrame callbacks after exact output count is visible; same machine wall clock, includes refresh and paint scheduling', samples, p50: times[Math.ceil(times.length * .5) - 1], p95: times[Math.ceil(times.length * .95) - 1] } }
  const reports = path.join(root, '.harness-local', 'validation')
  await mkdir(reports, { recursive: true })
  await writeFile(path.join(reports, `browser-${process.platform}.json`), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ platform: process.platform, browser: report.browser, crlfSeed: fixture.crlfSeed, gates: gates.results.length, eventDisplaySamples: times.length, p50: report.eventDisplay.p50, p95: report.eventDisplay.p95 }))
} finally { await browser?.close(); await fixture.stop() }
