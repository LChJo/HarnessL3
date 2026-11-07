import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { createBrowserFixture } from './browser-fixture.mjs'

const fixture = await createBrowserFixture()
let browser, page, release
const gate = new Promise(resolve => { release = resolve })
try {
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined) })
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = [], aborted = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('requestfailed', request => { if (new URL(request.url()).pathname === '/view') aborted.push(request.failure()?.errorText) })
  let requests = 0, firstArrived
  const arrived = new Promise(resolve => { firstArrived = resolve })
  await page.route('**/view?*', async route => {
    const ordinal = ++requests
    if (ordinal === 1) { firstArrived(); await gate }
    const response = await route.fetch()
    await route.fulfill({ response }).catch(() => {})
  })
  const start = performance.now()
  await page.goto(await fixture.url(fixture.entry.taskId))
  await arrived
  await page.waitForFunction(() => document.querySelector('[data-testid="connection-status"]')?.getAttribute('data-state') === 'connected')
  // The SSE reset schedules its refresh after 100ms. Keep the first view
  // response pending across that event, as with a slow archive on disk.
  await page.waitForTimeout(350)
  const pending = {
    requests, aborted: [...aborted],
    inputVisible: await page.locator('.input-card').isVisible(),
    outputVisible: await page.locator('.output-card').isVisible(),
    loadingVisible: await page.getByTestId('initial-view-loading').isVisible(),
  }
  console.log(JSON.stringify({ phase: 'pending-first-view', ...pending }))
  assert.deepEqual(pending, { requests: 1, aborted: [], inputVisible: false, outputVisible: false, loadingVisible: true }, 'initial SSE refresh must preserve the first request and show loading instead of an empty task')
  release()
  await page.waitForFunction(id => document.querySelector('[data-task-id]')?.getAttribute('data-task-id') === id && !document.querySelector('.view-loading'), fixture.entry.taskId)
  assert.equal(await page.locator('[data-output-count]').getAttribute('data-output-count'), '2')
  assert.equal(await page.locator('[data-category-root]').count(), 5)
  assert.equal(await page.locator('[data-map-depth="1"]').count(), 0)
  assert.equal(await page.locator('[data-skill-folder]').count(), 0)
  assert.deepEqual(errors, [])
  await mkdir('.harness-local/validation', { recursive: true })
  await page.screenshot({ path: '.harness-local/validation/web-loading-fixed.png', fullPage: true })
  const report = { platform: process.platform, node: process.version, browser: await browser.version(), pending, requests, aborted, errors, readyMsIncludingInjectedDelay: Math.round(performance.now() - start) }
  await writeFile('.harness-local/validation/web-loading-browser.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally {
  release()
  await page?.unrouteAll({ behavior: 'ignoreErrors' })
  await browser?.close()
  await fixture.stop()
}
