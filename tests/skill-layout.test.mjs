import { test } from 'node:test'
import assert from 'node:assert/strict'
import { layoutSkills } from '../src/skill-layout.ts'

const input = { x: 0, y: 138, width: 230, height: 224 }
const contextFrame = { x: 310, y: -52, width: 314, height: 604 }
const contextOutput = { x: 726, y: 144, width: 242, height: 212 }
const catalog = Array.from({ length: 21 }, (_, index) => ({
  id: `skill-${index}`, name: `Skill ${index}`, description: `A concise skill brief ${index}`,
  group: `Group ${index % 3}`, path: `skills/skill-${index}/SKILL.md`, contentHash: `hash-${index}`,
  files: [
    { path: 'SKILL.md', hash: `main-${index}`, bytes: 420, encoding: 'utf8' },
    { path: 'scripts/check.mjs', hash: `script-${index}`, bytes: 150, encoding: 'utf8' },
    { path: 'assets/reference.png', hash: `image-${index}`, bytes: 2048, encoding: 'base64' },
  ],
}))
const plan = {
  id: 'plan-one', status: 'selected', createdAt: '2026-11-05T06:00:00.000Z', catalogRevision: 'catalog-at-selection',
  skills: catalog.map(({ id, name, path, group, contentHash, files }) => ({ id, name, path, group, contentHash, files, reason: `Use ${name} to check this task's implementation and evidence.` })),
}
const folders = new Set(catalog.map(skill => skill.group))
const layout = overrides => layoutSkills({ input, contextFrame, contextOutput, catalog, plan: null, expanded: false, ...overrides })
const contains = (outer, inner) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

test('the collapsed skill lane stays below context and connects the same input to an aligned plan', () => {
  const result = layout()
  assert.ok(result.frame.y >= contextFrame.y + contextFrame.height + 90)
  assert.equal(result.selector.x, 350)
  assert.equal(result.output.x, contextOutput.x)
  assert.equal(result.nodes.length, 0, 'neither loading a catalog nor receiving a plan opens the lane')
  assert.equal(layout({ plan }).nodes.length, 0)
  assert.equal(layout({ plan, expandedSkills: new Set(catalog.map(skill => skill.id)) }).nodes.length, 0)
  assert.deepEqual(result.edges.map(edge => [edge.source, edge.target]), [['input', 'skill-selector'], ['skill-selector', 'skill-output']])
  assert.ok(result.edges[0].d.startsWith(`M${input.x + input.width},${input.y + input.height / 2} `))
  for (const box of [result.frame, result.selector, result.output]) assert.ok(contains(result.bounds, box))
})

test('opening the hub reveals only saved folders and aggregates selected skills', () => {
  const selectedPlan = { ...plan, skills: [plan.skills[4], plan.skills[1]] }
  const result = layout({ expanded: true, plan: selectedPlan, expandedSkills: new Set(['skill-1']) })
  assert.equal(result.nodes.length, 1, 'opening the hub must not reveal skills or files')
  assert.equal(result.nodes[0].kind, 'folder')
  assert.equal(result.nodes[0].group, 'Group 1')
  assert.equal(result.nodes[0].skillCount, 2)
  assert.equal(result.nodes[0].selectedCount, 2)
  assert.equal(result.edges.filter(edge => edge.kind === 'branch').length, 1)
  assert.equal(result.edges.filter(edge => edge.kind === 'output').length, 1)
  for (const node of result.nodes) {
    assert.ok(result.edges.some(edge => edge.source === 'skill-selector' && edge.target === node.id))
    assert.ok(result.edges.some(edge => edge.source === node.id && edge.target === 'skill-output'))
  }
  for (const count of [1, 2, 3]) {
    const branch = layout({ expanded: true, plan: { ...plan, skills: plan.skills.slice(0, count) } })
    assert.equal(new Set(branch.nodes.map(node => node.x)).size, 1, 'skills share one vertical branch column')
    assert.equal(new Set(branch.nodes.map(node => node.y)).size, count, 'each skill occupies a separate row')
    assert.ok(branch.nodes.every(node => node.x > branch.selector.x + branch.selector.width))
    assert.ok(branch.nodes.every(node => contains(branch.frame, node) && contains(branch.bounds, node)))
    assert.ok(branch.output.x >= Math.max(...branch.nodes.map(node => node.x + node.width)) + 100)
  }
})

test('catalog folders disclose members only after a folder click and remain unselected', () => {
  const result = layout({ expanded: true })
  assert.equal(result.nodes.length, folders.size)
  assert.ok(result.nodes.every(node => node.kind === 'folder' && node.skillCount === 7 && node.selectedCount === 0))
  assert.ok(result.edges.every(edge => !edge.selected))
  assert.equal(result.edges.filter(edge => edge.kind === 'branch').length, folders.size)
  assert.deepEqual(result.edges.filter(edge => edge.kind === 'output').map(edge => edge.source), ['skill-selector'], 'catalog entries do not claim selection in the plan')
  const opened = layout({ expanded: true, expandedFolders: new Set(['Group 1']) })
  const members = opened.nodes.filter(node => node.kind === 'catalog')
  assert.deepEqual(members.map(node => node.skillId), catalog.filter(skill => skill.group === 'Group 1').map(skill => skill.id))
  assert.ok(members.every(node => node.depth === 2 && node.parentId === 'skill-folder:Group%201'))
  assert.ok(opened.edges.every(edge => !edge.selected))
  assert.equal(opened.nodes.filter(node => node.kind === 'file').length, 0)
})

test('an explicit empty plan does not fall back to today\'s catalog', () => {
  const result = layout({ expanded: true, plan: { ...plan, skills: [] } })
  assert.deepEqual(result.nodes, [])
  assert.ok(result.edges.every(edge => edge.selected))
  assert.ok(result.frame.height > layout().frame.height, 'the expanded empty result has room for its explanation')
})

test('21 skills remain vertical mindmap branches inside the shared world without overlapping controls', () => {
  const result = layout({ expanded: true, plan, expandedFolders: folders })
  const skills = result.nodes.filter(node => node.kind === 'selected')
  assert.equal(skills.length, 21)
  assert.equal(result.nodes.filter(node => node.kind === 'folder').length, 3)
  assert.equal(new Set(skills.map(node => node.x)).size, 1, 'skills form a tree column instead of a card grid')
  assert.equal(new Set(skills.map(node => node.y)).size, 21)
  const boxes = [result.selector, result.output, ...result.nodes]
  for (const box of boxes) {
    if (box !== result.output) assert.ok(contains(result.frame, box), 'the lane frame encloses its tree')
    assert.ok(contains(result.bounds, box), 'fit bounds include every visible control')
    assert.ok(box.width >= 220 && box.height >= 88)
  }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlaps(boxes[i], boxes[j]), `boxes ${i} and ${j} overlap`)
  assert.ok(result.output.x > result.frame.x + result.frame.width, 'the plan stays to the right of the tree')
  assert.ok(result.nodes.every(node => node.y >= contextFrame.y + contextFrame.height + 90))
})

test('layout follows the context frame, preserves historic content, and does not mutate its inputs', () => {
  const historicalPlan = { ...plan, skills: [{ ...plan.skills[0], group: 'original-folder', name: 'Name at selection', path: 'old/skill/SKILL.md', contentHash: 'old-hash' }] }
  const args = { input, contextFrame: { ...contextFrame, height: 1600 }, contextOutput: { ...contextOutput, x: 2200 }, catalog, plan: historicalPlan, expanded: true, expandedFolders: new Set(['original-folder']) }
  const before = structuredClone(args)
  const result = layoutSkills(args)
  assert.deepEqual(args, before)
  assert.ok(result.frame.y >= args.contextFrame.y + args.contextFrame.height + 90)
  assert.equal(result.output.x, 2200)
  assert.equal(result.nodes[0].name, 'original-folder', 'saved grouping does not follow the current catalog')
  const savedSkill = result.nodes.find(node => node.kind === 'selected')
  assert.equal(savedSkill.name, 'Name at selection')
  assert.equal(savedSkill.path, 'old/skill/SKILL.md')
  assert.equal(savedSkill.contentHash, 'old-hash')
  assert.deepEqual(layoutSkills(args), result, 'pure layout is deterministic')
})

test('expanding one skill reveals only its actual file references and moves the plan to the new frontier', () => {
  const selectedPlan = { ...plan, skills: plan.skills.slice(0, 3) }
  const closed = layout({ expanded: true, plan: selectedPlan, expandedFolders: folders })
  const openedIds = new Set(['skill-1'])
  const opened = layout({ expanded: true, plan: selectedPlan, expandedFolders: folders, expandedSkills: openedIds })
  const files = opened.nodes.filter(node => node.kind === 'file')
  assert.equal(files.length, 3)
  assert.ok(files.every(node => node.skillId === 'skill-1' && node.parentId === 'skill:skill-1' && node.depth === 3))
  assert.deepEqual(files.map(node => node.filePath), catalog[1].files.map(file => file.path))
  assert.deepEqual(files.map(node => node.file), catalog[1].files)
  assert.ok(files.every(node => node.x > opened.nodes.find(node => node.id === 'skill:skill-1').x + 260))
  assert.ok(opened.output.x > closed.output.x)
  assert.ok(opened.bounds.width > closed.bounds.width)
  assert.ok(opened.edges.some(edge => edge.source === 'skill:skill-1' && edge.target === files[0].id && edge.kind === 'branch'))
  assert.deepEqual([...openedIds], ['skill-1'], 'layout does not mutate expansion state')
  const historic = { ...selectedPlan, skills: [{ ...selectedPlan.skills[0], files: [{ path: 'old.md', hash: 'old-file', bytes: 12, encoding: 'utf8', content: 'HISTORIC FILE BODY' }] }] }
  const restored = layout({ expanded: true, plan: historic, expandedFolders: folders, expandedSkills: new Set(['skill-0']) })
  assert.equal(restored.nodes.find(node => node.kind === 'file').filePath, 'old.md')
  assert.equal(restored.nodes.find(node => node.kind === 'file').file.hash, 'old-file')
  assert.ok(!JSON.stringify(restored).includes('HISTORIC FILE BODY'), 'the tree carries file references rather than bodies')
})

test('closing a folder hides all descendants and makes the folder the selected frontier', () => {
  const selectedPlan = { ...plan, skills: [plan.skills[1]] }
  const openSkills = new Set(['skill-1'])
  const opened = layout({ expanded: true, plan: selectedPlan, expandedFolders: new Set(['Group 1']), expandedSkills: openSkills })
  assert.equal(opened.nodes.length, 5)
  const closed = layout({ expanded: true, plan: selectedPlan, expandedSkills: openSkills })
  assert.equal(closed.nodes.length, 1)
  assert.equal(closed.nodes[0].kind, 'folder')
  assert.deepEqual(closed.edges.filter(edge => edge.kind === 'output').map(edge => edge.source), [closed.nodes[0].id])
  assert.ok(!opened.edges.some(edge => edge.kind === 'output' && edge.source === opened.nodes[0].id), 'expanded folders do not bypass their visible chosen members')
})

test('legacy saved IDs supply their original folder and unknown groups are never borrowed from the current catalog', () => {
  const legacy = { ...plan, skills: [{ ...plan.skills[0], id: 'engineering/tdd', group: undefined }, { ...plan.skills[1], group: undefined }] }
  const result = layout({ expanded: true, plan: legacy })
  assert.equal(result.nodes[0].name, 'engineering')
  assert.ok(!result.nodes.some(node => node.name === 'Group 1'))
  assert.equal(result.nodes[1].skillCount, 1)
  assert.ok(result.nodes[1].name, 'missing recorded folder has an explicit label')
})

function curvePoints(path) {
  let from
  const points = []
  for (const command of path.match(/[MC][^MC]*/g) ?? []) {
    const values = command.slice(1).trim().split(/[\s,]+/).map(Number)
    assert.ok(values.every(Number.isFinite))
    if (command[0] === 'M') { from = { x: values[0], y: values[1] }; points.push(from); continue }
    assert.equal(values.length, 6, 'mindmap edges use cubic curves')
    const [x1, y1, x2, y2, x3, y3] = values
    for (let step = 1; step <= 60; step++) {
      const t = step / 60, s = 1 - t
      points.push({ x: s ** 3 * from.x + 3 * s * s * t * x1 + 3 * s * t * t * x2 + t ** 3 * x3, y: s ** 3 * from.y + 3 * s * s * t * y1 + 3 * s * t * t * y2 + t ** 3 * y3 })
    }
    from = { x: x3, y: y3 }
  }
  return points
}

test('curved tree edges avoid unrelated nodes when expanded and collapsed skill branches mix', () => {
  for (const savedPlan of [plan, null]) {
    const result = layout({ expanded: true, plan: savedPlan, expandedFolders: new Set(['Group 0', 'Group 1']), expandedSkills: new Set(['skill-0', 'skill-10', 'skill-20']) })
    const boxes = [{ ...result.selector, id: 'skill-selector' }, { ...result.output, id: 'skill-output' }, ...result.nodes]
    for (const edge of result.edges) {
      assert.ok(edge.d.includes(' C'), 'all links use the upper mindmap curve style')
      for (const point of curvePoints(edge.d)) {
        assert.ok(contains(result.bounds, { ...point, width: 0, height: 0 }))
        for (const node of boxes.filter(node => node.id !== edge.source && node.id !== edge.target)) {
          assert.ok(!(point.x > node.x + .5 && point.x < node.x + node.width - .5 && point.y > node.y + .5 && point.y < node.y + node.height - .5), `${edge.source} → ${edge.target} crosses ${node.id}`)
        }
      }
    }
  }
})
