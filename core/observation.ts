import { open, stat, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { Archive } from './archive.js';
import { HarnessError } from './errors.js';
import { canonicalJson, digest, parseJsonStrict, sha256 } from './json.js';
import { canonicalPath, isWithin, samePath } from './paths.js';
import type { WorktreeRecord } from './types.js';

type Agent = 'codex' | 'claude-code';
type CoverageState = 'unbound' | 'observing' | 'partial' | 'unknown' | 'error' | 'stopped';
type Range = { startLine: number; endLine: number };
type Position = { generation: number; start: number; end: number };
type Gap = { code: string; generation: number; start: number; end: number; recordHash: string | null };
export interface ObservationEvent {
  schemaVersion: 1; eventId: string; projectId: string; worktreeId: string; taskId: string | null;
  agent: Agent; adapterVersion: string; declaredHostVersion: string | null; detectedHostVersion: string | null;
  sessionId: string; bindingId: string; generation: number; byteRange: { start: number; end: number };
  recordId: string | null; callId: string; occurredAt: string | null; observedAt: string; backfilled: boolean;
  operation: 'read' | 'search' | 'write'; tool: string; paths: string[]; pathValidation: string[];
  requestedRange: Range | null; returnedRange: Range | null; status: 'attempted' | 'succeeded' | 'failed' | 'unknown';
  resultMatched: boolean; resultRange: Position | null; exitCategory: string | null; truncated: boolean | null; partial: boolean | null;
  contentHash: null; contentHashSource: null; versionStatus: 'unknown';
  ownership: 'matched' | 'outside-worktree' | 'unknown'; support: 'literal-operation' | 'nested-unconfirmed'; diagnosticIds: string[];
}
type Cursor = { sourceIdentity: string; generation: number; offset: number; tailHash: string | null; anchorHash: string | null; adapterVersion: string; lastCommittedSeq: number };
type Coverage = { state: CoverageState; supportedTools: string[]; observedResults: number; unknownResults: number; failedResults: number; unsupportedRecords: number; unrecognizedRecords: number; hostVersionVerified: boolean; diagnostics: Gap[]; note: string };
export interface ObservationBinding {
  id: string; agent: Agent; sessionId: string; logFile: string; taskId: string | null; state: CoverageState;
  parserVersion: string; createdAt: string; stoppedAt: string | null; cursor: Cursor; coverage: Coverage;
}
type Operation = { operation: ObservationEvent['operation']; tool: string; paths: string[]; cwd: string | null; requestedRange: Range | null; nested: boolean; directResult: boolean; engine?: 'rg' };
type Pending = { eventIds: string[]; nested: boolean; directResult: boolean; engine: 'rg' | null };
type StoredBinding = ObservationBinding & {
  active: boolean; hostVersion: string | null; sessionVerified: boolean; cwd: string | null; pauseReason: string | null;
  pending: Record<string, Pending>; processes: Record<string, string>; polls: Record<string, string>; seen: string[];
};
type Mutation = { kind: 'observation-state'; binding: StoredBinding; events: ObservationEvent[]; snapshotHash: string };
type BindInput = { agent: Agent; sessionId: string; logFile: string; taskId?: string; requestId: string };
type Result = { bindings: ObservationBinding[]; replayed: boolean };
type Options = {
  worktree: WorktreeRecord; archive: Archive; serial: <T>(work: () => Promise<T>) => Promise<T>;
  onCommit?: (events: ObservationEvent[]) => void | Promise<void>; now?: () => string; pollIntervalMs?: number;
  validatedHostVersions?: Partial<Record<Agent, string[]>>;
};
type Decoded = { code: number | null; runningSession: string | null; failed: boolean; cancelled: boolean; denied: boolean; truncated: boolean; explicitSuccess: boolean; range: Range | null };
type Handle = { file: FileHandle; identity: string };
const VERSION = { codex: 'codex-rollout/1', 'claude-code': 'claude-transcript/1' };
export const OBSERVATION_VALIDATED_HOSTS: Record<Agent, string[]> = { codex: ['0.162.1'], 'claude-code': ['2.1.212'] };
const SUPPORTED = { codex: ['exec_command:literal-read/search', 'apply_patch:literal', 'exec:literal-AST', 'write_stdin:paired-session'], 'claude-code': ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash:literal-read/search'] };
const leases = new Map<string, { worktreeId: string; bindingId: string; owner: ObservationManager }>();
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_READ = 32 * 1024 * 1024;
function id(value: unknown): string | null { return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value) ? value : null; }
function time(value: unknown): string | null { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null; }
function identity(info: { dev: number | bigint; ino: number | bigint; birthtimeMs: number }): string { return `${info.dev}:${info.ino}:${info.birthtimeMs}`; }
function publicBinding(binding: StoredBinding): ObservationBinding {
  const { active: _a, hostVersion: _h, sessionVerified: _s, cwd: _c, pauseReason: _pa, pending: _p, processes: _pr, polls: _po, seen: _se, ...visible } = binding;
  return structuredClone(visible);
}
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter(item => ['text', 'input_text'].includes(item?.type) && typeof item.text === 'string').map(item => item.text).join('\n');
  return '';
}
function jsonObject(value: unknown): Record<string, any> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value === 'string') { try { const parsed = parseJsonStrict(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, any> : null; } catch {} }
  return null;
}
function decodeResult(value: unknown, tool: string, claude?: { block: any; extra: any }): Decoded {
  const rendered = text(value);
  let object = jsonObject(value);
  if (!object && Array.isArray(value)) {
    const objects = value.filter(item => ['text', 'input_text'].includes(item?.type)).map(item => jsonObject(item.text)).filter(Boolean);
    if (objects.length === 1) object = objects[0];
  }
  const body = object && typeof object.output === 'string' ? object.output : rendered;
  const code = Number.isInteger(object?.exit_code) ? object!.exit_code : Number.isInteger(object?.exitCode) ? object!.exitCode : null;
  const runningSession = object?.session_id != null && code === null ? String(object.session_id) : null;
  const truncated = object?.truncated === true || /(?:output truncated|tokens truncated|truncated output)/i.test(body);
  const cancelled = code === 130 || claude?.extra?.interrupted === true || /^(?:Error: )?(?:cancelled|canceled|interrupted)\b/i.test(body.trim());
  const denied = /(?:permission denied|permission was denied|access is denied|not permitted|user denied|denied permission)/i.test(body);
  let explicitSuccess = code === 0;
  let failed = code !== null && code !== 0;
  let range: Range | null = null;
  if (tool === 'apply_patch' && /^Success\. Updated the following files:/m.test(body)) explicitSuccess = true;
  if (claude) {
    const block = claude.block;
    const extra = claude.extra;
    failed ||= block.is_error === true || cancelled || denied;
    // The transcript's result envelope and matching toolUseResult are the evidence.
    explicitSuccess ||= block.is_error === false || block.is_error === undefined && extra && typeof extra === 'object';
    const file = extra?.file;
    if (Number.isInteger(file?.startLine) && Number.isInteger(file?.numLines) && file.startLine >= 1 && file.numLines > 0) range = { startLine: file.startLine, endLine: file.startLine + file.numLines - 1 };
    else if (tool === 'Read') {
      const numbers = [...body.matchAll(/^\s*(\d+)[→\t]/gm)].map(match => Number(match[1]));
      if (numbers.length && numbers.every((number, i) => i === 0 || number === numbers[i - 1] + 1)) range = { startLine: numbers[0], endLine: numbers.at(-1)! };
    }
  }
  return { code, runningSession, failed, cancelled, denied, truncated, explicitSuccess, range };
}

/** Only independent literal syntax is accepted; shell text is never executed. */
function shell(command: unknown, cwd: string | null): Operation[] {
  if (typeof command !== 'string' || /[\n\r;|&<>`$%]/.test(command) || /\*|\?/.test(command)) return [];
  const tokens: string[] = [];
  let current = '', quote = '', started = false;
  for (const character of command.trim()) {
    if (quote) { if (character === quote) quote = ''; else current += character; started = true; }
    else if (character === '"' || character === "'") { quote = character; started = true; }
    else if (/\s/.test(character)) { if (started) { tokens.push(current); current = ''; started = false; } }
    else { current += character; started = true; }
  }
  if (quote) return [];
  if (started) tokens.push(current);
  const program = tokens.shift()?.toLowerCase();
  if (!program) return [];
  if (['get-content', 'cat', 'type'].includes(program)) {
    if (program === 'type' && !cwd?.match(/^[a-z]:[\\/]/i)) return [];
    let target: string | undefined;
    let range: Range | null = null;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i], lower = token.toLowerCase();
      if (['-raw', '-n', '--number'].includes(lower)) continue;
      if (['-literalpath', '-path'].includes(lower)) { if (target || !tokens[i + 1]) return []; target = tokens[++i]; continue; }
      if (['-totalcount', '-head', '-first'].includes(lower)) { const count = Number(tokens[++i]); if (!Number.isSafeInteger(count) || count < 1) return []; range = { startLine: 1, endLine: count }; continue; }
      if (lower === '-encoding') { if (!['utf8', 'utf-8', 'unicode', 'ascii'].includes(tokens[++i]?.toLowerCase())) return []; continue; }
      if (token.startsWith('-') || target) return [];
      target = token;
    }
    return target ? [{ operation: 'read', tool: 'exec_command', paths: [target], cwd, requestedRange: range, nested: false, directResult: true }] : [];
  }
  if (program !== 'rg') return [];
  let files = false, pattern = false, operands = false;
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!operands && token === '--') { operands = true; continue; }
    if (!operands && token === '--files') { files = true; continue; }
    if (!operands && ['-n', '--line-number', '-i', '--ignore-case', '-l', '--files-with-matches', '-S', '--smart-case', '--hidden', '--no-ignore', '--no-heading', '--count', '-c'].includes(token)) continue;
    if (!operands && token.startsWith('-')) return [];
    if (!files && !pattern) { pattern = true; continue; }
    paths.push(token);
  }
  return files || pattern ? [{ operation: 'search', tool: 'exec_command', paths: paths.length ? paths : ['.'], cwd, requestedRange: null, nested: false, directResult: true, engine: 'rg' }] : [];
}
function patch(value: unknown, cwd: string | null): Operation[] {
  if (typeof value !== 'string' || !value.startsWith('*** Begin Patch') || !value.includes('*** End Patch')) return [];
  const paths = [...value.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map(match => (match[1] ?? match[2]).trim());
  return paths.length ? [{ operation: 'write', tool: 'apply_patch', paths: [...new Set(paths)], cwd, requestedRange: null, nested: false, directResult: true }] : [];
}
function literal(node: ts.Expression): unknown {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isObjectLiteralExpression(node)) {
    const object: Record<string, unknown> = Object.create(null);
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) throw new Error('nonliteral');
      const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
      if (key === null || Object.hasOwn(object, key)) throw new Error('nonliteral');
      object[key] = literal(property.initializer);
    }
    return object;
  }
  throw new Error('nonliteral');
}
/** A poll result is attributable only for the exact single-result wrapper shape. */
function nestedPoll(source: ts.SourceFile): string | null {
  const statements = source.statements.filter(statement => !ts.isEmptyStatement(statement));
  if (statements.length !== 2 || !ts.isVariableStatement(statements[0]) || statements[0].modifiers?.length || !ts.isExpressionStatement(statements[1])) return null;
  const declarations = statements[0].declarationList;
  if (!(declarations.flags & ts.NodeFlags.Const) || declarations.declarations.length !== 1) return null;
  const declaration = declarations.declarations[0];
  if (!ts.isIdentifier(declaration.name) || declaration.type || !declaration.initializer || !ts.isAwaitExpression(declaration.initializer)) return null;
  const call = declaration.initializer.expression;
  if (!ts.isCallExpression(call) || call.questionDotToken || call.typeArguments?.length || call.arguments.length !== 1) return null;
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken || !ts.isIdentifier(callee.expression) || callee.expression.text !== 'tools' || callee.name.text !== 'write_stdin') return null;
  const output = statements[1].expression;
  if (!ts.isCallExpression(output) || output.questionDotToken || output.typeArguments?.length || !ts.isIdentifier(output.expression) || output.expression.text !== 'text' || output.arguments.length !== 1 || !ts.isIdentifier(output.arguments[0]) || output.arguments[0].text !== declaration.name.text) return null;
  try {
    const args = literal(call.arguments[0]);
    if (!args || typeof args !== 'object') return null;
    const object = args as Record<string, unknown>;
    if (Object.keys(object).some(key => !['session_id', 'chars', 'yield_time_ms', 'max_output_tokens'].includes(key))) return null;
    if (Object.hasOwn(object, 'chars') && object.chars !== '') return null;
    for (const key of ['yield_time_ms', 'max_output_tokens']) if (Object.hasOwn(object, key) && (!Number.isSafeInteger(object[key]) || Number(object[key]) < 0)) return null;
    const session = object.session_id;
    if (typeof session === 'number') return Number.isSafeInteger(session) && session > 0 ? String(session) : null;
    return typeof session === 'string' ? id(session) : null;
  } catch { return null; }
}
function nested(code: unknown, fallbackCwd: string | null): { operations: Operation[]; unsupported: number; pollSession: string | null } {
  if (typeof code !== 'string') return { operations: [], unsupported: 1, pollSession: null };
  const source = ts.createSourceFile('observed-tool.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if ((source as any).parseDiagnostics?.length) return { operations: [], unsupported: 1, pollSession: null };
  const pollSession = nestedPoll(source);
  if (pollSession !== null) return { operations: [], unsupported: 0, pollSession };
  // Compound/dynamic poll wrappers cannot borrow a result from a different child.
  let hasPoll = false;
  const findPoll = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'tools' && node.name.text === 'write_stdin') hasPoll = true;
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'tools' && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === 'write_stdin') hasPoll = true;
    ts.forEachChild(node, findPoll);
  };
  findPoll(source);
  if (hasPoll) return { operations: [], unsupported: 1, pollSession: null };
  const operations: Operation[] = [];
  let unsupported = 0;
  let directVariable: string | null = null, printsVariable = false;
  const extract = (expression: ts.Expression, direct: boolean): void => {
    if (ts.isAwaitExpression(expression) || ts.isParenthesizedExpression(expression)) return extract(expression.expression, direct);
    if (!ts.isCallExpression(expression)) return;
    const callee = expression.expression;
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'tools') {
      if (!['exec_command', 'apply_patch'].includes(callee.name.text) || expression.arguments.length !== 1) { unsupported++; return; }
      try {
        const args = literal(expression.arguments[0]);
        const object = args && typeof args === 'object' ? args as Record<string, unknown> : null;
        const cwd = typeof object?.workdir === 'string' ? object.workdir : fallbackCwd;
        const parsed = callee.name.text === 'exec_command' ? shell(object?.cmd, cwd) : patch(typeof args === 'string' ? args : object?.input, cwd);
        if (!parsed.length) unsupported++;
        for (const operation of parsed) operations.push({ ...operation, nested: true, directResult: direct });
      } catch { unsupported++; }
      return;
    }
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'Promise' && ['all', 'allSettled'].includes(callee.name.text) && expression.arguments.length === 1 && ts.isArrayLiteralExpression(expression.arguments[0])) {
      for (const element of expression.arguments[0].elements) if (ts.isExpression(element)) extract(element, false);
      return;
    }
    if (ts.isIdentifier(callee) && callee.text === 'text' && expression.arguments.length === 1) {
      const argument = expression.arguments[0];
      if (ts.isIdentifier(argument) && argument.text === directVariable) printsVariable = true;
      else extract(argument, direct);
    }
  };
  for (const statement of source.statements) {
    if (ts.isExpressionStatement(statement)) extract(statement.expression, true);
    else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) if (declaration.initializer) {
        const before = operations.length;
        extract(declaration.initializer, true);
        if (operations.length === before + 1 && ts.isIdentifier(declaration.name)) directVariable = declaration.name.text;
      }
    } else if (!ts.isEmptyStatement(statement)) unsupported++;
  }
  if (operations.length !== 1 || !printsVariable) for (const operation of operations) operation.directResult = false;
  return { operations, unsupported: unsupported || (operations.length ? 0 : 1), pollSession: null };
}

export class ObservationManager {
  private readonly options: Options;
  private readonly bindings = new Map<string, StoredBinding>();
  private readonly events = new Map<string, ObservationEvent>();
  private readonly handles = new Map<string, Handle>();
  private initialized?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private polling?: Promise<ObservationEvent[]>;
  private closed = false;
  constructor(options: Options) { this.options = options; }
  private now(): string { return this.options.now?.() ?? new Date().toISOString(); }
  private scope(): string { return `observation:${this.options.worktree.id}`; }
  private lease(binding: Pick<StoredBinding, 'agent' | 'sessionId' | 'logFile'>): string { return `${binding.agent}\0${binding.sessionId}\0${process.platform === 'win32' ? binding.logFile.toLowerCase() : binding.logFile}`; }
  ready(): Promise<void> { return this.initialized ??= this.load(); }
  private async load(): Promise<void> {
    await this.options.archive.ready();
    for await (const record of this.options.archive.scanAsync({ kind: 'observation-state' })) {
      const mutation = record.payload as Mutation;
      if (mutation?.kind !== 'observation-state') continue;
      const snapshot = await this.options.archive.readSnapshot<{ binding: StoredBinding; events: ObservationEvent[] }>(mutation.snapshotHash);
      if (snapshot.binding.id !== mutation.binding.id || canonicalJson(snapshot.binding) !== canonicalJson(mutation.binding) || canonicalJson(snapshot.events) !== canonicalJson(mutation.events)) throw new HarnessError('ARCHIVE_CORRUPT', 'Observation journal snapshot does not match its recorded projection.');
      this.bindings.set(snapshot.binding.id, snapshot.binding);
      for (const event of snapshot.events) this.events.set(event.eventId, event);
    }
    for (const binding of this.bindings.values()) if (binding.active) {
      const lease = leases.get(this.lease(binding));
      if (!lease || lease.worktreeId === this.options.worktree.id) leases.set(this.lease(binding), { worktreeId: this.options.worktree.id, bindingId: binding.id, owner: this });
    }
    this.startTimer();
  }
  private startTimer(): void {
    const interval = this.options.pollIntervalMs ?? 250;
    if (!this.closed && interval > 0 && !this.timer) { this.timer = setInterval(() => { void this.poll().catch(() => {}); }, interval); this.timer.unref(); }
  }
  private diagnostic(binding: StoredBinding, code: string, position: Position = { generation: binding.cursor.generation, start: binding.cursor.offset, end: binding.cursor.offset }, recordHash: string | null = null): void {
    const gap = { code, ...position, recordHash };
    if (!binding.coverage.diagnostics.some(item => canonicalJson(item) === canonicalJson(gap))) binding.coverage.diagnostics.push(gap);
  }
  private coverage(binding: StoredBinding): void {
    const events = [...this.events.values()].filter(event => event.bindingId === binding.id);
    binding.coverage.observedResults = events.filter(event => event.resultMatched).length;
    binding.coverage.failedResults = events.filter(event => event.status === 'failed').length;
    binding.coverage.unknownResults = events.filter(event => event.status === 'unknown' || event.status === 'attempted').length;
    const versions = this.options.validatedHostVersions?.[binding.agent] ?? OBSERVATION_VALIDATED_HOSTS[binding.agent];
    binding.coverage.hostVersionVerified = binding.hostVersion !== null && versions.includes(binding.hostVersion);
    if (!binding.active) binding.state = binding.coverage.state = 'stopped';
    else if (binding.state === 'error' || binding.pauseReason) binding.coverage.state = binding.state;
    else if (!binding.sessionVerified || !binding.cwd || !binding.coverage.hostVersionVerified) binding.state = binding.coverage.state = 'unknown';
    else if (binding.coverage.diagnostics.length || binding.coverage.unsupportedRecords || binding.coverage.unknownResults) binding.state = binding.coverage.state = 'partial';
    else binding.state = binding.coverage.state = 'observing';
  }
  private async persist(binding: StoredBinding, events: ObservationEvent[], requestId: string, request: unknown): Promise<void> {
    binding.cursor.lastCommittedSeq = this.options.archive.seq + 1;
    const content = { binding, events };
    const snapshotHash = await this.options.archive.snapshot('observation', content);
    const mutation: Mutation = { kind: 'observation-state', binding, events, snapshotHash };
    await this.options.archive.commit({ scope: this.scope(), requestId, request, payload: mutation, receipt: { bindings: [publicBinding(binding)] }, archives: [{ kind: 'snapshot', hash: snapshotHash }], materializations: [{ path: `checkpoints/${binding.id}.json`, content: { schemaVersion: 1, bindingId: binding.id, cursor: binding.cursor, coverage: binding.coverage } }] });
    this.bindings.set(binding.id, binding);
    for (const event of events) this.events.set(event.eventId, event);
    await this.options.onCommit?.(structuredClone(events));
  }
  async bind(input: BindInput): Promise<Result> {
    await this.ready();
    if (this.closed) throw new HarnessError('IO_ERROR', 'Observation manager is closed.');
    if (!['codex', 'claude-code'].includes(input.agent) || !id(input.sessionId) || !path.isAbsolute(input.logFile) || !uuid.test(input.requestId)) throw new HarnessError('INVALID_ARGUMENT', 'Binding requires a supported agent, declared session, absolute log file and request UUID.');
    // A committed retry does not require today's log file to remain available.
    const request = { operation: 'agent bind', agent: input.agent, sessionId: input.sessionId, logFile: path.resolve(input.logFile), taskId: input.taskId ?? null };
    return this.options.serial(async () => {
      const replay = await this.options.archive.replay<{ bindings: ObservationBinding[] }>(this.scope(), input.requestId, request);
      if (replay) return { ...replay.receipt, replayed: true };
      const logFile = await canonicalPath(input.logFile).catch(() => { throw new HarnessError('IO_ERROR', 'The explicitly requested log path cannot be resolved.'); });
      const source = await open(logFile, 'r');
      const info = await source.stat();
      if (!info.isFile()) { await source.close(); throw new HarnessError('LOG_UNSUPPORTED', 'Only an explicitly bound regular JSONL log is supported.'); }
      const existing = [...this.bindings.values()].find(binding => binding.agent === input.agent && binding.sessionId === input.sessionId && samePath(binding.logFile, logFile));
      const lease = leases.get(this.lease({ agent: input.agent, sessionId: input.sessionId, logFile }));
      if (lease && (lease.worktreeId !== this.options.worktree.id || existing && lease.bindingId !== existing.id)) { await source.close(); throw new HarnessError('TARGET_CONFLICT', 'This session/log is already bound to another worktree.'); }
      if (existing?.active && existing.taskId !== (input.taskId ?? null)) { await source.close(); throw new HarnessError('TARGET_CONFLICT', 'Unbind before changing the task associated with a session.'); }
      const binding: StoredBinding = existing ? structuredClone(existing) : {
        id: randomUUID(), agent: input.agent, sessionId: input.sessionId, logFile, taskId: input.taskId ?? null, state: 'unknown', parserVersion: VERSION[input.agent], createdAt: this.now(), stoppedAt: null, active: true, hostVersion: null, sessionVerified: false, cwd: null, pauseReason: null,
        cursor: { sourceIdentity: identity(info), generation: 0, offset: 0, tailHash: null, anchorHash: null, adapterVersion: VERSION[input.agent], lastCommittedSeq: 0 },
        coverage: { state: 'unknown', supportedTools: SUPPORTED[input.agent], observedResults: 0, unknownResults: 0, failedResults: 0, unsupportedRecords: 0, unrecognizedRecords: 0, hostVersionVerified: false, diagnostics: [], note: 'Only supported explicit tools are observed. Uncollected operations remain unknown; reading does not prove understanding.' }, pending: {}, processes: {}, polls: {}, seen: [],
      };
      binding.active = true; binding.stoppedAt = null; binding.taskId = input.taskId ?? null; binding.pauseReason = null;
      const previous = this.handles.get(binding.id); if (previous) await previous.file.close();
      this.handles.set(binding.id, { file: source, identity: identity(info) });
      try {
        const changed = await this.read(binding, true, true);
        if (!binding.sessionVerified && changed.length === 0 && binding.coverage.unrecognizedRecords) throw new HarnessError('LOG_UNSUPPORTED', 'The explicitly bound file does not contain a recognized transcript format.');
        this.coverageWith(binding, changed);
        await this.persist(binding, changed, input.requestId, request);
        leases.set(this.lease(binding), { worktreeId: this.options.worktree.id, bindingId: binding.id, owner: this });
        this.startTimer();
        return { bindings: [publicBinding(binding)], replayed: false };
      } catch (error) { await source.close().catch(() => {}); this.handles.delete(binding.id); throw error; }
    });
  }
  async unbind(bindingId: string, requestId: string): Promise<Result> {
    await this.ready();
    if (this.closed) throw new HarnessError('IO_ERROR', 'Observation manager is closed.');
    if (!uuid.test(bindingId) || !uuid.test(requestId)) throw new HarnessError('INVALID_ARGUMENT', 'Binding and request IDs must be UUIDs.');
    const request = { operation: 'agent unbind', bindingId };
    return this.options.serial(async () => {
      const replay = await this.options.archive.replay<{ bindings: ObservationBinding[] }>(this.scope(), requestId, request);
      if (replay) return { ...replay.receipt, replayed: true };
      const existing = this.bindings.get(bindingId);
      if (!existing) throw new HarnessError('NOT_FOUND', 'The binding does not belong to this worktree.');
      const binding = structuredClone(existing);
      binding.active = false; binding.stoppedAt ??= this.now(); this.coverage(binding);
      await this.persist(binding, [], requestId, request);
      await this.handles.get(binding.id)?.file.close(); this.handles.delete(binding.id);
      if (leases.get(this.lease(binding))?.owner === this) leases.delete(this.lease(binding));
      return { bindings: [publicBinding(binding)], replayed: false };
    });
  }
  async status(bindingId?: string): Promise<{ bindings: ObservationBinding[]; events: ObservationEvent[] }> {
    await this.ready();
    if (bindingId && !this.bindings.has(bindingId)) throw new HarnessError('NOT_FOUND', 'The binding does not belong to this worktree.');
    return { bindings: [...this.bindings.values()].filter(binding => !bindingId || binding.id === bindingId).map(publicBinding), events: [...this.events.values()].filter(event => !bindingId || event.bindingId === bindingId).map(event => structuredClone(event)) };
  }
  poll(): Promise<ObservationEvent[]> {
    if (this.closed) return Promise.resolve([]);
    return this.polling ??= this.pollAll().finally(() => { this.polling = undefined; });
  }
  private async pollAll(): Promise<ObservationEvent[]> {
    await this.ready();
    return this.options.serial(async () => {
      const all: ObservationEvent[] = [];
      for (const existing of this.bindings.values()) {
        if (!existing.active || existing.pauseReason) continue;
        const binding = structuredClone(existing);
        const before = canonicalJson(binding);
        let changed: ObservationEvent[] = [];
        try { changed = await this.read(binding, false, false); }
        catch (error) {
          binding.state = 'error';
          this.diagnostic(binding, 'LOG_IO_ERROR');
        }
        this.coverageWith(binding, changed);
        if (canonicalJson(binding) !== before || changed.length) {
          await this.persist(binding, changed, randomUUID(), { operation: 'observation poll', bindingId: binding.id, generation: binding.cursor.generation, offset: binding.cursor.offset, tailHash: binding.cursor.tailHash, state: binding.state });
          all.push(...changed);
        }
      }
      return all;
    });
  }
  private coverageWith(binding: StoredBinding, changed: ObservationEvent[]): void {
    const old = new Map<string, ObservationEvent | undefined>();
    for (const event of changed) { old.set(event.eventId, this.events.get(event.eventId)); this.events.set(event.eventId, event); }
    this.coverage(binding);
    for (const [eventId, event] of old) { if (event) this.events.set(eventId, event); else this.events.delete(eventId); }
  }
  private async read(binding: StoredBinding, backfilled: boolean, strict: boolean): Promise<ObservationEvent[]> {
    let handle = this.handles.get(binding.id);
    if (!handle) { const file = await open(binding.logFile, 'r'); const info = await file.stat(); handle = { file, identity: identity(info) }; this.handles.set(binding.id, handle); }
    let pathInfo;
    try { pathInfo = await stat(binding.logFile); }
    catch {
      const drained = await this.consume(binding, handle.file, backfilled, strict);
      binding.state = 'error'; this.diagnostic(binding, 'LOG_PATH_UNAVAILABLE');
      return drained;
    }
    const pathIdentity = identity(pathInfo);
    const changed: ObservationEvent[] = [];
    if (handle.identity !== pathIdentity) {
      // Drain the original opened inode before returning to the explicitly bound path.
      changed.push(...await this.consume(binding, handle.file, backfilled, strict));
      await handle.file.close();
      const file = await open(binding.logFile, 'r'); handle = { file, identity: pathIdentity }; this.handles.set(binding.id, handle);
    }
    const info = await handle.file.stat();
    let reset = binding.cursor.sourceIdentity !== handle.identity || info.size < binding.cursor.offset;
    if (!reset && binding.cursor.offset && binding.cursor.anchorHash) {
      const size = Math.min(binding.cursor.offset, 4096); const bytes = Buffer.alloc(size);
      await handle.file.read(bytes, 0, size, 0);
      reset = sha256(bytes) !== binding.cursor.anchorHash;
    }
    if (reset) {
      this.diagnostic(binding, binding.cursor.sourceIdentity !== handle.identity ? 'LOG_ROTATED' : 'LOG_TRUNCATED');
      binding.cursor = { ...binding.cursor, sourceIdentity: handle.identity, generation: binding.cursor.generation + 1, offset: 0, tailHash: null, anchorHash: null };
      binding.sessionVerified = false; binding.cwd = null; binding.hostVersion = null;
      // New generation must establish its metadata before any events are accepted.
    }
    changed.push(...await this.consume(binding, handle.file, backfilled, strict));
    return changed;
  }
  private async consume(binding: StoredBinding, file: FileHandle, backfilled: boolean, strict: boolean): Promise<ObservationEvent[]> {
    const size = (await file.stat()).size;
    const length = Math.min(Math.max(size - binding.cursor.offset, 0), MAX_READ);
    if (!length) { if (binding.state === 'error') binding.state = 'partial'; return []; }
    const bytes = Buffer.alloc(length);
    const read = await file.read(bytes, 0, length, binding.cursor.offset);
    const data = bytes.subarray(0, read.bytesRead);
    const end = data.lastIndexOf(10) + 1;
    const changed = new Map<string, ObservationEvent>();
    let start = 0;
    let mismatched = false;
    while (start < end) {
      const newline = data.indexOf(10, start);
      const raw = data.subarray(start, newline);
      const position = { generation: binding.cursor.generation, start: binding.cursor.offset + start, end: binding.cursor.offset + newline + 1 };
      const recordHash = sha256(raw);
      let row: any;
      try { row = parseJsonStrict(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
      catch { binding.coverage.unrecognizedRecords++; this.diagnostic(binding, 'INVALID_RECORD', position, recordHash); start = newline + 1; continue; }
      const mismatch = await this.metadata(binding, row);
      if (mismatch) {
        if (strict) throw new HarnessError('TARGET_CONFLICT', 'Log session/cwd metadata conflicts with the declared binding.', { field: mismatch });
        binding.state = 'unknown'; binding.pauseReason = mismatch; mismatched = true; this.diagnostic(binding, mismatch, position, recordHash); break;
      }
      const fingerprint = this.recordKey(binding, row, position, recordHash);
      if (!binding.seen.includes(fingerprint)) {
        const updates = await this.decode(binding, row, position, backfilled, changed);
        for (const event of updates) changed.set(event.eventId, event);
        binding.seen.push(fingerprint);
      }
      start = newline + 1;
    }
    if (!mismatched) binding.cursor.offset += start;
    const tail = data.subarray(start);
    binding.cursor.tailHash = tail.length ? sha256(tail) : null;
    if (binding.cursor.offset) { const count = Math.min(binding.cursor.offset, 4096); const anchor = Buffer.alloc(count); await file.read(anchor, 0, count, 0); binding.cursor.anchorHash = sha256(anchor); }
    if (size - binding.cursor.offset > MAX_READ) this.diagnostic(binding, 'POLL_CHUNK_LIMIT');
    if (binding.state === 'error') binding.state = 'partial';
    return [...changed.values()];
  }
  private recordKey(binding: StoredBinding, row: any, position: Position, recordHash: string): string {
    const payload = row?.payload;
    const stable = id(row.uuid) ?? id(payload?.id);
    const callId = id(payload?.call_id);
    return digest('observation-record', stable ? { stable, type: row.type, payloadType: payload?.type ?? null } : callId ? { callId, type: payload.type, recordHash } : { ...position, recordHash });
  }
  private async metadata(binding: StoredBinding, row: any): Promise<string | null> {
    let session: unknown, cwd: unknown, version: unknown;
    if (binding.agent === 'codex' && row.type === 'session_meta') { session = row.payload?.id ?? row.payload?.session_id; cwd = row.payload?.cwd; version = row.payload?.cli_version; }
    else if (binding.agent === 'claude-code') { session = row.sessionId ?? row.session_id; cwd = row.cwd; version = row.version; }
    if (typeof session === 'string') { if (session !== binding.sessionId) return 'SESSION_MISMATCH'; binding.sessionVerified = true; }
    if (typeof cwd === 'string') {
      const resolved = await this.resolvePath(cwd, null);
      if (resolved.ownership === 'outside-worktree') return 'CWD_MISMATCH';
      if (resolved.ownership === 'matched') binding.cwd = resolved.absolute;
    }
    if (typeof version === 'string' && id(version)) binding.hostVersion = version;
    return null;
  }
  private async resolvePath(input: string, cwd: string | null): Promise<{ display: string; absolute: string | null; validation: string; ownership: ObservationEvent['ownership'] }> {
    if (!input || /[\u0000-\u001f]/.test(input)) return { display: '', absolute: null, validation: 'unresolved-path', ownership: 'unknown' };
    const windows = /^[a-z]:[\\/]/i.test(input) || /^[a-z]:[\\/]/i.test(cwd ?? '');
    if (windows && process.platform !== 'win32' || !windows && input.startsWith('/') && process.platform === 'win32') return { display: (windows ? path.win32 : path.posix).normalize(input), absolute: null, validation: 'unresolved-platform', ownership: 'unknown' };
    if (!path.isAbsolute(input) && !cwd) return { display: input, absolute: null, validation: 'unresolved-cwd', ownership: 'unknown' };
    const absolute = path.resolve(cwd ?? '', input);
    try {
      let validation = 'realpath';
      try { await realpath(absolute); } catch { validation = 'parent-realpath'; }
      const resolved = await canonicalPath(absolute);
      const root = await canonicalPath(this.options.worktree.root);
      const inside = isWithin(root, resolved);
      return { display: inside ? path.relative(root, resolved).replaceAll('\\', '/') || '.' : resolved, absolute: resolved, validation, ownership: inside ? 'matched' : 'outside-worktree' };
    } catch { return { display: absolute, absolute: null, validation: 'unresolved-filesystem', ownership: 'unknown' }; }
  }
  private async createEvent(binding: StoredBinding, row: any, operation: Operation, callId: string, index: number, position: Position, backfilled: boolean): Promise<ObservationEvent> {
    const paths = await Promise.all(operation.paths.map(value => this.resolvePath(value, operation.cwd ?? binding.cwd)));
    const ownership = paths.some(item => item.ownership === 'outside-worktree') ? 'outside-worktree' : paths.every(item => item.ownership === 'matched') ? 'matched' : 'unknown';
    const recordId = id(row.uuid) ?? id(row.payload?.id);
    const eventId = digest('observation-event', { bindingId: binding.id, callId, operation: operation.operation, paths: paths.map(item => item.display), index });
    return { schemaVersion: 1, eventId, projectId: this.options.worktree.projectId, worktreeId: this.options.worktree.id, taskId: ownership === 'matched' ? binding.taskId : null, agent: binding.agent, adapterVersion: binding.parserVersion, declaredHostVersion: null, detectedHostVersion: binding.hostVersion, sessionId: binding.sessionId, bindingId: binding.id, generation: position.generation, byteRange: { start: position.start, end: position.end }, recordId, callId, occurredAt: time(row.timestamp), observedAt: this.now(), backfilled, operation: operation.operation, tool: operation.tool, paths: paths.map(item => item.display), pathValidation: paths.map(item => item.validation), requestedRange: operation.requestedRange, returnedRange: null, status: 'unknown', resultMatched: false, resultRange: null, exitCategory: null, truncated: null, partial: null, contentHash: null, contentHashSource: null, versionStatus: 'unknown', ownership, support: operation.nested && !operation.directResult ? 'nested-unconfirmed' : 'literal-operation', diagnosticIds: [] };
  }
  private async decode(binding: StoredBinding, row: any, position: Position, backfilled: boolean, changed: Map<string, ObservationEvent>): Promise<ObservationEvent[]> {
    const updates: ObservationEvent[] = [];
    const install = async (callId: string, operations: Operation[]) => {
      const eventIds: string[] = [];
      for (let i = 0; i < operations.length; i++) { const event = await this.createEvent(binding, row, operations[i], callId, i, position, backfilled); updates.push(event); eventIds.push(event.eventId); }
      if (operations.length) binding.pending[callId] = { eventIds, nested: operations.some(operation => operation.nested), directResult: operations.length === 1 && operations[0].directResult, engine: operations[0].engine ?? null };
      else { binding.coverage.unsupportedRecords++; this.diagnostic(binding, 'UNSUPPORTED_TOOL', position); }
    };
    const complete = (callId: string, value: unknown, tool?: string, claude?: { block: any; extra: any }) => {
      const originalId = binding.polls[callId] ?? callId;
      const pending = binding.pending[originalId];
      if (!pending) { binding.coverage.unrecognizedRecords++; this.diagnostic(binding, 'UNMATCHED_RESULT', position); return; }
      const decoded = decodeResult(value, tool ?? (changed.get(pending.eventIds[0]) ?? this.events.get(pending.eventIds[0]))?.tool ?? '', claude);
      if (decoded.runningSession) binding.processes[decoded.runningSession] = originalId;
      const verified = binding.hostVersion !== null && (this.options.validatedHostVersions?.[binding.agent] ?? OBSERVATION_VALIDATED_HOSTS[binding.agent]).includes(binding.hostVersion);
      for (const eventId of pending.eventIds) {
        const previous = changed.get(eventId) ?? this.events.get(eventId);
        if (!previous) continue;
        const event = structuredClone(previous);
        event.resultMatched = true; event.resultRange = position; event.truncated = previous.truncated === true || decoded.truncated; event.partial = event.truncated ? true : null;
        event.exitCategory = decoded.cancelled ? 'cancelled' : decoded.denied ? 'permission-denied' : decoded.runningSession ? 'running' : pending.engine === 'rg' && decoded.code === 1 ? 'no-matches' : decoded.code === 0 || decoded.explicitSuccess ? 'zero' : decoded.code !== null ? 'nonzero' : null;
        if (pending.nested && !pending.directResult) event.status = 'unknown';
        else if (decoded.cancelled || decoded.denied || decoded.failed && !(pending.engine === 'rg' && decoded.code === 1)) event.status = 'failed';
        else if (decoded.runningSession || event.truncated || !verified || !binding.sessionVerified || event.ownership === 'unknown') event.status = 'unknown';
        else if (decoded.explicitSuccess || pending.engine === 'rg' && decoded.code === 1) event.status = 'succeeded';
        else event.status = 'unknown';
        if (event.operation === 'read') event.returnedRange = decoded.range;
        updates.push(event);
      }
      if (!decoded.runningSession) { delete binding.pending[originalId]; for (const [session, original] of Object.entries(binding.processes)) if (original === originalId) delete binding.processes[session]; }
      delete binding.polls[callId];
    };
    if (binding.agent === 'codex') {
      if (row.type === 'session_meta' || row.type === 'event_msg' || row.type === 'turn_context') return [];
      if (row.type !== 'response_item') { binding.coverage.unrecognizedRecords++; this.diagnostic(binding, 'UNRECOGNIZED_RECORD', position); return []; }
      const payload = row.payload;
      if (['message', 'reasoning', 'compaction'].includes(payload?.type)) return [];
      const callId = id(payload?.call_id) ?? id(payload?.id) ?? `generation:${position.generation}:${position.start}`;
      if (['function_call', 'custom_tool_call'].includes(payload?.type)) {
        if (payload.namespace != null && payload.namespace !== 'functions') { binding.coverage.unsupportedRecords++; this.diagnostic(binding, 'UNSUPPORTED_TOOL_NAMESPACE', position); return []; }
        const name = String(payload.name ?? '').replace(/^functions\./, '');
        const args = jsonObject(payload.arguments) ?? jsonObject(payload.input);
        if (name === 'write_stdin') {
          const original = args?.session_id != null && binding.processes[String(args.session_id)];
          if (original && (!args?.chars || args.chars === '')) binding.polls[callId] = original;
          else { binding.coverage.unsupportedRecords++; this.diagnostic(binding, 'UNSUPPORTED_SESSION_POLL', position); }
        } else if (name === 'exec_command') await install(callId, shell(args?.cmd, typeof args?.workdir === 'string' ? args.workdir : binding.cwd));
        else if (name === 'apply_patch') await install(callId, patch(payload.input ?? args?.input, binding.cwd));
        else if (name === 'exec') {
          const decoded = nested(payload.input ?? args?.code ?? payload.arguments, binding.cwd);
          if (decoded.unsupported) { binding.coverage.unsupportedRecords += decoded.unsupported; this.diagnostic(binding, 'UNSUPPORTED_EXEC_AST', position); }
          if (decoded.pollSession !== null) {
            const original = Object.hasOwn(binding.processes, decoded.pollSession) ? binding.processes[decoded.pollSession] : undefined;
            if (original) binding.polls[callId] = original;
            else { binding.coverage.unsupportedRecords++; this.diagnostic(binding, 'UNSUPPORTED_SESSION_POLL', position); }
          }
          if (decoded.operations.length) await install(callId, decoded.operations);
        } else { binding.coverage.unsupportedRecords++; this.diagnostic(binding, 'UNSUPPORTED_TOOL', position); }
      } else if (['function_call_output', 'custom_tool_call_output'].includes(payload?.type)) complete(callId, payload.output);
      else { binding.coverage.unrecognizedRecords++; this.diagnostic(binding, 'UNRECOGNIZED_RECORD', position); }
    } else {
      if (['summary', 'system', 'progress', 'file-history-snapshot', 'queue-operation'].includes(row.type)) return [];
      const blocks = row.message?.content;
      if (!Array.isArray(blocks)) return [];
      for (const block of blocks) {
        if (block?.type === 'tool_use') {
          const callId = id(block.id) ?? `generation:${position.generation}:${position.start}`;
          const input = block.input;
          const cwd = typeof input?.cwd === 'string' ? input.cwd : binding.cwd;
          let operations: Operation[] = [];
          if (['Read', 'Edit', 'Write'].includes(block.name) && typeof input?.file_path === 'string') {
            const start = Number.isSafeInteger(input.offset) && input.offset > 0 ? input.offset : 1;
            const range = Number.isSafeInteger(input.limit) && input.limit > 0 ? { startLine: start, endLine: start + input.limit - 1 } : null;
            operations = [{ operation: block.name === 'Read' ? 'read' : 'write', tool: block.name, paths: [input.file_path], cwd, requestedRange: block.name === 'Read' ? range : null, nested: false, directResult: true }];
          } else if (['Grep', 'Glob'].includes(block.name)) operations = [{ operation: 'search', tool: block.name, paths: [typeof input?.path === 'string' ? input.path : '.'], cwd, requestedRange: null, nested: false, directResult: true }];
          else if (block.name === 'Bash') operations = shell(input?.command, cwd).map(operation => ({ ...operation, tool: 'Bash' }));
          await install(callId, operations);
        } else if (block?.type === 'tool_result') complete(id(block.tool_use_id) ?? '', block.content, undefined, { block, extra: row.toolUseResult });
      }
    }
    return updates;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; if (this.timer) clearInterval(this.timer);
    await this.polling?.catch(() => {});
    for (const handle of this.handles.values()) await handle.file.close().catch(() => {});
    this.handles.clear();
    for (const [key, lease] of leases) if (lease.owner === this) leases.delete(key);
  }
}
