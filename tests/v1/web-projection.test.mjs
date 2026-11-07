import test from 'node:test'
import assert from 'node:assert/strict'
import { layoutMindmap } from '../../web/canvas-model.ts'
import { layoutSkills } from '../../web/skill-layout.ts'

const item = (id, hit = false, children = []) => ({ id, title: id, brief: '', category: 'objects', kind: 'object', children, hit, hits: hit ? 1 : 0, state: hit ? 'returned' : 'available', relatedIds: [], fields: {} })
const bounds = { input: { x: 0, y: 100, width: 230, height: 224 }, contextFrame: { x: 310, y: 0, width: 320, height: 600 }, contextOutput: { x: 800, y: 100, width: 240, height: 212 } }
const skill = (id, group = 'quality') => ({ id, group, name: id, description: id, contentHash: 'a'.repeat(64), files: [{ path: 'SKILL.md', hash: 'b'.repeat(64), bytes: 20, encoding: 'utf8' }], related: [], diagnostics: [] })

test('TC21 expanded context keeps hit paths and one overflow instead of thousands of unmatched siblings', () => {
  const children = Array.from({ length: 10000 }, (_, i) => item('node:' + i, i === 17))
  const roots = [item('category:objects', true, [item('app', true, children)])]
  const layout = layoutMindmap(roots, ['category:objects', 'app'])
  assert.ok(layout.nodes.some(node => node.id === 'node:17'))
  assert.ok(!layout.nodes.some(node => node.id === 'node:18'))
  const overflow = layout.nodes.filter(node => node.kind === 'overflow')
  assert.equal(overflow.length, 1)
  assert.equal(overflow[0].overflowFor, 'app')
  assert.equal(overflow[0].hiddenCount, 9999)
  assert.equal(layout.nodes.length, 4)
  assert.ok(!layout.edges.some(edge => edge.target === overflow[0].id && edge.hit))
  assert.equal(children.length, 10000, 'Projection must preserve the complete directory')
})

test('TC21 an entirely unmatched context branch opens only its directory overflow', () => {
  const roots = [item('category:objects', false, [item('unread-root', false, [item('unread-child')])])]
  assert.equal(layoutMindmap(roots, []).nodes.length, 1)
  const layout = layoutMindmap(roots, ['category:objects', 'unread-root'])
  assert.deepEqual(layout.nodes.map(node => node.kind), ['object', 'overflow'])
  assert.equal(layout.nodes[1].hiddenCount, 1)
})

test('TC21 returning a parent body keeps a hit leaf and output path when all descendants are unmatched', () => {
  const parent = { ...item('app', true, [item('unread-child')]), entityId: 'app-id' }
  const root = { ...item('category:objects', true, [parent]), kind: 'category', state: 'aggregate' }
  const layout = layoutMindmap([root], [root.id, parent.id])
  const hitLeaves = layout.nodes.filter(node => node.hit && !layout.edges.some(edge => edge.source === node.id && edge.kind === 'branch'))
  assert.equal(hitLeaves.length, 1, 'A returned parent body must remain a visible terminal hit')
  assert.equal(hitLeaves[0].entityId, parent.entityId)
  assert.ok(layout.edges.some(edge => edge.source === hitLeaves[0].id && edge.kind === 'output' && edge.hit))
  assert.equal(root.hits, 1, 'A body projection must not count the same returned entity twice')
  assert.equal(parent.children[0].hit, false, 'The unreturned child must remain unmatched')
  assert.equal(layout.nodes.find(node => node.kind === 'overflow').hiddenCount, 1)
})

test('TC21 aggregate ancestors do not create body hits and direct parent/child returns stay distinct', () => {
  const child = { ...item('child', true), entityId: 'child-id' }
  const parent = { ...item('parent', true, [child]), entityId: 'parent-id', state: 'aggregate' }
  const aggregate = layoutMindmap([parent], [parent.id])
  assert.deepEqual(aggregate.nodes.filter(node => node.kind === 'body'), [], 'A child return must not imply the parent body was read')
  parent.state = 'returned'; parent.hits = 2
  const direct = layoutMindmap([parent], [parent.id])
  const leaves = direct.nodes.filter(node => node.hit && !direct.edges.some(edge => edge.source === node.id && edge.kind === 'branch'))
  assert.deepEqual(leaves.map(node => node.entityId).sort(), ['child-id', 'parent-id'])
  assert.equal(parent.hits, 2)
  const collapsed = layoutMindmap([parent], [])
  assert.equal(collapsed.nodes.length, 1)
  assert.ok(collapsed.edges.some(edge => edge.kind === 'output' && edge.hit))
})

test('TC20/21 skill folders keep selected members and aggregate all unmatched catalog entries', () => {
  const catalog = [skill('quality/chosen'), skill('quality/unused'), skill('planning/other', 'planning')]
  const plan = { id: 'plan', skills: [{ ...catalog[0], reason: 'Requested method' }] }
  const layout = layoutSkills({ ...bounds, catalog, plan, expanded: true, expandedFolders: new Set(['quality', 'planning']) })
  assert.ok(layout.nodes.some(node => node.skillId === 'quality/chosen'))
  assert.ok(!layout.nodes.some(node => node.skillId === 'quality/unused' || node.skillId === 'planning/other'))
  assert.equal(layout.nodes.filter(node => node.kind === 'overflow').length, 2)
  assert.equal(layout.nodes.find(node => node.kind === 'folder').skillCount, 2)
  assert.equal(layout.nodes.find(node => node.kind === 'folder').selectedCount, 1)
  assert.ok(layout.edges.filter(edge => edge.target.includes('overflow')).every(edge => !edge.selected))
})

test('TC20/21 a large unselected skill library remains one overflow and keeps the saved group authoritative', () => {
  const catalog = Array.from({ length: 10000 }, (_, i) => skill('quality/method-' + i))
  const unselected = layoutSkills({ ...bounds, catalog, expanded: true })
  assert.equal(unselected.nodes.length, 1)
  assert.equal(unselected.nodes[0].kind, 'overflow')
  assert.equal(unselected.nodes[0].hiddenCount, 10000)
  const saved = { ...catalog[0], group: 'archived', reason: 'Original reason' }
  const selected = layoutSkills({ ...bounds, catalog, plan: { id: 'old', skills: [saved] }, expanded: true, expandedFolders: new Set(['archived']) })
  assert.equal(selected.nodes.filter(node => node.skillId === saved.id).length, 1)
  assert.equal(selected.nodes.find(node => node.kind === 'folder').group, 'archived')
  assert.equal(selected.nodes.find(node => node.kind === 'selected').reason, 'Original reason')
})

test('TC19/21 explicit empty selection keeps a directory entry without lighting any catalog node', () => {
  const layout = layoutSkills({ ...bounds, catalog: [skill('quality/unused')], plan: { id: 'empty', skills: [] }, expanded: true })
  assert.equal(layout.nodes.length, 1)
  assert.equal(layout.nodes[0].kind, 'overflow')
  assert.equal(layout.nodes[0].selected, false)
  assert.equal(layout.edges.filter(edge => edge.kind === 'branch').some(edge => edge.selected), false)
})
