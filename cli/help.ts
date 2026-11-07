import { readFileSync } from 'node:fs'
import path from 'node:path'
import { commands, globals, booleanFlags } from './args.js'
import { PACKAGE_ROOT, PACKAGE_VERSION, SCHEMA_ROOT } from '../core/package.js'
import { HarnessError } from '../core/errors.js'

const descriptions: Record<string, string> = {
  init: 'Create missing context files and register this Git worktree; the current agent authors/reviews its project model and reports progress.',
  'project register': 'Register an existing configured project without creating its model.',
  'project list': 'List registered projects from any directory.',
  'project show': 'Show a registered project by its stable ID.',
  'project unregister': 'Deactivate registration; retain source, skills and archives.',
  'worktree register': 'Register an existing configured Git worktree; never create or switch branches.',
  'worktree list': 'List registered worktrees, optionally filtered by project.',
  'worktree show': 'Show the exact worktree path and availability.',
  'worktree unregister': 'Deactivate this worktree registration while retaining its files and history.',
  'task start': 'Create a context task and return brief directories, current skill catalog and routing guidance.',
  'task prompt': 'Refresh routing material for a task whose joint selection has not been recorded.',
  'task select': 'Commit one joint context and skill selection; empty collections are valid.',
  'task read': 'Read selected archived skill files by exact path and expected hash; never execute them.',
  'task show': 'Restore recorded task state, optionally through one historical batch.',
  'task handoff': 'Return cumulative context and archived skill file references; do not read their bodies.',
  'task close': 'Close context organization; retain unresolved sync state and archived content.',
  'task list': 'List tasks in this target and its 60-day context activity window.',
  'context query': 'Batch-expand brief directories or read exact context entities for this task.',
  'history list': 'Search the 60-day window by query/date with bounded pagination.',
  'history show': 'Restore an identified historical task or batch without extending retention.',
  'skills list': 'List the actual skill directory and diagnostics; no selection or execution.',
  'skills refresh': 'Rescan skill files; preserve existing selections and archived bytes.',
  'agent bind': 'Bind a known Codex or Claude Code session log for read-only observation; no Hooks.',
  'agent unbind': 'Stop the specified read-only log binding without deleting logs or history.',
  'agent status': 'Show observation bindings and known coverage gaps.',
  'sync status': 'Return current source/model versions, epoch, pending scope and referenced evidence diagnostics.',
  'sync verify': 'Check a scoped stage declaration against current versions; not automatic semantic review.',
  'serve start': 'Start/reuse the correct loopback-only service; foreground mode stays attached.',
  'serve status': 'Inspect this data root service without selecting a worktree.',
  'serve stop': 'Stop this data root service; retain committed work.',
  'web open': 'Return a Web sign-in URL for the resident service; open the browser unless --no-open is supplied.',
  'model validate': 'Validate the current LikeC4 model without editing or marking source as synchronized.',
  gc: 'Preview rebuildable derived-data cleanup by default; never purge history or user skills.',
  'migrate prototype': 'Preview legacy archive copying by default; apply preserves the original source.',
}
const options: Record<string, [string, string]> = {
  json: ['', 'Emit one JSON envelope to stdout; diagnostics go to stderr. Help/version stay text.'],
  project: ['UUID', 'Explicit registered project; ambiguous worktrees require --worktree.'],
  worktree: ['UUID', 'Exact registered worktree; a conflicting registered cwd is rejected.'],
  'data-dir': ['absolute-path', 'Machine data root outside all registered worktree trees.'],
  'request-id': ['UUID', 'Save a request ID for reliable retries; match the JSON requestId when both are supplied.'],
  help: ['', 'Show static top-level, command-group or command help; no service startup.'],
  version: ['', 'Show the installed package version; no service startup.'],
  name: ['name', 'Project display name; init defaults to the worktree directory name.'],
  title: ['purpose', 'Non-empty purpose for this context task.'],
  session: ['session-id', 'Known session identifier; task start only declares it, not log observation.'],
  file: ['path|-', 'UTF-8 JSON file or UTF-8 stdin (-); prefer a file in PowerShell. Keep request files outside scanned source.'],
  batch: ['UUID', 'Fixed historical batch boundary; otherwise use the latest recorded batch at call start.'],
  task: ['UUID', 'Explicit task in this command target.'],
  binding: ['UUID', 'Filter by the known observation binding ID.'],
  limit: ['1..200', 'Page size; task list defaults to 50 and history list to 20.'],
  offset: ['number', 'Non-negative page offset; default 0.'],
  query: ['text', 'Match purpose, task/session identity or model version.'],
  from: ['YYYY-MM-DD', 'Inclusive UTC lower date bound.'],
  to: ['YYYY-MM-DD', 'Inclusive UTC upper date bound.'],
  agent: ['codex|claude-code', 'Read-only adapter for a known existing session log.'],
  'log-file': ['absolute-path', 'Explicit existing log; do not discover unrelated sessions.'],
  port: ['0..65535', 'Loopback port; default 0 selects an available dynamic port.'],
  foreground: ['', 'Stay attached after service readiness; JSON readiness is emitted once.'],
  'no-open': ['', 'Return a clickable authenticated Web URL without launching a browser; first use may have no target.'],
  'dry-run': ['', 'Preview only; default for gc and migrate prototype. Mutually exclusive with --apply.'],
  apply: ['', 'Apply the named conservative operation; mutually exclusive with --dry-run.'],
}
const contracts: Record<string, string> = {
  'task select': 'selection', 'context query': 'query', 'task read': 'file-read', 'sync verify': 'sync-proof',
}
const resultKinds: Record<string, string> = {
  init: 'command-result: registration and initialization stage, model counts and agent guidance. scaffold-ready is mechanical setup; semanticStatus is not-assessed. The current agent reads sources, writes the model and reports progress.',
  'serve status': 'command-result: shared service identity, startedAt, scope:user-data-root and lifetime:until-stopped; no idle expiry. The default data root shares one service across projects.',
  'web open': 'command-result: url, opened, service and login metadata; --no-open returns opened:false. The single-use sign-in code lasts five minutes, the authenticated browser session lasts twelve hours, and the service runs until stopped. After context and required skill contents return, follow the runtime skill to show one progress output card before continuing; do not repeat it in the final answer.',
  'task start': 'task-entry: taskId, binding, routingPrompt, directory and catalog.',
  'task prompt': 'task-entry: refreshed routing material and binding for the pending selection.',
  'task select': 'selection: context packet, archived skill plan and exact file references.',
  'context query': 'context-batch: exact requested briefs/bodies and per-item errors.',
  'task handoff': 'handoff: cumulative exact context and selected archived file references.',
  'task read': 'skill-files: archived file content and per-item errors; no execution.',
  'sync status': 'command-result: current source/model versions, sourceEpoch, pending paths and evidence/Git diagnostics.',
  'sync verify': 'command-result: scoped verification outcome and remaining sync state.',
  'task close': 'command-result: taskId, closedAt and syncStatus; not proof of task success.',
}

function flagUsage(operation: string, name: string): string {
  const value = operation === 'migrate prototype' && name === 'from' ? 'directory' : options[name]?.[0] ?? 'value'
  return '--' + name + (booleanFlags.has(name) ? '' : ` <${value}>`)
}
function usage(operation: string): string {
  const definition = commands[operation]
  const positional = !definition.count ? '' : operation.endsWith(' register') ? ' <path>' : operation.startsWith('project ') ? ' <project-id>' : operation.startsWith('worktree ') ? ' <worktree-id>' : operation === 'agent unbind' ? ' <binding-id>' : ' <task-id>'
  const required = definition.required ?? []
  const optional = (definition.flags ?? []).filter(name => !required.includes(name))
  return 'harnessl3 ' + operation + positional + required.map(name => ' ' + flagUsage(operation, name)).join('') + optional.map(name => ' [' + flagUsage(operation, name) + ']').join('')
}
function flags(operation: string, names: string[], required: string[] = []): string[] {
  return names.map(name => '  ' + flagUsage(operation, name) + (required.includes(name) ? ' (required)' : '') + '\n    ' + (operation === 'migrate prototype' && name === 'from' ? 'Absolute legacy source directory; copy without deleting it.' : options[name]?.[1] ?? 'See the installed usage guide.'))
}

/** Static discovery uses the parser's command/flag registry and this installed package's contracts. */
export function renderHelp(words: string[]): string {
  const operation = [words.slice(0, 2).join(' '), words[0]].find(name => name && Object.hasOwn(commands, name))
  const topic = words.join(' ')
  const matches = Object.keys(commands).filter(name => !topic || name.startsWith(topic + ' '))
  if (topic && !operation && !matches.length) throw new HarnessError('INVALID_ARGUMENT', 'Unknown help topic; use harnessl3 --help', { topic })
  const lines = [`HarnessL3 ${PACKAGE_VERSION}`]
  if (operation) {
    lines.push('Usage: ' + usage(operation) + ' [global options]', '', descriptions[operation], '')
    const definition = commands[operation]
    const names = [...new Set([...(definition.flags ?? []), ...(definition.required ?? [])])]
    if (names.length) lines.push('Command options:', ...flags(operation, names, definition.required), '')
    const contract = contracts[operation]
    if (contract) {
      const schemaPath = path.join(SCHEMA_ROOT, contract + '.schema.json')
      const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as { required: string[] }
      lines.push('Request schema: ' + schemaPath, 'Request example: ' + path.join(SCHEMA_ROOT, 'examples', contract + '.json'), 'Normalized required fields: ' + schema.required.join(', '), 'The schema applies after requestId normalization. Raw JSON may omit requestId; save an explicit ID for reliable retries.', 'Read the schema and its local references for nested fields; use real IDs, bindings and hashes returned by this task.', '')
    }
    lines.push('Returns: ' + (resultKinds[operation] ?? 'command-result: ' + descriptions[operation]), '')
  } else {
    lines.push(`Usage: harnessl3 ${topic ? topic + ' <command>' : '<command>'} [arguments] [--json]`, '', 'Commands:')
    for (const name of matches) lines.push('  ' + usage(name) + '\n    ' + descriptions[name])
    lines.push('', 'Use harnessl3 <command> --help for its options, request schema/example paths and return meaning.', '')
  }
  lines.push('Global options:', ...flags(operation ?? '', globals), '', 'Response schema: ' + path.join(SCHEMA_ROOT, 'response.schema.json'), 'Usage guide: ' + path.join(PACKAGE_ROOT, 'docs', 'USAGE.md'), 'Contracts guide: ' + path.join(SCHEMA_ROOT, 'README.md'), '', 'JSON results: ok:true/data or ok:false/error. A successful envelope can still have data.status:"partial".', 'Exit codes: 0 complete; 2 invalid input; 3 conflict; 4 partial; 130 cancelled; 1 other failure.', 'The current agent calls HarnessL3. It does not start agents, run skills, or install Hooks.', '')
  return lines.join('\n')
}
