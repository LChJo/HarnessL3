import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fixture } from './helpers.mjs'
import { writeLegacyFixture } from './legacy-fixture.mjs'

test('TC24 CLI previews/copies legacy archives and preserves their original history and skill bytes', async t => {
  const f = await fixture(t, 'harness-v1-maintenance-cli-')
  const root = await f.repository()
  const initialized = await f.cli(['init'], { cwd: root })
  assert.equal(initialized.code, 0, initialized.stdout)
  const target = initialized.body.target
  const source = path.join(f.directory, 'synthetic original')
  const old = await writeLegacyFixture(source)
  const args = ['migrate', 'prototype', '--from', source, '--worktree', target.worktreeId]
  const preview = await f.cli(args, { cwd: f.directory })
  assert.equal(preview.code, 0, preview.stdout)
  assert.equal(preview.body.data.result.mode, 'dry-run')
  assert.equal(preview.body.data.result.tasks[0].action, 'copy')
  await assert.rejects(stat(path.join(f.dataRoot, 'worktrees', target.worktreeId)), { code: 'ENOENT' })
  const requestId = randomUUID()
  const applied = await f.cli([...args, '--apply', '--request-id', requestId], { cwd: f.directory })
  assert.equal(applied.code, 0, applied.stdout)
  assert.equal(applied.body.data.result.sourcePreserved, true)
  assert.equal(await readFile(path.join(source, 'context-tasks', old.task.id + '.json'), 'utf8'), old.raw)
  const replay = await f.cli([...args, '--apply', '--request-id', requestId], { cwd: f.directory })
  assert.equal(replay.body.replayed, true)
  const show = await f.cli(['history', 'show', old.task.id], { cwd: root })
  assert.equal(show.code, 0, show.stdout)
  assert.equal(show.body.data.kind, 'legacy-archive')
  assert.equal(show.body.data.record.packet.contexts[0].id, 'example.worker')
  assert.equal(show.body.data.binding.sourceScanRevision, null)
  const history = await f.cli(['history', 'list', '--query', 'legacy'], { cwd: root })
  assert.equal(history.code, 0, history.stdout)
  assert.equal(history.body.data.result.items[0].id, old.task.id)
  assert.equal(history.body.data.result.items[0].retentionBasisAt, old.task.updatedAt)
  const fileInput = { schemaVersion: 1, requestId: randomUUID(), files: [{ skillId: 'engineering/original-method', path: 'SKILL.md', expectedHash: old.file.hash }] }
  const readArgs = ['task', 'read', old.task.id, '--file', '-']
  const read = await f.cli(readArgs, { cwd: root, input: JSON.stringify(fileInput) })
  assert.equal(read.code, 0, read.stdout)
  assert.equal(read.body.data.record.legacyRead.files[0].file.content, old.file.content)
  const reread = await f.cli(readArgs, { cwd: root, input: JSON.stringify(fileInput) })
  assert.equal(reread.body.replayed, true)
  await f.cli(['serve', 'stop'])
  const restored = await f.cli(['history', 'list', '--query', 'legacy'], { cwd: root })
  assert.equal(restored.body.data.result.items[0].id, old.task.id)
  const gc = await f.cli(['gc'], { cwd: f.directory })
  assert.equal(gc.code, 0, gc.stdout)
  assert.equal(gc.body.data.result.mode, 'dry-run')
  assert.deepEqual(gc.body.data.result.removed, [])
  const protectedApply = await f.cli(['gc', '--apply'], { cwd: f.directory })
  assert.equal(protectedApply.code, 0, protectedApply.stdout)
  assert.ok(protectedApply.body.data.result.removed.every(file => !/snapshots|skill-blobs|tasks|journal|skills/.test(file)))
})
