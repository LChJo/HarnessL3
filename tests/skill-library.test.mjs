import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkillLibrary } from '../server/skill-library.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'harness-skills-'))
  const add = async (name, description = 'Read the actual code') => {
    const dir = join(root, 'engineering', name); await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: "${description}"\n---\n# ${name}\nUse [reference](reference.md).\n`)
    await writeFile(join(dir, 'reference.md'), '# Original reference\n')
    return dir
  }
  await add('debug'); return { root, add, library: createSkillLibrary({ root }) }
}

test('skill catalog reflects editable files and preserves selected bodies/attachments with version binding', async () => {
  const f = await fixture(), first = await f.library.catalog()
  assert.deepEqual(first.skills.map(s => s.id), ['engineering/debug'])
  assert.equal(first.skills[0].description, 'Read the actual code')
  const selected = await f.library.select([{ id: 'engineering/debug', reason: 'Need a reproducible diagnosis' }], first.revision)
  assert.ok(selected.skills[0].files.some(file => file.path === 'reference.md' && file.content.includes('Original reference')))
  await writeFile(join(f.root, 'engineering/debug/reference.md'), '# Changed reference\n')
  assert.notEqual((await f.library.catalog()).revision, first.revision)
  await assert.rejects(f.library.select([{ id: 'engineering/debug', reason: 'diagnose' }], first.revision), /版本|变化/)
  assert.ok(selected.skills[0].files.find(file => file.path === 'reference.md').content.includes('Original reference'))
  await f.add('review'); assert.equal((await f.library.catalog()).skills.length, 2)
  await rm(join(f.root, 'engineering/debug'), { recursive: true }); assert.deepEqual((await f.library.catalog()).skills.map(s => s.id), ['engineering/review'])
})

test('skill selection rejects unknown IDs and duplicate names while YAML descriptions remain human editable', async () => {
  const f = await fixture(), dir = await f.add('review')
  await writeFile(join(dir, 'SKILL.md'), '---\nname: review\ndescription: >-\n  Review the change\n  against the spec.\ncustom:\n  tags: [code, quality]\n---\n# Body\n')
  const catalog = await f.library.catalog()
  assert.equal(catalog.skills.find(s => s.name === 'review').description, 'Review the change against the spec.')
  await assert.rejects(f.library.select([{ id: '../debug', reason: 'escape' }], catalog.revision), /未知|无效/)
  await writeFile(join(dir, 'SKILL.md'), '---\nname: debug\ndescription: duplicate\n---\n')
  await assert.rejects(f.library.catalog(), /重名|重复/)
})
