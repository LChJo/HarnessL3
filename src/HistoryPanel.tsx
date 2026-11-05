import { useEffect, useState } from 'react'
import type { HistoryPage } from './context-types'

export function HistoryPanel({ onOpen }: { onOpen: (id: string) => void }) {
  const [query, setQuery] = useState(''), [from, setFrom] = useState(''), [to, setTo] = useState('')
  const [filter, setFilter] = useState({ query: '', from: '', to: '' }), [offset, setOffset] = useState(0)
  const [page, setPage] = useState<HistoryPage | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false)
  useEffect(() => {
    const controller = new AbortController(), params = new URLSearchParams({ query: filter.query, offset: String(offset), limit: '20' })
    if (filter.from) params.set('from', new Date(filter.from + 'T00:00:00').toISOString())
    if (filter.to) params.set('to', new Date(filter.to + 'T23:59:59.999').toISOString())
    setLoading(true); setError('')
    fetch('/api/context/history?' + params, { signal: controller.signal }).then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error); setPage(data) }).catch(e => { if (e.name !== 'AbortError') setError(e.message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [filter, offset])
  return <div className="history-content"><p className="history-intro">最近 60 天的任务。打开当时的输入、分批披露、五类命中和上下文输出。</p><form className="history-filter" onSubmit={event => { event.preventDefault(); setOffset(0); setFilter({ query, from, to }) }}><input aria-label="搜索历史任务" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索任务目的、ID 或会话"/><div><label>从<input aria-label="历史开始日期" type="date" value={from} onChange={e => setFrom(e.target.value)}/></label><label>到<input aria-label="历史结束日期" type="date" value={to} onChange={e => setTo(e.target.value)}/></label><button type="submit">查找</button></div></form>{error && <p className="record-error">{error}</p>}<div className="history-count" aria-live="polite">{loading ? '正在查找…' : `${page?.total ?? 0} 项任务`}</div><div className="history-list">{page?.tasks.map(task => <button className="history-task" key={task.id} data-history-id={task.id} onClick={() => onOpen(task.id)}><strong>{task.title}</strong><span>{new Date(task.updatedAt).toLocaleString('zh-CN')}<i/>{task.batchCount ?? 0} 批 · {task.contextCount} 项正文</span><small>{task.history?.snapshotStatus === 'complete' ? '已归档模型' : '旧记录 · 部分快照'} · {task.id.slice(0, 8)}<b>查看组织 →</b></small></button>)}</div>{!loading && !page?.tasks.length && !error && <p className="detail-note">该时间范围内没有匹配任务。</p>}<div className="history-pagination"><button disabled={!offset || loading} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</button><span>第 {Math.floor(offset / 20) + 1} 页</span><button disabled={!page?.hasMore || loading} onClick={() => setOffset(offset + 20)}>下一页</button></div><p className="detail-note">按最后一次读取活动计算，查看历史不会延长保留期。历史不包含未采集的其他工具操作。</p></div>
}
