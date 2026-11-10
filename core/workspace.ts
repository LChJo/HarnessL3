import { execFile as callbackExecFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { validateContract } from './contract.js';
import { HarnessError } from './errors.js';
import { ensureDir, isErrno, readJson, writeJson } from './io.js';
import { canonicalPath, isWithin, samePath, resolveInside } from './paths.js';
import { seedSkills } from './skills.js';
import { SEED_ROOT } from './package.js';
import type { ProjectConfig, ProjectRecord, WorktreeRecord } from './types.js';

const execFile = promisify(callbackExecFile);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const queues = new Map<string, Promise<unknown>>();

interface RegistryFile {
  schemaVersion: 1;
  projects: ProjectRecord[];
  worktrees: WorktreeRecord[];
}

interface WorkspaceIdentity {
  kind: 'git' | 'directory';
  root: string;
  gitCommonDir: string | null;
  gitDir: string | null;
  branch: string | null;
}

export interface WorkspaceRegistration {
  project: ProjectRecord;
  worktree: WorktreeRecord;
  paths: { config: string };
  createdFiles?: string[];
  skillSeed?: 'created' | 'already-present';
}

export interface WorkspaceTarget {
  cwd: string;
  projectId?: string;
  worktreeId?: string;
  allowInactive?: boolean;
}

function requireUuid(id: string, label: string): void {
  if (!uuidPattern.test(id)) throw new HarnessError('INVALID_ARGUMENT', `${label} must be a lowercase UUID.`, { [label]: id });
}

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (error) { if (isErrno(error, 'ENOENT')) return false; throw error; }
}

const sameCommon = (left: string | null, right: string | null): boolean => left === null || right === null ? left === right : samePath(left, right);
const validCommon = (value: ProjectRecord | WorktreeRecord): boolean => value.kind === 'directory' ? value.gitCommonDir === null : value.kind === 'git' && typeof value.gitCommonDir === 'string' && path.isAbsolute(value.gitCommonDir);
export const DIRECTORY_EXCLUDES = ['**/node_modules', '**/.venv', '**/__pycache__', '**/.cache', '**/dist', '**/build', '**/coverage', '**/target'];

/** The nearest explicit project or repository boundary owns the target. No Git process is needed for plain directories. */
async function workspaceIdentity(location: string): Promise<WorkspaceIdentity> {
  const requested = await canonicalPath(location);
  if (!(await stat(requested)).isDirectory()) throw new HarnessError('INVALID_ARGUMENT', 'The workspace path must be a directory.', { path: location });
  let current = requested;
  while (true) {
    if (await exists(path.join(current, '.git'))) return gitIdentity(current);
    if (await exists(path.join(current, '.harness', 'project.json'))) return { kind: 'directory', root: current, gitCommonDir: null, gitDir: null, branch: null };
    const parent = path.dirname(current);
    if (parent === current) return { kind: 'directory', root: requested, gitCommonDir: null, gitDir: null, branch: null };
    current = parent;
  }
}

async function gitIdentity(location: string): Promise<WorkspaceIdentity> {
  const workingDirectory = await canonicalPath(location);
  try {
    if (!(await stat(workingDirectory)).isDirectory()) throw new Error('Not a directory');
    const environment: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
    // Identity is anchored to -C, never to the invoking agent's Git overrides.
    for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM']) delete environment[key];
    const run = async (...args: string[]) => (await execFile('git', ['-C', workingDirectory, ...args], {
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      env: environment,
    })).stdout.trim();
    // These independent read-only observations share one request-local identity.
    const [insideWorktree, rootPath, commonPath, directoryPath, branch] = await Promise.all([
      run('rev-parse', '--is-inside-work-tree'),
      run('rev-parse', '--show-toplevel'),
      run('rev-parse', '--path-format=absolute', '--git-common-dir'),
      run('rev-parse', '--absolute-git-dir'),
      run('symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => null),
    ]);
    if (insideWorktree !== 'true') throw new Error('Not a Git worktree');
    const [root, gitCommonDir, gitDir] = await Promise.all([canonicalPath(rootPath), canonicalPath(commonPath), canonicalPath(directoryPath)]);
    if (!samePath(root, workingDirectory)) throw new Error('Invalid Git boundary');
    return { kind: 'git', root, gitCommonDir, gitDir, branch };
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError('INVALID_ARGUMENT', 'The Git boundary could not be inspected. Check Git installation and repository integrity; it cannot be used as a plain directory.', { path: location });
  }
}

/** Read the tracked configuration without following metadata outside its worktree. */
export async function readConfig(root: string): Promise<ProjectConfig> {
  const configPath = await resolveInside(root, '.harness/project.json', { noSymlinks: true });
  const config = validateContract<ProjectConfig>('project-config', await readJson(configPath));
  if (!config.name.trim()) throw new HarnessError('SCHEMA_INVALID', 'Project name must contain visible text.');
  for (const pattern of config.source.excludePatterns) {
    if (/(?:^|\/)\.{1,2}(?:\/|$)/.test(pattern) || /[!\[\]{}\u0000-\u001f]/.test(pattern) || pattern.endsWith('/') || pattern.includes('//')) {
      throw new HarnessError('SCHEMA_INVALID', 'Source exclusions use root-anchored posix-glob-v1 patterns.', { pattern });
    }
  }
  return config;
}

/**
 * The registry owns machine bindings only. Every Git command below is a read;
 * neither registration nor cancellation creates, switches or removes worktrees.
 */
export class WorkspaceRegistry {
  readonly dataRoot: string;
  private readonly overrideSkillsRoot?: string;
  private readonly seedRoot: string;

  constructor(dataRoot: string, options: { skillsRoot?: string; seedRoot?: string } = {}) {
    if (!path.isAbsolute(dataRoot)) throw new HarnessError('INVALID_ARGUMENT', 'Data root must be an absolute path.');
    if (options.skillsRoot !== undefined && !path.isAbsolute(options.skillsRoot)) throw new HarnessError('INVALID_ARGUMENT', 'Skills root override must be an absolute path.');
    this.dataRoot = path.resolve(dataRoot);
    this.overrideSkillsRoot = options.skillsRoot ?? (process.env.HARNESS_SKILLS_ROOT || undefined);
    if (this.overrideSkillsRoot !== undefined && !path.isAbsolute(this.overrideSkillsRoot)) throw new HarnessError('INVALID_ARGUMENT', 'HARNESS_SKILLS_ROOT must be an absolute path.');
    this.seedRoot = options.seedRoot ?? SEED_ROOT;
  }

  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    const canonical = await canonicalPath(this.dataRoot);
    const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    const previous = queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    queues.set(key, current);
    try { return await current; } finally { if (queues.get(key) === current) queues.delete(key); }
  }

  private async load(): Promise<RegistryFile> {
    const file = path.join(this.dataRoot, 'registry.json');
    let data: RegistryFile;
    try {
      await resolveInside(this.dataRoot, 'registry.json', { allowMissing: true, noSymlinks: true });
      data = await readJson<RegistryFile>(file);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return { schemaVersion: 1, projects: [], worktrees: [] };
      throw error;
    }
    if (data?.schemaVersion !== 1 || !Array.isArray(data.projects) || !Array.isArray(data.worktrees)) {
      throw new HarnessError('ARCHIVE_CORRUPT', 'The machine registry has an unsupported or invalid shape.', { path: file });
    }
    const projects = new Map<string, ProjectRecord>();
    const roots: string[] = [];
    const ids = new Set<string>();
    for (const project of data.projects) {
      if (project && project.kind === undefined) project.kind = 'git';
      if (!project || !uuidPattern.test(project.id) || projects.has(project.id) || typeof project.active !== 'boolean' || typeof project.name !== 'string' || !validCommon(project) || typeof project.configPath !== 'string' || !path.isAbsolute(project.configPath) || project.gitCommonDir !== null && [...projects.values()].some((item) => sameCommon(item.gitCommonDir, project.gitCommonDir))) {
        throw new HarnessError('ARCHIVE_CORRUPT', 'The machine project registry is invalid.', { path: file });
      }
      projects.set(project.id, project);
    }
    for (const worktree of data.worktrees) {
      if (worktree && worktree.kind === undefined) worktree.kind = 'git';
      if (!worktree || !uuidPattern.test(worktree.id) || ids.has(worktree.id) || !projects.has(worktree.projectId) || typeof worktree.active !== 'boolean' || typeof worktree.available !== 'boolean' || !(worktree.branch === null || typeof worktree.branch === 'string') || !validCommon(worktree) || worktree.kind === 'directory' && worktree.branch !== null || typeof worktree.root !== 'string' || !path.isAbsolute(worktree.root) || roots.some((root) => samePath(root, worktree.root)) || projects.get(worktree.projectId)!.kind !== worktree.kind || !sameCommon(projects.get(worktree.projectId)!.gitCommonDir, worktree.gitCommonDir) || worktree.kind === 'directory' && data.worktrees.some(item => item !== worktree && item.projectId === worktree.projectId)) {
        throw new HarnessError('ARCHIVE_CORRUPT', 'The machine worktree registry is invalid.', { path: file });
      }
      ids.add(worktree.id);
      roots.push(worktree.root);
    }
    return data;
  }

  private async save(data: RegistryFile): Promise<void> {
    await ensureDir(this.dataRoot);
    await resolveInside(this.dataRoot, 'registry.json', { allowMissing: true, noSymlinks: true });
    await writeJson(path.join(this.dataRoot, 'registry.json'), data);
  }

  private async checkDataRoot(root: string, registered: WorktreeRecord[] = []): Promise<void> {
    const dataRoot = await canonicalPath(this.dataRoot);
    for (const candidate of [root, ...registered.map((item) => item.root)]) {
      const actual = await canonicalPath(candidate);
      if (isWithin(actual, dataRoot) || isWithin(dataRoot, actual)) {
        throw new HarnessError('INVALID_ARGUMENT', 'The data root and every registered worktree must be disjoint.', { dataRoot, worktreeRoot: actual });
      }
    }
  }

  private async checkMetadataRoot(root: string): Promise<void> {
    await resolveInside(root, '.harness', { allowMissing: true, noSymlinks: true });
    await resolveInside(root, '.harness/model', { allowMissing: true, noSymlinks: true });
    for (const name of ['project.json', 'evidence.json', 'aliases.json']) {
      await resolveInside(root, `.harness/${name}`, { allowMissing: true, noSymlinks: true });
    }
  }

  private async checkedSkillsRoot(identity: WorkspaceIdentity, config: ProjectConfig, registered: WorktreeRecord[]): Promise<string> {
    const projectConfigured = this.overrideSkillsRoot === undefined && config.skills !== undefined;
    const requested = this.overrideSkillsRoot ?? (config.skills ? path.resolve(identity.root, config.skills.root) : path.join(this.dataRoot, 'skills'));
    const skillsRoot = await canonicalPath(requested);
    if (projectConfigured && !isWithin(identity.root, skillsRoot, false)) {
      throw new HarnessError('INVALID_ARGUMENT', 'Project skills must remain strictly inside the current worktree.', { path: requested });
    }
    const dataRoot = await canonicalPath(this.dataRoot);
    const allowedDataSkills = await canonicalPath(path.join(this.dataRoot, 'skills'));
    if (isWithin(skillsRoot, dataRoot) || (isWithin(dataRoot, skillsRoot) && !isWithin(allowedDataSkills, skillsRoot))) {
      throw new HarnessError('INVALID_ARGUMENT', 'Only the dedicated data-root skills tree can supply user skills.', { path: requested });
    }
    const allRoots = new Set([identity.root, ...registered.map((item) => item.root)]);
    const protectedPaths = new Set([
      identity.gitCommonDir, identity.gitDir, path.join(identity.root, '.git'), path.join(identity.root, '.harness'),
      path.join(dataRoot, 'worktrees'), path.join(dataRoot, 'registry.json'),
      ...registered.map((item) => item.gitCommonDir),
    ]);
    for (const root of allRoots) {
      const actual = await canonicalPath(root);
      if (isWithin(skillsRoot, actual)) throw new HarnessError('INVALID_ARGUMENT', 'A skills root cannot contain or equal a worktree root.', { path: requested, worktreeRoot: actual });
      protectedPaths.add(path.join(actual, '.git'));
      protectedPaths.add(path.join(actual, '.harness'));
    }
    for (const candidate of protectedPaths) {
      if (candidate === null) continue;
      const actual = await canonicalPath(candidate);
      if (isWithin(actual, skillsRoot) || isWithin(skillsRoot, actual)) throw new HarnessError('INVALID_ARGUMENT', 'Skills must not overlap Git metadata or the managed model.', { path: requested, protectedPath: actual });
    }
    return skillsRoot;
  }

  /** The selected root is a source; this method neither scans nor executes skills. */
  async skillsRoot(worktree: WorktreeRecord): Promise<string> {
    const [identity, data] = await Promise.all([workspaceIdentity(worktree.root), this.load()]);
    const config = await readConfig(identity.root);
    if (!samePath(identity.root, worktree.root) || identity.kind !== (worktree.kind ?? 'git') || !sameCommon(identity.gitCommonDir, worktree.gitCommonDir) || config.projectId !== worktree.projectId) {
      throw new HarnessError('WORKTREE_MOVED', 'The worktree no longer matches its registered identity.', { worktreeId: worktree.id });
    }
    return this.checkedSkillsRoot(identity, config, data.worktrees);
  }

  async readConfig(root: string): Promise<ProjectConfig> { return readConfig(root); }

  private async seedSkills(): Promise<'created' | 'already-present'> {
    return seedSkills(this.seedRoot, path.join(this.dataRoot, 'skills'));
  }

  private checkIdentity(data: RegistryFile, identity: WorkspaceIdentity, config: ProjectConfig): void {
    const existing = data.worktrees.find(item => samePath(item.root, identity.root));
    const upgrade = existing?.kind === 'directory' && identity.kind === 'git';
    if (existing && (existing.projectId !== config.projectId || !upgrade && (existing.kind !== identity.kind || !sameCommon(existing.gitCommonDir, identity.gitCommonDir)))) throw new HarnessError('WORKTREE_MOVED', 'The registered path now identifies a different workspace or project.', { worktreeId: existing.id });
    const common = identity.gitCommonDir === null ? undefined : data.projects.find(item => sameCommon(item.gitCommonDir, identity.gitCommonDir));
    if (common && common.id !== config.projectId) throw new HarnessError('PROJECT_ID_CONFLICT', 'This Git common directory belongs to another project.', { projectId: config.projectId });
    const project = data.projects.find(item => item.id === config.projectId);
    if (project && (project.kind === 'directory' ? !existing || existing.projectId !== project.id : identity.kind !== 'git' || !sameCommon(project.gitCommonDir, identity.gitCommonDir))) throw new HarnessError('PROJECT_ID_CONFLICT', 'This project ID belongs to another workspace.', { projectId: config.projectId });
  }

  private async registerIdentity(data: RegistryFile, identity: WorkspaceIdentity, config: ProjectConfig): Promise<WorkspaceRegistration> {
    await this.checkDataRoot(identity.root, data.worktrees);
    await this.checkMetadataRoot(identity.root);
    await this.checkedSkillsRoot(identity, config, data.worktrees);
    const existingRoot = data.worktrees.find((item) => samePath(item.root, identity.root));
    this.checkIdentity(data, identity, config);
    let project = data.projects.find((item) => item.id === config.projectId);
    const configPath = path.join(identity.root, '.harness', 'project.json');
    if (!project) {
      project = { id: config.projectId, name: config.name, kind: identity.kind, gitCommonDir: identity.gitCommonDir, active: true, configPath };
      data.projects.push(project);
    } else {
      project.active = true;
      project.name = config.name;
      project.kind = identity.kind;
      project.gitCommonDir = identity.gitCommonDir;
      // Keep a reachable configuration as the project's navigation hint.
      if (!(await exists(project.configPath))) project.configPath = configPath;
    }
    let worktree = existingRoot;
    if (!worktree) {
      worktree = { id: randomUUID(), projectId: project.id, kind: identity.kind, root: identity.root, gitCommonDir: identity.gitCommonDir, branch: identity.branch, available: true, active: true };
      data.worktrees.push(worktree);
    } else Object.assign(worktree, { kind: identity.kind, gitCommonDir: identity.gitCommonDir, active: true, available: true, branch: identity.branch });
    await this.save(data);
    return { project: { ...project }, worktree: { ...worktree }, paths: { config: configPath } };
  }

  async register(location: string): Promise<WorkspaceRegistration> {
    return this.locked(async () => {
      const data = await this.load();
      const identity = await workspaceIdentity(location);
      await this.checkDataRoot(identity.root, data.worktrees);
      await this.checkMetadataRoot(identity.root);
      return this.registerIdentity(data, identity, await readConfig(identity.root));
    });
  }

  async init(cwd: string, name?: string): Promise<WorkspaceRegistration & { createdFiles: string[]; skillSeed: 'created' | 'already-present' }> {
    if (name !== undefined && !name.trim()) throw new HarnessError('INVALID_ARGUMENT', 'Project name must contain visible text.');
    return this.locked(async () => {
      const data = await this.load();
      const identity = await workspaceIdentity(cwd);
      await this.checkDataRoot(identity.root, data.worktrees);
      await this.checkMetadataRoot(identity.root);
      const configPath = path.join(identity.root, '.harness', 'project.json');
      const commonProject = identity.gitCommonDir === null ? undefined : data.projects.find((item) => sameCommon(item.gitCommonDir, identity.gitCommonDir));
      const config: ProjectConfig = await exists(configPath) ? await readConfig(identity.root) : {
        schemaVersion: 1, projectId: commonProject?.id ?? randomUUID(), name: name ?? commonProject?.name ?? path.basename(identity.root), source: { excludePatterns: identity.kind === 'directory' ? [...DIRECTORY_EXCLUDES] : [] },
      };
      await this.checkedSkillsRoot(identity, config, data.worktrees);
      this.checkIdentity(data, identity, config);
      const createdFiles: string[] = [];
      const create = async (relative: string, contents: string): Promise<void> => {
        const destination = await resolveInside(identity.root, relative, { allowMissing: true, noSymlinks: true });
        await ensureDir(path.dirname(destination));
        try { await writeFile(destination, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); createdFiles.push(relative); } catch (error) { if (!isErrno(error, 'EEXIST')) throw error; }
      };
      await create('.harness/project.json', JSON.stringify(config, null, 2) + '\n');
      await create('.harness/evidence.json', JSON.stringify({ schemaVersion: 1, evidence: [] }, null, 2) + '\n');
      await create('.harness/aliases.json', JSON.stringify({ schemaVersion: 1, aliases: {} }, null, 2) + '\n');
      await mkdir(path.join(identity.root, '.harness', 'model'), { recursive: true });
      const hasModel = async (directory: string): Promise<boolean> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) throw new HarnessError('INVALID_ARGUMENT', 'Model files cannot follow symbolic links.');
          if (entry.isFile() && /\.(?:c4|likec4)$/.test(entry.name)) return true;
          if (entry.isDirectory() && await hasModel(path.join(directory, entry.name))) return true;
        }
        return false;
      };
      if (!(await hasModel(path.join(identity.root, '.harness', 'model')))) {
        const title = JSON.stringify(config.name);
        await create('.harness/model/main.c4', `specification {\n  element system\n}\nmodel {\n  app = system ${title} {\n    metadata {\n      harness_id "${randomUUID()}"\n      brief "Project boundary; update this description from verified sources."\n      source "human"\n      status "unknown"\n      evidence "none"\n      version "1"\n    }\n  }\n}\nviews {\n  view overview { include * }\n}\n`);
      }
      const skillSeed = await this.seedSkills();
      const result = await this.registerIdentity(data, identity, await readConfig(identity.root));
      return { ...result, createdFiles, skillSeed };
    });
  }

  async projects(): Promise<ProjectRecord[]> { return (await this.load()).projects.map((item) => ({ ...item })); }

  async project(id: string): Promise<ProjectRecord> {
    requireUuid(id, 'projectId');
    const result = (await this.load()).projects.find((item) => item.id === id);
    if (!result) throw new HarnessError('NOT_FOUND', 'The project is not registered.', { projectId: id });
    return { ...result };
  }

  private async inspectRecord(record: WorktreeRecord, observedIdentity?: WorkspaceIdentity): Promise<{ record: WorktreeRecord; identity?: WorkspaceIdentity; config?: ProjectConfig }> {
    try {
      const identity = observedIdentity ?? await workspaceIdentity(record.root);
      const config = await readConfig(identity.root);
      if (record.kind === 'directory' && identity.kind === 'git' && samePath(identity.root, record.root) && config.projectId === record.projectId) {
        return await this.locked(async () => {
          const data = await this.load();
          const actual = await workspaceIdentity(record.root);
          const currentConfig = await readConfig(actual.root);
          if (actual.kind !== 'git' || !samePath(actual.root, record.root) || currentConfig.projectId !== record.projectId) throw new HarnessError('WORKTREE_MOVED', 'The workspace identity changed during Git adoption.', { worktreeId: record.id });
          this.checkIdentity(data, actual, currentConfig);
          await this.checkDataRoot(actual.root, data.worktrees);
          await this.checkMetadataRoot(actual.root);
          await this.checkedSkillsRoot(actual, currentConfig, data.worktrees);
          const current = data.worktrees.find(item => item.id === record.id)!;
          const project = data.projects.find(item => item.id === current.projectId)!;
          Object.assign(current, { kind: actual.kind, gitCommonDir: actual.gitCommonDir, branch: actual.branch });
          Object.assign(project, { kind: actual.kind, gitCommonDir: actual.gitCommonDir });
          await this.save(data);
          return { record: { ...current, available: true }, identity: actual, config: currentConfig };
        });
      }
      const available = samePath(identity.root, record.root) && identity.kind === record.kind && sameCommon(identity.gitCommonDir, record.gitCommonDir) && config.projectId === record.projectId;
      return { record: { ...record, branch: available ? identity.branch : record.branch, available }, identity, config };
    } catch { return { record: { ...record, available: false } }; }
  }

  private async liveRecord(record: WorktreeRecord): Promise<WorktreeRecord> {
    return (await this.inspectRecord(record)).record;
  }

  async worktrees(projectId?: string): Promise<WorktreeRecord[]> {
    if (projectId !== undefined) await this.project(projectId);
    return Promise.all((await this.load()).worktrees.filter((item) => projectId === undefined || item.projectId === projectId).map((item) => this.liveRecord(item)));
  }

  async worktree(id: string): Promise<WorktreeRecord> {
    requireUuid(id, 'worktreeId');
    const result = (await this.load()).worktrees.find((item) => item.id === id);
    if (!result) throw new HarnessError('NOT_FOUND', 'The worktree is not registered.', { worktreeId: id });
    return this.liveRecord(result);
  }

  async unregisterProject(id: string): Promise<{ unregisteredIds: string[]; archivesRetained: true }> {
    requireUuid(id, 'projectId');
    return this.locked(async () => {
      const data = await this.load();
      const project = data.projects.find((item) => item.id === id);
      if (!project) throw new HarnessError('NOT_FOUND', 'The project is not registered.', { projectId: id });
      project.active = false;
      const worktrees = data.worktrees.filter((item) => item.projectId === id);
      for (const worktree of worktrees) worktree.active = false;
      await this.save(data);
      return { unregisteredIds: [id, ...worktrees.map((item) => item.id)], archivesRetained: true };
    });
  }

  async unregisterWorktree(id: string): Promise<{ unregisteredIds: string[]; archivesRetained: true }> {
    requireUuid(id, 'worktreeId');
    return this.locked(async () => {
      const data = await this.load();
      const record = data.worktrees.find((item) => item.id === id);
      if (!record) throw new HarnessError('NOT_FOUND', 'The worktree is not registered.', { worktreeId: id });
      record.active = false;
      await this.save(data);
      return { unregisteredIds: [id], archivesRetained: true };
    });
  }

  async resolve(options: WorkspaceTarget): Promise<WorktreeRecord> {
    if (options.projectId !== undefined) requireUuid(options.projectId, 'projectId');
    if (options.worktreeId !== undefined) requireUuid(options.worktreeId, 'worktreeId');
    const data = await this.load();
    const explicitProject = options.projectId === undefined ? undefined : data.projects.find((item) => item.id === options.projectId);
    if (options.projectId !== undefined && !explicitProject) throw new HarnessError('NOT_FOUND', 'The project is not registered.', { projectId: options.projectId });
    const explicitWorktree = options.worktreeId === undefined ? undefined : data.worktrees.find((item) => item.id === options.worktreeId);
    if (options.worktreeId !== undefined && !explicitWorktree) throw new HarnessError('NOT_FOUND', 'The worktree is not registered.', { worktreeId: options.worktreeId });
    if (explicitProject && explicitWorktree && explicitWorktree.projectId !== explicitProject.id) throw new HarnessError('TARGET_CONFLICT', 'Explicit project and worktree do not have the same ownership.');
    if (explicitProject && !explicitWorktree && data.worktrees.filter((item) => item.projectId === explicitProject.id && item.active).length > 1) {
      throw new HarnessError('TARGET_REQUIRED', 'This project has multiple active worktrees; specify --worktree.');
    }
    const cwd = await canonicalPath(options.cwd);
    // Match the Git root, rather than a directory prefix, so nested unregistered
    // repositories cannot silently borrow an outer registered target.
    let cwdIdentity: WorkspaceIdentity | undefined;
    try { cwdIdentity = await workspaceIdentity(cwd); }
    catch (error) { if (!(options.allowInactive && explicitWorktree)) throw error; }
    const cwdRecord = cwdIdentity ? data.worktrees.find((item) => samePath(item.root, cwdIdentity!.root)) : undefined;
    if (cwdRecord && (explicitWorktree && explicitWorktree.id !== cwdRecord.id || explicitProject && explicitProject.id !== cwdRecord.projectId)) {
      throw new HarnessError('TARGET_CONFLICT', 'The explicit target conflicts with the registered current worktree.', { cwdWorktreeId: cwdRecord.id });
    }
    if (!cwdRecord && !explicitWorktree) {
      if (cwdIdentity && !options.projectId) {
        const dataRoot = await canonicalPath(this.dataRoot);
        if (isWithin(cwdIdentity.root, dataRoot) || isWithin(dataRoot, cwdIdentity.root)) throw new HarnessError('TARGET_REQUIRED', 'Choose a workspace disjoint from the machine data root.', { dataRoot, worktreeRoot: cwdIdentity.root });
        const configured = await exists(path.join(cwdIdentity.root, '.harness', 'project.json'));
        throw new HarnessError('TARGET_REQUIRED', 'HarnessL3 setup needs user confirmation. Ask the onboarding.question in the agent question UI before proceeding; continue without L3 only if the user declines or cancels.', {
          onboarding: {
            state: configured ? 'registration-required' : 'initialization-required',
            worktreeRoot: cwdIdentity.root,
            confirmationRequired: true,
            nextAction: 'ask-user',
            question: configured
              ? `Register this workspace with HarnessL3 at ${cwdIdentity.root}? This preserves its existing configuration and model.`
              : `Initialize HarnessL3 in this workspace at ${cwdIdentity.root}? This creates missing .harness configuration, model, evidence and alias files, registers the worktree, and creates the user skill library only if it is missing; existing content is preserved.`,
            command: configured ? ['worktree', 'register', cwdIdentity.root] : ['init'],
            fallback: 'continue-without-l3',
            fallbackWhen: ['declined', 'cancelled'],
          },
        });
      }
      throw new HarnessError('TARGET_REQUIRED', 'Specify a worktree UUID when running outside a registered worktree.');
    }
    const selected = explicitWorktree ?? cwdRecord;
    if (!selected) throw new HarnessError('TARGET_REQUIRED', 'A worktree target is required.');
    if (cwdIdentity && !samePath(cwdIdentity.root, selected.root) && isWithin(selected.root, cwdIdentity.root, false)) throw new HarnessError('TARGET_CONFLICT', 'A nested project/repository cannot use its outer workspace as the target.', { worktreeRoot: cwdIdentity.root, selectedRoot: selected.root });
    const project = data.projects.find((item) => item.id === selected.projectId)!;
    if ((!selected.active || !project.active) && !(options.allowInactive && explicitWorktree)) {
      throw new HarnessError('TARGET_CONFLICT', 'This target is inactive; register it again before starting active operations.', { worktreeId: selected.id });
    }
    // Explicit archive-only reads retain their original binding even if today's
    // configuration disappears. Callers must not use this for current content.
    const observed = cwdIdentity && samePath(cwdIdentity.root, selected.root) ? cwdIdentity : undefined;
    const inspected = await this.inspectRecord(selected, observed);
    const current = inspected.record;
    if (options.allowInactive && explicitWorktree) return current;
    if (!current.available) throw new HarnessError('WORKTREE_MOVED', 'The registered worktree is missing or no longer matches its stored Git/project identity.', { worktreeId: selected.id });
    await this.checkDataRoot(current.root, data.worktrees);
    await this.checkMetadataRoot(current.root);
    await this.checkedSkillsRoot(inspected.identity!, inspected.config!, data.worktrees);
    return current;
  }
}
