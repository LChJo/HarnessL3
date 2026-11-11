export interface Target { projectId: string; worktreeId: string }
export interface SourceVersion { head: string | null; treeHash: string | null; status: 'clean' | 'dirty' | 'unversioned' | 'unknown' }
export interface Binding extends Target { modelRevision: string; catalogRevision: string; sourceVersion: SourceVersion; sourceScanRevision: string | null; mode?: 'snapshot' | 'verified' }
export interface Diagnostic { message: string; code?: string; file?: string; line?: number; column?: number; severity?: 'error' | 'warning'; evidenceId?: string }
export interface ProjectConfig { schemaVersion: 1; projectId: string; name: string; source: { excludePatterns: string[] }; skills?: { root: string } }
export type WorkspaceKind = 'git' | 'directory';
export interface ProjectRecord { id: string; name: string; kind?: WorkspaceKind; gitCommonDir: string | null; active: boolean; configPath: string }
export interface WorktreeRecord { id: string; projectId: string; kind?: WorkspaceKind; root: string; gitCommonDir: string | null; branch: string | null; available: boolean; active: boolean; config?: ProjectConfig }
export interface Brief { id: string; locator: string; entityType: 'object' | 'relation'; title: string; kind: string; brief: string; parentId: string | null; children: number }
export interface Directory { parentId: string | null; items: Brief[] }
export interface Entity {
  id: string; locator: string; entityType: 'object' | 'relation'; title: string; kind: string; brief: string; description: string
  source: 'fact' | 'human' | 'inference'; status: 'verified' | 'needs-review' | 'unknown'; evidenceIds: string[]
  version: string; parentId: string | null; sourceId?: string; targetId?: string
}
export interface Evidence {
  id: string; kind: 'source-code' | 'document' | 'manual' | 'inference'; claim: string
  location: { path: string } | { url: string }; hash: string | null; observedAt: string | null
  range?: { startLine: number; endLine: number }; sourceVersion?: SourceVersion
}
export interface BoundaryRelation { id: string; sourceId: string; targetId: string; kind: string; brief: string; scope: 'boundary-reference' }
export interface ContextBody { entity: Entity; ancestors: Brief[]; relationships: BoundaryRelation[]; evidenceIds: string[]; modelRevision: string; sourceVersion: SourceVersion; contentHash: string; scope: 'exact-entity' }
export interface ModelSnapshot { revision: string; entities: Entity[]; evidence: Evidence[]; aliases: Record<string, string>; views: unknown[]; diagnostics: Diagnostic[] }
export interface FileRef { path: string; hash: string; bytes: number; encoding: 'utf8' | 'base64' }
export interface SkillBrief { id: string; name: string; group: string; description: string; contentHash: string; files: FileRef[]; related: string[]; diagnostics: string[] }
export interface SelectedSkill { id: string; name: string; group: string; description: string; contentHash: string; files: FileRef[]; reason: string }
export interface SkillCatalog { root: string; revision: string | null; skills: SkillBrief[]; diagnostics: Diagnostic[]; checkedAt: string; valid: boolean; files: Map<string, Buffer> }
export interface SkillPlan { id: string; batchId: string; routerVersion: string; catalogRevision: string; skills: SelectedSkill[]; observation: 'selection-recorded; execution-unknown' }
export interface QueryFields { expand: string[]; read: string[]; known: Record<string, string> }
export interface QueryRequest extends QueryFields { schemaVersion: 1; requestId: string; expectedModelRevision: string }
export interface SelectionRequest { schemaVersion: 1; requestId: string; binding: Binding; context: QueryFields; skills: { id: string; reason: string }[]; taskId?: string; stage?: boolean }
export interface FileReadRequest { schemaVersion: 1; requestId: string; throughBatchId?: string; files: { skillId: string; path: string; expectedHash?: string }[] }
export interface ItemError { operation: 'expand' | 'read' | 'skill-file'; id: string; path?: string; code: string; message: string }
export interface BatchResult { batchId: string; directories: Directory[]; contexts: ContextBody[]; unchanged: { id: string; contentHash: string; reason: 'retained-in-this-task' }[]; errors: ItemError[]; observation: 'reader-response-produced' }
export interface Packet { scope: 'returned-entities-only'; contexts: ContextBody[]; evidence: Evidence[] }
export interface TaskBatch { id: string; requestId: string; operation: string; request: unknown; result: BatchResult | null; createdAt: string; packet: Packet; skillPlan: SkillPlan | null; source?: 'cli' | 'web' }
export interface TaskRecord {
  schemaVersion: 1; id: string; title: string; binding: Binding; createdAt: string; updatedAt: string; lastReadAt: string | null
  retentionBasisAt: string; expiresAt: string; closedAt: string | null; declaredSession: string | null; source: 'cli' | 'web'
  initialDirectory: Directory; modelSnapshotHash: string; catalog: SkillBrief[]; batches: TaskBatch[]; packet: Packet; skillPlan: SkillPlan | null
}
export interface ErrorData { code: string; message: string; retryable: boolean; details: Record<string, unknown> }
export type Envelope<T = unknown> = { schemaVersion: 1; requestId: string; target: Target | null; replayed: boolean } & ({ ok: true; data: T } | { ok: false; error: ErrorData })
