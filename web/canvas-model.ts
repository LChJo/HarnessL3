import type { MapItem } from './context-map'
export type Point = { x: number; y: number }
export type Camera = Point & { scale: number }
export type Bounds = Point & { width: number; height: number }
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
export function zoomAt(camera: Camera, point: Point, ratio: number): Camera {
  const scale = clamp(camera.scale * ratio, 0.3, 2), factor = scale / camera.scale
  return { x: point.x - (point.x - camera.x) * factor, y: point.y - (point.y - camera.y) * factor, scale }
}
export function fitBounds(bounds: Bounds, view: { width: number; height: number }, padding = 80): Camera {
  const scale = clamp(Math.min((view.width - padding * 2) / Math.max(1, bounds.width), (view.height - padding * 2) / Math.max(1, bounds.height)), 0.3, 1)
  return { scale, x: (view.width - bounds.width * scale) / 2 - bounds.x * scale, y: (view.height - bounds.height * scale) / 2 - bounds.y * scale }
}
export function connection(a: Point, b: Point) { const mid = (a.x + b.x) / 2; return `M${a.x},${a.y} C${mid},${a.y} ${mid},${b.y} ${b.x},${b.y}` }
export type PlacedItem = MapItem & Bounds & { depth: number; parentId: string | null }
export type MapEdge = { source: string; target: string; kind: 'input' | 'branch' | 'output'; d: string; hit: boolean; relatedIds: string[] }
export function layoutMindmap(roots: MapItem[], expanded: string[]) {
  const open = new Set(expanded), nodes: PlacedItem[] = [], edges: MapEdge[] = [], frontier: PlacedItem[] = []
  const visible = new Map<string, MapItem[]>(), heights = new Map<string, number>()
  const children = (node: MapItem): MapItem[] => {
    if (!open.has(node.id)) return []
    if (visible.has(node.id)) return visible.get(node.id)!
    const hits = node.children.filter(child => child.hit), hidden = node.children.filter(child => !child.hit)
    let hiddenCount = 0
    while (hidden.length) {
      const item = hidden.pop()!
      hiddenCount++
      for (const child of item.children) hidden.push(child)
    }
    const entityId = node.entityId ?? node.objectId
    if (node.kind === 'object' && node.state === 'returned' && node.children.length && entityId) hits.unshift({ ...node, id: 'body:' + node.id, title: node.title + ' · 正文', brief: '', kind: 'body', children: [], hit: true, hits: 1, relatedIds: [entityId], bodyFor: node.id })
    if (hiddenCount) hits.push({ id: 'overflow:' + node.id, title: '…', brief: `其余 ${hiddenCount} 项`, category: node.category, kind: 'overflow', children: [], hit: false, hits: 0, state: 'available', relatedIds: [], fields: {}, overflowFor: node.id, hiddenCount })
    visible.set(node.id, hits)
    return hits
  }
  const size = (node: MapItem): number => {
    if (heights.has(node.id)) return heights.get(node.id)!
    const height = Math.max(node.kind === 'category' ? 86 : 74, children(node).reduce((sum, child, i) => sum + size(child) + (i ? 16 : 0), 0))
    heights.set(node.id, height)
    return height
  }
  function place(node: MapItem, top: number, depth: number, parent: PlacedItem | null) {
    const height = node.kind === 'category' ? 86 : 74
    const placed = { ...node, depth, parentId: parent?.id ?? null, x: 350 + depth * 302, y: top + size(node) / 2 - height / 2, width: depth ? 236 : 224, height }
    nodes.push(placed)
    if (parent) edges.push({ source: parent.id, target: node.id, kind: 'branch', d: connection({ x: parent.x + parent.width, y: parent.y + parent.height / 2 }, { x: placed.x, y: placed.y + height / 2 }), hit: node.hit, relatedIds: node.relatedIds })
    const visible = children(node)
    if (!visible.length) frontier.push(placed)
    let y = top
    for (const child of visible) { place(child, y, depth + 1, placed); y += size(child) + 16 }
  }
  let top = 0
  for (const root of roots) { place(root, top, 0, null); top += size(root) + 24 }
  const height = Math.max(500, top - 24), right = Math.max(574, ...nodes.map(n => n.x + n.width))
  const input = { x: 0, y: height / 2 - 112, width: 230, height: 224 }, output = { x: right + 152, y: height / 2 - 106, width: 242, height: 212 }
  for (const node of nodes.filter(n => n.depth === 0)) edges.push({ source: 'input', target: node.id, kind: 'input', d: connection({ x: input.x + input.width, y: input.y + input.height / 2 }, { x: node.x, y: node.y + node.height / 2 }), hit: node.hit, relatedIds: node.relatedIds })
  for (const node of frontier) edges.push({ source: node.id, target: 'output', kind: 'output', d: connection({ x: node.x + node.width, y: node.y + node.height / 2 }, { x: output.x, y: output.y + output.height / 2 }), hit: node.hit, relatedIds: node.relatedIds })
  return { nodes, edges, input, output, frame: { x: 310, y: -52, width: right - 260, height: height + 104 }, bounds: { x: -30, y: -80, width: output.x + output.width + 60, height: height + 160 } }
}
