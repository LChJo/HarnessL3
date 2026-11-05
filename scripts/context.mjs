import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { title: { type: 'string' }, expand: { type: 'string' }, read: { type: 'string' }, revision: { type: 'string' }, session: { type: 'string' }, query: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, offset: { type: 'string' }, limit: { type: 'string' }, batch: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' } } })
const base = `http://127.0.0.1:${Number(process.env.PORT ?? 4317)}`
const split = text => text ? text.split(',').map(v => v.trim()).filter(Boolean) : []
async function api(path, body, collection = '/api/context/tasks') {
  const response = await fetch(base + collection + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-harness-client': 'cli' }, body: JSON.stringify(body) } : undefined)
  const data = await response.json(); if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`); return data
}
function textResult(data) {
  const result = data.result ?? data
  const lines = []
  const task = data.task ?? (data.packet ? data : null)
  if (task) lines.push(`# ${task.title}`, `task: ${task.id}`, `worktree: ${task.worktreeId}`, `model: ${task.modelRevision}`)
  if (data.history) lines.push(`history: ${data.history.snapshotStatus}; through: ${data.history.throughBatchId ?? 'latest'}; expires: ${data.history.expiresAt ?? 'unknown'}`)
  if (result.batchId) lines.push(`batch: ${result.batchId}`)
  for (const directory of result.directories ?? []) {
    lines.push(`\n## 子层简述 · ${directory.title} (${directory.id})`)
    for (const node of directory.items) lines.push(`- ${node.id} | ${node.title} | ${node.brief} | 子项 ${node.children}`)
  }
  for (const context of result.contexts ?? data.packet?.contexts ?? []) {
    lines.push(`\n## ${context.title} (${context.id})`,context.description,`来源: ${context.metadata.source}; 状态: ${context.metadata.status}`,`证据: ${context.metadata.evidence}; 引用: ${context.metadata.path}`,`source: ${context.sourceVersion?.branch ?? '未知'} @ ${context.sourceVersion?.commit ?? '未知'}`,`model: ${context.modelRevision}`,`content: ${context.contentHash}`)
    for (const relation of context.relationships) lines.push(`- 边界引用: ${relation.source} --${relation.kind}--> ${relation.target}; 来源 ${relation.metadata.source ?? '未知'}; 状态 ${relation.metadata.status ?? '未知'}; 证据 ${relation.metadata.evidence ?? '未知'}${relation.description ? '; ' + relation.description : ''}`)
  }
  for (const error of result.errors ?? []) lines.push(`\nERROR ${error.operation} ${error.id}: ${error.message}`)
  return lines.join('\n')
}
try {
  const [command, id] = positionals
  if (values.help || !command) console.log('Prototype context reader (no model calls)\nstart --title <purpose> [--session <caller-session>] [--json]\nquery <task-id> [--expand id,id] [--read id,id] [--revision hash] [--json]\nshow <task-id> [--batch <batch-id>] [--json]\nlist [--json] (recent 50)\nhistory [--query text] [--from ISO-date] [--to ISO-date] [--offset 0] [--limit 20] [--json] (60-day window)\nRequires the local service (npm run dev / npm start). Read results are produced for this caller; they do not prove model understanding.')
  else {
    let data
    if (command === 'start') data = await api('', { title: values.title, client: 'cli', selectionMode: 'external', sessionId: values.session })
    else if (command === 'query' && id) data = await api('/' + encodeURIComponent(id) + '/query', { expand: split(values.expand), read: split(values.read), expectedRevision: values.revision })
    else if (command === 'show' && id) data = await api('/' + encodeURIComponent(id) + (values.batch ? '?batch=' + encodeURIComponent(values.batch) : ''))
    else if (command === 'list') data = await api('')
    else if (command === 'history') data = await api('?' + new URLSearchParams(Object.fromEntries(['query', 'from', 'to', 'offset', 'limit'].filter(key => values[key] !== undefined).map(key => [key, values[key]]))), undefined, '/api/context/history')
    else throw new Error('Unknown command. Use --help.')
    console.log(values.json || command === 'list' || command === 'history' ? JSON.stringify(data, null, 2) : textResult(data))
  }
} catch (error) { console.error(error.message); process.exitCode = 1 }
