import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

let directory = path.dirname(fileURLToPath(import.meta.url))
while (!existsSync(path.join(directory, 'package.json'))) {
  const parent = path.dirname(directory)
  if (directory === parent) throw new Error('HarnessL3 package root is missing')
  directory = parent
}
export const PACKAGE_ROOT = directory
export const PACKAGE_VERSION = (JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string }).version
export interface PackageBuild { packageVersion: string; sourceCommit: string | null; sourceDirty: boolean | null; runtimeHash: string | null }
export function parsePackageBuild(input: unknown): PackageBuild | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  if (typeof value.packageVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(value.packageVersion) || !(value.sourceCommit === null && value.sourceDirty === null || typeof value.sourceCommit === 'string' && /^[a-f0-9]{40}$/.test(value.sourceCommit) && typeof value.sourceDirty === 'boolean') || !(value.runtimeHash === null || typeof value.runtimeHash === 'string' && /^[a-f0-9]{64}$/.test(value.runtimeHash))) return null
  return { packageVersion: value.packageVersion, sourceCommit: value.sourceCommit as string | null, sourceDirty: value.sourceDirty as boolean | null, runtimeHash: value.runtimeHash as string | null }
}
function buildSource(): PackageBuild {
  try {
    const value = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'build/build-info.json'), 'utf8'))
    const build = parsePackageBuild(value)
    if (value.schemaVersion === 1 && build?.packageVersion === PACKAGE_VERSION && build.runtimeHash !== null) return build
  } catch { /* Static help remains available when build provenance is unknown. */ }
  return { packageVersion: PACKAGE_VERSION, sourceCommit: null, sourceDirty: null, runtimeHash: null }
}
export const PACKAGE_BUILD = buildSource()
export async function runtimeFingerprint(): Promise<string> {
  const hash = createHash('sha256')
  for (const directory of ['cli', 'core', 'service']) {
    const files = (await readdir(path.join(PACKAGE_ROOT, 'build', directory))).filter(file => file.endsWith('.js')).sort()
    for (const file of files) { hash.update(`${directory}/${file}\0`); hash.update(await readFile(path.join(PACKAGE_ROOT, 'build', directory, file))); hash.update('\0') }
  }
  return hash.digest('hex')
}
export const SCHEMA_ROOT = path.join(PACKAGE_ROOT, 'docs/spec/contracts')
export const SEED_ROOT = path.join(PACKAGE_ROOT, 'skills')
