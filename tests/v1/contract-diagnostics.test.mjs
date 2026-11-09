import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { validateContract } from '../../build/core/contract.js'
import { binary, execFile } from './helpers.mjs'

const entityId = '10000000-0000-4000-8000-000000000002'
const example = async name => JSON.parse(await readFile(new URL(`../../docs/spec/contracts/examples/${name}.json`, import.meta.url), 'utf8'))
function failure(name, value) {
  try { validateContract(name, value) } catch (error) {
    assert.equal(error.code, 'SCHEMA_INVALID')
    assert.equal(error.exitCode, 2)
    return error
  }
  assert.fail('Expected the invalid request to be rejected')
}

test('TC22 known errors identify the field, expected constraint and same-task recovery without echoing values', async () => {
  for (const name of ['selection', 'query']) {
    const request = await example(name)
    const fields = name === 'selection' ? request.context : request
    const prefix = name === 'selection' ? '/context/known' : '/known'
    for (const invalid of ['already-read-private-text', 'A'.repeat(64), 'a'.repeat(63), true]) {
      fields.known = { [entityId]: invalid }
      const error = failure(name, request)
      const diagnostic = error.details.diagnostics.find(item => item.path === `${prefix}/${entityId}`)
      assert.ok(diagnostic, JSON.stringify(error.details))
      assert.match(diagnostic.hint, /\{\}.*this task.*contentHash.*64 lowercase/)
      assert.ok(diagnostic.schemaPath)
      assert.ok(diagnostic.params)
      assert.match(error.message, new RegExp(prefix))
      assert.ok(path.isAbsolute(error.details.schemaFile))
      assert.ok(!JSON.stringify(error.details).includes('already-read-private-text'))
    }
    fields.known = {}
    assert.equal(validateContract(name, request), request)
    fields.known = { [entityId]: 'a'.repeat(64) }
    assert.equal(validateContract(name, request), request, 'Schema acceptance does not assert that the body is retained')
  }
})

test('TC22 diagnostics point at missing, unknown and escaped invalid known keys', async () => {
  const request = await example('selection')
  delete request.context.known
  const missing = failure('selection', request).details.diagnostics.find(item => item.keyword === 'required')
  assert.equal(missing.path, '/context/known')
  assert.equal(missing.params.missingProperty, 'known')
  assert.match(missing.hint, /\{\}/)
  request.context.known = { 'bad/id~key': 'a'.repeat(64) }
  const keyError = failure('selection', request).details.diagnostics
  assert.ok(keyError.some(item => item.path === '/context/known/bad~1id~0key' && item.keyword === 'propertyNames'))
  request.context.known = []
  assert.ok(failure('selection', request).details.diagnostics.some(item => item.path === '/context/known' && item.hint))
  request.context.known = {}
  request.context.extra = 'private-value'
  const extra = failure('selection', request).details.diagnostics.find(item => item.keyword === 'additionalProperties')
  assert.equal(extra.path, '/context/extra')
  assert.equal(extra.params.additionalProperty, 'extra')
  assert.equal(extra.hint, undefined, 'Unrelated fields must not receive known guidance')
})

async function temporaryDirectory(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'harnessl3-contract-diagnostics-')))
  t.after(async () => {
    assert.equal(path.dirname(root), await realpath(tmpdir()))
    assert.ok(path.basename(root).startsWith('harnessl3-contract-diagnostics-'))
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  return root
}

test('TC22 CLI rejects malformed known before service dispatch with one error envelope and the original requestId', async t => {
  const root = await temporaryDirectory(t)
  const request = await example('selection')
  request.context.known = { [entityId]: 'not-a-hash' }
  const file = path.join(root, 'request.json')
  const dataRoot = path.join(root, 'unused-data')
  await writeFile(file, JSON.stringify(request), 'utf8')
  await assert.rejects(execFile(process.execPath, [binary, 'task', 'select', '10000000-0000-4000-8000-000000000003', '--file', file, '--data-dir', dataRoot, '--json'], { cwd: root, windowsHide: true }), error => {
    assert.equal(error.code, 2)
    const response = JSON.parse(error.stdout)
    assert.equal(response.ok, false)
    assert.equal(response.requestId, request.requestId)
    assert.equal(Object.hasOwn(response, 'data'), false)
    assert.equal(response.error.code, 'SCHEMA_INVALID')
    assert.match(response.error.details.diagnostics[0].hint, /contentHash/)
    assert.equal(error.stderr, '')
    return true
  })
  await assert.rejects(access(dataRoot))
})

test('TC22 documented caller preserves error envelopes, partial data and CLI exit codes without secondary exceptions', async t => {
  const root = await temporaryDirectory(t)
  const usage = await readFile(new URL('../../docs/USAGE.md', import.meta.url), 'utf8')
  const reader = usage.split('## 可靠读取JSON结果')[1]?.match(/```javascript\r?\n([\s\S]*?)```/)?.[1]
  assert.ok(reader, 'Exercise the actual documented reader')
  const script = path.join(root, 'read-result.mjs')
  const responseFile = path.join(root, 'stdout.json')
  await writeFile(script, reader, 'utf8')
  const failure = { ok: false, requestId: 'retained-request-id', error: { code: 'SCHEMA_INVALID', details: { diagnostics: [{ path: '/context/known', hint: 'Use {}' }] } } }
  const success = { ok: true, data: { status: 'complete', result: { batchId: 'retained-batch' } } }
  const partial = { ok: true, data: { status: 'partial', contexts: ['retained-body'], errors: ['missing-body'] } }
  for (const [body, cliCode, expectedCode] of [[failure, 2, 2], [failure, 130, 130], [failure, 0, 1], [success, 0, 0], [partial, 4, 4], [{}, 0, 1], ['invalid-json', 0, 1]]) {
    await writeFile(responseFile, '\uFEFF' + (typeof body === 'string' ? body : JSON.stringify(body)), 'utf8')
    let result
    try { result = { ...await execFile(process.execPath, [script, String(cliCode), responseFile], { windowsHide: true }), code: 0 } }
    catch (error) { result = error }
    assert.equal(result.code, expectedCode, result.stderr)
    assert.doesNotMatch(result.stderr, /TypeError|KeyError|SyntaxError|at file:/)
    if (body === failure) { assert.deepEqual(JSON.parse(result.stderr), body); assert.equal(result.stdout, '') }
    if (body === success || body === partial) assert.deepEqual(JSON.parse(result.stdout), body.data)
  }
})
