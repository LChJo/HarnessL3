import { canonicalJson } from './json.js';
import { HarnessError } from './errors.js';
import type { Binding, ContextBody, Evidence, Packet, SkillBrief, TaskBatch, TaskRecord } from './types.js';

const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const changes = new Set(['binding', 'catalog', 'updatedAt', 'lastReadAt', 'retentionBasisAt', 'expiresAt', 'closedAt', 'skillPlan']);
const hash = /^[0-9a-f]{64}$/;
type FullBatch = TaskBatch & { binding?: Binding; catalog?: SkillBrief[] };
type ArrayPatch<T> = { upsert: T[]; remove: string[]; order?: string[] };
interface PacketPatch { contexts?: ArrayPatch<ContextBody>; evidence?: ArrayPatch<Evidence> }
interface CompactBatch { value: Omit<FullBatch, 'packet'>; inheritBinding: boolean; inheritCatalog: boolean; inheritSkillPlan: boolean }
export interface TaskDelta { id: string; encoding: 'task-delta/1'; baseSeq: number; baseHash: string; set: Record<string, unknown>; packet: PacketPatch; append: CompactBatch | null }

const invalid = (message: string): never => { throw new HarnessError('ARCHIVE_CORRUPT', message); };
const contextId = (body: ContextBody) => body.entity.id;
const evidenceId = (proof: Evidence) => proof.id;

function diffArray<T>(before: T[], after: T[], key: (item: T) => string): ArrayPatch<T> | undefined {
  const old = new Map(before.map(item => [key(item), item])), next = new Map(after.map(item => [key(item), item]));
  if (old.size !== before.length || next.size !== after.length) invalid('A task packet contains duplicate identities.');
  const remove = [...old.keys()].filter(id => !next.has(id));
  const upsert = after.filter(item => !old.has(key(item)) || !equal(old.get(key(item)), item));
  const inferred = [...old.keys()].filter(id => next.has(id)).concat([...next.keys()].filter(id => !old.has(id)));
  const order = equal(inferred, [...next.keys()]) ? undefined : [...next.keys()];
  if (!remove.length && !upsert.length && !order) return undefined;
  return { upsert, remove, ...(order ? { order } : {}) };
}
function patchArray<T>(before: T[], patch: ArrayPatch<T> | undefined, key: (item: T) => string): T[] {
  if (patch === undefined) return before;
  if (!patch || !Array.isArray(patch.upsert) || !Array.isArray(patch.remove) || (patch.order !== undefined && !Array.isArray(patch.order))) invalid('Invalid task packet delta.');
  const values = new Map(before.map(item => [key(item), item]));
  if (new Set(patch.remove).size !== patch.remove.length || new Set(patch.upsert.map(key)).size !== patch.upsert.length) invalid('Duplicate task packet delta identities.');
  for (const id of patch.remove) if (!values.delete(id)) invalid('Task delta removes an unknown packet identity.');
  for (const item of patch.upsert) values.set(key(item), item);
  const order = patch.order ?? [...values.keys()];
  if (order.length !== values.size || new Set(order).size !== values.size || order.some(id => !values.has(id))) invalid('Task delta packet ordering does not cover its complete identities.');
  return order.map(id => values.get(id)!);
}

export function isTaskDelta(value: unknown): value is TaskDelta { return !!value && typeof value === 'object' && (value as TaskDelta).encoding === 'task-delta/1'; }

/** Only the new operation and altered packet identities are stored. Original
 * migrated full records stay byte-identical; their next commit may be a delta. */
export function encodeTaskDelta(before: TaskRecord, after: TaskRecord, baseSeq: number, baseHash: string): TaskDelta {
  if (before.id !== after.id || !Number.isSafeInteger(baseSeq) || baseSeq < 1 || !hash.test(baseHash)) invalid('Invalid task delta base.');
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) {
    if (key === 'packet' || key === 'batches') continue;
    const previous = (before as unknown as Record<string, unknown>)[key];
    if (equal(previous, value)) continue;
    if (!changes.has(key)) invalid(`An immutable task field changed: ${key}`);
    set[key] = value;
  }
  const packet: PacketPatch = {};
  const contexts = diffArray(before.packet.contexts, after.packet.contexts, contextId), evidence = diffArray(before.packet.evidence, after.packet.evidence, evidenceId);
  if (contexts) packet.contexts = contexts; if (evidence) packet.evidence = evidence;
  const suffix = after.batches.slice(before.batches.length);
  if (after.batches.length < before.batches.length || suffix.length > 1 || !equal(before.batches, after.batches.slice(0, before.batches.length))) invalid('A task operation rewrote existing batches instead of appending.');
  let append: CompactBatch | null = null;
  if (suffix.length) {
    const batch = suffix[0] as FullBatch;
    if (!equal(batch.packet, after.packet)) invalid('The appended batch packet differs from the emitted task packet.');
    const { packet: _packet, ...value } = batch;
    const inheritBinding = value.binding !== undefined && equal(value.binding, after.binding);
    const inheritCatalog = value.catalog !== undefined && equal(value.catalog, after.catalog);
    const inheritSkillPlan = equal(value.skillPlan, after.skillPlan);
    if (inheritBinding) delete value.binding;
    if (inheritCatalog) delete value.catalog;
    if (inheritSkillPlan) delete (value as Partial<FullBatch>).skillPlan;
    append = { value, inheritBinding, inheritCatalog, inheritSkillPlan };
  }
  const delta: TaskDelta = { id: after.id, encoding: 'task-delta/1', baseSeq, baseHash, set, packet, append };
  if (!equal(applyTaskDelta(before, delta), after)) invalid('Task delta did not reproduce the exact original task state.');
  return delta;
}

export function applyTaskDelta(before: TaskRecord, delta: TaskDelta): TaskRecord {
  if (!isTaskDelta(delta) || delta.id !== before.id || !delta.set || typeof delta.set !== 'object' || Array.isArray(delta.set) || Object.keys(delta.set).some(key => !changes.has(key)) || !delta.packet || typeof delta.packet !== 'object' || Object.keys(delta.packet).some(key => !['contexts', 'evidence'].includes(key))) invalid('Invalid task delta shape or identity.');
  const task = structuredClone(before);
  Object.assign(task, structuredClone(delta.set));
  const packet: Packet = { scope: 'returned-entities-only', contexts: patchArray(task.packet.contexts, delta.packet.contexts, contextId), evidence: patchArray(task.packet.evidence, delta.packet.evidence, evidenceId) };
  task.packet = packet;
  if (delta.append !== null) {
    const compact = delta.append;
    if (!compact || typeof compact.value !== 'object' || !compact.value || 'packet' in compact.value || typeof compact.inheritBinding !== 'boolean' || typeof compact.inheritCatalog !== 'boolean' || typeof compact.inheritSkillPlan !== 'boolean') invalid('Invalid compact batch delta.');
    const batch = { ...structuredClone(compact.value), packet: structuredClone(packet), ...(compact.inheritBinding ? { binding: structuredClone(task.binding) } : {}), ...(compact.inheritCatalog ? { catalog: structuredClone(task.catalog) } : {}), ...(compact.inheritSkillPlan ? { skillPlan: structuredClone(task.skillPlan) } : {}) } as FullBatch;
    task.batches.push(batch);
  }
  return task;
}
