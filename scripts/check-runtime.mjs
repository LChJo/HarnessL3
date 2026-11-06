import assert from 'node:assert/strict'
import { writeFile, unlink, access } from 'node:fs/promises'
import { join } from 'node:path'
const base = `http://127.0.0.1:${Number(process.env.PORT ?? 4317)}`
const get = async path => { const r = await fetch(base + path); assert.equal(r.status, 200, path); return r.json() }
const report = { time: new Date().toISOString(), checks: [], browserVisual: 'not-verified' }
async function waitFor(predicate) {
  const end = Date.now() + 12000
  while (Date.now() < end) { const state = await get('/api/snapshot'); if (predicate(state)) return state; await new Promise(r => setTimeout(r, 150)) }
  throw new Error('Timed out waiting for model state')
}
const page = await fetch(base)
assert.equal(page.status, 200)
const html = await page.text()
const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map(m => m[1])
assert.ok(assets.length >= 2)
for (const asset of assets) assert.equal((await fetch(base + asset)).status, 200)
report.checks.push('production HTML + CSS/JS assets return 200')
const before = await get('/api/snapshot')
assert.equal(before.modelStatus, 'valid')
assert.equal(before.elements.length, 40)
assert.equal(before.views.length, 5)
assert.equal(before.source.status, 'matched')
report.checks.push('real compiled LikeC4 data + five layouted views + matched evidence')
const evidence = await get('/api/evidence/e-mgrp-business-download')
assert.ok(evidence.lines.some(l => l.text.includes('business-layer authority')))
assert.equal(evidence.currentHash, evidence.sha256)
const definition = await get('/api/model-source?object=mgrp.business.download')
assert.ok(definition.file.endsWith('business.c4'))
assert.ok(definition.content.includes('stable_id "mgrp.business.download"'))
report.checks.push('source excerpt/hash + exact object-to-model-file lookup')
const unknown = await fetch(base + '/api/evidence/does-not-exist')
assert.equal(unknown.status, 404)
const outside = await fetch(base + '/api/model-source?file=../evidence.json')
assert.equal(outside.status, 404)
report.checks.push('unknown evidence + outside-model paths rejected')
const events = await get('/api/events')
assert.ok(events.events.some(e => e.origin === 'codex-tool-log' && e.operation === 'read'))
assert.ok(events.events.some(e => e.origin === 'codex-tool-log' && e.operation === 'write'))
assert.ok(events.events.some(e => e.origin === 'scripted-example'))
assert.ok(events.events.filter(e => e.origin === 'codex-tool-log').every(e => e.versionStatus === 'unknown'))
report.checks.push('real Codex reads/writes + explicitly labeled script events + unknown historical versions')
const probe = join(before.runtime.modelDir, '99-runtime-validation-probe.c4')
try { await access(probe); throw new Error('Probe already exists; refusing to overwrite') } catch (e) { if (e.code !== 'ENOENT') throw e }
try {
  await writeFile(probe, 'model { incomplete = }')
  const invalid = await waitFor(s => s.modelStatus === 'invalid')
  assert.equal(invalid.revision, before.revision)
  assert.notEqual(invalid.attemptedRevision, before.revision)
  assert.ok(invalid.diagnostics.length)
  assert.equal(invalid.elements.length, 40)
  report.checks.push('live invalid file edit retains labeled last-valid model and diagnostics')
} finally { await unlink(probe) }
await waitFor(s => s.modelStatus === 'valid' && s.revision === before.revision)
report.checks.push('removing invalid probe automatically restores current valid model')
const note = '自动 API 检查：保存与读取审查记录；尚未进行浏览器视觉和人工可用性验收。'
const response = await fetch(base + '/api/reviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verdict: 'unknown', note, origin: 'automated-api-check' }) })
assert.equal(response.status, 200)
const reviews = await get('/api/reviews')
assert.ok(reviews.some(r => r.note === note && r.revision === before.revision && r.verdict === 'unknown'))
report.checks.push('version-bound local review record is persisted and retrievable (tagged automated)')
const streamController = new AbortController()
const stream = await fetch(base + '/api/stream', { signal: streamController.signal })
assert.equal(stream.headers.get('content-type'), 'text/event-stream')
streamController.abort()
report.checks.push('server-sent event connection available')
await writeFile('.harness-local/runtime-check.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
