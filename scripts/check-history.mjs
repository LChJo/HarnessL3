import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { expect } from 'playwright/test'

const exec = promisify(execFile), base = `http://127.0.0.1:${Number(process.env.PORT ?? 4317)}`, output = '.harness-local/history-browser'
await mkdir(output, { recursive: true })
const report = { startedAt: new Date().toISOString(), checks: [], errors: [], screenshots: [] }
const cli = async (...args) => JSON.parse((await exec(process.execPath, ['scripts/context.mjs', ...args, '--json'])).stdout)
const json = async path => { const response = await fetch(base + path); assert.ok(response.ok, path); return response.json() }
const check = async (name, fn) => { await fn(); report.checks.push(name); console.log('PASS ' + name) }
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
await context.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort())
const page = await context.newPage(); page.on('pageerror', e => report.errors.push(String(e)))
const shot = async name => { const path = `${output}/${name}.png`; await page.screenshot({ path }); report.screenshots.push(path) }
const title = '自动历史检查：输入到输出组织 ' + Date.now()
let id, rootBatch, state
try {
  await check('CLI archives a real task and history search reaches its input and exact context output', async () => {
    const start = await cli('start', '--title', title); id = start.task.id; rootBatch = start.result.batchId
    await cli('query', id, '--expand', 'mgrp.execution,mgrp.network')
    await cli('query', id, '--read', 'mgrp.execution.task,mgrp.network')
    await cli('query', id, '--read', 'mgrp.execution.scheduler')
    state = await cli('show', id)
    assert.equal(state.packet.contexts.length, 3); assert.equal(state.history.snapshotStatus, 'complete')
    const found = await cli('history', '--query', title, '--limit', '1'); assert.equal(found.total, 1); assert.equal(found.tasks[0].id, id)
    const beforeBodies = await cli('show', id, '--batch', rootBatch); assert.equal(beforeBodies.title, title); assert.equal(beforeBodies.packet.contexts.length, 0)
  })
  await check('HTTP serves immutable snapshot and all five LikeC4 views with explicit invalid query errors', async () => {
    const archive = await json(`/api/context/tasks/${id}/snapshot`), structure = await json('/api/context/structure')
    assert.equal(archive.status, 'complete'); assert.equal(archive.snapshot.revision, state.modelRevision); assert.equal(archive.snapshot.c4Views.length, 5); assert.equal(structure.views.length, 5)
    assert.equal((await fetch(base + '/api/context/history?limit=0')).status, 400)
    assert.equal((await fetch(base + `/api/context/tasks/${id}?batch=missing`)).status, 404)
  })
  await page.goto(base); await expect(page.locator('.category-node')).toHaveCount(5)
  await check('history panel searches the 60-day archive and opens the saved five-category organization read-only', async () => {
    await page.getByRole('button', { name: '60天任务历史', exact: true }).click()
    await page.getByRole('textbox', { name: '搜索历史任务' }).fill(title); await page.getByRole('button', { name: '查找', exact: true }).click()
    await expect(page.locator('.history-task')).toHaveCount(1); await expect(page.locator('.history-task')).toContainText('已归档模型'); await shot('01-history-search')
    await page.locator(`[data-history-id="${id}"]`).click(); await expect(page.locator('.history-indicator')).toContainText('历史只读')
    await expect(page.locator('.output-card')).toHaveAttribute('data-output-count', '3'); await expect(page.locator('.map-node')).toHaveCount(5)
    await page.locator('[data-map-id="category:objects"] .map-main').click(); await page.getByRole('button', { name: '概览全部内容' }).click()
    await expect(page.getByRole('button', { name: '选择任务执行正文', exact: true })).toBeDisabled(); await shot('02-history-organization')
  })
  await check('later SSE results cannot rewrite an already opened historical organization', async () => {
    await cli('query', id, '--read', 'mgrp.common')
    await expect(page.locator('.output-card')).toHaveAttribute('data-output-count', '3')
    await page.getByRole('button', { name: '最终组织', exact: true }).click(); await expect(page.locator('.output-card')).toHaveAttribute('data-output-count', '4')
  })
  await check('batch inspection restores input-to-output state before any body was returned', async () => {
    await page.getByRole('button', { name: '检索记录', exact: true }).click(); await page.locator('.batch-view').first().click()
    await expect(page.locator('.history-indicator')).toContainText('1 / 5 批'); await expect(page.locator('.output-card')).toHaveAttribute('data-output-count', '0'); await expect(page.locator('.map-node')).toHaveCount(5)
    await shot('03-first-batch'); await page.getByRole('button', { name: '最终组织', exact: true }).click()
    await page.getByRole('button', { name: '定位上下文输出' }).click(); await page.getByRole('button', { name: '查看上下文包', exact: true }).click()
    const packet = await page.getByRole('textbox', { name: '上下文包原文' }).inputValue(); assert.ok(packet.includes(title)); assert.ok(packet.includes('mgrp.execution.task')); assert.ok(packet.includes('mgrp.common')); await shot('04-historical-output'); await page.keyboard.press('Escape')
  })
  await check('C4 is available on demand from the archived model and all five structural views render', async () => {
    await page.getByRole('button', { name: '查看C4项目结构', exact: true }).click(); await expect(page.locator('.structure-toolbar')).toContainText('当时模型')
    const select = page.getByRole('combobox', { name: 'C4结构视图' }); await expect(select.locator('option')).toHaveCount(5)
    for (const view of ['index', 'download', 'platforms', 'dependencies', 'quality']) { await select.selectOption(view); await expect(page.locator('.c4-diagram')).toHaveAttribute('data-c4-view', view); assert.ok(await page.locator('[data-c4-node]').count() > 0) }
    await select.selectOption('download'); await shot('05-c4-historical'); await page.keyboard.press('Escape')
  })
  await check('current project C4 entry does not create a context read or alter the five-root home', async () => {
    const before = await json(`/api/context/tasks/${id}`)
    await page.getByRole('combobox', { name: '当前检索任务' }).selectOption(''); await page.getByRole('button', { name: '查看C4项目结构', exact: true }).click()
    await expect(page.locator('.structure-toolbar')).toContainText('当前项目'); await expect(page.locator('.c4-diagram')).toBeVisible(); await shot('06-c4-current'); await page.keyboard.press('Escape')
    await expect(page.locator('.map-node')).toHaveCount(5); assert.equal((await json(`/api/context/tasks/${id}`)).batches.length, before.batches.length)
  })
  await check('mobile history and structure panels stay usable without page overflow or JavaScript errors', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await expect(page.locator('.category-node')).toHaveCount(5)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.getByRole('button', { name: '60天任务历史', exact: true }).click(); await expect(page.getByRole('textbox', { name: '搜索历史任务' })).toBeVisible(); await shot('07-mobile-history'); await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '查看C4项目结构', exact: true }).click(); await expect(page.locator('.c4-diagram')).toBeVisible(); await shot('08-mobile-c4'); assert.deepEqual(report.errors, [])
  })
  report.status = 'passed'; report.taskId = id
} catch (error) { report.status = 'failed'; report.failure = String(error); console.error(error); await shot('failure').catch(() => {}); process.exitCode = 1 }
finally { report.completedAt = new Date().toISOString(); await writeFile(output + '/report.json', JSON.stringify(report, null, 2)); await browser.close() }
