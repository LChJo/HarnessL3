import { useEffect, useRef, useState } from 'react'
import type { HistoryResult, Rpc } from './types'
import { errorMessage, time } from './types'

export function HistoryPanel({ rpc, worktree, onOpen }: { rpc: Rpc; worktree: string; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState(''), [from, setFrom] = useState(''), [to, setTo] = useState('')
  const [result, setResult] = useState<HistoryResult | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false)
  const generation = useRef(0)
  async function load(offset = 0) {
    const token = ++generation.current
    setLoading(true); setError('')
    try {
      const response = await rpc<{ result: HistoryResult }>('history list', { worktree, flags: { limit: '20', offset: String(offset), ...(query.trim() ? { query: query.trim() } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) } })
      if (generation.current === token) setResult(response.result)
    } catch (error) { if (generation.current === token) { setResult(null); setError(errorMessage(error)) } }
    finally { if (generation.current === token) setLoading(false) }
  }
  useEffect(() => { void load(); return () => { ++generation.current } }, [worktree])
  return <div data-testid="history-panel">
    <p className="history-intro">最近60天的任务与当时上下文。浏览、恢复和技能预览不延长保留窗口；已知超期任务仍保留在本机。</p>
    <form className="history-filter" onSubmit={event => { event.preventDefault(); void load() }}>
      <input aria-label="搜索历史任务" value={query} onChange={event => setQuery(event.target.value)} placeholder="任务目的、ID、会话或模型版本" />
      <div><label>起始日期<input type="date" aria-label="历史起始日期" value={from} onChange={event => setFrom(event.target.value)} /></label><label>结束日期<input type="date" aria-label="历史结束日期" value={to} onChange={event => setTo(event.target.value)} /></label><button type="submit" disabled={loading}>查询</button></div>
    </form>
    {error && <p role="alert" className="record-error">{error}<br/>搜索当前不可用，不能将其显示为空记录。</p>}
    {loading && <p className="history-count" role="status">正在检索归档索引…</p>}
    {result && <><p className="history-count">{result.total} 个任务 · 日期按UTC活动日筛选</p>
      <div>{result.items.map(item => <button className="history-task" key={item.id} data-history-task={item.id} onClick={() => onOpen(item.id)}><strong>{item.title || '未记录目的'}</strong><span>{item.contextCount ?? '未知'} 项正文<i/>{item.skillCount ?? '未知'} 项技能<i/>{item.closedAt ? '已关闭' : '上下文组织'}<i/>{item.completeness === 'complete' ? '归档完整' : '已知范围有限'}</span><small><span>{time(item.retentionBasisAt)}</span><b>{item.format === 'v1' ? item.binding?.modelRevision?.slice(0, 8) || '版本未知' : '旧格式记录'}</b></small></button>)}</div>
      {!result.items.length && <p className="detail-note">该筛选范围内没有可发现的任务。不会自动创建示例或读取当前源码。</p>}
      <div className="history-pagination"><button disabled={loading || !result.offset} onClick={() => void load(Math.max(0, result.offset - result.limit))}>上一页</button><span>{result.total ? result.offset + 1 : 0}–{result.offset + result.items.length} / {result.total}</span><button disabled={loading || !result.hasMore} onClick={() => void load(result.offset + result.limit)}>下一页</button></div>
    </>}
  </div>
}
