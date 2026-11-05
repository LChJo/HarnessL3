import type { Snapshot, Task, ModelNode, Relation, Meta, SourceVersion } from './context-types'

export type Category = 'objects' | 'relations' | 'sources' | 'evidence' | 'versions'
export type MapItem = {
  id: string; title: string; brief: string; category: Category
  kind: 'category' | 'group' | 'object' | 'relation' | 'source' | 'evidence' | 'version'
  children: MapItem[]; hit: boolean; hits: number
  state: 'available' | 'disclosed' | 'returned' | 'reference' | 'associated' | 'aggregate'
  relatedIds: string[]; objectId?: string; evidenceId?: string; relation?: Relation
  fields: Record<string, string>
}
const text = (value: string | string[] | undefined) => Array.isArray(value) ? value.join(', ') : value ?? '未知'
const values = (value: string | string[] | undefined) => (Array.isArray(value) ? value : value ? [value] : []).flatMap(v => v.split(/[,\s]+/)).filter(Boolean)
const sourceNames: Record<string, string> = { 'source-code': '源码', documentation: '文档', manual: '人工维护', inference: 'AI 推断', unknown: '来源未知' }
const names: [Category, string, string][] = [['objects', '对象', '项目由哪些部分组成'], ['relations', '关系', '这些部分如何协作'], ['sources', '来源', '这些信息从哪里来'], ['evidence', '证据', '回到具体依据核对'], ['versions', '版本', '本次上下文对应哪一版']]

export function projectContext(snapshot: Snapshot, task: Task | null, root = 'mgrp'): MapItem[] {
  const objects = new Map(snapshot.elements.map(node => [node.id, node]))
  const bodies = task?.packet.contexts ?? [], returned = new Set(bodies.map(node => node.id)), disclosed = new Set(task?.disclosedIds ?? [])
  for (const body of bodies) {
    for (const a of body.ancestors ?? []) if (!objects.has(a.id)) objects.set(a.id, { ...a, description: '历史上下文定位', kind: 'module', metadata: {} })
    objects.set(body.id, body)
  }
  const bodyMap = new Map(bodies.map(body => [body.id, body]))
  const relations = new Map((snapshot.relationships ?? []).map(r => [r.id, r])), returnedRelations = new Set<string>(), references = new Set<string>()
  for (const body of bodies) {
    values(body.metadata.evidence).forEach(id => references.add(id))
    for (const relation of body.relationships) { relations.set(relation.id, relation); returnedRelations.add(relation.id); values(relation.metadata.evidence).forEach(id => references.add(id)) }
  }
  function item(category: Category, id: string, title: string, brief = '', props: Partial<MapItem> = {}): MapItem {
    return { id, category, title, brief, kind: 'group', hit: false, hits: 0, state: 'available', children: [], relatedIds: [], fields: {}, ...props }
  }
  const roots = names.map(([category, title, brief]) => item(category, 'category:' + category, title, brief, { kind: 'category' }))
  const category = (id: Category) => roots.find(node => node.category === id)!
  const moduleOf = (id: string) => id.split('.').slice(0, root.split('.').length + 1).join('.')
  const titleOf = (id: string) => objects.get(id)?.title ?? id
  const relationTitle = (r: Relation) => `${titleOf(r.source)} → ${titleOf(r.target)}`
  const fields = (metadata: Meta) => ({ 来源: text(metadata.source), 状态: text(metadata.status), 证据引用: text(metadata.evidence), 源码引用: text(metadata.path) })
  function group(parent: MapItem, id: string, title: string): MapItem {
    let node = parent.children.find(n => n.id === id)
    if (!node) { node = item(parent.category, id, title); parent.children.push(node) }
    return node
  }
  function objectItem(node: ModelNode): MapItem {
    const body = bodyMap.get(node.id)
    return item('objects', 'object:' + node.id, node.title, node.description, { kind: 'object', objectId: node.id, relatedIds: [node.id], hit: returned.has(node.id), state: returned.has(node.id) ? 'returned' : disclosed.has(node.id) ? 'disclosed' : 'available', fields: { ...fields(node.metadata), 对象: node.id, 模型快照: body?.modelRevision ?? snapshot.revision }, children: [...objects.values()].filter(child => child.id.substring(0, child.id.lastIndexOf('.')) === node.id).map(objectItem) })
  }
  category('objects').children = [...objects.values()].filter(node => node.id.substring(0, node.id.lastIndexOf('.')) === root).map(objectItem)
  for (const relation of relations.values()) {
    const parent = group(category('relations'), 'relations:' + moduleOf(relation.source), titleOf(moduleOf(relation.source)))
    parent.children.push(item('relations', 'relation:' + relation.id, relationTitle(relation), relation.title || relation.description || relation.kind, { kind: 'relation', relation, hit: returnedRelations.has(relation.id), state: returnedRelations.has(relation.id) ? 'returned' : 'available', relatedIds: bodies.filter(b => b.relationships.some(r => r.id === relation.id)).map(b => b.id), fields: { ...fields(relation.metadata), 关系: relation.kind, 起点: relation.source, 终点: relation.target, 范围: '直接关系边界引用，不代表端点正文' } }))
  }
  const evidenceOwners = new Map<string, { module: string; relatedIds: string[]; path?: string }>()
  const entities = [...objects.values()].filter(n => n.id !== root).map(node => ({ id: node.id, title: node.title, metadata: node.metadata, owner: moduleOf(node.id), objectId: node.id, hit: returned.has(node.id), relatedIds: [node.id] })).concat([...relations.values()].map(r => ({ id: r.id, title: relationTitle(r), metadata: r.metadata, owner: moduleOf(r.source), objectId: '', hit: returnedRelations.has(r.id), relatedIds: bodies.filter(b => b.relationships.some(x => x.id === r.id)).map(b => b.id) })))
  for (const entity of entities) {
    for (const source of values(entity.metadata.source).length ? values(entity.metadata.source) : ['unknown']) {
      const sourceGroup = group(category('sources'), 'sources:' + source, sourceNames[source] ?? source)
      const owner = group(sourceGroup, 'sources:' + source + ':' + entity.owner, titleOf(entity.owner))
      owner.children.push(item('sources', 'source:' + source + ':' + entity.id, entity.title, sourceNames[source] ?? source, { kind: 'source', hit: entity.hit, state: entity.hit ? 'associated' : 'available', relatedIds: entity.relatedIds, fields: fields(entity.metadata) }))
    }
    for (const id of values(entity.metadata.evidence)) {
      const existing = evidenceOwners.get(id)
      evidenceOwners.set(id, { module: existing?.module ?? entity.owner, relatedIds: [...new Set([...(existing?.relatedIds ?? []), ...entity.relatedIds])], path: text(entity.metadata.path) })
    }
  }
  const evidence = new Map((snapshot.evidence ?? []).map(e => [e.id, e]))
  for (const id of new Set([...evidenceOwners.keys(), ...references])) {
    const owner = evidenceOwners.get(id), ref = evidence.get(id), path = ref?.path ?? owner?.path ?? id
    const parent = group(category('evidence'), 'evidence:' + (owner?.module ?? 'other'), owner ? titleOf(owner.module) : '其他引用')
    parent.children.push(item('evidence', 'evidence:' + id, path.split('/').at(-1) ?? id, ref?.startLine ? `引用 · ${ref.startLine}–${ref.endLine ?? ref.startLine} 行` : '证据引用', { kind: 'evidence', evidenceId: id, hit: references.has(id), state: references.has(id) ? 'reference' : 'available', relatedIds: owner?.relatedIds ?? [], fields: { 证据引用: id, 文件: path, 依据: ref?.claim ?? '引用详情待核对', 范围: '引用已返回不等于源码片段已读取' } }))
  }
  const model = group(category('versions'), 'versions:model', '模型')
  for (const revision of new Set([snapshot.revision, task?.modelRevision, ...bodies.map(b => b.modelRevision)].filter((v): v is string => !!v))) {
    const hit = task?.modelRevision === revision || bodies.some(b => b.modelRevision === revision)
    model.children.push(item('versions', 'version:model:' + revision, '模型快照 · ' + revision.slice(0, 8), '对应返回时的模型', { kind: 'version', hit, state: hit ? 'associated' : 'available', relatedIds: bodies.filter(b => b.modelRevision === revision).map(b => b.id), fields: { 模型快照: revision } }))
  }
  const source = group(category('versions'), 'versions:source', '源码'), versions = new Map<string, SourceVersion>()
  const versionKey = (v: SourceVersion) => JSON.stringify([v.branch, v.commit, v.evidenceDigest, v.dirty])
  versions.set(versionKey(snapshot.sourceVersion), snapshot.sourceVersion)
  for (const body of bodies) if (body.sourceVersion) versions.set(versionKey(body.sourceVersion), body.sourceVersion)
  for (const [key, version] of versions) {
    const matching = bodies.filter(b => b.sourceVersion && versionKey(b.sourceVersion) === key)
    source.children.push(item('versions', 'version:source:' + key, `${version.branch ?? '未知'} · ${version.commit?.slice(0, 8) ?? '版本未知'}`, '仅对应所引源码范围', { kind: 'version', hit: !!matching.length, state: matching.length ? 'associated' : 'available', relatedIds: matching.map(b => b.id), fields: { 分支: version.branch ?? '未知', 提交: version.commit ?? '未知', 所引文件内容指纹: version.evidenceDigest ?? '未知', 范围: '所引文件，不代表全项目语义同步' } }))
  }
  const workspace = group(category('versions'), 'versions:worktree', '工作区')
  workspace.children.push(item('versions', 'version:worktree:' + (task?.worktreeId ?? 'current'), '当前工作区', task?.worktreeId ?? '尚未绑定任务', { kind: 'version', hit: !!task, state: task ? 'associated' : 'available', relatedIds: bodies.map(b => b.id), fields: { 工作区: task?.worktreeId ?? '尚未绑定任务', 来源路径: snapshot.runtime.sourceRoot } }))
  function aggregate(node: MapItem): MapItem {
    node.children.forEach(aggregate)
    node.hits = (node.hit ? 1 : 0) + node.children.reduce((sum, child) => sum + child.hits, 0)
    if (!node.hit && node.hits) node.state = 'aggregate'
    node.hit = node.hits > 0
    node.relatedIds = [...new Set([...node.relatedIds, ...node.children.flatMap(child => child.relatedIds)])]
    return node
  }
  return roots.map(aggregate)
}

export function flattenMap(nodes: MapItem[]): MapItem[] { return nodes.flatMap(node => [node, ...flattenMap(node.children)]) }
