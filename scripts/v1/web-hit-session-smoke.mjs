import assert from 'node:assert/strict'
import { writeFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { createBrowserFixture, browserIds } from './browser-fixture.mjs'

const fixture = await createBrowserFixture()
let browser
try {
  const entry = (await fixture.cli(['task', 'start', '--title', 'Return the parent object itself'])).data
  await fixture.json('task select', entry.taskId, { schemaVersion: 1, requestId: randomUUID(), binding: entry.binding, context: { expand: [], read: [browserIds.app], known: {} }, skills: [] })
  const before = (await fixture.cli(['task', 'show', entry.taskId])).data.result.task
  const original = await fixture.url(entry.taskId)
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined) })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  const page = await context.newPage(), errors = [], logins = [], mutations = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => { if (new URL(response.url()).pathname === '/session') logins.push(response.status()) })
  page.on('request', request => { if (new URL(request.url()).pathname === '/rpc' && ['task select', 'context query', 'task read'].includes(request.postDataJSON()?.operation)) mutations.push(request.postDataJSON().operation) })
  const ready = async target => {
    await target.waitForFunction(id => document.querySelector('[data-task-id]')?.getAttribute('data-task-id') === id && document.querySelector('[data-view-ready="true"]') && !document.querySelector('.view-loading'), entry.taskId)
  }
  await page.goto(original)
  await ready(page)
  const cookieBefore = (await context.cookies(fixture.origin)).find(cookie => cookie.name === 'harnessl3_session')
  await page.locator('[data-category-root="objects"] .map-main').click()
  await page.locator(`[data-node-id="object:${browserIds.app}"] .map-main`).click()
  await page.getByRole('button', { name: '概览全部内容', exact: true }).click()
  const leafId = 'body:object:' + browserIds.app
  const leaf = page.locator(`[data-node-id="${leafId}"]`)
  assert.equal(await leaf.count(), 1)
  assert.equal(await leaf.getAttribute('data-state'), 'returned')
  assert.match(await leaf.getAttribute('class'), /is-hit/)
  assert.equal(await page.locator('[data-category-root="objects"]').getAttribute('data-hit-count'), '1')
  assert.equal(await page.locator(`[data-node-overflow="object:${browserIds.app}"]`).count(), 1)
  assert.equal(await page.locator(`[data-node-id="object:${browserIds.network}"]`).count(), 0)
  assert.match(await page.locator(`[data-edge-kind="output"][data-edge-source="${leafId}"]`).getAttribute('class'), /is-hit/)
  await leaf.locator('.map-main').click()
  await page.getByRole('dialog').waitFor()
  assert.equal(await page.locator('.exact-body').count(), 1, 'The body leaf must open the actual returned parent details')
  assert.ok((await page.getByRole('dialog').innerText()).includes(browserIds.app))
  await page.getByRole('button', { name: '关闭详情', exact: true }).click()
  await mkdir('.harness-local/validation', { recursive: true })
  await page.screenshot({ path: '.harness-local/validation/hit-session-parent-body.png' })
  await page.goto(original)
  await ready(page)
  const cookieAfter = (await context.cookies(fixture.origin)).find(cookie => cookie.name === 'harnessl3_session')
  assert.deepEqual(cookieAfter, cookieBefore, 'Reopening must reuse the same cookie and expiry')
  assert.deepEqual(logins, [200, 200])
  await page.reload()
  await ready(page)
  const anonymous = await browser.newContext({ viewport: { width: 900, height: 700 } })
  const signedOut = await anonymous.newPage()
  await signedOut.goto(original)
  await signedOut.getByTestId('session-required').waitFor()
  assert.ok(!(await signedOut.locator('body').innerText()).includes('本机服务不可用'))
  const target = new URL(signedOut.url()).searchParams
  assert.equal(target.get('worktree'), fixture.target.worktreeId)
  assert.equal(target.get('task'), entry.taskId)
  assert.equal(new URL(signedOut.url()).hash, '', 'The spent credential must not remain in the address bar')
  await signedOut.screenshot({ path: '.harness-local/validation/hit-session-auth-required.png' })
  await signedOut.reload()
  await signedOut.getByTestId('session-required').waitFor()
  await signedOut.goto(await fixture.url(entry.taskId))
  await ready(signedOut)
  const after = (await fixture.cli(['task', 'show', entry.taskId])).data.result.task
  assert.deepEqual(after, before)
  assert.deepEqual(mutations, [])
  assert.deepEqual(errors, [])
  const report = { platform: process.platform, browser: process.env.BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chromium'), directParentHitLeaf: true, categoryCount: 1, unmatchedChildren: 2, exactParentDetails: true, outputPath: true, repeatedOriginalLink: logins, sessionCookieUnchanged: true, reload: true, signedOutErrorAccurate: true, targetPreserved: true, freshLinkRecovery: true, taskUnchanged: true, pageErrors: errors }
  await writeFile('.harness-local/validation/hit-session-browser.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally { await browser?.close(); await fixture.stop() }
