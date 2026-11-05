import { mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const reportRoot = path.join(root, '.harness-local', 'validation')
await mkdir(reportRoot, { recursive: true })
const directories = process.argv.includes('--formal') ? ['tests/v1'] : ['tests', 'tests/v1']
const files = (await Promise.all(directories.map(async directory => (await readdir(path.join(root, directory))).filter(file => file.endsWith('.test.mjs')).sort().map(file => directory + '/' + file)))).flat()
const child = spawn(process.execPath, ['--test', '--test-concurrency=4', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', '--test-reporter-destination=' + path.join(reportRoot, `tests-${process.platform}.xml`), ...files], { cwd: root, stdio: 'inherit', windowsHide: true })
child.once('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1 })
child.once('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1 })
