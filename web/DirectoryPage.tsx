import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import { skillEntries } from './skill-layout'
import type { SkillPlan } from './skill-layout'
import type { MapItem } from './context-map'
import type { SkillBrief } from './types'

export type DirectoryTarget = { kind: 'context'; id: string } | { kind: 'skills'; group?: string }
export function parseDirectory(value: string | null): DirectoryTarget | null {
  if (value?.startsWith('context:') && value.length > 8) return { kind: 'context', id: value.slice(8) }
  if (value === 'skills') return { kind: 'skills' }
  if (value?.startsWith('skills:') && value.length > 7) return { kind: 'skills', group: value.slice(7) }
  return null
}
export const directoryKey = (target: DirectoryTarget) => target.kind === 'context' ? 'context:' + target.id : target.group ? 'skills:' + target.group : 'skills'
type Row = { id: string; title: string; path: string; brief: string; state: string; hit: boolean; node?: MapItem; skillId?: string; fileCount?: number }

export function DirectoryPage({ target, root, catalog, plan, loading, notice, onRefresh, refreshing, onBack, onInspectNode, onInspectSkill, onToggle, reads, expands, disabled, nodeLabel }: {
  target: DirectoryTarget; root?: MapItem; catalog: SkillBrief[]; plan: SkillPlan | null; loading: boolean; notice?: string
  onRefresh?: () => void; refreshing?: boolean
  onBack: () => void; onInspectNode: (id: string) => void; onInspectSkill: (id: string) => void
  onToggle: (id: string, kind: 'read' | 'expand') => void; reads: string[]; expands: string[]; disabled: boolean; nodeLabel: (item: MapItem) => string
}) {
  const [search, setSearch] = useState(''), [filter, setFilter] = useState('all'), [page, setPage] = useState(0)
  const heading = useRef<HTMLHeadingElement>(null)
  const key = directoryKey(target), title = target.kind === 'skills' ? target.group || '技能目录' : root?.title || '上下文目录'
  useEffect(() => { heading.current?.focus(); setSearch(''); setFilter('all'); setPage(0) }, [key])
  const rows = useMemo<Row[]>(() => {
    if (target.kind === 'skills') return skillEntries(catalog, plan).filter(({ skill }) => !target.group || skill.group === target.group).map(({ skill, selected }) => ({ id: skill.id, skillId: skill.id, title: skill.name, path: skill.id, brief: skill.description, state: selected ? '已选择' : '未选择', hit: selected, fileCount: skill.files.length }))
    const result: Row[] = []
    const visit = (nodes: MapItem[], ancestors: string[]) => { for (const node of nodes) { const path = [...ancestors, node.title]; result.push({ id: node.id, title: node.title, path: node.fields['定位'] || path.join(' / '), brief: node.brief, hit: node.hit, state: node.hit ? nodeLabel(node) || '命中' : '未命中', node }); visit(node.children, path) } }
    if (root) visit(root.children, [root.title])
    return result
  }, [root, catalog, plan, key])
  const query = search.trim().toLocaleLowerCase()
  const filtered = useMemo(() => rows.filter(row => (filter === 'all' || row.hit === (filter === 'hit')) && (!query || `${row.title}\n${row.path}\n${row.brief}`.toLocaleLowerCase().includes(query))), [rows, filter, query])
  const pages = Math.max(1, Math.ceil(filtered.length / 50)), current = Math.min(page, pages - 1), visible = filtered.slice(current * 50, (current + 1) * 50)
  return <main className="directory-page" aria-label="全部节点" data-testid="node-directory" data-directory-kind={target.kind}>
    <div className="directory-content">
      <button className="directory-back" onClick={onBack}><span aria-hidden="true">←</span> 返回画布</button>
      <div className="directory-heading"><div><span className="directory-eyebrow">{target.kind === 'skills' ? 'Skill Hub' : '上下文'}</span><h1 ref={heading} tabIndex={-1}>{title}</h1></div><div className="directory-heading-actions"><span className="directory-total">{rows.length} 项</span>{onRefresh && <button disabled={refreshing} onClick={onRefresh}>{refreshing ? '刷新中…' : '刷新目录'}</button>}</div></div>
      <div className="directory-toolbar"><label className="directory-search"><Icon name="search" size={16}/><input type="search" aria-label="搜索全部节点" placeholder="搜索名称、路径或简述" value={search} onChange={event => { setSearch(event.target.value); setPage(0) }}/></label><select aria-label="筛选命中状态" value={filter} onChange={event => { setFilter(event.target.value); setPage(0) }}><option value="all">全部</option><option value="hit">{target.kind === 'skills' ? '已选择' : '已命中'}</option><option value="miss">{target.kind === 'skills' ? '未选择' : '未命中'}</option></select></div>
      <div className="directory-results" aria-live="polite">{loading ? '正在加载…' : `${filtered.length} 项结果`}</div>
      {notice && <p className="record-error" role="alert">{notice}</p>}
      {!loading && !visible.length && <div className="directory-empty">{rows.length ? '没有匹配的节点' : '暂无节点'}</div>}
      <div className="directory-list">{!loading && visible.map(row => <article className={`directory-row ${row.hit ? 'is-hit' : ''}`} key={row.id} data-directory-row={row.id}>
        <div className="directory-row-body"><button className="directory-row-title" onClick={() => row.skillId ? onInspectSkill(row.skillId) : onInspectNode(row.id)}>{row.title}<span aria-hidden="true">↗</span></button><span className="directory-row-path">{row.path}</span>{row.brief && <p>{row.brief}</p>}</div>
        <div className="directory-row-meta"><span className="directory-row-state">{row.state}</span>{row.fileCount !== undefined && <span>{row.fileCount} 个文件</span>}{row.node?.entityId && <div className="directory-row-actions"><button disabled={disabled} className={reads.includes(row.node.entityId) ? 'picked' : ''} aria-label={`${reads.includes(row.node.entityId) ? '移除' : '选择'}${row.title}正文`} onClick={() => onToggle(row.node!.entityId!, 'read')}>正文</button>{row.node.kind === 'object' && <button disabled={disabled} className={expands.includes(row.node.entityId) ? 'picked' : ''} aria-label={`${expands.includes(row.node.entityId) ? '移除' : '选择'}${row.title}目录`} onClick={() => onToggle(row.node!.entityId!, 'expand')}>目录</button>}</div>}</div>
      </article>)}</div>
      {pages > 1 && <nav className="directory-pagination" aria-label="节点分页"><span>{current * 50 + 1}–{Math.min((current + 1) * 50, filtered.length)} / {filtered.length}</span><button disabled={current === 0} onClick={() => { setPage(current - 1); heading.current?.scrollIntoView({ block: 'start' }) }}>上一页</button><span>{current + 1} / {pages}</span><button disabled={current + 1 === pages} onClick={() => { setPage(current + 1); heading.current?.scrollIntoView({ block: 'start' }) }}>下一页</button></nav>}
    </div>
  </main>
}
