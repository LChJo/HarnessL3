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
export function layoutContext<T extends { id: string }>(nodes: T[], expanded: string[], root = 'mgrp') {
  const direct = (id: string) => nodes.filter(n => n.id.substring(0, n.id.lastIndexOf('.')) === id)
  const modules = direct(root).map((node, i) => ({ ...node, x: (i < 6 ? 100 : 198) + (i < 6 ? i : i - 6) * 196, y: i < 6 ? 95 : 197, width: 170, height: 76 }))
  const branches: { id: string; title?: string; x: number; y: number; width: number; height: number }[] = []
  const children: (T & Bounds & { parentId: string })[] = []
  let right = -100
  for (const parentId of expanded) {
    const items = direct(parentId), parent = modules.find(n => n.id === parentId) ?? children.find(n => n.id === parentId)
    if (!items.length || !parent) continue
    const columns = Math.min(items.length, 2), width = columns * 190 - 18
    const x = Math.max(parent.x + parent.width / 2 - width / 2 - 200, right + 46), y = 345
    const height = Math.ceil(items.length / columns) * 98 - 18
    branches.push({ id: parentId, x, y: y - 28, width, height: height + 28 })
    items.forEach((node, i) => children.push({ ...node, parentId, x: x + i % columns * 190, y: y + Math.floor(i / columns) * 98, width: 172, height: 80 }))
    right = x + width
  }
  const output = { x: Math.max(1192, right + 30), y: expanded.length ? 365 : 270, width: 235, height: 185 }
  const input = { x: -140, y: 95, width: 188, height: 172 }
  const maxX = Math.max(1330, output.x + output.width), maxY = Math.max(560, ...children.map(n => n.y + n.height), output.y + output.height)
  return { modules, branches, children, input, output, bounds: { x: -170, y: 30, width: maxX + 200, height: maxY + 30 } }
}
export function connection(a: Point, b: Point) { const mid = (a.x + b.x) / 2; return `M${a.x},${a.y} C${mid},${a.y} ${mid},${b.y} ${b.x},${b.y}` }
