import { useEffect, useRef, useState } from 'react'
import type { PointerEvent, RefObject, MouseEvent as ReactMouseEvent } from 'react'
import { fitBounds, zoomAt } from './canvas-model'
import type { Bounds, Camera, Point } from './canvas-model'

export function useCanvas(viewport: RefObject<HTMLDivElement | null>, initial: Bounds, ready: boolean) {
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 })
  const [smooth, setSmooth] = useState(false), [dragging, setDragging] = useState(false)
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  const initialized = useRef(false), pointers = useRef(new Map<number, Point>()), travelled = useRef(0), suppressClick = useRef(false)
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)'), update = () => setReduced(media.matches)
    media.addEventListener('change', update); return () => media.removeEventListener('change', update)
  }, [])
  function fit(bounds = initial) {
    if (!viewport.current) return
    const { width, height } = viewport.current.getBoundingClientRect()
    const next = fitBounds(bounds, { width, height: height - 150 }, width < 650 ? 25 : 45)
    setSmooth(!reduced); setCamera({ ...next, y: next.y + 100 })
  }
  function locate(bounds: Bounds) {
    if (!viewport.current) return
    const { width, height } = viewport.current.getBoundingClientRect(), scale = width < 650 ? .95 : 1
    setSmooth(!reduced); setCamera({ scale, x: width / 2 - (bounds.x + bounds.width / 2) * scale, y: height * .58 - (bounds.y + bounds.height / 2) * scale })
  }
  useEffect(() => {
    if (!ready || initialized.current || !viewport.current) return
    initialized.current = true
    const { width, height } = viewport.current.getBoundingClientRect()
    if (width < 700) locate({ x: 350, y: 0, width: 224, height: 526 })
    else fit(initial)
  }, [ready])
  useEffect(() => {
    const element = viewport.current; if (!element) return
    const wheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest('[data-no-pan]')) return
      event.preventDefault(); setSmooth(false)
      const rect = element.getBoundingClientRect()
      if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) setCamera(old => ({ ...old, x: old.x - event.deltaX - (event.shiftKey ? event.deltaY : 0), y: old.y - (event.shiftKey ? 0 : event.deltaY) }))
      else setCamera(old => zoomAt(old, { x: event.clientX - rect.left, y: event.clientY - rect.top }, Math.exp(-event.deltaY * .0018)))
    }
    element.addEventListener('wheel', wheel, { passive: false }); return () => element.removeEventListener('wheel', wheel)
  }, [])
  function onPointerDown(event: PointerEvent) {
    const target = event.target as HTMLElement, button = target.closest('button')
    if (target.closest('input,select,textarea,[data-no-pan]') || event.button > 0 || button && event.pointerType !== 'touch') return
    if (!button) { event.preventDefault(); viewport.current?.setPointerCapture(event.pointerId) }
    suppressClick.current = false
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); travelled.current = 0
  }
  function onPointerMove(event: PointerEvent) {
    if (!pointers.current.has(event.pointerId)) return
    const before = [...pointers.current.values()], old = pointers.current.get(event.pointerId)!
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const after = [...pointers.current.values()], delta = { x: event.clientX - old.x, y: event.clientY - old.y }
    travelled.current += Math.abs(delta.x) + Math.abs(delta.y); if (travelled.current < 3) return
    event.preventDefault(); suppressClick.current = true
    if (viewport.current && !viewport.current.hasPointerCapture(event.pointerId)) viewport.current.setPointerCapture(event.pointerId)
    setSmooth(false); setDragging(true)
    if (after.length === 2 && viewport.current) {
      const center = (items: Point[]) => ({ x: (items[0].x + items[1].x) / 2, y: (items[0].y + items[1].y) / 2 }), distance = (items: Point[]) => Math.hypot(items[1].x - items[0].x, items[1].y - items[0].y)
      const a = center(before), b = center(after), rect = viewport.current.getBoundingClientRect()
      setCamera(value => { const next = zoomAt(value, { x: a.x - rect.left, y: a.y - rect.top }, distance(after) / Math.max(1, distance(before))); return { ...next, x: next.x + b.x - a.x, y: next.y + b.y - a.y } })
    } else setCamera(value => ({ ...value, x: value.x + delta.x, y: value.y + delta.y }))
  }
  function onPointerUp(event: PointerEvent) { pointers.current.delete(event.pointerId); if (!pointers.current.size) { setDragging(false); setTimeout(() => { suppressClick.current = false }, 0) } }
  function onClickCapture(event: ReactMouseEvent) { if (suppressClick.current) { event.preventDefault(); event.stopPropagation() } }
  function zoom(ratio: number) { if (!viewport.current) return; setSmooth(false); setCamera(old => zoomAt(old, { x: viewport.current!.clientWidth / 2, y: viewport.current!.clientHeight / 2 }, ratio)) }
  function preserve(before: Point, after: Point) { setSmooth(!reduced); setCamera(old => ({ ...old, x: old.x + (before.x - after.x) * old.scale, y: old.y + (before.y - after.y) * old.scale })) }
  return { camera, smooth, dragging, reduced, fit, locate, zoom, preserve, handlers: { onPointerDown, onPointerMove, onPointerUp, onClickCapture, onPointerCancel: onPointerUp, onLostPointerCapture: onPointerUp } }
}
