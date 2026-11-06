import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { LikeC4 } from 'likec4'
import { sha256 } from '../server/evidence.mjs'
import { resolveSourceRoot } from '../server/config.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'examples/mgrp/evidence.json'), 'utf8'))
const sourceRoot = await resolveSourceRoot(root)
const modelDir = join(root, 'examples/mgrp/model')
const stateDir = join(root, '.harness-local', sha256(`${modelDir}|${sourceRoot}`).slice(0, 16))
await mkdir(stateDir, { recursive: true })
const sessionId = `script-demo-${Date.now()}`
async function record(operation, path, detail) {
  const workspace = path.startsWith('src/') ? sourceRoot : root
  const contentHash = sha256(await readFile(join(workspace, path)))
  const event = { id: `${sessionId}:${operation}:${path}`, timestamp: new Date().toISOString(), sessionId, operation, path,
    root: workspace.replaceAll('\\', '/'), contentHash, versionStatus: 'content-hash', origin: 'scripted-example', tool: 'node:fs', status: 'succeeded', detail }
  await appendFile(join(stateDir, 'agent-example.jsonl'), JSON.stringify(event) + '\n')
  console.log(`${operation.padEnd(8)} ${path} — ${detail}`)
}
const relative = 'examples/mgrp/model/03-views.c4'
const target = join(root, relative)
const before = await readFile(target, 'utf8')
await record('read', relative, '实际读取 LikeC4 视图原文；这是可复现脚本演示，不是 LLM 工具日志。')
await readFile(join(sourceRoot, 'src/mgrp/business/download_manager.h'))
await record('read', 'src/mgrp/business/download_manager.h', '实际读取职责声明；文件读取不等于语义理解。')
const after = before.replace(/\n\/\/ harnessl3-agent-example:.*\n?$/, '\n').trimEnd() + `\n\n// harnessl3-agent-example: ${new Date().toISOString()} · 只演示文本写入，无架构语义变化。\n`
await writeFile(target, after)
await record('write', relative, '实际写入一条演示注释；视图仍引用同一主模型，不制造对象或关系变化。')
const parser = await LikeC4.fromWorkspace(modelDir, { logger: false })
try {
  if (parser.hasErrors()) throw new Error(JSON.stringify(parser.getErrors()))
  await record('validate', relative, '真实 LikeC4 解析校验通过；本次只改注释，未宣称源码语义同步。')
} finally { await parser.dispose() }
