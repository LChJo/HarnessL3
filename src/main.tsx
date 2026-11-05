import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { layoutMindmap } from './canvas-model'
import type { PlacedItem } from './canvas-model'
import { projectContext, flattenMap } from './context-map'
import type { MapItem } from './context-map'
import { useCanvas } from './use-canvas'
import type { Snapshot, Task, TaskSummary, Query, QueryResult, TaskSnapshot, C4View } from './context-types'
import { packetText } from './context-types'
import { HistoryPanel } from './HistoryPanel'
import { StructurePanel } from './StructurePanel'
import { SkillLane } from './SkillLane'
import { SkillDetails } from './SkillDetails'
import { layoutSkills } from './skill-layout'
import type { SkillBrief } from './skill-layout'
import type { Bounds } from './canvas-model'
import './styles.css'

const paths: Record<string, React.ReactNode> = {
  plus: <path d="M12 5v14M5 12h14"/>, minus: <path d="M5 12h14"/>, fit: <path d="M9 4H4v5M15 4h5v5M4 15v5h5M20 15v5h-5"/>,
  target: <><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/></>, close: <path d="m6 6 12 12M18 6 6 18"/>, chevron: <path d="m9 5 7 7-7 7"/>, check: <path d="m5 12 5 5L20 6"/>,
  branch: <><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10M18 7v3a5 5 0 0 1-5 5H6"/></>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 10v7M12 6v1"/></>, record: <path d="M5 5h14M5 12h14M5 19h9"/>, output: <><path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h4M9 12h6M9 16h5"/></>, arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>, copy: <><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v13h5"/></>,
}
function Icon({ name, size = 16 }: { name: string; size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg> }
const clientLabel = (client: string) => ({ web: '网页', cli: 'CLI', api: 'API', test: '自动检查' }[client] ?? '未知来源')
const sourceLabel = (task: TaskSummary | null) => !task ? '新的上下文检索' : (task.clients?.length ?? 0) > 1 ? '多来源请求 · 实际读取' : task.selectionMode === 'preset' ? '预设选择 · 实际读取' : task.client === 'web' ? '网页手动选择 · 实际读取' : `${clientLabel(task.client)} 请求 · 实际读取`
const stateLabel = (node: MapItem) => node.state === 'aggregate' ? `含 ${node.hits} 项命中` : node.state === 'returned' ? node.kind === 'object' ? '正文已返回' : '关系已返回' : node.state === 'reference' ? '引用已返回' : node.state === 'associated' ? '随上下文返回' : node.state === 'disclosed' ? '简述已披露' : node.children.length ? '点击展开' : '尚未返回'
const confirmed = (batch: Task['batches'][number]) => ['complete', 'partial'].includes(batch.status) && !!batch.result
type Detail = { kind: 'node'; id: string } | { kind: 'skills'; id?: string; filePath?: string } | { kind: 'packet' | 'records' | 'workspace' | 'history' | 'structure' }
type SkillLibraryStatus = { root?: string; revision?: string; updatedAt?: string; checkedAt?: string; error?: string; stale?: boolean; skills: SkillBrief[]; diagnostics?: { skillId: string; message: string }[] }
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-harness-client': 'web' }, body: JSON.stringify(body) })
  const data = await response.json(); if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`); return data
}
function mergeBounds(a: Bounds, b: Bounds): Bounds {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y)
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }
}
function closedBounds(roots: MapItem[]) {
  const context = layoutMindmap(roots, [])
  return mergeBounds(context.bounds, layoutSkills({ input: context.input, contextFrame: context.frame, contextOutput: context.output, catalog: [], expanded: false }).bounds)
}

function App() {
  const [currentSnapshot, setCurrentSnapshot] = useState<Snapshot | null>(null), [taskSnapshot, setTaskSnapshot] = useState<TaskSnapshot | null>(null), [task, setTask] = useState<Task | null>(null), [tasks, setTasks] = useState<TaskSummary[]>([])
  const [historyMode, setHistoryMode] = useState(false), historyView = useRef<{ enabled: boolean; batchId?: string }>({ enabled: false }), snapshotCache = useRef(new Map<string, TaskSnapshot>())
  const [structure, setStructure] = useState<{ views: C4View[]; revision: string; historical: boolean; loading: boolean; focusId?: string; modelStatus?: string }>({ views: [], revision: '', historical: false, loading: false })
  const [skillExpanded, setSkillExpanded] = useState(false), [expandedSkillFolders, setExpandedSkillFolders] = useState<Set<string>>(new Set()), [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set()), [libraryStatus, setLibraryStatus] = useState<SkillLibraryStatus>({ skills: [] }), [refreshingSkills, setRefreshingSkills] = useState(false)
  const skillCatalog = task?.skillPlan || historyMode ? task?.skillRouting?.catalog ?? [] : libraryStatus.root ? libraryStatus.skills : task?.skillRouting?.catalog ?? [], skillUnknown = !!task && (!task.skillRouting || task.skillRouting.status === 'unknown')
  const snapshot = taskSnapshot?.snapshot ?? currentSnapshot, readOnly = historyMode || !!task?.history?.expired
  const [purpose, setPurpose] = useState('排查下载取消后仍继续传输'), [expanded, setExpanded] = useState<string[]>([])
  const [selectedRead, setSelectedRead] = useState<string[]>([]), [selectedExpand, setSelectedExpand] = useState<string[]>([])
  const [pending, setPending] = useState<Query | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [copied, setCopied] = useState(false)
  const [detail, setDetail] = useState<Detail | null>(null), [evidence, setEvidence] = useState<{ title: string; text: string } | null>(null)
  const [fresh, setFresh] = useState<string[]>([]), [freshBatch, setFreshBatch] = useState('')
  const activeId = useRef<string | null>(null), taskSequence = useRef(0), lastBatch = useRef('')
  const expansionAnchor = useRef<{ id: string; x: number; y: number } | null>(null)
  const skillExpansionAnchor = useRef<{ id: string; x: number; y: number } | null>(null)
  const viewport = useRef<HTMLDivElement>(null), dialog = useRef<HTMLElement>(null), returnFocus = useRef<HTMLElement | null>(null)
  const roots = useMemo(() => snapshot ? projectContext(snapshot, task) : [], [snapshot, task])
  const all = useMemo(() => flattenMap(roots), [roots]), byId = useMemo(() => new Map(all.map(n => [n.id, n])), [all])
  const layout = useMemo(() => layoutMindmap(roots, expanded), [roots, expanded])
  const skillLayout = useMemo(() => layoutSkills({ input: layout.input, contextFrame: layout.frame, contextOutput: layout.output, catalog: skillCatalog, plan: skillUnknown ? null : task?.skillPlan, expanded: skillExpanded, expandedFolders: expandedSkillFolders, expandedSkills }), [layout, skillCatalog, task?.skillPlan, skillExpanded, skillUnknown, expandedSkillFolders, expandedSkills])
  const worldBounds = mergeBounds(layout.bounds, skillLayout.bounds)
  const canvas = useCanvas(viewport, worldBounds, !!snapshot)
  useLayoutEffect(() => { const before = expansionAnchor.current; if (!before) return; expansionAnchor.current = null; const after = layout.nodes.find(n => n.id === before.id); if (after) canvas.preserve(before, after) }, [layout])
  useLayoutEffect(() => { const before = skillExpansionAnchor.current; if (!before) return; skillExpansionAnchor.current = null; const after = before.id === 'skill-selector' ? skillLayout.selector : skillLayout.nodes.find(node => node.id === before.id); if (after) canvas.preserve(before, after) }, [skillLayout])
  const bodyMap = useMemo(() => new Map(task?.packet.contexts.map(node => [node.id, node]) ?? []), [task])
  const requestedRead = new Set([...(pending?.read ?? []), ...(task?.batches.filter(b => b.status === 'requested').flatMap(b => b.request.read) ?? [])])

  const loadTask = useCallback(async (id: string) => {
    const sequence = ++taskSequence.current, batchId = historyView.current.batchId, suffix = batchId ? '?batch=' + encodeURIComponent(batchId) : '', state = await api<Task>('/api/context/tasks/' + id + suffix)
    if (activeId.current !== id || sequence !== taskSequence.current) return state
    const through = state.batches.at(-1)?.id, cacheKey = state.history?.snapshotId ?? `${id}:${through ?? 'initial'}`
    let archived = snapshotCache.current.get(cacheKey)
    if (!archived) { archived = await api<TaskSnapshot>('/api/context/tasks/' + id + '/snapshot' + (through ? '?batch=' + encodeURIComponent(through) : '')); snapshotCache.current.set(cacheKey, archived); if (snapshotCache.current.size > 64) snapshotCache.current.delete(snapshotCache.current.keys().next().value!) }
    if (activeId.current !== id || sequence !== taskSequence.current) return state
    setTask(state); setTaskSnapshot(archived); setPurpose(state.title)
    const latest = [...state.batches].reverse().find(confirmed)
    if (latest && latest.id !== lastBatch.current && !historyView.current.enabled) { lastBatch.current = latest.id; setFresh(latest.result!.contexts.map(node => node.id)); setFreshBatch(latest.id) }
    return state
  }, [])
  const loadTasks = useCallback(async (choose = false) => {
    const result = await api<{ tasks: TaskSummary[] }>('/api/context/tasks'); setTasks(result.tasks)
    if (choose && !activeId.current && result.tasks[0]) { activeId.current = result.tasks[0].id; await loadTask(activeId.current) }
  }, [loadTask])
  useEffect(() => {
    const fail = (e: Error) => setError(e.message)
    api<Snapshot>('/api/context/overview').then(setCurrentSnapshot).catch(fail); loadTasks(true).catch(fail)
    api<SkillLibraryStatus>('/api/skills/catalog').then(setLibraryStatus).catch(fail)
    const stream = new EventSource('/api/stream')
    const context = (event: MessageEvent) => { const data = JSON.parse(event.data); void loadTasks().catch(fail); if (data.taskId === activeId.current && !historyView.current.enabled) void loadTask(data.taskId).catch(fail) }
    const model = () => { void api<Snapshot>('/api/context/overview').then(setCurrentSnapshot).catch(fail); if (activeId.current && !historyView.current.enabled) void loadTask(activeId.current).catch(fail) }
    stream.addEventListener('context', context as EventListener); stream.addEventListener('model', model)
    stream.addEventListener('skills', ((event: MessageEvent) => setLibraryStatus(JSON.parse(event.data))) as EventListener)
    return () => stream.close()
  }, [loadTask, loadTasks])
  useEffect(() => { if (!fresh.length) return; const timer = setTimeout(() => setFresh([]), 1100); return () => clearTimeout(timer) }, [freshBatch])
  useEffect(() => {
    if (!detail) return
    returnFocus.current = document.activeElement as HTMLElement; dialog.current?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setDetail(null); setEvidence(null) }
      if (event.key === 'Tab' && dialog.current) {
        const items = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')], first = items[0], last = items.at(-1)
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', key); return () => { document.removeEventListener('keydown', key); if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true }) }
  }, [detail])
  function resetTask() { activeId.current = null; ++taskSequence.current; historyView.current = { enabled: false }; setHistoryMode(false); setTaskSnapshot(null); setTask(null); setExpanded([]); setSkillExpanded(false); setExpandedSkillFolders(new Set()); setExpandedSkills(new Set()); setSelectedRead([]); setSelectedExpand([]); setError(''); setFresh([]); canvas.fit(closedBounds(roots)) }
  async function chooseTask(id: string, historical = false, batchId?: string) { if (!id) return resetTask(); activeId.current = id; historyView.current = { enabled: historical, batchId }; setHistoryMode(historical); setExpanded([]); setSkillExpanded(false); setExpandedSkillFolders(new Set()); setExpandedSkills(new Set()); setSelectedRead([]); setSelectedExpand([]); setError(''); setFresh([]); setDetail(null); await loadTask(id); canvas.fit(closedBounds(roots)) }
  async function createTask(mode = 'manual') {
    historyView.current = { enabled: false }; setHistoryMode(false); setSkillExpanded(false); setExpandedSkillFolders(new Set()); setExpandedSkills(new Set())
    const result = await api<{ task: TaskSummary; result: QueryResult }>('/api/harness/tasks', { title: purpose, selectionMode: mode })
    activeId.current = result.task.id; lastBatch.current = ''; await loadTask(result.task.id); await loadTasks(); return result.task.id
  }
  async function start() { setBusy(true); setError(''); try { await createTask() } catch (e) { setError(String(e)) } finally { setBusy(false) } }
  function toggleSkillHub() { skillExpansionAnchor.current = { id: 'skill-selector', ...skillLayout.selector }; setSkillExpanded(value => !value) }
  function toggleSkillFolder(group: string) {
    const node = skillLayout.nodes.find(node => node.kind === 'folder' && node.group === group)
    if (node) skillExpansionAnchor.current = { id: node.id, x: node.x, y: node.y }
    setExpandedSkillFolders(value => { const next = new Set(value); if (next.has(group)) next.delete(group); else next.add(group); return next })
  }
  function toggleSkillBranch(id: string) {
    const node = skillLayout.nodes.find(node => node.id === 'skill:' + id)
    if (node) skillExpansionAnchor.current = { id: node.id, x: node.x, y: node.y }
    setExpandedSkills(value => { const next = new Set(value); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }
  async function refreshSkills() {
    setRefreshingSkills(true)
    try {
      const result = await api<SkillLibraryStatus>('/api/skills/refresh', {})
      setLibraryStatus(result)
      const id = activeId.current
      if (!result.error && id && !historyView.current.enabled && !task?.skillPlan && task?.skillRouting?.status === 'awaiting-selection' && !task.outdated && !task.history?.expired) {
        await api('/api/harness/tasks/' + id + '/prompt', { refreshCatalog: true })
        if (activeId.current === id) await loadTask(id)
      }
    } catch (e) { setError(String(e)) } finally { setRefreshingSkills(false) }
  }
  async function retrieve(query: Query, id = activeId.current) {
    if (!id) id = await createTask()
    setPending(query)
    const result = await api<QueryResult>('/api/context/tasks/' + id + '/query', query)
    await loadTask(id); await loadTasks(); return result
  }
  async function runBatch() {
    if (readOnly) { setError('历史查看为只读，请新建检索。'); return }
    setBusy(true); setError('')
    try {
      const result = await retrieve({ expand: selectedExpand, read: selectedRead, known: Object.fromEntries([...bodyMap].map(([id, body]) => [id, body.contentHash])) })
      setSelectedRead(result.errors.filter(e => e.operation === 'read').map(e => e.id)); setSelectedExpand(result.errors.filter(e => e.operation === 'expand').map(e => e.id))
      if (result.errors.length) setError(result.errors.map(e => `${e.id}: ${e.message}`).join('；'))
    } catch (e) { setError(String(e)) } finally { setPending(null); setBusy(false) }
  }
  async function preset() {
    setBusy(true); setError(''); setExpanded([]); setSelectedRead([]); setSelectedExpand([])
    try { const id = await createTask('preset'); await retrieve({ expand: ['mgrp.execution', 'mgrp.network'] }, id); await retrieve({ read: ['mgrp.execution.task', 'mgrp.execution.scheduler', 'mgrp.execution.transfer', 'mgrp.network'] }, id) }
    catch (e) { setError(String(e)) } finally { setPending(null); setBusy(false) }
  }
  function toggle(id: string, mode: 'read' | 'expand') { const set = mode === 'read' ? setSelectedRead : setSelectedExpand; set(old => old.includes(id) ? old.filter(key => key !== id) : [...old, id]) }
  function openBranch(id: string) { const node = layout.nodes.find(n => n.id === id); if (node) expansionAnchor.current = { id, x: node.x, y: node.y }; setExpanded(old => old.includes(id) ? old.filter(key => key !== id && !isDescendant(key, id)) : [...old, id]) }
  function isDescendant(child: string, parent: string) { return flattenMap(byId.get(parent)?.children ?? []).some(node => node.id === child) }
  async function copyPacket() { if (!task) return; try { await navigator.clipboard.writeText(packetText(task)); setCopied(true); setTimeout(() => setCopied(false), 1800) } catch { setError('复制不可用，请打开上下文包手动复制。') } }
  async function showEvidence(id: string) {
    try { const data = await api<{ path: string; startLine: number; lines: { number: number; text: string }[] }>('/api/evidence/' + encodeURIComponent(id)); setEvidence({ title: `${data.path}:${data.startLine}`, text: data.lines.map(line => `${line.number}  ${line.text}`).join('\n') }) }
    catch (e) { setEvidence({ title: '证据暂不可用', text: String(e) }) }
  }
  async function openStructure(focusId?: string, forceCurrent = false) {
    setDetail({ kind: 'structure' }); setError('')
    if (historyView.current.enabled && !forceCurrent) { setStructure({ views: taskSnapshot?.snapshot.c4Views ?? [], revision: task?.modelRevision ?? '', historical: true, loading: false, focusId }); return }
    setStructure({ views: [], revision: '', historical: false, loading: true, focusId })
    try { const data = await api<{ views: C4View[]; revision: string; modelStatus: string }>('/api/context/structure'); setStructure({ ...data, historical: false, loading: false, focusId }) }
    catch (e) { setError(String(e)); setStructure({ views: [], revision: '', historical: false, loading: false, focusId }) }
  }
  const selected = detail?.kind === 'node' ? byId.get(detail.id) : null
  const chosen = selectedRead.length + selectedExpand.length
  const freshFor = (ids: string[]) => ids.some(id => fresh.includes(id))
  function nodeCard(node: PlacedItem) {
    const open = expanded.includes(node.id), readSelected = !!node.objectId && selectedRead.includes(node.objectId), expandSelected = !!node.objectId && selectedExpand.includes(node.objectId), waiting = !!node.objectId && requestedRead.has(node.objectId)
    return <div key={node.id} className={`map-node ${node.kind === 'category' ? 'category-node' : ''} ${node.hit ? 'is-hit' : ''} ${node.state === 'returned' && node.kind === 'object' ? 'body-returned' : ''} ${readSelected || expandSelected ? 'is-selected' : ''} ${waiting ? 'is-requested' : ''} ${freshFor(node.relatedIds) ? 'fresh-return' : ''}`} data-map-id={node.id} data-category={node.category} data-depth={node.depth + 1} data-model-id={node.objectId} data-state={node.state} style={{ left: node.x, top: node.y, width: node.width, height: node.height }}>
      <button className="map-main" aria-label={node.children.length ? `${open ? '收起' : '展开'}${node.title}` : `${node.title}详情`} aria-expanded={node.children.length ? open : undefined} onClick={() => node.children.length ? openBranch(node.id) : (setEvidence(null), setDetail({ kind: 'node', id: node.id }))} title={node.brief}>
        <span className="map-title"><i/><strong>{node.title}</strong>{node.children.length > 0 && <span className={open ? 'rotated' : ''}><Icon name="chevron" size={12}/></span>}</span>
        <span className="map-brief">{node.brief}</span><span className="map-state">{waiting ? '正文请求中' : stateLabel(node)}</span>
      </button>
      {node.kind === 'category' && <span className="map-count">{node.hits ? `${node.hits} 项` : '—'}</span>}
      {node.kind !== 'category' && <div className="map-tools">{node.objectId && <>{node.children.length > 0 && <button disabled={readOnly || busy} className={expandSelected ? 'picked' : ''} aria-label={`选择${node.title}子层目录`} aria-pressed={expandSelected} onClick={() => toggle(node.objectId!, 'expand')}>子层</button>}<button disabled={readOnly || busy} className={readSelected ? 'picked' : ''} aria-label={`选择${node.title}正文`} aria-pressed={readSelected} onClick={() => toggle(node.objectId!, 'read')}>{readSelected ? '✓' : '+'} 正文</button></>}<button aria-label={`${node.title}来源详情`} onClick={() => { setEvidence(null); setDetail({ kind: 'node', id: node.id }) }}><Icon name="info" size={12}/></button></div>}
    </div>
  }
  return <div className="app"><header className="app-header"><div className="brand"><span className="brand-mark"><i/><i/><i/><i/></span>Harness<sup>L3</sup></div><span className="header-divider"/><button className="workspace-button" onClick={() => setDetail({ kind: 'workspace' })}>MGRP <span>/</span><Icon name="branch" size={13}/>{snapshot?.sourceVersion?.branch ?? 'main'}</button><span className="header-section">上下文脑图</span><div className="header-right"><button className="structure-button" aria-label="查看C4项目结构" onClick={() => void openStructure()}><Icon name="branch"/><span>项目结构</span></button><button className="history-button" aria-label="60天任务历史" onClick={() => setDetail({ kind: 'history' })}><Icon name="record"/><span>历史</span></button><select aria-label="当前检索任务" value={task?.id ?? ''} onChange={event => void chooseTask(event.target.value).catch(e => setError(String(e)))}><option value="">新的检索</option>{(task && !tasks.some(item => item.id === task.id) ? [task, ...tasks] : tasks).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select><button className="records-button" aria-label="检索记录" onClick={() => setDetail({ kind: 'records' })}><Icon name="record"/><span>记录</span></button></div></header>
    <main ref={viewport} className={`canvas-viewport ${canvas.dragging ? 'is-dragging' : ''}`} {...canvas.handlers} aria-label="上下文检索无限画布" style={{ backgroundPosition: `${canvas.camera.x}px ${canvas.camera.y}px`, backgroundSize: `${24 * canvas.camera.scale}px ${24 * canvas.camera.scale}px` }}>
      <div className="task-heading" data-no-pan><div className="eyebrow">CONTEXT <span>/ 同一张画布</span></div><h1>{task ? task.title : '从五类上下文，逐层看清任务'}</h1><p>{busy ? '正在批量获取所选上下文…' : task?.outdated ? '旧快照已保留，新读取需重新开始。' : '点击展开层级，沿连线查看命中范围。'}</p><div className="origin-label"><i/>{sourceLabel(task)}</div>{historyMode && <div className="history-indicator">历史只读 · {task?.batches.length} / {task?.history?.totalBatches} 批<button onClick={() => task && void chooseTask(task.id, true).catch(e => setError(String(e)))}>最终组织</button><button onClick={resetTask}>新任务</button></div>}{taskSnapshot?.status === 'partial' && <div className="legacy-note">旧记录仅恢复已保留内容，未记录区域未知。</div>}<div className="mobile-locations"><button onClick={() => canvas.locate(layout.input)}>输入</button><button onClick={() => canvas.locate(layout.nodes.find(n => n.depth === 0) ?? layout.input)}>五类</button><button onClick={() => canvas.locate(layout.output)}>输出</button><button onClick={() => canvas.locate(skillLayout.selector)}>技能</button></div></div>
      {snapshot && <><div className={`world ${canvas.smooth ? 'camera-smooth' : ''}`} style={{ transform: `translate(${canvas.camera.x}px,${canvas.camera.y}px) scale(${canvas.camera.scale})` }} data-camera-x={canvas.camera.x} data-camera-y={canvas.camera.y} data-camera-scale={canvas.camera.scale}>
        <div className="context-region" style={{ left: layout.frame.x, top: layout.frame.y, width: layout.frame.width, height: layout.frame.height }}><span>本次上下文 <small>对象 · 关系 · 来源 · 证据 · 版本</small></span></div>
        <svg className="world-lines" width="1" height="1" aria-hidden="true">{layout.edges.map(edge => <g key={edge.source + '>' + edge.target}><path data-edge-kind={edge.kind} data-edge-source={edge.source} data-edge-target={edge.target} className={`map-edge ${edge.hit ? 'is-hit' : ''} ${edge.hit && freshFor(edge.relatedIds) ? 'new-route' : ''}`} d={edge.d}/>{edge.hit && freshFor(edge.relatedIds) && !canvas.reduced && <circle r="2.6" className="return-particle"><animateMotion dur=".75s" path={edge.d} fill="freeze"/></circle>}</g>)}</svg>
        <section className="input-card" style={{ left: layout.input.x, top: layout.input.y, width: layout.input.width, height: layout.input.height }} aria-label="任务输入"><span className="card-eyebrow">任务输入</span>{task ? <><h2>{task.title}</h2><p>{task.batches.length} 批请求 · {clientLabel(task.client)}创建</p><button onClick={resetTask}>新建检索 <Icon name="plus" size={13}/></button></> : <><textarea aria-label="任务目的" value={purpose} onChange={e => setPurpose(e.target.value)} rows={3} maxLength={500}/><button className="start-button" onClick={start} disabled={busy || !purpose.trim() || snapshot.modelStatus !== 'valid'}>开始检索 <Icon name="arrow" size={13}/></button></>}</section>
        {layout.nodes.map(nodeCard)}
        <SkillLane input={layout.input} contextFrame={layout.frame} contextOutput={layout.output} catalog={skillCatalog} plan={task?.skillPlan} expanded={skillExpanded} onToggle={toggleSkillHub} expandedFolders={expandedSkillFolders} onToggleFolder={toggleSkillFolder} expandedSkills={expandedSkills} onToggleSkill={toggleSkillBranch} onInspect={(id, filePath) => setDetail({ kind: 'skills', id, filePath })} onRefresh={() => void refreshSkills()} refreshing={refreshingSkills} libraryStatus={libraryStatus} unavailable={skillUnknown}/>
        <section className={`output-card ${bodyMap.size ? 'has-output' : ''}`} data-output-count={bodyMap.size} style={{ left: layout.output.x, top: layout.output.y, width: layout.output.width, height: layout.output.height }} aria-label="上下文输出"><span className="card-eyebrow"><Icon name="output" size={14}/>上下文输出</span><h2>{bodyMap.size ? `${bodyMap.size} 项正文已就绪` : '等待所选上下文'}</h2><p>{bodyMap.size ? '同一次读取，从五类信息查看内容与依据。' : '按简述选择目标，一批取回需要的内容。'}</p>{bodyMap.size ? <><button className="packet-open" onClick={() => setDetail({ kind: 'packet' })}>查看上下文包 <Icon name="arrow" size={13}/></button><button className="copy-inline" onClick={copyPacket}><Icon name={copied ? 'check' : 'copy'} size={12}/>{copied ? '已复制' : '复制'}</button></> : <small>尚未返回正文</small>}</section>
      </div>
      <div className="canvas-summary" data-no-pan><span>{task?.disclosedIds.length ?? 0} 项简述</span><i/><strong>{bodyMap.size}</strong><span>项正文</span></div>
      <div className={`selection-dock ${chosen ? 'has-selection' : ''}`} data-no-pan>{chosen ? <><div className="selection-count"><strong>{chosen}</strong><span>{selectedExpand.length} 个目录 · {selectedRead.length} 项正文</span></div><button className="clear-selection" onClick={() => { setSelectedRead([]); setSelectedExpand([]) }} disabled={busy}>清空</button><button className="retrieve-button" onClick={runBatch} disabled={readOnly || busy || task?.outdated || currentSnapshot?.modelStatus !== 'valid'}>{busy ? '读取中…' : '批量获取'}<Icon name="arrow" size={15}/></button><span className="dock-divider"/></> : <span className="dock-note">五类入口 · 点击逐层展开</span>}<button className="preset-button" onClick={preset} disabled={busy} title="预设目标，执行真实读取">运行示例</button></div>
      <div className="zoom-tools" data-no-pan><button aria-label="放大画布" onClick={() => canvas.zoom(1.2)}><Icon name="plus"/></button><span>{Math.round(canvas.camera.scale * 100)}%</span><button aria-label="缩小画布" onClick={() => canvas.zoom(1 / 1.2)}><Icon name="minus"/></button><i/><button aria-label="概览全部内容" onClick={() => canvas.fit(worldBounds)}><Icon name="fit"/></button><button aria-label="收起全部层级" onClick={() => { setExpanded([]); setSkillExpanded(false); setExpandedSkillFolders(new Set()); setExpandedSkills(new Set()); canvas.fit(closedBounds(roots)) }}><Icon name="branch"/></button><button aria-label="定位技能方案" onClick={() => canvas.locate(skillLayout.output)}><Icon name="branch"/></button><button aria-label="定位上下文输出" onClick={() => canvas.locate(layout.output)}><Icon name="target"/></button></div><div className="canvas-hint">拖动平移 · 滚轮缩放<span>单指平移 · 双指缩放</span></div></>}
      {error && <div className="error-banner" data-no-pan>{error}<button aria-label="关闭提示" onClick={() => setError('')}><Icon name="close" size={13}/></button></div>}
      {currentSnapshot?.modelStatus !== 'valid' && currentSnapshot && !historyMode && <div className="model-warning" data-no-pan>模型待修复，当前为最近有效层级；新读取已停止。</div>}
      {currentSnapshot?.modelStatus === 'valid' && currentSnapshot.source?.status && currentSnapshot.source.status !== 'matched' && !historyMode && <div className="model-warning" data-no-pan>所引证据待核验。已有上下文保留返回时的来源状态。</div>}
      {!snapshot && <div className="loading-state">正在读取 LikeC4 模型…</div>}
    </main>
    {detail && <div className="detail-shade" onClick={event => { if (event.target === event.currentTarget) { setDetail(null); setEvidence(null) } }}><aside className={`detail-panel ${detail.kind === 'packet' || detail.kind === 'skills' ? 'packet-panel' : detail.kind === 'history' ? 'history-panel' : detail.kind === 'structure' ? 'structure-panel' : ''}`} ref={dialog} role="dialog" aria-modal="true" aria-labelledby="detail-title" tabIndex={-1}><div className="detail-heading"><span>{detail.kind === 'skills' ? '独立技能路由' : detail.kind === 'history' ? '最近60天' : detail.kind === 'structure' ? 'LikeC4' : detail.kind === 'node' ? '上下文详情' : detail.kind === 'packet' ? '返回给调用方的内容' : detail.kind === 'records' ? '真实请求记录' : '工作区'}</span><button aria-label="关闭详情" onClick={() => { setDetail(null); setEvidence(null) }}><Icon name="close"/></button></div><h2 id="detail-title">{detail.kind === 'skills' ? '技能方案' : detail.kind === 'history' ? '历史任务' : detail.kind === 'structure' ? '项目结构' : selected?.title ?? (detail.kind === 'packet' ? '上下文包' : detail.kind === 'records' ? '分批获取的上下文' : 'MGRP')}</h2>
      {detail.kind === 'skills' ? <SkillDetails task={task} catalog={skillCatalog} focusId={detail.id} focusFile={detail.filePath} readOnly={readOnly} libraryStatus={libraryStatus} onRefresh={() => void refreshSkills()} refreshing={refreshingSkills}/> : detail.kind === 'history' ? <HistoryPanel onOpen={id => void chooseTask(id, true).catch(e => setError(String(e)))}/> : detail.kind === 'structure' ? (structure.loading ? <p className="detail-note">正在读取 LikeC4 结构视图…</p> : <><StructurePanel views={structure.views} revision={structure.revision} historical={structure.historical} focusId={structure.focusId} modelStatus={structure.modelStatus}/>{structure.historical && !structure.views.length && <button className="detail-action" onClick={() => void openStructure(undefined, true)}>查看当前项目结构（非历史图）</button>}</>) : selected ? <><span className="detail-state">{stateLabel(selected)}</span><p className="node-description">{selected.brief}</p><dl>{Object.entries(selected.fields).map(([key, value]) => <React.Fragment key={key}><dt>{key}</dt><dd><code>{value}</code></dd></React.Fragment>)}</dl>{selected.objectId && <button className="detail-action" disabled={readOnly || busy} onClick={() => toggle(selected.objectId!, 'read')}>{selectedRead.includes(selected.objectId) ? '已加入正文候选' : '加入正文候选'}<Icon name="plus" size={14}/></button>}{(selected.evidenceId || selected.fields.证据引用 && selected.fields.证据引用 !== '未知') && <button className="detail-action" onClick={() => showEvidence(selected.evidenceId ?? selected.fields.证据引用.split(/[,\s]+/)[0])}>{historyMode ? '预览当前源码' : '查看源码证据'} <Icon name="arrow" size={14}/></button>}{(selected.objectId || selected.relation) && <button className="detail-action" onClick={() => void openStructure(selected.objectId ?? selected.relation?.source)}>查看C4结构 <Icon name="branch" size={14}/></button>}{evidence && <div className="evidence-excerpt"><strong>{evidence.title}</strong><pre>{evidence.text}</pre></div>}<p className="detail-note">展开是浏览层级。证据引用、源码预览和对象正文分别表达；关系保留事实/推断与未核验状态。返回不代表模型已理解。</p></> : detail.kind === 'packet' ? task && <><span className="detail-state">{bodyMap.size} 项正文 · {task.modelRevision.slice(0, 8)}{task.outdated ? ' · 旧快照' : ''}</span><button className="detail-action" onClick={copyPacket}><Icon name="copy" size={14}/>{copied ? '已复制上下文包' : '复制上下文包'}</button><textarea className="packet-text" aria-label="上下文包原文" value={packetText(task)} readOnly rows={24}/><p className="detail-note">五类是同一包的不同信息视角，分类命中数不能相加为独立读取量。</p></> : detail.kind === 'records' ? <><span className="detail-state">{sourceLabel(task)}</span>{task ? <><div className="records-list">{task.batches.map((batch, i) => <div key={batch.id} className={`batch-record ${batch.status}`}><span>批次 {String(i + 1).padStart(2, '0')}</span><strong>{{ complete: '完成', partial: '部分完成', requested: '请求中', unknown: '结果未知', failed: '失败' }[batch.status] ?? batch.status}</strong><p>{batch.request.expand.length} 个目录 · {batch.request.read.length} 项正文</p>{batch.skillPlan && <p className="record-skills">技能选择 {batch.skillPlan.skills.length} 项 · 执行状态未知</p>}<code>{batch.request.expand.concat(batch.request.read).join('\n')}</code><button className="batch-view" onClick={() => void chooseTask(task.id, true, batch.id).catch(e => setError(String(e)))}>查看此时上下文 →</button><small>{new Date(batch.requestedAt).toLocaleTimeString('zh-CN')} · {batch.result?.durationMs ?? '—'}ms · {batch.client}</small>{batch.result?.errors.map(e => <p className="record-error" key={e.id + e.operation}>{e.id}: {e.message}</p>)}</div>)}</div><p className="detail-note">任务 {task.id}<br/>worktree {task.worktreeId}<br/>记录为读取层生成响应；调用来源由调用方声明，未采集的其他工具操作仍未知。</p></> : <p className="detail-note">开始检索后，实际请求会记录在这里。</p>}</> : <><span className="detail-state">真实 LikeC4 模型 · 本机来源</span><dl><dt>分支</dt><dd>{snapshot?.sourceVersion?.branch}</dd><dt>来源路径</dt><dd><code>{snapshot?.runtime.sourceRoot}</code></dd><dt>模型快照</dt><dd><code>{snapshot?.revision}</code></dd><dt>任务归属</dt><dd><code>{task?.worktreeId ?? '尚未创建任务'}</code></dd></dl><p className="detail-note">输入、五类上下文和输出属于同一张无限画布；五类是同一权威模型的派生展示。CLI继续使用原来的批量读取入口。</p></>}
    </aside></div>}
  </div>
}
createRoot(document.getElementById('root')!).render(<App/>)
