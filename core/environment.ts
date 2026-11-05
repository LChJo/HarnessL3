import path from 'node:path'
import os from 'node:os'
import { canonicalPath } from './paths.js'
import { HarnessError } from './errors.js'

export async function resolveDataRoot(explicit?: string, environment = process.env): Promise<string> {
  let root = explicit || environment.HARNESSL3_HOME
  if (root && !path.isAbsolute(root)) throw new HarnessError('INVALID_ARGUMENT', 'The data root must be an absolute machine path')
  if (!root) root = process.platform === 'win32' ? path.join(environment.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'HarnessL3')
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support/HarnessL3')
      : path.join(environment.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'harnessl3')
  if (!path.isAbsolute(root)) throw new HarnessError('INVALID_ARGUMENT', 'The platform data directory must be absolute')
  return canonicalPath(root)
}
