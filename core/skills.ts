import { mkdir, readdir, realpath, readFile, writeFile, symlink, rm, lstat, rmdir } from 'node:fs/promises'
import { join, relative, isAbsolute, resolve, sep, basename, dirname, posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { parseDocument } from 'yaml'
import { HarnessError } from './errors.js'
import { digest, sha256, parseJsonStrict } from './json.js'
import type { Diagnostic, FileRef, SelectedSkill, SkillBrief, SkillCatalog } from './types.js'

const namePattern = /^[a-z0-9][a-z0-9-]*$/
const skillPattern = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/
const reserved = new Set(['ask-matt', 'skill-hub'])
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const inside = (root: string, file: string) => {
  const local = relative(root, file)
  return !isAbsolute(local) && local !== '..' && !local.startsWith('..' + sep)
}
const localPath = (root: string, file: string) => relative(root, file).split(sep).join('/')
const safeFile = (path: string) => !!path && !path.startsWith('/') && !path.includes('\\') && !path.includes(':') && !path.includes('//') && !/[\u0000-\u001f]/.test(path) && !path.split('/').some(part => part === '.' || part === '..' || !part)
const fileManifest = (files: FileRef[]) => files.map(({ path, hash }) => ({ path, hash })).sort((a, b) => compare(a.path, b.path))
function utf8(bytes: Buffer): string | null {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { return null }
}
function invalid(message: string): never { throw new HarnessError('CATALOG_INVALID', message) }

/** Current catalog is derived from captured files; a failed scan never reuses old candidates. */
export async function scanSkills(inputRoot: string): Promise<SkillCatalog> {
  let root = resolve(inputRoot)
  const checkedAt = new Date().toISOString()
  const diagnostics: Diagnostic[] = []
  const captured = new Map<string, Buffer>()
  try {
    root = await realpath(root)
    if (!(await lstat(root)).isDirectory()) invalid('The skill root must be a directory.')
    const skills: SkillBrief[] = []
    const metadataById = new Map<string, { related?: unknown }>()
    const names = new Set<string>()
    const sortedEntries = async (dir: string) => (await readdir(dir, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))
    async function filesAt(dir: string, id: string, prefix = ''): Promise<FileRef[]> {
      const files: FileRef[] = []
      for (const entry of await sortedEntries(dir)) {
        const path = join(dir, entry.name)
        if (entry.isSymbolicLink()) invalid(`${id}/${prefix}${entry.name}: symbolic links are not skill attachments and cannot cross a boundary.`)
        const actual = await realpath(path)
        if (!inside(root, actual)) invalid(`${id}: an attachment resolves outside the skill root boundary.`)
        const local = `${prefix}${entry.name}`
        if (!safeFile(local)) invalid(`${id}: invalid relative attachment path ${local}.`)
        if (entry.isDirectory()) files.push(...await filesAt(path, id, local + '/'))
        else if (entry.isFile()) {
          const bytes = await readFile(path)
          captured.set(`${id}/${local}`, bytes)
          files.push({ path: local, hash: sha256(bytes), bytes: bytes.length, encoding: utf8(bytes) === null ? 'base64' : 'utf8' })
        } else invalid(`${id}/${local}: unsupported attachment file type.`)
      }
      return files.sort((a, b) => compare(a.path, b.path))
    }
    for (const group of await sortedEntries(root)) {
      const groupDirectory = join(root, group.name)
      if (group.isSymbolicLink()) invalid(`${group.name}: a skill group cannot be a symbolic link.`)
      if (!group.isDirectory()) continue
      for (const folder of await sortedEntries(groupDirectory)) {
        const directory = join(groupDirectory, folder.name)
        if (folder.isSymbolicLink()) invalid(`${group.name}/${folder.name}: a skill folder cannot be a symbolic link.`)
        if (!folder.isDirectory()) continue
        const skillFile = join(directory, 'SKILL.md')
        try { await lstat(skillFile) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
        const id = `${group.name}/${folder.name}`
        if (!namePattern.test(group.name) || !namePattern.test(folder.name)) invalid(`${id}: skill group/name must use lowercase letters, digits and hyphens.`)
        if (reserved.has(folder.name)) invalid(`${id}: Skill Hub routing is built in and cannot be replaced by an ordinary skill.`)
        const files = await filesAt(directory, id)
        const bytes = captured.get(`${id}/SKILL.md`)
        const raw = bytes && utf8(bytes)
        if (typeof raw !== 'string') invalid(`${id}: SKILL.md must contain valid UTF-8 text.`)
        const match = raw.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
        if (!match) invalid(`${id}: SKILL.md needs valid YAML frontmatter.`)
        const yaml = parseDocument(match[1]!, { version: '1.2', uniqueKeys: true, stringKeys: true, customTags: [] })
        if (yaml.errors.length || yaml.warnings.length) invalid(`${id}: invalid YAML frontmatter: ${[...yaml.errors, ...yaml.warnings].map(error => error.message).join('; ')}`)
        const metadata = yaml.toJS({ maxAliasCount: 50 }) as { name?: unknown; description?: unknown; related?: unknown } | null
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || typeof metadata.name !== 'string' || !metadata.name.trim() || typeof metadata.description !== 'string' || !metadata.description.trim()) invalid(`${id}: frontmatter name and description must be nonempty strings.`)
        if (reserved.has(metadata.name.trim())) invalid(`${id}: Skill Hub routing is built in and cannot be replaced by an ordinary skill.`)
        if (names.has(metadata.name.trim())) invalid(`Duplicate skill display name: ${metadata.name.trim()}.`)
        names.add(metadata.name.trim())
        if (metadata.related !== undefined && (!Array.isArray(metadata.related) || metadata.related.some(item => typeof item !== 'string' || !item.trim()))) invalid(`${id}: related must be an array of relative SKILL.md references.`)
        metadataById.set(id, metadata)
        skills.push({ id, name: metadata.name.trim(), group: group.name, description: metadata.description.trim(), contentHash: digest('skill-files', fileManifest(files)), files, related: [], diagnostics: [] })
      }
    }
    const byId = new Map(skills.map(skill => [skill.id, skill]))
    for (const skill of skills) {
      for (const path of (metadataById.get(skill.id)?.related ?? []) as string[]) {
        let message: string | undefined
        if (path.includes('\\') || path.includes(':') || path.startsWith('/') || /[\u0000-\u001f]/.test(path)) message = `Related skill path is not a relative POSIX reference: ${path}`
        const local = posix.normalize(posix.join(skill.id, path))
        const id = local.endsWith('/SKILL.md') ? local.slice(0, -'/SKILL.md'.length) : ''
        if (!message && (!skillPattern.test(id) || !byId.has(id))) message = `Related skill does not exist inside this catalog: ${path}`
        if (message) {
          skill.diagnostics.push(message)
          diagnostics.push({ code: 'SKILL_RELATED', severity: 'warning', file: `${skill.id}/SKILL.md`, message })
        } else if (id !== skill.id && !skill.related.includes(id)) skill.related.push(id)
      }
    }
    const manifest = skills.flatMap(skill => skill.files.map(({ path, hash }) => ({ path: `${skill.id}/${path}`, hash }))).sort((a, b) => compare(a.path, b.path))
    return { root, revision: digest('skill-catalog', manifest), skills, diagnostics, checkedAt, valid: true, files: captured }
  } catch (error) {
    diagnostics.push({ code: 'CATALOG_INVALID', severity: 'error', message: error instanceof Error ? error.message : String(error) })
    return { root, revision: null, skills: [], diagnostics, checkedAt, valid: false, files: new Map() }
  }
}

/** Freeze only explicitly selected methods. Related references are suggestions, never dependencies. */
export function captureSkills(catalog: SkillCatalog, selections: { id: string; reason: string }[]): { skills: SelectedSkill[]; blobs: Map<string, Buffer> } {
  if (!catalog.valid || !catalog.revision) throw new HarnessError('CATALOG_INVALID', 'The current skill catalog is invalid.', { diagnostics: catalog.diagnostics })
  if (!Array.isArray(selections)) throw new HarnessError('INVALID_ARGUMENT', 'skills must be an array of explicit IDs and reasons.')
  const seen = new Set<string>()
  const selected: SelectedSkill[] = []
  const blobs = new Map<string, Buffer>()
  for (const selection of selections) {
    if (!selection || typeof selection.id !== 'string' || !skillPattern.test(selection.id) || typeof selection.reason !== 'string' || !selection.reason.trim() || Object.keys(selection).some(key => key !== 'id' && key !== 'reason') || seen.has(selection.id)) throw new HarnessError('INVALID_ARGUMENT', 'Each selected skill needs a unique catalog ID and a nonempty reason.')
    seen.add(selection.id)
    const skill = catalog.skills.find(item => item.id === selection.id)
    if (!skill) throw new HarnessError('INVALID_ARGUMENT', `Unknown current skill ID: ${selection.id}`)
    if (digest('skill-files', fileManifest(skill.files)) !== skill.contentHash) throw new HarnessError('CATALOG_INVALID', `Skill file manifest changed inside the captured catalog: ${selection.id}`)
    for (const file of skill.files) {
      const bytes = catalog.files.get(`${skill.id}/${file.path}`)
      if (!bytes || sha256(bytes) !== file.hash || bytes.length !== file.bytes) throw new HarnessError('CATALOG_INVALID', `Captured skill bytes are missing or changed: ${selection.id}/${file.path}`)
      blobs.set(file.hash, Buffer.from(bytes))
    }
    selected.push({ id: skill.id, name: skill.name, group: skill.group, description: skill.description, reason: selection.reason.trim(), contentHash: skill.contentHash, files: structuredClone(skill.files) })
  }
  return { skills: selected, blobs }
}

interface SeedOwner { version: 1; token: string; pid: number; target: string }
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' } }
async function exists(file: string): Promise<boolean> { try { await lstat(file); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
async function unlock(lock: string, token: string): Promise<void> {
  try {
    const owner = parseJsonStrict(await readFile(join(lock, 'owner.json'), 'utf8')) as SeedOwner
    if (owner.token !== token) return
    const contents = await readdir(lock)
    if (contents.length !== 1 || contents[0] !== 'owner.json') return
    await rm(join(lock, 'owner.json'))
    await rmdir(lock)
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}

/** A published entity is editable user content, not disposable staging or a cache. */
async function discardUnpublishedEntity(entity: string, target: string, identity: { dev: number; ino: number }): Promise<void> {
  let current
  try { current = await lstat(entity) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  // Only remove the exact directory created by this invocation.
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) return
  try {
    const actualTarget = await realpath(target)
    const actualEntity = await realpath(entity)
    if (inside(actualEntity, actualTarget) || inside(actualTarget, actualEntity)) return
  } catch {
    // An existing but unresolved entry may still refer into this entity. Preserve it.
    if (await exists(target)) return
  }
  await rm(entity, { recursive: true, force: true })
}

/** Seed is user content: existing roots (including empty roots) are never merged or upgraded. */
export async function seedSkills(seedRoot: string, targetRoot: string): Promise<'created' | 'already-present'> {
  const target = resolve(targetRoot)
  if (await exists(target)) return 'already-present'
  const parent = dirname(target)
  await mkdir(parent, { recursive: true })
  const lock = join(parent, `.${basename(target)}.seed-lock`)
  const token = randomUUID()
  const entity = join(parent, `.${basename(target)}-library-${token}`)
  let entityIdentity: { dev: number; ino: number } | undefined
  let published = false
  let locked = false
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await exists(target)) return 'already-present'
    try {
      await mkdir(lock)
      locked = true
      try { await writeFile(join(lock, 'owner.json'), JSON.stringify({ version: 1, token, pid: process.pid, target } satisfies SeedOwner), { flag: 'wx' }) }
      catch (error) { locked = false; await rmdir(lock).catch(() => {}); throw error }
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        if ((await lstat(lock)).isSymbolicLink()) throw new HarnessError('BUSY', 'The skill seed lock path is an unexpected symbolic link.', {}, true)
        const owner = parseJsonStrict(await readFile(join(lock, 'owner.json'), 'utf8')) as SeedOwner
        if (owner.version === 1 && owner.target === target && typeof owner.token === 'string' && Number.isInteger(owner.pid) && owner.pid > 0 && !alive(owner.pid)) await unlock(lock, owner.token)
      } catch (lockError) { if (lockError instanceof HarnessError && lockError.code === 'BUSY') throw lockError }
      await delay(25)
    }
  }
  if (!locked) throw new HarnessError('BUSY', 'Another process is still publishing this skill seed, or its lock could not be safely verified.', { target }, true)
  try {
    if (await exists(target)) return 'already-present'
    const base = await realpath(seedRoot)
    const actualTarget = join(await realpath(parent), basename(target))
    if (inside(base, actualTarget) || inside(actualTarget, base)) throw new HarnessError('INVALID_ARGUMENT', 'Seed source and target directories must not overlap.')
    await mkdir(entity)
    const metadata = await lstat(entity)
    entityIdentity = { dev: metadata.dev, ino: metadata.ino }
    async function copy(dir: string, destination: string): Promise<void> {
      const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))
      for (const entry of entries) {
        const source = join(dir, entry.name), output = join(destination, entry.name)
        if (entry.isSymbolicLink()) throw new HarnessError('INVALID_ARGUMENT', 'The bundled skill seed must contain regular files and directories only.')
        if (!inside(base, await realpath(source))) throw new HarnessError('INVALID_ARGUMENT', 'A bundled skill seed path resolves outside its source boundary.')
        if (entry.isDirectory()) { await mkdir(output); await copy(source, output) }
        else if (entry.isFile()) await writeFile(output, await readFile(source), { flag: 'wx' })
        else throw new HarnessError('INVALID_ARGUMENT', 'The bundled skill seed contains an unsupported file type.')
      }
    }
    await copy(base, entity)
    if (await exists(target)) return 'already-present'
    // Directory rename replaces a concurrent empty directory on POSIX. Link creation
    // exclusively installs the logical entry on every supported platform instead.
    try {
      await symlink(process.platform === 'win32' ? resolve(entity) : basename(entity), target, process.platform === 'win32' ? 'junction' : 'dir')
      published = true
    }
    catch (error) { if (await exists(target)) return 'already-present'; throw error }
    return 'created'
  } finally {
    try {
      if (!published && entityIdentity) await discardUnpublishedEntity(entity, target, entityIdentity)
    } finally { await unlock(lock, token) }
  }
}
