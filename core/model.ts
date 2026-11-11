import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { join, relative, isAbsolute, sep } from 'node:path'
import { LikeC4 } from 'likec4'
import { FqnRef, type Fqn, type RelationId } from '@likec4/core'
import { HarnessError } from './errors.js'
import { canonicalJson, digest, sha256, parseJsonStrict } from './json.js'
import { validateContract } from './contract.js'
import { reportProgress } from './progress.js'
import { permissionError } from './errors.js'
import { documentGitDiagnostics } from './references.js'
import type { Brief, ContextBody, Diagnostic, Directory, Entity, Evidence, ModelSnapshot, SourceVersion } from './types.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const sourceValues = new Set(['fact', 'human', 'inference'])
const statusValues = new Set(['verified', 'needs-review', 'unknown'])
const fields = ['harness_id', 'brief', 'source', 'status', 'evidence', 'version'] as const
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const inside = (root: string, path: string) => {
  const local = relative(root, path)
  return !isAbsolute(local) && local !== '..' && !local.startsWith('..' + sep)
}
const relativeFile = (root: string, file: string) => relative(root, file).split(sep).join('/')
const plain = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  return [record.txt, record.md, record.text].find((item): item is string => typeof item === 'string') ?? ''
}
interface CapturedSource { path: string; bytes: Buffer; text: string; firstLine: number }
interface ParsedEntity {
  id: string; title?: unknown; description?: unknown; kind?: string; metadata?: Record<string, unknown>
  source?: Parameters<typeof FqnRef.flatten>[0]; target?: Parameters<typeof FqnRef.flatten>[0]
}
interface ParsedData {
  elements: Record<string, ParsedEntity>; relations: Record<string, ParsedEntity>
  specification: { elements: Record<string, unknown>; relationships: Record<string, unknown> }
  views: Record<string, { sourcePath?: string }>
}

function invalid(diagnostics: Diagnostic[]): never {
  throw new HarnessError('MODEL_INVALID', 'The current LikeC4 model or its tracked references are invalid.', { diagnostics })
}

function decode(bytes: Buffer, file: string): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return invalid([{ code: 'MODEL_ENCODING', severity: 'error', file, line: 1, column: 1, message: 'Model and JSON files must contain valid UTF-8.' }]) }
}

async function modelSources(root: string, strict = true): Promise<CapturedSource[]> {
  const directory = join(root, '.harness', 'model')
  const resolved = await realpath(directory)
  if (!inside(root, resolved)) invalid([{ code: 'MODEL_PATH', severity: 'error', file: '.harness/model', message: 'The model directory resolves outside the worktree boundary.' }])
  const files: string[] = []
  const ancestors = new Set<string>()
  async function visit(dir: string): Promise<void> {
    const actual = await realpath(dir)
    if (!inside(root, actual)) invalid([{ code: 'MODEL_PATH', severity: 'error', file: relativeFile(root, dir), message: 'A model link resolves outside the worktree boundary.' }])
    if (ancestors.has(actual)) invalid([{ code: 'MODEL_PATH', severity: 'error', file: relativeFile(root, dir), message: 'A model directory link contains a cycle.' }])
    ancestors.add(actual)
    try {
      const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))
      for (const entry of entries) {
        const path = join(dir, entry.name)
        const target = await realpath(path)
        if (!inside(root, target)) invalid([{ code: 'MODEL_PATH', severity: 'error', file: relativeFile(root, path), message: 'A model link resolves outside the worktree boundary.' }])
        const info = entry.isSymbolicLink() ? await stat(path) : entry
        if (info.isDirectory()) await visit(path)
        else if (info.isFile() && /\.(?:c4|likec4)$/.test(entry.name)) files.push(path)
      }
    } finally { ancestors.delete(actual) }
  }
  await visit(directory)
  files.sort((a, b) => compare(relativeFile(root, a), relativeFile(root, b)))
  if (!files.length) invalid([{ code: 'MODEL_MISSING', severity: 'error', file: '.harness/model', message: 'At least one .c4 or .likec4 model file is required.' }])
  let firstLine = 0
  const sources: CapturedSource[] = []
  for (const file of files) {
    const bytes = await readFile(file)
    const text = strict ? decode(bytes, relativeFile(root, file)) : ''
    sources.push({ path: relativeFile(root, file), bytes, text, firstLine })
    firstLine += text.split('\n').length
  }
  return sources
}

function position(sources: CapturedSource[], line: number, column = 0): Pick<Diagnostic, 'file' | 'line' | 'column'> {
  const source = sources.find((item, index) => line >= item.firstLine && (index === sources.length - 1 || line < sources[index + 1]!.firstLine)) ?? sources[0]!
  return { file: source.path, line: Math.max(1, line - source.firstLine + 1), column: column + 1 }
}

function entityPosition(sources: CapturedSource[], item: ParsedEntity, parser?: LikeC4): Pick<Diagnostic, 'file' | 'line' | 'column'> {
  const location = parser?.languageServices.locate(item.source ? { relation: item.id as RelationId } : { element: item.id as Fqn })
  if (location) return position(sources, location.range.start.line, location.range.start.character)
  const id = item.metadata?.harness_id
  const candidates = typeof id === 'string' ? [id] : [item.id.split('.').at(-1) ?? item.id]
  for (const source of sources) {
    for (const candidate of candidates) {
      const index = source.text.indexOf(candidate)
      if (index < 0) continue
      const prefix = source.text.slice(0, index)
      return { file: source.path, line: prefix.split('\n').length, column: index - prefix.lastIndexOf('\n') }
    }
  }
  return { file: sources[0]!.path, line: 1, column: 1 }
}

async function trackedBytes(root: string, name: string): Promise<Buffer> {
  const file = join(root, '.harness', `${name}.json`)
  const actual = await realpath(file)
  if (!inside(root, actual)) invalid([{ code: 'MODEL_PATH', severity: 'error', file: `.harness/${name}.json`, message: 'Tracked JSON resolves outside the worktree boundary.' }])
  return readFile(file)
}

function trackedJson<T>(name: string, bytes: Buffer): { value: T; bytes: Buffer } {
  try { return { value: validateContract<T>(name, parseJsonStrict(decode(bytes, `.harness/${name}.json`))), bytes } }
  catch (error) {
    if (error instanceof HarnessError && error.code === 'MODEL_INVALID') throw error
    const issues = error instanceof HarnessError && Array.isArray(error.details.diagnostics) ? error.details.diagnostics : []
    invalid([{ code: 'MODEL_REFERENCE_SCHEMA', severity: 'error', file: `.harness/${name}.json`, line: 1, column: 1, message: `${error instanceof Error ? error.message : String(error)}${issues.length ? ': ' + issues.map(issue => `${(issue as { path?: string }).path ?? ''} ${(issue as { message?: string }).message ?? ''}`).join('; ') : ''}` }])
  }
}

function revisionFor(sources: CapturedSource[], evidence: Buffer, aliases: Buffer): string {
  const manifest = sources.map(source => ({ path: source.path.slice('.harness/'.length), hash: sha256(source.bytes) }))
  manifest.push({ path: 'evidence.json', hash: sha256(evidence) }, { path: 'aliases.json', hash: sha256(aliases) })
  manifest.sort((a, b) => compare(a.path, b.path))
  return digest('model-revision', manifest)
}

/** Raw-byte observation only. A fingerprint is never a claim that the model parses or validates. */
export async function captureModelRevision(worktreeRoot: string): Promise<string | null> {
  try {
    const root = await realpath(worktreeRoot)
    const [sources, evidence, aliases] = await Promise.all([modelSources(root, false), trackedBytes(root, 'evidence'), trackedBytes(root, 'aliases')])
    return revisionFor(sources, evidence, aliases)
  } catch { return null }
}

/** Check boundary even when the cited file itself is missing. Never dereference a URL. */
async function evidencePath(root: string, path: string): Promise<string> {
  let current = join(root, ...path.split('/'))
  while (true) {
    try {
      const actual = await realpath(current)
      if (!inside(root, actual)) invalid([{ code: 'EVIDENCE_PATH', severity: 'error', file: '.harness/evidence.json', line: 1, column: 1, message: `Evidence path ${path} resolves outside the worktree boundary.` }])
      return join(root, ...path.split('/'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = join(current, '..')
      if (parent === current) throw error
      current = parent
    }
  }
}

/** Parse precisely the captured bytes. No workspace config or source-generating script is loaded. */
export async function loadModel(worktreeRoot: string): Promise<ModelSnapshot> {
  reportProgress({ phase: 'loading-model' })
  let parser: LikeC4 | undefined
  let sources: CapturedSource[] = []
  let attemptedModelRevision: string | null = null
  try {
    const root = await realpath(worktreeRoot)
    const captured = await Promise.all([modelSources(root, false), trackedBytes(root, 'evidence'), trackedBytes(root, 'aliases')])
    sources = captured[0]
    attemptedModelRevision = revisionFor(sources, captured[1], captured[2])
    let firstLine = 0
    for (const source of sources) { source.text = decode(source.bytes, source.path); source.firstLine = firstLine; firstLine += source.text.split('\n').length }
    const evidenceJson = trackedJson<{ schemaVersion: 1; evidence: Evidence[] }>('evidence', captured[1])
    const aliasesJson = trackedJson<{ schemaVersion: 1; aliases: Record<string, string> }>('aliases', captured[2])
    const diagnostics: Diagnostic[] = []
    const proofIds = new Set<string>()
    for (const proof of evidenceJson.value.evidence) {
      if (proofIds.has(proof.id)) diagnostics.push({ code: 'EVIDENCE_DUPLICATE', severity: 'error', file: '.harness/evidence.json', line: 1, column: 1, message: `Duplicate evidence UUID: ${proof.id}` })
      proofIds.add(proof.id)
      if (proof.range && proof.range.startLine > proof.range.endLine) diagnostics.push({ code: 'EVIDENCE_RANGE', severity: 'error', file: '.harness/evidence.json', line: 1, column: 1, message: `Evidence range startLine exceeds endLine: ${proof.id}` })
      if ('url' in proof.location) {
        if (proof.hash !== null || proof.observedAt !== null) diagnostics.push({ code: 'EVIDENCE_URL_UNKNOWN', severity: 'error', file: '.harness/evidence.json', line: 1, column: 1, message: `External URL evidence must leave hash/observedAt null: ${proof.id}` })
        continue
      }
      const path = await evidencePath(root, proof.location.path)
      try {
        const bytes = await readFile(path)
        if (proof.hash && sha256(bytes) !== proof.hash) diagnostics.push({ code: 'EVIDENCE_CHANGED', severity: 'warning', file: proof.location.path, evidenceId: proof.id, message: `Evidence file bytes changed: ${proof.id}` })
      } catch (error) {
        diagnostics.push({ code: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'EVIDENCE_MISSING' : 'EVIDENCE_UNREADABLE', severity: 'warning', file: proof.location.path, evidenceId: proof.id, message: `Evidence file is ${(error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable'}: ${proof.id}` })
      }
    }
    diagnostics.push(...await documentGitDiagnostics(root, evidenceJson.value.evidence))
    parser = await LikeC4.fromSource(sources.map(source => source.text).join('\n'), { logger: false, printErrors: false, watch: false })
    for (const error of parser.getErrors()) diagnostics.push({ code: 'LIKEC4_INVALID', severity: 'error', message: error.message, ...position(sources, error.range.start.line, error.range.start.character) })
    if (diagnostics.some(item => item.severity === 'error')) invalid(diagnostics)
    const data = (await parser.parsedModel()).$data as unknown as ParsedData
    const all = [...Object.values(data.elements), ...Object.values(data.relations)]
    const ids = new Set<string>()
    const byLocator = new Map<string, string>()
    for (const item of all) {
      const metadata = item.metadata ?? {}
      const fail = (message: string) => diagnostics.push({ code: 'MODEL_FIELD', severity: 'error', message, ...entityPosition(sources, item, parser) })
      for (const field of fields) if (typeof metadata[field] !== 'string' || !(metadata[field] as string).trim()) fail(`${item.id}: ${field} must contain one nonempty scalar string; duplicate fields and arrays are invalid.`)
      if (typeof metadata.harness_id === 'string') {
        if (!uuid.test(metadata.harness_id)) fail(`${item.id}: harness_id must be a lowercase UUID.`)
        if (ids.has(metadata.harness_id)) fail(`${item.id}: duplicate harness_id UUID ${metadata.harness_id}.`)
        ids.add(metadata.harness_id)
        if (data.elements[item.id]) byLocator.set(item.id, metadata.harness_id)
      }
      if (typeof metadata.brief === 'string' && /[\r\n]/.test(metadata.brief)) fail(`${item.id}: brief must not contain a newline.`)
      if (!sourceValues.has(metadata.source as string)) fail(`${item.id}: source must be fact, human, or inference.`)
      if (!statusValues.has(metadata.status as string)) fail(`${item.id}: status must be verified, needs-review, or unknown.`)
      if (metadata.source === 'inference' && metadata.status === 'verified') fail(`${item.id}: inference cannot have verified status.`)
      const evidence = typeof metadata.evidence === 'string' && metadata.evidence !== 'none' ? metadata.evidence.split(' ') : []
      const validEvidence = !evidence.some(id => !uuid.test(id)) && new Set(evidence).size === evidence.length
      if (!validEvidence) fail(`${item.id}: evidence must be none or unique UUIDs separated by a single space, not commas. Write one scalar string, without arrays or duplicate IDs.`)
      // Resolve references only after validating the list syntax. A malformed
      // comma-joined scalar is not a missing evidence record.
      if (validEvidence) for (const id of evidence) if (!proofIds.has(id)) fail(`${item.id}: evidence UUID does not exist: ${id}.`)
      if (metadata.status === 'verified' && evidence.length === 0) fail(`${item.id}: verified status requires at least one resolvable evidence UUID.`)
      const specification = data.elements[item.id] ? data.specification.elements : data.specification.relationships
      if (!item.kind || !Object.hasOwn(specification, item.kind)) fail(`${item.id}: kind must be declared in the LikeC4 specification. ${data.elements[item.id] ? 'Declare an element kind and use it on the object.' : 'For example, declare relationship calls and use source -[calls]-> target; a bare -> has no kind.'}`)
    }
    const aliases = aliasesJson.value.aliases
    for (const [locator, target] of Object.entries(aliases)) {
      if (!byLocator.has(locator) && !Object.values(data.elements).some(item => item.metadata?.harness_id === target)) diagnostics.push({ code: 'ALIAS_TARGET', severity: 'error', file: '.harness/aliases.json', line: 1, column: 1, message: `Alias target does not exist as a current object: ${locator} -> ${target}.` })
      else if (byLocator.has(locator) && byLocator.get(locator) !== target) diagnostics.push({ code: 'ALIAS_AMBIGUOUS', severity: 'error', file: '.harness/aliases.json', line: 1, column: 1, message: `Alias locator is occupied by a different current UUID: ${locator}.` })
    }
    if (diagnostics.some(item => item.severity === 'error')) invalid(diagnostics)
    const entities: Entity[] = []
    for (const item of all) {
      const metadata = item.metadata as Record<(typeof fields)[number], string>
      const object = Object.hasOwn(data.elements, item.id)
      const source = !object && item.source ? FqnRef.flatten(item.source) : null
      const target = !object && item.target ? FqnRef.flatten(item.target) : null
      const parentLocator = object && item.id.includes('.') ? item.id.slice(0, item.id.lastIndexOf('.')) : null
      const entity: Entity = {
        id: metadata.harness_id, locator: object ? item.id : `${source} -[${item.kind}]-> ${target}`,
        entityType: object ? 'object' : 'relation', title: plain(item.title), kind: item.kind!, brief: metadata.brief,
        description: plain(item.description), source: metadata.source as Entity['source'], status: metadata.status as Entity['status'],
        evidenceIds: metadata.evidence === 'none' ? [] : metadata.evidence.split(' '), version: metadata.version,
        parentId: parentLocator ? byLocator.get(parentLocator) ?? null : null,
      }
      if (!object) {
        if (!source || !target || !byLocator.has(source) || !byLocator.has(target)) invalid([{ code: 'MODEL_ENDPOINT', severity: 'error', ...entityPosition(sources, item, parser), message: `Relationship endpoints must resolve to current objects: ${item.id}.` }])
        entity.sourceId = byLocator.get(source)!
        entity.targetId = byLocator.get(target)!
      }
      entities.push(entity)
    }
    canonicalJson(entities)
    const revision = attemptedModelRevision
    const namedViews = new Set(Object.entries(data.views).filter(([, view]) => view.sourcePath).map(([id]) => id))
    const relationIds = new Map(Object.values(data.relations).map(item => [item.id, item.metadata!.harness_id as string]))
    const views = namedViews.size ? Object.values((await parser.layoutedModel()).$data.views).filter(view => namedViews.has(view.id)).map(view => ({
      ...JSON.parse(JSON.stringify(view)),
      nodes: view.nodes.map(node => ({ ...JSON.parse(JSON.stringify(node)), harnessId: byLocator.get(String(node.modelRef ?? node.id)) ?? null })),
      edges: view.edges.map(edge => ({ ...JSON.parse(JSON.stringify(edge)), harnessIds: edge.relations.map(id => relationIds.get(id)).filter((id): id is string => !!id) })),
    })) : []
    return { revision, entities, evidence: evidenceJson.value.evidence, aliases, views, diagnostics }
  } catch (error) {
    const permission = permissionError(error)
    if (permission) throw permission
    if (error instanceof HarnessError && error.code === 'MODEL_INVALID') throw new HarnessError('MODEL_INVALID', error.message, { ...error.details, attemptedModelRevision })
    throw new HarnessError('MODEL_INVALID', 'The current LikeC4 model or its tracked references are invalid.', { attemptedModelRevision, diagnostics: [{ code: 'MODEL_LOAD', severity: 'error', file: '.harness/model', line: 1, column: 1, message: error instanceof Error ? error.message : String(error) }] })
  } finally { await parser?.dispose() }
}

interface ModelIndex { byId: Map<string, Entity>; children: Map<string | null, Entity[]>; boundaries: Map<string, Entity[]> }
const indexes = new WeakMap<ModelSnapshot, ModelIndex>()
function modelIndex(snapshot: ModelSnapshot): ModelIndex {
  const retained = indexes.get(snapshot)
  if (retained) return retained
  const index: ModelIndex = { byId: new Map(), children: new Map(), boundaries: new Map() }
  for (const entity of snapshot.entities) {
    index.byId.set(entity.id, entity)
    if (entity.entityType === 'object') {
      const siblings = index.children.get(entity.parentId) ?? []
      siblings.push(entity)
      index.children.set(entity.parentId, siblings)
    } else {
      for (const endpoint of new Set([entity.sourceId!, entity.targetId!])) {
        const boundary = index.boundaries.get(endpoint) ?? []
        boundary.push(entity)
        index.boundaries.set(endpoint, boundary)
      }
    }
  }
  indexes.set(snapshot, index)
  return index
}

function brief(index: ModelIndex, entity: Entity): Brief {
  return { id: entity.id, locator: entity.locator, entityType: entity.entityType, title: entity.title, kind: entity.kind, brief: entity.brief, parentId: entity.parentId, children: index.children.get(entity.id)?.length ?? 0 }
}

export function modelDirectory(snapshot: ModelSnapshot, parentId: string | null = null): Directory {
  const index = modelIndex(snapshot)
  if (parentId !== null) {
    const parent = index.byId.get(parentId)
    if (!parent) throw new HarnessError('ENTITY_NOT_FOUND', `Unknown model entity UUID: ${parentId}`)
    if (parent.entityType !== 'object') throw new HarnessError('NOT_EXPANDABLE', `Relationships have no child directory: ${parentId}`)
  }
  return { parentId, items: (index.children.get(parentId) ?? []).map(entity => brief(index, entity)) }
}

export function modelBody(snapshot: ModelSnapshot, id: string, sourceVersion: SourceVersion): ContextBody {
  const index = modelIndex(snapshot)
  const entity = index.byId.get(id)
  if (!entity) throw new HarnessError('ENTITY_NOT_FOUND', `Unknown model entity UUID: ${id}`)
  const ancestors: Brief[] = []
  let parentId = entity.parentId
  while (parentId !== null) {
    const ancestor = index.byId.get(parentId)
    if (!ancestor || ancestors.some(item => item.id === parentId)) throw new HarnessError('MODEL_INVALID', 'The stored model containment hierarchy is invalid.', { diagnostics: [{ message: `Broken ancestor UUID ${parentId}` }] })
    ancestors.unshift(brief(index, ancestor))
    parentId = ancestor.parentId
  }
  const relationships = entity.entityType === 'relation' ? [] : (index.boundaries.get(id) ?? []).map(item => ({ id: item.id, sourceId: item.sourceId!, targetId: item.targetId!, kind: item.kind, brief: item.brief, scope: 'boundary-reference' as const }))
  const relatedProofs = relationships.flatMap(relation => index.byId.get(relation.id)!.evidenceIds)
  const evidenceIds = [...new Set([...entity.evidenceIds, ...relatedProofs])]
  const content = { entity: structuredClone(entity), ancestors, relationships, evidenceIds, modelRevision: snapshot.revision, sourceVersion: structuredClone(sourceVersion), scope: 'exact-entity' as const }
  return { ...content, contentHash: digest('context-body', content) }
}
