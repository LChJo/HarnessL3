import type { Diagnostic, FileRef, ModelSnapshot, SkillBrief, Target, TaskRecord, WorktreeRecord } from '../core/types'
import type { Task as PrototypeTask, Snapshot as PrototypeSnapshot } from '../src/context-types'

export type { Binding, ContextBody, Diagnostic, Entity, Evidence, FileRef, ModelSnapshot, Packet, ProjectRecord, SelectedSkill, SkillBrief, SkillPlan, TaskBatch, TaskRecord, WorktreeRecord } from '../core/types'
export interface LegacyArchive {
  kind: 'legacy-archive'; status: 'complete'; format: 'prototype-v0.16'; taskId: string; throughBatchId: string | null; completeness: 'complete' | 'partial' | 'unknown'
  binding: { modelRevision: string | null; catalogRevision: string | null; sourceVersion: null; sourceScanRevision: null }
  record: Partial<PrototypeTask> & {
    legacyContextSnapshot?: Partial<PrototypeSnapshot> | null
    legacyArchive?: { unknown?: string[]; legacyBinding?: unknown; snapshotId?: string | null }
    legacyRead?: { files: { skillId: string; file: FileRef & { content: string } }[]; errors: { skillId: string; path: string; code: string }[] }
  }
}
export interface ViewData {
  schemaVersion: 1; target: Target; worktree: WorktreeRecord; seq: number; historical: boolean
  task: TaskRecord | null; model: ModelSnapshot | null
  legacy?: LegacyArchive
  modelState: { state: 'valid' | 'invalid' | 'unknown'; currentRevision: string | null; displayRevision: string | null; diagnostics: Diagnostic[] }
  catalog: { root: string | null; revision: string | null; skills: SkillBrief[]; valid: boolean; diagnostics: Diagnostic[]; checkedAt: string | null }
  freshness: unknown; observation: { bindings: unknown[]; events: unknown[] }; archive: unknown
}
export interface TaskSummary {
  id: string; title: string; binding: { modelRevision: string }; createdAt: string | null; lastReadAt: string | null
  retentionBasisAt: string | null; expiresAt: string | null; closedAt: string | null; contextCount: number; skillCount: number
  completeness: string; format: string
}
export interface HistoryResult { items: TaskSummary[]; total: number; limit: number; offset: number; hasMore: boolean; retentionDays: 60 }
export interface C4View {
  id: string; title?: string | null; description?: string | { txt?: string; md?: string } | null
  bounds: { x: number; y: number; width: number; height: number }
  nodes: { id: string; modelRef?: string; harnessId?: string | null; title: string; technology?: string; children?: string[]; x: number; y: number; width: number; height: number }[]
  edges: { id: string; source: string; target: string; harnessIds?: string[]; points: [number, number][]; label?: string; line?: string }[]
}
export type Rpc = <T = unknown>(operation: string, options?: { id?: string; input?: unknown; flags?: Record<string, string | boolean>; worktree?: string; requestId?: string }) => Promise<T>
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
export const pretty = (value: unknown) => JSON.stringify(value, null, 2)
export const time = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未知'
