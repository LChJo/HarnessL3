import cp from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { syncBuiltinESMExports } from 'node:module'

// Fault injection stays in this child process and in the caller's isolated fixture.
const request = JSON.parse(await fs.readFile(process.argv[2], 'utf8'))
const commands = [], originalExec = cp.execFile, originalOpen = fs.open, originalReaddir = fs.readdir
let mutations = 0, openedTreeFiles = 0, pipeFailure = false, queriedLinkedDescendant = false
const target = path.join(request.worktree.root, 'README.md')
const same = (left, right) => path.resolve(left) === path.resolve(right)
const replaceTree = async () => {
  mutations++
  await fs.rename(path.join(request.worktree.root, 'tree'), request.savedTree)
  await fs.symlink(request.outside, path.join(request.worktree.root, 'tree'), process.platform === 'win32' ? 'junction' : 'dir')
}
fs.readdir = async (...args) => {
  const result = await originalReaddir(...args)
  if (request.mode === 'pending-ancestor-link' && !mutations && same(String(args[0]), path.join(request.worktree.root, 'z-sibling'))) await replaceTree()
  return result
}
fs.open = async (...args) => {
  const handle = await originalOpen(...args)
  if (String(args[0]).startsWith(path.join(request.worktree.root, 'tree') + path.sep)) openedTreeFiles++
  if (same(String(args[0]), target) && ['write-once', 'write-always'].includes(request.mode)) {
    const read = handle.readFile.bind(handle)
    handle.readFile = async (...options) => {
      const bytes = await read(...options)
      if (!mutations || request.mode === 'write-always') {
        mutations++
        await fs.writeFile(target, 'Mutation ' + mutations + '\n')
      }
      return bytes
    }
  }
  return handle
}
function tracked(...args) {
  const callback = args.pop(), executable = args[0], argv = args[1]
  const command = executable === 'git' ? argv[argv.indexOf('-C') + 2] : null
  const event = command ? { command, inputBytes: 0 } : null
  if (event) commands.push(event)
  const child = originalExec(...args, (error, stdout, stderr) => {
    ;(async () => {
      if (command === 'check-ignore' && !mutations && request.mode === 'ignore-change') {
        mutations++
        await fs.writeFile(path.join(request.worktree.root, '.gitignore'), '')
      }
      if (command === 'check-ignore' && !mutations && request.mode === 'ancestor-link') {
        await replaceTree()
      }
      callback(error, stdout, stderr)
    })().catch(callback)
  })
  if (event && child.stdin) {
    const end = child.stdin.end.bind(child.stdin)
    child.stdin.end = (input, ...rest) => {
      event.inputBytes = input ? Buffer.byteLength(input) : 0
      if (command === 'check-ignore' && mutations && request.mode === 'pending-ancestor-link' && input?.includes('tree/keep.txt')) queriedLinkedDescendant = true
      if (command === 'check-ignore' && request.mode === 'pipe-error' && !pipeFailure) {
        pipeFailure = true
        queueMicrotask(() => child.stdin.emit('error', Object.assign(new Error('Injected source pipe failure'), { code: 'EPIPE' })))
      }
      return end(input, ...rest)
    }
  }
  return child
}
tracked[promisify.custom] = (...args) => new Promise((resolve, reject) => tracked(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })))
cp.execFile = tracked
syncBuiltinESMExports()
const { scanSource } = await import('../../build/core/source.js')
const scan = await scanSource(request.worktree, request.config, request.skillsRoot)
process.stdout.write(JSON.stringify({ scan, commands, mutations, pipeFailure, openedTreeFiles, queriedLinkedDescendant }) + '\n')
