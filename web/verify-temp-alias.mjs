import assert from 'node:assert/strict'
import { execFile as callbackExecFile } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

assert.equal(process.platform, 'win32', 'this gate exercises native Windows junction aliases')
const execFile = promisify(callbackExecFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const base = await realpath(await mkdtemp(path.join(tmpdir(), 'harnessl3-browser-alias-check-')))
const physical = path.join(base, 'physical temp'), alias = path.join(base, 'temp alias')
const inside = (parent, entry) => { const local = path.relative(parent, entry); return local && !path.isAbsolute(local) && local !== '..' && !local.startsWith('..' + path.sep) }
const redact = value => String(value ?? '')
  .replace(/Bearer\s+[^\s'"<>]+/gi, 'Bearer [redacted]')
  .replace(/((?:token|nonce|authorization|cookie)["'\s]*[:=]["'\s]*)[^\s'",;}<>]+/gi, '$1[redacted]')
  .replace(/([#?&]code=)[^&\s'"<>]+/gi, '$1[redacted]')
  .replaceAll(root, '[checkout]/')
let report
try {
  await mkdir(physical)
  assert.ok(inside(base, physical) && inside(base, alias))
  await symlink(physical, alias, 'junction')
  assert.equal(await realpath(alias), physical)
  console.log(JSON.stringify({ phase: 'start', platform: process.platform, node: process.version, browserChannel: process.env.BROWSER_CHANNEL ?? 'msedge', tempIsAlias: alias !== physical }))
  try {
    const child = await execFile(process.execPath, [path.join(root, 'scripts/v1/browser-smoke.mjs')], {
      cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60 * 1000,
      env: { ...process.env, TEMP: alias, TMP: alias, HARNESS_SKILLS_ROOT: '', HARNESSL3_HOME: '' },
    })
    report = { platform: process.platform, node: process.version, browserChannel: process.env.BROWSER_CHANNEL ?? 'msedge', tempIsAlias: true, exitCode: 0, stdout: redact(child.stdout), stderr: redact(child.stderr) }
  } catch (error) {
    report = { platform: process.platform, node: process.version, browserChannel: process.env.BROWSER_CHANNEL ?? 'msedge', tempIsAlias: true, exitCode: typeof error.code === 'number' ? error.code : 1, error: redact(error.message), stdout: redact(error.stdout), stderr: redact(error.stderr) }
    process.exitCode = report.exitCode
  }
  await mkdir(path.join(root, 'web/validation'), { recursive: true })
  await writeFile(path.join(root, 'web/validation/temp-alias-browser-win32.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally {
  // Remove this exact junction before recursive cleanup of its owned target.
  if (await realpath(alias).catch(() => null)) { assert.equal(await realpath(alias), physical); await unlink(alias) }
  assert.equal(await realpath(base), base)
  assert.ok(path.isAbsolute(base) && path.basename(base).startsWith('harnessl3-browser-alias-check-'))
  assert.equal(await realpath(physical), physical)
  assert.ok(inside(base, physical))
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
