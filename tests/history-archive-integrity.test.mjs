import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createContextReader } from '../server/context-reader.mjs'

test('damaged historical archive fails explicitly instead of silently substituting the current model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-integrity-'))
  const snapshot = { modelStatus: 'valid', revision: 'r1', elements: [{ id: 'p', title: 'P', metadata: {} }], relationships: [] }
  const reader = await createContextReader({ getSnapshot: () => snapshot, stateDir: dir, worktreeId: 'one', projectId: 'p' })
  const { task } = await reader.startTask({ title: 'integrity', client: 'test' })
  const history = await reader.getTaskSnapshot(task.id), file = join(dir, 'context-snapshots', history.id + '.json')
  const data = JSON.parse(await readFile(file, 'utf8')); data.snapshot.revision = 'tampered'
  await writeFile(file, JSON.stringify(data))
  await assert.rejects(reader.getTaskSnapshot(task.id), /指纹/)
  assert.equal((await reader.getTask(task.id)).modelRevision, 'r1')
})
