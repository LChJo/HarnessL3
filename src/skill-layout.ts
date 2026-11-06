export type Bounds = { x: number; y: number; width: number; height: number }

export type SkillFileReference = { path: string; hash: string; bytes: number; encoding: string }

export type SkillBrief = {
  id: string
  name: string
  description: string
  group: string
  path: string
  contentHash: string
  files?: SkillFileReference[]
  related?: string[]
  diagnostics?: string[]
}

export type SkillSelection = {
  id: string
  name: string
  description?: string
  reason: string
  contentHash: string
  path: string
  group?: string
  files?: SkillFileReference[]
}

export type SkillPlan = {
  id: string
  status: 'selected'
  createdAt: string
  catalogRevision: string
  skills: SkillSelection[]
  observation?: string
}

export type SkillLayoutInput = {
  input: Bounds
  contextFrame: Bounds
  contextOutput: Bounds
  catalog: SkillBrief[]
  plan?: SkillPlan | null
  expanded: boolean
  expandedFolders?: Set<string>
  expandedSkills?: Set<string>
}

export type LayoutSkillNode = Bounds & {
  id: string
  skillId: string
  kind: 'folder' | 'selected' | 'catalog' | 'file'
  parentId: string
  depth: number
  selected: boolean
  name: string
  description: string
  group?: string
  reason?: string
  path: string
  contentHash: string
  files?: SkillFileReference[]
  file?: SkillFileReference
  filePath?: string
  fileCount: number
  skillCount?: number
  selectedCount?: number
  related?: string[]
  diagnostics?: string[]
}

export type LayoutSkillEdge = {
  source: string
  target: string
  kind: 'input' | 'branch' | 'output'
  d: string
  selected: boolean
}

export type SkillLayout = {
  frame: Bounds
  selector: Bounds
  output: Bounds
  nodes: LayoutSkillNode[]
  edges: LayoutSkillEdge[]
  bounds: Bounds
}

const connection = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  const mid = (a.x + b.x) / 2
  return `M${a.x},${a.y} C${mid},${a.y} ${mid},${b.y} ${b.x},${b.y}`
}

/** All coordinates belong to the existing canvas world; this function has no camera or UI state. */
export function layoutSkills({ input, contextFrame, contextOutput, catalog, plan, expanded, expandedFolders = new Set<string>(), expandedSkills = new Set<string>() }: SkillLayoutInput): SkillLayout {
  const selected = !!plan, frameY = contextFrame.y + contextFrame.height + 104
  // Deliberately pick only reference metadata even when a saved plan also contains file bodies.
  const reference = (file: SkillFileReference): SkillFileReference => ({ path: file.path, hash: file.hash, bytes: file.bytes, encoding: file.encoding })
  const skills = !expanded ? [] : plan ? plan.skills : catalog
  const entries = skills.map(skill => {
    const files = skill.files?.map(reference)
    const refs: { path: string; file?: SkillFileReference }[] = files?.length ? files.map(file => ({ path: file.path, file })) : skill.path ? [{ path: skill.path }] : []
    const visible = expandedSkills.has(skill.id) ? refs : []
    return { skill, files, refs, visible, height: Math.max(108, visible.length * 88 + Math.max(0, visible.length - 1) * 16) }
  })
  const grouped = new Map<string, typeof entries>()
  for (const entry of entries) {
    // Legacy IDs also encode their original folder; never borrow today's grouping for a saved plan.
    const group = entry.skill.group || (entry.skill.id.includes('/') ? entry.skill.id.split('/')[0] : '未记录文件夹')
    if (!grouped.has(group)) grouped.set(group, [])
    grouped.get(group)!.push(entry)
  }
  const folders = [...grouped].map(([group, members]) => ({
    group, members, open: expandedFolders.has(group),
    height: expandedFolders.has(group) ? members.reduce((sum, entry, index) => sum + entry.height + (index ? 20 : 0), 0) : 96,
  }))
  const treeHeight = folders.reduce((sum, folder, index) => sum + folder.height + (index ? 28 : 0), 0)
  const bodyHeight = Math.max(expanded && !entries.length ? 208 : 176, treeHeight), bodyTop = frameY + 74
  const centerY = bodyTop + bodyHeight / 2
  const selector = { x: contextFrame.x + 40, y: centerY - 56, width: 224, height: 112 }
  const nodes: LayoutSkillNode[] = [], edges: LayoutSkillEdge[] = [], frontier: LayoutSkillNode[] = []
  let top = bodyTop + (bodyHeight - treeHeight) / 2
  for (const folder of folders) {
    const folderNode: LayoutSkillNode = {
      id: `skill-folder:${encodeURIComponent(folder.group)}`, skillId: '', kind: 'folder', selected,
      parentId: 'skill-selector', depth: 1, name: folder.group, group: folder.group, description: '',
      path: folder.group, contentHash: '', fileCount: 0, skillCount: folder.members.length, selectedCount: selected ? folder.members.length : 0,
      x: selector.x + 302, y: top + folder.height / 2 - 48, width: 240, height: 96,
    }
    nodes.push(folderNode)
    edges.push({ source: 'skill-selector', target: folderNode.id, kind: 'branch', selected, d: connection({ x: selector.x + selector.width, y: centerY }, { x: folderNode.x, y: folderNode.y + folderNode.height / 2 }) })
    if (!folder.open) frontier.push(folderNode)
    let memberTop = top
    for (const entry of folder.open ? folder.members : []) {
      const { skill } = entry
      const catalogEntry = plan ? undefined : skill as SkillBrief
      const node: LayoutSkillNode = {
        id: `skill:${skill.id}`, skillId: skill.id, kind: selected ? 'selected' : 'catalog', selected,
        parentId: folderNode.id, depth: 2, name: skill.name, description: skill.description ?? '', group: folder.group,
        reason: plan ? (skill as SkillSelection).reason : undefined, path: skill.path, contentHash: skill.contentHash,
        files: entry.files, fileCount: entry.refs.length, related: catalogEntry?.related, diagnostics: catalogEntry?.diagnostics,
        x: folderNode.x + 300, y: memberTop + entry.height / 2 - 54, width: 260, height: 108,
      }
      nodes.push(node)
      edges.push({ source: folderNode.id, target: node.id, kind: 'branch', selected, d: connection({ x: folderNode.x + folderNode.width, y: folderNode.y + folderNode.height / 2 }, { x: node.x, y: node.y + node.height / 2 }) })
      entry.visible.forEach((ref, index) => {
        const file: LayoutSkillNode = {
          id: `skill-file:${skill.id}:${encodeURIComponent(ref.path)}`, skillId: skill.id, kind: 'file', selected,
          parentId: node.id, depth: 3, name: ref.path.split(/[\\/]/).at(-1) || ref.path, description: ref.path,
          path: ref.path, filePath: ref.path, file: ref.file, contentHash: ref.file?.hash ?? '', fileCount: 0,
          x: node.x + 316, y: memberTop + index * 104, width: 284, height: 88,
        }
        nodes.push(file); frontier.push(file)
        edges.push({ source: node.id, target: file.id, kind: 'branch', selected, d: connection({ x: node.x + node.width, y: node.y + node.height / 2 }, { x: file.x, y: file.y + file.height / 2 }) })
      })
      if (!entry.visible.length) frontier.push(node)
      memberTop += entry.height + 20
    }
    top += folder.height + 28
  }
  const right = Math.max(selector.x + selector.width, ...nodes.map(node => node.x + node.width))
  const frame = { x: contextFrame.x, y: frameY, width: right + 40 - contextFrame.x, height: bodyTop + bodyHeight + 32 - frameY }
  const output = { x: Math.max(contextOutput.x, right + 152), y: centerY - 80, width: contextOutput.width, height: 160 }
  const start = { x: input.x + input.width, y: input.y + input.height / 2 }
  edges.unshift({ source: 'input', target: 'skill-selector', kind: 'input', d: connection(start, { x: selector.x, y: centerY }), selected })
  if (selected && frontier.length) {
    // Shorter branches leave horizontally through their own reserved row before converging outside the deepest column.
    const joinX = right + 64
    for (const leaf of frontier) {
      const join = { x: joinX, y: leaf.y + leaf.height / 2 }
      const tail = connection(join, { x: output.x, y: centerY })
      edges.push({ source: leaf.id, target: 'skill-output', kind: 'output', selected, d: connection({ x: leaf.x + leaf.width, y: join.y }, join) + tail.slice(tail.indexOf(' C')) })
    }
  } else if (nodes.length) {
    // Catalog browsing is a directory projection; its entries must not look selected in the plan.
    const leftRail = selector.x + selector.width + 38, rightRail = right + 64, gutter = frameY + 66
    edges.push({
      source: 'skill-selector', target: 'skill-output', kind: 'output', selected,
      d: `M${selector.x + selector.width},${centerY} C${leftRail},${centerY} ${leftRail},${gutter} ${leftRail},${gutter} C${leftRail},${gutter} ${rightRail},${gutter} ${rightRail},${gutter} C${rightRail},${gutter} ${rightRail},${centerY} ${output.x},${centerY}`,
    })
  } else {
    edges.push({ source: 'skill-selector', target: 'skill-output', kind: 'output', selected, d: connection({ x: selector.x + selector.width, y: centerY }, { x: output.x, y: centerY }) })
  }
  const x = Math.min(start.x, frame.x) - 24, y = Math.min(start.y, frame.y, output.y) - 24
  return { frame, selector, output, nodes, edges, bounds: { x, y, width: Math.max(frame.x + frame.width, output.x + output.width) + 24 - x, height: Math.max(frame.y + frame.height, output.y + output.height) + 24 - y } }
}
