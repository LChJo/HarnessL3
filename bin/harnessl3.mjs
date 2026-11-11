#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
const jsonMode = process.argv.slice(2).some(arg => arg === '--json' || arg.startsWith('--json='))
function fail(code, message, details = {}) {
  if (jsonMode) {
    const supplied = process.argv.slice(2).find(arg => arg.startsWith('--request-id='))?.slice('--request-id='.length)
      ?? process.argv[process.argv.indexOf('--request-id') + 1]
    const requestId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(supplied ?? '') ? supplied : randomUUID()
    process.stdout.write(JSON.stringify({ schemaVersion: 1, requestId, target: null, replayed: false, ok: false, error: { code, message, retryable: false, details } }) + '\n')
  } else process.stderr.write(message + '\n')
  process.exitCode = 1
}
const [major, minor] = process.versions.node.split('.').map(Number)
if (major !== 24 || minor < 12) {
  fail('RUNTIME_UNSUPPORTED', 'HarnessL3 requires Node.js 24.12.0 or newer on the Node 24 LTS line.', { nodeVersion: process.versions.node })
} else {
  try { const { runCli } = await import('../build/cli/main.js'); await runCli(process.argv.slice(2)) }
  catch (error) { fail('CLI_LOAD_FAILED', error?.code === 'ERR_MODULE_NOT_FOUND' ? 'HarnessL3 could not load its installed runtime. Repair or reinstall this package.' : 'HarnessL3 could not load its CLI.', { systemCode: typeof error?.code === 'string' ? error.code : 'unknown' }) }
}
