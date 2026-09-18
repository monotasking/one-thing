/**
 * The ncm-cli (网易云音乐) provider — the founding member of the registry, and
 * the reference for what a provider owns. Every NetEase-specific fact that
 * used to be hardcoded across layers converges here:
 *
 *  - argv vocabulary (play --song --encrypted-id …, song lyric --songId …)
 *  - wire-shape parsing (state JSON, search data.records, LRC lyrics, the
 *    exit-0 refusal envelope)
 *  - measured reliability laws (NCM_LEGACY_PLAY=1 is the one reliable
 *    starter; the player socket path doubles as an is-playing probe; volume
 *    must be read from user-prefs.json because `state` reports null)
 *  - the bash security policy (which subcommands run free vs. ask)
 */

import { NcmCliDriver, extractNcmCliJson } from '../../ncm-cli-driver.js'
import { parseLrcLyric, type OnethingMusicLyricLine } from '../../lyrics.js'
import { parseNowPlaying } from '../../now-playing.js'
import type {
  MusicCliEnvelope,
  MusicProvider,
  MusicSearchRecord,
} from '../types.js'
import { ncmIdSchema } from './ids.js'

function parseEnvelope(stdout: string): MusicCliEnvelope {
  const envelope = extractNcmCliJson(stdout)
  if (envelope?.success === false) {
    return { ok: false, message: envelope.message?.trim() || undefined }
  }
  return { ok: true }
}

interface NcmSearchRecordRaw {
  id?: unknown
  originalId?: unknown
  name?: unknown
  artistName?: unknown
  artists?: Array<{ name?: unknown }>
  playFlag?: unknown
  /** Milliseconds. */
  duration?: unknown
}

/** ncm reports `duration` in milliseconds. Anything outside 5s–2h is not a song length we trust. */
function trackSeconds(ms: unknown): number | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined
  const s = Math.round(ms / 1000)
  return s >= 5 && s <= 7200 ? s : undefined
}

function parseSearchRecords(stdout: string): MusicSearchRecord[] {
  let raw: NcmSearchRecordRaw[]
  try {
    const parsed = JSON.parse(stdout) as { data?: { records?: NcmSearchRecordRaw[] } }
    raw = parsed.data?.records ?? []
  } catch {
    return []
  }

  const records: MusicSearchRecord[] = []
  for (const record of raw) {
    // A malformed id could never be played or matched; dropping it here keeps
    // the generic identify layer free of NetEase's 32-hex rule.
    if (typeof record.id !== 'string' || !/^[0-9a-fA-F]{32}$/.test(record.id)) continue
    const artist =
      typeof record.artistName === 'string'
        ? record.artistName
        : typeof record.artists?.[0]?.name === 'string'
          ? record.artists[0].name
          : undefined
    records.push({
      primaryId: record.id,
      altId:
        typeof record.originalId === 'number' || typeof record.originalId === 'string'
          ? String(record.originalId)
          : undefined,
      title: typeof record.name === 'string' ? record.name : '',
      artist,
      playFlag: typeof record.playFlag === 'boolean' ? record.playFlag : undefined,
      durationS: trackSeconds(record.duration),
    })
  }
  return records
}

function parseLyricReply(stdout: string): OnethingMusicLyricLine[] {
  let data: { lyric?: string; noLyric?: boolean } | undefined
  try {
    data = (JSON.parse(stdout) as { data?: { lyric?: string; noLyric?: boolean } }).data
  } catch {
    return []
  }
  if (data?.noLyric || !data?.lyric) return []
  return parseLrcLyric(data.lyric)
}

/**
 * ncm-cli commands that run without asking (see the bash classifier).
 * Transport + reads run free; anything that writes to the user's account,
 * publishes, spends credits, or touches credentials still asks. Entries are
 * `<group>` or `<group> <subcommand>` — the longest match wins, so
 * `song lyric` reads freely while `song like` (edits 红心歌单) does not.
 */
const NCM_CLI_AUTO_ALLOW: ReadonlySet<string> = new Set([
  // Transport: local to the player daemon, spends no quota, changes no data.
  'state', 'queue', 'next', 'prev', 'pause', 'resume', 'stop', 'volume', 'seek', 'play',
  // Discovery: read-only (they do spend the daily request quota).
  'search', 'recommend', 'commands', 'song lyric', 'song detail',
  'album get', 'album tracks', 'artist songs', 'comment list-hot',
  'playlist get', 'playlist tracks', 'playlist created', 'playlist collected',
  'playlist radar', 'playlist getTags', 'album collected',
  'user info', 'user history', 'user favorite', 'user listen-ranking',
  'user album-history', 'user playlist-history',
])

export const ncmMusicProvider: MusicProvider = {
  descriptor: {
    id: 'ncm-cli',
    label: '网易云音乐 (ncm-cli)',
    binary: 'ncm-cli',
    tools: [
      { id: 'ncm-cli', label: 'ncm-cli', install: { npm: ['install', '-g', '@music163/ncm-cli'] } },
      {
        id: 'mpv',
        label: 'mpv',
        install: { brew: ['install', 'mpv'] },
        requiredWhenPlayerBackend: 'mpv',
      },
    ],
    setupStages: ['env', 'credentials', 'login', 'ready'],
    credentialFields: [
      { key: 'appId', label: 'App ID', secret: false, placeholder: '控制台应用详情页' },
      {
        key: 'privateKey',
        label: 'Private Key',
        secret: true,
        placeholder: '-----BEGIN PRIVATE KEY-----',
      },
    ],
    loginKind: 'qr-stdout',
    playerBackends: [
      { id: 'mpv', label: '内置播放器(mpv)' },
      { id: 'orpheus', label: '网易云音乐 App' },
    ],
  },

  createBackend(deps) {
    return new NcmCliDriver({
      runner: deps.runner,
      writeSecretFile: deps.writeSecretFile,
      logger: deps.logger,
    })
  },

  cli: {
    build: {
      state: () => ['state'],
      // NCM_LEGACY_PLAY=1 is the one starter that survived the field test:
      // the modern daemon pipeline (detached child, 3s handshake, manifest
      // revalidation) went 0/12 one evening; legacy in-process playback
      // started every time and still answers socket transport.
      start: entry => ({
        args: ['play', '--song', '--encrypted-id', entry.encryptedId, '--original-id', entry.originalId],
        env: { NCM_LEGACY_PLAY: '1' },
      }),
      stop: () => ['stop'],
      pause: () => ['pause'],
      resume: () => ['resume'],
      seek: seconds => ['seek', String(seconds)],
      like: entry => ['song', 'like', '--songId', entry.encryptedId],
      lyric: entry => ['song', 'lyric', '--songId', entry.encryptedId],
      search: (query, limit) => ['search', 'song', '--keyword', query, '--limit', String(limit)],
      loginCheck: () => ['login', '--check'],
    },
    parse: {
      envelope: parseEnvelope,
      nowPlaying: parseNowPlaying,
      searchRecords: parseSearchRecords,
      lyric: parseLyricReply,
    },
  },

  ids: ncmIdSchema,

  reliability: {
    probePaths: {
      playerSocket: '~/.config/ncm-cli/player-daemon.sock',
      volumePrefs: '~/.config/ncm-cli/user-prefs.json',
    },
    volumeSource: 'prefs-file',
  },

  bashPolicy: {
    binary: 'ncm-cli',
    autoAllow: NCM_CLI_AUTO_ALLOW,
    extraAllow(args) {
      const [group] = args
      // `config get player` reads; `config set` writes credentials — never free.
      if (group === 'config' && args[1] === 'get') return true
      if (group === 'login' && args.includes('--check')) return true
      // `--version` prints and exits; commander treats `--help` anywhere as
      // "print usage and exit", so even `config set --help` runs nothing.
      return args.some(
        arg => arg === '--version' || arg === '-V' || arg === '--help' || arg === '-h' || arg === 'help',
      )
    },
    askReason(groupOrPair) {
      return `ncm-cli "${groupOrPair}" writes to the user's NetEase account, credentials, or public content`
    },
  },

  prose: {
    skillDirName: 'netease-music-cli',
    // Filled when the persona/skill templating lands (Phase 1); until then the
    // NetEase command prose still lives in the content files themselves.
    cliCheatsheet: '',
  },
}
