import ts from 'typescript'

const normalize = path => path.replaceAll('\\', '/').replace(/\/$/, '')
function ownedPath(path, cwd, roots) {
  const candidate = normalize(path)
  const full = /^[a-z]:\//i.test(candidate) || candidate.startsWith('/') ? candidate : `${normalize(cwd)}/${candidate.replace(/^\.\//, '')}`
  const root = roots.map(normalize).find(r => full.toLowerCase().startsWith(r.toLowerCase() + '/'))
  return root ? { path: full.slice(root.length + 1), root } : null
}

function extractNested(code) {
  const source = ts.createSourceFile('tool-call.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const calls = []
  const literal = node => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null
  function walk(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text
      if (['exec_command', 'apply_patch'].includes(name)) {
        const arg = node.arguments[0]
        if (arg && ts.isObjectLiteralExpression(arg)) {
          const value = {}
          for (const p of arg.properties) if (ts.isPropertyAssignment(p)) value[p.name.getText(source).replaceAll(/["']/g, '')] = literal(p.initializer)
          calls.push({ name, args: value })
        } else if (arg && literal(arg) !== null) calls.push({ name, args: { input: literal(arg) } })
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(source)
  return calls
}

/** Deliberately bounded: literal file reads/searches and apply_patch, never executes logged code. */
export function parseCodexRollout(text, { roots = [] } = {}) {
  const rows = text.split(/\r?\n/).flatMap((line, index) => { try { return [{ ...JSON.parse(line), _line: index + 1 }] } catch { return [] } })
  const meta = rows.find(r => r.type === 'session_meta')?.payload ?? {}
  const outputs = new Map(rows.filter(r => r.type === 'response_item' && /(?:function|custom_tool)_call_output/.test(r.payload?.type ?? '')).map(r => [r.payload.call_id, String(r.payload.output ?? '')]))
  const events = []
  let unsupportedCalls = 0
  for (const row of rows) {
    const p = row.payload
    if (row.type !== 'response_item' || !['function_call', 'custom_tool_call'].includes(p?.type)) continue
    let args
    try { args = JSON.parse(p.arguments || '{}') } catch { args = {} }
    const calls = p.name === 'exec' ? extractNested(p.input ?? p.arguments ?? '') : [{ name: p.name, args: { ...args, input: p.input ?? args.input } }]
    let supported = false
    for (const call of calls) {
      const cwd = call.args.workdir ?? meta.cwd ?? roots[0] ?? ''
      const add = (operation, path, tool, detail) => {
        const owned = ownedPath(path, cwd, roots)
        if (!owned || owned.path.includes('..')) return
        supported = true
        const output = outputs.get(p.call_id)
        const success = output && /(?:exit_code["']?\s*:\s*0|Process exited with code 0)/.test(output)
        events.push({ id: `${p.call_id}:${events.length}`, timestamp: row.timestamp, sessionId: meta.id ?? 'unknown',
          operation, ...owned, tool, detail, origin: 'codex-tool-log', callId: p.call_id,
          status: p.name !== 'exec' && success ? 'succeeded' : 'observed',
          resultScope: p.name === 'exec' ? '批量工具调用已记录，单条退出结果未推断' : '工具日志',
          sourceLine: row._line, versionStatus: 'unknown', versionNote: '原始工具调用未提供对应文件内容哈希，不使用当前版本冒充历史版本。' })
      }
      if (call.name === 'exec_command' && call.args.cmd) {
        for (const command of call.args.cmd.split(/[;\n]/)) {
          const read = command.match(/^\s*(?:Get-Content|cat|type)\s+(?:(?:-[\w]+)\s+)*(?:["']([^"']+)["']|([^\s|]+))/i)
          if (read) add('read', read[1] ?? read[2], 'exec_command', command.trim().slice(0, 160))
          const search = command.match(/^\s*rg\s+(.+)/)
          if (search) {
            const tokens = search[1].match(/"[^"]*"|'[^']*'|[^\s|]+/g) ?? []
            const paths = tokens.filter(t => !t.startsWith('-') && /^(?:src|tests|docs|tools|examples|server|README|AGENTS|CMakeLists|\.claude)[/\\.]/.test(t))
            for (const path of paths) add('search', path.replace(/^["']|["']$/g, ''), 'exec_command', command.trim().slice(0, 160))
          }
        }
      }
      if (call.name === 'apply_patch') {
        for (const match of (call.args.input ?? '').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) add('write', match[1].trim(), 'apply_patch', '直接修改模型或文件；由实际工具调用记录')
      }
    }
    if (!supported) unsupportedCalls++
  }
  return { events, coverage: { status: events.length ? 'partial' : 'unknown', supported: 'Codex rollout：字面量 Get-Content / rg / apply_patch',
    unsupportedCalls, note: '仅为可识别工具调用的操作证据；读取不代表理解，未记录不代表未读取，未执行的脚本不解析为操作。' } }
}
