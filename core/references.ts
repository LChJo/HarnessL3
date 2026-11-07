import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import type { Diagnostic, Evidence } from './types.js'
import { isErrno } from './io.js'

const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
const paths = (bytes: Buffer) => {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (text && !text.endsWith('\0')) throw new Error('Incomplete Git path list')
  return new Set(text.split('\0').filter(Boolean).map(key))
}

/** Read-only, batched advice for project documents; it never stages files or changes source exclusions. */
export async function documentGitDiagnostics(root: string, evidence: Evidence[]): Promise<Diagnostic[]> {
  const documents = evidence.filter((item): item is Evidence & { location: { path: string } } => item.kind === 'document' && 'path' in item.location)
  if (!documents.length) return []
  try { await lstat(path.join(root, '.git')) }
  catch (error) { if (isErrno(error, 'ENOENT')) return []; return documents.map(item => unknown(item)) }
  const environment: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' }
  for (const name of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS', 'GIT_ATTR_SOURCE']) delete environment[name]
  const run = (args: string[], input?: Buffer, noMatch = false): Promise<Buffer> => new Promise((resolve, reject) => {
    const child = execFile('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', root, ...args], {
      env: environment, windowsHide: true, encoding: 'buffer', maxBuffer: 128 * 1024 * 1024,
    }, (error, stdout) => error && !(noMatch && error.code === 1) ? reject(error) : resolve(stdout))
    child.stdin?.on('error', () => { /* Process completion reports a failed Git invocation. */ })
    child.stdin?.end(input)
  })
  try {
    const tracked = paths(await run(['ls-files', '--cached', '--full-name', '-z']))
    const untracked = [...new Set(documents.filter(item => !tracked.has(key(item.location.path))).map(item => item.location.path))]
    const ignored = untracked.length ? paths(await run(['check-ignore', '--stdin', '-z'], Buffer.from(untracked.join('\0') + '\0'), true)) : new Set<string>()
    return documents.flatMap(item => {
      if (tracked.has(key(item.location.path))) return []
      const excluded = ignored.has(key(item.location.path))
      return [{ code: excluded ? 'EVIDENCE_IGNORED' : 'EVIDENCE_UNTRACKED', severity: 'warning' as const, file: item.location.path, evidenceId: item.id,
        message: excluded ? `Referenced project document is ignored by Git: ${item.location.path}. Review its retention and ignore rules before sharing project context.` : `Referenced project document is untracked: ${item.location.path}. Include it with related model changes when committing.` }]
    })
  } catch { return documents.map(item => unknown(item)) }
}

function unknown(item: Evidence & { location: { path: string } }): Diagnostic {
  return { code: 'EVIDENCE_GIT_UNKNOWN', severity: 'warning', file: item.location.path, evidenceId: item.id, message: 'Git tracking for this referenced project document could not be checked.' }
}
