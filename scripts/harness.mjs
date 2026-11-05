#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { title: { type: 'string' }, session: { type: 'string' }, file: { type: 'string' }, batch: { type: 'string' }, skill: { type: 'string' }, path: { type: 'string' }, refresh: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean' } } })
const base = `http://127.0.0.1:${Number(process.env.PORT ?? 4317)}`
async function api(path, body) {
  const response = await fetch(base + path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-harness-client': 'cli' }, body: JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
  return data
}
try {
  const [command, id] = positionals
  if (values.help || !command) console.log(`HarnessL3 task entrance — current agent selects, no extra model calls
start --title <purpose> [--session <caller-session>] [--json]
prompt <task-id> [--refresh] [--json]
select <task-id> --file <UTF-8 selection.json> [--json]
handoff <task-id> [--batch <batch-id>] [--json]
read <task-id> --file <UTF-8 files.json> [--batch <batch-id>] [--json]
read <task-id> --skill <group/name> [--path SKILL.md] [--batch <batch-id>] [--json]
skills [--refresh] [--json]
show/list/history and extra context reads: npm run context -- ...
Start the local service first. start prints the built-in Skill Hub/context selection prompt.
The current agent submits one joint selection. The resulting context + versioned file references
return to that agent's normal workflow; selection is not execution. No agent launcher is implied.`)
  else {
    let data, output
    if (command === 'start') { data = await api('/api/harness/tasks', { title: values.title, sessionId: values.session, selectionMode: 'external' }); output = data.entrance.prompt }
    else if (command === 'skills') { data = await api(values.refresh ? '/api/skills/refresh' : '/api/skills/catalog', values.refresh ? {} : undefined); if (data.error) throw new Error(data.error); output = JSON.stringify(data, null, 2) }
    else if (command === 'prompt' && id) { data = await api('/api/harness/tasks/' + encodeURIComponent(id) + '/prompt', { refreshCatalog: !!values.refresh }); output = data.prompt }
    else if (command === 'select' && id && values.file) {
      const selection = JSON.parse((await readFile(values.file, 'utf8')).replace(/^\uFEFF/, ''))
      data = await api('/api/harness/tasks/' + encodeURIComponent(id) + '/select', selection); output = data.handoff
    }
    else if (command === 'handoff' && id) { data = await api('/api/harness/tasks/' + encodeURIComponent(id) + '/handoff' + (values.batch ? '?batch=' + encodeURIComponent(values.batch) : '')); output = data.handoff }
    else if (command === 'read' && id && (values.file || values.skill)) {
      const request = values.file ? JSON.parse((await readFile(values.file, 'utf8')).replace(/^\uFEFF/, '')) : { files: [{ skillId: values.skill, path: values.path ?? 'SKILL.md' }] }
      data = await api('/api/harness/tasks/' + encodeURIComponent(id) + '/read', { ...request, ...(values.batch ? { batchId: values.batch } : {}) })
      output = data.files.map(file => `## ${file.skillId}/${file.path}\nSHA-256: ${file.hash}\nref: ${file.ref}\nencoding: ${file.encoding}\n\n${file.content}`).join('\n\n')
    }
    else throw new Error('Unknown command or missing arguments. Use --help.')
    console.log(values.json ? JSON.stringify(data, null, 2) : output)
  }
} catch (error) { console.error(error.message); process.exitCode = 1 }
