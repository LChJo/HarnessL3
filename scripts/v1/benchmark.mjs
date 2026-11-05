import { createHash, randomUUID } from 'node:crypto';
import { execFile as callbackExecFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, realpath, rm, statfs } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const execFile = promisify(callbackExecFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '../..');
const binary = path.join(projectRoot, 'bin/harnessl3.mjs');
const DEFAULT_SEED = 54261105;
const timestamp = '2026-11-05T12:00:00.000Z';
const hash = value => createHash('sha256').update(value).digest('hex');
const fixedUuid = (seed, kind, number) => {
  const raw = hash(`${seed}:${kind}:${number}`).slice(0, 32).split(''); raw[12] = '4'; raw[16] = '8';
  const value = raw.join(''); return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
};

/** All inputs are fabricated. The 40-object scale matches MGRP counts, not its business model. */
export function generateDataset({ objects, seed = DEFAULT_SEED }) {
  if (!Number.isSafeInteger(objects) || objects < 10 || objects > 100000 || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('objects must be an integer from 10 to 100000 and seed must be an unsigned 32-bit integer');
  const nodes = [], relationships = [], files = {};
  const sourceFiles = Math.ceil(objects / 16);
  const evidence = Array.from({ length: sourceFiles }, (_, number) => {
    const file = `src/module-${String(number).padStart(5, '0')}.ts`;
    const content = `// Synthetic benchmark source; no project business code.\nexport const fixture${number} = ${seed + number};\n`;
    files[file] = content;
    return { id: fixedUuid(seed, 'evidence', number), kind: 'source-code', claim: `Synthetic source fixture ${number}; semantic correctness is not measured.`, location: { path: file }, hash: hash(content), observedAt: timestamp, range: { startLine: 1, endLine: 2 } };
  });
  for (let i = 0; i < objects; i++) {
    const parentIndex = i === 0 ? null : Math.floor((i - 1) / 8);
    const parent = parentIndex === null ? null : nodes[parentIndex];
    const localName = i === 0 ? 'app' : `n${String(i).padStart(5, '0')}`;
    nodes.push({ id: fixedUuid(seed, 'object', i), index: i, localName, locator: parent ? `${parent.locator}.${localName}` : localName, parentId: parent?.id ?? null, parentIndex, depth: parent ? parent.depth + 1 : 0, evidenceId: evidence[Math.floor(i / 16)].id });
  }
  const seen = new Set();
  // LikeC4 does not permit relationships between a container and its descendant.
  const leafIndices = nodes.filter(node => node.index > Math.floor((objects - 2) / 8)).map(node => node.index);
  for (let i = 0; relationships.length < Math.floor(objects * 0.8); i++) {
    const source = leafIndices[(i * 17 + seed) % leafIndices.length];
    let targetSlot = (i * 31 + 7 + seed) % leafIndices.length;
    let target = leafIndices[targetSlot];
    if (target === source) { targetSlot = (targetSlot + 1) % leafIndices.length; target = leafIndices[targetSlot]; }
    const key = `${source}:${target}`;
    if (seen.has(key)) { for (let alternative = 1; alternative < leafIndices.length; alternative++) { const candidate = leafIndices[(targetSlot + alternative) % leafIndices.length]; if (candidate !== source && !seen.has(`${source}:${candidate}`)) { target = candidate; break; } } }
    const finalKey = `${source}:${target}`; if (seen.has(finalKey)) continue;
    seen.add(finalKey);
    relationships.push({ id: fixedUuid(seed, 'relation', relationships.length), sourceId: nodes[source].id, targetId: nodes[target].id, source: nodes[source].locator, target: nodes[target].locator });
  }
  const metadata = (id, brief, proof = 'none') => `metadata { harness_id "${id}"; brief "${brief}"; source "human"; status "unknown"; evidence "${proof}"; version "1" }`;
  const children = new Map();
  for (const node of nodes) { const group = children.get(node.parentIndex) ?? []; group.push(node); children.set(node.parentIndex, group); }
  const lines = ['specification {', ' element system', ' element component', ' relationship calls', '}', 'model {'];
  const emit = node => {
    lines.push(`${node.localName} = ${node.index === 0 ? 'system' : 'component'} "Synthetic module ${node.index}" {`);
    lines.push(`description "Synthetic body for module ${node.index}; fixture seed ${seed}." ${metadata(node.id, `Synthetic summary ${node.index}`, node.evidenceId)}`);
    for (const child of children.get(node.index) ?? []) emit(child);
    lines.push('}');
  };
  emit(nodes[0]);
  for (const relation of relationships) lines.push(`${relation.source} -[calls]-> ${relation.target} "Synthetic relation" { ${metadata(relation.id, 'Synthetic relationship')} }`);
  lines.push('}', 'views {');
  const views = [];
  for (let i = 0; i < 5; i++) {
    const included = [...new Set(Array.from({ length: Math.min(12, objects) }, (_, j) => nodes[(i * 19 + j * 7) % objects].locator))];
    views.push({ id: `bench_${i}`, included });
    lines.push(`view bench_${i} {`, ...included.map(locator => `include ${locator}`), '}');
  }
  lines.push('}');
  files['.harness/model/main.c4'] = lines.join('\n') + '\n';
  files['.harness/project.json'] = JSON.stringify({ schemaVersion: 1, projectId: fixedUuid(seed, 'project', objects), name: `Synthetic ${objects}`, source: { excludePatterns: [] }, skills: { root: 'skills' } });
  files['.harness/evidence.json'] = JSON.stringify({ schemaVersion: 1, evidence });
  files['.harness/aliases.json'] = JSON.stringify({ schemaVersion: 1, aliases: {} });
  files['README.md'] = `Synthetic benchmark fixture: ${objects} objects, seed ${seed}.\n`;
  files['.gitignore'] = '';
  for (let i = 0; i < 20; i++) {
    const group = `group-${i % 7}`, name = `method-${String(i).padStart(2, '0')}`;
    files[`skills/${group}/${name}/SKILL.md`] = `---\nname: ${name}\ndescription: Synthetic editable method ${i}; do not execute its attachment.\n---\n# Synthetic method ${i}\nUse only explicit task data.\n`;
    files[`skills/${group}/${name}/reference.txt`] = `Synthetic attachment ${seed}:${i}\n`;
  }
  return { kind: objects === 40 ? 'synthetic-mgrp-scale' : 'synthetic-layered-scale', seed, nodes, relationships, evidence, views, files, meta: { objects, relationships: relationships.length, evidence: evidence.length, skills: 20, skillGroups: 7, skillFiles: 40, views: 5, viewExplicitInclusions: views.reduce((sum, view) => sum + view.included.length, 0), maxDepth: Math.max(...nodes.map(node => node.depth)), sourceFiles: sourceFiles + 2, historyIndexRows: objects === 40 ? 60 : Math.min(1000, objects), archiveCommits: objects === 40 ? 60 : 100, backlogEvents: Math.min(10000, objects * 2) } };
}

export async function writeDataset(root, dataset) {
  if (!path.isAbsolute(root)) throw new Error('Fixture root must be absolute');
  for (const [relative, content] of Object.entries(dataset.files)) {
    if (!relative || relative.startsWith('/') || /[\\:\0]/.test(relative) || relative.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('Unsafe generated relative path');
    const file = path.join(root, ...relative.split('/')); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content);
  }
}

export function summarizeSamples(samples) {
  const latencies = samples.filter(sample => sample.ok).map(sample => sample.ms).sort((a, b) => a - b);
  const percentile = q => latencies.length ? latencies[Math.max(0, Math.ceil(latencies.length * q) - 1)] : null;
  return { sampleCount: samples.length, successCount: latencies.length, failureRate: samples.length ? (samples.length - latencies.length) / samples.length : 0, p50Ms: percentile(0.5), p95Ms: percentile(0.95), peakRSSBytes: Math.max(0, ...samples.map(sample => sample.peakRSSBytes ?? 0)) };
}
async function diskBytes(root) {
  let total = 0;
  try { for (const entry of await readdir(root, { withFileTypes: true })) { if (entry.isSymbolicLink()) continue; const file = path.join(root, entry.name); if (entry.isDirectory()) total += await diskBytes(file); else if (entry.isFile()) total += (await lstat(file)).size; } } catch {}
  return total;
}
async function diskBreakdown(fixture) {
  return {
    primaryWorktreeBytes: await diskBytes(fixture.root),
    secondWorktreeBytes: await diskBytes(fixture.secondRoot),
    machineDataBytes: await diskBytes(fixture.dataRoot),
    microArtifactsBytes: await diskBytes(path.join(fixture.base, 'micro')),
    rssMetricsBytes: await diskBytes(fixture.metricsRoot),
    fixtureDefinitionBytes: (await lstat(path.join(fixture.base, 'fixture.json'))).size,
  };
}
const peakRSS = () => Math.max(process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024);
function queue() { let pending = Promise.resolve(); return operation => { const result = pending.then(operation); pending = result.catch(() => {}); return result; }; }
const safeError = error => error?.code ?? error?.errorCode ?? (error?.killed ? 'TIMEOUT' : 'BENCHMARK_FAILED');
async function sample(operation, iteration) {
  const started = performance.now();
  try { const details = await operation(); return { iteration, ok: true, ms: performance.now() - started, peakRSSBytes: peakRSS(), details }; }
  catch (error) { return { iteration, ok: false, ms: performance.now() - started, peakRSSBytes: peakRSS(), errorCode: safeError(error), errorName: error?.name ?? 'Error', diagnostics: error?.details?.diagnostics?.slice(0, 3).map(item => ({ code: item.code, message: item.message?.slice(0, 200) })) ?? [] }; }
}

async function probe(fixture, scenario, temperature, count) {
  const { dataset, worktree, secondWorktree, root, skillsRoot } = fixture;
  const scratch = path.join(fixture.base, 'micro', `${scenario}-${temperature}-${randomUUID()}`);
  await mkdir(scratch, { recursive: true });
  const cleanups = [];
  let execute, dimensions = {};
  const warm = temperature === 'warm';
  try {
    if (scenario === 'model-load') {
      const { loadModel } = await import('../../build/core/model.js');
      execute = async () => { const model = await loadModel(root); const result = { objects: model.entities.filter(item => item.entityType === 'object').length, relationships: model.entities.filter(item => item.entityType === 'relation').length, evidence: model.evidence.length, views: model.views.length, layoutNodes: model.views.reduce((sum, view) => sum + view.nodes.length, 0), layoutEdges: model.views.reduce((sum, view) => sum + view.edges.length, 0) }; if (result.objects !== dataset.meta.objects || result.relationships !== dataset.meta.relationships || result.evidence !== dataset.meta.evidence || result.views !== dataset.meta.views) throw Object.assign(new Error('Loaded model counts differ from generated fixture'), { code: 'MODEL_COUNT_MISMATCH' }); return result; };
    } else if (scenario === 'source-reconciliation') {
      const { scanSource } = await import('../../build/core/source.js');
      const configuration = JSON.parse(await readFile(path.join(root, '.harness/project.json'), 'utf8'));
      execute = async () => { const result = await scanSource(worktree, configuration, skillsRoot); if (result.sourceVersion.status === 'unknown') throw Object.assign(new Error('Unknown source'), { code: 'SOURCE_UNKNOWN' }); return { entries: result.manifest.content.entries.length, sourceStatus: result.sourceVersion.status }; };
    } else if (scenario === 'skill-scan') {
      const { scanSkills } = await import('../../build/core/skills.js');
      execute = async () => { const result = await scanSkills(skillsRoot); if (!result.valid) throw Object.assign(new Error('Invalid synthetic skills'), { code: 'CATALOG_INVALID' }); return { skills: result.skills.length, files: result.skills.reduce((sum, skill) => sum + skill.files.length, 0) }; };
    } else if (scenario === 'mixed-read') {
      const { loadModel, modelBody, modelDirectory } = await import('../../build/core/model.js');
      const model = await loadModel(root);
      const targets = [...new Set([0, 1, 8, 9, Math.floor(dataset.meta.objects / 2), dataset.meta.objects - 1])].map(index => dataset.nodes[index].id);
      execute = async () => { const directories = [modelDirectory(model, null), modelDirectory(model, dataset.nodes[0].id)]; const contexts = targets.map(id => modelBody(model, id, { head: null, treeHash: 'a'.repeat(64), status: 'clean' })); return { directories: directories.length, returnedBodies: contexts.length, returnedBriefs: directories.reduce((sum, directory) => sum + directory.items.length, 0) }; };
      dimensions = { excludes: 'Model parsing, source fingerprinting, journal and CLI transport; measured separately.' };
    } else if (scenario.startsWith('sqlite-')) {
      const { SearchIndex } = await import('../../build/core/index.js');
      const docs = [
        ...dataset.nodes.map(node => ({ id: node.id, kind: 'entity', title: `Module ${node.index}`, text: `${node.locator} synthetic`, data: { id: node.id } })),
        ...dataset.relationships.map(relation => ({ id: relation.id, kind: 'entity', title: 'Relation', text: `${relation.source} ${relation.target}`, data: { id: relation.id } })),
        ...Array.from({ length: dataset.meta.historyIndexRows }, (_, i) => ({ id: fixedUuid(dataset.seed, 'history', i), kind: 'task', title: `Synthetic history ${i}`, text: 'fixture session synthetic-model', activityAt: timestamp, expiresAt: '2027-01-04T12:00:00.000Z', data: { id: i, format: 'benchmark-index-row' } })),
      ];
      dimensions = { documents: docs.length, historyRows: dataset.meta.historyIndexRows, historyRowsAreFullTaskArchives: false };
      let index = new SearchIndex(path.join(scratch, 'index.sqlite')), seq = 1;
      cleanups.push(async () => index.close());
      if (scenario === 'sqlite-project') { dimensions.preparation = 'Existing index and worker are initialized outside timing; each operation changes text/data in 10 documents. Cold means a fresh probe process, not an uninitialized index.'; await index.rebuild(docs, seq); execute = async () => { seq++; await index.project(seq, docs.slice(0, 10).map(document => ({ ...document, text: `${document.text} update-${seq}`, data: { ...document.data, benchmarkRevision: seq } }))); return { updatedDocuments: 10, totalDocuments: docs.length, seq }; }; }
      else if (scenario === 'sqlite-corrupt-rebuild') {
        await index.rebuild(docs, seq); await index.close();
        execute = async () => { await index.close(); await writeFile(path.join(scratch, 'index.sqlite'), 'synthetic corrupted derived index'); index = new SearchIndex(path.join(scratch, 'index.sqlite')); await index.ready(); const quarantined = Boolean(index.status.quarantinedPath); await index.rebuild(docs, ++seq); const found = await index.search({ now: timestamp, limit: 1, offset: 0 }); if (found.total !== dataset.meta.historyIndexRows) throw new Error('Rebuild lost index rows'); return { quarantined, restoredHistoryRows: found.total, seq }; };
      } else { execute = async () => { await index.rebuild(docs, ++seq); return { documents: docs.length, seq }; }; }
    } else if (scenario === 'archive-recovery') {
      const { Archive } = await import('../../build/core/archive.js');
      const archiveRoot = path.join(scratch, 'archive'), writer = new Archive(archiveRoot);
      let last;
      for (let i = 0; i < dataset.meta.archiveCommits; i++) {
        const taskId = fixedUuid(dataset.seed, 'archive-task', i);
        last = { scope: `task:${taskId}`, requestId: fixedUuid(dataset.seed, 'archive-request', i), request: { operation: 'benchmark-record', index: i } };
        await writer.commit({ ...last, payload: { kind: 'benchmark-task', taskId, ordinal: i }, receipt: { taskId, ordinal: i }, materializations: [{ path: `tasks/${taskId}.json`, content: { schemaVersion: 1, taskId, createdAt: timestamp } }] });
      }
      let archive = new Archive(archiveRoot);
      execute = async () => { await archive.ready(); const result = await archive.replay(last.scope, last.requestId, last.request); if (!result || archive.records().length !== dataset.meta.archiveCommits) throw new Error('Lost archive commits'); return { commits: archive.records().length, replayed: result.replayed, projectionFiles: dataset.meta.archiveCommits }; };
      dimensions = { committedSmallArchiveRecords: dataset.meta.archiveCommits, recordsAreFullTaskServiceTasks: false, preparation: 'Synthetic records are written before timing. Cold uses a new Archive instance in a fresh probe process; OS file caches are not cleared. Warm uses the recovered instance.', recoveryScope: 'Hash-chain/reference validation and materialization reconciliation; replay last archived receipt.' };
    } else if (scenario === 'log-backlog') {
      const { Archive } = await import('../../build/core/archive.js');
      const { ObservationManager } = await import('../../build/core/observation.js');
      let run = 0;
      execute = async () => {
        const log = path.join(scratch, `synthetic-log-${run}.jsonl`), rows = [JSON.stringify({ type: 'session_meta', payload: { id: `benchmark-session-${run}`, cwd: root, cli_version: '0.162.1' } })];
        for (let i = 0; i < dataset.meta.backlogEvents; i++) { const callId = `literal-${i}`; rows.push(JSON.stringify({ type: 'response_item', timestamp, payload: { type: 'function_call', call_id: callId, name: 'exec_command', arguments: JSON.stringify({ cmd: 'cat README.md', workdir: root }) } }), JSON.stringify({ type: 'response_item', timestamp, payload: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ exit_code: 0, output: 'SYNTHETIC BODY NOT RETAINED' }) } })); }
        await writeFile(log, rows.join('\n') + '\n');
        const archive = new Archive(path.join(scratch, `observation-${run}`));
        const manager = new ObservationManager({ worktree, archive, serial: queue(), pollIntervalMs: 0 });
        const started = performance.now();
        try { await manager.bind({ agent: 'codex', sessionId: `benchmark-session-${run}`, logFile: log, requestId: randomUUID() }); const result = await manager.status(); if (result.events.length !== dataset.meta.backlogEvents) throw new Error('Backlog event count differs'); return { observedEvents: result.events.length, originalLogRows: rows.length, bindingAndCommitMs: performance.now() - started, inputLogBytes: Buffer.byteLength(rows.join('\n')) + 1, fixture: 'synthetic-only' }; }
        finally { await manager.close(); run++; }
      };
      dimensions = { includes: 'Synthetic log construction/write, parsing/path validation, sanitized event snapshot, fsync commit and checkpoint materialization.', preparation: 'A fresh binding, manager and archive are used for every operation. Warm reuses the Node process and imported modules.', backlogEvents: dataset.meta.backlogEvents };
    } else if (scenario === 'sync-status-and-proof') {
      const { Archive } = await import('../../build/core/archive.js');
      const { FreshnessManager } = await import('../../build/core/freshness.js');
      const manager = new FreshnessManager({ worktree, archive: new Archive(path.join(scratch, 'sync-archive')), serial: queue(), pollIntervalMs: 3600000 });
      cleanups.push(() => manager.close());
      execute = async () => {
        const state = await manager.status(skillsRoot);
        const proof = { schemaVersion: 1, requestId: randomUUID(), target: { projectId: worktree.projectId, worktreeId: worktree.id }, phaseId: randomUUID(), sourceEpoch: state.sourceEpoch, expectedSourceVersion: state.sourceVersion, expectedModelRevision: state.modelRevision, scope: { paths: state.pendingPaths.length ? state.pendingPaths : ['README.md'], entities: [] }, disposition: 'no-semantic-change', reason: 'Synthetic fixture only; this benchmark measures mechanical validation, not semantic correctness.', checks: [{ name: 'Synthetic benchmark review', status: 'passed', evidence: ['README.md'] }] };
        const verified = await manager.verify(proof, skillsRoot);
        if (verified.state !== 'verified') throw Object.assign(new Error('Unexpected sync state'), { code: 'SYNC_NOT_VERIFIED' });
        return { sourceEpoch: verified.sourceEpoch, proofPaths: proof.scope.paths.length, state: verified.state };
      };
    } else if (scenario === 'dual-worktree-concurrent') {
      const { loadModel, modelBody } = await import('../../build/core/model.js');
      const { scanSource } = await import('../../build/core/source.js');
      const config = JSON.parse(await readFile(path.join(root, '.harness/project.json'), 'utf8'));
      execute = async () => {
        const results = await Promise.all([worktree, secondWorktree].map(async target => { const [model, source] = await Promise.all([loadModel(target.root), scanSource(target, config, path.join(target.root, 'skills'))]); if (source.sourceVersion.status === 'unknown') throw new Error('Unknown source'); return { worktreeId: target.id, objects: model.entities.filter(entity => entity.entityType === 'object').length, returnedBodyId: modelBody(model, dataset.nodes.at(-1).id, source.sourceVersion).entity.id }; }));
        if (results[0].worktreeId === results[1].worktreeId) throw new Error('Worktree isolation missing');
        return { targets: 2, independentBindings: true, objectsPerTarget: results.map(result => result.objects) };
      };
      dimensions = { scope: 'Concurrent actual LikeC4 parse/layout + source scans + exact body projection in two externally created Git worktrees; not two simultaneous CLI daemon cold starts.' };
    } else throw new Error(`Unknown probe ${scenario}`);
    let warmupMs = null, warmupError = null;
    if (warm) { const started = performance.now(); try { await execute(); } catch (error) { warmupError = safeError(error); } warmupMs = performance.now() - started; }
    const samples = [];
    for (let i = 0; i < count; i++) samples.push(await sample(execute, i));
    const footprint = await diskBytes(scratch);
    return { scenario, temperature, kind: 'core-microbenchmark', dimensions, warmupMs, warmupError, samples, diskBytesAtEnd: footprint, ...summarizeSamples(samples) };
  } finally { for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {}); }
}

const metricSource = `import fs from 'node:fs';import path from 'node:path';import{isMainThread}from'node:worker_threads';const dir=process.env.HARNESS_BENCH_METRICS_DIR;function save(){if(!dir||!isMainThread)return;try{fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,process.pid+'.json'),JSON.stringify({pid:process.pid,rssBytes:process.memoryUsage().rss,peakRSSBytes:Math.max(process.memoryUsage().rss,process.resourceUsage().maxRSS*1024)}))}catch{}}if(isMainThread){const t=setInterval(save,250);t.unref();process.on('exit',save);}`;
const metricImport = `--import=data:text/javascript;base64,${Buffer.from(metricSource).toString('base64')}`;
async function cli(fixture, args, { cwd = fixture.root, input, timeout = 300000 } = {}) {
  let pid;
  const response = await new Promise(resolve => {
    const child = callbackExecFile(process.execPath, [binary, ...args, '--data-dir', fixture.dataRoot, '--json'], { cwd, windowsHide: true, env: { ...process.env, HARNESS_SKILLS_ROOT: '', HARNESSL3_HOME: '', HARNESS_BENCH_METRICS_DIR: fixture.metricsRoot, NODE_OPTIONS: metricImport }, maxBuffer: 64 * 1024 * 1024, timeout }, (error, stdout) => { let body; try { body = JSON.parse(stdout); } catch {} resolve({ code: error ? typeof error.code === 'number' ? error.code : 1 : 0, body, errorCode: error?.killed ? 'TIMEOUT' : body?.ok === false ? body.error.code : error?.code, pid }); });
    pid = child.pid; child.stdin.end(input ?? '');
  });
  let peak = 0;
  try { peak = JSON.parse(await readFile(path.join(fixture.metricsRoot, `${pid}.json`), 'utf8')).peakRSSBytes; } catch {}
  response.peakRSSBytes = peak;
  if (response.code !== 0 || response.body?.ok !== true) throw Object.assign(new Error('CLI benchmark request failed'), { code: response.errorCode ?? 'CLI_RESPONSE_INVALID', peakRSSBytes: peak });
  return response;
}
async function servicePeak(fixture) {
  try { const descriptor = JSON.parse(await readFile(path.join(fixture.dataRoot, 'service.json'), 'utf8')); const metric = JSON.parse(await readFile(path.join(fixture.metricsRoot, `${descriptor.pid}.json`), 'utf8')); return metric.peakRSSBytes; } catch { return 0; }
}
async function cliScenarios(fixture, count, onGroup = async () => {}) {
  const result = [];
  const measure = async (name, temperature, operation, before) => {
    const samples = [], codeFingerprintStart = await codeFingerprint();
    for (let i = 0; i < count; i++) {
      try { await before?.(i); }
      catch (error) { samples.push({ iteration: i, ok: false, ms: 0, peakRSSBytes: error.peakRSSBytes ?? 0, errorCode: safeError(error), attemptScope: 'Cold precondition failed; request timing did not begin.' }); continue; }
      const started = performance.now();
      try { const details = await operation(i); const ms = performance.now() - started; await new Promise(resolve => setTimeout(resolve, 260)); samples.push({ iteration: i, ok: true, ms, peakRSSBytes: Math.max(details.peakRSSBytes ?? 0, await servicePeak(fixture)), details: details.details ?? {} }); }
      catch (error) { samples.push({ iteration: i, ok: false, ms: performance.now() - started, peakRSSBytes: error.peakRSSBytes ?? 0, errorCode: safeError(error) }); }
    }
    const group = { scenario: name, temperature, kind: 'cli-end-to-end', codeFingerprintStart, codeFingerprintEnd: await codeFingerprint(), samples, diskAtEnd: await diskBreakdown(fixture), ...summarizeSamples(samples) };
    result.push(group); await onGroup(group);
  };
  const stop = () => cli(fixture, ['serve', 'stop'], { cwd: fixture.base });
  await measure('cli-service-startup', 'cold', async () => { const response = await cli(fixture, ['serve', 'start']); return { peakRSSBytes: response.peakRSSBytes, details: { state: response.body.data.result.state } }; }, stop);
  await measure('cli-service-startup', 'warm', async () => { const response = await cli(fixture, ['serve', 'start']); return { peakRSSBytes: response.peakRSSBytes, details: { state: response.body.data.result.state } }; });
  const locate = async () => { const response = await cli(fixture, ['worktree', 'show', fixture.worktree.id]); if (response.body.target.worktreeId !== fixture.worktree.id) throw Object.assign(new Error('CLI returned a different target'), { code: 'WRONG_TARGET' }); return { peakRSSBytes: response.peakRSSBytes, details: { correctTarget: true } }; };
  await measure('cli-target-location', 'cold', locate, stop);
  await measure('cli-target-location', 'warm', locate);
  const mixed = async () => {
    const entry = await cli(fixture, ['task', 'start', '--title', 'Synthetic mixed read benchmark']);
    const taskId = entry.body.data.taskId;
    const ids = [...new Set([0, 1, 9, fixture.dataset.meta.objects - 1])].map(i => fixture.dataset.nodes[i].id);
    const request = { schemaVersion: 1, requestId: randomUUID(), expectedModelRevision: entry.body.data.binding.modelRevision, expand: [fixture.dataset.nodes[0].id], read: ids, known: {} };
    const query = await cli(fixture, ['context', 'query', taskId, '--file', '-'], { input: JSON.stringify(request) });
    if (query.body.data.result.contexts.length !== ids.length || query.body.data.result.directories.length !== 1) throw Object.assign(new Error('CLI returned incomplete mixed reads'), { code: 'INCOMPLETE_READ' });
    return { peakRSSBytes: Math.max(entry.peakRSSBytes, query.peakRSSBytes), details: { commands: ['task start', 'context query'], returnedBodies: query.body.data.result.contexts.length, returnedDirectories: query.body.data.result.directories.length, taskArchiveCreated: true } };
  };
  await measure('cli-task-start-and-mixed-read', 'cold', mixed, stop);
  await measure('cli-task-start-and-mixed-read', 'warm', mixed);
  await stop();
  return result;
}

async function runProbeChild(fixtureFile, scenario, temperature, samples, timeout) {
  const started = performance.now();
  try {
    const result = await execFile(process.execPath, [fileURLToPath(import.meta.url), '--probe', scenario, '--fixture', fixtureFile, '--temperature', temperature, '--samples', String(samples)], { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout });
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    try { const recorded = JSON.parse(error.stdout?.trim()); if (Array.isArray(recorded.samples)) return recorded; } catch {}
    return { scenario, temperature, kind: 'core-microbenchmark', samples: [{ iteration: 0, ok: false, ms: performance.now() - started, peakRSSBytes: 0, errorCode: error.killed ? 'TIMEOUT' : 'PROBE_PROCESS_FAILED', attemptScope: 'Probe process failed before returning operation samples.' }], unexecutedRequestedSamples: samples - 1, unavailableMetrics: ['Child peak RSS when the child did not finish.'] };
  }
}
async function environment(base) {
  const installedVersion = async name => JSON.parse(await readFile(path.join(projectRoot, 'node_modules', name, 'package.json'), 'utf8')).version;
  let disk = { type: 'unknown', reason: 'No physical-media information available.' };
  if (process.platform === 'win32') {
    try { const result = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-PhysicalDisk | Select-Object MediaType,BusType,Size | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 10000 }); disk = { type: 'reported-by-Get-PhysicalDisk', devices: JSON.parse(result.stdout) }; } catch {}
  } else {
    try { const result = await execFile('lsblk', ['-d', '-J', '-o', 'NAME,ROTA,TYPE,SIZE'], { timeout: 5000 }); disk = { type: 'reported-by-lsblk', devices: JSON.parse(result.stdout) }; } catch {}
  }
  let filesystem = null;
  try { const fs = await statfs(base); filesystem = { type: fs.type, blockSize: fs.bsize, blocks: fs.blocks, availableBlocks: fs.bavail }; } catch {}
  return { node: process.version, likec4: await installedVersion('likec4'), typescript: await installedVersion('typescript'), platform: process.platform, architecture: process.arch, os: { type: os.type(), release: os.release(), version: os.version() }, cpu: { model: os.cpus()[0]?.model ?? null, logicalCount: os.cpus().length }, totalMemoryBytes: os.totalmem(), availableMemoryAtStartBytes: os.freemem(), disk, fixtureFilesystem: filesystem };
}
async function codeFingerprint() {
  const files = ['package.json', 'package-lock.json', 'bin/harnessl3.mjs', 'scripts/v1/benchmark.mjs'];
  const visit = async directory => { for (const entry of await readdir(path.join(projectRoot, directory), { withFileTypes: true })) { if (entry.isSymbolicLink()) continue; const file = `${directory}/${entry.name}`; if (entry.isDirectory()) await visit(file); else if (entry.isFile() && entry.name.endsWith('.js')) files.push(file); } };
  for (const directory of ['build/core', 'build/cli', 'build/service']) await visit(directory); files.sort();
  return Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(path.join(projectRoot, file)))])));
}
async function createFixture(base, objects, seed) {
  const dataset = generateDataset({ objects, seed });
  const fixtureBase = path.join(base, `scale-${objects}`), root = path.join(fixtureBase, 'primary worktree'), secondRoot = path.join(fixtureBase, 'second worktree'), dataRoot = path.join(fixtureBase, 'machine-data');
  await mkdir(root, { recursive: true }); await writeDataset(root, dataset);
  const git = (...args) => execFile('git', ['-C', root, ...args], { windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(fixtureBase, 'empty-git-config') }, maxBuffer: 8 * 1024 * 1024 });
  await writeFile(path.join(fixtureBase, 'empty-git-config'), '');
  await git('init', '-b', 'benchmark-main'); await git('config', 'user.name', 'HarnessL3 synthetic benchmark'); await git('config', 'user.email', 'fixture@example.invalid'); await git('config', 'core.autocrlf', 'false'); await git('config', 'core.excludesfile', path.join(fixtureBase, 'empty-git-config'));
  await git('add', '.'); await git('commit', '-m', 'Synthetic benchmark fixture');
  // Fixture setup uses native Git; the product only registers these pre-existing worktrees.
  await git('worktree', 'add', '-b', 'benchmark-parallel', secondRoot);
  const { WorkspaceRegistry } = await import('../../build/core/workspace.js');
  const registry = new WorkspaceRegistry(dataRoot);
  const first = await registry.register(root), second = await registry.register(secondRoot);
  const fixture = { base: fixtureBase, root, secondRoot, dataRoot, metricsRoot: path.join(fixtureBase, 'rss-metrics'), skillsRoot: path.join(root, 'skills'), worktree: first.worktree, secondWorktree: second.worktree, dataset };
  await mkdir(fixture.metricsRoot); const file = path.join(fixtureBase, 'fixture.json'); await writeFile(file, JSON.stringify(fixture));
  return { fixture, file };
}

const MICRO = ['model-load', 'mixed-read', 'source-reconciliation', 'skill-scan', 'sqlite-rebuild', 'sqlite-project', 'sqlite-corrupt-rebuild', 'archive-recovery', 'log-backlog', 'sync-status-and-proof', 'dual-worktree-concurrent'];
function argumentsMap(args) { const result = {}; for (let i = 0; i < args.length; i += 2) { if (!args[i]?.startsWith('--') || args[i + 1] === undefined) throw new Error('Arguments use --name value'); result[args[i].slice(2)] = args[i + 1]; } return result; }
export async function runSuite(options = {}) {
  const scales = options.scales ?? [40, 100, 1000, 10000], samples = options.samples ?? 3, seed = options.seed ?? DEFAULT_SEED, timeout = options.timeout ?? 300000;
  if (!Number.isSafeInteger(samples) || samples < 3 || samples > 10) throw new Error('At least 3 and at most 10 samples are required');
  const base = await mkdtemp(path.join(os.tmpdir(), 'harnessl3-performance-'));
  const output = path.resolve(options.output ?? path.join(projectRoot, '.harness-local', 'implementation-20261105', `performance-${process.platform}-${Date.now()}.json`));
  const active = [];
  try {
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), finishedAt: null, synthetic: true, seed, samplesPerTemperature: samples, environment: await environment(base), codeFingerprintStart: await codeFingerprint(), codeFingerprintEnd: null, methodology: { cold: 'New Node process for each core sample; stopped daemon before each CLI cold sample. OS/disk caches are not forcibly cleared.', warm: 'One unmeasured warmup then same-process core calls, or already-running daemon with newly launched CLI clients.', percentiles: 'Nearest rank among successful raw samples; all failures and their latency are retained separately.', memory: 'Process-lifetime peak RSS via resourceUsage.maxRSS and RSS; CLI/daemon use a 250 ms preload sampler plus exit measurement. This includes setup/imports and prior warm samples.', disk: 'Observed regular-file bytes; source Git fixture and derived artifacts are separated. Atomic transient disk peaks are not sampled.', scope: 'Core microbenchmarks exclude process/import setup and do not replace CLI end-to-end scenarios. View inclusions are bounded; a 10000-object model is not a 10000-node layout benchmark.', machineLoad: 'Runs on a shared development machine. Other project work or background OS processes can affect measurements; this is a reproducible local baseline, not an isolated hardware result.', fixtureSafety: 'All Git repositories, worktrees, logs, archives and corrupt SQLite files are synthetic and below one owned OS temporary directory.', sla: null }, datasets: [], missing: ['Browser commit-to-render latency is not measured by this script; it requires a separate Playwright report.', 'No forced OS page-cache flush or physical disk type-to-volume mapping.', 'This run alone does not verify other operating systems.'] };
  report.methodology.probeProcessTimeoutMs = timeout;
  report.methodology.cliCommandTimeoutMs = 300000;
  report.runLabel = options.label ?? 'local-benchmark';
  report.methodology.concurrentWork = options.loadNote ?? null;
  report.selectedScenarios = options.only ?? ['cli', ...MICRO];
  const checkpoint = async () => { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); };
    for (const objects of scales) {
      const { fixture, file } = await createFixture(base, objects, seed); active.push(fixture);
      const datasetReport = { kind: fixture.dataset.kind, seed, size: fixture.dataset.meta, fixtureBytesBefore: await diskBytes(fixture.base), fixtureDiskBefore: await diskBreakdown(fixture), fixtureBytesAfter: null, fixtureDiskAfter: null, scenarios: [] }; report.datasets.push(datasetReport); await checkpoint();
      if (!options.only || options.only.includes('cli')) {
        process.stdout.write(JSON.stringify({ progress: true, objects, scenario: 'cli-end-to-end' }) + '\n');
        await cliScenarios(fixture, samples, async group => { datasetReport.scenarios.push(group); await checkpoint(); });
      }
      for (const scenario of MICRO.filter(name => !options.only || options.only.includes(name))) {
        for (const temperature of ['cold', 'warm']) {
          process.stdout.write(JSON.stringify({ progress: true, objects, scenario, temperature }) + '\n');
          const collected = [], runs = [], codeFingerprintStart = await codeFingerprint();
          while (collected.length < samples) { const result = await runProbeChild(file, scenario, temperature, temperature === 'cold' ? 1 : samples - collected.length, timeout); runs.push(result); for (const sample of result.samples ?? []) collected.push({ ...sample, iteration: collected.length }); }
          datasetReport.scenarios.push({ scenario, temperature, kind: 'core-microbenchmark', codeFingerprintStart, codeFingerprintEnd: await codeFingerprint(), dimensions: runs[0]?.dimensions ?? null, samples: collected, processRuns: runs.map(run => ({ warmupMs: run.warmupMs ?? null, warmupError: run.warmupError ?? null, diskBytesAtEnd: run.diskBytesAtEnd ?? null, unavailableMetrics: run.unavailableMetrics ?? [] })), ...summarizeSamples(collected) });
          await checkpoint();
        }
      }
      datasetReport.fixtureBytesAfter = await diskBytes(fixture.base); datasetReport.fixtureDiskAfter = await diskBreakdown(fixture); await checkpoint();
    }
    report.finishedAt = new Date().toISOString(); report.codeFingerprintEnd = await codeFingerprint(); await checkpoint();
    process.stdout.write(JSON.stringify({ output, datasets: report.datasets.length, failedSamples: report.datasets.flatMap(dataset => dataset.scenarios.flatMap(scenario => scenario.samples)).filter(sample => !sample.ok).length }) + '\n');
    return report;
  } finally {
    const failedStops = [];
    for (const fixture of active) { try { await cli(fixture, ['serve', 'stop'], { cwd: fixture.base, timeout: 60000 }); } catch (error) { failedStops.push({ dataRoot: fixture.dataRoot, code: safeError(error) }); } }
    if (failedStops.length) throw Object.assign(new Error('Owned fixture service could not be confirmed stopped; temporary files are retained for recovery'), { code: 'BENCHMARK_CLEANUP_FAILED', details: failedStops });
    const actual = await realpath(base);
    const relative = path.relative(await realpath(os.tmpdir()), actual);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(actual).startsWith('harnessl3-performance-')) throw new Error('Unsafe benchmark cleanup target');
    await rm(actual, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = argumentsMap(process.argv.slice(2));
  if (args.probe) {
    try { const fixture = JSON.parse(await readFile(args.fixture, 'utf8')); const result = await probe(fixture, args.probe, args.temperature ?? 'cold', Number(args.samples ?? 1)); process.stdout.write(JSON.stringify(result) + '\n'); }
    catch (error) { process.stdout.write(JSON.stringify({ scenario: args.probe, temperature: args.temperature, samples: [{ iteration: 0, ok: false, ms: 0, peakRSSBytes: peakRSS(), errorCode: safeError(error), errorName: error?.name ?? 'Error', attemptScope: 'Probe preparation failed; operation timing did not begin.', diagnostics: error?.details?.diagnostics?.slice(0, 5).map(item => ({ code: item.code, message: item.message?.slice(0, 300) })) ?? [] }] }) + '\n'); process.exitCode = 1; }
  } else await runSuite({ scales: args.scales?.split(',').map(Number), samples: Number(args.samples ?? 3), seed: Number(args.seed ?? DEFAULT_SEED), timeout: Number(args.timeout ?? 300000), output: args.output, only: args.only?.split(','), label: args.label, loadNote: args['load-note'] });
}
