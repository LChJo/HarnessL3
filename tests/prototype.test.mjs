import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkbench } from '../server/workbench.mjs'
import { fingerprint, resolveEvidencePath } from '../server/evidence.mjs'
import { parseCodexRollout } from '../server/agent-log.mjs'
import { verifyEvidence, sha256 } from '../server/evidence.mjs'
import { validateModelContract } from '../server/model-contract.mjs'

test('source identity includes uncommitted file contents; path traversal is rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-evidence-'))
  await writeFile(join(root, 'entry.cpp'), 'version one')
  const first = await fingerprint(root, ['entry.cpp'])
  await writeFile(join(root, 'entry.cpp'), 'version two')
  assert.notEqual(first.digest, (await fingerprint(root, ['entry.cpp'])).digest)
  assert.throws(() => resolveEvidencePath(root, '../secret.txt'), /outside|路径/)
})

test('one real LikeC4 model drives multiple views; invalid edits retain the last valid revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-model-'))
  const modelDir = join(root, 'model')
  await mkdir(modelDir)
  const file = join(modelDir, 'model.c4')
  await writeFile(file, 'specification { element component }\nmodel { a = component "Before" b = component "Other" a -> b "uses" }\nviews { view overview { include * } view detail { include a } }')
  const wb = await createWorkbench({ modelDir, sourceRoot: root, stateDir: join(root, 'state'), evidenceFile: null, watch: false })
  try {
    const original = wb.snapshot()
    assert.equal(original.modelStatus, 'valid')
    assert.equal(original.elements.length, 2)
    assert.equal(typeof original.relationships[0].source, 'string', 'Web 摘要须将 LikeC4 端点引用归一为稳定对象 ID')
    assert.equal(original.relationships[0].source, 'a')
    assert.equal(original.relationships[0].target, 'b')
    assert.ok(['overview', 'detail'].every(id => original.views.some(v => v.id === id)))
    await writeFile(file, (await readFile(file, 'utf8')).replace('Before', 'After'))
    await wb.refresh()
    assert.ok(wb.snapshot().elements.some(e => e.title === 'After'))
    assert.notEqual(wb.snapshot().revision, original.revision)
    const validRevision = wb.snapshot().revision
    await writeFile(file, 'model { broken = }')
    await wb.refresh()
    assert.equal(wb.snapshot().modelStatus, 'invalid')
    assert.equal(wb.snapshot().revision, validRevision)
    assert.ok(wb.snapshot().diagnostics.length > 0)
    assert.ok(wb.snapshot().elements.some(e => e.title === 'After'))
  } finally { await wb.close() }
})

test('Codex tool logs provide bounded observed reads/writes; watcher changes cannot invent reads', () => {
  const rows = [
    { timestamp: '2026-11-04T12:00:00Z', type: 'session_meta', payload: { id: 'test-session', cwd: 'I:/demo' } },
    { timestamp: '2026-11-04T12:00:01Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'read-1', arguments: JSON.stringify({ cmd: 'Get-Content src/main.cpp', workdir: 'I:/demo' }) } },
    { timestamp: '2026-11-04T12:00:02Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'read-1', output: '{"exit_code":0,"output":"example"}' } },
    { timestamp: '2026-11-04T12:00:03Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'write-1', input: '*** Begin Patch\n*** Update File: I:/demo/model/architecture.c4\n@@\n-old\n+new\n*** End Patch' } },
    { timestamp: '2026-11-04T12:00:04Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'unknown-1', arguments: JSON.stringify({ cmd: 'SomeOpaqueScript.exe', workdir: 'I:/demo' }) } }
  ]
  const result = parseCodexRollout(rows.map(r => JSON.stringify(r)).join('\n'), { roots: ['I:/demo'] })
  assert.ok(result.events.some(e => e.operation === 'read' && e.path === 'src/main.cpp' && e.status === 'succeeded'))
  assert.ok(result.events.some(e => e.operation === 'write' && e.path === 'model/architecture.c4'))
  assert.ok(result.coverage.unsupportedCalls >= 1)
  assert.ok(result.events.every(e => e.origin === 'codex-tool-log'))
  assert.ok(result.events.every(e => e.versionStatus === 'unknown'))
})

test('evidence reports changed and missing files without claiming source synchronization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-stale-'))
  await writeFile(join(root, 'source.cpp'), 'original')
  const manifest = { evidence: [{ id: 'proof', path: 'source.cpp', sha256: sha256('original') }] }
  assert.equal((await verifyEvidence(root, manifest)).status, 'matched')
  await writeFile(join(root, 'source.cpp'), 'edited but uncommitted')
  const changed = await verifyEvidence(root, manifest)
  assert.equal(changed.status, 'stale')
  assert.deepEqual(changed.changedFiles, ['source.cpp'])
  assert.equal(changed.scope, 'evidence-files-only')
  assert.equal((await verifyEvidence(root, { evidence: [{ ...manifest.evidence[0], path: 'missing.cpp' }] })).evidence[0].freshness, 'missing')
})

test('broken evidence references and unmarked inferences fail the model contract', () => {
  const data = { elements: { a: { id: 'a', metadata: { stable_id: 'a', evidence: 'missing', source: 'source-code' } } }, relations: { r: { id: 'r', kind: 'inferred', metadata: { stable_id: 'relation-r', evidence: 'p', source: 'source-code' } } } }
  const errors = validateModelContract(data, { evidence: [{ id: 'p', type: 'inference' }] })
  assert.ok(errors.some(d => d.message.includes('证据引用不存在')))
  assert.ok(errors.some(d => d.message.includes('来源类型')))
  assert.ok(errors.some(d => d.message.includes('推断关系')))
})

test('watching actual file edits updates the model; restarting with invalid text restores a labeled valid graph', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-watch-'))
  const modelDir = join(root, 'model'), stateDir = join(root, 'state')
  await mkdir(modelDir)
  const file = join(modelDir, 'project.c4')
  await writeFile(file, 'specification { element app } model { a = app "First" } views { view index { include * } }')
  let wb = await createWorkbench({ modelDir, sourceRoot: root, stateDir, evidenceFile: null, watch: true })
  try {
    const original = wb.snapshot().revision
    const updated = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { off(); reject(new Error('文件监听未更新模型')) }, 7000)
      const off = wb.onChange(state => { if (state.revision !== original && state.modelStatus === 'valid') { clearTimeout(timeout); off(); resolve(state) } })
    })
    await writeFile(file, 'specification { element app } model { a = app "Second" } views { view index { include * } }')
    assert.equal((await updated).elements[0].title, 'Second')
    const valid = wb.snapshot().revision
    await wb.close()
    await writeFile(file, 'model { invalid = }')
    wb = await createWorkbench({ modelDir, sourceRoot: root, stateDir, evidenceFile: null, watch: false })
    assert.equal(wb.snapshot().modelStatus, 'invalid')
    assert.equal(wb.snapshot().revision, valid)
    assert.equal(wb.snapshot().elements[0].title, 'Second')
    assert.notEqual(wb.snapshot().attemptedRevision, valid)
  } finally { await wb.close() }
})
