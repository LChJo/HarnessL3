import path from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import { HarnessError } from './errors.js'
import { isErrno } from './io.js'
import { validUnicode } from './json.js'

export function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => { const absolute = path.resolve(value); return process.platform === 'win32' ? absolute.toLowerCase() : absolute }
  return normalize(left) === normalize(right)
}
export function isWithin(parent: string, child: string, allowEqual = true): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' ? allowEqual : relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}
export async function canonicalPath(input: string): Promise<string> {
  let current = path.resolve(input)
  const missing: string[] = []
  while (true) {
    try { return path.join(await realpath(current), ...missing.reverse()) } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
      // A dangling symlink is not a nonexistent directory we may append to.
      try { if ((await lstat(current)).isSymbolicLink()) throw new HarnessError('INVALID_ARGUMENT', 'Path contains a dangling link', { path: input }) } catch (statError) { if (!isErrno(statError, 'ENOENT')) throw statError }
      const parent = path.dirname(current)
      if (parent === current) throw error
      missing.push(path.basename(current)); current = parent
    }
  }
}
export function safeRelative(input: string): string {
  if (!input || !validUnicode(input) || /[\\:\x00-\x1f]/.test(input) || input.startsWith('/') || input.endsWith('/') || input.includes('//') || input.split('/').some(part => part === '.' || part === '..')) {
    throw new HarnessError('INVALID_ARGUMENT', 'Expected a safe worktree-relative POSIX path', { path: input })
  }
  return input
}
export async function resolveInside(root: string, relative: string, options: { allowMissing?: boolean; noSymlinks?: boolean } = {}): Promise<string> {
  safeRelative(relative)
  const canonicalRoot = await realpath(root)
  let current = canonicalRoot
  for (const part of relative.split('/')) {
    current = path.join(current, part)
    try {
      const metadata = await lstat(current)
      if (metadata.isSymbolicLink() && options.noSymlinks) throw new HarnessError('INVALID_ARGUMENT', 'Links are not permitted in this archive path', { path: relative })
    } catch (error) { if (!(options.allowMissing && isErrno(error, 'ENOENT'))) throw error }
    const resolved = await canonicalPath(current)
    if (!isWithin(canonicalRoot, resolved)) throw new HarnessError('INVALID_ARGUMENT', 'Path escapes its worktree or archive', { path: relative })
  }
  return options.allowMissing ? canonicalPath(current) : realpath(current)
}
