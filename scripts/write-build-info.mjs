import { execFile as callbackExecFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { runtimeFingerprint } from '../build/core/package.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const execFile = promisify(callbackExecFile)
const git = async args => (await execFile('git', ['-C', root, ...args], { windowsHide: true })).stdout.trim()
let sourceCommit = null, sourceDirty = null
try {
  const head = await git(['rev-parse', 'HEAD'])
  if (/^[a-f0-9]{40}$/.test(head)) { sourceCommit = head; sourceDirty = (await git(['status', '--porcelain=v1', '--untracked-files=normal'])).length > 0 }
} catch { /* A source archive without Git metadata has unknown provenance. */ }
const { version: packageVersion } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const lockHash = createHash('sha256').update(await readFile(path.join(root, 'package-lock.json'))).digest('hex')
const runtimeHash = await runtimeFingerprint()
const file = path.join(root, 'build', 'build-info.json')
await mkdir(path.dirname(file), { recursive: true })
const temporary = file + '.' + randomUUID() + '.tmp'
await writeFile(temporary, JSON.stringify({ schemaVersion: 1, packageVersion, sourceCommit, sourceDirty, runtimeHash, lockHash, node: process.version }, null, 2) + '\n', 'utf8')
await rename(temporary, file)
