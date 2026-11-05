import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { resolve, relative, sep } from 'node:path'
import { chromium } from 'playwright'
import { expect } from 'playwright/test'

const exec = promisify(execFile), base = `http://127.0.0.1:${Number(process.env.PORT ?? 4317)}`, output = '.harness-local/skills-browser'
await mkdir(output, { recursive: true })
const report = { startedAt: new Date().toISOString(), checks: [], errors: [], screenshots: [] }
const cli = async (...args) => JSON.parse((await exec(process.execPath, ['scripts/harness.mjs', ...args, '--json'], { maxBuffer: 4 * 1024 * 1024 })).stdout)
const contextCli = async (...args) => JSON.parse((await exec(process.execPath, ['scripts/context.mjs', ...args, '--json'])).stdout)
const json = async path => { const response = await fetch(base + path); assert.ok(response.ok, path); return response.json() }
const check = async (name, fn) => { await fn(); report.checks.push(name); console.log('PASS ' + name) }
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
await context.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort())
const page = await context.newPage(); page.on('pageerror', error => report.errors.push(String(error)))
const shot = async name => { const path = `${output}/${name}.png`; await page.screenshot({ path }); report.screenshots.push(path) }
const title = '自动技能检查：上下文与技能联合选择 ' + Date.now()
let selectedIds
const skillId = name => start.entrance.catalog.skills.find(skill => skill.name === name)?.id
const skillNode = name => page.locator('[data-skill-id=' + JSON.stringify(skillId(name)) + ']')
const folderNode = group => page.locator('[data-skill-folder=' + JSON.stringify(group) + ']')
const selectedGroups = () => [...new Set(selected.task.skillPlan.skills.map(skill => skill.group))]
const selector = () => page.locator('[data-skill-selector]'), skillOutput = () => page.locator('[data-skill-plan]')
let start, id, selected
try {
  await check('CLI entrance supplies built-in routing and the current light catalog without unselected bodies', async () => {
    start = await cli('start', '--title', title); id = start.task.id
    assert.ok(start.entrance.catalog.skills.length >= 3); selectedIds = ['diagnosing-bugs', 'tdd', 'code-review'].map(name => { const id = skillId(name); assert.ok(id, 'required test method exists: ' + name); return id }); assert.ok(start.entrance.prompt.includes('Skill Hub'))
    assert.ok(start.entrance.prompt.includes('mgrp.execution')); assert.ok(!start.entrance.catalog.skills.some(skill => skill.name === 'ask-matt'))
    assert.ok(!start.entrance.prompt.includes('# Test-Driven Development'), 'routing material does not include the known full TDD body')
    assert.ok(start.entrance.catalog.skills.every(skill => skill.files.every(file => !('content' in file))), 'routing catalog contains file references, not unselected bodies')
    assert.equal(start.entrance.observation, 'routing-material-produced; model-selection-not-yet-recorded')
  })
  await page.goto(base); await page.getByRole('combobox', { name: '当前检索任务' }).selectOption(id)
  await expect(page.locator('.map-node')).toHaveCount(5)
  await check('the second lane shares the world and input, stays collapsed and never invents skill choices', async () => {
    await expect(selector()).toHaveAttribute('aria-expanded', 'false'); await expect(skillOutput()).toContainText('未选择')
    assert.equal(await page.locator('.world [data-skill-lane]').count(), 1); await expect(page.locator('[data-skill-id]')).toHaveCount(0)
    const upper = await page.locator('.context-region').boundingBox(), lower = await page.locator('.skill-lane-region').boundingBox(); assert.ok(lower.y > upper.y + upper.height)
    await selector().click(); await expect(page.locator('[data-skill-folder]')).toHaveCount(new Set(start.entrance.catalog.skills.map(skill => skill.group)).size)
    await expect(page.locator('[data-skill-id]')).toHaveCount(0); await expect(page.locator('[data-skill-file]')).toHaveCount(0)
    for (const group of new Set(start.entrance.catalog.skills.map(skill => skill.group))) {
      await expect(folderNode(group)).toHaveAttribute('data-skill-folder-count', String(start.entrance.catalog.skills.filter(skill => skill.group === group).length))
      await expect(folderNode(group)).toHaveAttribute('data-skill-folder-selected', '0')
    }
    await expect(page.locator('[data-skill-state="selected"]')).toHaveCount(0); await selector().click(); await shot('01-two-lanes-awaiting')
  })
  await check('one CLI selection returns exact contexts and versioned references for three chosen skills', async () => {
    const selection = { modelRevision: start.task.modelRevision, catalogRevision: start.entrance.catalog.revision, expand: ['mgrp.execution', 'mgrp.network'], read: ['mgrp.execution.task', 'mgrp.execution.scheduler', 'mgrp.execution.transfer', 'mgrp.network'], skills: selectedIds.map((id, index) => ({ id, reason: ['先建立取消后传输问题的可复现诊断循环', '用行为回归验证取消和执行状态边界', '核对修复与任务要求和工程约定'][index] })) }
    const file = output + '/selection.json'; await writeFile(file, JSON.stringify(selection), 'utf8')
    selected = await cli('select', id, '--file', file)
    assert.equal(selected.task.packet.contexts.length, 4); assert.deepEqual(selected.task.skillPlan.skills.map(skill => skill.id), selectedIds)
    assert.ok(selected.task.skillPlan.skills.find(skill => skill.name === 'tdd').files.some(file => file.path === 'tests.md'))
    assert.ok(!selected.task.skillPlan.skills.some(skill => skill.name === 'implement'))
    assert.ok(selected.task.skillPlan.skills.every(skill => skill.files.every(file => !('content' in file))), 'select --json must not include archived bodies')
    assert.equal(selected.task.skillPlan.observation, 'selection-recorded; execution-unknown')
    await expect(skillOutput()).toContainText('已选 3 项'); await expect(selector()).toHaveAttribute('aria-expanded', 'false'); await expect(page.locator('.output-card')).toHaveAttribute('data-output-count', '4')
    await shot('02-two-lanes-selected')
  })
  await check('selected mindmap branches reveal reasons without adding reads and move with the same canvas transform', async () => {
    const before = (await json('/api/context/tasks/' + id)).batches.length
    await page.getByRole('button', { name: '定位技能方案', exact: true }).click(); await selector().click()
    await expect(page.locator('[data-skill-folder]')).toHaveCount(selectedGroups().length)
    await expect(page.locator('[data-skill-id]')).toHaveCount(0)
    await shot('10-selected-folders')
    for (const group of selectedGroups()) {
      const button = folderNode(group).getByRole('button'), before = await button.boundingBox()
      await expect(button).toHaveAttribute('aria-expanded', 'false'); await button.click()
      const after = await button.boundingBox()
      assert.ok(Math.abs(before.x - after.x) < 2 && Math.abs(before.y - after.y) < 2, 'folder expansion preserves the clicked position')
      await expect(folderNode(group)).toHaveAttribute('data-skill-folder-selected', String(selected.task.skillPlan.skills.filter(skill => skill.group === group).length))
    }
    await expect(page.locator('[data-skill-state="selected"]')).toHaveCount(3)
    for (const id of selectedIds) await expect(page.locator(`[data-skill-id="${id}"]`)).toContainText('选择已记录')
    const a = await selector().boundingBox(), b = await skillOutput().boundingBox()
    await page.mouse.move(1300, 500); await page.mouse.down(); await page.mouse.move(1340, 535); await page.mouse.up()
    const c = await selector().boundingBox(), d = await skillOutput().boundingBox(); assert.ok(Math.abs((c.x - a.x) - (d.x - b.x)) < 1); assert.ok(Math.abs((c.y - a.y) - (d.y - b.y)) < 1)
    assert.equal((await json('/api/context/tasks/' + id)).batches.length, before); await shot('03-selected-skill-set')
  })
  await check('skill detail displays the frozen editable body and attachments, not a claim of execution', async () => {
    await skillNode('tdd').locator('.skill-lane-inspect').click(); await expect(page.locator('.detail-panel')).toContainText('执行状态未知')
    await expect(page.getByRole('textbox', { name: '归档技能原文' })).toHaveValue(/# Test-Driven Development/)
    await page.getByRole('combobox', { name: '归档技能文件' }).selectOption('tests.md'); await expect(page.getByRole('textbox', { name: '归档技能原文' })).toHaveValue(/test|Test/)
    await shot('04-frozen-skill-file'); await page.keyboard.press('Escape')
    const handoff = await cli('handoff', id); assert.ok(handoff.handoff.includes('mgrp.execution.task')); assert.ok(handoff.handoff.includes('tdd')); assert.ok(handoff.handoff.includes('标准 agent'))
    assert.ok(!handoff.handoff.includes('# Test-Driven Development'))
    const batch = selected.task.batches.at(-1).id
    const read = await cli('read', id, '--skill', skillId('tdd'), '--path', 'tests.md', '--batch', batch)
    assert.equal(read.files.length, 1); assert.equal(read.files[0].path, 'tests.md'); assert.ok(read.files[0].content.includes('test'))
    assert.equal(read.files[0].hash, selected.task.skillPlan.skills.find(skill => skill.name === 'tdd').files.find(file => file.path === 'tests.md').hash)
  })
  await check('skill mindmap progressively reveals connected file references with independent detail controls', async () => {
    const nodes = await page.locator('[data-skill-id]').evaluateAll(items => items.map(item => ({ x: Number.parseFloat(item.style.left), y: Number.parseFloat(item.style.top) })))
    assert.equal(new Set(nodes.map(node => node.x)).size, 1); assert.equal(new Set(nodes.map(node => node.y)).size, 3)
    await expect(page.locator('[data-skill-file]')).toHaveCount(0)
    const main = page.getByRole('button', { name: '展开技能tdd文件引用', exact: true })
    const before = await main.boundingBox(); await main.click()
    const after = await page.getByRole('button', { name: '收起技能tdd文件引用', exact: true }).boundingBox()
    assert.ok(Math.abs(before.x - after.x) < 2 && Math.abs(before.y - after.y) < 2, 'expansion preserves the clicked branch')
    const expected = selected.task.skillPlan.skills.find(skill => skill.name === 'tdd').files.length
    await expect(page.locator('[data-skill-file-owner=' + JSON.stringify(skillId('tdd')) + ']')).toHaveCount(expected)
    await expect(page.locator('[data-skill-file-owner=' + JSON.stringify(skillId('code-review')) + ']')).toHaveCount(0)
    assert.equal(await page.locator('[data-skill-edge^=' + JSON.stringify('skill:' + skillId('tdd') + ':skill-file:') + ']').count(), expected)
    await shot('08-skill-file-mindmap')
    await page.locator('[data-skill-file="tests.md"][data-skill-file-owner=' + JSON.stringify(skillId('tdd')) + ']').click()
    await expect(page.getByRole('combobox', { name: '归档技能文件' })).toHaveValue('tests.md')
    await expect(page.getByRole('textbox', { name: '归档技能原文' })).toHaveValue(/test|Test/)
    await page.keyboard.press('Escape')
    for (const group of selectedGroups()) await folderNode(group).getByRole('button').click()
    await expect(page.locator('[data-skill-id]')).toHaveCount(0)
    await expect(page.locator('[data-skill-file]')).toHaveCount(0)
    for (const group of selectedGroups()) await folderNode(group).getByRole('button').click()
    await expect(page.locator('[data-skill-file-owner=' + JSON.stringify(skillId('tdd')) + ']')).toHaveCount(expected)
    await page.getByRole('button', { name: '收起技能tdd文件引用', exact: true }).click()
    await expect(page.locator('[data-skill-file]')).toHaveCount(0)
  })
  await check('historical batch views preserve absence before selection and the exact skill plan afterwards', async () => {
    await page.getByRole('button', { name: '检索记录', exact: true }).click(); await page.locator('.batch-view').first().click()
    await expect(skillOutput()).toContainText('未知'); await expect(page.locator('.output-card')).toHaveAttribute('data-output-count', '0')
    await page.getByRole('button', { name: '最终组织', exact: true }).click(); await expect(skillOutput()).toContainText('已选 3 项')
    await contextCli('query', id, '--read', 'mgrp.common'); await expect(page.locator('.output-card')).toHaveAttribute('data-output-count', '4')
    await page.getByRole('button', { name: '定位技能方案', exact: true }).click(); await skillOutput().click()
    await page.getByRole('button', { name: '查看上下文 + 技能交接包 →', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '技能交接材料' })).not.toHaveValue(/"id": "mgrp\.common"/)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '最终组织', exact: true }).click(); await expect(page.locator('.output-card')).toHaveAttribute('data-output-count', '5')
    await expect(skillOutput()).toContainText('已选 3 项'); await shot('05-history-plan')
  })
  await check('unknown skills and a second selection are rejected without altering the archived task', async () => {
    const again = await fetch(base + '/api/harness/tasks/' + id + '/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selected.selection) })
    assert.equal(again.status, 409)
    const fresh = await cli('start', '--title', title + ' invalid'), badFile = output + '/invalid.json'
    await writeFile(badFile, JSON.stringify({ modelRevision: fresh.task.modelRevision, catalogRevision: fresh.entrance.catalog.revision, expand: [], read: ['mgrp.network'], skills: [{ id: 'quality/missing', reason: 'Invalid target for negative check' }] }))
    await assert.rejects(cli('select', fresh.task.id, '--file', badFile), /未知|无效/)
    const unchanged = await json('/api/context/tasks/' + fresh.task.id); assert.equal(unchanged.batches.length, 1); assert.equal(unchanged.packet.contexts.length, 0); assert.equal(unchanged.skillPlan, null)
  })
  await check('directory edits update the live mindmap automatically, expose errors, refresh manually and preserve old selections', async () => {
    const live = await json('/api/skills/catalog'), root = await realpath('skills')
    assert.equal((await realpath(live.root)).toLowerCase(), root.toLowerCase(), 'only the repository test catalog may be mutated')
    const group = 'hub-check-' + Date.now(), groupRoot = resolve(root, group), folder = resolve(groupRoot, 'check-skill'), local = relative(root, groupRoot)
    assert.ok(local && !local.startsWith('..' + sep) && local !== '..' && !local.includes(':'))
    const pending = await cli('start', '--title', title + ' live catalog')
    await page.getByRole('combobox', { name: '当前检索任务' }).selectOption(pending.task.id)
    await expect(selector()).toHaveAttribute('aria-expanded', 'false')
    try {
      await mkdir(folder, { recursive: true })
      const body = description => `---\nname: hub-auto-check\ndescription: ${description}\n---\n# Temporary auto catalog check\n`
      await writeFile(resolve(folder, 'SKILL.md'), body('Automatic addition observed'))
      await expect(page.locator('[data-skill-library-state]')).toHaveAttribute('data-skill-library-state', 'ready', { timeout: 10000 })
      await expect.poll(async () => (await json('/api/skills/catalog')).skills.length).toBe(live.skills.length + 1)
      await expect(selector()).toHaveAttribute('aria-expanded', 'false', { timeout: 10000 })
      await selector().click(); await expect(page.locator('[data-skill-id]')).toHaveCount(0)
      const groupCount = 1
      await expect(page.locator('[data-skill-folder]')).toHaveCount(new Set(live.skills.map(skill => skill.group)).size + 1)
      await expect(folderNode(group)).toHaveAttribute('data-skill-folder-count', String(groupCount), { timeout: 10000 })
      await page.getByRole('button', { name: '概览全部内容', exact: true }).click()
      await folderNode(group).getByRole('button').click(); await expect(page.locator('[data-skill-id]')).toHaveCount(groupCount, { timeout: 10000 })
      await writeFile(resolve(folder, 'SKILL.md'), body('Automatic description replacement observed'))
      await expect(page.locator('[data-skill-id]').filter({ hasText: 'Automatic description replacement observed' })).toHaveCount(1, { timeout: 10000 })
      await writeFile(resolve(folder, 'SKILL.md'), 'invalid skill header')
      await expect(page.locator('[data-skill-library-state]')).toHaveAttribute('data-skill-library-state', 'error', { timeout: 10000 })
      await expect(page.locator('[data-skill-id]')).toHaveCount(0)
      await expect(page.locator('[data-skill-folder]')).toHaveCount(0)
      await writeFile(resolve(folder, 'SKILL.md'), body('Recovered automatic catalog'))
      await expect(page.locator('[data-skill-id]')).toHaveCount(groupCount, { timeout: 10000 })
      await selector().click(); await page.getByRole('button', { name: '定位技能方案', exact: true }).click()
      const refreshed = page.waitForResponse(response => response.url() === base + '/api/skills/refresh' && response.request().method() === 'POST')
      await page.getByRole('button', { name: '刷新技能目录', exact: true }).click()
      assert.equal((await (await refreshed).json()).reason, 'manual')
      await expect(selector()).toHaveAttribute('aria-expanded', 'false')
      await expect(page.locator('[data-skill-library-state]')).toHaveAttribute('data-skill-library-state', 'ready')
      await shot('09-live-catalog-refresh')
    } finally { await rm(groupRoot, { recursive: true, force: true }) }
    await expect.poll(async () => (await json('/api/skills/catalog')).skills.length).toBe(live.skills.length)
    await selector().click(); await expect(folderNode(group)).toHaveCount(0); await selector().click()
    await page.getByRole('combobox', { name: '当前检索任务' }).selectOption(id)
    await expect(skillOutput()).toContainText('已选 3 项')
    assert.equal((await json('/api/context/tasks/' + id)).skillPlan.catalogRevision, selected.task.skillPlan.catalogRevision)
  })
  await check('mobile can navigate to the skill lane and inspect archived files without overflow or page errors', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await page.getByRole('combobox', { name: '当前检索任务' }).selectOption(id)
    await expect(skillOutput()).toContainText('已选 3 项'); await page.getByRole('button', { name: '技能', exact: true }).click(); await selector().click()
    await expect(page.locator('[data-skill-id]')).toHaveCount(0)
    await page.getByRole('button', { name: '概览全部内容', exact: true }).click()
    for (const group of selectedGroups()) await folderNode(group).getByRole('button').click()
    await page.getByRole('button', { name: '概览全部内容', exact: true }).click(); await shot('06-mobile-lane')
    await skillNode('diagnosing-bugs').locator('.skill-lane-inspect').click(); await expect(page.getByRole('textbox', { name: '归档技能原文' })).toBeVisible(); await shot('07-mobile-skill-file')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); assert.deepEqual(report.errors, [])
  })
  report.status = 'passed'; report.taskId = id; report.catalogRevision = start.entrance.catalog.revision
} catch (error) { report.status = 'failed'; report.failure = String(error); console.error(error); await shot('failure').catch(() => {}); process.exitCode = 1 }
finally { report.completedAt = new Date().toISOString(); await writeFile(output + '/report.json', JSON.stringify(report, null, 2)); await browser.close() }
