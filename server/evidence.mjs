import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, win32 } from 'node:path'

export const sha256 = data => createHash('sha256').update(data).digest('hex')

export function resolveEvidencePath(root, file) {
  if (!file || isAbsolute(file) || win32.isAbsolute(file)) throw new Error('路径必须相对来源工作区')
  const resolved = resolve(root, file)
  const rel = relative(resolve(root), resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('路径 outside 来源工作区')
  return resolved
}

export async function readSourceFile(root, file) {
  const target = resolveEvidencePath(root, file)
  const [actualRoot, actualTarget] = await Promise.all([realpath(root), realpath(target)])
  const rel = relative(actualRoot, actualTarget)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('符号链接路径 outside 来源工作区')
  return readFile(actualTarget)
}

export async function fingerprint(root, files) {
  const entries = await Promise.all([...new Set(files)].sort().map(async path => {
    try { return { path, sha256: sha256(await readSourceFile(root, path)) } }
    catch { return { path, sha256: null } }
  }))
  return { digest: sha256(JSON.stringify(entries)), files: entries }
}

export async function verifyEvidence(root, manifest) {
  const current = await fingerprint(root, manifest.evidence.map(e => e.path))
  const hashes = new Map(current.files.map(f => [f.path, f.sha256]))
  const evidence = manifest.evidence.map(e => ({ ...e, currentHash: hashes.get(e.path),
    freshness: hashes.get(e.path) === e.sha256 ? 'matched' : hashes.get(e.path) ? 'changed' : 'missing' }))
  return { status: evidence.every(e => e.freshness === 'matched') ? 'matched' : 'stale',
    scope: 'evidence-files-only', digest: current.digest, checkedAt: new Date().toISOString(),
    changedFiles: [...new Set(evidence.filter(e => e.freshness !== 'matched').map(e => e.path))], evidence }
}
