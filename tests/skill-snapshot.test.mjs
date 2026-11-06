import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, relative, isAbsolute, sep } from 'node:path'
import { parseDocument } from 'yaml'

test('a skill edited between scans cannot retain an old brief under the new content revision', async () => {
  // Simulate an editor replacing SKILL.md at the filesystem boundary. Each complete read
  // observes a valid version; the public catalog and selection must agree on that version.
  const oldBody = '---\nname: debug\ndescription: Diagnose a failure\n---\n# Diagnosis\n'
  const newBody = '---\nname: debug\ndescription: Perform an unrelated deployment\n---\n# Deployment\n'
  let reads = 0
  const file = name => ({ name, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false })
  const directory = name => ({ ...file(name), isDirectory: () => true, isFile: () => false })
  const root = join(process.cwd(), 'virtual-skills')
  const source = (await readFile(new URL('../server/skill-library.mjs', import.meta.url), 'utf8')).replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '').replace('function createSkillLibrary', 'return function createSkillLibrary')
  const factory = new Function('createHash', 'readFile', 'readdir', 'realpath', 'join', 'relative', 'isAbsolute', 'sep', 'parseDocument', source)
  const library = factory(createHash, async (_path, encoding) => { const body = ++reads === 1 ? oldBody : newBody; return encoding ? body : Buffer.from(body) }, async path => path === root ? [directory('engineering')] : path === join(root, 'engineering') ? [directory('debug')] : [file('SKILL.md')], async path => path, join, relative, isAbsolute, sep, parseDocument)({ root })
  const catalog = await library.catalog()
  assert.equal(catalog.skills[0].description, 'Diagnose a failure')
  await assert.rejects(library.select([{ id: 'engineering/debug', reason: 'Need diagnosis' }], catalog.revision), /版本|变化/)
})
