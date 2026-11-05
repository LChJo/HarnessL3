const one = value => Array.isArray(value) ? value[0] : value

/** Checks references and provenance; does not claim semantic or runtime correctness. */
export function validateModelContract(data, manifest) {
  const diagnostics = []
  const evidence = new Map(manifest.evidence.map(e => [e.id, e]))
  const stable = new Set()
  for (const object of [...Object.values(data.elements), ...Object.values(data.relations)]) {
    const metadata = object.metadata ?? {}
    const id = one(metadata.stable_id)
    const reference = one(metadata.evidence)
    const proof = evidence.get(reference)
    if (!id || stable.has(id)) diagnostics.push({ message: `稳定身份缺失或重复：${id ?? object.id}` })
    stable.add(id)
    if (!proof) diagnostics.push({ message: `证据引用不存在：${id ?? object.id} → ${reference ?? '未设置'}` })
    else if (one(metadata.source) !== proof.type) diagnostics.push({ message: `来源类型与证据不一致：${id}` })
    if (object.kind === 'inferred' && (one(metadata.source) !== 'inference' || one(metadata.status) !== 'unverified')) diagnostics.push({ message: `推断关系必须明确标记未验证：${id}` })
    if (data.elements[object.id] && id !== object.id) diagnostics.push({ message: `对象稳定身份与 LikeC4 标识不一致：${object.id}` })
  }
  return diagnostics
}
