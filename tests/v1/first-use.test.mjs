import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fixture } from './helpers.mjs'

test('TC27 first use offers explicit initialization without writing the worktree; consent can resume the task', async t => {
  const f = await fixture(t, 'harnessl3-first-use-')
  const root = await f.repository('首次使用 project')
  const nested = path.join(root, 'src')
  await mkdir(nested)
  const before = await f.git(root, 'status', '--porcelain')
  const response = await f.cli(['task', 'start', '--title', 'First task'], { cwd: nested })
  assert.equal(response.code, 3, response.stdout)
  assert.equal(response.body.error.code, 'TARGET_REQUIRED')
  const onboarding = response.body.error.details.onboarding
  assert.equal(onboarding?.state, 'initialization-required')
  assert.equal((await f.git(onboarding.worktreeRoot, 'rev-parse', '--show-toplevel')).stdout, (await f.git(root, 'rev-parse', '--show-toplevel')).stdout)
  assert.equal(onboarding.confirmationRequired, true)
  assert.deepEqual(onboarding.command, ['init'])
  assert.equal(onboarding.fallback, 'continue-without-l3')
  await assert.rejects(access(path.join(root, '.harness')))
  assert.equal((await f.git(root, 'status', '--porcelain')).stdout, before.stdout)
  assert.deepEqual((await f.cli(['worktree', 'list'])).body.data.result.items, [])

  // An explicit call represents the user's affirmative answer; the failed entry never initializes.
  assert.equal((await f.cli(onboarding.command, { cwd: onboarding.worktreeRoot })).code, 0)
  assert.equal((await f.cli(['model', 'validate'], { cwd: root })).code, 0)
  const resumed = await f.cli(['task', 'start', '--title', 'First task'], { cwd: root })
  assert.equal(resumed.code, 0, resumed.stdout)
  assert.equal(resumed.body.data.kind, 'task-entry')
})

test('TC27 existing configuration offers registration and preserves the original bytes', async t => {
  const f = await fixture(t, 'harnessl3-first-use-')
  const root = await f.repository()
  await mkdir(path.join(root, '.harness'))
  const config = JSON.stringify({ schemaVersion: 1, projectId: randomUUID(), name: 'Keep this project', source: { excludePatterns: [] } }, null, 2) + '\n'
  const file = path.join(root, '.harness', 'project.json')
  await writeFile(file, config)
  const response = await f.cli(['task', 'start', '--title', 'Existing project'], { cwd: root })
  assert.equal(response.code, 3, response.stdout)
  const onboarding = response.body.error.details.onboarding
  assert.equal(onboarding?.state, 'registration-required')
  assert.equal(onboarding.confirmationRequired, true)
  assert.deepEqual(onboarding.command, ['worktree', 'register', onboarding.worktreeRoot])
  assert.equal(await readFile(file, 'utf8'), config)
  assert.deepEqual((await f.cli(['project', 'list'])).body.data.result.items, [])
})

test('TC27 missing or conflicting targets do not invite initialization of another project', async t => {
  const f = await fixture(t, 'harnessl3-first-use-')
  const absent = await f.cli(['task', 'start', '--title', 'No Git worktree'])
  assert.equal(absent.body.error.code, 'TARGET_REQUIRED')
  assert.equal(absent.body.error.details.onboarding, undefined)
  const root = await f.repository()
  const initialized = await f.cli(['init'], { cwd: root })
  const other = await f.repository()
  const explicit = await f.cli(['task', 'start', '--title', 'Explicit target', '--project', initialized.body.target.projectId], { cwd: other })
  assert.equal(explicit.body.error.code, 'TARGET_REQUIRED')
  assert.equal(explicit.body.error.details.onboarding, undefined)
})

test('TC27/23 no-open provides an authenticated clickable Web link before entry and for the exact task', async t => {
  const f = await fixture(t, 'harnessl3-first-use-')
  const root = await f.repository()
  const first = await f.cli(['web', 'open', '--no-open'], { cwd: root })
  assert.equal(first.code, 0, first.stderr + first.stdout)
  assert.equal(first.body.target, null)
  assert.equal(first.body.data.result.opened, false)
  const url = new URL(first.body.data.result.url)
  assert.match(url.origin, /^http:\/\/127\.0\.0\.1:\d+$/)
  const code = new URLSearchParams(url.hash.slice(1)).get('code')
  assert.match(code, /^[a-f0-9]{64}$/)
  const service = JSON.parse(await readFile(path.join(f.dataRoot, 'service.json'), 'utf8'))
  assert.ok(!first.stdout.includes(service.token))
  assert.equal((await fetch(url.origin)).status, 200)
  const login = () => fetch(url.origin + '/session', { method: 'POST', headers: { origin: url.origin, 'content-type': 'application/json' }, body: JSON.stringify({ code }) })
  const session = await login()
  assert.equal(session.status, 200)
  assert.equal((await login()).status, 401)
  const cookie = session.headers.get('set-cookie').split(';')[0]
  assert.deepEqual((await f.cli(['worktree', 'list'])).body.data.result.items, [])
  await assert.rejects(access(path.join(root, '.harness')))
  const missingTask = await f.cli(['web', 'open', '--no-open', '--task', randomUUID()], { cwd: root })
  assert.equal(missingTask.body.error.code, 'TARGET_REQUIRED')

  const initialized = await f.cli(['init'], { cwd: root })
  const started = await f.cli(['task', 'start', '--title', 'Visible task'], { cwd: root })
  assert.equal(started.code, 0, started.stdout)
  const scoped = await f.cli(['web', 'open', '--no-open', '--task', started.body.data.taskId], { cwd: root })
  assert.equal(scoped.code, 0, scoped.stdout)
  assert.equal(scoped.body.data.result.opened, false)
  const parameters = new URLSearchParams(new URL(scoped.body.data.result.url).hash.slice(1))
  assert.equal(parameters.get('worktree'), initialized.body.target.worktreeId)
  assert.equal(parameters.get('task'), started.body.data.taskId)
  const view = await fetch(url.origin + '/view?' + new URLSearchParams({ worktree: parameters.get('worktree'), task: parameters.get('task') }), { headers: { cookie } }).then(response => response.json())
  assert.equal(view.task.title, 'Visible task')
  assert.equal(view.task.lastReadAt, null, 'Viewing the task must not count as an agent context read')
})
