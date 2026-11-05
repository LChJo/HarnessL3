import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'

const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
export async function writeLegacyFixture(source, options = {}) {
  await mkdir(path.join(source, 'context-tasks'), { recursive: true })
  await mkdir(path.join(source, 'context-snapshots'), { recursive: true })
  const at = options.at ?? new Date(Date.now() - 86400000).toISOString()
  const id = options.id ?? randomUUID(), batchId = randomUUID()
  const metadata = { brief: 'An original legacy module', source: 'manual', status: 'unknown', evidence: [] }
  const parent = { id: 'example', title: 'Legacy example', kind: 'system', description: 'Synthetic archived project', metadata }
  const entity = { id: 'example.worker', title: 'Legacy worker', kind: 'component', description: 'Original legacy context', metadata }
  const sourceVersion = { branch: 'original-branch', commit: 'a'.repeat(40), dirty: false, evidenceDigest: null }
  const snapshot = { revision: 'b'.repeat(64), elements: [parent, entity], relationships: [], evidence: [], sourceVersion, runtime: { sourceRoot: 'original-source-unavailable', worktreeId: 'original-worktree' }, c4Views: [{ id: 'original-view', title: 'Archived structure', bounds: { x: 0, y: 0, width: 340, height: 180 }, nodes: [{ id: entity.id, modelRef: entity.id, title: entity.title, x: 40, y: 40, width: 230, height: 90, children: [] }], edges: [] }] }
  const snapshotId = hash(snapshot)
  const fileBytes = Buffer.from('# SYNTHETIC LEGACY METHOD\nUse the archived method.\n')
  const file = { path: 'SKILL.md', hash: hash(fileBytes), bytes: fileBytes.length, encoding: 'utf8', content: fileBytes.toString('utf8') }
  const skill = { id: 'engineering/original-method', name: 'original-method', group: 'engineering', description: 'Original legacy file reference', files: [file], contentHash: hash([[file.path, file.hash]]), reason: 'Preserve the old choice' }
  const plan = { id: randomUUID(), status: 'selected', routerVersion: 'legacy-router', catalogRevision: 'c'.repeat(64), skills: [skill], observation: 'selection-recorded; execution-unknown' }
  const body = { ...entity, ancestors: [parent], relationships: [], modelRevision: snapshot.revision, sourceVersion, scope: 'exact-object' }
  const context = { ...body, contentHash: hash(body) }
  const task = { id, title: options.title ?? 'Synthetic legacy task', projectId: 'original-project', worktreeId: 'original-worktree', modelRevision: snapshot.revision, sourceVersion, createdAt: at, updatedAt: at, initialSnapshotId: snapshotId, disclosedIds: [parent.id, entity.id], batches: [{ id: batchId, status: 'complete', createdAt: at, snapshotId, skillPlan: plan, result: { directories: [{ parentId: parent.id, children: [entity] }], contexts: [context], unchanged: [], errors: [] } }], packet: { contexts: [context], scope: 'exact-objects' } }
  await writeFile(path.join(source, 'context-snapshots', snapshotId + '.json'), JSON.stringify({ id: snapshotId, capturedAt: at, snapshot }))
  const raw = JSON.stringify(task)
  await writeFile(path.join(source, 'context-tasks', id + '.json'), raw)
  return { task, file, raw, batchId }
}
