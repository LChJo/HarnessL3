import { watch } from 'node:fs'
import { EventEmitter } from 'node:events'

// Derived catalog only: watching never rewrites the editable skill files.
export async function createSkillHub({ root, library, pollInterval = 5000, debounceMs = 120 }) {
  const emitter = new EventEmitter()
  let state = { root: root.replaceAll('\\', '/'), revision: null, skills: [], diagnostics: [], error: null, stale: false, updatedAt: null, checkedAt: null, reason: 'startup' }
  let queue = Promise.resolve(), closed = false, timer, watcher
  function refresh(reason = 'manual') {
    const next = queue.catch(() => {}).then(async () => {
      if (closed) return structuredClone(state)
      const at = new Date().toISOString(), previous = state
      try {
        const catalog = await library.catalog()
        state = { ...catalog, error: null, stale: false, reason, checkedAt: at, updatedAt: previous.revision !== catalog.revision || previous.error ? at : previous.updatedAt ?? at }
      } catch (error) {
        state = { ...previous, skills: [], diagnostics: [], error: error.message, stale: !!previous.revision, reason, checkedAt: at, updatedAt: previous.error !== error.message ? at : previous.updatedAt }
      }
      if (reason === 'manual' || previous.revision !== state.revision || previous.error !== state.error) emitter.emit('change', structuredClone(state))
      return structuredClone(state)
    })
    queue = next
    return next
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { void refresh('watch') }, debounceMs); timer.unref?.() }
  await refresh('startup')
  // Polling is a recovery path for unsupported recursive watch, atomic replacements,
  // missed events and a temporarily missing root. No last-good catalog is called current.
  try { watcher = watch(root, { recursive: true }, schedule); watcher.on('error', () => { watcher.close(); watcher = null; schedule() }); watcher.unref?.() } catch {}
  const poll = setInterval(() => { void refresh('poll') }, pollInterval); poll.unref?.()
  return {
    status: () => structuredClone(state),
    refresh,
    async catalog() {
      const current = await refresh('request')
      if (current.error) throw Object.assign(new Error(current.error), { status: 409 })
      return current
    },
    onChange(listener) { emitter.on('change', listener); return () => emitter.off('change', listener) },
    async close() { closed = true; clearTimeout(timer); clearInterval(poll); watcher?.close(); await queue; emitter.removeAllListeners() },
  }
}
