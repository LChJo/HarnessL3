import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { createBrowserFixture } from './browser-fixture.mjs'

const fixture = await createBrowserFixture()
let browser
try {
  const validReason = '与 HEAD 比较，核对规格、標準和实现 🙂'
  const damagedReason = '??HEAD??????????????????????????????'
  const reasons = [validReason, damagedReason, 'Review ?? and ?. operators']
  const ids = ['quality/code-review', 'quality/diagnosing-bugs', 'quality/tdd']
  const entry = (await fixture.cli(['task', 'start', '--title', 'UTF-8 reasons and self-contained skill archives'])).data
  await fixture.json('task select', entry.taskId, { schemaVersion: 1, requestId: randomUUID(), binding: entry.binding, context: { expand: [], read: [], known: {} }, skills: ids.map((id, index) => ({ id, reason: reasons[index] })) })
  const before = (await fixture.cli(['task', 'show', entry.taskId])).data.result.task
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined) })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(await fixture.url(entry.taskId))
  await page.waitForFunction(id => document.querySelector('[data-task-id]')?.getAttribute('data-task-id') === id && document.querySelector('[data-view-ready="true"]') && !document.querySelector('.view-loading'), entry.taskId)
  await page.getByRole('button', { name: '查看技能方案', exact: true }).click()
  const details = page.getByTestId('skill-details')
  assert.equal(await details.locator('[data-skill-detail="quality/code-review"] .skill-reason').innerText(), '选择理由：' + validReason)
  const damaged = details.locator('[data-skill-detail="quality/diagnosing-bugs"]')
  assert.equal(await damaged.locator('.skill-reason').innerText(), '选择理由：原记录可能存在编码损坏')
  await damaged.getByText('查看理由原文', { exact: true }).click()
  assert.equal(await damaged.locator('.skill-reason-raw pre').innerText(), damagedReason)
  assert.equal(await details.locator('[data-skill-detail="quality/tdd"] .skill-reason').innerText(), '选择理由：' + reasons[2])
  const review = details.locator('[data-skill-detail="quality/code-review"]')
  await review.getByRole('button', { name: '网页预览归档文件SKILL.md', exact: true }).click()
  const raw = await page.getByRole('textbox', { name: '技能归档文件原文', exact: true }).inputValue()
  assert.ok(raw.includes('Two-axis review'))
  assert.ok(!raw.includes('related:') && !raw.includes('../../') && !raw.includes('maintenance notes'))
  await mkdir('.harness-local/validation', { recursive: true })
  await page.screenshot({ path: '.harness-local/validation/skill-content-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await damaged.locator('.skill-reason-raw pre').innerText(), damagedReason)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
  await page.screenshot({ path: '.harness-local/validation/skill-content-mobile.png' })
  await page.getByRole('button', { name: '关闭详情', exact: true }).click()
  await page.getByRole('button', { name: '展开Skill Hub技能选择区', exact: true }).click()
  await page.getByRole('button', { name: '展开文件夹quality', exact: true }).click()
  const node = page.locator('[data-skill-id="quality/diagnosing-bugs"]')
  assert.equal(await node.locator('.skill-lane-brief').innerText(), '原记录可能存在编码损坏')
  assert.ok(!(await node.locator('.skill-lane-main').getAttribute('title')).includes('??HEAD'))
  const after = (await fixture.cli(['task', 'show', entry.taskId])).data.result.task
  assert.deepEqual(after.skillPlan, before.skillPlan, 'Display warnings and archive previews must not rewrite saved reasons or files')
  assert.deepEqual(after.batches, before.batches, 'Browsing must not add context batches')
  assert.deepEqual(errors, [])
  const report = { platform: process.platform, browser: browser.version(), taskId: entry.taskId, reasons: { multilingual: 'preserved', damaged: 'warned-with-exact-raw', operators: 'preserved' }, selfContainedReviewArchive: true, savedPlanUnchanged: true, batchesUnchanged: true, desktop: [1440, 1000], mobile: [390, 844], errors }
  await writeFile('.harness-local/validation/skill-content-browser.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally {
  await browser?.close()
  await fixture.stop()
}
