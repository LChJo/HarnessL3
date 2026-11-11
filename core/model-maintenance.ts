import { loadModel } from './model.js'
import { HarnessError } from './errors.js'
import type { Diagnostic, ModelSnapshot } from './types.js'
import type { FreshnessState } from './freshness.js'

export const MODEL_GUIDANCE_VERSION = 'model-maintenance/1'
export type MaintenanceMode = 'supplement' | 'revise' | 'rebuild'
export const maintenanceCommand = (mode: MaintenanceMode = 'supplement') => ['harnessl3', 'model', 'maintain', '--mode', mode]

/** Instructions for the current agent, never an invocation of another model. */
export function modelGuidance(mode: MaintenanceMode): string {
  const intent = {
    supplement: 'Supplement missing or newly implemented responsibilities, components, dependencies, evidence and views within the reviewed scope. Retain unrelated correct content.',
    revise: 'Revise existing decomposition, descriptions, relationships and views against the current sources. Review moved, renamed or removed responsibilities and repair current incoming references.',
    rebuild: 'Reassess the declared scope from current sources and reorganize its model and views. Rebuild means semantic reworking, not deleting .harness or resetting identities. Map existing entities to their continuing responsibilities before editing.',
  }[mode]
  return [
    `Model maintenance ${MODEL_GUIDANCE_VERSION}; mode=${mode}. Guidance is ready; semantic work is not assessed or completed.`,
    intent,
    'Use the current agent and existing file tools. Read model validate --help and its installed Usage guide authoring example; then read existing .harness/model/*.c4 and *.likec4, evidence.json and aliases.json. Preserve projectId, worktreeId and each continuing entity harness_id; generate UUIDs only for genuinely new entities. Keep historical snapshots and task bytes unchanged. A rebuild does not authorize deleting user files, changing exclusions, committing or pushing.',
    'Report reading progress. Inspect project goals, actual entry points, composition and key source implementations. Use prior retained reading where suitable and read changed or missing scope. Distinguish production, prototype/history and external boundaries. Separate planned from implemented responsibilities: a young project may have a small accurate model; extend it as implementations appear. Do not infer architecture solely from directory names or fabricate components to meet counts.',
    'Report modeling progress. Compare actual responsibilities with existing objects: split substantial subsystems when their responsibilities and evidence justify it; retain useful composition hierarchy. Review representative end-to-end paths and cross-module dependencies. Express actual relation semantics rather than labeling every relationship a call. Add useful local descriptions for complex boundaries, evidence claims, actual paths/ranges and full-file hashes; distinguish fact, human declaration, inference and unknown review scope.',
    'Review view coverage. Provide a useful module overview and necessary subsystem or flow-focused static views. Check the actual nodes and edges of every view: include * can show only top-level roots, while app.* shows direct children. Important modeled leaves should appear in a suitable view or have an explicitly disclosed scope omission. A root-only boundary view is valid but cannot substitute for internal module views. Do not force all nodes into one graph, impose fixed node/depth quotas or mistake a dense graph for completeness.',
    'When adding, moving, renaming or deleting source or durable documents, update affected objects, relationships, descriptions, evidence paths, aliases and current incoming references in the same stage. Preserve harness_id for the same semantic entity, advance its knowledge version when meaning changes, remove obsolete current references and preserve history. If a reviewed change has no semantic effect, record that conclusion with its actual scope and evidence.',
    'Report validation progress. Run harnessl3 model validate --json and inspect actual topology and view coverage through Web or the core read model. Repair material gaps in the claimed scope. Parsing, file hashes, guidance return and topology hints do not prove semantic completeness; disclose uncovered scope and unresolved diagnostics. Re-read changed authority before editing; concurrent edits require fresh review.',
    'For stage completion use harnessl3 sync status --json and the existing sync verify scoped proof/CAS workflow after reviewing the current changes. This guidance does not scan source, clear pending state or certify sources. A source/model race requires a fresh review and new declaration. If the work requires a new model binding, start a new task after edits; old tasks retain their original model and graph. Do not close unfinished tasks or rewrite their bindings.',
  ].join('\n\n')
}

export function modelMaintenanceHint(state: Pick<FreshnessState, 'state' | 'pendingPaths' | 'modelPending'>) {
  return {
    state: state.pendingPaths.length || state.modelPending ? 'review-required' : state.state === 'unknown' || state.state === 'failed' ? 'unknown' : 'no-pending-observed',
    semanticStatus: 'not-assessed' as const,
    command: maintenanceCommand(),
  }
}

function inspectTopology(model: ModelSnapshot) {
  const objects = model.entities.filter(entity => entity.entityType === 'object')
  const relations = model.entities.filter(entity => entity.entityType === 'relation')
  const parents = new Set(objects.map(entity => entity.parentId).filter(Boolean))
  const represented = new Set<string>()
  const hints: { code: string; message: string }[] = []
  const views = (model.views as { id: string; title?: string | null; nodes: { harnessId?: string | null; id: string }[]; edges: unknown[] }[]).map(view => {
    for (const node of view.nodes) if (node.harnessId) represented.add(node.harnessId)
    if (objects.length > 1 && view.nodes.length === 1 && objects.some(object => !object.parentId && view.nodes[0]?.harnessId === object.id)) {
      hints.push({ code: 'ROOT_ONLY_VIEW', message: `${view.id} shows only a project boundary; review internal views separately.` })
    }
    return { id: view.id, title: view.title ?? null, nodes: view.nodes.length, edges: view.edges.length }
  })
  const maxDepth = objects.reduce((depth, entity) => Math.max(depth, entity.locator.split('.').length), 0)
  if (objects.length === 1) hints.push({ code: 'ROOT_ONLY_MODEL', message: 'Only one object is modeled; compare it with the actual project responsibilities before declaring coverage.' })
  else if (maxDepth <= 2) hints.push({ code: 'FLAT_MODEL_REVIEW', message: 'The model has no nested subsystems below direct children; assess whether the reviewed scope needs further decomposition.' })
  if (!relations.length) hints.push({ code: 'NO_RELATIONSHIPS', message: 'No relationships are modeled; check actual dependencies in the reviewed scope.' })
  if (!views.length) hints.push({ code: 'NO_VIEWS', message: 'No named structure views are available.' })
  const unrepresentedLeaves = objects.filter(object => !parents.has(object.id) && !represented.has(object.id)).map(({ id, locator, title }) => ({ id, locator, title }))
  if (unrepresentedLeaves.length) hints.push({ code: 'UNREPRESENTED_LEAVES', message: 'Some modeled leaf objects appear in no view; add appropriate views or disclose intentional scope omissions.' })
  return { topology: { objects: objects.length, relations: relations.length, maxDepth, views }, coverage: { scope: 'model-views-only' as const, unrepresentedLeaves, hints } }
}

/** Model/evidence reads only; observations are supplied as last-known state, never reconciled here. */
export async function modelMaintenance(root: string, mode: MaintenanceMode, observed?: FreshnessState) {
  let model: ModelSnapshot | null = null, modelRevision: string | null = null, diagnostics: Diagnostic[] = []
  try { model = await loadModel(root); modelRevision = model.revision; diagnostics = model.diagnostics }
  catch (error) {
    if (!(error instanceof HarnessError) || error.code !== 'MODEL_INVALID') throw error
    modelRevision = typeof error.details.attemptedModelRevision === 'string' ? error.details.attemptedModelRevision : null
    diagnostics = error.details.diagnostics as Diagnostic[] ?? []
  }
  return {
    promptVersion: MODEL_GUIDANCE_VERSION, mode, stage: 'guidance-ready' as const, semanticStatus: 'not-assessed' as const,
    worktreeRoot: root, sourceScan: 'not-requested' as const, modelState: model ? 'valid' as const : 'invalid' as const, modelRevision,
    files: { model: '.harness/model/', evidence: '.harness/evidence.json', aliases: '.harness/aliases.json' },
    ...(model ? inspectTopology(model) : { topology: null, coverage: null }), diagnostics,
    observedSource: observed ? { scope: 'last-observed' as const, state: observed.state, sourceEpoch: observed.sourceEpoch, sourceVersion: observed.sourceVersion, sourceScanRevision: observed.sourceScanRevision, checkedAt: observed.lastCheckedAt, pendingPaths: observed.pendingPaths } : null,
    agentPrompt: modelGuidance(mode), nextCommands: [['harnessl3', 'model', 'validate', '--json'], ['harnessl3', 'sync', 'status', '--json'], ['harnessl3', 'sync', 'verify', '--help']],
  }
}
