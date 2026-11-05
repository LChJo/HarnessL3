export type Meta = Record<string, string | string[]>
export type ModelNode = { id: string; title: string; description: string; kind: string; metadata: Meta }
export type Brief = { id: string; title: string; brief: string; parentId: string; children: number }
export type Relation = { id: string; source: string; target: string; kind: string; title?: string; description?: string; metadata: Meta; scope?: string }
export type SourceVersion = { branch?: string; commit?: string; dirty?: boolean; evidenceDigest?: string }
export type Evidence = { id: string; path: string; claim?: string; startLine?: number; endLine?: number; freshness?: string }
export type C4View = { id: string; title?: string; description?: { txt?: string }; bounds: { x: number; y: number; width: number; height: number }; nodes: { id: string; modelRef?: string; title: string; technology?: string; children?: string[]; parent?: string | null; x: number; y: number; width: number; height: number }[]; edges: { id: string; source: string; target: string; label?: string; points: number[][]; line?: string }[] }
export type HistoryInfo = { retentionDays: number; expiresAt: string | null; expired: boolean; snapshotId: string | null; snapshotStatus: 'complete' | 'partial'; throughBatchId?: string | null; totalBatches?: number }
export type HistoryPage = { tasks: TaskSummary[]; total: number; offset: number; limit: number; hasMore: boolean; retentionDays: number }
export type TaskSnapshot = { id: string | null; status: 'complete' | 'partial'; note?: string; snapshot: Snapshot }
export type ContextBody = ModelNode & { ancestors: { id: string; title: string }[]; relationships: Relation[]; modelRevision: string; sourceVersion?: SourceVersion; contentHash: string; sourceState: { status: string; scope: string } }
export type Query = { expand?: string[]; read?: string[]; known?: Record<string, string> }
export type QueryResult = { taskId: string; batchId: string; modelRevision: string; directories: { id: string; title: string; items: Brief[] }[]; contexts: ContextBody[]; unchanged: { id: string; contentHash: string }[]; errors: { id: string; operation: string; message: string }[]; durationMs: number }
export type Batch = { id: string; status: string; client: string; requestedAt: string; completedAt?: string; request: { expand: string[]; read: string[] }; result?: QueryResult; error?: string; skillPlan?: TaskSkillPlan }
export type TaskSummary = { id: string; title: string; client: string; clients?: string[]; selectionMode: string; worktreeId: string; modelRevision: string; createdAt?: string; updatedAt: string; contextCount: number; batchCount?: number; history?: HistoryInfo; skillCount?: number | null; sourceRoot?: string; sourceVersion?: SourceVersion }
export type Task = TaskSummary & { outdated: boolean; sessionId: string | null; disclosedIds: string[]; batches: Batch[]; packet: { modelRevision: string; contexts: ContextBody[] }; skillRouting?: SkillRouting | null; skillPlan?: TaskSkillPlan | null }
export type Snapshot = { modelStatus: string; revision: string; elements: ModelNode[]; relationships?: Relation[]; evidence?: Evidence[]; c4Views?: C4View[]; source?: { status: string }; sourceVersion: SourceVersion; runtime: { sourceRoot: string } }
export const meta = (node: ModelNode, key: string) => Array.isArray(node.metadata?.[key]) ? (node.metadata[key] as string[]).join(', ') : node.metadata?.[key] ?? '未知'
export function packetText(task: Task) {
  const field = (value: string | string[] | undefined) => Array.isArray(value) ? value.join(', ') : value ?? '未知'
  const header = [`# ${task.title}`, `任务: ${task.id}`, `工作区: ${task.worktreeId}`, `模型快照: ${task.modelRevision}`, `范围: 精确选择的 ${task.packet.contexts.length} 个对象；祖先和其他端点仅为定位/边界引用`]
  const bodies = task.packet.contexts.map(node => [
    `\n## ${node.title} (${node.id})`, node.description,
    `来源: ${meta(node, 'source')}; 状态: ${meta(node, 'status')}`,
    `证据: ${meta(node, 'evidence')}`, `源码引用: ${meta(node, 'path')}`,
    `来源版本: ${node.sourceVersion?.branch ?? '未知'} @ ${node.sourceVersion?.commit ?? '未知'}`,
    `位置: ${node.ancestors.map(n => n.title).join(' / ')}`, `内容指纹: ${node.contentHash}`,
    `证据文件状态: ${node.sourceState.status}（不代表全项目同步）`,
    ...node.relationships.map(r => `- 边界引用: ${r.source} --${r.kind}--> ${r.target}; 来源 ${field(r.metadata.source)}; 状态 ${field(r.metadata.status)}; 证据 ${field(r.metadata.evidence)}${r.description ? '; ' + r.description : ''}`),
  ].join('\n'))
  return [...header, ...bodies].join('\n')
}
import type { SkillBrief, SkillPlan, SkillSelection } from './skill-layout'
export type SkillFile = { path: string; content: string; encoding: 'utf8' | 'base64'; hash: string; bytes: number }
export type TaskSkillPlan = Omit<SkillPlan, 'skills'> & { routerVersion: string; client: string; skills: (Omit<SkillSelection, 'files'> & { description: string; group: string; files: SkillFile[] })[] }
export type SkillRouting = { status: 'awaiting-selection' | 'selected' | 'unknown'; catalogRevision: string; catalog: SkillBrief[]; routerVersion: string; preparedAt: string; libraryRoot?: string }
