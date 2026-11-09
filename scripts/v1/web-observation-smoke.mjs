import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import { createBrowserFixture } from './browser-fixture.mjs'

const fixture = await createBrowserFixture()
let browser
const output = '.harness-local/validation/observe-incremental'
try {
  await mkdir(output, { recursive: true })
  browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = [], views = [], lists = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/view') views.push(new URL(request.url()).search)
    if (new URL(request.url()).pathname === '/rpc') { const command = request.postDataJSON(); if (command.operation === 'task list') lists.push(command.flags.worktree) }
  })
  const ready = async (worktree, task) => page.waitForFunction(({ worktree, task }) => {
    const shell = document.querySelector('[data-testid="app-shell"]')
    return shell?.getAttribute('data-route-worktree') === worktree && (shell?.getAttribute('data-task-id') || null) === task && !!document.querySelector('[data-view-ready="true"]') && !document.querySelector('.view-loading')
  }, { worktree, task })
  const archivePath = path.join(fixture.dataRoot, 'worktrees', fixture.target.worktreeId, 'tasks', fixture.entry.taskId + '.json')
  const before = await readFile(archivePath)
  await page.goto(await fixture.url(fixture.entry.taskId))
  await ready(fixture.target.worktreeId, fixture.entry.taskId)
  await page.getByRole('combobox', { name: '选择项目', exact: true }).selectOption(fixture.other.projectId)
  await ready(fixture.other.worktreeId, null)
  const returnStart = performance.now()
  const beforeReturn = views.length
  const beforeLists = lists.filter(id => id === fixture.target.worktreeId).length
  await page.getByRole('combobox', { name: '选择项目', exact: true }).selectOption(fixture.target.projectId)
  await ready(fixture.target.worktreeId, fixture.entry.taskId)
  const returnMs = Math.round(performance.now() - returnStart)
  assert.equal(views.length - beforeReturn, 1, 'returning to a project requests its remembered task exactly once')
  assert.equal(lists.filter(id => id === fixture.target.worktreeId).length - beforeLists, 1, 'resolving the default task reuses its already loaded list')
  assert.equal(await page.getByTestId('history-fixed').count(), 1)
  assert.deepEqual(await readFile(archivePath), before, 'browsing cannot rewrite the task or renew its reads')
  // A new task elsewhere in the project only signals an update to this fixed history.
  await page.waitForFunction(() => document.querySelector('[data-testid="connection-status"]')?.getAttribute('data-state') === 'connected')
  const viewCount = views.length
  await fixture.cli(['task', 'start', '--title', 'New task while reviewing fixed history'])
  await page.getByTestId('history-update').waitFor()
  assert.equal(views.length, viewCount)
  assert.equal(await page.getByTestId('app-shell').getAttribute('data-task-id'), fixture.entry.taskId)
  await page.getByRole('combobox', { name: '选择工作区', exact: true }).selectOption(fixture.linked.worktreeId)
  await ready(fixture.linked.worktreeId, null)
  await page.getByRole('combobox', { name: '选择项目', exact: true }).selectOption(fixture.other.projectId)
  await ready(fixture.other.worktreeId, null)
  await page.getByRole('combobox', { name: '选择项目', exact: true }).selectOption(fixture.target.projectId)
  await ready(fixture.linked.worktreeId, null)
  await page.screenshot({ path: path.join(output, 'empty-recorded-workspace.png'), fullPage: true })
  // A fresh browser session without an explicit task picks the latest recorded task.
  const fresh = await browser.newPage()
  await fresh.goto(await fixture.url(null))
  await fresh.waitForFunction(() => !!document.querySelector('[data-task-id]')?.getAttribute('data-task-id') && !document.querySelector('.view-loading'))
  assert.match(await fresh.getByRole('heading', { level: 1 }).innerText(), /New task while reviewing fixed history/)
  assert.deepEqual(errors, [])
  const result = { platform: process.platform, node: process.version, browser: await browser.version(), returnMs, rememberedTaskRequests: 1, taskListRequests: 1, remembersWorktree: true, emptyWorktree: true, historyUnchanged: true, frozenHistorySignalsOnly: true, defaultsToLatest: true, errors }
  await writeFile(path.join(output, 'browser.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
} finally { await browser?.close(); await fixture.stop() }
