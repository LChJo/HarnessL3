import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, mkdir, symlink, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { canonicalJson, parseJsonStrict, digest, sha256 } from '../../build/core/json.js'
import { atomicWrite, readJson, writeJson } from '../../build/core/io.js'
import { canonicalPath, resolveInside, isWithin, safeRelative } from '../../build/core/paths.js'
import { validateContract } from '../../build/core/contract.js'

test('JCS uses UTF-16 property order and original strings, including RFC number serialization', () => {
  assert.equal(canonicalJson({ z: -0, a: [1e30, 0.000001, '\u20ac'], '\ud83d\ude00': 2, '\ufffd': 3 }),
    '{"a":[1e+30,0.000001,"\u20ac"],"z":0,"\ud83d\ude00":2,"\ufffd":3}')
  assert.notEqual(digest('body', { a: 'e\u0301' }), digest('body', { a: '\u00e9' }))
  assert.equal(digest('body', { z: 2, a: 1 }), sha256('{"content":{"a":1,"z":2},"kind":"body","schemaVersion":1}'))
})

test('strict JSON rejects duplicate keys, invalid Unicode, nonfinite numbers and trailing input', () => {
  assert.deepEqual(parseJsonStrict('\ufeff{"valid":[true,null,"ok"]}'), { valid: [true, null, 'ok'] })
  for (const text of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"a":{"x":1,"x":2}}', '"\\ud800"', '1e999', '{"x":undefined}', '{}{}', '\ufeff\ufeff{}']) {
    assert.throws(() => parseJsonStrict(text), error => error.code === 'INVALID_JSON', text)
  }
  const value = parseJsonStrict('{"__proto__":{"polluted":true}}')
  assert.equal(Object.hasOwn(value, '__proto__'), true)
  assert.equal({}.polluted, undefined)
  for (const value of [NaN, Infinity, undefined, { x: undefined }, { x: '\ud800' }]) assert.throws(() => canonicalJson(value))
})

test('Draft 2020-12 validates normalized requests deeply and reports unknown schema versions', () => {
  const value = { schemaVersion: 1, projectId: '10000000-0000-4000-8000-000000000001', name: 'Example', source: { excludePatterns: [] } }
  assert.deepEqual(validateContract('project-config', value), value)
  assert.throws(() => validateContract('project-config', { ...value, extra: true }), e => e.code === 'SCHEMA_INVALID')
  assert.throws(() => validateContract('project-config', { ...value, schemaVersion: 2 }), e => e.code === 'UNSUPPORTED_SCHEMA')
  assert.throws(() => validateContract('project-config', { ...value, skills: { root: '../escape' } }), e => e.code === 'SCHEMA_INVALID')
})

test('Schema failures point at the installed request example when one ships', () => {
  const selection = { schemaVersion: 1, requestId: '10000000-0000-4000-8000-000000000001', binding: {}, context: [], skills: [] }
  const failure = (() => { try { validateContract('selection', selection) } catch (error) { return error } })()
  assert.equal(failure.code, 'SCHEMA_INVALID')
  assert.ok(failure.details.example.endsWith(path.join('examples', 'selection.json')), JSON.stringify(failure.details))
  const response = (() => { try { validateContract('response', { schemaVersion: 1 }) } catch (error) { return error } })()
  assert.equal(response.code, 'SCHEMA_INVALID')
  assert.equal('example' in response.details, false)
})

test('atomic replace preserves current file when the new write fails and preserves exact bytes', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'harnessl3-io-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'state.json')
  await writeJson(file, { value: 1 })
  await atomicWrite(file, Buffer.from('{"value":2}\n'))
  assert.deepEqual(await readJson(file), { value: 2 })
  await mkdir(path.join(root, 'directory'))
  await assert.rejects(atomicWrite(path.join(root, 'directory'), 'cannot replace a directory'))
  assert.equal(await readFile(file, 'utf8'), '{"value":2}\n')
})

test('path boundaries resolve existing ancestors and reject traversal and linked escapes', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'harnessl3-path-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const inside = path.join(root, 'project')
  const outside = path.join(root, 'outside')
  await mkdir(inside); await mkdir(outside)
  assert.equal(await canonicalPath(path.join(inside, 'missing', 'file')), path.join(await canonicalPath(inside), 'missing', 'file'))
  assert.equal(isWithin(inside, inside), true)
  assert.equal(isWithin(inside, inside + '-other'), false)
  for (const input of ['../outside', '/absolute', 'C:/absolute', 'a\\b', 'a/../b', 'a//b', 'a\u0000b']) assert.throws(() => safeRelative(input))
  await symlink(outside, path.join(inside, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(resolveInside(inside, 'link/file', { allowMissing: true }))
  assert.equal(await resolveInside(inside, 'new/file', { allowMissing: true }), path.join(inside, 'new', 'file'))
})
