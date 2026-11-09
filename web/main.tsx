import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { rpc, session, view, ApiError } from './api'
import { layoutMindmap, type Bounds, type PlacedItem } from './canvas-model'
import { flattenMap, projectContext, type MapItem } from './context-map'
import { useCanvas } from './use-canvas'
import { layoutSkills } from './skill-layout'
import { SkillLane } from './SkillLane'
import { SkillDetails } from './SkillDetails'
import { LegacySkillDetails, LegacyRecords, LegacyPacket } from './LegacyDetails'
import { legacyContext, legacyPlan, legacyViews } from './legacy'
import { HistoryPanel } from './HistoryPanel'
import { StructurePanel } from './StructurePanel'
import { DirectoryPage, parseDirectory, directoryKey, type DirectoryTarget } from './DirectoryPage'
import { Icon } from './Icon'
import { errorMessage, pretty, time, type Binding, type C4View, type HistoryResult, type LegacyArchive, type ProjectRecord, type Rpc, type SkillBrief, type TaskBatch, type TaskRecord, type TaskSummary, type ViewData, type WorktreeRecord } from './types'
import './styles.css'
import './formal.css'

interface Route { worktree: string; task?: string; batch?: string; frozen: boolean; browse?: boolean; listed?: boolean }
type Detail = { kind: 'node'; id: string } | { kind: 'skills'; id?: string; file?: string } | { kind: 'history' | 'records' | 'packet' | 'workspace' | 'structure' }
interface Command { operation: string; options: Parameters<Rpc>[1] }
interface Catalog { root: string | null; revision: string | null; skills: SkillBrief[]; valid: boolean; diagnostics: { message: string }[]; checkedAt: string | null }
const label = (item: MapItem) => item.state === 'aggregate' ? `含 ${item.hits} 项命中` : item.state === 'returned' ? '精确正文已返回' : item.state === 'reference' ? '引用已返回' : item.state === 'associated' ? '随上下文返回' : item.state === 'disclosed' ? '简述' : item.children.length ? '' : '未返回'
function mergeBounds(a: Bounds, b: Bounds): Bounds { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y } }
function initialBounds(roots: MapItem[]) { const context = layoutMindmap(roots, []); return mergeBounds(context.bounds, layoutSkills({ input: context.input, contextFrame: context.frame, contextOutput: context.output, catalog: [], expanded: false }).bounds) }
function batchFields(batch: TaskBatch) { const raw = batch.request as { context?: { expand?: string[]; read?: string[] }; expand?: string[]; read?: string[] }; return raw?.context ?? raw ?? {} }
function recordState(value: unknown): string { if (!value || typeof value !== 'object') return 'unknown'; const record = value as { state?: unknown }; return typeof record.state === 'string' ? record.state : 'unknown' }
function dataResult<T>(value: { result: T }): T { return value.result }
function rememberWorktree(project: string, worktree: string) { try { sessionStorage.setItem('harnessl3:worktree:' + project, worktree) } catch { /* Optional local view state. */ } }

function App() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]), [worktrees, setWorktrees] = useState<WorktreeRecord[]>([]), [project, setProject] = useState('')
  const [route, setRoute] = useState<Route | null>(null), [data, setData] = useState<ViewData | null>(null), [taskList, setTaskList] = useState<TaskSummary[]>([])
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [viewError, setViewError] = useState(''), [connected, setConnected] = useState(false), [offline, setOffline] = useState(!navigator.onLine), [updates, setUpdates] = useState(false)
  const loginError = [error, viewError].find(value => /^(AUTH_REQUIRED|SIGN_IN_RETRY):/.test(value))
  const [expanded, setExpanded] = useState<string[]>([]), [hubOpen, setHubOpen] = useState(false), [folders, setFolders] = useState(new Set<string>()), [skillsOpen, setSkillsOpen] = useState(new Set<string>())
  const [reads, setReads] = useState<string[]>([]), [expands, setExpands] = useState<string[]>([]), [skillChoices, setSkillChoices] = useState(new Map<string, string>()), [refreshing, setRefreshing] = useState(false), [liveCatalog, setLiveCatalog] = useState<Catalog | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null), [copied, setCopied] = useState(false), [fresh, setFresh] = useState<string[]>([]), [freshBatch, setFreshBatch] = useState(''), [retry, setRetry] = useState<Command | null>(null)
  const [directory, setDirectory] = useState<DirectoryTarget | null>(() => parseDirectory(new URL(location.href).searchParams.get('directory')))
  const initialDirectory = useRef(directory), directoryTrigger = useRef<HTMLElement | null>(null)
  const [batchOptions, setBatchOptions] = useState<{ task: string; batches: { id: string; createdAt?: string }[] }>({ task: '', batches: [] })
  const viewport = useRef<HTMLDivElement>(null), dialog = useRef<HTMLElement>(null), restoreFocus = useRef<HTMLElement | null>(null)
  const routeRef = useRef<Route | null>(null), generation = useRef(0), loadCounter = useRef(0), abort = useRef<AbortController | null>(null), lastSeq = useRef(new Map<string, number>()), latestBatch = useRef({ task: '', batch: '' }), tasksRef = useRef<TaskSummary[]>([])
  const pendingView = useRef<{ token: number; wantedSeq: number; dirty: boolean; promise: Promise<void> } | null>(null)
  const pendingTasks = useRef<{ token: number; worktree: string; wantedSeq: number; promise: Promise<TaskSummary[]> } | null>(null)
  const taskListSeq = useRef(new Map<string, number>())
  const anchor = useRef<{ id: string; x: number; y: number } | null>(null), skillAnchor = useRef<{ id: string; x: number; y: number } | null>(null)
  const task = data?.task ?? null, legacy = data?.legacy ?? null, historical = !!route?.frozen || !!legacy, unavailable = !!task?.closedAt || !!task && Date.now() > Date.parse(task.expiresAt)
  const displayedId = task?.id ?? legacy?.taskId, displayedTitle = task?.title ?? legacy?.record.title, displayedBatches = task?.batches.length ?? legacy?.record.batches?.length ?? 0
  const plan = useMemo(() => task?.skillPlan ?? (legacy ? legacyPlan(legacy) : null), [task?.skillPlan, legacy])
  const readonly = historical || unavailable || !data?.worktree.active || !data?.worktree.available
  const canRefresh = !historical && !unavailable && !!data?.worktree.active && !!data?.worktree.available
  const catalog = !historical && !unavailable && !task?.skillPlan && liveCatalog ? liveCatalog : data?.catalog
  const availableSkills = legacy ? [] : task?.skillPlan ? task.catalog : catalog?.skills ?? []
  const roots = useMemo(() => legacy ? legacyContext(legacy) : projectContext(data?.model ?? null, task, data), [data])
  const all = useMemo(() => flattenMap(roots), [roots]), byId = useMemo(() => new Map(all.map(item => [item.id, item])), [all])
  const layout = useMemo(() => layoutMindmap(roots, expanded), [roots, expanded])
  const skillLayout = useMemo(() => layoutSkills({ input: layout.input, contextFrame: layout.frame, contextOutput: layout.output, catalog: availableSkills, plan, expanded: hubOpen, expandedFolders: folders, expandedSkills: skillsOpen }), [layout, availableSkills, plan, hubOpen, folders, skillsOpen])
  const canvas = useCanvas(viewport, mergeBounds(layout.bounds, skillLayout.bounds), !!data)
  const bodies = useMemo(() => new Map(task?.packet.contexts.map(body => [body.entity.id, body]) ?? []), [task])
  const bodyTexts = useMemo(() => new Map(legacy ? (legacy.record.packet?.contexts ?? []).map(body => [body.id, body.description]) : [...bodies].map(([id, body]) => [id, body.entity.description])), [legacy, bodies])
  const selected = detail?.kind === 'node' ? byId.get(detail.id) : null
  const selectedCount = reads.length + expands.length + skillChoices.size
  const showDock = selectedCount > 0 || !!task && !task.skillPlan && !readonly
  const packet = task ? pretty({ taskId: task.id, binding: task.binding, packet: task.packet, skillPlan: task.skillPlan }) : legacy ? pretty(legacy) : ''

  const chooseRoute = useCallback((next: Route) => {
    setDirectory(null)
    if (routeRef.current?.worktree !== next.worktree) { tasksRef.current = []; setTaskList([]); setBatchOptions({ task: '', batches: [] }); latestBatch.current = { task: '', batch: '' } }
    ++generation.current; ++loadCounter.current; abort.current?.abort(); routeRef.current = next
    if (next.task) { try { sessionStorage.setItem('harnessl3:view:' + next.worktree, JSON.stringify({ task: next.task, batch: next.batch, frozen: next.frozen })) } catch { /* Browsing works without session storage. */ } }
    setData(null); setLoading(true); setLiveCatalog(null); setRoute(next); setExpanded([]); setHubOpen(false); setFolders(new Set()); setSkillsOpen(new Set()); setReads([]); setExpands([]); setSkillChoices(new Map()); setDetail(null); setFresh([]); setUpdates(false); setError(''); setViewError(''); setRetry(null); setBusy(false); setRefreshing(false)
    const url = new URL(location.href); url.hash = ''; url.searchParams.set('worktree', next.worktree); url.searchParams.delete('directory')
    if (!next.task && !next.browse) url.searchParams.set('overview', '1'); else url.searchParams.delete('overview')
    for (const name of ['task', 'batch']) { const value = next[name as 'task' | 'batch']; if (value) url.searchParams.set(name, value); else url.searchParams.delete(name) }
    if (next.frozen) url.searchParams.set('history', '1'); else url.searchParams.delete('history')
    history.replaceState(null, '', url.pathname + url.search)
  }, [])
  const loadTasks = useCallback((worktree: string, chooseNew = false, eventSeq = 0): Promise<TaskSummary[]> => {
    const token = generation.current
    const pending = pendingTasks.current
    if (pending?.token === token && pending.worktree === worktree) { pending.wantedSeq = Math.max(pending.wantedSeq, eventSeq); return pending.promise }
    const flight = { token, worktree, wantedSeq: eventSeq, promise: Promise.resolve([] as TaskSummary[]) }
    pendingTasks.current = flight
    flight.promise = (async () => {
      let result: HistoryResult
      do {
        const requestedSeq = flight.wantedSeq
        result = dataResult(await rpc<{ result: HistoryResult }>('task list', { worktree, flags: { limit: '50' } }))
        if (token !== generation.current || routeRef.current?.worktree !== worktree) return []
        if (flight.wantedSeq <= (result.seq ?? requestedSeq)) break
      } while (true)
      const before = new Set(tasksRef.current.map(item => item.id))
      if (result.seq !== undefined) taskListSeq.current.set(worktree, result.seq)
      tasksRef.current = result.items; setTaskList(result.items)
      const active = routeRef.current
      if (chooseNew && active && !active.task && !active.frozen && result.items[0] && !before.has(result.items[0].id)) chooseRoute({ worktree, task: result.items[0].id, frozen: false })
      return result.items
    })().finally(() => { if (pendingTasks.current === flight) pendingTasks.current = null })
    return flight.promise
  }, [chooseRoute])
  const loadView = useCallback((target = routeRef.current, eventSeq?: number): Promise<void> => {
    if (!target) return Promise.resolve()
    const token = generation.current
    const pending = pendingView.current
    if (pending?.token === token) { if (eventSeq === undefined) pending.dirty = true; else pending.wantedSeq = Math.max(pending.wantedSeq, eventSeq); return pending.promise }
    const sequence = ++loadCounter.current
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller
    setLoading(true)
    const flight = { token, wantedSeq: eventSeq ?? 0, dirty: false, promise: Promise.resolve() }
    pendingView.current = flight
    flight.promise = (async () => {
      do {
        flight.dirty = false
        try {
          const result = await view(target.worktree, target.task, target.batch, controller.signal)
          if (token !== generation.current || sequence !== loadCounter.current || result.target.worktreeId !== target.worktree) return
          if (result.legacy && !target.frozen) { chooseRoute({ ...target, frozen: true }); return }
          setData(result); setLoading(false); setViewError(''); lastSeq.current.set(target.worktree, Math.max(lastSeq.current.get(target.worktree) ?? 0, result.seq))
          if (target.frozen) setUpdates(flight.wantedSeq > result.seq)
          else if (flight.wantedSeq > result.seq) flight.dirty = true
          if (result.task) {
            const key = `${target.worktree}:${result.task.id}`, latest = result.task.batches.at(-1)
            if (!target.frozen && latestBatch.current.task === key && latest && latest.id !== latestBatch.current.batch) { setFresh([...(latest.result?.contexts.map(body => body.entity.id) ?? []), ...(latest.result?.directories.flatMap(directory => directory.items.map(item => item.id)) ?? [])]); setFreshBatch(latest.id) }
            latestBatch.current = { task: key, batch: latest?.id ?? '' }
            if (!target.batch) setBatchOptions({ task: result.task.id, batches: result.task.batches })
            else if (result.task.id !== batchOptions.task) {
              setBatchOptions({ task: result.task.id, batches: result.task.batches })
              void rpc<{ result: { task: TaskRecord } }>('task show', { id: result.task.id, worktree: target.worktree }).then(response => { if (generation.current === token) setBatchOptions({ task: result.task!.id, batches: response.result.task.batches }) }).catch(error => { if (generation.current === token) setViewError(errorMessage(error)) })
            }
          } else if (result.legacy) {
            const archive = result.legacy
            const options = (value: LegacyArchive) => ({ task: value.taskId, batches: (value.record.batches ?? []).map(batch => ({ id: batch.id, createdAt: batch.requestedAt ?? batch.completedAt })) })
            if (!target.batch) setBatchOptions(options(archive))
            else if (archive.taskId !== batchOptions.task) {
              setBatchOptions(options(archive))
              void rpc<LegacyArchive>('task show', { id: archive.taskId, worktree: target.worktree }).then(value => { if (token === generation.current) setBatchOptions(options(value)) }).catch(error => { if (token === generation.current) setViewError(errorMessage(error)) })
            }
          }
        } catch (error) { if (!controller.signal.aborted && token === generation.current && sequence === loadCounter.current) setViewError(errorMessage(error)) }
      } while (flight.dirty && token === generation.current && !controller.signal.aborted)
    })().finally(() => {
      if (pendingView.current === flight) pendingView.current = null
      if (token === generation.current && sequence === loadCounter.current) setLoading(false)
    })
    return flight.promise
  }, [batchOptions.task, chooseRoute])

  useEffect(() => {
    const signInLink = () => { if (new URLSearchParams(location.hash.slice(1)).has('code')) location.reload() }
    window.addEventListener('hashchange', signInLink)
    return () => window.removeEventListener('hashchange', signInLink)
  }, [])
  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const initial = await session()
        const [projectResult, worktreeResult] = await Promise.all([rpc<{ result: { items: ProjectRecord[] } }>('project list'), rpc<{ result: { items: WorktreeRecord[] } }>('worktree list')])
        if (!live) return
        setProjects(projectResult.result.items); setWorktrees(worktreeResult.result.items)
        const chosen = initial.worktree ? worktreeResult.result.items.find(item => item.id === initial.worktree) : worktreeResult.result.items.find(item => item.active && item.available) ?? worktreeResult.result.items[0]
        if (initial.worktree && !chosen) throw new Error('工作区未登记')
        if (chosen) { rememberWorktree(chosen.projectId, chosen.id); setProject(chosen.projectId); chooseRoute({ worktree: chosen.id, task: initial.task, batch: initial.batch, frozen: !!initial.batch || new URL(location.href).searchParams.get('history') === '1', browse: !initial.task && !initialDirectory.current && new URL(location.href).searchParams.get('overview') !== '1' }); if (initialDirectory.current) { const target = initialDirectory.current; initialDirectory.current = null; openDirectory(target, true) } }
        else setLoading(false)
      } catch (error) { if (live) { setError(errorMessage(error)); setLoading(false) } }
    })()
    return () => { live = false; abort.current?.abort() }
  }, [chooseRoute])
  useEffect(() => {
    const pop = () => {
      const url = new URL(location.href), worktree = url.searchParams.get('worktree'), current = routeRef.current
      if (worktree && current && (worktree !== current.worktree || (url.searchParams.get('task') || undefined) !== current.task || (url.searchParams.get('batch') || undefined) !== current.batch)) { setProject(worktrees.find(item => item.id === worktree)?.projectId ?? ''); chooseRoute({ worktree, task: url.searchParams.get('task') || undefined, batch: url.searchParams.get('batch') || undefined, frozen: url.searchParams.get('history') === '1' }); history.replaceState(null, '', url.pathname + url.search) }
      const next = parseDirectory(url.searchParams.get('directory')); setDirectory(next); setDetail(null)
      if (!next) requestAnimationFrame(() => directoryTrigger.current?.focus({ preventScroll: true }))
    }
    window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop)
  }, [chooseRoute, worktrees])
  useEffect(() => {
    if (!route) return
    const token = generation.current
    if (!route.browse) void loadView(route)
    if (route.listed) return
    void loadTasks(route.worktree).then(async items => {
      if (!route.browse || token !== generation.current) return
      let remembered: Partial<Route> = {}
      try { const value = JSON.parse(sessionStorage.getItem('harnessl3:view:' + route.worktree) ?? '{}'); if (value && typeof value === 'object') remembered = value } catch { /* Use the latest recorded task. */ }
      let selected = items.find(item => item.id === remembered.task)
      if (!selected && typeof remembered.task === 'string' && remembered.task) {
        // Search the visible history by ID; a remembered task can be beyond page one.
        let offset = 0
        while (true) {
          const result = dataResult(await rpc<{ result: HistoryResult }>('history list', { worktree: route.worktree, flags: { query: remembered.task, limit: '50', offset: String(offset) } }))
          if (token !== generation.current) return
          selected = result.items.find(item => item.id === remembered.task)
          if (selected || !result.hasMore || !result.items.length) break
          offset += result.items.length
        }
      }
      selected ??= items[0]
      const resume = selected?.id === remembered.task
      chooseRoute({ worktree: route.worktree, task: selected?.id, batch: resume && typeof remembered.batch === 'string' ? remembered.batch : undefined, frozen: !!selected, browse: false, listed: true })
    }).catch(error => { if (token === generation.current) { setViewError(errorMessage(error)); setLoading(false) } })
  }, [route])
  useEffect(() => {
    if (!route?.worktree || route.browse) return
    const worktree = route.worktree
    let timer: ReturnType<typeof setTimeout> | undefined
    const stream = new EventSource('/events?' + new URLSearchParams({ worktree, after: String(lastSeq.current.get(worktree) ?? 0) }))
    let wantedSeq = 0, tasksChanged = false
    const refresh = (seq: number, kind?: string) => {
      if (kind === 'freshness' && routeRef.current?.task) return
      wantedSeq = Math.max(wantedSeq, seq); tasksChanged ||= !kind || kind === 'task' || kind === 'migration'
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (routeRef.current?.worktree !== worktree) return
        if (routeRef.current.frozen) {
          const pending = pendingView.current
          if (pending?.token === generation.current) pending.wantedSeq = Math.max(pending.wantedSeq, wantedSeq)
          else if (wantedSeq > (lastSeq.current.get(worktree) ?? 0)) setUpdates(true)
        }
        else {
          if (wantedSeq > (lastSeq.current.get(worktree) ?? 0)) void loadView(undefined, wantedSeq)
          if (tasksChanged && wantedSeq > (taskListSeq.current.get(worktree) ?? -1)) void loadTasks(worktree, true, wantedSeq).catch(error => { if (routeRef.current?.worktree === worktree) setViewError(errorMessage(error)) })
        }
        tasksChanged = false
      }, 100)
    }
    const commit = (event: MessageEvent) => {
      try { const message = JSON.parse(event.data) as { worktreeId?: string; seq: number; kind?: string }; if (message.worktreeId && message.worktreeId !== worktree || routeRef.current?.worktree !== worktree || !Number.isSafeInteger(message.seq) || message.seq <= (lastSeq.current.get(worktree) ?? 0)) return; refresh(message.seq, message.kind) } catch { setViewError('连接异常，请重试') }
    }
    stream.addEventListener('commit', commit as EventListener)
    stream.addEventListener('ready', () => setConnected(true))
    stream.addEventListener('reset', event => { setConnected(true); commit(event as MessageEvent) })
    stream.onopen = () => setConnected(true)
    stream.onerror = () => setConnected(false)
    return () => { stream.close(); if (timer) clearTimeout(timer); setConnected(false) }
  }, [route?.worktree, route?.browse, loadTasks, loadView])
  useEffect(() => {
    if (!route || !canRefresh || legacy || task?.skillPlan) return
    const worktree = route.worktree, token = generation.current
    let active = true, scanning = false
    const scan = async () => {
      if (scanning || !navigator.onLine) return
      scanning = true
      try { const result = await rpc<{ result: Catalog }>('skills list', { worktree }); if (active && token === generation.current) setLiveCatalog(result.result) }
      catch (error) { if (active && token === generation.current) setViewError(errorMessage(error)) }
      finally { scanning = false }
    }
    void scan(); const timer = setInterval(() => void scan(), 2500)
    return () => { active = false; clearInterval(timer) }
  }, [route?.worktree, route?.task, canRefresh, task?.skillPlan?.id, !!legacy])
  useEffect(() => { const online = () => { setOffline(false); if (routeRef.current?.frozen) setUpdates(true); else void loadView() }, offline = () => setOffline(true); window.addEventListener('online', online); window.addEventListener('offline', offline); return () => { window.removeEventListener('online', online); window.removeEventListener('offline', offline) } }, [loadView])
  useEffect(() => { if (!fresh.length) return; const timer = setTimeout(() => setFresh([]), 1100); return () => clearTimeout(timer) }, [freshBatch])
  useLayoutEffect(() => { const before = anchor.current; if (!before) return; anchor.current = null; const after = layout.nodes.find(item => item.id === before.id); if (after) canvas.preserve(before, after) }, [layout])
  useLayoutEffect(() => { const before = skillAnchor.current; if (!before) return; skillAnchor.current = null; const after = before.id === 'skill-selector' ? skillLayout.selector : skillLayout.nodes.find(item => item.id === before.id); if (after) canvas.preserve(before, after) }, [skillLayout])
  useEffect(() => {
    if (!detail) return
    restoreFocus.current = document.activeElement as HTMLElement; dialog.current?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDetail(null)
      if (event.key !== 'Tab' || !dialog.current) return
      const items = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')], first = items[0], last = items.at(-1)
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); if (restoreFocus.current?.isConnected) restoreFocus.current.focus({ preventScroll: true }) }
  }, [detail?.kind])

  function chooseProject(id: string) {
    setProject(id)
    let remembered: string | null = null
    try { remembered = sessionStorage.getItem('harnessl3:worktree:' + id) } catch { /* Choose an available worktree. */ }
    const next = worktrees.find(item => item.projectId === id && item.id === remembered) ?? worktrees.find(item => item.projectId === id && item.active && item.available) ?? worktrees.find(item => item.projectId === id)
    if (next) { rememberWorktree(id, next.id); chooseRoute({ worktree: next.id, frozen: false, browse: true }) }
  }
  function openDirectory(target: DirectoryTarget, replace = false) {
    directoryTrigger.current = document.activeElement as HTMLElement
    const url = new URL(location.href); url.searchParams.set('directory', directoryKey(target))
    history[replace ? 'replaceState' : 'pushState']({ directoryPage: !replace }, '', url.pathname + url.search)
    setDetail(null); setDirectory(target)
  }
  function closeDirectory() {
    if (history.state?.directoryPage) { history.back(); return }
    const url = new URL(location.href); url.searchParams.delete('directory'); history.replaceState(null, '', url.pathname + url.search); setDirectory(null)
    requestAnimationFrame(() => directoryTrigger.current?.focus({ preventScroll: true }))
  }
  function inspectSkill(id?: string, file?: string) { if (!id && !plan) openDirectory({ kind: 'skills' }); else setDetail({ kind: 'skills', id, file }) }
  function chooseTask(id: string, frozen = true, batch?: string) { if (route) chooseRoute({ worktree: route.worktree, task: id || undefined, batch, frozen: !!id && frozen, listed: true }) }
  function toggle(id: string, kind: 'read' | 'expand') { if (readonly || !task) return; const setter = kind === 'read' ? setReads : setExpands; setter(value => value.includes(id) ? value.filter(item => item !== id) : [...value, id]) }
  function expand(item: PlacedItem) { anchor.current = { id: item.id, x: item.x, y: item.y }; setExpanded(value => value.includes(item.id) ? value.filter(id => id !== item.id) : [...value, item.id]) }
  function toggleHub() { skillAnchor.current = { id: 'skill-selector', ...skillLayout.selector }; setHubOpen(value => !value) }
  function toggleFolder(group: string) { const item = skillLayout.nodes.find(node => node.kind === 'folder' && node.group === group); if (item) skillAnchor.current = { id: item.id, x: item.x, y: item.y }; setFolders(value => { const next = new Set(value); if (next.has(group)) next.delete(group); else next.add(group); return next }) }
  function toggleSkill(id: string) { const item = skillLayout.nodes.find(node => node.skillId === id && node.kind !== 'file'); if (item) skillAnchor.current = { id: item.id, x: item.x, y: item.y }; setSkillsOpen(value => { const next = new Set(value); if (next.has(id)) next.delete(id); else next.add(id); return next }) }
  function chooseSkill(id: string, reason: string | null) { setSkillChoices(value => { const next = new Map(value); if (reason === null) next.delete(id); else next.set(id, reason); return next }) }
  async function command(pending: Command, token: number): Promise<unknown> {
    if (token === generation.current) setRetry(pending)
    const result = await rpc(pending.operation, pending.options)
    if (token === generation.current) setRetry(null)
    return result
  }
  async function runBatch() {
    if (!route || !task || readonly) return
    if ([...skillChoices.values()].some(reason => !reason.trim())) { setDetail({ kind: 'skills' }); setError('请填写每项技能的选择理由。'); return }
    setBusy(true); setError(''); const token = generation.current
    try {
      let binding: Binding = task.binding
      if (!task.skillPlan && liveCatalog?.revision && liveCatalog.revision !== binding.catalogRevision) binding = (await rpc<{ binding: Binding }>('task prompt', { id: task.id, worktree: route.worktree })).binding
      const requestId = crypto.randomUUID(), context = { expand: expands, read: reads, known: Object.fromEntries([...bodies].map(([id, body]) => [id, body.contentHash])) }
      const pending: Command = task.skillPlan ? { operation: 'context query', options: { id: task.id, worktree: route.worktree, input: { schemaVersion: 1, requestId, expectedModelRevision: binding.modelRevision, ...context } } } : { operation: 'task select', options: { id: task.id, worktree: route.worktree, input: { schemaVersion: 1, requestId, binding, context, skills: [...skillChoices].map(([id, reason]) => ({ id, reason: reason.trim() })) } } }
      const result = await command(pending, token) as { result: { errors: { operation: string; id: string }[] } }
      if (token !== generation.current) return
      setReads(result.result.errors.filter(item => item.operation === 'read').map(item => item.id)); setExpands(result.result.errors.filter(item => item.operation === 'expand').map(item => item.id)); setSkillChoices(new Map())
      await loadView(); await loadTasks(route.worktree)
      if (result.result.errors.length) setError(`部分内容已返回，${result.result.errors.length} 项请求失败`)
    } catch (error) { if (token === generation.current) { setError(errorMessage(error)); void loadView() } }
    finally { if (token === generation.current) setBusy(false) }
  }
  async function retryCommand() {
    if (!retry || busy) return
    const original = retry, token = generation.current
    setBusy(true); setError('')
    try {
      const result = await command(original, token) as { result?: { errors: { operation: string; id: string }[] } }
      if (token !== generation.current) return
      if (['task select', 'context query'].includes(original.operation) && result.result) {
        setReads(result.result.errors.filter(item => item.operation === 'read').map(item => item.id)); setExpands(result.result.errors.filter(item => item.operation === 'expand').map(item => item.id)); setSkillChoices(new Map())
        if (result.result.errors.length) setError(`部分内容已返回，${result.result.errors.length} 项请求失败`)
      }
      await loadView(); if (route) await loadTasks(route.worktree)
    }
    catch (error) { if (token === generation.current) setError(errorMessage(error)) }
    finally { if (token === generation.current) setBusy(false) }
  }
  async function refreshSkills() {
    if (!route || !canRefresh) return
    setRefreshing(true); const token = generation.current
    try { const result = await rpc<{ result: Catalog }>('skills refresh', { worktree: route.worktree }); if (token === generation.current) { setLiveCatalog(result.result); if (task && !task.skillPlan) await rpc('task prompt', { id: task.id, worktree: route.worktree }); await loadView() } }
    catch (error) { if (token === generation.current) setError(errorMessage(error)) }
    finally { if (token === generation.current) setRefreshing(false) }
  }
  async function copyPacket() { try { await navigator.clipboard.writeText(packet); setCopied(true); setTimeout(() => setCopied(false), 1400) } catch { setError('无法访问剪贴板，可在详情中手动复制原文。') } }
  const freshFor = (ids: string[]) => ids.some(id => fresh.includes(id))
  const entityReturned = (item: MapItem) => !!(item.entityId ?? item.objectId) && bodyTexts.has((item.entityId ?? item.objectId)!)
  function nodeCard(item: PlacedItem) {
    if (item.kind === 'overflow') return <button key={item.id} className="map-node overflow-node" style={{ left: item.x, top: item.y, width: item.width, height: item.height }} data-node-overflow={item.overflowFor} aria-label={`查看${byId.get(item.overflowFor!)?.title ?? '上下文'}全部节点`} onClick={() => openDirectory({ kind: 'context', id: item.overflowFor! })}><strong>…</strong><span>{item.brief}</span><span aria-hidden="true">↗</span></button>
    const detailId = item.bodyFor ?? item.id
    const open = expanded.includes(item.id), picked = !!item.entityId && (reads.includes(item.entityId) || expands.includes(item.entityId))
    return <div key={item.id} className={`map-node ${item.kind === 'category' ? 'category-node' : ''} ${item.hit ? 'is-hit' : ''} ${entityReturned(item) ? 'body-returned' : ''} ${picked ? 'is-selected' : ''} ${freshFor(item.relatedIds) ? 'fresh-return' : ''}`} style={{ left: item.x, top: item.y, width: item.width, height: item.height }} data-node-id={item.id} data-category-root={item.kind === 'category' ? item.category : undefined} data-map-depth={item.depth} data-node-state={item.state} data-state={item.state} data-hit-count={item.hits}>
      <button className="map-main" aria-label={item.children.length ? `${open ? '收起' : '展开'}${item.title}` : `查看${item.title}`} aria-expanded={item.children.length ? open : undefined} onClick={() => item.children.length ? expand(item) : setDetail({ kind: 'node', id: detailId })}><span className="map-title"><i/><strong>{item.title}</strong>{!!item.children.length && <span className={open ? 'rotated' : ''}><Icon name="chevron" size={13}/></span>}</span>{item.kind !== 'category' && item.brief && <span className="map-brief">{item.brief}</span>}{item.kind !== 'category' && label(item) && <span className="map-state">{label(item)}</span>}</button>
      {item.kind === 'category' && <span className="map-count">{item.hits ? `${item.hits} 项` : `${item.children.length} 组`}</span>}
      {item.kind !== 'category' && <div className="map-tools"><button aria-label={`查看${item.title}详情`} onClick={() => setDetail({ kind: 'node', id: detailId })}><Icon name="info" size={12}/></button>{item.entityId && <><button disabled={readonly || !task || busy} className={reads.includes(item.entityId) ? 'picked' : ''} aria-label={`${reads.includes(item.entityId) ? '移除' : '选择'}${item.title}正文`} onClick={() => toggle(item.entityId!, 'read')}>正文</button>{item.kind === 'object' && <button disabled={readonly || !task || busy} className={expands.includes(item.entityId) ? 'picked' : ''} aria-label={`${expands.includes(item.entityId) ? '移除' : '选择'}${item.title}目录`} onClick={() => toggle(item.entityId!, 'expand')}>目录</button>}</>}</div>}
    </div>
  }
  const libraryStatus = { root: historical || plan ? '归档' : catalog?.root ?? undefined, revision: legacy?.binding.catalogRevision ?? catalog?.revision ?? undefined, checkedAt: catalog?.checkedAt ?? undefined, error: !legacy && catalog && !catalog.valid ? catalog.diagnostics.map(item => item.message).join('; ') || '目录无效' : null, archived: historical || !!plan }
  const freshness = recordState(data?.freshness)
  const detailTitle = detail?.kind === 'node' ? selected?.title ?? '上下文详情' : detail?.kind === 'skills' ? '技能方案' : detail?.kind === 'history' ? '历史任务' : detail?.kind === 'structure' ? '项目结构' : detail?.kind === 'packet' ? '上下文包' : detail?.kind === 'records' ? '真实请求记录' : '工作区'
  return <div className="app" data-testid="app-shell" data-route-worktree={route?.worktree ?? ''} data-historical={historical} data-task-id={displayedId ?? ''} data-view-seq={data?.seq ?? 0} data-format={legacy ? 'prototype-v0.16' : 'v1'}>
    <header className="app-header"><div className="brand"><span className="brand-mark"><i/><i/><i/><i/></span>Harness<sup>L3</sup></div><div className="target-selectors"><select data-testid="project-select" aria-label="选择项目" value={project} disabled={!projects.length} onChange={event => chooseProject(event.target.value)}>{!projects.length && <option value="">尚无项目</option>}{projects.map(item => <option key={item.id} value={item.id}>{item.name}{item.active ? '' : ' · 已停用'}</option>)}</select><select data-testid="worktree-select" aria-label="选择工作区" value={route?.worktree ?? ''} disabled={!worktrees.length} onChange={event => { const item = worktrees.find(item => item.id === event.target.value); if (item) { rememberWorktree(item.projectId, item.id); setProject(item.projectId); chooseRoute({ worktree: item.id, frozen: false, browse: true }) } }}>{!worktrees.length && <option value="">尚无工作区</option>}{worktrees.filter(item => item.projectId === project).map(item => <option key={item.id} value={item.id}>{item.branch || 'detached'} · {item.root.split(/[\\/]/).at(-1)}{item.active && item.available ? '' : ' · 仅历史'}</option>)}</select></div><div className="header-right"><select className="task-select" aria-label="选择任务" value={route?.task ?? ''} disabled={!route} onChange={event => chooseTask(event.target.value, false)}><option value="">当前工作区</option>{displayedId && !taskList.some(item => item.id === displayedId) && <option value={displayedId}>{displayedTitle}</option>}{taskList.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select><button className="structure-button" aria-label="项目结构" onClick={() => setDetail({ kind: 'structure' })} disabled={!data}><Icon name="branch"/><span>结构</span></button><button className="history-button" aria-label="历史任务" onClick={() => setDetail({ kind: 'history' })} disabled={!route}><Icon name="history"/><span>历史</span></button><button className="records-button" aria-label="检索记录" onClick={() => setDetail({ kind: 'records' })} disabled={!data}><Icon name="record"/><span>记录</span></button></div></header>
    <div className="workspace-content">
    <main ref={viewport} className={`canvas-viewport ${canvas.dragging ? 'is-dragging' : ''}`} {...canvas.handlers} inert={!!directory || !!loginError} aria-hidden={directory || loginError ? true : undefined} aria-label="上下文检索无限画布" aria-busy={loading} data-view-ready={!!data} style={{ visibility: directory || loginError ? 'hidden' : undefined, backgroundPosition: `${canvas.camera.x}px ${canvas.camera.y}px`, backgroundSize: `${24 * canvas.camera.scale}px ${24 * canvas.camera.scale}px` }}>
      <div className="task-heading" data-no-pan>
        <h1>{displayedTitle || '当前工作区'}</h1>
        <div className="origin-label"><span data-testid="connection-status" data-state={offline ? 'offline' : connected ? 'connected' : 'connecting'} className={!connected || offline ? 'connection-gap' : ''} role="status">{offline ? '离线' : connected ? '已连接' : '连接中…'}</span><button onClick={() => setDetail({ kind: 'workspace' })}>工作区详情</button></div>
        {historical && <div className="history-indicator" data-testid="history-fixed">历史 · {displayedBatches} 批<select aria-label="恢复到指定批次" value={route?.batch ?? ''} onChange={event => route?.task && chooseTask(route.task, true, event.target.value || undefined)}><option value="">全部批次</option>{batchOptions.task === displayedId && batchOptions.batches.map((batch, index) => <option key={batch.id} value={batch.id}>批次 {index + 1} · {time(batch.createdAt)}</option>)}</select>{updates && <span data-testid="history-update">有更新</span>}</div>}
        {unavailable && !task?.closedAt && !historical && <div className="legacy-note">已过期</div>}
        <div className="mobile-locations"><button onClick={() => canvas.locate(layout.input)}>输入</button><button onClick={() => canvas.locate(layout.nodes[0] ?? layout.input)}>五类</button><button onClick={() => canvas.locate(layout.output)}>输出</button><button onClick={() => canvas.locate(skillLayout.selector)}>技能</button></div>
      </div>
      <div className={`world ${canvas.smooth ? 'camera-smooth' : ''}`} style={{ transform: `translate(${canvas.camera.x}px,${canvas.camera.y}px) scale(${canvas.camera.scale})` }} data-camera-x={canvas.camera.x} data-camera-y={canvas.camera.y} data-camera-scale={canvas.camera.scale}>
        <div className="context-region" style={{ left: layout.frame.x, top: layout.frame.y, width: layout.frame.width, height: layout.frame.height }}><span>本次上下文 </span></div>
        <svg className="world-lines" width="1" height="1" aria-hidden="true">{layout.edges.map(edge => <g key={edge.source + '>' + edge.target}><path data-edge-kind={edge.kind} data-edge-source={edge.source} data-edge-target={edge.target} className={`map-edge ${edge.hit ? 'is-hit' : ''} ${edge.hit && freshFor(edge.relatedIds) ? 'new-route' : ''}`} d={edge.d}/>{edge.hit && freshFor(edge.relatedIds) && !canvas.reduced && <circle r="2.6" className="return-particle"><animateMotion dur=".75s" path={edge.d} fill="freeze"/></circle>}</g>)}</svg>
        <section className="input-card" style={{ left: layout.input.x, top: layout.input.y, width: layout.input.width, height: layout.input.height }} aria-label="任务输入"><span className="card-eyebrow">任务输入</span>{displayedId ? <><h2>{displayedTitle}</h2><p>{displayedBatches} 批请求 · {legacy ? '原型' : task?.source === 'web' ? '网页' : 'CLI'}创建</p></> : <h2>未选择任务</h2>}</section>
        {layout.nodes.map(nodeCard)}
        <SkillLane layout={skillLayout} plan={plan} unavailable={!!legacy && !plan} expanded={hubOpen} onToggle={toggleHub} expandedFolders={folders} onToggleFolder={toggleFolder} expandedSkills={skillsOpen} onToggleSkill={toggleSkill} onInspect={inspectSkill} onBrowse={group => openDirectory({ kind: 'skills', group })} onRefresh={canRefresh && route ? () => void refreshSkills() : undefined} refreshing={refreshing} libraryStatus={libraryStatus}/>
        <section className={`output-card ${bodyTexts.size ? 'has-output' : ''}`} data-output-count={bodyTexts.size} style={{ left: layout.output.x, top: layout.output.y, width: layout.output.width, height: layout.output.height }} aria-label="上下文输出"><span className="card-eyebrow"><Icon name="output" size={14}/>上下文输出</span><h2>{bodyTexts.size ? `${bodyTexts.size} 项正文已就绪` : '等待所选上下文'}</h2>{displayedId ? <><button className="packet-open" onClick={() => setDetail({ kind: 'packet' })}>查看上下文包 <Icon name="arrow" size={13}/></button><button className="copy-inline" onClick={() => void copyPacket()}><Icon name={copied ? 'check' : 'copy'} size={12}/>{copied ? '已复制' : '复制'}</button></> : <small>尚未返回正文</small>}</section>
      </div>
      <div className="canvas-summary" data-no-pan><strong>{bodyTexts.size}</strong><span>项精确正文</span></div>
      {showDock && <div className={`selection-dock ${selectedCount ? 'has-selection' : ''}`} data-no-pan>{selectedCount ? <><div className="selection-count"><strong>{selectedCount}</strong><span>{expands.length} 个目录 · {reads.length} 项正文 · {skillChoices.size} 项技能</span></div><button className="clear-selection" disabled={busy} onClick={() => { setReads([]); setExpands([]); setSkillChoices(new Map()) }}>清空</button><button className="retrieve-button" disabled={readonly || busy || !task || !!task.skillPlan && !reads.length && !expands.length} onClick={() => void runBatch()}>{busy ? '读取中…' : task?.skillPlan ? '批量获取' : '联合选择'}<Icon name="arrow" size={15}/></button></> : null}{task && !task.skillPlan && !selectedCount && !readonly && <button className="preset-button" onClick={() => void runBatch()} disabled={busy}>保存空集合</button>}</div>}
      <div className="zoom-tools" data-no-pan><button aria-label="放大画布" onClick={() => canvas.zoom(1.2)}><Icon name="plus"/></button><span>{Math.round(canvas.camera.scale * 100)}%</span><button aria-label="缩小画布" onClick={() => canvas.zoom(1 / 1.2)}><Icon name="minus"/></button><i/><button aria-label="概览全部内容" onClick={() => canvas.fit(mergeBounds(layout.bounds, skillLayout.bounds))}><Icon name="fit"/></button><button aria-label="收起全部层级" onClick={() => { setExpanded([]); setHubOpen(false); setFolders(new Set()); setSkillsOpen(new Set()); canvas.fit(initialBounds(roots)) }}><Icon name="branch"/></button><button aria-label="定位技能方案" onClick={() => canvas.locate(skillLayout.selector)}><Icon name="branch"/></button><button aria-label="定位上下文输出" onClick={() => canvas.locate(layout.output)}><Icon name="target"/></button></div>
      {loading && <div className={`view-loading ${!data ? 'initial-view-loading' : ''}`} data-testid={!data ? 'initial-view-loading' : undefined} role="status" data-no-pan>{data ? '更新中…' : '加载中…'}</div>}
      {!data && route && !loading && viewError && <div className="empty-workspace" data-no-pan><strong>无法打开任务</strong><button onClick={() => void loadView()}>重新读取</button></div>}
      {(error || viewError) && <div className="error-banner" role="alert" data-no-pan><span>{error || viewError}</span>{retry && <button disabled={busy} onClick={() => void retryCommand()}>重试原请求</button>}<button aria-label="关闭提示" onClick={() => { setError(''); setViewError('') }}><Icon name="close" size={13}/></button></div>}
      {data && !historical && data.modelState.state !== 'valid' && <div className="model-warning" data-no-pan>当前模型{data.modelState.state === 'invalid' ? '无效' : '未知'}。{data.model ? ' · 最近有效版本' : ''}</div>}
      {!route && !loading && <div className="empty-workspace" data-no-pan><strong>{error ? '无法读取本机工作区' : '还没有登记的项目'}</strong><button onClick={() => location.reload()}>重新连接</button></div>}
    </main>
    {loginError && <div className="empty-workspace session-required" role="alert" data-testid="session-required"><strong>{loginError.startsWith('SIGN_IN_RETRY:') ? '登录未完成' : '需要重新登录'}</strong><p>{loginError.replace(/^(AUTH_REQUIRED|SIGN_IN_RETRY):\s*/, '')}</p><button onClick={() => location.reload()}>重试登录</button></div>}
    {directory && !loginError && <DirectoryPage target={directory} root={directory.kind === 'context' ? byId.get(directory.id) : undefined} catalog={availableSkills} plan={plan} loading={!data && loading} notice={viewError || (directory.kind === 'skills' ? libraryStatus.error : '') || (offline ? '已离线' : !data ? error : '') || undefined} onRefresh={directory.kind === 'skills' && !plan && canRefresh ? () => void refreshSkills() : undefined} refreshing={refreshing} onBack={closeDirectory} onInspectNode={id => setDetail({ kind: 'node', id })} onInspectSkill={id => setDetail({ kind: 'skills', id })} onToggle={toggle} reads={reads} expands={expands} disabled={readonly || busy || !task} nodeLabel={label}/>}
    </div>
    {detail && !loginError && <div className="detail-shade" onClick={event => { if (event.target === event.currentTarget) setDetail(null) }}><aside ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="detail-title" className={`detail-panel ${['packet', 'skills'].includes(detail.kind) ? 'packet-panel' : detail.kind === 'history' ? 'history-panel' : detail.kind === 'structure' ? 'structure-panel' : ''}`}><div className="detail-heading"><span>{detail.kind === 'history' ? '最近60天' : historical ? '历史' : ''}</span><button aria-label="关闭详情" onClick={() => setDetail(null)}><Icon name="close"/></button></div><h2 id="detail-title">{detailTitle}</h2>
      {detail.kind === 'history' && route ? <HistoryPanel key={route.worktree} rpc={rpc} worktree={route.worktree} onOpen={id => chooseTask(id, true)}/> : detail.kind === 'skills' && route ? legacy ? <LegacySkillDetails archive={legacy} worktree={route.worktree} focusId={detail.id} focusFile={detail.file} rpc={rpc}/> : <SkillDetails key={route.worktree} task={task} catalog={availableSkills} diagnostics={catalog?.diagnostics} catalogValid={catalog?.valid} focusId={detail.id} focusFile={detail.file} rpc={rpc} worktree={route.worktree} selected={skillChoices} onChoose={chooseSkill} historical={historical} onRefresh={canRefresh ? () => void refreshSkills() : undefined}/> : detail.kind === 'structure' ? <StructurePanel views={(legacy ? legacyViews(legacy) : data?.model?.views ?? []) as C4View[]} revision={legacy?.record.modelRevision ?? data?.modelState.displayRevision ?? data?.model?.revision ?? ''} historical={historical || !!task} modelStatus={data?.modelState.state}/> : detail.kind === 'packet' ? legacy ? <LegacyPacket archive={legacy} copied={copied} onCopy={() => void copyPacket()}/> : task ? <><span className="detail-state">{bodyTexts.size} 项精确正文 · {task.binding.modelRevision.slice(0, 8)}</span><button className="detail-action" onClick={() => void copyPacket()}><Icon name="copy" size={14}/>{copied ? '已复制' : '复制上下文包'}</button><textarea aria-label="上下文包原文" className="packet-text" readOnly value={packet} rows={22}/></> : <p className="detail-note">尚未创建任务。</p> : detail.kind === 'node' && selected ? <><span className="detail-state">{label(selected)}</span><p className="node-description">{selected.brief}</p><dl>{Object.entries(selected.fields).map(([key, value]) => <React.Fragment key={key}><dt>{key}</dt><dd><code>{value}</code></dd></React.Fragment>)}</dl>{(selected.entityId ?? selected.objectId) && bodyTexts.has((selected.entityId ?? selected.objectId)!) && <section className="exact-body"><strong>正文</strong><pre>{bodyTexts.get((selected.entityId ?? selected.objectId)!) || '这项实体没有额外正文说明。'}</pre></section>}{selected.entityId && <button className="detail-action" disabled={readonly || busy || !task} onClick={() => toggle(selected.entityId!, 'read')}>{reads.includes(selected.entityId) ? '移除正文候选' : '加入正文候选'}<Icon name="plus" size={14}/></button>}</> : detail.kind === 'records' ? legacy ? <LegacyRecords archive={legacy} onBatch={id => chooseTask(legacy.taskId, true, id)}/> : <><span className="detail-state">{task ? `${task.batches.length} 批 · ${legacy ? '原型' : task?.source === 'web' ? '网页' : 'CLI'}创建` : '尚无任务'}</span><div className="records-list">{task?.batches.map((batch, index) => { const fields = batchFields(batch), failed = !!batch.result?.errors.length && !(batch.result.contexts.length + batch.result.directories.length + batch.result.unchanged.length) && batch.operation !== 'task select'; return <div className={`batch-record ${failed ? 'failed' : batch.result?.errors.length ? 'partial' : batch.result ? 'complete' : 'unknown'}`} key={batch.id}><span>批次 {String(index + 1).padStart(2, '0')}</span><strong>{failed ? '失败' : batch.result?.errors.length ? '部分返回' : batch.result ? '响应已记录' : '结果未知'}</strong><p>{fields.expand?.length ?? 0} 个目录 · {fields.read?.length ?? 0} 项正文</p><code>{[...fields.expand ?? [], ...fields.read ?? []].join('\n')}</code><button className="batch-view" onClick={() => chooseTask(task.id, true, batch.id)}>查看此时上下文 →</button><small>{time(batch.createdAt)} · {batch.source === 'web' ? '网页手动请求' : 'CLI请求'}</small>{batch.result?.errors.map((error, i) => <p className="record-error" key={i}>{error.code}: {error.message}</p>)}</div> })}</div><h3 className="section-label">观测记录</h3><p className="history-intro">{data?.observation.bindings.length ?? 0} 个只读绑定 · {data?.observation.events.length ?? 0} 条已返回观测。</p><pre className="raw-detail">{pretty(data?.observation ?? { bindings: [], events: [] })}</pre></> : <><span className="detail-state">核验状态：{freshness === 'verified' ? '所核范围已有声明' : freshness === 'pending' ? '待核验' : '未知或未完成'}</span><dl><dt>工作区</dt><dd><code>{data?.worktree.root ?? '未知'}</code></dd><dt>分支</dt><dd>{data?.worktree.branch ?? 'detached / 未知'}</dd><dt>模型</dt><dd><code>{data?.modelState.displayRevision ?? '未知'}</code></dd><dt>当前诊断</dt><dd>{data?.modelState.diagnostics.map(item => item.message).join('\n') || '无'}</dd></dl><h3 className="section-label">实际核验范围</h3><pre className="raw-detail">{pretty(data?.freshness ?? { state: 'unknown' })}</pre><h3 className="section-label">归档与派生索引</h3><pre className="raw-detail">{pretty(data?.archive ?? { state: 'unknown' })}</pre></>}
    </aside></div>}
  </div>
}
createRoot(document.getElementById('root')!).render(<App/>)
