import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'

const step = process.argv[2]
if (!['browser-smoke', 'package-smoke'].includes(step)) throw new Error('Expected browser-smoke or package-smoke')
const child = spawn(process.execPath, [`scripts/v1/${step}.mjs`], { stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true })
let stdout = '', stderr = '', stderrHead = ''
child.stdout.on('data', chunk => { process.stdout.write(chunk); stdout = (stdout + chunk).slice(-24_000) })
child.stderr.on('data', chunk => { process.stderr.write(chunk); stderrHead = (stderrHead + chunk).slice(0, 8000); stderr = (stderr + chunk).slice(-24_000) })
const safe = value => value
  .replace(/Bearer\s+[^\s'"<>]+/gi, 'Bearer [redacted]')
  .replace(/((?:token|nonce|authorization|cookie)["'\s]*[:=]["'\s]*)[^\s'",;}<>]+/gi, '$1[redacted]')
  .replace(/([#?&](?:code|nonce|token)=)[^&\s'"<>]+/gi, '$1[redacted]')
  .replaceAll(process.cwd(), '[checkout]')
const result = await new Promise(resolve => {
  child.once('error', error => resolve({ code: 1, error: error.message }))
  child.once('close', (code, signal) => resolve({ code, signal }))
})
const report = { step, platform: process.platform, node: process.version, ...result, ...(result.code === 0 ? {} : { stderr: safe(stderr), stdout: safe(stdout) }) }
await mkdir('.harness-local/validation', { recursive: true })
await writeFile(`.harness-local/validation/ci-${step}-${process.platform}.json`, JSON.stringify(report, null, 2) + '\n')
if (result.code !== 0 && process.env.GITHUB_ACTIONS === 'true') {
  const combined = stderrHead + '\n' + stderr
  const locations = combined.split('\n').filter(line => /(?:AssertionError|TimeoutError|Error:|\.mjs:\d+|Expected values|operator:)/.test(line)).map(line => line.slice(0, 500)).slice(-12).join('\n')
  const details = safe(stderr ? stderrHead.slice(0, 3000) + '\n' + locations : stdout || result.error || `Exit ${result.code}, signal ${result.signal}`).slice(0, 6000)
  const escape = value => value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
  console.log(`::error title=${step} ${process.platform}::${escape(details)}`)
}
process.exitCode = result.code ?? 1
