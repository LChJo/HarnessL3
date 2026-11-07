import { useId } from 'react'
import type { LayoutSkillNode, SkillPlan, SkillLayout } from './skill-layout'
import './skill-lane.css'

export type { Bounds, SkillBrief, SkillSelection, SkillPlan, SkillFileReference } from './skill-layout'

export type SkillLibraryStatus = {
  root?: string
  updatedAt?: string
  checkedAt?: string
  error?: string | null
  stale?: boolean
  revision?: string
  archived?: boolean
}

export type SkillLaneProps = {
  layout: SkillLayout
  plan?: SkillPlan | null
  expanded: boolean
  onToggle: () => void
  expandedFolders?: Set<string>
  onToggleFolder: (group: string) => void
  expandedSkills?: Set<string>
  onToggleSkill?: (id: string) => void
  onInspect: (id?: string, filePath?: string) => void
  onBrowse: (group?: string) => void
  onRefresh?: () => void
  refreshing?: boolean
  libraryStatus?: SkillLibraryStatus
  unavailable?: boolean
}

function Chevron({ expanded }: { expanded: boolean }) {
  return <svg className={expanded ? 'is-expanded' : ''} width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m7 4 6 6-6 6"/></svg>
}

function InspectIcon() {
  return <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M10 9v5M10 6v.5"/></svg>
}

function fileState(node: LayoutSkillNode) {
  if (!node.file) return '主路径 · 文件清单未保存'
  const size = node.file.bytes >= 1024 ? `${(node.file.bytes / 1024).toFixed(1)} KB` : `${node.file.bytes} B`
  return `文件引用 · ${size} · ${node.file.encoding === 'utf8' ? 'UTF-8' : '附件'}`
}

function timeLabel(value?: string) {
  if (!value) return ''
  const time = new Date(value)
  return Number.isNaN(time.valueOf()) ? '' : time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

export function SkillLane({ layout, plan, expanded, onToggle, expandedFolders = new Set<string>(), onToggleFolder, expandedSkills = new Set<string>(), onToggleSkill, onInspect, onBrowse, onRefresh, refreshing = false, libraryStatus, unavailable = false }: SkillLaneProps) {
  const contentId = useId()
  // An unknown record must not be filled using the current catalog or a current plan.
  const savedPlan = unavailable ? null : plan
  const selected = !!savedPlan
  const status = unavailable ? '未知' : !savedPlan ? '未选择' : savedPlan.skills.length ? `已选 ${savedPlan.skills.length} 项` : '不需要额外技能'

  const libraryState = libraryStatus?.archived ? 'archived' : refreshing ? 'refreshing' : libraryStatus?.error ? 'error' : libraryStatus?.stale ? 'stale' : libraryStatus?.checkedAt || libraryStatus?.updatedAt ? 'ready' : 'unknown'
  const refreshLabel = libraryStatus?.archived ? '归档目录' : refreshing ? '刷新中…' : libraryStatus?.error ? '目录异常' : libraryStatus?.stale ? '待刷新' : libraryStatus?.checkedAt ? `已检查 ${timeLabel(libraryStatus.checkedAt)}` : libraryStatus?.updatedAt ? `已更新 ${timeLabel(libraryStatus.updatedAt)}` : '尚未刷新'
  const root = libraryStatus?.root || '文件路径随节点查看'
  function skillNode(node: LayoutSkillNode) {
    if (node.kind === 'overflow') return <button type="button" key={node.id} className="mind-node skill-lane-node overflow-node" style={{ left: node.x, top: node.y, width: node.width, height: node.height }} data-skill-overflow={node.group ?? '*'} aria-label={`查看${node.group || '技能目录'}全部节点`} onClick={() => onBrowse(node.group)}><strong>…</strong><span>{node.description}</span><span aria-hidden="true">↗</span></button>
    if (node.kind === 'folder') {
      const group = node.group!, open = expandedFolders.has(group)
      return <div key={node.id} className={`mind-node skill-lane-node skill-lane-folder ${node.selected ? 'has-selection' : ''}`} style={{ left: node.x, top: node.y, width: node.width, height: node.height }} data-skill-node={node.id} data-skill-folder={group} data-skill-folder-count={node.skillCount} data-skill-folder-selected={node.selectedCount}>
        <button type="button" className="skill-lane-main" aria-label={`${open ? '收起' : '展开'}文件夹${group}`} aria-expanded={open} title={`${group}\n${node.selected ? `本次已选 ${node.selectedCount} 项技能` : `${node.skillCount} 项技能 · 未选择`}`} onClick={() => onToggleFolder(group)}>
          <span className="skill-lane-node-title"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 5h6l2 2h7v9.5h-15Z"/></svg><strong>{node.name}</strong><span className="skill-lane-file-count">{node.skillCount}</span><Chevron expanded={open}/></span>
          <span className="skill-lane-brief">{node.selected ? `本次已选 ${node.selectedCount} 项技能` : `${node.skillCount} 项技能 · 未选择`}</span>

        </button>
      </div>
    }
    if (node.kind === 'file') return <button type="button" key={node.id} className={`mind-node skill-lane-node skill-lane-file ${node.selected ? 'has-selection' : ''}`} style={{ left: node.x, top: node.y, width: node.width, height: node.height }} data-skill-node={node.id} data-skill-file={node.filePath} data-skill-file-owner={node.skillId} aria-label={`查看技能文件${node.filePath}`} title={`${node.filePath}\n${fileState(node)}${node.file ? `\n${node.file.hash}` : ''}`} onClick={() => onInspect(node.skillId, node.filePath)}>
      <span className="skill-lane-node-title"><svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true"><path d="M5 2.5h7l3 3v12H5Z"/><path d="M12 2.5v4h3"/></svg><strong>{node.name}</strong><span aria-hidden="true">↗</span></span>
      <span className="skill-lane-file-path">{node.filePath}</span>
      <span className="skill-lane-node-state">{fileState(node)}</span>
    </button>
    const open = expandedSkills.has(node.skillId), expandable = !!node.fileCount && !!onToggleSkill
    return <div key={node.id} className={`mind-node skill-lane-node ${node.selected ? 'has-selection' : ''}`} style={{ left: node.x, top: node.y, width: node.width, height: node.height }} data-skill-node={node.id} data-skill-id={node.skillId} data-skill-state={node.kind}>
      <button type="button" className="skill-lane-main" aria-label={expandable ? `${open ? '收起' : '展开'}技能${node.name}文件引用` : `查看技能${node.name}详情`} aria-expanded={expandable ? open : undefined} title={`${node.name}\n${node.reason || node.description}\n${node.path}`} onClick={() => expandable ? onToggleSkill!(node.skillId) : onInspect(node.skillId)}>
        <span className="skill-lane-node-title"><i/><strong>{node.name}</strong>{expandable && <><span className="skill-lane-file-count" title={`${node.fileCount} 个文件引用`}>{node.fileCount}</span><Chevron expanded={open}/></>}</span>
        <span className="skill-lane-brief">{node.reason || node.description || '暂无简述'}</span>
        <span className="skill-lane-node-state">{node.selected ? '已选择' : `${node.group || '技能目录'} · 未选择`}{!!node.diagnostics?.length && ' · 有提示'}</span>
      </button>
      <button type="button" className="skill-lane-inspect" aria-label={`查看技能${node.name}详情`} title="查看简述、选择理由和文件详情" onClick={() => onInspect(node.skillId)}><InspectIcon/></button>
    </div>
  }

  return <div className="skill-lane" role="group" aria-label="Skill Hub 技能脑图" data-skill-lane data-skill-status={unavailable ? 'unknown' : selected ? 'selected' : 'unselected'}>
    <section className="skill-lane-region" style={{ left: layout.frame.x, top: layout.frame.y, width: layout.frame.width, height: layout.frame.height }} aria-label="独立技能选择区">
    </section>
    <div className="skill-lane-caption" style={{ left: layout.frame.x + 24, top: layout.frame.y + 15, width: layout.frame.width - 48 }} data-skill-library-state={libraryState}>
      <div className="skill-lane-caption-heading"><span>本次技能</span><span>{unavailable ? '记录未知' : selected ? '选择已记录' : '未选择'}</span>{onRefresh && <button type="button" aria-label="刷新技能目录" title="刷新技能目录" disabled={refreshing} onClick={onRefresh}><svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15.8 6.7A6 6 0 1 0 16 12M16 3v4h-4"/></svg></button>}</div>
      <div className={`skill-lane-library-line ${libraryStatus?.error ? 'has-error' : ''}`} title={`${root}\n${libraryStatus?.error || refreshLabel}${libraryStatus?.revision ? `\n${libraryStatus.revision}` : ''}`}><span className="skill-lane-library-path">{root}</span><span className="skill-lane-library-state" aria-live="polite">{refreshLabel}</span></div>
    </div>
    <svg className="skill-lane-lines" width="1" height="1" aria-hidden="true">
      {layout.edges.map(edge => <path key={`${edge.source}:${edge.target}`} className={`skill-lane-edge ${edge.selected ? 'has-selection' : ''}`} data-skill-edge={`${edge.source}:${edge.target}`} d={edge.d}/>) }
    </svg>
    <button type="button" className={`mind-node skill-lane-selector ${selected ? 'has-selection' : ''}`} style={{ left: layout.selector.x, top: layout.selector.y, width: layout.selector.width, height: layout.selector.height }} data-skill-selector="skill-hub" aria-label={`${expanded ? '收起' : '展开'}Skill Hub技能选择区`} aria-expanded={expanded} aria-controls={contentId} onClick={onToggle}>
      <span className="skill-lane-selector-title"><i/><strong>Skill Hub</strong><Chevron expanded={expanded}/></span>

      <span className="skill-lane-selector-state">{status}<span>{expanded ? '收起' : '展开'}</span></span>
    </button>
    <button type="button" className={`skill-lane-output ${selected ? 'has-selection' : ''}`} style={{ left: layout.output.x, top: layout.output.y, width: layout.output.width, height: layout.output.height }} data-skill-plan={savedPlan?.id ?? (unavailable ? 'unknown' : 'unselected')} aria-label="查看技能方案" onClick={() => onInspect()}>
      <span className="skill-lane-output-label"><svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 2.5h7l3 3v12H5Z"/><path d="M12 2.5v4h3M8 10h4M8 13h4"/></svg>技能方案<span aria-hidden="true">↗</span></span>
      <strong>{status}</strong>

      <span className="skill-lane-output-link">查看方案<span aria-hidden="true">→</span></span>
    </button>
    <div id={contentId} hidden={!expanded}>
      {expanded && <>
        {layout.nodes.length > 0 ? layout.nodes.map(skillNode) : <div className="skill-lane-empty" style={{ left: layout.selector.x, top: layout.selector.y + layout.selector.height + 16, width: layout.selector.width }}>
          <strong>{unavailable ? '技能选择记录未知' : selected ? '这次任务不需要额外技能' : '暂无可浏览的技能目录'}</strong>

        </div>}
      </>}
    </div>
  </div>
}
