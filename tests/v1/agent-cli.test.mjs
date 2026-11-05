import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile, appendFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fixture } from './helpers.mjs'

test('TC10 CLI explicitly binds a log, restores collection, preserves unknowns and refuses cross-target reuse', async t => {
  const f = await fixture(t, 'harness-v1-agent-cli-')
  const root = await f.repository()
  const initialized = await f.cli(['init'], { cwd: root })
  assert.equal(initialized.code, 0, initialized.stdout)
  const worktreeId = initialized.body.target.worktreeId
  const task = await f.cli(['task', 'start', '--title', 'Observe a literal read'], { cwd: root })
  assert.equal(task.code, 0, task.stdout)
  const taskId = task.body.data.taskId
  const logFile = path.join(f.directory, 'explicit session.jsonl')
  const lines = [
    { type: 'session_meta', payload: { id: 'cli-synthetic-session', cwd: root, cli_version: '0.162.1' } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'read-1', name: 'exec_command', arguments: JSON.stringify({ cmd: 'cat README.md', workdir: root }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'read-1', output: JSON.stringify({ exit_code: 0, output: 'PRIVATE_SOURCE_BODY_NEVER_SAVE' }) } },
  ]
  await writeFile(logFile, lines.map(row => JSON.stringify(row) + '\n').join(''))
  const original = await readFile(logFile)
  const requestId = randomUUID()
  const args = ['agent', 'bind', '--agent', 'codex', '--session', 'cli-synthetic-session', '--log-file', logFile, '--task', taskId, '--request-id', requestId]
  const bound = await f.cli(args, { cwd: root })
  assert.equal(bound.code, 0, bound.stdout)
  const bindingId = bound.body.data.result.bindings[0].id
  const status = await f.cli(['agent', 'status', '--binding', bindingId], { cwd: root })
  assert.equal(status.code, 0, status.stdout)
  assert.equal(status.body.data.result.events[0].status, 'succeeded')
  assert.equal(status.body.data.result.events[0].contentHash, null)
  assert.equal(status.body.data.result.events[0].taskId, taskId)
  assert.deepEqual(await readFile(logFile), original)
  const root2 = await f.repository('other-project')
  await f.cli(['init'], { cwd: root2 })
  const reused = await f.cli(args.filter((value, index, array) => array[index - 1] !== '--task' && value !== '--task'), { cwd: root2 })
  assert.equal(reused.body.error.code, 'TARGET_CONFLICT')
  await f.cli(['serve', 'stop'])
  await appendFile(logFile, JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'unknown-2', name: 'exec_command', arguments: JSON.stringify({ cmd: 'cat $DYNAMIC', workdir: root }) } }) + '\n')
  const resumed = await f.cli(['agent', 'status'], { cwd: root })
  assert.equal(resumed.code, 0, resumed.stdout)
  assert.equal(resumed.body.data.result.bindings[0].id, bindingId)
  assert.ok(resumed.body.data.result.bindings[0].coverage.unsupportedRecords >= 1)
  await rm(logFile)
  const replay = await f.cli(args, { cwd: root })
  assert.equal(replay.code, 0, replay.stdout)
  assert.equal(replay.body.replayed, true)
  const wrongTask = await f.cli(['agent', 'bind', '--agent', 'codex', '--session', 'cli-synthetic-session', '--log-file', path.join(f.directory, 'missing.jsonl'), '--task', randomUUID()], { cwd: root })
  assert.equal(wrongTask.body.error.code, 'NOT_FOUND')
  const stopped = await f.cli(['agent', 'unbind', bindingId], { cwd: root })
  assert.equal(stopped.code, 0, stopped.stdout)
  assert.equal(stopped.body.data.result.bindings[0].state, 'stopped')
  const journal = await readFile(path.join(f.dataRoot, 'worktrees', worktreeId, 'journal.jsonl'), 'utf8')
  assert.ok(!journal.includes('PRIVATE_SOURCE_BODY_NEVER_SAVE'))
  assert.ok(!journal.includes('cat $DYNAMIC'))
})
