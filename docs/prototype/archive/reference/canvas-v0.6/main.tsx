import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { JOURNEY_STEPS, totalDuration, stepStart, journeyAt, zoomAt, fitBounds, stationPositions, curvePoint, clamp } from './canvas-model'
import type { Camera, Point, Bounds } from './canvas-model'
import './styles.css'

type ModelNode = { id: string; title: string; description: string; kind: string; metadata: Record<string, string | string[]> }
type Snapshot = { modelStatus: string; revision: string; elements: ModelNode[]; diagnostics: { message: string }[]; sourceVersion: { branch: string; commit: string }; runtime: { sourceRoot: string }; source: { status: string } }
type PlacedNode = ModelNode & Bounds
type Detail = { kind: 'node'; id: string } | { kind: 'output' | 'records' | 'workspace' }
const meta = (node: ModelNode, key: string) => Array.isArray(node.metadata?.[key]) ? (node.metadata[key] as string[]).join(', ') : node.metadata?.[key] ?? '未知'
const positions = stationPositions(), duration = totalDuration()
const shortTime = (value: number) => `${Math.floor(value / 60000).toString().padStart(2, '0')}:${Math.floor(value / 1000 % 60).toString().padStart(2, '0')}`
const icons: Record<string, React.ReactNode> = {
  play: <path d="m6 4 11 8-11 8Z"/>, pause: <path d="M7 5v14M17 5v14"/>, next: <path d="m5 5 10 7-10 7ZM19 5v14"/>, previous: <path d="m19 5-10 7 10 7ZM5 5v14"/>,
  reset: <path d="M4 8a9 9 0 1 1 0 9M4 3v5h5"/>, plus: <path d="M12 5v14M5 12h14"/>, minus: <path d="M5 12h14"/>, fit: <path d="M9 4H4v5M15 4h5v5M4 15v5h5M20 15v5h-5"/>,
  target: <><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></>, close: <path d="m6 6 12 12M18 6 6 18"/>, chevron: <path d="m9 5 7 7-7 7"/>, check: <path d="m5 12 5 5L20 6"/>,
  branch: <><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10M18 7v3a5 5 0 0 1-5 5H6"/></>, info: <><circle cx="12" cy="12" r="9"/><path d="M12 10v7M12 6v1"/></>, record: <path d="M5 5h14M5 12h14M5 19h9"/>, output: <><path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h4M9 12h6M9 16h5"/></>, arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>, modules: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
}
function Icon({ name, size = 18 }: { name: string; size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icons[name]}</svg> }
const readableTitle = (text: string) => text.split(/(?<=[a-z])(?=[A-Z])/).map((part, index) => <React.Fragment key={index}>{index > 0 && <wbr/>}{part}</React.Fragment>)

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [cursor, setCursor] = useState(0), [playing, setPlaying] = useState(false), [follow, setFollow] = useState(true), [speed, setSpeed] = useState(1)
  const [expanded, setExpanded] = useState<string | null>(null), [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 })
  const [smooth, setSmooth] = useState(false), [dragging, setDragging] = useState(false), [detail, setDetail] = useState<Detail | null>(null)
  const [evidence, setEvidence] = useState<{ title: string; lines?: { number: number; text: string }[]; error?: string } | null>(null)
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  const viewport = useRef<HTMLDivElement>(null), pointers = useRef(new Map<number, Point>()), gestureDistance = useRef(0)
  const manualRef = useRef<() => void>(() => {}), previousRevision = useRef<string | null>(null), initialized = useRef(false)
  const dialog = useRef<HTMLElement>(null), returnFocus = useRef<HTMLElement | null>(null)
  manualRef.current = () => { setFollow(false); setSmooth(false) }
  const nodes = snapshot?.elements ?? []
  const byId = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes])
  const modules = useMemo(() => nodes.filter(n => n.id.startsWith('mgrp.') && n.id.split('.').length === 2), [nodes])
  const children = useMemo(() => expanded ? nodes.filter(n => n.id.substring(0, n.id.lastIndexOf('.')) === expanded) : [], [nodes, expanded])
  const journey = journeyAt(cursor), current = JOURNEY_STEPS[journey.index]
  const currentObject = current.objectId && byId.has(current.objectId) ? current.objectId : null
  const completedIds = journey.completedObjectIds.filter(id => byId.has(id))
  const relatedCount = (id: string) => completedIds.filter(key => key === id || key.startsWith(id + '.')).length
  const moduleNodes: PlacedNode[] = modules.map((node, i) => ({ ...node, x: (i < 6 ? 83 : 176) + (i < 6 ? i : i - 6) * 186, y: i < 6 ? 80 : 174, width: 156, height: 58 }))
  const parent = moduleNodes.find(n => n.id === expanded)
  const childNodes: PlacedNode[] = children.map((node, i) => ({ ...node, x: (parent ? parent.x + 78 : 626) - (children.length * 178 - 18) / 2 + i * 178, y: 300, width: 160, height: 70 }))
  const activeNode = [...childNodes, ...moduleNodes].find(n => n.id === currentObject) ?? moduleNodes.find(n => currentObject?.startsWith(n.id + '.'))
  const curveA = { x: positions[journey.index].x + positions[journey.index].width / 2, y: 470 }
  const curveB = activeNode ? { x: activeNode.x + activeNode.width / 2, y: activeNode.y + activeNode.height } : null
  const curve = curveB ? `M${curveA.x},${curveA.y} C${curveA.x},${(curveA.y + curveB.y) / 2} ${curveB.x},${(curveA.y + curveB.y) / 2} ${curveB.x},${curveB.y}` : ''
  const bead = curveB ? curvePoint(curveA, curveB, journey.progress < .5 ? journey.progress * 2 : 2 - journey.progress * 2) : null
  function canvasBounds(): Bounds { const all = [...moduleNodes, ...childNodes, ...positions], minX = Math.min(...all.map(n => n.x)), maxX = Math.max(...all.map(n => n.x + n.width)); return { x: minX - 30, y: 35, width: maxX - minX + 60, height: 595 } }
  async function load() {
    setError('')
    try { const response = await fetch('/api/snapshot'); if (!response.ok) throw new Error(`HTTP ${response.status}`); const data = await response.json(); if (!data.elements?.some((n: ModelNode) => n.id === 'mgrp')) throw new Error('当前没有可显示的 MGRP 模型'); if (previousRevision.current && previousRevision.current !== data.revision) { setCursor(0); setPlaying(false); setNotice('主模型已更新，演示已回到起点。') }; previousRevision.current = data.revision; setSnapshot(data) }
    catch (err) { setError(String(err)) }
  }
  useEffect(() => {
    load()
    const stream = new EventSource('/api/stream')
    const update = (event: MessageEvent) => { try { const data = JSON.parse(event.data); if (!data.elements?.length) { void load(); return }
      if (previousRevision.current && data.revision !== previousRevision.current) { setCursor(0); setPlaying(false); setNotice('主模型已更新，演示已回到起点。') }
      previousRevision.current = data.revision; setSnapshot(data)
    } catch { /* retain the last readable snapshot */ } }
    stream.addEventListener('snapshot', update as EventListener)
    stream.addEventListener('model', update as EventListener)
    return () => stream.close()
  }, [])
  useEffect(() => { if (snapshot && !previousRevision.current) previousRevision.current = snapshot.revision }, [snapshot])
  useEffect(() => { const query = matchMedia('(prefers-reduced-motion: reduce)'); const update = () => { setReduced(query.matches); if (query.matches) setPlaying(false) }; query.addEventListener('change', update); return () => query.removeEventListener('change', update) }, [])
  useEffect(() => {
    if (!snapshot || initialized.current || !viewport.current) return
    initialized.current = true
    const { width, height } = viewport.current.getBoundingClientRect(), scale = width < 850 ? .95 : Math.min(1, (width - 100) / 1252)
    setCamera(width < 850 ? { x: width / 2 - 94 * scale, y: height * .54 - 522 * scale, scale } : { x: (width - 1252 * scale) / 2, y: clamp(height - 660, 60, 120), scale })
    if (!reduced) setPlaying(true)
  }, [snapshot, reduced])
  useEffect(() => {
    if (!playing || detail) return
    let frame = 0, last = performance.now()
    const animate = (now: number) => { const delta = Math.min(now - last, 100) * speed; last = now; setCursor(value => Math.min(duration, value + delta)); frame = requestAnimationFrame(animate) }
    frame = requestAnimationFrame(animate); return () => cancelAnimationFrame(frame)
  }, [playing, speed, detail])
  useEffect(() => { if (cursor >= duration) setPlaying(false) }, [cursor])
  useEffect(() => {
    if (!follow || !snapshot || !viewport.current) return
    if (currentObject) setExpanded(currentObject.split('.').slice(0, 2).join('.'))
    const { width, height } = viewport.current.getBoundingClientRect(), rect = positions[journey.index]
    setCamera(old => {
      const cx = (rect.x + rect.width / 2) * old.scale + old.x, cy = (rect.y + 52) * old.scale + old.y, margin = width < 850 ? 110 : 120
      if (cx >= margin && cx <= width - margin && cy >= 160 && cy <= height - 100) return old
      return { ...old, x: width / 2 - (rect.x + rect.width / 2) * old.scale, y: height * .62 - (rect.y + 52) * old.scale }
    }); setSmooth(!reduced)
  }, [journey.index, follow, snapshot, reduced])
  useEffect(() => {
    const element = viewport.current; if (!element) return
    const wheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest('[data-no-pan]')) return
      event.preventDefault(); manualRef.current()
      const rect = element.getBoundingClientRect()
      if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) setCamera(old => ({ ...old, x: old.x - event.deltaX - (event.shiftKey ? event.deltaY : 0), y: old.y - (event.shiftKey ? 0 : event.deltaY) }))
      else setCamera(old => zoomAt(old, { x: event.clientX - rect.left, y: event.clientY - rect.top }, Math.exp(-event.deltaY * .0018)))
    }
    element.addEventListener('wheel', wheel, { passive: false }); return () => element.removeEventListener('wheel', wheel)
  }, [])
  useEffect(() => {
    if (!detail) return
    returnFocus.current = document.activeElement as HTMLElement; dialog.current?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setDetail(null); setEvidence(null) }
      if (event.key === 'Tab' && dialog.current) {
        const items = [...dialog.current.querySelectorAll<HTMLElement>('button, a[href], [tabindex="0"]')], first = items[0], last = items.at(-1)
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', key); return () => { document.removeEventListener('keydown', key); returnFocus.current?.isConnected && returnFocus.current.focus({ preventScroll: true }) }
  }, [detail])
  function pointerDown(event: React.PointerEvent) {
    if ((event.target as HTMLElement).closest('button,input,select,[data-no-pan]') || event.button > 0) return
    event.preventDefault()
    viewport.current?.setPointerCapture(event.pointerId); pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); gestureDistance.current = 0
  }
  function pointerMove(event: React.PointerEvent) {
    if (!pointers.current.has(event.pointerId)) return
    const before = [...pointers.current.values()], old = pointers.current.get(event.pointerId)!
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const after = [...pointers.current.values()], delta = { x: event.clientX - old.x, y: event.clientY - old.y }
    gestureDistance.current += Math.abs(delta.x) + Math.abs(delta.y); if (gestureDistance.current < 3) return
    manualRef.current(); setDragging(true)
    if (after.length === 2 && viewport.current) {
      const center = (list: Point[]) => ({ x: (list[0].x + list[1].x) / 2, y: (list[0].y + list[1].y) / 2 }), distance = (list: Point[]) => Math.hypot(list[1].x - list[0].x, list[1].y - list[0].y)
      const a = center(before), b = center(after), rect = viewport.current.getBoundingClientRect()
      setCamera(value => { const next = zoomAt(value, { x: a.x - rect.left, y: a.y - rect.top }, distance(after) / Math.max(1, distance(before))); return { ...next, x: next.x + b.x - a.x, y: next.y + b.y - a.y } })
    } else setCamera(value => ({ ...value, x: value.x + delta.x, y: value.y + delta.y }))
  }
  function pointerUp(event: React.PointerEvent) { pointers.current.delete(event.pointerId); if (!pointers.current.size) setDragging(false) }
  function focusStep() { if (!viewport.current) return; const { width, height } = viewport.current.getBoundingClientRect(), rect = positions[journey.index], scale = width < 850 ? .95 : 1; setSmooth(!reduced); setFollow(true); setCamera({ scale, x: width / 2 - (rect.x + rect.width / 2) * scale, y: height * .62 - (rect.y + 52) * scale }) }
  function overview() { if (!viewport.current) return; const { width, height } = viewport.current.getBoundingClientRect(); setFollow(false); setSmooth(!reduced); const next = fitBounds(canvasBounds(), { width, height: height - 130 }, width < 650 ? 32 : 65); setCamera({ ...next, y: next.y + 95 }) }
  function focusModules() { if (!viewport.current) return; const { width, height } = viewport.current.getBoundingClientRect(), target = activeNode ?? moduleNodes[0]; if (!target) return; setSmooth(!reduced); setFollow(false); setCamera({ scale: .95, x: width / 2 - (target.x + 78) * .95, y: height * .4 - (target.y + 30) * .95 }) }
  function seek(index: number) { setPlaying(false); setCursor(stepStart(index) + 1); if (JOURNEY_STEPS[index].objectId) setExpanded(JOURNEY_STEPS[index].objectId!.split('.').slice(0, 2).join('.')) }
  function restart() { setCursor(0); setExpanded(null); setFollow(true); setPlaying(!reduced); setNotice('') }
  function childrenOf(id: string) { return nodes.some(n => n.id.substring(0, n.id.lastIndexOf('.')) === id) }
  function modelCard(node: PlacedNode, leaf = false) {
    const active = currentObject === node.id && !journey.finished, parentActive = !!currentObject?.startsWith(node.id + '.') && !journey.finished, count = relatedCount(node.id), exact = completedIds.includes(node.id), isExpanded = expanded === node.id
    return <div className={`model-node ${leaf ? 'child-node' : ''} ${active ? 'is-current' : ''} ${exact ? 'is-visited' : ''} ${parentActive ? 'has-current' : ''} ${count ? 'has-visited' : ''}`} key={node.id} data-model-id={node.id} style={{ left: node.x, top: node.y, width: node.width, minHeight: node.height }}>
      <button className="model-node-main" aria-label={leaf ? `${node.title}详情` : `${isExpanded ? '收起' : '展开'}${node.title}`} aria-expanded={leaf ? undefined : isExpanded} onClick={() => { if (leaf || !childrenOf(node.id)) setDetail({ kind: 'node', id: node.id }); else { setFollow(false); setExpanded(old => old === node.id ? null : node.id) } }}><span className="model-signal"/><span className="model-copy"><strong>{readableTitle(node.title)}</strong><small>{active ? journey.progress < .5 ? '请求上下文' : '上下文返回中' : exact ? '已返回 · 演示' : parentActive ? '当前访问此分支' : count ? `路径经过 ${count} 项` : leaf ? '查看详情' : `${nodes.filter(n => n.id.substring(0, n.id.lastIndexOf('.')) === node.id).length || '—'} 个子项`}</small></span>{!leaf && childrenOf(node.id) ? <span className={isExpanded ? 'expanded-chevron' : ''}><Icon name="chevron" size={13}/></span> : null}</button>
      {!leaf && <button className="node-info" aria-label={`${node.title}详情`} onClick={() => setDetail({ kind: 'node', id: node.id })}><Icon name="info" size={13}/></button>}
    </div>
  }
  async function showEvidence(node: ModelNode) { setEvidence({ title: '正在读取证据…' }); try { const response = await fetch('/api/evidence/' + encodeURIComponent(String(meta(node, 'evidence')))); if (!response.ok) throw new Error('证据暂不可读取'); const data = await response.json(); setEvidence({ title: `${data.path}:${data.startLine}`, lines: data.lines }) } catch (err) { setEvidence({ title: '证据读取失败', error: String(err) }) } }
  const selectedNode = detail?.kind === 'node' ? byId.get(detail.id) : null
  const caption = journey.finished ? '路径已走完，排查线索已整理。' : current.kind === 'start' ? '从这次任务出发，按需获取项目上下文。' : current.kind === 'output' ? '把访问过的上下文整理为输出。' : `${journey.progress < .5 ? '请求' : '返回'} ${byId.get(current.objectId!)?.title ?? current.subtitle} 的上下文`
  return <div className={`app ${reduced ? 'reduced-motion' : ''}`}>
    <header className="app-header"><div className="brand"><span className="brand-mark"><i/><i/><i/><i/></span>Harness<sup>L3</sup></div><span className="header-divider"/><button className="workspace-button" onClick={() => setDetail({ kind: 'workspace' })}>MGRP <span>/</span><Icon name="branch" size={13}/>{snapshot?.sourceVersion?.branch ?? 'main'}</button><span className="header-section">任务上下文</span><div className="header-right"><span className="demo-badge"><i/>模拟任务路径</span><button className="header-records" onClick={() => setDetail({ kind: 'records' })}><Icon name="record" size={16}/><span>路径记录</span></button></div></header>
    <main className={`canvas-viewport ${dragging ? 'is-dragging' : ''}`} ref={viewport} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onLostPointerCapture={pointerUp} aria-label="无限画布，可拖动平移、滚轮或双指缩放" style={{ backgroundPosition: `${camera.x}px ${camera.y}px`, backgroundSize: `${24 * camera.scale}px ${24 * camera.scale}px` }}>
      <div className="task-heading" data-no-pan><div className="eyebrow"><span className={playing ? 'agent-dot running' : 'agent-dot'}/>AGENT JOURNEY <span className="task-number">/ 01</span></div><h1>排查下载取消后仍继续传输</h1><p aria-live="polite">{snapshot ? caption : '正在读取项目模块…'}</p><div className="mobile-locations"><button onClick={focusStep}><Icon name="arrow" size={13}/>任务路径</button><button onClick={focusModules}><Icon name="modules" size={13}/>模块</button></div></div>
      {snapshot && <><div className={`world ${smooth ? 'camera-smooth' : ''}`} style={{ transform: `translate(${camera.x}px,${camera.y}px) scale(${camera.scale})` }} data-camera-x={camera.x} data-camera-y={camera.y} data-camera-scale={camera.scale}>
        <div className="world-label modules-label" style={{ left: 83, top: 39 }}>项目模块 <span>{modules.length} 个顶层 · 点击展开</span></div>
        <svg className="world-lines" width="1" height="1" aria-hidden="true"><defs><marker id="path-arrow" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto"><path d="M0 0 6 3 0 6" fill="none" stroke="currentColor" strokeWidth="1"/></marker></defs>
          {parent && childNodes.map(child => <path key={child.id} className="containment-line" d={`M${parent.x + 78},${parent.y + 58} C${parent.x + 78},260 ${child.x + 80},255 ${child.x + 80},300`}/>)}
          {positions.slice(1).map((rect, i) => { const prev = positions[i], d = `M${prev.x + prev.width + 1},522 L${rect.x - 4},522`, progress = journey.states[i + 1] === 'complete' ? 1 : journey.index === i + 1 ? clamp(journey.progress * 3, 0, 1) : 0; return <g key={i}><path className="journey-line-base" d={d} markerEnd="url(#path-arrow)"/><path className="journey-line-lit" d={d} pathLength="1" strokeDasharray="1" strokeDashoffset={1 - progress}/>{journey.index === i + 1 && journey.progress < .34 && playing && !reduced && <circle className="path-particle" cx={prev.x + prev.width + 1 + (rect.x - prev.x - prev.width - 5) * progress} cy="522" r="3"/>}</g> })}
          {curveB && <><path className="context-connection" d={curve}/>{bead && playing && !reduced && <><circle className="particle-halo" cx={bead.x} cy={bead.y} r="8"/><circle className="context-particle" cx={bead.x} cy={bead.y} r="3"/></>}</>}
        </svg>
        {moduleNodes.map(node => modelCard(node))}
        {expanded && childNodes.length > 0 && <div className="branch-caption" style={{ left: childNodes[0].x, top: 277 }}><span>{parent?.title}</span><button onClick={() => { setExpanded(null); setFollow(false) }} aria-label="收起当前模块"><Icon name="close" size={12}/></button></div>}
        {childNodes.map(node => modelCard(node, true))}
        <div className="world-label path-label" style={{ left: 0, top: 429 }}>本次任务路径 <span>起点 → 上下文 → 输出</span></div>
        {JOURNEY_STEPS.map((step, i) => { const state = journey.states[i], rect = positions[i], progress = state === 'complete' ? 1 : state === 'active' ? journey.progress : 0; return <div key={step.id} data-step-id={step.id} className={`journey-station ${state} station-${step.kind}`} style={{ left: rect.x, top: rect.y, width: rect.width }}>
          <button className="station-main" onClick={() => seek(i)} aria-label={`回看第${i + 1}步：${step.title}`} aria-current={state === 'active' ? 'step' : undefined}><span className="station-top"><span className="station-index">{state === 'complete' ? <Icon name="check" size={12}/> : String(i + 1).padStart(2, '0')}</span><small>{state === 'active' ? playing ? '进行中' : '当前回放' : state === 'complete' ? '已完成' : '待到达'}</small>{step.kind === 'output' && <Icon name="output" size={15}/>}</span><strong>{step.title}</strong><span className="station-subtitle">{state === 'complete' && step.kind === 'output' ? '排查线索已整理' : byId.get(step.objectId ?? '')?.title ?? step.subtitle}</span></button><div className="station-progress"><i style={{ transform: `scaleX(${progress})` }}/></div>
          {step.kind === 'context' && step.objectId && <button className="station-detail" onClick={() => setDetail({ kind: 'node', id: step.objectId! })} aria-label={`${step.subtitle}上下文详情`}><Icon name="info" size={13}/></button>}{step.kind === 'output' && state === 'complete' && <button className="output-open" onClick={() => setDetail({ kind: 'output' })}>查看输出 <Icon name="arrow" size={13}/></button>}
        </div> })}
        <div className="path-footnote" style={{ left: 0, top: 603 }}><span className="legend-dot complete"/>已走过的路径 <span className="legend-dot current"/>当前步骤 <span className="legend-dot future"/>尚未到达</div>
      </div>
      <div className="canvas-summary" data-no-pan><span className="summary-number">{String(journey.finished ? 6 : journey.index + 1).padStart(2, '0')}</span><span>/ 06 步</span><i/><span>{completedIds.length} 处上下文已返回</span></div>
      <div className="zoom-tools" data-no-pan><button onClick={() => { manualRef.current(); setCamera(old => zoomAt(old, { x: innerWidth / 2, y: (viewport.current?.clientHeight ?? 700) / 2 }, 1.2)) }} aria-label="放大画布"><Icon name="plus"/></button><span className="zoom-value">{Math.round(camera.scale * 100)}%</span><button onClick={() => { manualRef.current(); setCamera(old => zoomAt(old, { x: innerWidth / 2, y: (viewport.current?.clientHeight ?? 700) / 2 }, 1 / 1.2)) }} aria-label="缩小画布"><Icon name="minus"/></button><span className="tool-divider"/><button onClick={overview} aria-label="概览全部内容" title="概览全部内容"><Icon name="fit"/></button><button onClick={focusStep} aria-label="定位当前步骤" title="定位当前步骤"><Icon name="target"/></button></div>
      <div className="playback-dock" data-no-pan><div className="playback-controls"><button className="play-button" onClick={() => journey.finished ? restart() : setPlaying(value => !value)} aria-label={journey.finished ? '重新播放' : playing ? '暂停回放' : '播放路径'}><Icon name={journey.finished ? 'reset' : playing ? 'pause' : 'play'} size={19}/></button><button className="step-button" onClick={() => seek(Math.max(0, journey.index - 1))} disabled={journey.index === 0} aria-label="上一步"><Icon name="previous" size={15}/></button><button className="step-button" onClick={() => { if (journey.index === 5) { setCursor(duration); setPlaying(false) } else seek(journey.index + 1) }} disabled={journey.finished} aria-label="下一步"><Icon name="next" size={15}/></button></div><div className="timeline"><div className="timeline-label"><span>演示回放</span><span>{shortTime(cursor)} <i>/</i> {shortTime(duration)}</span></div><input type="range" aria-label="任务路径回放进度" min="0" max={duration} step="10" value={cursor} onChange={event => { setPlaying(false); setCursor(Number(event.target.value)) }} style={{ '--progress': `${cursor / duration * 100}%` } as React.CSSProperties}/></div><select className="speed-select" aria-label="回放速度" value={speed} onChange={event => setSpeed(Number(event.target.value))}><option value=".5">0.5×</option><option value="1">1×</option><option value="1.5">1.5×</option></select><span className="dock-divider"/><button className={`follow-button ${follow ? 'enabled' : ''}`} onClick={() => follow ? setFollow(false) : focusStep()} aria-pressed={follow}><Icon name="target" size={15}/><span>{follow ? '正在跟随' : '跟随 Agent'}</span></button></div>
      <div className="canvas-hint">拖动画布 · 滚轮缩放<span>单指平移 · 双指缩放</span></div></>}
      {(!snapshot || error) && <div className="canvas-empty" data-no-pan>{error ? <><h2>暂时无法读取模型</h2><p>{error}</p><button onClick={load}>重新读取</button></> : <><div className="loading-line"/><p>正在准备项目上下文</p></>}</div>}
      {(notice || snapshot?.modelStatus === 'invalid') && <div className="model-notice" data-no-pan>{snapshot?.modelStatus === 'invalid' ? '主模型校验失败，当前显示最近有效层级。' : notice}<button aria-label="关闭提示" onClick={() => setNotice('')}><Icon name="close" size={13}/></button></div>}
    </main>
    {detail && <div className="detail-shade" onClick={event => { if (event.target === event.currentTarget) { setDetail(null); setEvidence(null) } }}><aside className="detail-panel" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="detail-title" tabIndex={-1}><div className="detail-heading"><span>{selectedNode ? '上下文详情' : detail.kind === 'records' ? '本次任务' : detail.kind === 'workspace' ? '工作区' : '任务输出'}</span><button aria-label="关闭详情" onClick={() => { setDetail(null); setEvidence(null) }}><Icon name="close"/></button></div><h2 id="detail-title">{selectedNode?.title ?? (detail.kind === 'records' ? '从开始到输出' : detail.kind === 'workspace' ? 'MGRP' : '排查路径已整理')}</h2>
      {selectedNode ? <><span className="detail-state">{currentObject === selectedNode.id && !journey.finished ? '回放当前访问' : completedIds.includes(selectedNode.id) ? '此回放位置之前已返回' : relatedCount(selectedNode.id) ? `路径经过 ${relatedCount(selectedNode.id)} 个子项` : '本次路径未返回此项'}</span><p className="node-description">{selectedNode.description}</p><h3>来源与依据</h3><dl><dt>对象 ID</dt><dd><code>{selectedNode.id}</code></dd><dt>来源</dt><dd>{meta(selectedNode, 'source')}</dd><dt>依据状态</dt><dd>{meta(selectedNode, 'status')}</dd><dt>源码引用</dt><dd><code>{meta(selectedNode, 'path')}</code></dd><dt>证据引用</dt><dd><code>{meta(selectedNode, 'evidence')}</code></dd><dt>模型快照</dt><dd><code>{snapshot?.revision.slice(0, 12)}</code></dd></dl><button className="detail-action" onClick={() => showEvidence(selectedNode)}>读取源码证据 <Icon name="arrow" size={15}/></button>{evidence && <div className="evidence-excerpt"><strong>{evidence.title}</strong>{evidence.error ? <p>{evidence.error}</p> : <pre>{evidence.lines?.map(line => `${line.number}  ${line.text}`).join('\n')}</pre>}</div>}<p className="detail-note">模块信息来自真实 LikeC4 主模型；本次访问与返回状态是模拟路径。工具日志覆盖未在此路径中接入。</p></> : detail.kind === 'records' ? <><span className="detail-state">模拟任务路径 · demo-cancel-download</span><div className="records-list">{JOURNEY_STEPS.map((step, i) => <button key={step.id} className={`record-item ${journey.states[i]}`} onClick={() => { seek(i); setDetail(null) }}><span>{shortTime(stepStart(i))}</span><i/><div><strong>{step.title}</strong><small>{step.objectId ? `${step.objectId} · ${journey.states[i] === 'complete' ? '已返回（模拟）' : journey.states[i] === 'active' ? '当前回放' : '待到达'}` : step.subtitle}</small></div></button>)}</div><p className="detail-note">这条连线表达示例步骤的顺序。模块包含关系与源码依赖不代表实际执行顺序；正式路径将按支持的真实事件来源构建，缺失记录保留未知。</p></> : detail.kind === 'workspace' ? <><span className="detail-state">真实模型 · 本机工作区</span><dl><dt>分支</dt><dd>{snapshot?.sourceVersion?.branch ?? '未知'}</dd><dt>来源路径</dt><dd><code>{snapshot?.runtime.sourceRoot}</code></dd><dt>模型版本</dt><dd><code>{snapshot?.revision}</code></dd><dt>模型有效性</dt><dd>{snapshot?.modelStatus}</dd><dt>证据文件</dt><dd>{snapshot?.source.status}</dd></dl><p className="detail-note">LikeC4 文本仍是权威上下文。画布位置、展开、回放与运行节点均为派生展示，不修改模型或业务源码。</p></> : <><span className="detail-state">{journey.finished ? '演示输出' : '尚未到达输出步骤'}</span>{journey.finished ? <><p className="output-lead">已沿业务入口、执行门面、调度状态与网络边界整理排查线索。</p><div className="output-findings"><h3>建议继续核对</h3><p>取消信号如何从业务入口传到 TaskManager；TaskScheduler 如何处理任务状态；网络管理层是否收到了对应的中止请求。</p><h3>对应上下文</h3>{completedIds.map(id => <button key={id} onClick={() => setDetail({ kind: 'node', id })}><Icon name="check" size={13}/>{byId.get(id)?.title}<Icon name="chevron" size={13}/></button>)}</div><p className="detail-note">这是交互演示的输出示例，未诊断真实故障，未修改 MGRP 源码或运行 SDK 测试。</p></> : <p className="detail-note">可以继续播放，或将进度拖至结尾查看演示输出。</p>}</>}
    </aside></div>}
  </div>
}
createRoot(document.getElementById('root')!).render(<App/>)
