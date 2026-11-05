export type Point = { x: number; y: number }
export type Camera = Point & { scale: number }
export type Bounds = Point & { width: number; height: number }
export type JourneyStep = { id: string; title: string; subtitle: string; objectId?: string; duration: number; width: number; kind: 'start' | 'context' | 'output' }
// Runtime stations reference model IDs, without creating LikeC4 objects.
export const JOURNEY_STEPS: JourneyStep[] = [
  { id: 'start', title: '接收任务', subtitle: '确定本次排查范围', duration: 1600, width: 188, kind: 'start' },
  { id: 'download', title: '定位业务入口', subtitle: 'DownloadManager', objectId: 'mgrp.business.download', duration: 2600, width: 156, kind: 'context' },
  { id: 'task', title: '查看执行门面', subtitle: 'TaskManager', objectId: 'mgrp.execution.task', duration: 2600, width: 156, kind: 'context' },
  { id: 'scheduler', title: '核查调度状态', subtitle: 'TaskScheduler', objectId: 'mgrp.execution.scheduler', duration: 2600, width: 156, kind: 'context' },
  { id: 'network', title: '追踪网络边界', subtitle: 'NetworkManager', objectId: 'mgrp.network.manager', duration: 2600, width: 156, kind: 'context' },
  { id: 'output', title: '形成输出', subtitle: '整理排查路径与下一步', duration: 2000, width: 220, kind: 'output' },
]
export const totalDuration = () => JOURNEY_STEPS.reduce((sum, step) => sum + step.duration, 0)
export const stepStart = (index: number) => JOURNEY_STEPS.slice(0, index).reduce((sum, step) => sum + step.duration, 0)
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
export function journeyAt(time: number) {
  const cursor = clamp(time, 0, totalDuration()), finished = cursor >= totalDuration()
  let index = JOURNEY_STEPS.findIndex((_, i) => cursor < stepStart(i + 1))
  if (index < 0) index = JOURNEY_STEPS.length - 1
  const states = JOURNEY_STEPS.map((_, i) => finished || i < index ? 'complete' : i === index ? 'active' : 'future')
  return { index, finished, progress: clamp((cursor - stepStart(index)) / JOURNEY_STEPS[index].duration, 0, 1), states,
    completedObjectIds: JOURNEY_STEPS.filter((s, i) => s.objectId && states[i] === 'complete').map(s => s.objectId!) }
}
export function zoomAt(camera: Camera, point: Point, ratio: number): Camera {
  const scale = clamp(camera.scale * ratio, 0.3, 2), factor = scale / camera.scale
  return { x: point.x - (point.x - camera.x) * factor, y: point.y - (point.y - camera.y) * factor, scale }
}
export function fitBounds(bounds: Bounds, view: { width: number; height: number }, padding = 80): Camera {
  const scale = clamp(Math.min((view.width - padding * 2) / Math.max(1, bounds.width), (view.height - padding * 2) / Math.max(1, bounds.height)), 0.3, 1)
  return { scale, x: (view.width - bounds.width * scale) / 2 - bounds.x * scale, y: (view.height - bounds.height * scale) / 2 - bounds.y * scale }
}
export const stationPositions = () => { let x = 0; return JOURNEY_STEPS.map(step => { const point = { x, y: 470, width: step.width, height: 104 }; x += step.width + 44; return point }) }
export function curvePoint(a: Point, b: Point, t: number): Point {
  const mid = (a.y + b.y) / 2, u = 1 - t
  return { x: u*u*u*a.x + 3*u*u*t*a.x + 3*u*t*t*b.x + t*t*t*b.x, y: u*u*u*a.y + 3*u*u*t*mid + 3*u*t*t*mid + t*t*t*b.y }
}
