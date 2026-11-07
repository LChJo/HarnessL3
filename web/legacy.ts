import { projectContext as projectPrototype } from '../src/context-map'
import type { Snapshot, Task } from '../src/context-types'
import type { C4View, LegacyArchive, SelectedSkill } from './types'
import type { MapItem } from './context-map'
import type { SkillPlan } from './skill-layout'

/** Legacy projection is deliberately separate from formal UUID/SourceVersion data. */
export function legacyContext(archive: LegacyArchive): MapItem[] {
  const record = archive.record, stored = record.legacyContextSnapshot
  const contexts = (record.packet?.contexts ?? []).map(body => ({ ...body, metadata: body.metadata ?? {}, ancestors: body.ancestors ?? [], relationships: (body.relationships ?? []).map(edge => ({ ...edge, metadata: edge.metadata ?? {} })) }))
  const snapshot: Snapshot = {
    modelStatus: stored?.modelStatus ?? 'unknown', revision: stored?.revision ?? record.modelRevision ?? '未知',
    elements: (stored?.elements ?? []).map(entity => ({ ...entity, metadata: entity.metadata ?? {} })),
    relationships: (stored?.relationships ?? []).map(edge => ({ ...edge, metadata: edge.metadata ?? {} })),
    evidence: stored?.evidence ?? [], sourceVersion: stored?.sourceVersion ?? record.sourceVersion ?? {}, runtime: { sourceRoot: stored?.runtime?.sourceRoot ?? record.sourceRoot ?? '未保存' },
  }
  // The pure prototype projection reads only these archived fields. An empty
  // root displays original top-level dot IDs, with no hardcoded MGRP identity.
  const task = { ...record, modelRevision: record.modelRevision ?? snapshot.revision, disclosedIds: record.disclosedIds ?? [], packet: { modelRevision: record.packet?.modelRevision ?? snapshot.revision, contexts } } as Task
  const roots: MapItem[] = projectPrototype(snapshot, task, '')
  function mark(item: MapItem) {
    if (item.fields.范围) item.fields.范围 = item.kind === 'relation' ? '关系引用' : item.kind === 'evidence' ? '证据引用' : '所引文件'
    if (item.id.startsWith('version:worktree:')) { item.title = '原工作区'; item.fields.范围 = '旧格式工作区' }
    if (item.kind === 'object') item.fields.身份 = 'dot ID'
    item.children.forEach(mark)
  }
  roots.forEach(mark)
  return roots
}

export function legacyPlan(archive: LegacyArchive): SkillPlan | null {
  const plan = archive.record.skillPlan
  if (!plan) return null
  const skills: SelectedSkill[] = plan.skills.map(skill => ({
    id: skill.id, name: skill.name, description: skill.description ?? '',
    group: skill.group || (skill.id.includes('/') ? skill.id.split('/')[0]! : '未记录文件夹'), reason: skill.reason ?? '未保存选择理由', contentHash: skill.contentHash,
    files: (skill.files ?? []).map(file => ({ path: file.path, hash: file.hash, bytes: file.bytes, encoding: file.encoding })),
  }))
  return { id: plan.id, skills }
}

export function legacyViews(archive: LegacyArchive): C4View[] {
  return (archive.record.legacyContextSnapshot?.c4Views ?? []).map(view => ({ ...view, edges: (view.edges ?? []).map(edge => ({ ...edge, points: (edge.points ?? []).filter(point => point.length >= 2).map(point => [point[0]!, point[1]!] as [number, number]) })) }))
}
