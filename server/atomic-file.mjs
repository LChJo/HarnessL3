import { rename } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'

// Preserve atomic replacement; a transient reader/scanner lock must not force truncating the destination.
export async function replaceFile(temp, target) {
  for (let attempt = 0; ; attempt++) {
    try { await rename(temp, target); return }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 6) throw error
      await setTimeout(15 * 2 ** attempt)
    }
  }
}
