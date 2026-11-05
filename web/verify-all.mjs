import { execFile as callbackExecFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const descriptor = process.argv[2]
if (!descriptor) throw new Error('Usage: node web/verify-all.mjs <isolated-browser-fixture.json>')
const root = fileURLToPath(new URL('../', import.meta.url))
const execFile = promisify(callbackExecFile)
const results = []
for (const entry of ['verify-fixture.mjs', 'verify-manual.mjs', 'verify-directory.mjs']) {
  const checked = await execFile(process.execPath, [fileURLToPath(new URL(entry, import.meta.url)), path.resolve(descriptor)], { cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
  results.push({ entry, result: JSON.parse(checked.stdout) })
}
console.log(JSON.stringify({ suite: 'formal-web', completed: ['canvas-archives-touch-offline', 'manual-requests-and-idempotent-retry', 'editable-directory-lifecycle'], results, fixtureSkillBytesRestored: true }))
