import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

let directory = path.dirname(fileURLToPath(import.meta.url))
while (!existsSync(path.join(directory, 'package.json'))) {
  const parent = path.dirname(directory)
  if (directory === parent) throw new Error('HarnessL3 package root is missing')
  directory = parent
}
export const PACKAGE_ROOT = directory
export const PACKAGE_VERSION = (JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string }).version
export const SCHEMA_ROOT = path.join(PACKAGE_ROOT, 'docs/spec/contracts')
export const SEED_ROOT = path.join(PACKAGE_ROOT, 'skills')
