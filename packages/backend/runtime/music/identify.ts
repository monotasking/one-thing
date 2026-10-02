/**
 * Reverse-identifying an already-playing song, and the silent-start
 * post-mortem — both generic over the provider's normalized search records
 * (the provider's `cli.parse.searchRecords` owns the wire shape).
 *
 * Songs the radio starts are known by construction (onDeck). Songs started by
 * anyone else (the model's manual play, per the skill's single-song lane)
 * reach us only as the player's title string — no id, so no lyrics, no heart.
 * The player's title format is stable machine output (`name - artistName`),
 * so an exact match against a search record is a safe way to recover the id:
 * exact or nothing, because captioning the wrong song is worse than no
 * caption.
 */

import type { MusicSearchRecord } from './providers/types.js'

export interface OnethingMusicIdentifiedSong {
  encryptedId: string
  originalId: string
}

/**
 * Find the record whose `title - artist` EXACTLY equals the player's title.
 * Returns null on any ambiguity — the caller simply shows no lyrics.
 */
export function matchSongFromSearch(
  records: MusicSearchRecord[],
  playerTitle: string,
): OnethingMusicIdentifiedSong | null {
  for (const record of records) {
    if (!record.title || !record.artist) continue
    if (`${record.title} - ${record.artist}` !== playerTitle) continue
    if (!record.primaryId) continue
    return { encryptedId: record.primaryId, originalId: record.altId ?? record.primaryId }
  }
  return null
}

/**
 * The song's playFlag, looked up by its machine ids. Post-mortem for a silent
 * start: `play` on a rights-restricted song exits 0 with no output and no
 * sound (measured 2026-07-17), so the only way to name the true cause is to
 * search again and read the flag. Either id counts — a curated entry may be
 * an album variant that ranks low for its own title (琵琶语's chosen version
 * was absent from the top five), and the alt id doubles the chance of finding
 * the exact record. null = not found / no flag — the caller falls back to the
 * generic verdict.
 */
export function songPlayFlagFromSearch(
  records: MusicSearchRecord[],
  ids: { encryptedId: string; originalId?: string },
): boolean | null {
  const wantedPrimary = ids.encryptedId.toLowerCase()
  const wantedAlt = ids.originalId?.trim()
  for (const record of records) {
    const primaryMatch = record.primaryId.toLowerCase() === wantedPrimary
    const altMatch =
      wantedAlt !== undefined && wantedAlt !== '' && record.altId !== undefined && record.altId === wantedAlt
    if (!primaryMatch && !altMatch) continue
    return typeof record.playFlag === 'boolean' ? record.playFlag : null
  }
  return null
}
