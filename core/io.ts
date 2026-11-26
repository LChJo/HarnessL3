import { mkdir, open, readFile, rename, unlink, statfs } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { canonicalJson, parseJsonStrict } from './json.js'
import { HarnessError } from './errors.js'

export const isErrno = (error: unknown, code: string): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === code
export async function ensureDir(directory: string): Promise<void> { await mkdir(directory, { recursive: true, mode: 0o700 }) }
const freeSpace = new Map<string, { checked: number; remaining: number }>()
/** Reserve a conservative upper bound for a single atomic/transactional
 * write. A cached estimate avoids statfs for every small immutable item;
 * recheck before rejecting. Unsupported platforms retain OS write errors. */
export async function requireWriteCapacity(root: string, bytes: number): Promise<void> {
  const required = bytes * 2 + 1024 * 1024
  const now = Date.now()
  let cached = freeSpace.get(root)
  if (!cached || now - cached.checked >= 5000 || cached.remaining < required) {
    try {
      const info = await statfs(root, { bigint: true })
      cached = { checked: now, remaining: Number(info.bavail * info.bsize) }; freeSpace.set(root, cached)
      if (freeSpace.size > 128) freeSpace.delete(freeSpace.keys().next().value!)
    } catch (error) { if (['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'UNKNOWN'].some(code => isErrno(error, code))) return; throw error }
  }
  if (cached.remaining < required) throw new HarnessError('IO_ERROR', 'Insufficient free disk space for the requested durable write.', { path: root, reason: 'disk-space-low', availableBytes: cached.remaining, requiredBytes: required })
  cached.remaining = Math.max(0, cached.remaining - bytes)
}
export async function readJson<T>(file: string): Promise<T> {
  const bytes = await readFile(file)
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { throw new HarnessError('INVALID_JSON', 'JSON file is not valid UTF-8', { file }) }
  return parseJsonStrict(text) as T
}

/** Publish only after file sync. Never delete the valid destination to make rename succeed. */
export async function atomicWrite(file: string, data: string | Uint8Array): Promise<void> {
  await ensureDir(path.dirname(file))
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(data); await handle.sync() } finally { await handle.close() }
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, file); break } catch (error) {
        if (process.platform !== 'win32' || attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].some(code => isErrno(error, code))) throw error
        await setTimeout(20 * (attempt + 1))
      }
    }
    if (process.platform !== 'win32') {
      const directory = await open(path.dirname(file), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
  } finally { await unlink(temporary).catch(error => { if (!isErrno(error, 'ENOENT')) throw error }) }
}
export async function writeJson(file: string, value: unknown): Promise<void> { await atomicWrite(file, canonicalJson(value) + '\n') }
