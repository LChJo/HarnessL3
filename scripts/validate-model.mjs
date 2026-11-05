import { LikeC4 } from 'likec4'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { validateModelContract } from '../server/model-contract.mjs'
const parser = await LikeC4.fromWorkspace(fileURLToPath(new URL('../examples/mgrp/model/', import.meta.url)), { logger: false })
try {
  const errors = parser.getErrors()
  if (errors.length) { console.error(JSON.stringify(errors, null, 2)); process.exitCode = 1 }
  else {
    const model = await parser.layoutedModel()
    const manifest = JSON.parse(await readFile(new URL('../examples/mgrp/evidence.json', import.meta.url), 'utf8'))
    const contract = validateModelContract(model.$data, manifest)
    if (contract.length) throw new Error(JSON.stringify(contract))
    console.log(JSON.stringify({ valid: true, objects: Object.keys(model.$data.elements).length, relations: Object.keys(model.$data.relations).length,
      evidence: manifest.evidence.length, provenanceContract: 'passed',
      views: Object.values(model.$data.views).map(v => ({ id: v.id, nodes: v.nodes.length, edges: v.edges.length, bounds: v.bounds })) }, null, 2))
  }
} finally { await parser.dispose() }
