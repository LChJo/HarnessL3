import type { Entity, ModelSnapshot, TaskRecord, ViewData } from './types'

export type Category = 'objects' | 'relations' | 'sources' | 'evidence' | 'versions'
export type MapItem = {
  id: string; title: string; brief: string; category: Category; kind: 'category' | 'group' | 'object' | 'body' | 'relation' | 'source' | 'evidence' | 'version' | 'overflow'
  children: MapItem[]; hit: boolean; hits: number; state: 'available' | 'disclosed' | 'returned' | 'reference' | 'associated' | 'aggregate'
  relatedIds: string[]; entityId?: string; objectId?: string; evidenceId?: string; fields: Record<string, string>
  overflowFor?: string; hiddenCount?: number; bodyFor?: string
}
const categories: [Category, string, string][] = [['objects', '对象', '项目由哪些部分组成'], ['relations', '关系', '这些部分如何协作'], ['sources', '来源', '这些声明从哪里来'], ['evidence', '证据', '回到具体依据核对'], ['versions', '版本', '本次上下文对应哪一版']]
const sourceName: Record<string, string> = { fact: '事实声明', human: '人工维护', inference: '推断' }
const statusName: Record<string, string> = { verified: '已核验声明', 'needs-review': '待核验', unknown: '未知' }
const evidenceName: Record<string, string> = { 'source-code': '源码依据', document: '文档依据', manual: '人工记录', inference: '推断依据' }
function node(category: Category, id: string, title: string, brief = '', rest: Partial<MapItem> = {}): MapItem { return { id, title, brief, category, kind: 'group', children: [], hit: false, hits: 0, state: 'available', relatedIds: [], fields: {}, ...rest } }
export function projectContext(model: ModelSnapshot | null, task: TaskRecord | null, view?: ViewData | null): MapItem[] {
  const roots = categories.map(([category, title, brief]) => node(category, 'category:' + category, title, brief, { kind: 'category' }))
  if (!model) return roots
  const category = (id: Category) => roots.find(item => item.category === id)!
  const entities = new Map(model.entities.map(entity => [entity.id, entity]))
  const objects = model.entities.filter(entity => entity.entityType === 'object')
  const children = new Map<string | null, Entity[]>()
  for (const object of objects) { const list = children.get(object.parentId) ?? []; list.push(object); children.set(object.parentId, list) }
  const bodies = task?.packet.contexts ?? []
  const returned = new Set(bodies.map(body => body.entity.id))
  const disclosed = new Set(task?.initialDirectory.items.map(item => item.id) ?? [])
  for (const batch of task?.batches ?? []) for (const directory of batch.result?.directories ?? []) for (const brief of directory.items) disclosed.add(brief.id)
  const boundaries = new Map<string, string[]>()
  for (const body of bodies) for (const relation of body.relationships) boundaries.set(relation.id, [...new Set([...(boundaries.get(relation.id) ?? []), body.entity.id])])
  const title = (id: string) => entities.get(id)?.title || entities.get(id)?.locator || id
  const owner = (id: string): Entity | undefined => {
    let item = entities.get(id)
    const seen = new Set<string>()
    while (item?.parentId && !seen.has(item.id)) { seen.add(item.id); item = entities.get(item.parentId) }
    return item
  }
  const fields = (entity: Entity) => ({ UUID: entity.id, 定位: entity.locator, 类型: entity.kind, 来源声明: sourceName[entity.source] ?? entity.source, 核验声明: statusName[entity.status] ?? entity.status, 知识版本: entity.version, 证据引用: entity.evidenceIds.join(' ') || 'none' })
  function group(parent: MapItem, id: string, name: string): MapItem { let found = parent.children.find(item => item.id === id); if (!found) { found = node(parent.category, id, name); parent.children.push(found) }; return found }
  const objectNode = (entity: Entity, ancestors = new Set<string>()): MapItem => {
    if (ancestors.has(entity.id)) return node('objects', 'object:' + entity.id, entity.title, '层级数据损坏，不能继续展开')
    const next = new Set([...ancestors, entity.id])
    return node('objects', 'object:' + entity.id, entity.title || entity.locator, entity.brief, { kind: 'object', entityId: entity.id, objectId: entity.id, hit: returned.has(entity.id), state: returned.has(entity.id) ? 'returned' : disclosed.has(entity.id) ? 'disclosed' : 'available', relatedIds: [entity.id], fields: fields(entity), children: (children.get(entity.id) ?? []).map(child => objectNode(child, next)) })
  }
  category('objects').children = (children.get(null) ?? []).map(entity => objectNode(entity))
  for (const entity of model.entities.filter(item => item.entityType === 'relation')) {
    const source = entity.sourceId!, target = entity.targetId!, top = owner(source)
    const parent = group(category('relations'), 'relations:' + (top?.id ?? source), top?.title || title(source))
    const hit = returned.has(entity.id) || boundaries.has(entity.id)
    parent.children.push(node('relations', 'relation:' + entity.id, `${title(source)} → ${title(target)}`, entity.brief, { kind: 'relation', entityId: entity.id, hit, state: returned.has(entity.id) ? 'returned' : boundaries.has(entity.id) ? 'reference' : 'available', relatedIds: [...boundaries.get(entity.id) ?? [], ...(returned.has(entity.id) ? [entity.id] : [])], fields: { ...fields(entity), 起点: source, 终点: target, 范围: returned.has(entity.id) ? '关系正文' : '关系引用' } }))
  }
  for (const entity of model.entities) {
    const source = group(category('sources'), 'sources:' + entity.source, sourceName[entity.source] ?? entity.source)
    const top = owner(entity.entityType === 'relation' ? entity.sourceId! : entity.id)
    const parent = group(source, 'sources:' + entity.source + ':' + (top?.id ?? entity.id), top?.title || entity.title)
    parent.children.push(node('sources', 'source:' + entity.source + ':' + entity.id, entity.title || entity.locator, entity.brief, { kind: 'source', entityId: entity.id, hit: returned.has(entity.id), state: returned.has(entity.id) ? 'associated' : 'available', relatedIds: [entity.id], fields: fields(entity) }))
  }
  const actualProofs = new Set(task?.packet.evidence.map(proof => proof.id) ?? [])
  for (const proof of model.evidence) {
    const parent = group(category('evidence'), 'evidence-kind:' + proof.kind, evidenceName[proof.kind] ?? proof.kind)
    const location = 'path' in proof.location ? proof.location.path : proof.location.url
    parent.children.push(node('evidence', 'evidence:' + proof.id, location.split('/').at(-1) || location, proof.claim, { kind: 'evidence', evidenceId: proof.id, hit: actualProofs.has(proof.id), state: actualProofs.has(proof.id) ? 'reference' : 'available', relatedIds: bodies.filter(body => body.evidenceIds.includes(proof.id)).map(body => body.entity.id), fields: { UUID: proof.id, 位置: location, 主张: proof.claim, 原字节指纹: proof.hash ?? '未知', 核对时间: proof.observedAt ?? '未知', 行范围: proof.range ? `${proof.range.startLine}–${proof.range.endLine}` : '未声明', 范围: '证据引用' } }))
  }
  const bound = !!task
  const revision = task?.binding.modelRevision ?? model.revision
  const version = (id: string, name: string, brief: string, facts: Record<string, string>) => node('versions', 'version:' + id, name, brief, { kind: 'version', hit: bound, state: bound ? 'associated' : 'available', relatedIds: bodies.map(body => body.entity.id), fields: facts })
  category('versions').children = [
    version('model', '模型 · ' + revision.slice(0, 8), bound ? '任务模型' : '当前模型', { 模型版本: revision }),
    version('source', '来源版本', task?.binding.sourceVersion.status ?? '尚未绑定任务', { HEAD: task?.binding.sourceVersion.head ?? '未知', 来源树指纹: task?.binding.sourceVersion.treeHash ?? '未知', 状态: task?.binding.sourceVersion.status ?? '未知', 范围: '按任务绑定的实际来源扫描范围' }),
    version('policy', '扫描策略', task?.binding.sourceScanRevision.slice(0, 12) ?? '尚未绑定任务', { 扫描策略指纹: task?.binding.sourceScanRevision ?? '未知' }),
    version('worktree', '工作区', view?.worktree.branch ?? '分支未知', { 项目: task?.binding.projectId ?? view?.target.projectId ?? '未知', 工作区: task?.binding.worktreeId ?? view?.target.worktreeId ?? '未知', 模型目录: '.harness/model' }),
  ]
  function aggregate(item: MapItem): void {
    item.children.forEach(aggregate)
    item.hits = (item.hit ? 1 : 0) + item.children.reduce((count, child) => count + child.hits, 0)
    if (!item.hit && item.hits) item.state = 'aggregate'
    item.hit = item.hits > 0
    item.relatedIds = [...new Set([...item.relatedIds, ...item.children.flatMap(child => child.relatedIds)])]
  }
  roots.forEach(aggregate)
  return roots
}
export function flattenMap(nodes: MapItem[]): MapItem[] { return nodes.flatMap(item => [item, ...flattenMap(item.children)]) }
