import { watch, type FSWatcher } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { canonicalPath } from './paths.js'
import { scanSkills } from './skills.js'
import type { SkillCatalog } from './types.js'

/** A browsing projection only. Task selection still captures current skill bytes independently. */
export class CatalogObserver {
  private readonly entries = new Map<string, { watcher?: FSWatcher; revision: number; scanned: number; checked: number; value?: SkillCatalog; pending?: Promise<SkillCatalog> }>()
  async read(inputRoot: string, force = false): Promise<SkillCatalog> {
    const root = await canonicalPath(inputRoot)
    let entry = this.entries.get(root)
    if (!entry) {
      entry = { revision: 0, scanned: -1, checked: 0 }
      this.entries.set(root, entry)
      const captured = entry
      try {
        captured.watcher = watch(root, { recursive: true, persistent: false }, () => { captured.revision++ })
        captured.watcher.on('error', () => { captured.revision++; captured.watcher?.close(); captured.watcher = undefined })
      } catch { /* Without watch coverage every directory request scans again. */ }
    }
    if (entry.pending) {
      const value = await entry.pending
      return force ? this.read(inputRoot, true) : value
    }
    if (!force && entry.watcher && entry.value && entry.scanned === entry.revision && performance.now() - entry.checked < 60_000) return entry.value
    const generation = entry.revision
    const captured = entry
    captured.pending = scanSkills(root).then(value => {
      captured.value = { ...value, files: new Map() }; captured.scanned = generation; captured.checked = performance.now()
      return value
    }).finally(() => { captured.pending = undefined })
    return captured.pending
  }
  async close(): Promise<void> {
    for (const entry of this.entries.values()) entry.watcher?.close()
    await Promise.allSettled([...this.entries.values()].flatMap(entry => entry.pending ? [entry.pending] : []))
    this.entries.clear()
  }
}
