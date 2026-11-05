import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { connection, layoutContext } from './canvas-model'
import { useCanvas } from './use-canvas'
import type { Bounds } from './canvas-model'
import type { ModelNode, Snapshot, Task, TaskSummary, Query, QueryResult } from './context-types'
import { meta, packetText } from './context-types'
import './styles.css'

const icons: Record<string, React.ReactNode> = {
  plus: <path d="M12 5v14M5 12h14"/>, minus: <path d="M5 12h14"/>, fit: <path d="M9 4H4v5M15 4h5v5M4 15v5h5M20 15v5h-5"/>,
  target: <><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></>, close: <path d="m6 6 12 12M18 6 6 18"/>, chevron: <path d="m9 5 7 7-7 7"/>, check: <path d="m5 12 5 5L20 6"/>,
  branch: <><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10M18 7v3a5 5 0 0 1-5 5H6"/></>, info: <><circle cx="12" cy="12" r="9"/><path d="M12 10v7M12 6v1"/></>, record: <path d="M5 5h14M5 12h14M5 19h9"/>, output: <><path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h4M9 12h6M9 16h5"/></>, arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>, copy: <><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v13h5"/></>,
}
function Icon({ name, size = 17 }: { name: string; size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icons[name]}</svg> }
const readable = (text: string) => text.split(/(?<=[a-z])(?=[A-Z])/).map((part, i) => <React.Fragment key={i}>{i > 0 && <wbr/>}{part}</React.Fragment>)
const clientLabel = (client: string) => ({ web: '网页', cli: 'CLI', api: 'API', test: '自动检查' }[client] ?? '未知来源')
const sourceLabel = (task: TaskSummary | null) => !task ? '未开始检索' : (task.clients?.length ?? 0) > 1 ? '多来源请求 · 实际读取' : task.selectionMode === 'preset' ? '预设选择 · 实际读取' : task.client === 'web' ? '网页手动选择 · 实际读取' : `${clientLabel(task.client)} 请求 · 实际读取`
const confirmed = (batch: Task['batches'][number]) => ['complete', 'partial'].includes(batch.status) && !!batch.result
type Detail = { kind: 'node'; id: string } | { kind: 'packet' | 'records' | 'workspace' }
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-harness-client': 'web' }, body: JSON.stringify(body) })
  const data = await response.json(); if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`); return data
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [task, setTask] = useState<Task | null>(null), [tasks, setTasks] = useState<TaskSummary[]>([])
  const [purpose, setPurpose] = useState('排查下载取消后仍继续传输'), [expanded, setExpanded] = useState<string[]>([])
  const [selectedRead, setSelectedRead] = useState<string[]>([]), [selectedExpand, setSelectedExpand] = useState<string[]>([])
  const [pending, setPending] = useState<Query | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [copied, setCopied] = useState(false)
  const [detail, setDetail] = useState<Detail | null>(null), [evidence, setEvidence] = useState<{ title: string; text: string } | null>(null)
  const [fresh, setFresh] = useState<string[]>([]), [freshBatch, setFreshBatch] = useState('')
  const activeId = useRef<string | null>(null), taskSequence = useRef(0), lastBatch = useRef(''), seenDirectories = useRef(new Set<string>())
  const viewport = useRef<HTMLDivElement>(null), dialog = useRef<HTMLElement>(null), returnFocus = useRef<HTMLElement | null>(null)
  const nodes = snapshot?.elements ?? [], byId = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes])
  const layout = useMemo(() => layoutContext(nodes, expanded), [nodes, expanded])
  const canvas = useCanvas(viewport, layout.bounds, !!snapshot)
  const bodyMap = useMemo(() => new Map(task?.packet.contexts.map(node => [node.id, node]) ?? []), [task])
  const disclosed = new Set(task?.disclosedIds ?? [])
  const directories = new Set(task?.batches.filter(confirmed).flatMap(batch => batch.result?.directories.map(d => d.id) ?? []) ?? [])
  const requestedRead = new Set([...(pending?.read ?? []), ...(task?.batches.filter(b => b.status === 'requested').flatMap(b => b.request.read) ?? [])])
  const requestedExpand = new Set([...(pending?.expand ?? []), ...(task?.batches.filter(b => b.status === 'requested').flatMap(b => b.request.expand) ?? [])])
  const bodyCount = (id: string) => [...bodyMap.keys()].filter(key => key.startsWith(id + '.')).length

  const loadTask = useCallback(async (id: string) => {
    const sequence = ++taskSequence.current
    const state = await api<Task>('/api/context/tasks/' + id)
    if (activeId.current !== id || sequence !== taskSequence.current) return state
    setTask(state); setPurpose(state.title)
    const newDirectories = state.batches.flatMap(batch => {
      const key = state.id + ':' + batch.id
      if (!confirmed(batch) || !batch.result || seenDirectories.current.has(key)) return []
      seenDirectories.current.add(key)
      return batch.result.directories.filter(d => d.id !== 'mgrp').map(d => d.id)
    })
    setExpanded(old => [...new Set([...old, ...newDirectories])])
    const latest = [...state.batches].reverse().find(confirmed)
    if (latest && latest.id !== lastBatch.current) { lastBatch.current = latest.id; setFresh(latest.result!.contexts.map(node => node.id)); setFreshBatch(latest.id) }
    return state
  }, [])
  const loadTasks = useCallback(async (choose = false) => {
    const result = await api<{ tasks: TaskSummary[] }>('/api/context/tasks'); setTasks(result.tasks)
    if (choose && !activeId.current && result.tasks[0]) { activeId.current = result.tasks[0].id; await loadTask(activeId.current) }
  }, [loadTask])
  useEffect(() => {
    api<Snapshot>('/api/context/overview').then(setSnapshot).catch(e => setError(e.message))
    loadTasks(true).catch(e => setError(e.message))
    const stream = new EventSource('/api/stream')
    const context = (event: MessageEvent) => { const data = JSON.parse(event.data); void loadTasks().catch(() => {}); if (data.taskId === activeId.current) void loadTask(data.taskId).catch(e => setError(e.message)) }
    const model = () => { void api<Snapshot>('/api/context/overview').then(setSnapshot); if (activeId.current) void loadTask(activeId.current) }
    stream.addEventListener('context', context as EventListener); stream.addEventListener('model', model)
    return () => stream.close()
  }, [loadTask, loadTasks])
  useEffect(() => { if (!fresh.length) return; const timer = setTimeout(() => setFresh([]), 1000); return () => clearTimeout(timer) }, [freshBatch])
  useEffect(() => {
    if (!detail) return
    returnFocus.current = document.activeElement as HTMLElement; dialog.current?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setDetail(null); setEvidence(null) }
      if (event.key === 'Tab' && dialog.current) {
        const items = [...dialog.current.querySelectorAll<HTMLElement>('button,textarea,[tabindex="0"]')], first = items[0], last = items.at(-1)
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', key); return () => { document.removeEventListener('keydown', key); returnFocus.current?.isConnected && returnFocus.current.focus({ preventScroll: true }) }
  }, [detail])

  function resetTask() { activeId.current = null; ++taskSequence.current; setTask(null); setExpanded([]); setSelectedRead([]); setSelectedExpand([]); setError(''); canvas.locate(layout.input) }
  async function chooseTask(id: string) { if (!id) return resetTask(); activeId.current = id; seenDirectories.current.clear(); setExpanded([]); setSelectedRead([]); setSelectedExpand([]); setError(''); await loadTask(id) }
  async function createTask(mode = 'manual') {
    const result = await api<{ task: TaskSummary; result: QueryResult }>('/api/context/tasks', { title: purpose, client: 'web', selectionMode: mode })
    activeId.current = result.task.id; lastBatch.current = ''; setExpanded([]); await loadTask(result.task.id); await loadTasks(); return result.task.id
  }
  async function start() { setBusy(true); setError(''); try { await createTask() } catch (e) { setError(String(e)) } finally { setBusy(false) } }
  async function retrieve(query: Query, id = activeId.current) {
    if (!id) id = await createTask()
    setPending(query)
    const result = await api<QueryResult>('/api/context/tasks/' + id + '/query', query)
    await loadTask(id); await loadTasks(); return result
  }
  async function runBatch() {
    setBusy(true); setError('')
    try {
      const result = await retrieve({ expand: selectedExpand, read: selectedRead, known: Object.fromEntries([...bodyMap].map(([id, body]) => [id, body.contentHash])) })
      setSelectedRead(result.errors.filter(e => e.operation === 'read').map(e => e.id)); setSelectedExpand(result.errors.filter(e => e.operation === 'expand').map(e => e.id))
      if (result.errors.length) setError(result.errors.map(e => `${e.id}: ${e.message}`).join('；'))
    } catch (e) { setError(String(e)) } finally { setPending(null); setBusy(false) }
  }
  async function preset() {
    setBusy(true); setError(''); setSelectedRead([]); setSelectedExpand([])
    try { const id = await createTask('preset'); await retrieve({ expand: ['mgrp.execution', 'mgrp.network'] }, id); await retrieve({ read: ['mgrp.execution.task', 'mgrp.execution.scheduler', 'mgrp.execution.transfer', 'mgrp.network'] }, id) }
    catch (e) { setError(String(e)) } finally { setPending(null); setBusy(false) }
  }
  function toggle(id: string, mode: 'read' | 'expand') { const set = mode === 'read' ? setSelectedRead : setSelectedExpand; set(old => old.includes(id) ? old.filter(key => key !== id) : [...old, id]) }
  function openBranch(id: string) { setExpanded(old => old.includes(id) ? old.filter(key => key !== id) : [...old, id]) }
  async function copyPacket() { if (!task) return; try { await navigator.clipboard.writeText(packetText(task)); setCopied(true); setTimeout(() => setCopied(false), 1800) } catch { setError('复制不可用，请打开上下文包手动复制。') } }
  async function showEvidence(node: ModelNode) { try { const data = await api<{ path: string; startLine: number; lines: { number: number; text: string }[] }>('/api/evidence/' + encodeURIComponent(String(meta(node, 'evidence')))); setEvidence({ title: `${data.path}:${data.startLine}`, text: data.lines.map(line => `${line.number}  ${line.text}`).join('\n') }) } catch (e) { setEvidence({ title: '证据暂不可用', text: String(e) }) } }
  const selectedNode = detail?.kind === 'node' ? bodyMap.get(detail.id) ?? byId.get(detail.id) : null
  const allPlaced = [...layout.modules, ...layout.children]
  const source = { x: layout.input.x + layout.input.width, y: layout.input.y + 55 }, sink = { x: layout.output.x, y: layout.output.y + 70 }
  const ancestorsRead = layout.modules.filter(node => bodyMap.has(node.id) || bodyCount(node.id))
  const chosen = selectedRead.length + selectedExpand.length

  function nodeCard(node: ModelNode & Bounds, child = false) {
    const exact = bodyMap.has(node.id), descendants = bodyCount(node.id), pendingBody = requestedRead.has(node.id), hasChildren = nodes.some(n => n.id.substring(0, n.id.lastIndexOf('.')) === node.id)
    const readSelected = selectedRead.includes(node.id), expandSelected = selectedExpand.includes(node.id)
    return <div className={`model-node ${child ? 'child-node' : ''} ${exact ? 'body-returned' : ''} ${disclosed.has(node.id) ? 'brief-disclosed' : ''} ${pendingBody || requestedExpand.has(node.id) ? 'is-requested' : ''} ${readSelected || expandSelected ? 'is-selected' : ''} ${fresh.includes(node.id) ? 'fresh-return' : ''}`} key={node.id} data-model-id={node.id} style={{ left: node.x, top: node.y, width: node.width, minHeight: node.height }}>
      <button className="model-main" onClick={() => hasChildren ? openBranch(node.id) : (setEvidence(null), setDetail({ kind: 'node', id: node.id }))} aria-label={hasChildren ? `${expanded.includes(node.id) ? '收起' : '展开'}${node.title}` : `${node.title}详情`} aria-expanded={hasChildren ? expanded.includes(node.id) : undefined} title={node.description}><span className="node-title"><i/ ><strong>{readable(node.title)}</strong>{hasChildren && <span className={expanded.includes(node.id) ? 'rotated' : ''}><Icon name="chevron" size={12}/></span>}</span><span className="node-brief">{node.description}</span></button>
      <div className="node-actions"><span className="node-status">{pendingBody ? '正文请求中' : exact ? '正文已返回' : descendants ? `含 ${descendants} 项正文` : disclosed.has(node.id) ? '简述已披露' : '仅画布可见'}</span>{hasChildren && <button aria-label={`选择${node.title}子层目录`} aria-pressed={expandSelected} className={expandSelected ? 'picked' : ''} onClick={() => toggle(node.id, 'expand')}>{expandSelected ? '✓' : '+'} 子层</button>}<button aria-label={`选择${node.title}正文`} aria-pressed={readSelected} className={readSelected ? 'picked' : ''} onClick={() => toggle(node.id, 'read')}>{readSelected ? '✓' : '+'} 正文</button></div>
      <button className="node-info" aria-label={`${node.title}来源详情`} onClick={() => { setEvidence(null); setDetail({ kind: 'node', id: node.id }) }}><Icon name="info" size={12}/></button>
    </div>
  }

  return <div className="app"><header className="app-header"><div className="brand"><span className="brand-mark"><i/><i/><i/><i/></span>Harness<sup>L3</sup></div><span className="header-divider"/><button className="workspace-button" onClick={() => setDetail({ kind: 'workspace' })}>MGRP <span>/</span><Icon name="branch" size={13}/>{snapshot?.sourceVersion?.branch ?? 'main'}</button><span className="header-section">渐进披露</span><div className="header-right"><select aria-label="当前检索任务" value={task?.id ?? ''} onChange={event => void chooseTask(event.target.value)}><option value="">新的检索</option>{tasks.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select><button className="records-button" aria-label="检索记录" onClick={() => setDetail({ kind: 'records' })}><Icon name="record" size={16}/><span>记录</span></button></div></header>
    <main ref={viewport} className={`canvas-viewport ${canvas.dragging ? 'is-dragging' : ''}`} {...canvas.handlers} aria-label="上下文检索无限画布" style={{ backgroundPosition: `${canvas.camera.x}px ${canvas.camera.y}px`, backgroundSize: `${24 * canvas.camera.scale}px ${24 * canvas.camera.scale}px` }}>
      <div className="task-heading" data-no-pan><div className="eyebrow">CONTEXT <span>/ 渐进披露</span></div><h1>{task ? task.title : '从简述中找到需要的上下文'}</h1><p>{busy ? '正在按所选范围批量读取…' : task?.outdated ? '此任务属于旧快照，原上下文保留；新读取需重新开始。' : '多个分支一起筛选，多个目标一批取回。'}</p><div className="origin-label"><i/>{sourceLabel(task)}</div><div className="mobile-locations"><button onClick={() => canvas.locate(layout.input)}>任务输入</button><button onClick={() => canvas.locate(layout.modules.find(n => expanded.includes(n.id)) ?? layout.modules[0] ?? layout.input)}>模块</button><button onClick={() => canvas.locate(layout.output)}>输出</button></div></div>
      {snapshot && <><div className={`world ${canvas.smooth ? 'camera-smooth' : ''}`} style={{ transform: `translate(${canvas.camera.x}px,${canvas.camera.y}px) scale(${canvas.camera.scale})` }} data-camera-x={canvas.camera.x} data-camera-y={canvas.camera.y} data-camera-scale={canvas.camera.scale}>
        <div className="world-label" style={{ left: 100, top: 53 }}>项目模块 <span>{layout.modules.length} 个顶层 · 展开浏览不自动获取正文</span></div>
        <svg className="world-lines" width="1" height="1" aria-hidden="true">
          {ancestorsRead.map(node => <path key={'input-' + node.id} className="selected-route" d={connection(source, { x: node.x, y: node.y + 32 })}/>)}
          {layout.children.map(node => { const parentNode = allPlaced.find(n => n.id === node.parentId); if (!parentNode) return null; return <path key={node.id} className={bodyMap.has(node.id) ? 'containment returned-route' : 'containment'} d={`M${parentNode.x + parentNode.width / 2},${parentNode.y + parentNode.height} C${parentNode.x + parentNode.width / 2},310 ${node.x + node.width / 2},310 ${node.x + node.width / 2},${node.y}`}/> })}
          {[...bodyMap.keys()].map(id => { const node = allPlaced.find(n => n.id === id) ?? layout.modules.find(n => id.startsWith(n.id + '.')); if (!node) return null; const d = connection({ x: node.x + node.width, y: node.y + 34 }, sink); return <g key={id}><path className={`output-route ${fresh.includes(id) ? 'new-route' : ''}`} d={d}/>{fresh.includes(id) && !canvas.reduced && <circle r="3" className="return-particle"><animateMotion dur=".65s" path={d} fill="freeze"/></circle>}</g> })}
        </svg>
        <section className="input-card" style={{ left: layout.input.x, top: layout.input.y, width: layout.input.width }} aria-label="任务输入"><span className="card-eyebrow">任务输入</span>{task ? <><h2>{task.title}</h2><p>{task.batches.length} 批请求 · {clientLabel(task.client)}创建</p><button onClick={resetTask}>新建检索 <Icon name="plus" size={13}/></button></> : <><textarea aria-label="任务目的" value={purpose} onChange={e => setPurpose(e.target.value)} rows={3} maxLength={500}/><button className="start-button" onClick={start} disabled={busy || !purpose.trim()}>开始检索 <Icon name="arrow" size={13}/></button></>}</section>
        {layout.modules.map(node => nodeCard(node))}
        {layout.branches.map(branch => <div key={branch.id} className="branch-heading" style={{ left: branch.x, top: branch.y }}>{byId.get(branch.id)?.title}<span>{directories.has(branch.id) ? '子层已披露' : '浏览 · 尚未请求子层简述'}</span><button aria-label={`收起${byId.get(branch.id)?.title}分支`} onClick={() => openBranch(branch.id)}><Icon name="close" size={12}/></button></div>)}
        {layout.children.map(node => nodeCard(node, true))}
        <section className={`output-card ${bodyMap.size ? 'has-output' : ''}`} data-output-count={bodyMap.size} style={{ left: layout.output.x, top: layout.output.y, width: layout.output.width }} aria-label="上下文输出"><span className="card-eyebrow"><Icon name="output" size={14}/>上下文输出</span><h2>{bodyMap.size ? `${bodyMap.size} 项正文已就绪` : '等待所选上下文'}</h2><p>{bodyMap.size ? '精确对象、来源、证据与版本。其他模块只保留必要边界引用。' : '选择目录或正文后，批量获取所需内容。'}</p>{bodyMap.size ? <><button className="packet-open" onClick={() => setDetail({ kind: 'packet' })}>查看上下文包 <Icon name="arrow" size={13}/></button><button className="copy-inline" onClick={copyPacket}><Icon name={copied ? 'check' : 'copy'} size={12}/>{copied ? '已复制' : '复制'}</button></> : <small>尚未返回正文</small>}</section>
      </div>
      <div className="canvas-summary" data-no-pan><span>{task?.disclosedIds.length ?? 0} 项简述</span><i/><strong>{bodyMap.size}</strong><span>项正文</span></div>
      <div className="selection-dock" data-no-pan><div className="selection-count"><strong>{chosen || '—'}</strong><span>{selectedExpand.length} 个目录 · {selectedRead.length} 项正文</span></div><button className="clear-selection" onClick={() => { setSelectedRead([]); setSelectedExpand([]) }} disabled={!chosen || busy}>清空</button><button className="retrieve-button" onClick={runBatch} disabled={!chosen || busy || task?.outdated}>{busy ? '读取中…' : '批量获取'}<Icon name="arrow" size={15}/></button><span className="dock-divider"/><button className="preset-button" onClick={preset} disabled={busy} title="使用预设选择执行真实目录与正文读取，不调用AI">示例选择</button></div>
      <div className="zoom-tools" data-no-pan><button aria-label="放大画布" onClick={() => canvas.zoom(1.2)}><Icon name="plus"/></button><span>{Math.round(canvas.camera.scale * 100)}%</span><button aria-label="缩小画布" onClick={() => canvas.zoom(1 / 1.2)}><Icon name="minus"/></button><i/><button aria-label="概览全部内容" onClick={() => canvas.fit(layout.bounds)}><Icon name="fit"/></button><button aria-label="定位上下文输出" onClick={() => canvas.locate(layout.output)}><Icon name="target"/></button></div><div className="canvas-hint">拖动平移 · 滚轮缩放<span>单指平移 · 双指缩放</span></div></>}
      {error && <div className="error-banner" data-no-pan>{error}<button aria-label="关闭提示" onClick={() => setError('')}><Icon name="close" size={13}/></button></div>}
      {snapshot?.modelStatus !== 'valid' && snapshot && <div className="model-warning" data-no-pan>模型待修复，当前为最近有效层级；新读取已停止。</div>}
      {snapshot?.modelStatus === 'valid' && snapshot.source?.status && snapshot.source.status !== 'matched' && <div className="model-warning" data-no-pan>所引证据待核验：{snapshot.source.status}。已有上下文保留返回时的来源状态。</div>}
      {!snapshot && <div className="loading-state">正在读取 LikeC4 模型…</div>}
    </main>
    {detail && <div className="detail-shade" onClick={event => { if (event.target === event.currentTarget) { setDetail(null); setEvidence(null) } }}><aside className={`detail-panel ${detail.kind === 'packet' ? 'packet-panel' : ''}`} ref={dialog} role="dialog" aria-modal="true" aria-labelledby="detail-title" tabIndex={-1}><div className="detail-heading"><span>{detail.kind === 'node' ? '上下文详情' : detail.kind === 'packet' ? '返回给调用方的内容' : detail.kind === 'records' ? '真实请求记录' : '工作区'}</span><button aria-label="关闭详情" onClick={() => { setDetail(null); setEvidence(null) }}><Icon name="close"/></button></div><h2 id="detail-title">{selectedNode?.title ?? (detail.kind === 'packet' ? '上下文包' : detail.kind === 'records' ? '分批获取的上下文' : 'MGRP')}</h2>
      {selectedNode ? <><span className="detail-state">{bodyMap.has(selectedNode.id) ? '正文已返回给本任务调用方' : disclosed.has(selectedNode.id) ? '仅简述已披露' : '仅在画布中浏览，未读取正文'}</span><p className="node-description">{selectedNode.description}</p><dl><dt>对象</dt><dd><code>{selectedNode.id}</code></dd><dt>来源</dt><dd>{meta(selectedNode, 'source')}</dd><dt>状态</dt><dd>{meta(selectedNode, 'status')}</dd><dt>源码引用</dt><dd><code>{meta(selectedNode, 'path')}</code></dd><dt>证据引用</dt><dd><code>{meta(selectedNode, 'evidence')}</code></dd><dt>模型版本</dt><dd><code>{bodyMap.get(selectedNode.id)?.modelRevision.slice(0, 12) ?? snapshot?.revision.slice(0, 12)}</code></dd></dl><button className="detail-action" onClick={() => showEvidence(selectedNode)}>查看源码证据 <Icon name="arrow" size={14}/></button>{evidence && <div className="evidence-excerpt"><strong>{evidence.title}</strong><pre>{evidence.text}</pre></div>}<p className="detail-note">目录简述、完整对象上下文和源码证据分别读取。返回记录说明读取层已为调用方生成响应，不证明模型理解或覆盖其他工具。</p></> : detail.kind === 'packet' ? task && <><span className="detail-state">{bodyMap.size} 项正文 · {task.modelRevision.slice(0, 8)}{task.outdated ? ' · 旧快照' : ''}</span><button className="detail-action" onClick={copyPacket}><Icon name="copy" size={14}/>{copied ? '已复制上下文包' : '复制上下文包'}</button><textarea className="packet-text" aria-label="上下文包原文" value={packetText(task)} readOnly rows={24}/><p className="detail-note">仅包含本任务实际返回的精确对象；目录简述与边界引用不等于额外模块正文。</p></> : detail.kind === 'records' ? <><span className="detail-state">{sourceLabel(task)}</span>{task ? <><div className="records-list">{task.batches.map((batch, i) => <div key={batch.id} className={`batch-record ${batch.status}`}><span>批次 {String(i + 1).padStart(2, '0')}</span><strong>{batch.status === 'complete' ? '完成' : batch.status === 'partial' ? '部分完成' : batch.status === 'requested' ? '请求中' : batch.status === 'unknown' ? '结果未知' : '失败'}</strong><p>{batch.request.expand.length} 个目录 · {batch.request.read.length} 项正文</p><code>{batch.request.expand.concat(batch.request.read).join('\n')}</code><small>{new Date(batch.requestedAt).toLocaleTimeString('zh-CN')} · {batch.result?.durationMs ?? '—'}ms · {batch.client}</small>{batch.result?.errors.map(e => <p className="record-error" key={e.id}>{e.id}: {e.message}</p>)}</div>)}</div><p className="detail-note">任务 {task.id}<br/>worktree {task.worktreeId}<br/>来源由本机调用方声明，未伪装为完整agent日志。多个目标属于同批请求，不按时间先后推导因果。</p></> : <p className="detail-note">开始检索后，真实目录/正文请求会记录在这里。</p>}</> : <><span className="detail-state">真实 LikeC4 模型 · 本机来源</span><dl><dt>分支</dt><dd>{snapshot?.sourceVersion?.branch}</dd><dt>来源路径</dt><dd><code>{snapshot?.runtime.sourceRoot}</code></dd><dt>模型快照</dt><dd><code>{snapshot?.revision}</code></dd><dt>任务归属</dt><dd><code>{task?.worktreeId ?? '尚未创建任务'}</code></dd></dl><p className="detail-note">模型文本保持权威，读取结果与检索批次属于本机运行记录。CLI、网页手动选择和预设示例分开标记，现有agent可直接使用CLI读取简述并自行选择目标。</p></>}
    </aside></div>}
  </div>
}
createRoot(document.getElementById('root')!).render(<App/>)

