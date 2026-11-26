import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile as callbackExecFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseArgs } from '../../build/cli/args.js'

export const execFile = promisify(callbackExecFile)
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const binary = path.join(projectRoot, 'bin/harnessl3.mjs')
export async function fixture(t, prefix = 'harnessl3-v1-', { legacy = true } = {}) {
  // Resolve native aliases up front (macOS /private/var, Windows 8.3 spellings)
  // so fixtures and the canonical roots reported by the service stay comparable.
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), prefix)))
  const dataRoot = path.join(directory, 'user data')
  const git = (cwd, ...args) => execFile('git', ['-C', cwd, ...args], { windowsHide: true })
  const cli = async (args, { cwd = directory, input, env = {} } = {}) => {
    // Existing native archive regression fixtures deliberately exercise v1
    // compatibility. The new-format tests pass legacy:false (real default).
    if (legacy) {
      let operation;
      try { operation = parseArgs([...args, '--data-dir', dataRoot, '--json'], cwd).operation } catch { /* Invalid commands must not initialize a fixture. */ }
      if (operation && !['help', 'version', 'serve status', 'serve stop'].includes(operation)) {
        await mkdir(dataRoot, { recursive: true });
        await writeFile(path.join(dataRoot, 'registry.json'), '{"schemaVersion":1,"projects":[],"worktrees":[]}\n', { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error });
      }
    }
    return new Promise((resolve, reject) => {
    const child = callbackExecFile(process.execPath, [binary, ...args, '--data-dir', dataRoot, '--json'], {
      cwd, env: { ...process.env, HARNESS_SKILLS_ROOT: '', HARNESSL3_HOME: '', ...env }, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const code = error ? typeof error.code === 'number' ? error.code : 1 : 0
      let body = null
      try { body = JSON.parse(stdout) } catch { /* A missing/extra JSON result is asserted by the caller. */ }
      resolve({ code, stdout, stderr, body })
    })
    child.once('error', reject)
    child.stdin.end(input ?? '')
    })
  }
  t.after(async () => {
    await cli(['serve', 'stop']).catch(() => {})
    // The resolved mkdtemp root is the only recursively removed test directory.
    if (!path.isAbsolute(directory) || !path.basename(directory).startsWith(prefix)) throw new Error('Unsafe test cleanup target')
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  let count = 0
  const repository = async (name = `project-${++count}`) => {
    const root = path.join(directory, name)
    await mkdir(root, { recursive: true })
    await git(root, 'init', '-b', 'main')
    await git(root, 'config', 'user.name', 'HarnessL3 Fixture')
    await git(root, 'config', 'user.email', 'fixture@example.invalid')
    await writeFile(path.join(root, 'README.md'), 'A test project\n')
    await git(root, 'add', 'README.md'); await git(root, 'commit', '-m', 'Initial fixture')
    return root
  }
  return { directory, dataRoot, git, cli, repository }
}
