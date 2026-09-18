import type { MusicRadioSpinDTO } from '@shared/ipc/music.js'
import { RADIO_RECENT_LIMIT } from '@shared/ipc/music.js'
import type { OnethingRadioBrief } from '@onething/runtime/music/radio-store'

/**
 * The station's recent spins, newest first, each marked with what the listener
 * did to it. Only this run's (at ≥ startedAt): the panel reads a record side
 * off it, and last week's songs are not on tonight's record. Loved / skipped are
 * matched by id and must come after the spin started.
 */
export function recentSpins(brief: OnethingRadioBrief): MusicRadioSpinDTO[] {
  const since = brief.active && brief.startedAt ? brief.startedAt : undefined
  const after = (list: typeof brief.played, id: string | undefined, at: string) =>
    id !== undefined && list.some(s => s.encryptedId?.toLowerCase() === id.toLowerCase() && s.at >= at)
  return brief.played
    .filter(spin => since === undefined || spin.at >= since)
    .slice(-RADIO_RECENT_LIMIT)
    .reverse()
    .map(spin => ({
      title: spin.title,
      at: spin.at,
      encryptedId: spin.encryptedId,
      durationS: spin.durationS,
      verdict: after(brief.loved, spin.encryptedId, spin.at) ? 'love' : after(brief.skipped, spin.encryptedId, spin.at) ? 'skip' : undefined,
    }))
}
