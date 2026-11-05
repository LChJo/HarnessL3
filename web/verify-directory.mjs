import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

if (!process.argv[2]) throw new Error('Usage: node web/verify-directory.mjs <isolated-browser-fixture.json>')
const fixture = JSON.parse(await readFile(process.argv[2], 'utf8'))
assert.ok(path.basename(fixture.directory).startsWith('harnessl3-browser-'))
const dataRoot = await realpath(fixture.dataRoot)
const inside = (root, file) => { const local = path.relative(root, file); return local && !path.isAbsolute(local) && local !== '..' && !local.startsWith('..' + path.sep) }
const service = JSON.parse(await readFile(path.join(dataRoot, 'service.json'), 'utf8'))
const nonce = await fetch(service.url + '/browser-session', { method: 'POST', headers: { authorization: 'Bearer ' + service.token } }).then(response => response.json())
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined) })
const stamp = Date.now().toString(36), originalGroup = 'ui-fixture-' + stamp, renamedGroup = originalGroup + '-renamed'
const renamedQuality = 'quality-ui-fixture-' + stamp, method = 'probe-method', name = 'ui-method-' + stamp
const errors = [], owned = []
let library, qualityBytes, qualityMoved = false
const validSkill = description => `---\nname: ${name}\ndescription: ${description}\n---\n\n# Probe method\nRead these archived instructions only when explicitly selected.\n`
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(service.url + '/#' + new URLSearchParams({ code: nonce.code, worktree: fixture.target.worktreeId }))
  await page.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-route-worktree') && !document.querySelector('.view-loading'))
  const rpc = operation => page.evaluate(async args => {
    const response = await fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Harness-Web': '1' }, body: JSON.stringify({ operation: args.operation, positionals: [], flags: { worktree: args.worktree }, requestId: crypto.randomUUID() }) }).then(response => response.json())
    if (!response.ok) throw new Error(response.error.code + ': ' + response.error.message)
    return response.data.result
  }, { operation, worktree: fixture.target.worktreeId })
  const initial = await rpc('skills list'), before = await rpc('sync status')
  library = await realpath(initial.root)
  assert.ok(inside(dataRoot, library), 'canonical editable copy must stay within this fixture dataRoot')
  assert.equal(initial.valid, true)
  const folder = group => path.join(library, group)
  for (const group of [originalGroup, renamedGroup]) { assert.ok(inside(library, folder(group))); owned.push(folder(group)) }
  const quality = folder('quality'), qualityTarget = folder(renamedQuality)
  assert.ok(inside(library, quality)); assert.ok(inside(library, qualityTarget))
  assert.equal((await lstat(quality)).isSymbolicLink(), false)
  qualityBytes = await readFile(path.join(quality, 'tdd', 'SKILL.md'))
  const waitFolder = (group, exists = true) => page.waitForFunction(({ group, exists }) => !!document.querySelector(`[data-skill-folder="${group}"]`) === exists, { group, exists }, { timeout: 20000 })
  const fit = () => page.getByRole('button', { name: '概览全部内容', exact: true }).click()
  const refresh = async () => {
    const response = page.waitForResponse(response => response.url().endsWith('/rpc') && response.request().postDataJSON()?.operation === 'skills refresh')
    await page.getByRole('button', { name: '刷新技能目录', exact: true }).click()
    return (await (await response).json()).data.result
  }
  await page.locator('[data-skill-selector]').click()
  await mkdir(path.join(folder(originalGroup), method), { recursive: true })
  await writeFile(path.join(folder(originalGroup), method, 'SKILL.md'), validSkill('First actual file-derived description.'))
  await waitFolder(originalGroup)
  await fit()
  await page.locator(`[data-skill-folder="${originalGroup}"] .skill-lane-main`).click()
  await page.waitForFunction(id => document.querySelector(`[data-skill-id="${id}"]`)?.textContent?.includes('First actual'), originalGroup + '/' + method)
  await writeFile(path.join(folder(originalGroup), method, 'SKILL.md'), validSkill('Updated description comes from the edited bytes.'))
  await page.waitForFunction(id => document.querySelector(`[data-skill-id="${id}"]`)?.textContent?.includes('Updated description'), originalGroup + '/' + method)
  await rename(folder(originalGroup), folder(renamedGroup))
  await waitFolder(originalGroup, false); await waitFolder(renamedGroup)
  assert.equal((await lstat(folder(renamedGroup))).isSymbolicLink(), false)
  await rm(folder(renamedGroup), { recursive: true })
  await waitFolder(renamedGroup, false)

  await mkdir(path.join(folder(originalGroup), method), { recursive: true })
  await writeFile(path.join(folder(originalGroup), method, 'SKILL.md'), 'This file intentionally has no YAML frontmatter.\n')
  await page.locator('[data-skill-library-state="error"]').waitFor({ timeout: 20000 })
  assert.equal(await page.locator('[data-skill-folder]').count(), 0, 'invalid scan clears old candidates')
  assert.equal((await refresh()).valid, false)
  await page.locator('.selection-dock').getByRole('button', { name: '技能方案', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'frontmatter' }).waitFor()
  await writeFile(path.join(folder(originalGroup), method, 'SKILL.md'), validSkill('Recovered file is valid again.'))
  const recovered = page.waitForResponse(response => response.url().endsWith('/rpc') && response.request().postDataJSON()?.operation === 'skills refresh')
  await page.getByRole('button', { name: '重新扫描实际技能目录', exact: true }).click()
  assert.equal((await (await recovered).json()).data.result.valid, true)
  await page.waitForFunction(() => !document.querySelector('.skill-details [role="alert"]'))
  await page.getByRole('button', { name: '关闭详情', exact: true }).click()
  await waitFolder(originalGroup)

  const archived = await context.newPage()
  archived.on('pageerror', error => errors.push(error.message))
  await archived.goto(service.url + '/?' + new URLSearchParams({ worktree: fixture.target.worktreeId, task: fixture.entry.taskId, history: '1' }))
  await archived.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-task-id') && !document.querySelector('.view-loading'))
  await archived.locator('[data-skill-selector]').click()
  assert.equal(await archived.locator('[data-skill-folder="quality"]').count(), 1)
  await writeFile(path.join(quality, 'tdd', 'SKILL.md'), Buffer.concat([qualityBytes, Buffer.from('\nUI_DIRECTORY_MUTATION_MARKER\n')]))
  await rename(quality, qualityTarget); qualityMoved = true
  await waitFolder('quality', false); await waitFolder(renamedQuality)
  assert.equal(await archived.locator('[data-skill-folder="quality"]').count(), 1)
  assert.equal(await archived.locator(`[data-skill-folder="${renamedQuality}"]`).count(), 0)
  await archived.getByRole('button', { name: '概览全部内容', exact: true }).click()
  await archived.locator('[data-skill-folder="quality"] .skill-lane-main').click()
  await archived.getByRole('button', { name: '概览全部内容', exact: true }).click()
  await archived.locator('[data-skill-id="quality/tdd"] .skill-lane-main').click()
  await archived.getByRole('button', { name: '概览全部内容', exact: true }).click()
  await archived.locator('[data-skill-file-owner="quality/tdd"][data-skill-file="SKILL.md"]').click()
  await archived.getByRole('button', { name: '网页预览归档文件SKILL.md', exact: true }).click()
  const oldText = archived.getByRole('textbox', { name: '技能归档文件原文', exact: true })
  await oldText.waitFor()
  assert.equal(await oldText.inputValue(), qualityBytes.toString('utf8'), 'old plan returns its original bytes despite directory rename/edit')
  await rename(qualityTarget, quality); qualityMoved = false
  await writeFile(path.join(quality, 'tdd', 'SKILL.md'), qualityBytes)
  await waitFolder('quality'); await waitFolder(renamedQuality, false)
  const after = await rpc('sync status')
  assert.equal(after.sourceEpoch, before.sourceEpoch)
  assert.deepEqual(after.sourceVersion, before.sourceVersion)
  assert.equal(after.sourceScanRevision, before.sourceScanRevision)
  assert.ok(inside(library, await realpath(folder(originalGroup))))
  await rm(folder(originalGroup), { recursive: true })
  await waitFolder(originalGroup, false)
  const final = await refresh()
  assert.equal(final.revision, initial.revision, 'fixture skill bytes and directory restored exactly')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ canonicalCopyInsideFixture: true, directory: ['automatic-add', 'automatic-body-edit', 'automatic-category-rename', 'automatic-delete', 'invalid-clears-candidates', 'manual-invalid-refresh', 'manual-recovery'], oldPlan: 'original-group-and-bytes', sourceEpoch: { before: before.sourceEpoch, after: after.sourceEpoch }, restoredCatalogRevision: true, pageErrors: errors }))
} finally {
  // Only known fixture paths are restored/deleted; never touch repo skills.
  if (library && qualityBytes) {
    const quality = path.join(library, 'quality'), moved = path.join(library, renamedQuality)
    if (qualityMoved) { assert.ok(inside(library, await realpath(moved))); await rename(moved, quality) }
    assert.ok(inside(library, await realpath(quality)))
    await writeFile(path.join(quality, 'tdd', 'SKILL.md'), qualityBytes)
  }
  for (const entry of owned) {
    try { const actual = await realpath(entry); assert.ok(library && inside(library, actual)); assert.equal((await lstat(entry)).isSymbolicLink(), false); await rm(entry, { recursive: true }) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  await browser.close()
}
