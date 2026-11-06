import { mkdir, lstat, realpath, readFile, writeFile, rename, unlink, open, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const packagedSkill = fileURLToPath(new URL('../agent-skills/harnessl3/', import.meta.url))

export function resolveSkillTargets({ home = homedir(), env = process.env } = {}) {
  return {
    codexSkillsDir: path.join(home, '.agents', 'skills'),
    claudeSkillsDir: path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'skills'),
  }
}

async function statIfPresent(file) {
  try { return await lstat(file) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

async function skillFiles(source) {
  const files = []
  async function visit(directory, prefix = '') {
    const stat = await lstat(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Refusing non-directory or symbolic link source: ${directory}`)
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name)
      const relativePath = prefix + name
      const entry = await lstat(file)
      if (entry.isSymbolicLink()) throw new Error(`Refusing source symbolic link/junction: ${file}`)
      if (entry.isDirectory()) await visit(file, relativePath + '/')
      else if (entry.isFile()) files.push({ relativePath, bytes: await readFile(file) })
      else throw new Error(`Refusing non-regular source: ${file}`)
    }
  }
  await visit(source)
  if (!files.some(file => file.relativePath === 'SKILL.md' && file.bytes.length)) throw new Error('Packaged HarnessL3 runtime SKILL.md is missing or empty')
  return files
}

async function checkDestination(directory, relativePath) {
  const components = relativePath.split('/')
  let current = directory
  for (const [index, component] of components.entries()) {
    current = path.join(current, component)
    const stat = await statIfPresent(current)
    if (stat?.isSymbolicLink()) throw new Error(`Refusing destination symbolic link/junction: ${current}`)
    if (stat && (index < components.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error(`Refusing incompatible destination: ${current}`)
  }
}

async function copySkill(root, sourceFiles) {
  if (!path.isAbsolute(root)) throw new Error(`Skill directory must be absolute: ${root}`)
  await mkdir(root, { recursive: true })
  // A user's skills root may itself be a symlink; only the named skill is managed.
  root = await realpath(root)
  const directory = path.join(root, 'harnessl3')
  const existingDirectory = await statIfPresent(directory)
  if (existingDirectory?.isSymbolicLink()) throw new Error(`Refusing skill directory symbolic link/junction: ${directory}`)
  if (existingDirectory && !existingDirectory.isDirectory()) throw new Error(`Skill path is not a directory: ${directory}`)
  await mkdir(directory, { recursive: true })
  const lock = path.join(directory, '.harnessl3-install.lock')
  const handle = await open(lock, 'wx')
  const entry = path.join(directory, 'SKILL.md')
  const files = []
  try {
    // Check every attachment path before replacing any file, including SKILL.md.
    for (const source of sourceFiles) await checkDestination(directory, source.relativePath)
    const snapshots = []
    for (const source of sourceFiles) {
      const destination = path.join(directory, source.relativePath)
      snapshots.push({ ...source, path: destination, before: await statIfPresent(destination) ? await readFile(destination) : null })
    }
    const backupDirectory = path.join(path.dirname(root), '.harnessl3-skill-backups', randomUUID())
    for (const file of snapshots) {
      if (file.before && !file.before.equals(file.bytes)) {
        file.backup = path.join(backupDirectory, file.relativePath)
        await mkdir(path.dirname(file.backup), { recursive: true })
        await writeFile(file.backup, file.before, { flag: 'wx' })
      }
    }
    for (const file of snapshots) {
      const status = file.before?.equals(file.bytes) ? 'unchanged' : file.before ? 'updated' : 'installed'
      if (status !== 'unchanged') {
        await mkdir(path.dirname(file.path), { recursive: true })
        const temporary = path.join(path.dirname(file.path), `.harnessl3-${randomUUID()}.tmp`)
        const output = await open(temporary, 'wx')
        try {
          try { await output.writeFile(file.bytes) } finally { await output.close() }
          await rename(temporary, file.path)
        } finally {
          await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
        }
      }
      if (!(await readFile(file.path)).equals(file.bytes)) throw new Error(`Skill copy verification failed: ${file.path}`)
      files.push({ path: file.path, relativePath: file.relativePath, status, ...(file.backup ? { backup: file.backup } : {}) })
    }
    const primary = files.find(file => file.relativePath === 'SKILL.md')
    const status = files.every(file => file.status === 'unchanged') ? 'unchanged' : snapshots.find(file => file.relativePath === 'SKILL.md').before ? 'updated' : 'installed'
    return { path: entry, status, files, ...(primary.backup ? { backup: primary.backup } : {}) }
  } catch (error) {
    error.files = files
    throw error
  } finally {
    try { await handle.close() } finally { await unlink(lock) }
  }
}

/** Explicit installer only: never runs from npm lifecycle hooks or the runtime skill. */
export async function installAgentSkills({ source = packagedSkill, ...options } = {}) {
  const targets = { ...resolveSkillTargets(), ...options }
  const sourceFiles = await skillFiles(source)
  const results = []
  try {
    for (const [agent, root] of [['codex', targets.codexSkillsDir], ['claude-code', targets.claudeSkillsDir]]) {
      try { results.push({ agent, ...await copySkill(root, sourceFiles) }) }
      catch (error) { error.current = { agent, files: error.files || [] }; throw error }
    }
    return results
  } catch (error) {
    error.results = results
    throw error
  }
}

function parseArguments(args) {
  const options = {}
  const flags = { '--codex-skills-dir': 'codexSkillsDir', '--claude-skills-dir': 'claudeSkillsDir' }
  for (let index = 0; index < args.length; index += 2) {
    const key = Object.hasOwn(flags, args[index]) ? flags[args[index]] : undefined
    const value = args[index + 1]
    if (!key || key in options || !value || !path.isAbsolute(value)) {
      throw new Error('Usage: node install-agent-skills.mjs [--codex-skills-dir <absolute-directory>] [--claude-skills-dir <absolute-directory>]')
    }
    options[key] = value
  }
  return options
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const results = await installAgentSkills(parseArguments(process.argv.slice(2)))
    process.stdout.write(JSON.stringify({ ok: true, results }) + '\n')
  } catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, error: error.message, results: error.results || [], ...(error.current ? { current: error.current } : {}) }) + '\n')
    process.exitCode = 1
  }
}
