import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile, unlink, access } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect } from 'playwright/test'

// An isolated test browser, with no persisted user profile and no external network requests.
const base = `http://127.0.0.1:${Number(process.env.PORT ?? 4317)}`
const output = '.harness-local/browser'
await mkdir(output, { recursive: true })
const report = { startedAt: new Date().toISOString(), checks: [], screenshots: [], errors: [], measurements: {} }
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined), headless: true })
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
await context.route('**/*', route => {
  const url = route.request().url()
  return url.startsWith(base + '/') || /^(?:data:|blob:)/.test(url) ? route.continue() : route.abort()
})
const page = await context.newPage()
page.on('pageerror', error => report.errors.push(String(error)))
page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()) })
async function capture(name) {
  const path = `${output}/${name}.png`
  await page.locator('.main-area').evaluate(element => { element.scrollTop = 0 }).catch(() => {})
  await page.screenshot({ path, fullPage: true })
  report.screenshots.push(path)
}
async function check(name, run) {
  await run()
  report.checks.push(name)
  console.log(`PASS ${name}`)
}
const nav = label => page.locator('.main-nav').getByRole('button', { name: label })
try {
  const snapshotResponse = await context.request.get(`${base}/api/snapshot`)
  assert.equal(snapshotResponse.status(), 200)
  const snapshot = await snapshotResponse.json()
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await check('production page renders the actual LikeC4 model', async () => {
    await expect(page.locator('.map-heading h1')).toContainText('项目总览')
    await expect(page.locator('.react-flow__node')).toHaveCount(snapshot.views.find(v => v.id === 'index').nodes)
    await expect(page.locator('.toolbar-status')).toContainText('模型有效')
    assert.deepEqual(report.errors, [])
  })
  await capture('overview')
  await check('overview node labels are readable at the default scale', async () => {
    const label = page.locator('.react-flow__node[data-id="mgrp.business"]').getByText('业务编排', { exact: true })
    const rect = await label.boundingBox()
    assert.ok(rect, '业务编排标签应显示在图中')
    report.measurements.overviewLabelHeight = rect.height
    assert.ok(rect.height >= 11, `默认视图标签只有 ${rect.height.toFixed(1)}px，需至少 11px 才能阅读`)
  })
  await check('all five views render their model-derived nodes', async () => {
    for (const view of snapshot.views) {
      await page.locator('.view-item').filter({ hasText: view.title }).click()
      await expect(page.locator('.map-heading h1')).toContainText(view.title)
      await expect(page.locator('.react-flow__node')).toHaveCount(view.nodes)
      await capture(`view-${view.id}`)
    }
  })
  await check('module inspector includes relationships of its child objects', async () => {
    await page.locator('.view-item').filter({ hasText: '项目总览' }).click()
    await page.locator('.react-flow__node[data-id="mgrp.business"]').click()
    await expect(page.locator('.inspector h2')).toHaveText('业务编排')
    await page.locator('.inspector-tabs button').filter({ hasText: '关系' }).click()
    assert.ok(await page.locator('.relation-card').count() > 0, '图中业务模块有关系，检查器不能显示 0 条')
    await expect(page.locator('.inspector-content')).toContainText('DownloadManager')
  })
  await check('search locates DownloadManager and its relevant view', async () => {
    await page.getByRole('textbox', { name: '搜索模型对象' }).fill('DownloadManager')
    await page.getByRole('button', { name: /DownloadManager\s+mgrp\.business\.download/ }).click()
    await expect(page.locator('.inspector h2')).toHaveText('DownloadManager')
    await expect(page.locator('.map-heading h1')).toContainText('下载执行路径')
  })
  await check('object and relationship evidence show real source excerpts', async () => {
    await page.getByRole('button', { name: '查看源码证据', exact: true }).click()
    await expect(page.locator('.evidence-code')).toContainText('business-layer authority')
    await expect(page.locator('.inspector-content')).toContainText('所引文件内容匹配')
    await capture('source-evidence')
    await page.locator('.inspector-tabs button').filter({ hasText: '关系' }).click()
    await page.locator('.relation-card').first().click()
    await expect(page.locator('.evidence-code')).toBeVisible()
    await expect(page.locator('.inspector-content')).toContainText('记录 SHA-256')
  })
  await check('object definition opens the actual local LikeC4 file', async () => {
    await page.locator('.inspector-tabs').getByRole('button', { name: '概览', exact: true }).click()
    await page.getByRole('button', { name: '定位此对象的 .c4 原文' }).click()
    await expect(page.locator('.file-tabs button.active')).toContainText('12-business.c4')
    await expect(page.locator('.source-code')).toContainText('stable_id "mgrp.business.download"')
    for (const file of ['00-specification.c4', '02-relations.c4', '03-views.c4']) {
      await page.locator('.file-tabs').getByRole('button', { name: file, exact: true }).click()
      await expect(page.locator('.code-toolbar')).toContainText(file)
      await expect(page.locator('.source-code')).not.toBeEmpty()
    }
    await capture('model-source')
  })
  await check('real tool logs and scripted examples can be filtered and inspected', async () => {
    await nav(/Agent 读写轨迹/).click()
    await page.getByLabel('轨迹来源').selectOption('real')
    await page.getByRole('button', { name: '写入', exact: true }).click()
    await expect(page.locator('.trace-row').first()).toBeVisible()
    for (const text of await page.locator('.trace-row').allTextContents()) { assert.ok(text.includes('Codex')); assert.ok(text.includes('写入')) }
    await page.locator('.trace-row').first().click()
    await expect(page.locator('.trace-inspector')).toContainText('未知（日志未记录）')
    await expect(page.locator('.trace-inspector')).toContainText('call:')
    await page.getByRole('button', { name: '关闭操作详情' }).click()
    await page.getByRole('button', { name: '全部操作', exact: true }).click()
    await page.getByLabel('轨迹来源').selectOption('demo')
    await expect(page.locator('.trace-row').first()).toBeVisible()
    assert.ok((await page.locator('.trace-row').allTextContents()).every(text => text.includes('脚本演示')))
    await capture('agent-traces')
  })
  await check('review questions navigate to the referenced object and view', async () => {
    for (let i = 0; i < snapshot.review.questions.length; i++) {
      const question = snapshot.review.questions[i]
      await nav('模型可用性审查').click()
      await expect(page.locator('.review-question')).toHaveCount(4)
      await page.getByRole('button', { name: '在图中验证' }).nth(i).click()
      await expect(page.locator('.inspector h2')).toHaveText(snapshot.elements.find(e => e.id === question.object).title)
      await expect(page.locator('.map-heading h1')).toContainText(snapshot.views.find(v => v.id === question.view).title)
    }
  })
  await check('direct text edits refresh the browser; invalid text preserves and labels the last valid diagram', async () => {
    await nav('项目地图').click()
    await page.locator('.view-item').filter({ hasText: '项目总览' }).click()
    const file = join(snapshot.runtime.modelDir, '03-views.c4')
    const probe = join(snapshot.runtime.modelDir, '99-browser-validation-probe.c4')
    const original = await readFile(file, 'utf8')
    const changed = original.replace('title "项目总览"', 'title "项目总览 · 文件更新验证"')
    assert.notEqual(changed, original)
    try { await access(probe); throw new Error('Probe already exists; refusing to overwrite') } catch (e) { if (e.code !== 'ENOENT') throw e }
    let probeCreated = false
    try {
      await writeFile(file, changed)
      await expect(page.locator('.map-heading h1')).toContainText('项目总览 · 文件更新验证', { timeout: 12000 })
      await expect(page.locator('.react-flow__node')).toHaveCount(snapshot.views.find(v => v.id === 'index').nodes)
      await writeFile(probe, 'model { incomplete = }')
      probeCreated = true
      await expect(page.locator('.diagnostics')).toContainText('当前文本未通过模型校验', { timeout: 12000 })
      await expect(page.locator('.toolbar-status')).toContainText('模型无效 · 展示最近有效版本')
      await expect(page.locator('.map-heading h1')).toContainText('项目总览 · 文件更新验证')
      await expect(page.locator('.react-flow__node')).toHaveCount(snapshot.views.find(v => v.id === 'index').nodes)
      await capture('invalid-model-last-valid-diagram')
    } finally {
      if (probeCreated) await unlink(probe)
      const current = await readFile(file, 'utf8')
      if (current === changed) await writeFile(file, original)
      else assert.equal(current, original, '发现外部编辑，拒绝覆盖模型文件')
    }
    await expect(page.locator('.diagnostics')).toBeHidden({ timeout: 12000 })
    await expect(page.locator('.map-heading h1')).toHaveText('项目总览LikeC4', { useInnerText: false, timeout: 12000 })
    await expect(page.locator('.toolbar-status')).toContainText('模型有效')
  })
  await check('a version-bound review can be saved through the interface', async () => {
    await nav('模型可用性审查').click()
    const note = '浏览器自动检查：验证审查表单保存；该记录不是用户的人工可用性结论。'
    await page.getByRole('textbox', { name: '发现与建议' }).fill(note)
    const response = page.waitForResponse(r => r.url() === `${base}/api/reviews` && r.request().method() === 'POST')
    await page.getByRole('button', { name: '保存审查记录', exact: true }).click()
    assert.equal((await response).status(), 200)
    await expect(page.locator('.saved-reviews')).toContainText(note)
    await capture('model-review')
  })
  await check('tablet and mobile layouts keep search and evidence accessible', async () => {
    for (const viewport of [{ width: 900, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      await nav('项目地图').click()
      await page.getByRole('textbox', { name: '搜索模型对象' }).fill('DownloadManager')
      await page.getByRole('button', { name: /DownloadManager\s+mgrp\.business\.download/ }).click()
      await expect(page.locator('.inspector')).toBeVisible()
      await page.getByRole('button', { name: '查看源码证据', exact: true }).click()
      await expect(page.locator('.evidence-code')).toContainText('business-layer authority')
      const panel = await page.locator('.inspector').boundingBox()
      const canvas = await page.locator('.diagram-container').boundingBox()
      assert.ok(await page.locator('.inspector').evaluate((element, point) => {
        const hit = document.elementFromPoint(point.x, point.y)
        return hit === element || element.contains(hit)
      }, { x: panel.x + 20, y: canvas.y + 20 }), '图形浮动工具条不能遮挡上下文面板')
      await capture(`responsive-${viewport.width}`)
      await page.getByRole('button', { name: '关闭上下文详情' }).click()
      await expect(page.locator('.inspector')).toBeHidden()
      if (viewport.width < 650) {
        await page.getByLabel('选择项目视图').selectOption('platforms')
        await expect(page.locator('.map-heading h1')).toContainText('跨平台网络后端')
        await expect(page.locator('.react-flow__node')).toHaveCount(snapshot.views.find(v => v.id === 'platforms').nodes)
        await capture('responsive-mobile-map')
      }
    }
  })
  assert.deepEqual(report.errors, [], '浏览器不能出现未处理异常')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.failure = String(error)
  await capture('failure')
  console.error(error)
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2))
  await browser.close()
  console.log(JSON.stringify(report, null, 2))
}
