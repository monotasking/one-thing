/**
 * The music CLI provider contract.
 *
 * Everything NetEase-specific used to leak out of the driver into every layer
 * (argv strings in the host, wire-shape parsers in the runtime, socket paths
 * in the service, subcommand whitelists in the bash classifier, command prose
 * in the DJ persona). A provider gathers those per-CLI facts into one module
 * so the radio — conductor, store, patter timing, all of it provider-neutral
 * by construction — can drive a different music CLI without being edited.
 *
 * A provider is CODE, not data: half of what it owns is parsers and prose.
 * The one serializable slice (`MusicProviderDescriptor`) crosses IPC to drive
 * the settings wizard generically.
 */

import type { OnethingMusicLyricLine } from '../lyrics.js'
import type { OnethingMusicNowPlaying } from '../now-playing.js'
import type { OnethingRadioProgrammeEntry } from '../radio-store.js'
import type {
  OnethingMusicBackend,
  OnethingMusicProcessRunner,
  OnethingMusicSetupStage,
} from '../types.js'

// ----------------------------------------------------------------------------
// Serializable descriptor (drives the settings wizard over IPC)
// ----------------------------------------------------------------------------

export interface MusicProviderToolSpec {
  /** e.g. 'ncm-cli', 'mpv' — keys OnethingMusicEnvStatus.tools. */
  id: string
  label: string
  /** Install argv per channel; the host picks whichever is available. */
  install: { npm?: string[]; brew?: string[] }
  /**
   * Only a prerequisite while this player backend is chosen (ncm: mpv is
   * irrelevant under orpheus). Absent = always required.
   */
  requiredWhenPlayerBackend?: string
}

export interface MusicProviderCredentialField {
  key: string
  label: string
  /** Rendered masked; delivered to the backend off argv. */
  secret: boolean
  placeholder?: string
  helpUrl?: string
}

export type MusicProviderLoginKind = 'qr-stdout' | 'oauth-url' | 'token-paste' | 'none'

export interface MusicProviderDescriptor {
  id: string
  /** Settings-facing name, e.g. '网易云音乐 (ncm-cli)'. */
  label: string
  /** The CLI binary — also the bash-policy match key. */
  binary: string
  tools: MusicProviderToolSpec[]
  setupStages: OnethingMusicSetupStage[]
  credentialFields: MusicProviderCredentialField[]
  loginKind: MusicProviderLoginKind
  /** Provider-private playback sub-modes (ncm: mpv/orpheus). */
  playerBackends?: Array<{ id: string; label: string }>
}

// ----------------------------------------------------------------------------
// CLI profile: command builders + wire-shape parsers (they travel together)
// ----------------------------------------------------------------------------

/** A search hit normalized to what the radio needs; ids are machine keys. */
export interface MusicSearchRecord {
  /** The id the play/like/lyric commands want (ncm: encryptedId). */
  primaryId: string
  /** A second machine id when the CLI has one (ncm: originalId). */
  altId?: string
  title: string
  artist?: string
  playFlag?: boolean
  /** Track length in seconds, when the catalogue says (ncm: `duration`, in ms). */
  durationS?: number
}

export interface MusicCliEnvelope {
  /** false = the CLI refused (possibly with exit 0); message carries its words. */
  ok: boolean
  message?: string
}

export interface MusicCliProfile {
  build: {
    state(): string[]
    start(entry: OnethingRadioProgrammeEntry): { args: string[]; env?: Record<string, string> }
    stop(): string[]
    pause(): string[]
    resume(): string[]
    seek(seconds: number): string[]
    like(entry: OnethingRadioProgrammeEntry): string[]
    lyric(entry: OnethingRadioProgrammeEntry): string[]
    search(query: string, limit: number): string[]
    loginCheck(): string[]
  }
  parse: {
    envelope(stdout: string): MusicCliEnvelope
    nowPlaying(stdout: string): OnethingMusicNowPlaying | null
    searchRecords(stdout: string): MusicSearchRecord[]
    lyric(stdout: string): OnethingMusicLyricLine[]
  }
}

// ----------------------------------------------------------------------------
// Id schema, reliability profile, bash policy, prose
// ----------------------------------------------------------------------------

export interface MusicIdSchema {
  /**
   * Validate + fill a raw programme entry; null = unplayable garbage, drop.
   * ncm: 32-hex encryptedId AND numeric originalId. A single-id CLI mirrors
   * its primary id into both fields — the store's field names are frozen to
   * avoid a data migration.
   */
  normalizeEntry(raw: Record<string, unknown>): OnethingRadioProgrammeEntry | null
  /** Spin-history id validation (brief.played[].encryptedId). */
  validateSpinId(id: string): boolean
}

export interface MusicReliabilityProfile {
  /**
   * '~'-prefixed paths the HOST expands and stats. playerSocket's existence
   * means "a player session is up" (cheap poll gate); absent = probe via
   * `state` itself.
   */
  probePaths?: { playerSocket?: string; volumePrefs?: string }
  /** 'prefs-file' when `state` cannot report volume (ncm reports null). */
  volumeSource: 'state' | 'prefs-file'
}


export interface MusicProseBundle {
  /** resources/skills/<dir> exposed only while this provider is active. */
  skillDirName: string
  /** Markdown fragment: the CLI command cheatsheet for the DJ persona/skill. */
  cliCheatsheet: string
}

// ----------------------------------------------------------------------------
// The provider
// ----------------------------------------------------------------------------

export interface MusicProviderBackendDeps {
  runner: OnethingMusicProcessRunner
  /** Host capability: secrets ride private temp files, never argv. */
  writeSecretFile(content: string): Promise<{ path: string; dispose(): Promise<void> }>
  logger?: { warn(message: string, ...args: unknown[]): void }
}

export interface MusicProvider {
  descriptor: MusicProviderDescriptor
  createBackend(deps: MusicProviderBackendDeps): OnethingMusicBackend
  cli: MusicCliProfile
  ids: MusicIdSchema
  reliability: MusicReliabilityProfile
  bashPolicy: {
    /** Matched against the parsed command head (basename tolerated by caller). */
    binary: string
    /** '<group>' or '<group> <sub>' keys; longest match wins. */
    autoAllow: ReadonlySet<string>
    /** Extra read-only probes outside the subcommand table (--version, config get …). */
    extraAllow?(args: string[]): boolean
    /** Why a non-whitelisted subcommand asks — shown in the permission prompt. */
    askReason(groupOrPair: string): string
  }
  prose: MusicProseBundle
}
