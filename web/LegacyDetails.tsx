import { useEffect, useRef, useState } from 'react'
import type { LegacyArchive, Rpc } from './types'
import { errorMessage, pretty, time } from './types'
import { legacyPlan } from './legacy'

export function LegacySkillDetails({ archive, worktree, focusId, focusFile, rpc }: { archive: LegacyArchive; worktree: string; focusId?: string; focusFile?: string; rpc: Rpc }) {
  const [returned, setReturned] = useState<LegacyArchive['record']['legacyRead']>(), [error, setError] = useState(''), [reading, setReading] = useState('')
  const generation = useRef(0), plan = legacyPlan(archive)
  useEffect(() => { ++generation.current; setReturned(undefined); setError(''); setReading(''); return () => { ++generation.current } }, [worktree, archive.taskId, archive.throughBatchId, focusId, focusFile])
  async function read(skillId: string, path: string, expectedHash: string) {
    const token = ++generation.current
    setReading(skillId + '/' + path); setError('')
    try {
      const result = await rpc<LegacyArchive>('task read', { id: archive.taskId, worktree, input: { schemaVersion: 1, requestId: crypto.randomUUID(), files: [{ skillId, path, expectedHash }], ...(archive.throughBatchId ? { throughBatchId: archive.throughBatchId } : {}) } })
      if (token === generation.current) setReturned(result.record.legacyRead)
    } catch (error) { if (token === generation.current) setError(errorMessage(error)) }
    finally { if (token === generation.current) setReading('') }
  }
  return <div className="skill-details" data-testid="legacy-skills"><p className="history-intro">旧格式归档 · 保留原始技能ID、文件夹和文件引用。当前技能目录不会改写这次选择。执行、理解和未采集的范围保持未知。</p><span className="detail-state">{plan ? `当时已选 ${plan.skills.length} 项` : '技能选择未知'}</span>
    {!plan && <p className="detail-note">这份旧记录没有保存可确认的选择方案，不能用当前目录补造。</p>}
    {plan?.skills.filter(skill => !focusId || skill.id === focusId).map(skill => <section className="skill-method" key={skill.id}><div className="skill-method-title"><strong>{skill.name}</strong><span>{skill.group}</span></div><code>{skill.id}</code><p>{skill.description}</p><p className="skill-reason">选择理由：{skill.reason}</p><div className="skill-file-list">{skill.files.filter(file => !focusFile || file.path === focusFile).map(file => <div className="skill-file-row" key={file.path}><div><strong>{file.path}</strong><small>{file.bytes} B · {file.encoding.toUpperCase()} · {file.hash.slice(0, 12)}</small></div><button disabled={!!reading} onClick={() => void read(skill.id, file.path, file.hash)}>{reading === skill.id + '/' + file.path ? '读取中…' : '预览归档'}</button></div>)}</div></section>)}
    {error && <p className="record-error" role="alert">{error}</p>}
    {returned?.errors.map((item, index) => <p className="record-error" key={index}>{item.skillId}/{item.path}: {item.code}</p>)}
    {returned?.files.map(item => <section className="skill-returned" key={item.skillId + '/' + item.file.path}><strong>{item.skillId}/{item.file.path}</strong><p>网页预览 · 原始归档字节；不代表agent读取或执行。</p><textarea aria-label="旧技能归档原文" readOnly rows={14} value={item.file.content}/><small>{item.file.encoding === 'base64' ? '二进制以BASE64显示，不执行或自动打开。' : '保留当时UTF-8正文。'}</small></section>)}
  </div>
}

export function LegacyRecords({ archive, onBatch }: { archive: LegacyArchive; onBatch: (id: string) => void }) {
  return <><span className="detail-state">原型归档 · {archive.completeness} · {(archive.record.batches ?? []).length} 批</span><p className="history-intro">原始任务、批次、模型快照与文件指纹独立保留。旧观测没有完整来源树扫描和正式身份，缺失范围保持未知。</p><div className="records-list">{archive.record.batches?.map((batch, index) => <div className="batch-record" key={batch.id}><span>批次 {index + 1}</span><strong>{batch.status === 'partial' ? '部分返回' : batch.status === 'complete' ? '响应已记录' : batch.status || '状态未知'}</strong><p>{batch.result?.directories?.length ?? 0} 个目录 · {batch.result?.contexts?.length ?? 0} 项正文</p><small>{time(batch.requestedAt ?? batch.completedAt)} · 原始客户端 {batch.client || '未知'}</small><button className="batch-view" onClick={() => onBatch(batch.id)}>查看此时上下文 →</button>{batch.result?.errors?.map((error, i) => <p className="record-error" key={i}>{error.operation}: {error.message}</p>)}</div>)}</div><h3 className="section-label">原始绑定与未知范围</h3><pre className="raw-detail">{pretty(archive.record.legacyArchive ?? { state: 'unknown' })}</pre></>
}

export function LegacyPacket({ archive, copied, onCopy }: { archive: LegacyArchive; copied: boolean; onCopy: () => void }) {
  return <><span className="detail-state">旧格式 · {archive.completeness} · {archive.record.packet?.contexts.length ?? 0} 项原始正文</span><button className="detail-action" onClick={onCopy}>{copied ? '已复制' : '复制原始上下文包'}</button><textarea className="packet-text" aria-label="上下文包原文" readOnly rows={22} value={pretty(archive)}/><p className="detail-note">保留原ID、原版本和当时选择，未转换为正式UUID或完整SourceVersion。{archive.record.legacyContextSnapshot ? '模型与C4来自当时归档。' : '完整模型快照缺失，只显示已保存的局部正文和定位。'} 未知范围：{archive.record.legacyArchive?.unknown?.join('、') || '以原始记录为准'}。</p></>
}
