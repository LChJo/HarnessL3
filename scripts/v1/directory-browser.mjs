import assert from 'node:assert/strict'
import { chromium } from 'playwright'

export async function verifyDirectoryBrowser(url, taskId) {
  const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined) })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const errors = [], disclosures = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => { if (request.url().endsWith('/rpc') && ['task start', 'context query', 'task select', 'task read'].includes(request.postDataJSON()?.operation)) disclosures.push(request.postDataJSON().operation) })
    await page.goto(url)
    await page.waitForFunction(id => document.querySelector('[data-task-id]')?.getAttribute('data-task-id') === id && !document.querySelector('.view-loading'), taskId)
    assert.match(await page.getByTestId('worktree-select').locator('option:checked').innerText(), /普通目录/)
    assert.equal(await page.locator('[data-category-root]').count(), 5)
    assert.equal(await page.locator('[data-output-count]').getAttribute('data-output-count'), '1')
    await page.getByRole('button', { name: '工作区详情', exact: true }).click()
    await page.getByText('未使用 Git', { exact: true }).waitFor()
    await page.getByRole('button', { name: '项目结构', exact: true }).click()
    await page.locator('[data-c4-node]').first().waitFor()
    await page.getByRole('button', { name: '历史任务', exact: true }).click()
    await page.locator(`[data-history-task="${taskId}"]`).waitFor()
    await page.locator(`[data-history-task="${taskId}"]`).click()
    await page.waitForFunction(() => !document.querySelector('.view-loading'))
    const hub = page.locator('[data-skill-selector="skill-hub"]')
    await hub.click()
    assert.equal(await hub.getAttribute('aria-expanded'), 'true')
    assert.deepEqual(errors, [])
    assert.deepEqual(disclosures, [], 'Browsing installed directory history/structure/skills cannot create agent reads')
    return { browser: await browser.version(), directoryLabel: true, noGitDetail: true, categories: 5, c4: true, history: true, skillHub: true, browsingDisclosures: disclosures.length, pageErrors: errors.length }
  } finally { await browser.close() }
}
