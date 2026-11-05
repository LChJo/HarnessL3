import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

// Read only our Node JUnit output. Publish bounded diagnostics so a failed
// platform can be inspected without downloading authenticated Actions logs.
const reportPath = process.argv[2] ?? `.harness-local/validation/tests-${process.platform}.xml`
const xml = await readFile(reportPath, 'utf8')
const decode = value => value.replace(/&(?:quot|apos|lt|gt|amp|#\d+|#x[\da-f]+);/gi, entity => {
  const named = { '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' }
  if (named[entity]) return named[entity]
  const code = entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1))
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\uFFFD'
})
const attribute = (text, name) => decode(new RegExp(`\\b${name}="([^"]*)"`).exec(text)?.[1] ?? '')
const safe = value => value
  .replace(/Bearer\s+[^\s'"<>]+/gi, 'Bearer [redacted]')
  .replace(/((?:token|nonce|authorization|cookie)["'\s]*[:=]["'\s]*)[^\s'",;}<>]+/gi, '$1[redacted]')
  .replace(/([#?&](?:code|nonce|token)=)[^&\s'"<>]+/gi, '$1[redacted]')
  .replaceAll(process.cwd(), '[checkout]')
  .slice(0, 6000)
const totals = Object.fromEntries([...xml.matchAll(/<!-- (tests|pass|fail|cancelled|skipped|todo) (\d+) -->/g)].map(match => [match[1], Number(match[2])]))
const failures = []
for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
  const failure = /<failure\b([^>]*)>([\s\S]*?)<\/failure>/.exec(match[2] ?? '')
  if (!failure) continue
  const relative = path.relative(process.cwd(), attribute(match[1], 'file')).replaceAll('\\', '/')
  failures.push({
    name: safe(attribute(match[1], 'name')),
    file: relative.startsWith('tests/') ? relative : undefined,
    type: safe(attribute(failure[1], 'type')),
    message: safe(decode(failure[2].trim()) || attribute(failure[1], 'message')),
  })
}
const result = { platform: process.platform, node: process.version, totals, failures }
const outputRoot = '.harness-local/validation'
await mkdir(outputRoot, { recursive: true })
await writeFile(path.join(outputRoot, `ci-tests-${process.platform}.json`), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result))
if (process.env.GITHUB_ACTIONS === 'true') {
  const escape = value => value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
  console.log(`::notice title=Node tests ${process.platform}::${escape(JSON.stringify(totals))}`)
  for (const failure of failures.slice(0, 40)) {
    const file = failure.file ? `,file=${failure.file},line=1` : ''
    console.log(`::error title=Node test failure${file}::${escape(failure.name + '\n' + failure.message)}`)
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Node tests (${process.platform})\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`)
  }
}
