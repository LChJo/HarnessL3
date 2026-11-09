import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { createBrowserFixture, browserIds } from './browser-fixture.mjs'

const fixture = await createBrowserFixture()
const reportRoot = '.harness-local/validation/overflow-counts'
let browser
try {
  await mkdir(reportRoot, { recursive: true })
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined) })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  const page = await context.newPage(), errors = [], mutations = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (new URL(request.url()).pathname === '/rpc') mutations.push(request.postDataJSON()?.operation) })
  const addedObjects = 200
  const addedSkills = 3
  await page.route('**/view?*', async route => {
    const response = await route.fetch(), value = await response.json()
    if (value.task?.id === fixture.entry.taskId) {
      const template = value.model.entities.find(entity => entity.id === browserIds.client)
      value.model.entities.push(...Array.from({ length: addedObjects }, (_, i) => ({ ...template, id: `overflow-object-${i}`, parentId: browserIds.client, locator: `app.network.client.unread${i}`, title: `Unread object ${i}`, brief: 'Synthetic nested count fixture', evidenceIds: [] })))
      const method = value.task.catalog.find(skill => skill.id === 'quality/tdd')
      value.task.catalog.push(...Array.from({ length: addedSkills }, (_, i) => ({ ...method, id: `quality/overflow-unused-${i}`, name: `Unused count method ${i}` })))
      value.task.packet = { ...value.task.packet, contexts: [], evidence: [] }
    }
    await route.fulfill({ response, json: value })
  })
  const before = (await fixture.cli(['task', 'show', fixture.entry.taskId])).data.result.task
  await page.goto(await fixture.url())
  await page.waitForFunction(() => document.querySelector('[data-view-ready="true"]') && !document.querySelector('.view-loading'))
  const fit = () => page.getByRole('button', { name: '概览全部内容', exact: true }).click()
  const counts = {}
  for (const category of ['objects', 'relations', 'sources', 'evidence']) {
    await page.locator(`[data-category-root="${category}"] .map-main`).click()
    await fit()
    const overflow = page.locator(`[data-node-overflow="category:${category}"]`)
    const count = Number((await overflow.innerText()).match(/其余\s+(\d+)\s+项/)?.[1])
    assert.ok(count > 1, `${category} must not report only its immediate group count`)
    counts[category] = count
    await overflow.click()
    const directory = page.getByTestId('node-directory')
    await directory.waitFor()
    assert.equal((await directory.locator('.directory-total').innerText()).trim(), `${count} 项`)
    await directory.getByRole('combobox', { name: '筛选命中状态' }).selectOption('miss')
    assert.equal((await directory.locator('.directory-results').innerText()).trim(), `${count} 项结果`)
    assert.equal(await directory.locator('[data-directory-row]').count(), Math.min(count, 50))
    if (category === 'objects') {
      assert.equal(count, addedObjects + 7)
      await directory.getByRole('searchbox', { name: '搜索全部节点' }).fill('Unread object 199')
      assert.equal(await directory.locator('[data-directory-row]').count(), 1)
      await page.screenshot({ path: reportRoot + '/directory.png' })
    }
    await page.getByRole('button', { name: '返回画布', exact: true }).click()
  }
  assert.equal(await page.locator('[data-node-id],[data-node-overflow]').count(), 9, 'Only five categories and four overflows are rendered')
  await fit()
  await page.screenshot({ path: reportRoot + '/canvas.png' })
  await page.locator('[data-skill-selector]').click()
  await fit()
  await page.locator('[data-skill-folder="quality"] .skill-lane-main').click()
  await fit()
  const selected = new Set(before.skillPlan.skills.map(skill => skill.id))
  const selectedGroups = new Set(before.skillPlan.skills.map(skill => skill.group))
  const hubCount = before.catalog.filter(skill => !selected.has(skill.id) && !selectedGroups.has(skill.group)).length
  const folderCount = before.catalog.filter(skill => skill.group === 'quality' && !selected.has(skill.id)).length + addedSkills
  for (const [group, expected] of [['*', hubCount], ['quality', folderCount]]) {
    assert.ok(expected > 0)
    assert.match(await page.locator(`[data-skill-overflow="${group}"]`).innerText(), new RegExp(`其余 ${expected} 项`))
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await fit()
  await page.screenshot({ path: reportRoot + '/mobile.png' })
  const after = (await fixture.cli(['task', 'show', fixture.entry.taskId])).data.result.task
  assert.deepEqual(after, before, 'Counting and browsing must leave native task/history bytes unchanged')
  assert.ok(!mutations.some(operation => ['context query', 'task select', 'task read'].includes(operation)))
  assert.deepEqual(errors, [])
  const report = { platform: process.platform, browser: browser.version(), fixture: 'synthetic nested render payload on isolated native service', counts, hubCount, folderCount, canvasNodes: 9, directoryCountsMatch: true, paged: true, nestedSearch: true, mobile: true, taskUnchanged: true, pageErrors: errors }
  await writeFile(reportRoot + '/browser.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally { await browser?.close(); await fixture.stop() }
