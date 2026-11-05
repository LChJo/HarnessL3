import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { HarnessError } from '../core/errors.js'

export interface CommandRequest { operation: string; positionals: string[]; flags: Record<string, string | boolean>; requestId: string; cwd: string; input?: unknown; skillsRoot?: string; source?: 'cli' | 'web' }
interface CommandDefinition { count: number; flags?: string[]; required?: string[] }
const commands: Record<string, CommandDefinition> = {
  init: { count: 0, flags: ['name'] },
  'project register': { count: 1 }, 'project list': { count: 0 }, 'project show': { count: 1 }, 'project unregister': { count: 1 },
  'worktree register': { count: 1 }, 'worktree list': { count: 0 }, 'worktree show': { count: 1 }, 'worktree unregister': { count: 1 },
  'task start': { count: 0, flags: ['title', 'session'], required: ['title'] }, 'task prompt': { count: 1 },
  'task select': { count: 1, flags: ['file'], required: ['file'] }, 'task read': { count: 1, flags: ['file', 'batch'], required: ['file'] },
  'task show': { count: 1, flags: ['batch'] }, 'task handoff': { count: 1, flags: ['batch'] }, 'task close': { count: 1 },
  'task list': { count: 0, flags: ['limit', 'offset'] }, 'context query': { count: 1, flags: ['file'], required: ['file'] },
  'history list': { count: 0, flags: ['query', 'from', 'to', 'limit', 'offset'] }, 'history show': { count: 1, flags: ['batch'] },
  'skills list': { count: 0 }, 'skills refresh': { count: 0 },
  'agent bind': { count: 0, flags: ['agent', 'session', 'log-file', 'task'], required: ['agent', 'session', 'log-file'] },
  'agent unbind': { count: 1 }, 'agent status': { count: 0, flags: ['binding'] },
  'sync status': { count: 0 }, 'sync verify': { count: 0, flags: ['file'], required: ['file'] },
  'serve start': { count: 0, flags: ['port', 'foreground'] }, 'serve status': { count: 0 }, 'serve stop': { count: 0 },
  'web open': { count: 0, flags: ['task'] }, 'model validate': { count: 0 },
  gc: { count: 0, flags: ['dry-run', 'apply'] }, 'migrate prototype': { count: 0, flags: ['from', 'dry-run', 'apply'], required: ['from', 'worktree'] },
}
const globals = ['json', 'project', 'worktree', 'data-dir', 'request-id', 'help', 'version']
const booleanFlags = new Set(['json', 'help', 'version', 'foreground', 'dry-run', 'apply'])
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export function flag(request: CommandRequest, name: string): string | undefined { const value = request.flags[name]; return typeof value === 'string' ? value : undefined }
export function validateUuid(value: string, field: string): string { if (!uuid.test(value)) throw new HarnessError('INVALID_ARGUMENT', 'Expected a lowercase UUID', { field }); return value }

export function parseArgs(args: string[], cwd = process.cwd()): CommandRequest {
  const words: string[] = [], flags: Record<string, string | boolean> = {}
  const allowed = new Set([...globals, ...Object.values(commands).flatMap(command => command.flags ?? [])])
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    if (!token.startsWith('--')) { words.push(token); continue }
    const separator = token.indexOf('=')
    const name = token.slice(2, separator < 0 ? undefined : separator)
    if (!allowed.has(name) || Object.hasOwn(flags, name)) throw new HarnessError('INVALID_ARGUMENT', 'Unknown or repeated argument', { argument: name })
    if (booleanFlags.has(name)) {
      if (separator >= 0) throw new HarnessError('INVALID_ARGUMENT', 'Boolean flags do not take a value', { argument: name })
      flags[name] = true
    } else {
      const value = separator >= 0 ? token.slice(separator + 1) : args[++index]
      if (!value || (separator < 0 && value.startsWith('--'))) throw new HarnessError('INVALID_ARGUMENT', 'Argument needs a value', { argument: name })
      flags[name] = value
    }
  }
  if (flags.help || flags.version) return { operation: flags.version ? 'version' : 'help', positionals: words, flags, requestId: randomUUID(), cwd }
  const length = ['init', 'gc'].includes(words[0]) ? 1 : 2
  const operation = words.slice(0, length).join(' ')
  const definition = commands[operation]
  if (!definition) throw new HarnessError('INVALID_ARGUMENT', 'Unknown command; use harnessl3 --help')
  const positionals = words.slice(length)
  if (positionals.length !== definition.count) throw new HarnessError('INVALID_ARGUMENT', 'Incorrect number of positional arguments', { operation, expected: definition.count })
  for (const name of Object.keys(flags)) if (!globals.includes(name) && !definition.flags?.includes(name)) throw new HarnessError('INVALID_ARGUMENT', 'Argument is not valid for this command', { operation, argument: name })
  for (const name of definition.required ?? []) if (flags[name] === undefined) throw new HarnessError('INVALID_ARGUMENT', 'Missing required argument', { argument: name })
  for (const name of ['project', 'worktree', 'request-id', 'batch', 'task', 'binding']) if (typeof flags[name] === 'string') validateUuid(flags[name] as string, name)
  if (positionals.length && operation !== 'project register' && operation !== 'worktree register') validateUuid(positionals[0], 'id')
  for (const name of ['title', 'name', 'session']) if (typeof flags[name] === 'string' && !(flags[name] as string).trim()) throw new HarnessError('INVALID_ARGUMENT', 'Argument must not be blank', { argument: name })
  for (const name of ['limit', 'offset', 'port']) {
    const value = flags[name]
    if (typeof value !== 'string') continue
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || (name === 'limit' && (+value < 1 || +value > 200)) || (name === 'port' && +value > 65535)) throw new HarnessError('INVALID_ARGUMENT', 'Numeric argument is outside its permitted range', { argument: name })
  }
  for (const name of ['from', 'to']) if (operation === 'history list' && flags[name]) {
    const value = String(flags[name])
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new HarnessError('INVALID_ARGUMENT', 'Expected a UTC YYYY-MM-DD date', { argument: name })
  }
  if (operation === 'history list' && flags.from && flags.to && String(flags.from) > String(flags.to)) throw new HarnessError('INVALID_ARGUMENT', 'from must not be after to')
  if (flags['dry-run'] && flags.apply) throw new HarnessError('INVALID_ARGUMENT', '--dry-run and --apply are mutually exclusive')
  if (flags['data-dir'] && !path.isAbsolute(String(flags['data-dir']))) throw new HarnessError('INVALID_ARGUMENT', '--data-dir must be absolute')
  if (flags['log-file'] && !path.isAbsolute(String(flags['log-file']))) throw new HarnessError('INVALID_ARGUMENT', '--log-file must be absolute')
  if (flags.agent && !['codex', 'claude-code'].includes(String(flags.agent))) throw new HarnessError('INVALID_ARGUMENT', 'Unsupported agent')
  return { operation, positionals, flags, requestId: String(flags['request-id'] ?? randomUUID()), cwd: path.resolve(cwd) }
}

export function validateRpcRequest(value: unknown): CommandRequest {
  if (!value || typeof value !== 'object') throw new HarnessError('INVALID_ARGUMENT', 'Invalid command request')
  const object = value as Record<string, unknown>
  if (Object.keys(object).some(key => !['operation', 'positionals', 'flags', 'requestId', 'cwd', 'input', 'skillsRoot'].includes(key)) || typeof object.operation !== 'string' || !Array.isArray(object.positionals) || !object.positionals.every(value => typeof value === 'string') || !object.flags || typeof object.flags !== 'object' || Array.isArray(object.flags) || typeof object.cwd !== 'string' || !path.isAbsolute(object.cwd) || typeof object.requestId !== 'string') throw new HarnessError('INVALID_ARGUMENT', 'Invalid command request fields')
  const flags = object.flags as Record<string, unknown>
  const args = object.operation.split(' ').concat(object.positionals as string[])
  for (const [name, value] of Object.entries(flags)) {
    if (value === true) args.push('--' + name)
    else if (typeof value === 'string') args.push('--' + name + '=' + value)
    else throw new HarnessError('INVALID_ARGUMENT', 'Invalid flag value', { argument: name })
  }
  const parsed = parseArgs(args, object.cwd)
  validateUuid(object.requestId, 'requestId')
  if (parsed.flags['request-id'] && parsed.flags['request-id'] !== object.requestId) throw new HarnessError('INVALID_ARGUMENT', 'Request IDs differ')
  parsed.requestId = object.requestId
  if (Object.hasOwn(object, 'input')) parsed.input = object.input
  if (object.skillsRoot !== undefined) {
    if (typeof object.skillsRoot !== 'string' || !path.isAbsolute(object.skillsRoot)) throw new HarnessError('INVALID_ARGUMENT', 'Skill root must be absolute')
    parsed.skillsRoot = object.skillsRoot
  }
  return parsed
}
