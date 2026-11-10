import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'

const input = JSON.parse(await fs.readFile(process.argv[2], 'utf8'))
const mode = process.argv[3]
const originalOpen = fs.open, originalReaddir = fs.readdir
let count = 0
fs.open = async (file, ...args) => {
  if (mode === 'unreadable' && path.basename(file) === 'changing.txt') throw Object.assign(new Error('Denied fixture'), { code: 'EACCES' })
  const handle = await originalOpen(file, ...args)
  if (mode === 'bytes' && path.basename(file) === 'changing.txt') {
    const read = handle.readFile.bind(handle)
    handle.readFile = async (...options) => { const bytes = await read(...options); await fs.writeFile(file, ++count % 2 ? 'B' : 'A'); return bytes }
  }
  if (mode === 'late-rule' && path.basename(file) === 'changing.txt') {
    const read = handle.readFile.bind(handle)
    handle.readFile = async (...options) => { const bytes = await read(...options); if (++count % 2 === 0) await fs.writeFile(path.join(input.worktree.root, '.gitignore'), '# Late rule ' + count); return bytes }
  }
  return handle
}
fs.readdir = async (directory, ...args) => {
  const entries = await originalReaddir(directory, ...args)
  if (directory === input.worktree.root) {
    if (mode === 'enumeration') {
      const file = path.join(directory, 'appearing.txt')
      if (++count % 2) await fs.writeFile(file, 'new')
      else await fs.rm(file, { force: true })
    }
    if (mode === 'rules') await fs.writeFile(path.join(directory, '.gitignore'), '# rule revision ' + ++count)
  }
  return entries
}
syncBuiltinESMExports()
const { scanSource } = await import('../../build/core/source.js')
console.log(JSON.stringify(await scanSource(input.worktree, input.config, input.skillsRoot)))
