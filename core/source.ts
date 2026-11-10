import { execFile as callbackExecFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readdir, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import ignore from 'ignore';
import { canonicalJson, digest, parseJsonStrict, sha256, validUnicode } from './json.js';
import { canonicalPath, isWithin, samePath, safeRelative } from './paths.js';
import { isErrno } from './io.js';
import { HarnessError } from './errors.js';
import type { Diagnostic, ProjectConfig, SourceVersion, WorktreeRecord } from './types.js';

const execFile = promisify(callbackExecFile);
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const absent = (error: unknown): boolean => isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR');

export interface SourceEntry { path: string; entryKind: 'file' | 'symlink' | 'deleted'; contentHash: string | null }
export interface SourceManifest { schemaVersion: 1; kind: 'source-manifest'; content: { entries: SourceEntry[] } }
export interface IgnoreSource { origin: 'global' | 'info' | 'worktree'; path: string | null; hash: string | null }
export interface IgnoreRules { schemaVersion: 1; kind: 'git-ignore-rules'; content: { ignoreCase: boolean; sources: IgnoreSource[] } }
export interface IgnoreRuleFile { origin: IgnoreSource['origin']; path: string | null; bytesBase64: string }
export interface SourcePolicy {
  schemaVersion: 1;
  kind: 'source-scan-policy';
  content: {
    scannerVersion: 'source-scanner/1' | 'directory-scanner/1'; candidateSet: 'head-index-and-untracked' | 'filesystem'; pathOrder: 'utf16-code-unit';
    ruleDialect: 'posix-glob-v1'; caseSensitive: true; includePatterns: ['**']; fixedExcludePrefixes: ['.git', '.harness'];
    projectExcludePatterns: string[]; gitIgnoreMode: 'untracked-only' | 'directory-files'; gitIgnoreRevision: string;
    skillRootExcludePrefixes: string[]; linkHandling: 'record-readlink-utf8-no-follow'; unsupportedEntryHandling: 'unknown';
  };
}
export interface SourceScan {
  sourceVersion: SourceVersion;
  sourceScanRevision: string | null;
  manifest: SourceManifest | null;
  policy: SourcePolicy | null;
  diagnostics: Diagnostic[];
  ignoreRules: IgnoreRules | null;
  ignoreRuleFiles: IgnoreRuleFile[];
  /** Derived native-ignore directory coverage for watchers; never a fingerprint input. */
  ignoredDirectoryPrefixes?: string[];
}

export interface SourceObservation {
  checkedAt: string; sourceEpoch: number; paths: string[]; entries: SourceEntry[];
  requiresFullScan: boolean; diagnostics: Diagnostic[];
}

/** Targeted observation only: never a complete source version or a task binding. */
export async function observeSourcePaths(worktree: WorktreeRecord, paths: string[], sourceEpoch: number): Promise<SourceObservation> {
  const result: SourceObservation = { checkedAt: new Date().toISOString(), sourceEpoch, paths: [...new Set(paths)].sort(compare), entries: [], requiresFullScan: false, diagnostics: [] };
  for (const relative of result.paths) {
    try {
      validatePath(relative);
      const root = await canonicalPath(worktree.root);
      if (!samePath(root, worktree.root) || (await lstat(worktree.root)).isSymbolicLink()) throw new ScanFailure('SOURCE_TARGET_CHANGED', 'The observed worktree root changed identity.', relative);
      const candidate: Candidate = { path: relative, tracked: true, modes: new Set(), stages: new Set([0]), directory: false };
      const first = await sourceEntry(worktree.root, candidate);
      const second = await sourceEntry(worktree.root, candidate);
      if (canonicalJson(first) !== canonicalJson(second)) throw new ScanFailure('SOURCE_SCAN_RACE', 'Observed source bytes changed during capture.', relative, true);
      result.entries.push(first);
    } catch (error) {
      result.requiresFullScan = true;
      result.diagnostics.push(error instanceof ScanFailure ? error.diagnostic() : { code: 'SOURCE_OBSERVATION_UNAVAILABLE', severity: 'error', file: relative, message: 'The changed path requires complete source reconciliation.' });
    }
  }
  return result;
}

class ScanFailure extends Error {
  constructor(readonly code: string, message: string, readonly file?: string, readonly race = false) { super(message); }
  diagnostic(): Diagnostic { return { code: this.code, message: this.message, severity: 'error', ...(this.file === undefined ? {} : { file: this.file }) }; }
}

function decode(bytes: Buffer, code = 'SOURCE_PATH_ENCODING'): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new ScanFailure(code, 'Git paths or configuration cannot be represented as valid UTF-8.'); }
}

function records(bytes: Buffer): string[] {
  if (!bytes.length) return [];
  if (bytes.at(-1) !== 0) throw new ScanFailure('SOURCE_GIT_OUTPUT', 'Git returned a non-terminated machine record.');
  return decode(bytes.subarray(0, -1)).split('\0');
}

function validatePath(relative: string): string {
  try { return safeRelative(relative); } catch { throw new ScanFailure('SOURCE_PATH_INVALID', 'A source candidate has an unsupported relative path.'); }
}

function exclusion(pattern: string): RegExp {
  try { safeRelative(pattern); } catch { throw new ScanFailure('SOURCE_PATTERN_INVALID', 'Source exclusions must use safe root-relative posix-glob-v1 patterns.'); }
  if (/[!\[\]{}]/.test(pattern)) throw new ScanFailure('SOURCE_PATTERN_INVALID', 'Source exclusions do not support negation, character classes or brace expansion.');
  let body = '';
  for (let i = 0; i < pattern.length; i++) {
    const character = pattern[i]!;
    if (character === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') { i++; body += '(?:[^/]+/)*'; }
        else body += '[\\s\\S]*';
      } else body += '[^/]*';
    } else if (character === '?') body += '[^/]';
    else body += character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  return new RegExp(`^(?:${body})$`, 'u');
}

type ExclusionInput = Pick<ProjectConfig, 'source'> | SourcePolicy | SourcePolicy['content'];
function settings(input: ExclusionInput, skills: string[] = []): { patterns: string[]; prefixes: string[] } {
  if ('source' in input) return { patterns: input.source.excludePatterns, prefixes: ['.git', '.harness', ...skills] };
  const content = 'content' in input ? input.content : input;
  return { patterns: content.projectExcludePatterns, prefixes: [...content.fixedExcludePrefixes, ...content.skillRootExcludePrefixes] };
}

/** Pure filtering for reconciliation/watchers; it does not establish a read. */
export function isSourcePathIncluded(relative: string, input: ExclusionInput, skillRootExcludePrefixes: string[] = []): boolean {
  validatePath(relative);
  const { patterns, prefixes } = settings(input, skillRootExcludePrefixes);
  if (prefixes.some(prefix => relative === prefix || relative.startsWith(prefix + '/'))) return false;
  const ancestors = relative.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'));
  return !patterns.map(exclusion).some(pattern => ancestors.some(ancestor => pattern.test(ancestor)));
}

interface Candidate {
  path: string; tracked: boolean; modes: Set<string>; stages: Set<number>; directory: boolean;
  head?: { mode: string; oid: string }; index?: { mode: string; oid: string };
}
interface GitState { head: string | null; candidates: Candidate[]; token: string; dirty: boolean; commonDir: string; directories: string[]; ignoredDirectoryPrefixes: string[] }
interface GitRun { (...args: string[]): Promise<Buffer>; input(args: string[], input: Buffer): Promise<Buffer> }

function gitRunner(root: string): GitRun {
  const environment: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' };
  for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS', 'GIT_ATTR_SOURCE']) delete environment[key];
  const invoke = async (args: string[], input?: Buffer): Promise<Buffer> => {
    try {
      const arguments_ = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', root, ...args];
      const options = {
        windowsHide: true, env: environment, encoding: 'buffer', maxBuffer: 128 * 1024 * 1024,
      } as const;
      if (input === undefined) return (await execFile('git', arguments_, options)).stdout;
      return await new Promise<Buffer>((resolve, reject) => {
        const child = callbackExecFile('git', arguments_, options, (error, stdout) => error ? reject(error) : resolve(stdout));
        child.stdin?.on('error', reject);
        child.stdin?.end(input);
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'number') throw error;
      throw new ScanFailure('SOURCE_GIT_ERROR', 'Git source discovery could not be completed.');
    }
  };
  const run = ((...args: string[]) => invoke(args)) as GitRun;
  run.input = invoke;
  return run;
}

const line = (bytes: Buffer): string => decode(bytes, 'SOURCE_CONFIG_ENCODING').replace(/\r?\n$/, '');
const gitCode = (error: unknown, expected: number): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === expected;

async function gitState(run: GitRun, worktree: WorktreeRecord, config: ProjectConfig, prefixes: string[]): Promise<GitState> {
  const root = await canonicalPath(line(await run('rev-parse', '--show-toplevel')));
  const commonDir = await canonicalPath(line(await run('rev-parse', '--path-format=absolute', '--git-common-dir')));
  if (!samePath(root, worktree.root) || worktree.gitCommonDir === null || !samePath(commonDir, worktree.gitCommonDir) || config.projectId !== worktree.projectId) throw new ScanFailure('SOURCE_TARGET_CHANGED', 'The current Git/project identity does not match the registered target.');
  let head: string | null = null;
  try { head = line(await run('rev-parse', '--verify', '--quiet', 'HEAD')); } catch (error) { if (!gitCode(error, 1)) throw error; }
  if (head !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) throw new ScanFailure('SOURCE_GIT_OUTPUT', 'Git returned an invalid commit identifier.');
  const [headBytes, indexBytes] = await Promise.all([
    head ? run('ls-tree', '-r', '-z', '--full-tree', head) : Promise.resolve(Buffer.alloc(0)),
    run('ls-files', '--stage', '-z', '--full-name'),
  ]);
  const candidates = new Map<string, Candidate>();
  const spellings = new Map<string, string>();
  const included = (candidate: string) => isSourcePathIncluded(candidate, config, prefixes);
  const add = (raw: string, tracked: boolean, mode?: string, stage?: number, oid?: string, fromHead = false): void => {
    const directory = raw.endsWith('/');
    const relative = validatePath(directory ? raw.slice(0, -1) : raw);
    if (!included(relative)) return;
    const spelling = process.platform === 'win32' ? relative.toLowerCase() : relative;
    if (spellings.has(spelling) && spellings.get(spelling) !== relative) throw new ScanFailure('SOURCE_PATH_CONFLICT', 'Distinct Git paths refer to the same filesystem path.', relative);
    spellings.set(spelling, relative);
    let item = candidates.get(relative);
    if (!item) { item = { path: relative, tracked: false, modes: new Set(), stages: new Set(), directory: false }; candidates.set(relative, item); }
    item.tracked ||= tracked;
    item.directory ||= directory;
    if (mode !== undefined) item.modes.add(mode);
    if (stage !== undefined) item.stages.add(stage);
    if (mode !== undefined && oid !== undefined) {
      if (fromHead) item.head = { mode, oid };
      else if (stage === 0) item.index = { mode, oid };
    }
  };
  for (const record of records(headBytes)) {
    const match = /^([0-7]{6}) (?:blob|commit|tree) ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
    if (!match) throw new ScanFailure('SOURCE_GIT_OUTPUT', 'Git returned an invalid tree record.');
    add(match[3]!, true, match[1]!, undefined, match[2]!, true);
  }
  const indexTokens: string[] = [];
  for (const record of records(indexBytes)) {
    const match = /^([0-7]{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(record);
    if (!match) throw new ScanFailure('SOURCE_GIT_OUTPUT', 'Git returned an invalid index record.');
    const relative = validatePath(match[4]!);
    if (included(relative)) indexTokens.push(record);
    add(relative, true, match[1]!, Number(match[3]), match[2]!);
  }
  for (const candidate of candidates.values()) {
    if ([...candidate.stages].some(stage => stage !== 0)) throw new ScanFailure('SOURCE_INDEX_CONFLICT', 'Unresolved index stages prevent a complete source snapshot.', candidate.path);
    if ([...candidate.modes].some(mode => !['100644', '100755', '120000'].includes(mode))) throw new ScanFailure('SOURCE_UNSUPPORTED_ENTRY', 'Gitlinks and unsupported Git entry kinds cannot be scanned.', candidate.path);
    await checkParents(root, candidate.path);
  }
  // Walk only ordinary directories and ask native Git to classify ignore rules.
  // Native Git for Windows may traverse junctions while listing untracked files;
  // avoiding that listing keeps junction targets outside the scanner entirely.
  const discovered = await untrackedEntries(run, root, candidates, included);
  for (const candidate of discovered.entries) add(candidate.path + (candidate.directory ? '/' : ''), false);
  const untrackedTokens = [...candidates.values()].filter(candidate => !candidate.tracked).map(candidate => candidate.path).sort(compare);
  const statusTokens: string[] = [];
  const regularTracked: string[] = [];
  const filterable: string[] = [];
  for (const candidate of candidates.values()) {
    if (!candidate.tracked) continue;
    let metadata;
    try { metadata = await lstat(path.join(root, ...candidate.path.split('/'))); } catch (error) { if (!absent(error)) throw error; }
    if (metadata?.isSymbolicLink()) {
      const target = await readlink(path.join(root, ...candidate.path.split('/')), { encoding: 'buffer' });
      decode(target, 'SOURCE_LINK_ENCODING');
      // Git for Windows and Node expose different textual spellings of native
      // link targets. Git compares its own tracked-link representation; with
      // untracked traversal disabled this does not enumerate target contents.
      if (candidate.index?.mode === '120000') regularTracked.push(candidate.path);
      else statusTokens.push('link-type-change ' + candidate.path + ' ' + sha256(target));
    } else { regularTracked.push(candidate.path); if (metadata?.isFile()) filterable.push(candidate.path); }
  }
  await rejectExternalFilters(run, filterable);
  // Only selected tracked leaves reach status; directory links without a Git
  // symlink mode never reach it. No untracked directory traversal takes place.
  for (const chunk of argumentChunks(regularTracked)) {
    const bytes = await run('status', '--porcelain=v1', '-z', '--untracked-files=no', '--no-renames', '--ignore-submodules=all', '--', ...chunk.map(relative => ':(top,literal)' + relative));
    for (const record of records(bytes)) {
      if (!/^[ MARCUD?!]{2} /.test(record)) throw new ScanFailure('SOURCE_GIT_OUTPUT', 'Git returned an unsupported status record.');
      const relative = validatePath(record.slice(3));
      if (included(relative)) statusTokens.push(record);
    }
  }
  return {
    head, commonDir, candidates: [...candidates.values()].sort((a, b) => compare(a.path, b.path)), dirty: statusTokens.length > 0 || untrackedTokens.length > 0, directories: discovered.directories, ignoredDirectoryPrefixes: discovered.ignoredDirectoryPrefixes,
    token: canonicalJson({ head, index: indexTokens.sort(compare), untracked: untrackedTokens.sort(compare), status: statusTokens.sort(compare) }),
  };
}

async function rejectExternalFilters(run: GitRun, selected: string[]): Promise<void> {
  const drivers = new Map<string, boolean>();
  const commandConfigured = async (key: string): Promise<boolean> => {
    try { return line(await run('config', '--get', key)).trim().length > 0; }
    catch (error) { if (gitCode(error, 1)) return false; throw error; }
  };
  for (const chunk of stdinChunks(selected)) {
    const attributes = records(await run.input(['check-attr', '-z', '--stdin', 'filter'], Buffer.from(chunk.join('\0') + '\0')));
    if (attributes.length % 3 !== 0) throw new ScanFailure('SOURCE_GIT_OUTPUT', 'Git returned an invalid filter-attribute record.');
    for (let index = 0; index < attributes.length; index += 3) {
      const relative = validatePath(attributes[index]!);
      if (attributes[index + 1] !== 'filter') throw new ScanFailure('SOURCE_GIT_OUTPUT', 'Git returned an unexpected source attribute.');
      const driver = attributes[index + 2]!;
      if (!driver || ['unspecified', 'unset', 'set'].includes(driver)) continue;
      let external = drivers.get(driver);
      if (external === undefined) {
        const configured = await Promise.all([commandConfigured(`filter.${driver}.clean`), commandConfigured(`filter.${driver}.process`)]);
        external = configured.some(Boolean); drivers.set(driver, external);
      }
      if (external) throw new ScanFailure('SOURCE_FILTER_UNSUPPORTED', 'The selected tracked source requires an external Git clean/process filter. Read-only scanning does not execute that driver; explicitly exclude this scope to proceed.', relative);
    }
  }
}

function argumentChunks(values: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const value of values) {
    if (current.length && (current.length >= 100 || length + value.length > 8000)) { chunks.push(current); current = []; length = 0; }
    current.push(value); length += value.length + 32;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

// stdin bypasses argv limits; bound its UTF-8 payload independently instead.
const STDIN_BATCH_BYTES = 64 * 1024;
const IGNORE_BATCH_DIRECTORIES = 32;
function* stdinChunks(values: Iterable<string>): Generator<string[]> {
  let current: string[] = [];
  let bytes = 0;
  for (const value of values) {
    const size = Buffer.byteLength(value, 'utf8') + 1;
    if (current.length && bytes + size > STDIN_BATCH_BYTES) { yield current; current = []; bytes = 0; }
    current.push(value); bytes += size;
  }
  if (current.length) yield current;
}

async function untrackedEntries(run: GitRun, root: string, tracked: Map<string, Candidate>, included: (relative: string) => boolean): Promise<{ entries: { path: string; directory: boolean }[]; directories: string[]; ignoredDirectoryPrefixes: string[] }> {
  let frontier = [''];
  const directories: string[] = [];
  const entries: { path: string; directory: boolean }[] = [];
  const ignoredDirectoryPrefixes: string[] = [];
  while (frontier.length) {
    const next: string[] = [];
    const selected: { path: string; isDirectory: boolean }[] = [];
    let bytes = 0, visited = 0;
    const flush = async (): Promise<void> => {
      visited = 0;
      if (!selected.length) return;
      const batch = selected.splice(0);
      bytes = 0;
      // Siblings may have waited in the batch. Never ask Git to classify a
      // descendant whose directory has since become a link.
      for (const child of batch) if (!await checkParents(root, child.path)) throw new ScanFailure('SOURCE_SCAN_RACE', 'A source directory disappeared during classification.', child.path, true);
      const ignored = new Set<string>();
      try { for (const record of records(await run.input(['check-ignore', '--no-index', '-z', '--stdin'], Buffer.from(batch.map(child => child.path).join('\0') + '\0')))) ignored.add(validatePath(record)); }
      catch (error) { if (!gitCode(error, 1)) throw error; }
      for (const child of batch) {
        if (ignored.has(child.path)) { if (child.isDirectory) ignoredDirectoryPrefixes.push(child.path); continue; }
        if (!child.isDirectory) { entries.push({ path: child.path, directory: false }); continue; }
        // Classification can wait for sibling directories; recheck before any descent.
        if (!await checkParents(root, child.path + '/.probe')) throw new ScanFailure('SOURCE_SCAN_RACE', 'A source directory disappeared during discovery.', child.path, true);
        let nestedGit = false;
        try { await lstat(path.join(root, ...child.path.split('/'), '.git')); nestedGit = true; } catch (error) { if (!absent(error)) throw error; }
        if (await nestedProject(root, child.path)) throw new ScanFailure('SOURCE_NESTED_PROJECT', 'A nested HarnessL3 project is an independent source boundary. Review and explicitly exclude its relative path in source.excludePatterns.', child.path);
        if (nestedGit) entries.push({ path: child.path, directory: true });
        else next.push(child.path);
      }
    };
    for (const relativeDirectory of frontier) {
      if (relativeDirectory && !await checkParents(root, relativeDirectory + '/.probe')) throw new ScanFailure('SOURCE_SCAN_RACE', 'A source directory disappeared during discovery.', relativeDirectory, true);
      directories.push(relativeDirectory);
      const children = await readdir(path.join(root, ...relativeDirectory.split('/').filter(Boolean)), { withFileTypes: true, encoding: 'buffer' });
      for (const child of children) {
        const name = decode(child.name);
        const relative = validatePath(relativeDirectory ? relativeDirectory + '/' + name : name);
        if (!included(relative)) continue;
        if (tracked.has(relative) && !child.isDirectory()) continue;
        const size = Buffer.byteLength(relative, 'utf8') + 1;
        if (selected.length && bytes + size > STDIN_BATCH_BYTES) await flush();
        selected.push({ path: relative, isDirectory: child.isDirectory() && !child.isSymbolicLink() });
        bytes += size;
      }
      if (++visited >= IGNORE_BATCH_DIRECTORIES) await flush();
    }
    await flush();
    frontier = next;
  }
  return { entries, directories, ignoredDirectoryPrefixes: ignoredDirectoryPrefixes.sort(compare) };
}

async function checkParents(root: string, relative: string): Promise<boolean> {
  let current = root;
  for (const part of relative.split('/').slice(0, -1)) {
    current = path.join(current, part);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) throw new ScanFailure('SOURCE_ANCESTOR_LINK', 'A source path is hidden by a linked ancestor; its target was not read.', relative);
      if (!entry.isDirectory()) return false;
    } catch (error) { if (absent(error)) return false; throw error; }
  }
  return true;
}

function identity(metadata: Awaited<ReturnType<typeof stat>>): string {
  return [metadata.dev, metadata.ino, metadata.mode, metadata.size, metadata.mtimeMs, metadata.ctimeMs].join(':');
}

async function ordinaryBytes(file: string, label: string, noFollow = true): Promise<{ bytes: Buffer; token: string }> {
  const before = noFollow ? await lstat(file) : await stat(file);
  if (!before.isFile()) throw new ScanFailure('SOURCE_UNSUPPORTED_ENTRY', 'The source entry is not an ordinary file.', label);
  const actualBefore = await realpath(file);
  const handle = await open(file, constants.O_RDONLY | (noFollow ? (constants.O_NOFOLLOW ?? 0) : 0) | (constants.O_NONBLOCK ?? 0));
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || identity(opened) !== identity(before)) throw new ScanFailure('SOURCE_SCAN_RACE', 'A source changed while it was being captured.', label, true);
    bytes = await handle.readFile();
    if (identity(await handle.stat()) !== identity(before)) throw new ScanFailure('SOURCE_SCAN_RACE', 'A source changed while it was being captured.', label, true);
  } finally { await handle.close(); }
  const after = noFollow ? await lstat(file) : await stat(file);
  const actualAfter = await realpath(file);
  if (identity(before) !== identity(after) || !samePath(actualBefore, actualAfter)) throw new ScanFailure('SOURCE_SCAN_RACE', 'A source changed while it was being captured.', label, true);
  return { bytes, token: actualBefore + '\0' + identity(before) };
}

async function sourceEntry(root: string, candidate: Candidate): Promise<SourceEntry> {
  if ([...candidate.stages].some(stage => stage !== 0)) throw new ScanFailure('SOURCE_INDEX_CONFLICT', 'Unresolved index stages prevent a complete source snapshot.', candidate.path);
  if ([...candidate.modes].some(mode => !['100644', '100755', '120000'].includes(mode))) throw new ScanFailure('SOURCE_UNSUPPORTED_ENTRY', 'Gitlinks and unsupported Git entry kinds cannot be scanned.', candidate.path);
  if (candidate.directory) throw new ScanFailure('SOURCE_NESTED_REPOSITORY', 'A nested repository is a separate source boundary and was not traversed. Review this scope; to exclude it explicitly, add its worktree-relative path to source.excludePatterns in .harness/project.json. Do not remove its .git directory.', candidate.path);
  const presentParents = await checkParents(root, candidate.path);
  const file = path.join(root, ...candidate.path.split('/'));
  let entry;
  try { entry = presentParents ? await lstat(file) : null; } catch (error) { if (!absent(error)) throw error; entry = null; }
  if (!entry) {
    if (!candidate.tracked) throw new ScanFailure('SOURCE_SCAN_RACE', 'An untracked source disappeared during scanning.', candidate.path, true);
    return { path: candidate.path, entryKind: 'deleted', contentHash: null };
  }
  if (entry.isSymbolicLink()) {
    const bytes = await readlink(file, { encoding: 'buffer' });
    const value = decode(bytes, 'SOURCE_LINK_ENCODING');
    if (!validUnicode(value)) throw new ScanFailure('SOURCE_LINK_ENCODING', 'A link target is not valid Unicode.', candidate.path);
    if (identity(await lstat(file)) !== identity(entry) || !await checkParents(root, candidate.path)) throw new ScanFailure('SOURCE_SCAN_RACE', 'A source link changed during scanning.', candidate.path, true);
    return { path: candidate.path, entryKind: 'symlink', contentHash: sha256(Buffer.from(value, 'utf8')) };
  }
  if (!entry.isFile() || candidate.directory) throw new ScanFailure('SOURCE_UNSUPPORTED_ENTRY', 'Directory/gitlink or special-file source entries are unsupported.', candidate.path);
  const captured = await ordinaryBytes(file, candidate.path);
  if (!await checkParents(root, candidate.path)) throw new ScanFailure('SOURCE_SCAN_RACE', 'A source ancestor changed during scanning.', candidate.path, true);
  return { path: candidate.path, entryKind: 'file', contentHash: sha256(captured.bytes) };
}

interface CapturedRules { rules: IgnoreRules; files: IgnoreRuleFile[]; token: string }

async function nestedProject(root: string, relative: string): Promise<boolean> {
  const metadata = path.join(root, ...relative.split('/'), '.harness');
  try {
    const directory = await lstat(metadata);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
    await lstat(path.join(metadata, 'project.json'));
    return true;
  } catch (error) { if (absent(error)) return false; throw error; }
}

interface DirectoryRule { base: string; matcher: ReturnType<typeof ignore> }
function directoryRule(relative: string, bytes: Buffer): DirectoryRule {
  const slash = relative.lastIndexOf('/');
  return { base: slash < 0 ? '' : relative.slice(0, slash + 1), matcher: ignore({ ignorecase: false }).add(decode(bytes, 'SOURCE_IGNORE_ENCODING')) };
}

/** Apply each ancestor's rules in order, without resurrecting excluded parents. */
function directoryIgnored(relative: string, directory: boolean, rules: DirectoryRule[]): boolean {
  const parts = relative.split('/');
  for (let index = 1; index <= parts.length; index++) {
    const target = parts.slice(0, index).join('/') + (index < parts.length || directory ? '/' : '');
    let ignored = false;
    for (const rule of rules) {
      if (!target.startsWith(rule.base) || target === rule.base) continue;
      const result = rule.matcher.test(target.slice(rule.base.length));
      if (result.ignored) ignored = true;
      else if (result.unignored) ignored = false;
    }
    if (ignored) return true;
  }
  return false;
}

async function captureDirectoryRule(root: string, relative: string): Promise<{ rule: DirectoryRule; source: IgnoreSource; file: IgnoreRuleFile; token: string } | null> {
  if (!await checkParents(root, relative)) throw new ScanFailure('SOURCE_SCAN_RACE', 'An ignore-rule ancestor disappeared.', relative, true);
  try {
    const file = path.join(root, ...relative.split('/'));
    const metadata = await lstat(file);
    if (metadata.isSymbolicLink()) return null;
    const captured = await ordinaryBytes(file, relative);
    const hash = sha256(captured.bytes);
    return { rule: directoryRule(relative, captured.bytes), source: { origin: 'worktree', path: relative, hash }, file: { origin: 'worktree', path: relative, bytesBase64: captured.bytes.toString('base64') }, token: relative + ':' + captured.token + ':' + hash };
  } catch (error) { if (absent(error)) return null; throw error; }
}

/** Watcher classification reads only the applicable rule chain, using the scan's matcher. */
export async function isDirectoryPathIgnored(root: string, relative: string, directory: boolean): Promise<boolean> {
  validatePath(relative);
  const rules: DirectoryRule[] = [];
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    const base = parts.slice(0, index).join('/');
    if (base && directoryIgnored(base, true, rules)) return true;
    const captured = await captureDirectoryRule(root, (base ? base + '/' : '') + '.gitignore');
    if (captured) rules.push(captured.rule);
  }
  return directoryIgnored(relative, directory, rules);
}

async function directoryState(root: string, config: ProjectConfig, prefixes: string[]): Promise<{ candidates: Candidate[]; rules: CapturedRules; token: string; ignoredDirectoryPrefixes: string[]; verify: () => Promise<void> }> {
  try { await lstat(path.join(root, '.git')); throw new ScanFailure('SOURCE_TARGET_CHANGED', 'Git metadata appeared; resolve the workspace again before scanning.'); }
  catch (error) { if (!absent(error)) throw error; }
  const candidates: Candidate[] = [], sources: IgnoreSource[] = [], files: IgnoreRuleFile[] = [], tokens: string[] = [], directories: string[] = [], ignored: string[] = [];
  const directoryTokens = new Map<string, string>();
  const visit = async (relative: string, inherited: DirectoryRule[]): Promise<void> => {
    if (relative && !await checkParents(root, relative + '/.probe')) throw new ScanFailure('SOURCE_SCAN_RACE', 'A source directory disappeared.', relative, true);
    directories.push(relative);
    directoryTokens.set(relative, identity(await lstat(path.join(root, ...relative.split('/').filter(Boolean)))));
    const captured = await captureDirectoryRule(root, (relative ? relative + '/' : '') + '.gitignore');
    const rules = captured ? [...inherited, captured.rule] : inherited;
    if (captured) { sources.push(captured.source); files.push(captured.file); tokens.push(captured.token); }
    const children = await readdir(path.join(root, ...relative.split('/').filter(Boolean)), { withFileTypes: true, encoding: 'buffer' });
    for (const child of children) {
      const name = decode(child.name);
      const candidate = validatePath(relative ? relative + '/' + name : name);
      if (!isSourcePathIncluded(candidate, config, prefixes)) continue;
      const directory = child.isDirectory() && !child.isSymbolicLink();
      if (directoryIgnored(candidate, directory, rules)) { if (directory) ignored.push(candidate); continue; }
      if (directory) {
        if (!await checkParents(root, candidate + '/.probe')) throw new ScanFailure('SOURCE_SCAN_RACE', 'A source directory disappeared.', candidate, true);
        // A .git link is also a boundary; never traverse its target.
        try { await lstat(path.join(root, ...candidate.split('/'), '.git')); throw new ScanFailure('SOURCE_NESTED_REPOSITORY', 'A nested repository is an independent source boundary. Review and explicitly exclude its relative path in source.excludePatterns to proceed.', candidate); }
        catch (error) { if (!absent(error)) throw error; }
        if (await nestedProject(root, candidate)) throw new ScanFailure('SOURCE_NESTED_PROJECT', 'A nested project is an independent source boundary. Review and explicitly exclude its relative path in source.excludePatterns to proceed.', candidate);
        await visit(candidate, rules);
      } else candidates.push({ path: candidate, tracked: false, modes: new Set(), stages: new Set([0]), directory: false });
    }
  };
  await visit('', []);
  candidates.sort((a, b) => compare(a.path, b.path));
  sources.sort((a, b) => compare(a.path!, b.path!)); files.sort((a, b) => compare(a.path!, b.path!));
  const rules: CapturedRules = { rules: { schemaVersion: 1, kind: 'git-ignore-rules', content: { ignoreCase: false, sources } }, files, token: canonicalJson(tokens.sort(compare)) };
  const verify = async (): Promise<void> => {
    // These tokens only detect late enumeration races; both complete byte passes remain mandatory.
    const currentRules: string[] = [];
    for (const relative of directories) {
      if (relative && !await checkParents(root, relative + '/.probe')) throw new ScanFailure('SOURCE_SCAN_RACE', 'A source directory disappeared during verification.', relative, true);
      const directory = await lstat(path.join(root, ...relative.split('/').filter(Boolean)));
      if (directory.isSymbolicLink() || !directory.isDirectory() || identity(directory) !== directoryTokens.get(relative)) throw new ScanFailure('SOURCE_SCAN_RACE', 'Directory entries changed during source capture.', relative || undefined, true);
      const captured = await captureDirectoryRule(root, (relative ? relative + '/' : '') + '.gitignore');
      if (captured) currentRules.push(captured.token);
    }
    if (canonicalJson(currentRules.sort(compare)) !== rules.token) throw new ScanFailure('SOURCE_SCAN_RACE', 'Ignore rules changed during byte verification.', undefined, true);
  };
  await verify();
  return { candidates, rules, ignoredDirectoryPrefixes: ignored.sort(compare), verify, token: canonicalJson({ candidates: candidates.map(item => item.path), directories: [...directoryTokens].sort((a, b) => compare(a[0], b[0])) }) };
}

async function ignoreRules(run: GitRun, root: string, state: GitState): Promise<CapturedRules> {
  const ignoreCaseValue = line(await run('config', '--bool', '--default', 'false', '--get', 'core.ignorecase'));
  if (ignoreCaseValue !== 'true' && ignoreCaseValue !== 'false') throw new ScanFailure('SOURCE_IGNORE_UNAVAILABLE', 'The effective Git ignore-case setting could not be read.');
  const defaultGlobal = process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, 'git', 'ignore') : '~/.config/git/ignore';
  const globalValue = line(await run('config', '--path', '--default', defaultGlobal, '--get', 'core.excludesfile'));
  const sources: IgnoreSource[] = [];
  const files: IgnoreRuleFile[] = [];
  const privateTokens: string[] = [];
  const capture = async (origin: IgnoreSource['origin'], relative: string | null, file: string | null, worktreeRule = false): Promise<void> => {
    if (file === null) { sources.push({ origin, path: relative, hash: null }); privateTokens.push(origin + ':disabled'); return; }
    try {
      if (worktreeRule && !await checkParents(root, relative!)) return;
      const metadata = await lstat(file);
      // Native Git ignores linked .gitignore files in the worktree. They remain
      // ordinary source link leaves; no target is read as an ignore rule.
      if (worktreeRule && metadata.isSymbolicLink()) { privateTokens.push(relative! + ':link'); return; }
      const captured = await ordinaryBytes(file, relative ?? origin, worktreeRule);
      const hash = sha256(captured.bytes);
      sources.push({ origin, path: relative, hash });
      files.push({ origin, path: relative, bytesBase64: captured.bytes.toString('base64') });
      privateTokens.push(origin + ':' + relative + ':' + captured.token + ':' + hash);
    } catch (error) {
      if (absent(error)) {
        if (!worktreeRule) sources.push({ origin, path: null, hash: null });
        privateTokens.push(origin + ':' + relative + ':missing');
        return;
      }
      if (error instanceof ScanFailure) throw error;
      throw new ScanFailure('SOURCE_IGNORE_UNAVAILABLE', 'The effective Git ignore rule bytes could not be captured.', relative ?? undefined);
    }
  };
  await capture('global', null, globalValue ? path.resolve(root, globalValue) : null);
  await capture('info', null, path.join(state.commonDir, 'info', 'exclude'));
  const applicable = new Set<string>(['.gitignore']);
  for (const directory of state.directories) if (directory) applicable.add(directory + '/.gitignore');
  for (const candidate of state.candidates) {
    const parts = candidate.path.split('/');
    for (let index = 1; index < parts.length; index++) applicable.add(parts.slice(0, index).join('/') + '/.gitignore');
  }
  for (const relative of [...applicable].sort(compare)) await capture('worktree', relative, path.join(root, ...relative.split('/')), true);
  return { rules: { schemaVersion: 1, kind: 'git-ignore-rules', content: { ignoreCase: ignoreCaseValue === 'true', sources } }, files, token: canonicalJson(privateTokens) };
}

function policy(config: ProjectConfig, prefixes: string[], rules: IgnoreRules): SourcePolicy {
  return { schemaVersion: 1, kind: 'source-scan-policy', content: {
    scannerVersion: 'source-scanner/1', candidateSet: 'head-index-and-untracked', pathOrder: 'utf16-code-unit', ruleDialect: 'posix-glob-v1', caseSensitive: true,
    includePatterns: ['**'], fixedExcludePrefixes: ['.git', '.harness'], projectExcludePatterns: [...new Set(config.source.excludePatterns)].sort(compare),
    gitIgnoreMode: 'untracked-only', gitIgnoreRevision: digest('git-ignore-rules', rules.content), skillRootExcludePrefixes: [...new Set(prefixes)].sort(compare),
    linkHandling: 'record-readlink-utf8-no-follow', unsupportedEntryHandling: 'unknown',
  } };
}

async function currentConfig(root: string, config: ProjectConfig): Promise<string> {
  try {
    if (!await checkParents(root, '.harness/project.json')) throw new ScanFailure('SOURCE_CONFIG_UNAVAILABLE', 'The source configuration directory is missing.', '.harness/project.json');
    const bytes = await ordinaryBytes(path.join(root, '.harness', 'project.json'), '.harness/project.json');
    const current = parseJsonStrict(decode(bytes.bytes, 'SOURCE_CONFIG_ENCODING')) as ProjectConfig;
    const target = (value: ProjectConfig) => canonicalJson({ projectId: value.projectId, source: value.source, skills: value.skills ?? null });
    if (target(current) !== target(config)) throw new ScanFailure('SOURCE_CONFIG_CHANGED', 'The source configuration changed; retry with the current configuration.', '.harness/project.json', true);
    return target(current);
  } catch (error) {
    if (error instanceof ScanFailure) throw error;
    throw new ScanFailure('SOURCE_CONFIG_UNAVAILABLE', 'The current source configuration could not be verified.', '.harness/project.json');
  }
}

/** Capture a reproducible source scope, without interpreting file contents. */
export async function scanSource(worktree: WorktreeRecord, config: ProjectConfig, skillsRoot: string): Promise<SourceScan> {
  const result: SourceScan = { sourceVersion: { head: null, treeHash: null, status: 'unknown' }, sourceScanRevision: null, manifest: null, policy: null, diagnostics: [], ignoreRules: null, ignoreRuleFiles: [] };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      for (const pattern of config.source.excludePatterns) exclusion(pattern);
      const root = await canonicalPath(worktree.root);
      const actualSkills = await canonicalPath(skillsRoot);
      const prefixes = isWithin(root, actualSkills, false) ? [path.relative(root, actualSkills).split(path.sep).join('/')] : [];
      const configToken = await currentConfig(root, config);
      if (worktree.kind === 'directory') {
        if (!samePath(root, worktree.root) || config.projectId !== worktree.projectId) throw new ScanFailure('SOURCE_TARGET_CHANGED', 'The directory/project identity changed.');
        const before = await directoryState(root, config, prefixes);
        result.ignoreRules = before.rules.rules; result.ignoreRuleFiles = before.rules.files;
        result.ignoredDirectoryPrefixes = before.ignoredDirectoryPrefixes;
        result.policy = policy(config, prefixes, before.rules.rules);
        Object.assign(result.policy.content, { scannerVersion: 'directory-scanner/1', candidateSet: 'filesystem', gitIgnoreMode: 'directory-files' });
        result.sourceScanRevision = digest('source-scan-policy', result.policy.content);
        const entries: SourceEntry[] = [];
        for (const candidate of before.candidates) entries.push(await sourceEntry(root, candidate));
        const after = await directoryState(root, config, prefixes);
        if (before.token !== after.token || before.rules.token !== after.rules.token || configToken !== await currentConfig(root, config)) throw new ScanFailure('SOURCE_SCAN_RACE', 'Directory entries or rules changed during scanning.', undefined, true);
        const verified: SourceEntry[] = [];
        for (const candidate of after.candidates) verified.push(await sourceEntry(root, candidate));
        if (canonicalJson(entries) !== canonicalJson(verified)) throw new ScanFailure('SOURCE_SCAN_RACE', 'Source bytes changed during scanning.', undefined, true);
        await after.verify();
        if (configToken !== await currentConfig(root, config)) throw new ScanFailure('SOURCE_CONFIG_CHANGED', 'The source configuration changed during byte verification.', '.harness/project.json', true);
        result.manifest = { schemaVersion: 1, kind: 'source-manifest', content: { entries } };
        result.sourceVersion = { head: null, treeHash: digest('source-manifest', result.manifest.content), status: 'unversioned' };
        result.diagnostics = [];
        return result;
      }
      const run = gitRunner(root);
      const before = await gitState(run, worktree, config, prefixes);
      result.sourceVersion.head = before.head;
      result.ignoredDirectoryPrefixes = before.ignoredDirectoryPrefixes;
      const rules = await ignoreRules(run, root, before);
      result.ignoreRules = rules.rules;
      result.ignoreRuleFiles = rules.files;
      result.policy = policy(config, prefixes, rules.rules);
      result.sourceScanRevision = digest('source-scan-policy', result.policy.content);
      const entries: SourceEntry[] = [];
      for (const candidate of before.candidates) entries.push(await sourceEntry(root, candidate));
      const after = await gitState(run, worktree, config, prefixes);
      const afterRules = await ignoreRules(run, root, after);
      if (before.token !== after.token || rules.token !== afterRules.token || configToken !== await currentConfig(root, config)) throw new ScanFailure('SOURCE_SCAN_RACE', 'Git state or ignore policy changed during the source scan.', undefined, true);
      const verified: SourceEntry[] = [];
      for (const candidate of after.candidates) verified.push(await sourceEntry(root, candidate));
      if (canonicalJson(entries) !== canonicalJson(verified)) throw new ScanFailure('SOURCE_SCAN_RACE', 'Source bytes changed during the source scan.', undefined, true);
      result.manifest = { schemaVersion: 1, kind: 'source-manifest', content: { entries } };
      result.sourceVersion = { head: before.head, treeHash: digest('source-manifest', result.manifest.content), status: before.dirty ? 'dirty' : 'clean' };
      result.diagnostics = [];
      return result;
    } catch (error) {
      const failure = error instanceof ScanFailure ? error : new ScanFailure('SOURCE_SCAN_UNAVAILABLE', 'The complete source scope could not be scanned.');
      if (failure.race && attempt === 0) { result.policy = null; result.sourceScanRevision = null; result.ignoreRules = null; result.ignoreRuleFiles = []; continue; }
      result.sourceVersion = { head: result.sourceVersion.head, treeHash: null, status: 'unknown' };
      result.manifest = null;
      result.diagnostics = [failure.diagnostic()];
      return result;
    }
  }
  return result;
}

export function changedSourcePaths(previous: SourceScan, next: SourceScan): string[] {
  if (!previous.manifest || !next.manifest || previous.sourceVersion.status === 'unknown' || next.sourceVersion.status === 'unknown') throw new HarnessError('SYNC_UNRESOLVED', 'Unknown source scans cannot establish that paths are unchanged.');
  const left = new Map(previous.manifest.content.entries.map(entry => [entry.path, entry]));
  const right = new Map(next.manifest.content.entries.map(entry => [entry.path, entry]));
  return [...new Set([...left.keys(), ...right.keys()])].filter(relative => canonicalJson(left.get(relative) ?? null) !== canonicalJson(right.get(relative) ?? null)).sort(compare);
}
