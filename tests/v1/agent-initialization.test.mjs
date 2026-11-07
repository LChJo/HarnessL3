import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fixture } from './helpers.mjs'

test('TC03/27 init reports mechanical setup and hands semantic modeling to the current agent', async t => {
  const f = await fixture(t, 'harnessl3-agent-init-')
  const root = await f.repository()
  const initialized = await f.cli(['init'], { cwd: root })
  assert.equal(initialized.code, 0, initialized.stdout)
  const setup = initialized.body.data.result.initialization
  assert.equal(setup?.stage, 'scaffold-ready')
  assert.equal(setup.semanticStatus, 'not-assessed')
  assert.equal(setup.modelCreated, true)
  assert.equal(setup.nextAction, 'model-project')
  assert.deepEqual(setup.model, { objects: 1, relations: 0, views: 1 })
  assert.ok(setup.agentGuidance)

  const again = await f.cli(['init'], { cwd: root })
  assert.equal(again.code, 0, again.stdout)
  assert.equal(again.body.data.result.initialization.modelCreated, false)
  assert.equal(again.body.data.result.initialization.nextAction, 'review-project-model')
  assert.equal(again.body.data.result.initialization.semanticStatus, 'not-assessed')
})

test('TC23 Web login expiry is separate from the shared daemon lifetime across projects', async t => {
  const f = await fixture(t, 'harnessl3-agent-init-')
  const first = await f.repository('first')
  const second = await f.repository('second')
  assert.equal((await f.cli(['init'], { cwd: first })).code, 0)
  const status = (await f.cli(['serve', 'status'])).body.data.result
  assert.equal(status.scope, 'user-data-root')
  assert.equal(status.lifetime, 'until-stopped')
  assert.ok(Number.isFinite(Date.parse(status.startedAt)))
  const before = Date.now()
  const opened = await f.cli(['web', 'open', '--no-open'], { cwd: first })
  assert.equal(opened.code, 0, opened.stdout)
  const result = opened.body.data.result
  assert.deepEqual(result.service, { instanceId: status.instanceId, scope: 'user-data-root', lifetime: 'until-stopped' })
  assert.equal(result.login.oneTime, true)
  assert.equal(result.login.browserSessionTtlMs, 43_200_000)
  const expiresAt = Date.parse(result.login.expiresAt)
  assert.ok(expiresAt >= before + 300_000 && expiresAt <= Date.now() + 300_000)
  const url = new URL(result.url)
  const code = new URLSearchParams(url.hash.slice(1)).get('code')
  const login = await fetch(url.origin + '/session', { method: 'POST', headers: { origin: url.origin, 'content-type': 'application/json' }, body: JSON.stringify({ code }) })
  assert.equal(login.status, 200)
  assert.match(login.headers.get('set-cookie'), /Max-Age=43200/)
  assert.equal((await f.cli(['init'], { cwd: second })).code, 0)
  const later = (await f.cli(['serve', 'status'], { cwd: second })).body.data.result
  assert.equal(later.instanceId, status.instanceId)
  assert.equal(later.startedAt, status.startedAt)
  const stopped = (await f.cli(['serve', 'stop'])).body.data.result
  assert.equal(stopped.state, 'stopped')
  assert.equal(stopped.startedAt, null)
})

test('TC03/05 init preserves a model authored through files and reports its actual topology without semantic approval', async t => {
  const f = await fixture(t, 'harnessl3-agent-init-')
  const root = await f.repository()
  assert.equal((await f.cli(['init'], { cwd: root })).code, 0)
  const metadata = (suffix, brief) => `metadata {\n harness_id "aa250000-0000-4000-8000-0000000000${suffix}"\n brief "${brief}"\n source "human"\n status "needs-review"\n evidence "none"\n version "1"\n}`
  // Synthetic hand-authored model: file editing is the seam, not a CLI semantic generator.
  const model = `specification {\n element system\n element component\n relationship calls\n}\nmodel {
 app = system "Fixture" {
  ${metadata('01', 'Project boundary')}
  api = component "API" { ${metadata('02', 'Accept requests')} }
  worker = component "Worker" { ${metadata('03', 'Run work')} }
 }
 app.api -[calls]-> app.worker "Dispatch" { ${metadata('04', 'Forward work')} }
}\nviews {\n view overview { include app.* }\n view worker { include app.worker }\n}\n`
  const file = path.join(root, '.harness/model/main.c4')
  await writeFile(file, model)
  const again = await f.cli(['init'], { cwd: root })
  assert.equal(again.code, 0, again.stdout)
  assert.deepEqual(again.body.data.result.initialization.model, { objects: 3, relations: 1, views: 2 })
  assert.equal(again.body.data.result.initialization.semanticStatus, 'not-assessed')
  assert.equal(again.body.data.result.initialization.modelCreated, false)
  assert.equal(await readFile(file, 'utf8'), model)
})
