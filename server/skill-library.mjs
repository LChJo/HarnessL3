import { createHash } from 'node:crypto'
import { readFile, readdir, realpath } from 'node:fs/promises'
import { join, relative, isAbsolute, sep } from 'node:path'
import { parseDocument } from 'yaml'

const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const inside = (root, path) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep) }
const allowedName = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/

export function verifySkillPlan(plan) {
  try {
    if (!plan || plan.status !== 'selected' || !Array.isArray(plan.skills)) throw new Error('方案结构无效')
    for (const skill of plan.skills) {
      if (!Array.isArray(skill.files) || !skill.files.length) throw new Error('文件组缺失')
      const paths = new Set()
      for (const file of skill.files) {
        if (!file || typeof file.path !== 'string' || file.path.startsWith('/') || file.path.includes('\\') || file.path.split('/').includes('..') || paths.has(file.path) || typeof file.content !== 'string' || !['utf8', 'base64'].includes(file.encoding)) throw new Error('文件结构无效')
        paths.add(file.path)
        const bytes = Buffer.from(file.content, file.encoding)
        if (file.encoding === 'base64' && bytes.toString('base64') !== file.content || bytes.length !== file.bytes || digest(bytes) !== file.hash) throw new Error('文件指纹不匹配')
      }
      if (digest(skill.files.map(file => [file.path, file.hash])) !== skill.contentHash) throw new Error('文件组指纹不匹配')
    }
    return plan
  } catch { throw fail('历史技能文件缺失或损坏，内容指纹不匹配；不会以当前文件代替', 409) }
}

export function createSkillLibrary({ root }) {
  async function scan() {
    const base = await realpath(root), bundles = [], names = new Set()
    async function entries(path) { return (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en')) }
    async function filesAt(directory, prefix = '', depth = 0) {
      if (depth > 12) throw fail('技能文件层级过深')
      const files = []
      for (const entry of await entries(directory)) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        const path = join(directory, entry.name), resolved = await realpath(path)
        if (!inside(base, resolved) || entry.isSymbolicLink()) throw fail('技能文件不能通过链接越出或替换目录边界')
        const local = prefix + entry.name
        if (entry.isDirectory()) files.push(...await filesAt(path, local + '/', depth + 1))
        else if (entry.isFile()) {
          const bytes = await readFile(path)
          if (bytes.length > 2 * 1024 * 1024) throw fail('单个技能文件不能超过 2 MiB')
          const text = bytes.toString('utf8'), encoding = Buffer.from(text).equals(bytes) ? 'utf8' : 'base64'
          files.push({ path: local, content: encoding === 'utf8' ? text : bytes.toString('base64'), encoding, hash: digest(bytes), bytes: bytes.length })
        }
        if (files.length > 200) throw fail('单个技能附件不能超过 200 个文件')
      }
      return files
    }
    for (const group of await entries(base)) {
      if (!group.isDirectory() || !allowedName.test(group.name)) continue
      for (const folder of await entries(join(base, group.name))) {
        // A configured upstream library may still contain the original router.
        // Routing is built in; these folders never become ordinary candidates.
        if (!folder.isDirectory() || !allowedName.test(folder.name) || ['ask-matt', 'skill-hub'].includes(folder.name)) continue
        const directory = join(base, group.name, folder.name), skillFile = join(directory, 'SKILL.md')
        let files
        try {
          if (!inside(base, await realpath(skillFile))) throw fail('技能正文不能越出目录边界')
          files = await filesAt(directory)
        } catch (error) { if (error.code === 'ENOENT') continue; throw error }
        const body = files.find(file => file.path === 'SKILL.md')
        if (!body || body.encoding !== 'utf8') throw fail(`${group.name}/${folder.name}: SKILL.md 应为 UTF-8 文本`)
        // Metadata and hashes must derive from the same captured bytes, even during edits.
        const raw = body.content
        const match = raw.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
        if (!match) throw fail(`${group.name}/${folder.name}: 缺少有效的 SKILL.md frontmatter`)
        const document = parseDocument(match[1], { version: '1.2', uniqueKeys: true, stringKeys: true, customTags: [] })
        if (document.errors.length || document.warnings.length) throw fail(`${group.name}/${folder.name}: YAML 无效：${[...document.errors, ...document.warnings].map(e => e.message).join('; ')}`)
        const metadata = document.toJS({ maxAliasCount: 50 })
        if (!metadata || typeof metadata !== 'object' || typeof metadata.name !== 'string' || !allowedName.test(metadata.name) || typeof metadata.description !== 'string' || !metadata.description.trim() || metadata.description.length > 4000) throw fail(`${group.name}/${folder.name}: name/description 无效`)
        if (['ask-matt', 'skill-hub'].includes(metadata.name) || ['ask-matt', 'skill-hub'].includes(folder.name)) throw fail('Skill Hub 是 CLI 内置路由器，不能由普通技能覆盖')
        if (metadata.related !== undefined && (!Array.isArray(metadata.related) || metadata.related.length > 100 || metadata.related.some(path => typeof path !== 'string' || !path || path.length > 500))) throw fail(`${group.name}/${folder.name}: related 应为相对 SKILL.md 路径数组`)
        if (names.has(metadata.name)) throw fail(`技能重名：${metadata.name}`)
        names.add(metadata.name)
        const id = `${group.name}/${folder.name}`
        const contentHash = digest(files.map(file => [file.path, file.hash]))
        bundles.push({ id, name: metadata.name, description: metadata.description.trim(), group: group.name, path: `skills/${id}/SKILL.md`, sourcePath: skillFile.replaceAll('\\', '/'), contentHash, metadata, files })
      }
    }
    const revision = digest(bundles.map(skill => [skill.id, skill.contentHash]))
    const byId = new Map(bundles.map(bundle => [bundle.id, bundle]))
    for (const bundle of bundles) {
      bundle.related = []; bundle.diagnostics = []
      for (const path of bundle.metadata.related ?? []) {
        const target = join(base, bundle.id, path)
        if (isAbsolute(path) || path.includes('\\') || !inside(base, target)) { bundle.diagnostics.push(`关联引用越出技能目录：${path}`); continue }
        const local = relative(base, target).replaceAll('\\', '/')
        const id = local.endsWith('/SKILL.md') ? local.slice(0, -9) : null
        if (!id || !byId.has(id)) bundle.diagnostics.push(`关联技能不存在：${path}`)
        else if (id !== bundle.id && !bundle.related.includes(id)) bundle.related.push(id)
      }
    }
    const skills = bundles.map(({ metadata, files, ...brief }) => ({ ...brief, fileCount: files.length, files: files.map(({ content, ...file }) => file) }))
    return { root: base.replaceAll('\\', '/'), revision, skills, diagnostics: skills.flatMap(skill => skill.diagnostics.map(message => ({ skillId: skill.id, message }))), bundles }
  }
  return {
    async catalog() { const { bundles, ...catalog } = await scan(); return catalog },
    async select(requests, expectedRevision) {
      if (!Array.isArray(requests) || requests.length > 100 || requests.some(item => !item || typeof item.id !== 'string' || typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 1500 || Object.keys(item).some(key => !['id', 'reason'].includes(key)))) throw fail('skills 应为含 id 和非空 reason 的数组')
      const current = await scan()
      if (!expectedRevision || current.revision !== expectedRevision) throw fail('技能目录版本已变化，请重新获取入口提示；未保存旧选择', 409)
      const seen = new Set(), selected = []
      for (const item of requests) {
        if (seen.has(item.id)) throw fail('技能选择不能重复')
        const skill = current.bundles.find(skill => skill.id === item.id)
        if (!skill) throw fail(`未知或无效技能：${item.id}`)
        seen.add(item.id); selected.push({ ...skill, reason: item.reason.trim() })
      }
      return { catalogRevision: current.revision, skills: selected }
    },
  }
}
