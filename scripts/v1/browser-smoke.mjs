import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile as callbackExecFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { createBrowserFixture, browserIds } from './browser-fixture.mjs'
import { Archive } from '../../build/core/archive.js'
import { closePackedArchive } from '../../build/core/packed-archive.js'

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
    const archive = new Archive(path.join(fixture.dataRoot, 'worktrees', fixture.target.worktreeId), { readOnly: true, verification: 'operational' })
    await archive.ready()
    const header = archive.lastHeader({ requestId })
    const commit = header ? await archive.record(header.seq) : null
    closePackedArchive(fixture.dataRoot)
    assert.ok(commit)
    samples.push({ requestId, committedAt: commit.committedAt, paintedAt: new Date(paintedAt).toISOString(), milliseconds: paintedAt - Date.parse(commit.committedAt) })
  }
  const times = samples.map(sample => sample.milliseconds).sort((a, b) => a - b)
  // Explicit registration links two legacy project IDs; source and archived task bindings stay separate.
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  const otherRoot = (await fixture.cli(['worktree', 'show', fixture.other.worktreeId])).data.result.worktree.root
  for (const directory of [fixture.root, otherRoot]) {
    await execFile('git', ['-C', directory, 'remote', 'add', 'origin', 'git@example.invalid:team/shared.git'], { windowsHide: true })
    await fixture.cli(['worktree', 'register', directory], directory)
  }
  const grouped = (await fixture.cli(['project', 'list'])).data.result.items
  assert.equal(grouped.length, 1)
  assert.ok(grouped[0].memberProjectIds.includes(fixture.other.projectId))
  await page.reload()
  await page.getByTestId('project-select').waitFor()
  await page.waitForFunction(() => document.querySelector('[data-testid="worktree-select"]')?.options.length === 3)
  assert.equal(await page.getByTestId('project-select').locator('option').count(), 1)
  assert.equal(await page.getByTestId('project-select').inputValue(), grouped[0].id)
  const waitWorktree = id => page.waitForFunction(id => document.querySelector('[data-route-worktree]')?.getAttribute('data-route-worktree') === id && !document.querySelector('.view-loading'), id)
  await page.getByTestId('worktree-select').selectOption(fixture.other.worktreeId)
  await waitWorktree(fixture.other.worktreeId)
  assert.equal(await page.getByTestId('project-select').inputValue(), grouped[0].id)
  // Selectors replace the current URL; retain an explicit navigation entry for popstate coverage.
  await page.evaluate(() => history.pushState(null, '', location.href))
  await page.getByTestId('worktree-select').selectOption(fixture.target.worktreeId)
  await waitWorktree(fixture.target.worktreeId)
  await page.goBack()
  await waitWorktree(fixture.other.worktreeId)
  assert.equal(await page.getByTestId('project-select').inputValue(), grouped[0].id)
  await page.reload()
  await waitWorktree(fixture.other.worktreeId)
  assert.equal(await page.getByTestId('project-select').inputValue(), grouped[0].id)
  assert.deepEqual(pageErrors, [])
  const gitProjectGrouping = { projects: 1, worktrees: 3, legacyIdsRetained: true, crossCloneNavigation: true, backAndReload: true }
  const report = { platform: process.platform, node: process.version, browser: await browser.version(), crlfSeed: fixture.crlfSeed, gates, eventDisplay: { definition: 'journal committedAt to two requestAnimationFrame callbacks after exact output count is visible; same machine wall clock, includes refresh and paint scheduling', samples, p50: times[Math.ceil(times.length * .5) - 1], p95: times[Math.ceil(times.length * .95) - 1] } }
  const reports = path.join(root, '.harness-local', 'validation')
  await mkdir(reports, { recursive: true })
  await page.screenshot({ path: path.join(reports, `git-project-grouping-${process.platform}.png`) })
  await writeFile(path.join(reports, `browser-${process.platform}.json`), JSON.stringify({ ...report, gitProjectGrouping }, null, 2) + '\n')
  console.log(JSON.stringify({ platform: process.platform, browser: report.browser, crlfSeed: fixture.crlfSeed, gates: gates.results.length, eventDisplaySamples: times.length, p50: report.eventDisplay.p50, p95: report.eventDisplay.p95 }))
} finally { await browser?.close(); await fixture.stop() }
