import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { createBrowserFixture } from './browser-fixture.mjs'

const fixture = await createBrowserFixture()
const reportRoot = '.harness-local/validation/web-login-recovery'
await mkdir(reportRoot, { recursive: true })
let browser
try {
  const before = (await fixture.cli(['task', 'show', fixture.entry.taskId])).data.result.task
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined) })
  const errors = []
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  const ready = async target => {
    await target.waitForFunction(id => document.querySelector('[data-task-id]')?.getAttribute('data-task-id') === id && document.querySelector('[data-view-ready="true"]') && !document.querySelector('.view-loading'), fixture.entry.taskId)
  }
  const original = await fixture.url()
  let calls = 0
  await page.route('**/session', route => ++calls === 1 ? route.abort('connectionreset') : route.continue())
  await page.goto(original)
  await page.getByTestId('session-required').waitFor()
  assert.match(await page.getByTestId('session-required').innerText(), /登录未完成/)
  assert.equal(page.url(), original, 'an interrupted first request must preserve the original link')
  await page.screenshot({ path: reportRoot + '/interrupted.png' })
  await page.getByRole('button', { name: '重试登录', exact: true }).click()
  await ready(page)
  assert.equal(new URL(page.url()).hash, '')
  assert.equal(new URL(page.url()).searchParams.get('task'), fixture.entry.taskId)
  assert.equal(new URL(page.url()).searchParams.get('worktree'), fixture.target.worktreeId)
  const cookieBefore = await context.cookies(fixture.origin)
  await page.goto(original)
  await ready(page)
  assert.deepEqual(await context.cookies(fixture.origin), cookieBefore, 'reopening must neither rotate nor extend the session')
  await page.screenshot({ path: reportRoot + '/recovered.png' })

  const confirmationContext = await browser.newContext()
  const confirmation = await confirmationContext.newPage()
  confirmation.on('pageerror', error => errors.push(error.message))
  const confirmationUrl = await fixture.url()
  let confirmations = 0
  await confirmation.route('**/session', route => ++confirmations === 2 ? route.abort('connectionreset') : route.continue())
  await confirmation.goto(confirmationUrl)
  await confirmation.getByTestId('session-required').waitFor()
  assert.equal(confirmation.url(), confirmationUrl)
  const issuedCookie = await confirmationContext.cookies(fixture.origin)
  assert.equal(issuedCookie.length, 1)
  await confirmation.getByRole('button', { name: '重试登录', exact: true }).click()
  await ready(confirmation)
  assert.deepEqual(await confirmationContext.cookies(fixture.origin), issuedCookie, 'retry after cookie issuance reuses the session')

  const replacementContext = await browser.newContext()
  const replacement = await replacementContext.newPage()
  replacement.on('pageerror', error => errors.push(error.message))
  let replacements = 0
  await replacement.route('**/session', route => ++replacements === 1 ? route.abort('connectionreset') : route.continue())
  await replacement.goto(await fixture.url())
  await replacement.getByTestId('session-required').waitFor()
  assert.ok(new URL(replacement.url()).hash)
  await replacement.goto(await fixture.url())
  await ready(replacement)
  assert.equal(new URL(replacement.url()).hash, '', 'a fresh fragment in the same document must restart sign-in')

  const missingCookieContext = await browser.newContext()
  const missingCookie = await missingCookieContext.newPage()
  missingCookie.on('pageerror', error => errors.push(error.message))
  const missingCookieUrl = await fixture.url()
  let withoutCookie = 0
  await missingCookie.route('**/session', async route => {
    if (++withoutCookie === 2) {
      await missingCookieContext.clearCookies()
      const headers = { ...route.request().headers() }
      delete headers.cookie
      await route.continue({ headers })
    } else await route.continue()
  })
  await missingCookie.goto(missingCookieUrl)
  await missingCookie.getByTestId('session-required').waitFor()
  assert.match(await missingCookie.getByTestId('session-required').innerText(), /Cookie/)
  assert.equal(new URL(missingCookie.url()).hash, '')
  assert.equal(new URL(missingCookie.url()).searchParams.get('task'), fixture.entry.taskId)
  await missingCookie.screenshot({ path: reportRoot + '/missing-cookie.png' })
  await missingCookie.unroute('**/session')
  await missingCookie.goto(await fixture.url())
  await ready(missingCookie)
  assert.equal(new URL(missingCookie.url()).searchParams.get('task'), fixture.entry.taskId)

  const after = (await fixture.cli(['task', 'show', fixture.entry.taskId])).data.result.task
  assert.deepEqual(after, before, 'login and browser inspection must not change task records')
  assert.deepEqual(errors, [])
  const report = { platform: process.platform, browser: process.env.BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chromium'), interruptedRequestRetry: true, interruptedConfirmationRetry: true, sameDocumentFreshLinkRecovery: true, missingCookieExplained: true, freshLinkRecovery: true, successfulLoginClearsCode: true, rejectedCodeCleared: true, targetPreserved: true, repeatedLinkKeepsCookie: true, taskUnchanged: true, pageErrors: errors }
  await writeFile(reportRoot + '/browser.json', JSON.stringify(report, null, 2) + '\n')
  process.stdout.write(JSON.stringify(report) + '\n')
} finally { await browser?.close(); await fixture.stop() }
