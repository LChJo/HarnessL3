// Documentation validator only. No CLI implementation and no package dependency.
import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

const root = new URL('./', import.meta.url)
const schemas = new Map()
const files = (await readdir(root)).filter(name => name.endsWith('.schema.json')).sort()
for (const name of files) {
  const schema = JSON.parse(await readFile(new URL(name, root), 'utf8'))
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
  assert(!schemas.has(schema.$id), `Duplicate schema id: ${schema.$id}`)
  schemas.set(schema.$id, schema)
}
const canon = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canon).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canon(value[key])}`).join(',')}}`
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const digest = (kind, content) => hash(canon({ schemaVersion: 1, kind, content }))
const equal = (a, b) => canon(a) === canon(b)
function resolve(ref, base) {
  const url = new URL(ref, base), key = new URL(url)
  key.hash = ''
  let value = schemas.get(key.href)
  assert(value, `Unresolved external schema: ${url.href}`)
  if (url.hash) {
    const pointer = decodeURIComponent(url.hash.slice(1))
    assert(pointer.startsWith('/'), `Unsupported reference fragment: ${url.href}`)
    for (const part of pointer.slice(1).split('/')) value = value?.[part.replaceAll('~1', '/').replaceAll('~0', '~')]
    assert(value !== undefined, `Unresolved JSON pointer: ${url.href}`)
  }
  return { schema: value, base: key.href }
}
const knownKeywords = new Set(['$schema', '$id', '$ref', '$defs', 'title', 'description', 'type', 'const', 'enum', 'required', 'properties', 'additionalProperties', 'propertyNames', 'items', 'uniqueItems', 'minItems', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'format', 'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else'])
function inspect(schema, base) {
  if (typeof schema === 'boolean') return
  assert(schema && typeof schema === 'object' && !Array.isArray(schema), 'A subschema must be an object or boolean')
  for (const keyword of Object.keys(schema)) assert(knownKeywords.has(keyword), `Validator must implement new keyword: ${keyword}`)
  if (schema.$ref) resolve(schema.$ref, base)
  if (schema.pattern) new RegExp(schema.pattern, 'u')
  if (schema.format) assert(['date-time', 'uri'].includes(schema.format), `Unsupported format: ${schema.format}`)
  for (const keyword of ['$defs', 'properties']) for (const child of Object.values(schema[keyword] ?? {})) inspect(child, base)
  for (const keyword of ['items', 'additionalProperties', 'propertyNames', 'not', 'if', 'then', 'else']) if (schema[keyword] !== undefined) inspect(schema[keyword], base)
  for (const keyword of ['oneOf', 'anyOf', 'allOf']) for (const child of schema[keyword] ?? []) inspect(child, base)
}
for (const [base, schema] of schemas) inspect(schema, base)
function validate(schema, value, base, path = '$') {
  if (schema === true) return []
  if (schema === false) return [`${path}: disallowed`]
  const errors = [], report = text => errors.push(`${path}: ${text}`)
  if (schema.$ref) {
    const resolved = resolve(schema.$ref, base)
    errors.push(...validate(resolved.schema, value, resolved.base, path))
  }
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value)
  const matchesType = type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value)
    : type === 'object' ? isObject : type === 'integer' ? Number.isSafeInteger(value)
      : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type
  if (schema.type && ![schema.type].flat().some(matchesType)) report(`expected ${JSON.stringify(schema.type)}`)
  if (Object.hasOwn(schema, 'const') && !equal(value, schema.const)) report('const mismatch')
  if (schema.enum && !schema.enum.some(item => equal(item, value))) report('enum mismatch')
  if (isObject) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) report(`missing required property ${key}`)
    for (const [key, child] of Object.entries(value)) {
      if (schema.propertyNames) errors.push(...validate(schema.propertyNames, key, base, `${path}.{${key}}`))
      if (schema.properties && Object.hasOwn(schema.properties, key)) errors.push(...validate(schema.properties[key], child, base, `${path}.${key}`))
      else if (schema.additionalProperties === false) report(`unknown property ${key}`)
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') errors.push(...validate(schema.additionalProperties, child, base, `${path}.${key}`))
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) report('too few items')
    if (schema.maxItems !== undefined && value.length > schema.maxItems) report('too many items')
    if (schema.uniqueItems && new Set(value.map(canon)).size !== value.length) report('duplicate items')
    if (schema.items !== undefined) value.forEach((item, index) => errors.push(...validate(schema.items, item, base, `${path}[${index}]`)))
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) report('string too short')
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) report('string too long')
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) report('pattern mismatch')
    if (schema.format === 'date-time' && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value)))) report('invalid date-time')
    if (schema.format === 'uri') try { new URL(value) } catch { report('invalid absolute URI') }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) report('below minimum')
    if (schema.maximum !== undefined && value > schema.maximum) report('above maximum')
  }
  for (const child of schema.allOf ?? []) errors.push(...validate(child, value, base, path))
  if (schema.anyOf && !schema.anyOf.some(child => !validate(child, value, base, path).length)) report('no anyOf branch matches')
  if (schema.oneOf && schema.oneOf.filter(child => !validate(child, value, base, path).length).length !== 1) report('oneOf must match exactly one branch')
  if (schema.not && !validate(schema.not, value, base, path).length) report('not clause matched')
  if (schema.if) {
    const branch = !validate(schema.if, value, base, path).length ? schema.then : schema.else
    if (branch !== undefined) errors.push(...validate(branch, value, base, path))
  }
  return errors
}
const examples = new Map()
const mapping = { 'project-config.json': 'project-config', 'aliases.json': 'aliases', 'evidence.json': 'evidence', 'selection.json': 'selection', 'query.json': 'query', 'file-read.json': 'file-read', 'sync-proof.json': 'sync-proof' }
for (const name of (await readdir(new URL('examples/', root))).filter(name => name.endsWith('.json')).sort()) {
  const value = JSON.parse(await readFile(new URL(`examples/${name}`, root), 'utf8'))
  const id = `https://harnessl3.local/spec/v1/${mapping[name] ?? 'response'}.schema.json`
  assert(schemas.has(id), `Missing root schema for ${name}`)
  const errors = validate(schemas.get(id), value, id)
  assert.equal(errors.length, 0, `${name}: ${errors.join('; ')}`)
  examples.set(name, { value, id })
}
let negatives = 0
function reject(name, change) {
  const { value, id } = examples.get(name), copy = structuredClone(value)
  change(copy)
  assert(validate(schemas.get(id), copy, id).length, `Invalid fixture was accepted: ${name}`)
  negatives++
}
reject('selection.json', value => { delete value.binding })
reject('selection.json', value => { delete value.requestId })
reject('selection.json', value => { value.requestId = 'automatic' })
reject('selection.json', value => { value.schemaVersion = 2 })
reject('selection.json', value => { value.skills[0].reason = '' })
reject('selection.json', value => { value.context.read.push(value.context.read[0]) })
reject('selection.json', value => { value.extra = true })
reject('query.json', value => { value.expectedModelRevision = 'not-a-sha256' })
reject('query.json', value => { value.expand = []; value.read = [] })
reject('query.json', value => { value.read = ['app.worker'] })
reject('query.json', value => { value.known = { 'app.worker': 'a'.repeat(64) } })
reject('sync-proof.json', value => { value.checks = [] })
reject('sync-proof.json', value => { delete value.requestId })
reject('sync-proof.json', value => { value.requestId = 'phase-is-not-a-request-id' })
reject('sync-proof.json', value => { value.checks[0].status = 'probably' })
reject('sync-proof.json', value => { value.scope = { paths: [], entities: [] } })
reject('sync-proof.json', value => { value.expectedSourceVersion.status = 'unknown' })
reject('project-config.json', value => { value.skills.root = '../other-worktree' })
reject('project-config.json', value => { value.skills.root = 'C:/skills' })
reject('project-config.json', value => { value.source.excludePatterns = ['!src/**'] })
reject('file-read.json', value => { value.files[0].path = 'a/../SKILL.md' })
reject('file-read.json', value => { value.files[0].path = 'a\\SKILL.md' })
reject('file-read.json', value => { value.files[0].path = '/SKILL.md' })
reject('file-read.json', value => { value.files[0].path = 'a\u0000' })
reject('selection-response.json', value => { value.data.result.contexts[0].entity.source = 'inference' })
reject('selection-response.json', value => { value.data.result.contexts[0].entity.evidenceIds = [] })
reject('selection-response.json', value => { value.error = { code: 'INVALID_ARGUMENT', message: 'bad', retryable: false, details: {} } })
reject('file-read-response.json', value => { value.data.files[0].file.encoding = 'auto' })
reject('legacy-response.json', value => { value.data.binding.sourceScanRevision = 'a'.repeat(64) })
reject('error-response.json', value => { delete value.error.code })
reject('no-target-response.json', value => { delete value.requestId })
reject('no-target-response.json', value => { delete value.replayed })
reject('model-maintenance-response.json', value => { value.data.result.stage = 'completed' })
reject('model-maintenance-response.json', value => { value.data.result.mode = 'snapshot' })
reject('model-maintenance-response.json', value => { value.data.result.modelState = 'invalid' })
reject('model-maintenance-response.json', value => { value.data.result.sourceScan = 'verified' })
const replayFixture = structuredClone(examples.get('selection-response.json'))
replayFixture.value.replayed = true
assert.equal(validate(schemas.get(replayFixture.id), replayFixture.value, replayFixture.id).length, 0)

// Cross-field semantics that standard JSON Schema does not express.
const selection = examples.get('selection.json').value
const selected = examples.get('selection-response.json').value
const entry = examples.get('task-entry-response.json').value
const config = examples.get('project-config.json').value
const sourceManifest = { entries: [{ path: 'src/cancel.ts', entryKind: 'file', contentHash: hash('export function cancel() {}\n') }] }
assert.equal(selection.binding.sourceVersion.treeHash, digest('source-manifest', sourceManifest))
const gitIgnoreRevision = digest('git-ignore-rules', { ignoreCase: false, sources: [{ origin: 'global', path: null, hash: null }, { origin: 'info', path: null, hash: null }] })
const policy = {
  scannerVersion: 'source-scanner/1', candidateSet: 'head-index-and-untracked', pathOrder: 'utf16-code-unit', ruleDialect: 'posix-glob-v1',
  caseSensitive: true, includePatterns: ['**'], fixedExcludePrefixes: ['.git', '.harness'], projectExcludePatterns: [...config.source.excludePatterns].sort(),
  gitIgnoreMode: 'untracked-only', gitIgnoreRevision, skillRootExcludePrefixes: [config.skills.root],
  linkHandling: 'record-readlink-utf8-no-follow', unsupportedEntryHandling: 'unknown',
}
assert.equal(selection.binding.sourceScanRevision, digest('source-scan-policy', policy))
const catalogManifest = entry.data.catalog.flatMap(skill => skill.files.map(({ path, hash }) => ({ path: `${skill.id}/${path}`, hash })))
  .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
assert.equal(selection.binding.catalogRevision, digest('skill-catalog', catalogManifest))
assert.deepEqual(selected.data.binding, selection.binding)
assert.deepEqual(selected.target, { projectId: selection.binding.projectId, worktreeId: selection.binding.worktreeId })
assert.equal(selected.requestId, selection.requestId)
assert.equal(selected.data.skillPlan.batchId, selected.data.result.batchId)
assert.equal(selected.data.skillPlan.catalogRevision, selection.binding.catalogRevision)
assert.equal(new Set(selection.skills.map(item => item.id)).size, selection.skills.length)
for (const { value } of examples.values()) {
  if (value.data?.binding) assert.deepEqual(value.target, { projectId: value.data.binding.projectId, worktreeId: value.data.binding.worktreeId })
  const result = value.data?.result
  if (['context-batch', 'selection'].includes(value.data?.kind)) assert.equal(value.data.status === 'partial', result.errors.length > 0)
  for (const context of [...(result?.contexts ?? []), ...(value.data?.packet?.contexts ?? [])]) {
    const { contentHash, ...content } = context
    assert.equal(contentHash, digest('context-body', content))
    assert.equal(context.entity.id, context.entity.id.toLowerCase())
  }
  for (const item of value.data?.files ?? []) {
    const file = item.file, bytes = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8')
    assert.equal(file.bytes, bytes.length)
    assert.equal(file.hash, hash(bytes))
  }
}
const fileRequest = examples.get('file-read.json').value
const fileResponse = examples.get('file-read-response.json').value
assert.equal(fileRequest.files.length, fileResponse.data.files.length)
for (const item of fileRequest.files) {
  const returned = fileResponse.data.files.find(candidate => candidate.skillId === item.skillId && candidate.file.path === item.path)
  assert(returned)
  assert.equal(item.expectedHash, returned.file.hash)
}
assert.equal(fileRequest.throughBatchId, fileResponse.data.throughBatchId)
assert.deepEqual(selected.data.skillPlan.skills[0].files, fileResponse.data.files.map(({ file: { content, ...ref } }) => ref))
assert.equal(selected.data.skillPlan.skills[0].contentHash, digest('skill-files', selected.data.skillPlan.skills[0].files.map(({ path, hash }) => ({ path, hash }))))
console.log(JSON.stringify({ schemas: schemas.size, examples: examples.size, rejectedInvalidExamples: negatives, crossFieldChecks: 'passed', validator: 'dependency-free schema subset; not a general draft 2020-12 engine' }, null, 2))
