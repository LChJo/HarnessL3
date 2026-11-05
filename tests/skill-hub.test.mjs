import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSkillLibrary } from '../server/skill-library.mjs'
import { createSkillHub } from '../server/skill-hub-watch.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'harness-hub-'))
  const add = async (name, description = 'Find the cause') => {
    const dir = join(root, 'engineering', name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`)
    return dir
  }
  await add('debug')
  return { root, add, library: createSkillLibrary({ root }) }
}
function changed(hub, predicate) {
  if (predicate(hub.status())) return Promise.resolve(hub.status())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error('catalog update was not observed')) }, 4000)
    const stop = hub.onChange(value => { if (predicate(value)) { clearTimeout(timer); stop(); resolve(value) } })
  })
}

test('Skill Hub automatically discovers edits/additions/removals and recovers from invalid files', async t => {
  const f = await fixture(), hub = await createSkillHub({ ...f, pollInterval: 80, debounceMs: 10 })
  t.after(async () => { await hub.close(); await rm(f.root, { recursive: true, force: true }) })
  const initial = hub.status()
  assert.equal(initial.skills.length, 1); assert.equal(initial.error, null)
  assert.ok(initial.root); assert.ok(initial.checkedAt)
  await f.add('review')
  const added = await changed(hub, s => s.skills.length === 2)
  assert.notEqual(added.revision, initial.revision)
  await writeFile(join(f.root, 'engineering/debug/SKILL.md'), '---\nname: debug\ndescription: Updated diagnosis\n---\nChanged body\n')
  await changed(hub, s => s.skills.some(skill => skill.description === 'Updated diagnosis'))
  await writeFile(join(f.root, 'engineering/debug/SKILL.md'), 'invalid YAML and no header')
  const invalid = await changed(hub, s => !!s.error)
  assert.equal(invalid.stale, true); assert.deepEqual(invalid.skills, [], 'invalid catalog cannot look current')
  await assert.rejects(hub.catalog(), /frontmatter|有效/)
  await f.add('debug', 'Recovered diagnosis')
  await changed(hub, s => !s.error && s.skills.some(skill => skill.description === 'Recovered diagnosis'))
  await rm(join(f.root, 'engineering/review'), { recursive: true })
  await changed(hub, s => !s.error && s.skills.length === 1)
  const refreshed = await hub.refresh('manual')
  assert.equal(refreshed.reason, 'manual'); assert.ok(refreshed.checkedAt)
})

test('derived file references and related skill IDs follow real files without loading bodies into catalog', async () => {
  const f = await fixture(); await f.add('review')
  try {
    await writeFile(join(f.root, 'engineering/debug/SKILL.md'), '---\nname: debug\ndescription: Diagnosis\nrelated:\n  - ../review/SKILL.md\n  - ../missing/SKILL.md\n---\n# Secret body\n')
    await writeFile(join(f.root, 'engineering/debug/reference.md'), '# Reference body')
    const catalog = await f.library.catalog(), debug = catalog.skills.find(s => s.name === 'debug')
    assert.deepEqual(debug.related, ['engineering/review'])
    assert.ok(debug.files.some(file => file.path === 'reference.md' && file.hash && file.bytes))
    assert.ok(debug.diagnostics.some(text => text.includes('missing')))
    assert.ok(!JSON.stringify(catalog).includes('Secret body'))
    assert.ok(!JSON.stringify(catalog).includes('Reference body'))
    await f.add('ask-matt')
    assert.ok(!(await f.library.catalog()).skills.some(skill => skill.id === 'engineering/ask-matt'), 'a reference source may retain the original built-in router folder')
    await writeFile(join(f.root, 'engineering/debug/SKILL.md'), '---\nname: skill-hub\ndescription: Try to replace built-in router\n---\n')
    await assert.rejects(f.library.catalog(), /内置|覆盖/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
