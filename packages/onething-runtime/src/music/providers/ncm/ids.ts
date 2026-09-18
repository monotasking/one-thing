/**
 * NetEase's dual-id model. `encryptedId` (32-hex) is what playback commands
 * want; `originalId` (numeric) rides along because `play` requires the pair.
 * These validators are the reason a hallucinated id cannot reach the player:
 * the DJ copies ids out of search results, and anything that does not look
 * like a real pair is dropped at the store boundary.
 */

import type { OnethingRadioProgrammeEntry } from '../../radio-store.js'
import type { MusicIdSchema } from '../types.js'

const ENCRYPTED_ID = /^[0-9a-fA-F]{32}$/

/**
 * A programme entry's length. The DJ copies ncm's search `duration` verbatim —
 * milliseconds; an entry built in code may carry `durationS` already. Anything
 * outside 5s–2h is dropped rather than trusted.
 */
function entrySeconds(record: Record<string, unknown>): number | undefined {
  const raw =
    typeof record.durationS === 'number'
      ? record.durationS
      : typeof record.duration === 'number'
        ? record.duration / 1000
        : undefined
  if (raw === undefined || !Number.isFinite(raw)) return undefined
  const s = Math.round(raw)
  return s >= 5 && s <= 7200 ? s : undefined
}

export const ncmIdSchema: MusicIdSchema = {
  normalizeEntry(record: Record<string, unknown>): OnethingRadioProgrammeEntry | null {
    const encryptedId = typeof record.encryptedId === 'string' ? record.encryptedId.trim() : ''
    // The DJ copies originalId out of search results, where it is a number.
    const originalId =
      typeof record.originalId === 'string'
        ? record.originalId.trim()
        : typeof record.originalId === 'number'
          ? String(record.originalId)
          : ''
    // Both ids or the entry is unplayable — the player needs the pair.
    if (!ENCRYPTED_ID.test(encryptedId) || !/^\d+$/.test(originalId)) return null
    return {
      encryptedId,
      originalId,
      title: typeof record.title === 'string' && record.title ? record.title : '未知曲目',
      note: typeof record.note === 'string' && record.note ? record.note : undefined,
      say: typeof record.say === 'string' && record.say.trim() ? record.say.trim() : undefined,
      playFlag: typeof record.playFlag === 'boolean' ? record.playFlag : undefined,
      durationS: entrySeconds(record),
    }
  },
  validateSpinId(id: string): boolean {
    return ENCRYPTED_ID.test(id)
  },
}
