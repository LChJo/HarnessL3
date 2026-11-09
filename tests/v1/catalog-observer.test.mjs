import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fixture } from './helpers.mjs'
import { CatalogObserver } from '../../build/core/catalog.js'

test('TC19 browsing catalog reuses checked bytes, observes edits and drops invalid candidates', async t => {
  const f = await fixture(t, 'harness-v1-catalog-observer-')
  const root = path.join(f.directory, 'library'), method = path.join(root, 'quality', 'sample')
  await mkdir(method, { recursive: true })
  const skill = path.join(method, 'SKILL.md')
  const valid = '---\nname: sample\ndescription: Sample method\n---\nActual method\n'
  await writeFile(skill, valid)
  const observer = new CatalogObserver()
  try {
    let first = await observer.read(root), cached
    assert.equal(first.valid, true)
    // Native notifications for the seed can arrive while its first scan is in flight.
    // Drain those real invalidations before testing a quiet browsing request.
    const quietDeadline = Date.now() + 10000
    do {
      cached = await observer.read(root)
      if (cached.checkedAt === first.checkedAt) break
      first = cached
    } while (Date.now() < quietDeadline)
    assert.equal(cached.checkedAt, first.checkedAt)
    assert.equal(cached.revision, first.revision)
    await writeFile(skill, 'invalid frontmatter')
    let invalid
    const deadline = Date.now() + 10000
    do { invalid = await observer.read(root); if (!invalid.valid) break; await delay(20) } while (Date.now() < deadline)
    assert.equal(invalid.valid, false)
    assert.deepEqual(invalid.skills, [])
    await writeFile(skill, valid + 'Changed method\n')
    const restored = await observer.read(root, true)
    assert.equal(restored.valid, true)
    assert.notEqual(restored.revision, first.revision)
    // Observer entries are keyed by the canonical root, which differs from the
    // caller's temp spelling on macOS (/private/var) and Windows (8.3 names).
    observer.entries.get(await realpath(root)).watcher?.emit('error', new Error('Injected watch gap'))
    await writeFile(skill, valid + 'After watch gap\n')
    assert.notEqual((await observer.read(root)).revision, restored.revision)
  } finally { await observer.close() }
})
