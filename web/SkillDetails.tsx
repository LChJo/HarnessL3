import { useEffect, useRef, useState } from 'react'
import type { FileRef, Rpc, SelectedSkill, SkillBrief, TaskRecord } from './types'
import { errorMessage } from './types'
import { SkillReason } from './SkillReason'

interface ReturnedFile { skillId: string; file: FileRef & { content: string } }
export function SkillDetails({ task, catalog, diagnostics = [], catalogValid = true, focusId, focusFile, worktree, rpc, selected, onChoose, historical, onRefresh }: { task: TaskRecord | null; catalog: SkillBrief[]; diagnostics?: { message: string }[]; catalogValid?: boolean; focusId?: string; focusFile?: string; worktree: string; rpc: Rpc; selected: Map<string, string>; onChoose: (id: string, reason: string | null) => void; historical: boolean; onRefresh?: () => void }) {
  const [reading, setReading] = useState(''), [returned, setReturned] = useState<ReturnedFile | null>(null), [error, setError] = useState('')
  const generation = useRef(0)
  useEffect(() => { ++generation.current; setReturned(null); setError(''); setReading(''); return () => { ++generation.current } }, [worktree, task?.id, focusId, focusFile])
  const recorded = !!task?.skillPlan
  const saved = task?.skillPlan?.skills ?? []
  const methods: (SelectedSkill | SkillBrief)[] = recorded ? focusId ? [...saved, ...catalog.filter(skill => !saved.some(chosen => chosen.id === skill.id))] : saved : catalog
  const visible = focusId ? methods.filter(skill => skill.id === focusId) : methods
  async function read(id: string, file: FileRef) {
    if (!task) return
    const token = ++generation.current
    setReading(id + '/' + file.path); setError('')
    try {
      const input = { schemaVersion: 1, requestId: crypto.randomUUID(), files: [{ skillId: id, path: file.path, expectedHash: file.hash }], ...(task.batches.at(-1)?.id ? { throughBatchId: task.batches.at(-1)!.id } : {}) }
      const result = await rpc<{ files: ReturnedFile[]; errors: { message: string }[] }>('task read', { id: task.id, input, worktree })
      if (generation.current === token) { setReturned(result.files[0] ?? null); if (result.errors.length) setError(result.errors.map(error => error.message).join('; ')) }
    } catch (error) { if (generation.current === token) setError(errorMessage(error)) }
    finally { if (generation.current === token) setReading('') }
  }
  return <div className="skill-details" data-testid="skill-details">
    <span className="detail-state">{focusId && recorded ? saved.some(skill => skill.id === focusId) ? '已选择' : '未选择' : recorded ? `已选 ${saved.length} 项` : `${methods.length} 项技能`}{historical ? ' · 历史' : ''}</span>
    {!historical && onRefresh && <button className="detail-action" onClick={onRefresh}>刷新目录</button>}
    {!recorded && !catalogValid && diagnostics.map((item, index) => <p key={index} className="record-error" role="alert">{item.message}</p>)}
    {!visible.length && <p className="detail-note">{recorded ? '未选择技能' : '暂无技能'}</p>}
    {visible.map(skill => <section className="skill-method" key={skill.id} data-skill-detail={skill.id}>
      <div className="skill-method-title"><strong>{skill.name}</strong><span>{skill.group}</span></div>
      <p>{skill.description}</p>
      {'reason' in skill && <SkillReason reason={skill.reason} />}
      {!recorded && <div className="skill-choice"><label><input type="checkbox" aria-label={`选择技能${skill.name}`} checked={selected.has(skill.id)} disabled={historical || !task} onChange={event => onChoose(skill.id, event.target.checked ? '' : null)} />加入联合选择</label>{selected.has(skill.id) && <textarea aria-label={`${skill.name}选择理由`} value={selected.get(skill.id) ?? ''} onChange={event => onChoose(skill.id, event.target.value)} placeholder="本次任务为什么需要它" rows={2} />}</div>}
      {'related' in skill && !!skill.related.length && <p className="skill-related">相关技能：{skill.related.join('、')}</p>}
      {'diagnostics' in skill && skill.diagnostics.map((message, index) => <p key={index} className="record-error">{message}</p>)}
      <div className="skill-file-list">{skill.files.filter(file => !focusFile || file.path === focusFile).map(file => <div className="skill-file-row" key={file.path}><div><strong>{file.path}</strong><small>{file.bytes} B · {file.encoding.toUpperCase()} · {file.hash.slice(0, 12)}</small></div>{recorded && saved.some(chosen => chosen.id === skill.id) ? <button disabled={!!reading} onClick={() => void read(skill.id, file)} aria-label={`网页预览归档文件${file.path}`}>{reading === skill.id + '/' + file.path ? '读取中…' : '预览归档'}</button> : <span>仅文件引用</span>}</div>)}</div>
    </section>)}
    {error && <p role="alert" className="record-error">{error}</p>}
    {returned && <section className="skill-returned"><strong>{returned.skillId}/{returned.file.path}</strong><textarea aria-label="技能归档文件原文" readOnly value={returned.file.content} rows={14} /><small>{returned.file.encoding.toUpperCase()}</small></section>}
  </div>
}
