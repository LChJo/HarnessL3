import { useEffect, useState } from 'react'
import type { Task } from './context-types'
import type { SkillBrief } from './skill-layout'
import './skill-details.css'

function SkillLinks({ brief, onSelect }: { brief?: SkillBrief; onSelect: (id: string) => void }) {
  return <>{!!brief?.related?.length && <div className="skill-related"><strong>关联方法</strong>{brief.related.map(id => <button key={id} className="detail-action" onClick={() => onSelect(id)}>{id} →</button>)}<p className="detail-note">关联仅供筛选，不自动选择或执行。</p></div>}{brief?.diagnostics?.map(message => <p className="record-error" key={message}>{message}</p>)}</>
}

function CatalogInfo({ status, onRefresh, refreshing }: { status?: LibraryStatus; onRefresh?: () => void; refreshing?: boolean }) {
  return <div className="skill-library-info"><strong>技能目录 · 自动更新</strong>
    <dl><dt>路径</dt><dd><code>{status?.root ?? '正在加载'}</code></dd><dt>最近检查</dt><dd>{status?.checkedAt ? new Date(status.checkedAt).toLocaleString('zh-CN') : '等待加载'}</dd></dl>
    <button className="detail-action" disabled={refreshing} onClick={onRefresh}>{refreshing ? '正在刷新…' : '刷新技能目录'}</button>
    {status?.error && <p className="record-error" role="alert">{status.error}</p>}
    {status?.diagnostics?.map(item => <p className="record-error" key={item.skillId + item.message}>{item.skillId}：{item.message}</p>)}
    <p className="detail-note">文件变化会更新目录、简述和关联引用。刷新不改写正文或已保存方案；交接先提供版本化引用，CLI read 按需返回文件。</p>
  </div>
}

type LibraryStatus = { root?: string; revision?: string; updatedAt?: string; checkedAt?: string; error?: string; diagnostics?: { skillId: string; message: string }[] }
export function SkillDetails({ task, catalog, focusId, focusFile, readOnly, libraryStatus, onRefresh, refreshing }: { task: Task | null; catalog: SkillBrief[]; focusId?: string; focusFile?: string; readOnly: boolean; libraryStatus?: LibraryStatus; onRefresh?: () => void; refreshing?: boolean }) {
  const [selectedId, setSelectedId] = useState(focusId), [filePath, setFilePath] = useState(focusFile ?? 'SKILL.md'), [material, setMaterial] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(false), [copied, setCopied] = useState(false)
  const plan = task?.skillPlan, selected = plan?.skills.find(skill => skill.id === selectedId), brief = catalog.find(skill => skill.id === selectedId)
  const file = selected?.files.find(file => file.path === filePath) ?? selected?.files[0]
  useEffect(() => { setSelectedId(focusId); setFilePath(focusFile ?? 'SKILL.md'); setMaterial(''); setError('') }, [focusId, focusFile, task?.id, plan?.id])
  async function loadMaterial(kind: 'prompt' | 'handoff') {
    if (!task) return
    setLoading(true); setError('')
    try {
      const through = task.history?.throughBatchId ?? (readOnly ? task.batches.at(-1)?.id : undefined)
      const suffix = kind === 'handoff' && through ? '?batch=' + encodeURIComponent(through) : ''
      const response = await fetch('/api/harness/tasks/' + task.id + '/' + kind + suffix, kind === 'prompt' ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-harness-client': 'web' }, body: '{}' } : undefined)
      const result = await response.json(); if (!response.ok) throw new Error(result.error)
      setMaterial(result[kind]); setCopied(false)
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }
  async function copy() { try { await navigator.clipboard.writeText(material); setCopied(true) } catch { setError('复制不可用，可选择下方原文复制。') } }
  if (selected || brief) return <div className="skill-details"><button className="detail-action" onClick={() => setSelectedId(undefined)}>← 返回技能方案</button><span className="detail-state">{selected ? '已选择 · 执行状态未知' : '目录简述 · 未选择'}</span><h3>{selected?.name ?? brief?.name}</h3><p className="node-description">{selected?.description ?? brief?.description}</p>{selected && <div className="skill-reason"><strong>选择理由</strong><p>{selected.reason}</p></div>}<dl><dt>可编辑文件</dt><dd><code>{selected?.path ?? brief?.path}</code></dd><dt>内容指纹</dt><dd><code>{selected?.contentHash ?? brief?.contentHash}</code></dd></dl><SkillLinks brief={brief} onSelect={id => { setSelectedId(id); setFilePath('SKILL.md') }}/>{selected ? <><label className="skill-file-label">当时的技能文件<select aria-label="归档技能文件" value={file?.path ?? ''} onChange={e => setFilePath(e.target.value)}>{selected.files.map(file => <option key={file.path} value={file.path}>{file.path}</option>)}</select></label><textarea className="packet-text skill-file" aria-label="归档技能原文" value={file?.content ?? ''} readOnly rows={22}/><p className="detail-note">此处显示选择时保存的文件，后续编辑或删除不会改写历史。{file?.encoding === 'base64' ? '该附件为 base64 编码。' : ''}</p></> : <p className="detail-note">当前仅浏览简述，未加载该技能正文，也未执行技能。技能文件可直接编辑、增加或删除。</p>}</div>
  return <div className="skill-details"><CatalogInfo status={libraryStatus} onRefresh={onRefresh} refreshing={refreshing}/><span className="detail-state">{plan ? `${plan.skills.length} 项技能 · 选择已记录` : task?.skillRouting?.status === 'unknown' || task && !task.skillRouting ? '选择记录未知' : '等待入口 agent 选择'}</span><p className="node-description">Skill Hub 根据任务目的与技能简述，一次选择本次需要的技能集合。上下文检索和技能路由分别记录，准备后回到标准 agent 工作方式。</p>{plan ? <><div className="skill-plan-list">{plan.skills.map(skill => <button key={skill.id} data-plan-skill={skill.id} onClick={() => { setSelectedId(skill.id); setFilePath('SKILL.md') }}><strong>{skill.name}<span>↗</span></strong><p>{skill.reason}</p><small>{skill.files.length} 个文件 · {skill.contentHash.slice(0, 8)}</small></button>)}</div>{!plan.skills.length && <p className="detail-note">本次明确不需要额外技能，空集合已保存。</p>}<dl><dt>目录版本</dt><dd><code>{plan.catalogRevision}</code></dd><dt>入口路由</dt><dd>{plan.routerVersion}</dd><dt>记录时间</dt><dd>{new Date(plan.createdAt).toLocaleString('zh-CN')}</dd></dl><button className="detail-action" disabled={loading} onClick={() => void loadMaterial('handoff')}>查看上下文 + 技能交接包 →</button></> : task?.skillRouting && task.skillRouting.status !== 'unknown' ? <><p className="detail-note">入口已提供 {catalog.length} 项技能简述，尚未记录模型选择。浏览不等于选中。</p>{!readOnly && <button className="detail-action" disabled={loading} onClick={() => void loadMaterial('prompt')}>查看入口筛选提示 →</button>}</> : <p className="detail-note">尚无可确认的选择方案，不能用当前目录补造历史。新任务可通过 HarnessL3 入口准备。</p>}{loading && <p className="detail-note">正在读取已记录材料…</p>}{material && <><button className="detail-action" onClick={() => void copy()}>{copied ? '已复制' : '复制交接材料'}</button><textarea className="packet-text" aria-label="技能交接材料" value={material} readOnly rows={22}/></>}{error && <p role="alert" className="record-error">{error}</p>}<p className="detail-note">选择与文件返回不证明技能已执行。脚本保留为可编辑文件，此入口不自动运行脚本。</p></div>
}
