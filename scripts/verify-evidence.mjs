import { readFile } from 'node:fs/promises'
import { verifyEvidence } from '../server/evidence.mjs'
import { resolveSourceRoot } from '../server/config.mjs'
import { fileURLToPath } from 'node:url'
const manifest = JSON.parse(await readFile(new URL('../examples/mgrp/evidence.json', import.meta.url), 'utf8'))
const result = await verifyEvidence(await resolveSourceRoot(fileURLToPath(new URL('../', import.meta.url))), manifest)
console.log(JSON.stringify({ status: result.status, evidence: result.evidence.length, sourceFiles: new Set(result.evidence.map(e => e.path)).size, changedFiles: result.changedFiles, digest: result.digest }, null, 2))
if (result.status !== 'matched') process.exitCode = 1
