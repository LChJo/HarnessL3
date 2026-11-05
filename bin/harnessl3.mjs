#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number)
if (major !== 24 || minor < 12) {
  process.stderr.write('HarnessL3 requires Node.js 24.12.0 or newer on the Node 24 LTS line.\n')
  process.exitCode = 1
} else {
  try { const { runCli } = await import('../build/cli/main.js'); await runCli(process.argv.slice(2)) }
  catch (error) { process.stderr.write(error?.code === 'ERR_MODULE_NOT_FOUND' ? 'HarnessL3 is not built. Run npm run build first.\n' : 'HarnessL3 could not load its CLI.\n'); process.exitCode = 1 }
}
