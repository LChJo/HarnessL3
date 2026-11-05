import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, access, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { digest } from '../../build/core/json.js'

const nativePosix = { timeout: 20_000, skip: process.platform === 'win32' ? 'Windows Ctrl+C is verified through the native ConPTY cancel-probe, not process.kill emulation.' : false }
async function run(t, args, directory) {
  const moduleUrl = new URL('../../build/cli/main.js', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', `const {runCli}=await import(${JSON.stringify(moduleUrl)}); const running=runCli(${JSON.stringify(args)});process.send('ready');await running;process.disconnect();`], { cwd: directory, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: { ...process.env, HARNESSL3_HOME: '', HARNESS_SKILLS_ROOT: '' } })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  const exit = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })))
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', code => { if (code) reject(new Error(stderr)) }) })
  return { child, exit }
}
async function temporary(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'harness-v1-cancellation-')))
  t.after(async () => { if (!path.isAbsolute(root) || !path.basename(root).startsWith('harness-v1-cancellation-')) throw new Error('Unsafe cancellation cleanup'); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  return root
}

test('TC22 POSIX SIGINT while waiting for stdin returns one CANCELLED/130 before service startup', nativePosix, async t => {
  const root = await temporary(t), dataRoot = path.join(root, 'not-created-data')
  const requestId = randomUUID()
  const { child, exit } = await run(t, ['context', 'query', randomUUID(), '--file', '-', '--data-dir', dataRoot, '--request-id', requestId, '--json'], root)
  child.kill('SIGINT')
  const result = await exit
  assert.equal(result.code, 130, result.stderr)
  assert.equal(result.signal, null)
  const response = JSON.parse(result.stdout)
  assert.equal(response.error.code, 'CANCELLED')
  assert.equal(response.requestId, requestId)
  await assert.rejects(access(dataRoot), { code: 'ENOENT' })
})

test('TC22 POSIX cancellation after dispatch preserves accepted work and request identity', nativePosix, async t => {
  const root = await temporary(t), dataRoot = path.join(root, 'data')
  await mkdir(dataRoot)
  const marker = path.join(root, 'accepted-operation.json'), instanceId = randomUUID(), token = 'd'.repeat(64)
  let received
  const accepted = new Promise(resolve => { received = resolve })
  const server = createServer((request, response) => {
    if (request.url === '/health') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ state: 'running', instanceId, pid: process.pid, dataRootHash: digest('data-root', dataRoot), protocolVersion: 1 })); return }
    if (request.url === '/rpc') {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', async () => { const value = JSON.parse(body); await writeFile(marker, JSON.stringify({ requestId: value.requestId })); received(); /* Intentionally withhold the reply after acceptance. */ })
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  await writeFile(path.join(dataRoot, 'service.json'), JSON.stringify({ schemaVersion: 1, protocolVersion: 1, pid: process.pid, instanceId, startedAt: new Date().toISOString(), dataRootHash: digest('data-root', dataRoot), url: `http://127.0.0.1:${server.address().port}`, token }))
  const requestId = randomUUID()
  const { child, exit } = await run(t, ['project', 'list', '--data-dir', dataRoot, '--request-id', requestId, '--json'], root)
  await Promise.race([accepted, exit.then(result => { throw new Error('CLI exited before the fake service accepted the request: ' + JSON.stringify(result)) })])
  child.kill('SIGINT')
  const result = await exit
  assert.equal(result.code, 130, result.stderr)
  const response = JSON.parse(result.stdout)
  assert.equal(response.error.code, 'CANCELLED')
  assert.equal(response.requestId, requestId)
  assert.equal(JSON.parse(await readFile(marker, 'utf8')).requestId, requestId)
})
