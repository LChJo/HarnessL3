import { access } from 'node:fs/promises'
import { execFile as callbackExecFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const execFile = promisify(callbackExecFile)
export async function npm(args, options = {}) {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean)
  for (const file of candidates) {
    try { await access(file) } catch { continue }
    return execFile(process.execPath, [file, ...args], { windowsHide: true, maxBuffer: 32 * 1024 * 1024, ...options })
  }
  throw new Error('Cannot locate the npm CLI installed with this native Node toolchain')
}
