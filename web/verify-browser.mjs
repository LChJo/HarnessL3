import assert from 'node:assert/strict'
import { chromium } from 'playwright'

/** Read-only smoke entry. Pass an isolated service URL, optionally with its one-use #code. */
export async function verifyCanvas(page, url) {
  const disclosures = []
  page.on('request', request => {
    if (!request.url().endsWith('/rpc') || request.method() !== 'POST') return
    const operation = request.postDataJSON()?.operation
    if (['task start', 'task select', 'context query', 'task read'].includes(operation)) disclosures.push(operation)
  })
  await page.goto(url)
  await page.getByTestId('app-shell').waitFor({ state: 'visible', timeout: 10000 })
  await page.getByTestId('project-select').waitFor({ state: 'visible', timeout: 10000 })
  await page.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-route-worktree') && !document.querySelector('.view-loading'))
  assert.equal(await page.locator('.empty-workspace,.error-banner').count(), 0, 'real target must load without a service error')
  assert.equal(await page.locator('[data-category-root]').count(), 5)
  assert.equal(await page.locator('[data-map-depth="1"]').count(), 0)
  const hub = page.locator('[data-skill-selector="skill-hub"]')
  assert.equal(await hub.getAttribute('aria-expanded'), 'false')
  await hub.click()
  assert.equal(await hub.getAttribute('aria-expanded'), 'true')
  assert.equal(await page.locator('[data-skill-id]').count(), 0, 'first disclosure shows folders only')
  await page.getByRole('button', { name: '收起全部层级', exact: true }).click()
  assert.equal(await hub.getAttribute('aria-expanded'), 'false')
  const world = page.locator('.world')
  const previousScale = await world.getAttribute('data-camera-scale')
  await page.getByRole('button', { name: '放大画布', exact: true }).click()
  assert.notEqual(await world.getAttribute('data-camera-scale'), previousScale)
  assert.deepEqual(disclosures, [], 'browsing and canvas controls must never create retrievals')
  return { categories: 5, initialChildren: 0, hub: 'folder-first', browsingDisclosures: disclosures.length }
}

if (process.argv[1]?.endsWith('verify-browser.mjs')) {
  const url = process.argv[2]
  if (!url) throw new Error('Usage: node web/verify-browser.mjs <isolated-service-url[#code=...]>')
  const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined) })
  try { const page = await browser.newPage(); console.log(JSON.stringify(await verifyCanvas(page, url))) }
  finally { await browser.close() }
}
