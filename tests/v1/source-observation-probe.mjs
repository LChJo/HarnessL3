import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
const request = JSON.parse(await fs.readFile(process.argv[2], 'utf8'))
const original = fs.open, opened = []
fs.open = async (...args) => { opened.push(String(args[0])); return original(...args) }
syncBuiltinESMExports()
const { observeSourcePaths } = await import('../../build/core/source.js')
const result = await observeSourcePaths(request.worktree, request.paths, 7)
process.stdout.write(JSON.stringify({ result, opened }) + '\n')
