import { spawn } from 'node:child_process'
import { mkdtemp, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Run in a native terminal and press Ctrl+C while the CLI waits for stdin.
// The parent stays alive long enough to report the actual Node child exit code.
const directory = await mkdtemp(path.join(tmpdir(), 'harnessl3-cancel-native-'))
const dataRoot = path.join(directory, 'data')
const binary = fileURLToPath(new URL('../../bin/harnessl3.mjs', import.meta.url))
process.on('SIGINT', () => {})
const child = spawn(process.execPath, [binary, 'context', 'query', '10000000-0000-4000-8000-000000000001', '--file', '-', '--json', '--data-dir', dataRoot], { stdio: 'inherit', windowsHide: true })
child.once('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1 })
child.once('close', async (code, signal) => {
  let created = true
  try { await access(dataRoot) } catch { created = false }
  process.stderr.write(JSON.stringify({ probe: 'native-cancel', childExitCode: code, signal, dataRootCreated: created }) + '\n')
  process.exitCode = code === 130 && !created ? 0 : 1
  if (!path.isAbsolute(directory) || !path.basename(directory).startsWith('harnessl3-cancel-native-')) throw new Error('Unsafe cancellation probe cleanup target')
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
