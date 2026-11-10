import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { captureModelRevision, loadModel, modelDirectory, modelBody } from '../../build/core/model.js'

const ids = {
  app: '10000000-0000-4000-8000-000000000001',
  worker: '10000000-0000-4000-8000-000000000002',
  api: '10000000-0000-4000-8000-000000000003',
  relation: '20000000-0000-4000-8000-000000000001',
  second: '20000000-0000-4000-8000-000000000002',
  proof: '30000000-0000-4000-8000-000000000001',
}
const sourceVersion = { head: 'a'.repeat(40), treeHash: 'b'.repeat(64), status: 'clean' }
const hash = value => createHash('sha256').update(value).digest('hex')
const metadata = (id, brief, extra = '') => `metadata {
  harness_id "${id}"
  brief "${brief}"
  source "human"
  status "unknown"
  evidence "none"
  version "1"
  ${extra}
}`
const specification = 'specification {\n element system\n element component\n relationship calls\n}\n'
const model = () => `${specification}
model {
  app = system "Application" {
    ${metadata(ids.app, 'Owns the application boundary')}
    description "Application local body"
    worker = component "Worker" {
      ${metadata(ids.worker, 'Runs queued work')}
      description "Worker secret local body"
    }
    api = component "API" {
      ${metadata(ids.api, 'Accepts requests')}
      description "API secret local body"
    }
  }
  app.worker -[calls]-> app.api "Dispatch" {
    ${metadata(ids.relation, 'Dispatches queued requests')}
    description "Relation local body"
  }
}
views { view overview { include * } }
`
async function fixture(t, body = model(), evidence = []) {
  const root = await mkdtemp(join(tmpdir(), 'harness-v1-model-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.harness', 'model'), { recursive: true })
  await writeFile(join(root, '.harness', 'model', 'main.c4'), body)
  await writeFile(join(root, '.harness', 'evidence.json'), JSON.stringify({ schemaVersion: 1, evidence }))
  await writeFile(join(root, '.harness', 'aliases.json'), JSON.stringify({ schemaVersion: 1, aliases: {} }))
  return root
}
const rejectsModel = (promise, pattern) => assert.rejects(promise, error => {
  assert.equal(error.code, 'MODEL_INVALID')
  assert.ok(error.details.diagnostics.length)
  assert.match(JSON.stringify(error.details.diagnostics), pattern)
  return true
})

test('formal LikeC4 parses UUIDs, direct directories, exact local bodies and real C4 layouts', async t => {
  const root = await fixture(t)
  const snapshot = await loadModel(root)
  assert.match(snapshot.revision, /^[a-f0-9]{64}$/)
  assert.equal(snapshot.entities.length, 4)
  assert.deepEqual(modelDirectory(snapshot).items.map(item => item.id), [ids.app])
  assert.equal(modelDirectory(snapshot).items[0].children, 2)
  assert.deepEqual(modelDirectory(snapshot, ids.app).items.map(item => item.id), [ids.worker, ids.api])
  const parentBody = modelBody(snapshot, ids.app, sourceVersion)
  assert.equal(parentBody.entity.description, 'Application local body')
  assert.ok(!JSON.stringify(parentBody).includes('Worker secret'))
  const worker = modelBody(snapshot, ids.worker, sourceVersion)
  assert.deepEqual(worker.ancestors.map(item => item.id), [ids.app])
  assert.deepEqual(worker.relationships, [{ id: ids.relation, sourceId: ids.worker, targetId: ids.api, kind: 'calls', brief: 'Dispatches queued requests', scope: 'boundary-reference' }])
  assert.ok(!JSON.stringify(worker).includes('API secret'))
  const relation = modelBody(snapshot, ids.relation, sourceVersion)
  assert.deepEqual(relation.ancestors, [])
  assert.deepEqual(relation.relationships, [])
  assert.equal(relation.entity.sourceId, ids.worker)
  assert.equal(relation.entity.targetId, ids.api)
  assert.match(worker.contentHash, /^[a-f0-9]{64}$/)
  assert.equal(snapshot.views.length, 1)
  assert.ok(snapshot.views[0].nodes.length)
  assert.ok(snapshot.views[0].bounds.width > 0)
  assert.ok(snapshot.views[0].nodes.every(node => typeof node.harnessId === 'string'))
})

test('multiple model files and raw-byte changes determine modelRevision', async t => {
  const root = await fixture(t)
  const initial = await loadModel(root)
  const path = join(root, '.harness', 'model', 'extra.likec4')
  await writeFile(path, '// Additional model source\n')
  const expanded = await loadModel(root)
  assert.notEqual(expanded.revision, initial.revision)
  await writeFile(path, '// Additional model source\r\n')
  assert.notEqual((await loadModel(root)).revision, expanded.revision)
})

test('empty valid template is legal without inventing objects or views', async t => {
  const root = await fixture(t, `${specification}\nmodel {}\n`)
  const snapshot = await loadModel(root)
  assert.deepEqual(snapshot.entities, [])
  assert.deepEqual(snapshot.views, [])
  assert.deepEqual(modelDirectory(snapshot), { parentId: null, items: [] })
})

test('captured attempted revision fingerprints invalid bytes without publishing a valid model', async t => {
  const root = await fixture(t)
  const valid = await loadModel(root)
  assert.equal(await captureModelRevision(root), valid.revision)
  const file = join(root, '.harness', 'model', 'main.c4')
  for (const bytes of [Buffer.from(model() + '\nmodel { broken =\n'), Buffer.from([0xff, 0xfe, 0x00])]) {
    await writeFile(file, bytes)
    const attempted = await captureModelRevision(root)
    assert.match(attempted, /^[a-f0-9]{64}$/)
    assert.notEqual(attempted, valid.revision)
    await assert.rejects(loadModel(root), error => { assert.equal(error.code, 'MODEL_INVALID'); assert.equal(error.details.attemptedModelRevision, attempted); return true })
  }
  await rm(join(root, '.harness', 'aliases.json'))
  assert.equal(await captureModelRevision(root), null, 'missing or inaccessible required manifest input is unknown')
})

test('relation UUID and object UUID share uniqueness space', async t => {
  const root = await fixture(t, model().replace(ids.relation, ids.app))
  await rejectsModel(loadModel(root), /duplicate|unique|重复/i)
})

test('distinct relationships with identical endpoints retain their separate UUIDs', async t => {
  const body = model().replace('\n}\nviews', `\n app.worker -[calls]-> app.api "Another dispatch" { ${metadata(ids.second, 'Second separate relationship')} }\n}\nviews`)
  const root = await fixture(t, body)
  const snapshot = await loadModel(root)
  assert.equal(snapshot.entities.filter(entity => entity.entityType === 'relation').length, 2)
  assert.deepEqual(modelBody(snapshot, ids.worker, sourceVersion).relationships.map(relation => relation.id), [ids.relation, ids.second])
})

test('initialization reports actionable evidence syntax and relationship kinds without cascading missing IDs', async t => {
  const proofs = [ids.proof, '30000000-0000-4000-8000-000000000002']
  const evidence = proofs.map(id => ({ id, kind: 'manual', claim: 'Fixture reference', location: { url: 'https://example.invalid/reference' }, hash: null, observedAt: null }))
  const body = model().replace('evidence "none"', `evidence "${proofs.join(',')}"`).replace('-[calls]->', '->')
  const root = await fixture(t, body, evidence)
  await assert.rejects(loadModel(root), error => {
    const messages = error.details.diagnostics.map(item => item.message)
    assert.ok(messages.some(message => message.includes('single space') && message.includes('not commas')))
    assert.ok(messages.some(message => message.includes('-[calls]->') && message.includes('relationship calls')))
    assert.ok(!messages.some(message => message.includes('evidence UUID does not exist')))
    return true
  })
  await writeFile(join(root, '.harness/model/main.c4'), model().replace('evidence "none"', `evidence "${proofs.join(' ')}"`))
  assert.equal((await loadModel(root)).entities.length, 4)
})

for (const field of ['brief', 'source', 'status', 'evidence', 'version', 'harness_id']) {
  test(`required metadata ${field} is enforced with file and line diagnostics`, async t => {
    const body = model().replace(new RegExp(`\\s+${field} "[^"\\n]*"`), '')
    const root = await fixture(t, body)
    await assert.rejects(loadModel(root), error => {
      assert.equal(error.code, 'MODEL_INVALID')
      const diagnostic = error.details.diagnostics.find(item => item.message.includes(field))
      assert.ok(diagnostic)
      assert.equal(diagnostic.file, '.harness/model/main.c4')
      assert.ok(diagnostic.line >= 1)
      assert.ok(diagnostic.column >= 1)
      return true
    })
  })
}

test('scalar metadata cannot be duplicated or an array', async t => {
  const root = await fixture(t, model().replace('brief "Owns the application boundary"', 'brief "First"\n brief "Second"'))
  await rejectsModel(loadModel(root), /brief|duplicate|重复/i)
  await writeFile(join(root, '.harness', 'model', 'main.c4'), model().replace('brief "Owns the application boundary"', 'brief ["First", "Second"]'))
  await rejectsModel(loadModel(root), /brief|scalar|单个/i)
})

test('LikeC4 grammar and reference errors are surfaced without partial models', async t => {
  const root = await fixture(t, model().replace('app.api "Dispatch"', 'app.missing "Dispatch"'))
  await rejectsModel(loadModel(root), /missing|resolve|reference|refer/i)
  await writeFile(join(root, '.harness', 'model', 'main.c4'), model().replace('app = system', 'app = undefined_kind'))
  await rejectsModel(loadModel(root), /undefined_kind|resolve|kind/i)
})

test('inference cannot be verified and verified requires a resolvable evidence UUID', async t => {
  const root = await fixture(t, model().replace('source "human"', 'source "inference"').replace('status "unknown"', 'status "verified"'))
  await rejectsModel(loadModel(root), /inference|verified/i)
  await writeFile(join(root, '.harness', 'model', 'main.c4'), model().replace('status "unknown"', 'status "verified"'))
  await rejectsModel(loadModel(root), /evidence|verified/i)
})

test('evidence records retain reference truth, not semantic success from matching bytes', async t => {
  const bytes = Buffer.from('source body\n')
  const evidence = [{ id: ids.proof, kind: 'source-code', claim: 'A limited source claim', location: { path: 'src/main.txt' }, hash: hash(bytes), observedAt: '2026-11-05T00:00:00.000Z', range: { startLine: 1, endLine: 1 } }]
  const body = model().replace('status "unknown"', 'status "verified"').replace('evidence "none"', `evidence "${ids.proof}"`)
  const root = await fixture(t, body, evidence)
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'main.txt'), bytes)
  const matched = await loadModel(root)
  assert.deepEqual(matched.evidence, evidence)
  assert.deepEqual(modelBody(matched, ids.app, sourceVersion).evidenceIds, [ids.proof])
  await writeFile(join(root, 'src', 'main.txt'), 'changed')
  const changed = await loadModel(root)
  assert.equal(changed.revision, matched.revision, 'source freshness is separate from authoritative modelRevision')
  assert.ok(changed.diagnostics.some(item => /changed/i.test(item.code)))
  assert.equal(changed.entities[0].status, 'verified', 'authored claim is not silently rewritten')
  await rm(join(root, 'src', 'main.txt'))
  assert.ok((await loadModel(root)).diagnostics.some(item => /missing/i.test(item.code)))
})

test('TC06 unavailable Git classification is an explicit document warning while model browsing remains available', async t => {
  const bytes = Buffer.from('Retained project document\n')
  const evidence = [{ id: ids.proof, kind: 'document', claim: 'Retained decision', location: { path: 'decision.md' }, hash: hash(bytes), observedAt: '2026-11-07T00:00:00.000Z' }]
  const root = await fixture(t, model().replace('evidence "none"', `evidence "${ids.proof}"`), evidence)
  await writeFile(join(root, 'decision.md'), bytes)
  await mkdir(join(root, '.git'))
  const snapshot = await loadModel(root)
  assert.equal(snapshot.entities.length, 4)
  assert.ok(snapshot.diagnostics.some(item => item.code === 'EVIDENCE_GIT_UNKNOWN' && item.evidenceId === ids.proof))
})

test('relation evidence is included in exact boundary evidence union', async t => {
  const evidence = [{ id: ids.proof, kind: 'manual', claim: 'Reviewed relationship', location: { url: 'https://example.test/proof' }, hash: null, observedAt: null }]
  const root = await fixture(t, model().replace('brief "Dispatches queued requests"\n  source "human"\n  status "unknown"\n  evidence "none"', `brief "Dispatches queued requests"\n  source "human"\n  status "unknown"\n  evidence "${ids.proof}"`), evidence)
  assert.deepEqual(modelBody(await loadModel(root), ids.worker, sourceVersion).evidenceIds, [ids.proof])
})

test('invalid evidence shapes, paths and ranges fail instead of fetching other files', async t => {
  const root = await fixture(t)
  const evidenceFile = join(root, '.harness', 'evidence.json')
  for (const path of ['../elsewhere', '/absolute', 'C:/outside', 'src\\bad', 'src//bad']) {
    await writeFile(evidenceFile, JSON.stringify({ schemaVersion: 1, evidence: [{ id: ids.proof, kind: 'source-code', claim: 'bad path', location: { path }, hash: null, observedAt: null }] }))
    await rejectsModel(loadModel(root), /path|location|relative|boundary/i)
  }
  await writeFile(evidenceFile, JSON.stringify({ schemaVersion: 1, evidence: [{ id: ids.proof, kind: 'manual', claim: 'bad range', location: { url: 'https://example.test' }, hash: null, observedAt: null, range: { startLine: 4, endLine: 2 } }] }))
  await rejectsModel(loadModel(root), /range|Line/i)
})

test('aliases preserve old locators without accepting ambiguous current locators', async t => {
  const root = await fixture(t)
  const file = join(root, '.harness', 'aliases.json')
  await writeFile(file, JSON.stringify({ schemaVersion: 1, aliases: { 'app.old-worker': ids.worker } }))
  assert.equal((await loadModel(root)).aliases['app.old-worker'], ids.worker)
  await writeFile(file, JSON.stringify({ schemaVersion: 1, aliases: { 'app.api': ids.worker } }))
  await rejectsModel(loadModel(root), /alias|locator|ambig/i)
  await writeFile(file, JSON.stringify({ schemaVersion: 1, aliases: { old: ids.proof } }))
  await rejectsModel(loadModel(root), /alias|exist|target/i)
})

test('directory and body reject unknown entities and do not expand relationships', async t => {
  const root = await fixture(t)
  const snapshot = await loadModel(root)
  assert.throws(() => modelDirectory(snapshot, ids.relation), { code: 'NOT_EXPANDABLE' })
  assert.throws(() => modelDirectory(snapshot, ids.proof), { code: 'ENTITY_NOT_FOUND' })
  assert.throws(() => modelBody(snapshot, 'app.worker', sourceVersion), { code: 'ENTITY_NOT_FOUND' })
})

test('duplicate JSON keys and invalid UTF-8 are not silently accepted', async t => {
  const root = await fixture(t)
  const path = join(root, '.harness', 'aliases.json')
  await writeFile(path, '{"schemaVersion":1,"aliases":{},"aliases":{}}')
  await rejectsModel(loadModel(root), /duplicate|aliases/i)
  await writeFile(path, JSON.stringify({ schemaVersion: 1, aliases: {} }))
  await writeFile(join(root, '.harness', 'model', 'main.c4'), Buffer.from([0xff, 0xfe, 0x00]))
  await rejectsModel(loadModel(root), /UTF|encoding/i)
})

test('model and evidence symlinks cannot escape the managed worktree', async t => {
  const root = await fixture(t)
  const outside = await mkdtemp(join(tmpdir(), 'harness-v1-model-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'external.c4'), '// external')
  try { await symlink(join(outside, 'external.c4'), join(root, '.harness', 'model', 'escape.c4')) }
  catch (error) { if (error.code === 'EPERM') return t.skip('OS does not grant symlink creation'); throw error }
  await rejectsModel(loadModel(root), /link|boundary|outside/i)
})
