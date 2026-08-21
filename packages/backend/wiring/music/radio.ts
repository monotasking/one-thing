/**
 * The radio's host-side wiring: the conductor gets its samples from the
 * now-playing watcher, its DJ from the stream engine, and its revive path from
 * the keepalive flow. See docs/design/music-radio-conductor.md.
 *
 * The DJ is a real agent (`radio-dj`) in a real session named 电台 — its
 * transcript is the programming log. Wakes are engine-direct drives, same as
 * goal kicks: `source: 'radio'` is registered in SYSTEM_INTERNAL_MESSAGE_SOURCES,
 * so the router bypasses channel-identity resolution and the turn lands in the
 * radio session instead of spawning a ghost session.
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  RADIO_DJ_AGENT_ID,
  RADIO_DJ_AGENT_NAME,
  RADIO_DJ_FACTORY_VERSION,
  RADIO_DJ_TOOL_ALLOWLIST,
  createOnethingMusicReliableRunner,
  createOnethingRadioConductor,
  createOnethingRadioStore,
  estimateSpeechSeconds,
  firstVocalStartAt,
  matchSongFromSearch,
  songPlayFlagFromSearch,
  radioDjFactoryPromptVersion,
  renderRadioCurationPrompt,
  renderRadioDjAgentPrompt,
  renderRadioOpenPrompt,
  type OnethingMusicIdentifiedSong,
  type OnethingMusicNowPlaying,
  type OnethingRadioConductor,
  type OnethingRadioProgrammeEntry,
  type OnethingRadioStore,
} from '@onething/runtime/music/index'
import { broadcastVoiceHostMessage } from '@onething/runtime/voice/host-ports.wiring'
import { IPC_CHANNELS } from '@shared/ipc.js'
import type { MusicLyricLine, MusicLyrics } from '@shared/ipc/music.js'
import { createElectronMusicProcessRunner } from '@onething/runtime/music/process-runner'
import { addGrant } from '@onething/core'
import { writeJsonFile } from '@onething/core/storage'
import { agentExists, createAgent, findAgent, updateAgent } from '@onething/runtime/agents/store-bound.wiring'
import { markSessionUnattended } from '@onething/runtime/permissions/unattended'
import {
  getOnethingStorePath,
} from '@onething/runtime/storage/index'
import { getSettings } from '../../stores/settings.js'
import * as sessions from '../../stores/sessions.js'
import { sessionReads } from '../../session/reads.js'
import {
  getActiveMusicProvider,
  getMusicNowPlaying,
  getMusicService,
  nudgeMusicClients,
  refreshMusicNowPlaying,
  setMusicSampleListener,
} from './service.js'
import { prefetchDjPatter, resetDjPatterCache, speakDjPatter } from './dj-voice.js'

import { SESSION_COMMAND_TYPES } from '@shared/events/index.js'
import { consolePort, getLogger } from '../logging/index.js'

const log = getLogger('music.radio')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog = consolePort(log)


let radioStore: OnethingRadioStore | null = null
let conductor: OnethingRadioConductor | null = null
/** Sessions this process already pre-granted music-dir writes to. */
const grantedSessions = new Set<string>()

export function getRadioStore(): OnethingRadioStore {
  const provider = getActiveMusicProvider()
  radioStore ??= createOnethingRadioStore(path.join(getOnethingStorePath(), 'music'), {
    ids: provider.ids,
    providerId: provider.descriptor.id,
  })
  return radioStore
}

function getReliableRunner() {
  const provider = getActiveMusicProvider()
  return createOnethingMusicReliableRunner({
    runner: createElectronMusicProcessRunner(),
    logger: consoleLog,
    cli: {
      binary: provider.descriptor.binary,
      parse: {
        envelope: provider.cli.parse.envelope,
        nowPlaying: provider.cli.parse.nowPlaying,
      },
    },
  })
}

/**
 * Make sure the DJ exists to be woken: the factory persona once, a dedicated
 * session bound to it once. User edits to the agent are never overwritten —
 * this only ever creates.
 */
function ensureRadioSession(store: OnethingRadioStore): string {
  const factoryPrompt = renderRadioDjAgentPrompt({
    inboxPath: store.inboxPath,
    cliCheatsheet: getActiveMusicProvider().prose.cliCheatsheet,
  })
  // Recreate the agent if it was deleted by hand — a session pointing at a
  // missing agent silently falls back to the default persona, which is a
  // different host with no radio discipline.
  if (!agentExists(RADIO_DJ_AGENT_ID)) {
    createAgent({
      id: RADIO_DJ_AGENT_ID,
      name: RADIO_DJ_AGENT_NAME,
      systemPrompt: factoryPrompt,
      tools: RADIO_DJ_TOOL_ALLOWLIST,
      // 后台设施角色(agent-domain-model.md M2):有身份面,无社交面 —
      // 联系人/roster/AgentSelector 全部按 kind 过滤,不再撒 id 硬编码。
      kind: 'service',
    })
    log.warn('radio-dj agent was missing, recreated from the factory persona')
  } else {
    // Mandatory disciplines live in the persona, so installed agents must
    // follow factory upgrades: "created once, never touched" froze every DJ
    // on day-one rules, and a chat with the stale DJ shipped six
    // rights-restricted songs (2026-07-17). The fingerprint line in the
    // prompt is the opt-out: users who delete it own their persona; a prompt
    // without a fingerprint is a pre-fingerprint factory install and gets a
    // one-time migration.
    const installedAgent = findAgent(RADIO_DJ_AGENT_ID)
    const installed = installedAgent?.systemPrompt ?? ''
    const installedVersion = radioDjFactoryPromptVersion(installed)
    if ((installedVersion ?? 0) < RADIO_DJ_FACTORY_VERSION && installed !== factoryPrompt) {
      updateAgent({ agentId: RADIO_DJ_AGENT_ID, systemPrompt: factoryPrompt })
      log.warn('radio-dj persona upgraded to the factory version', {
        version: RADIO_DJ_FACTORY_VERSION,
        previousVersion: installedVersion ?? 'pre-fingerprint',
      })
    }
    // One-time backfill: pre-allowlist installs carried every tool into each
    // DJ turn. An explicit (user-edited) allowlist is left alone.
    if (installedAgent && installedAgent.tools === undefined) {
      updateAgent({ agentId: RADIO_DJ_AGENT_ID, tools: RADIO_DJ_TOOL_ALLOWLIST })
      log.warn('radio-dj tool allowlist backfilled', { tools: RADIO_DJ_TOOL_ALLOWLIST })
    }
    // One-time backfill: pre-classification installs are plain colleague rows,
    // which would keep the DJ inside every social surface (AgentSelector,
    // room member pickers). The DJ is infrastructure — stamp it service.
    if (installedAgent && installedAgent.kind !== 'service') {
      updateAgent({ agentId: RADIO_DJ_AGENT_ID, kind: 'service' })
      log.warn('radio-dj classified as a service agent')
    }
  }

  const brief = store.readBrief()
  if (brief.sessionId) {
    const existing = sessions.getSession(brief.sessionId)
    if (existing && !isDjSessionOversized(existing)) return brief.sessionId
    if (existing) {
      // Rotation: wakes replay the full transcript, so an old station pays
      // for every past batch on every new one. The DJ is stateless by design
      // (the wake prompt carries intent/history/queue), so a fresh session IS
      // the handoff — no summary needed. The old log stays in the sidebar's
      // Music group.
      log.warn('rotating dj session', {
        sessionId: brief.sessionId,
        messages: sessionReads.countMessages(brief.sessionId),
      })
    }
  }

  // A dead id (session deleted by hand) used to mean "silently create a new
  // session every wake" — five sessions in one morning, field-measured. Reuse
  // the newest still-reasonable radio-dj session from the index first.
  if (brief.sessionId && !sessions.getSession(brief.sessionId)) {
    const candidate = pickReusableRadioDjSession(sessions.getSessionsList())
    if (candidate) {
      store.writeBrief({ ...brief, sessionId: candidate })
      return candidate
    }
  }

  const sessionId = randomUUID()
  sessions.createSession(sessionId, '电台')
  sessions.updateSessionAgent(sessionId, RADIO_DJ_AGENT_ID)
  store.writeBrief({ ...brief, sessionId })
  return sessionId
}

/** Transcript-weight thresholds for rotating the DJ session. */
const DJ_SESSION_MAX_CONTEXT_TOKENS = 60_000
const DJ_SESSION_MAX_MESSAGES = 40

export function isDjSessionOversized(
  session: { messages?: unknown[]; contextSize?: number } | undefined | null,
): boolean {
  if (!session) return false
  const contextSize = typeof session.contextSize === 'number' ? session.contextSize : 0
  const messageCount = Array.isArray(session.messages) ? session.messages.length : 0
  return contextSize > DJ_SESSION_MAX_CONTEXT_TOKENS || messageCount > DJ_SESSION_MAX_MESSAGES
}

/** Newest radio-dj session light enough to keep using (index metadata only). */
export function pickReusableRadioDjSession(
  list: Array<{ id: string; agentId?: string; updatedAt: number; messageCount?: number }>,
): string | null {
  const candidates = list
    .filter(
      meta =>
        meta.agentId === RADIO_DJ_AGENT_ID && (meta.messageCount ?? 0) <= DJ_SESSION_MAX_MESSAGES,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
  return candidates[0]?.id ?? null
}

/**
 * Drive one DJ turn into the radio session. A missing sessionId means this is
 * the opening of the station (first batch + start playback); afterwards every
 * wake is a follow-up batch.
 */
/**
 * The DJ's whole file workspace is the music dir (inbox in, brief context
 * out). Grant EVERY effect a file op there can raise (session-scoped, this
 * dir only): the wake lands in a session nobody is looking at, where a
 * permission prompt hangs (first field test) and an auto-deny deadlocks —
 * second field test: the DJ session has no workingDirectory, so reads raise
 * `external_directory`/`sensitive_file_read`, which the original write-only
 * grant did not cover; Read got denied, Write requires Read first, and the
 * curation loop died against that wall every wake.
 */
const MUSIC_DIR_GRANT_TYPES = [
  'read',
  'sensitive_file_read',
  'external_directory',
  'file_write',
  'file_edit',
  'file_destructive_edit',
] as const

function grantMusicDirAccess(sessionId: string, musicDir: string): void {
  if (grantedSessions.has(sessionId)) return
  grantedSessions.add(sessionId)
  const pattern = path.join(musicDir, '*')
  for (const type of MUSIC_DIR_GRANT_TYPES) {
    addGrant({
      scope: 'session',
      type,
      pattern,
      sessionId,
      createdFrom: { messageId: 'radio-conductor', title: '电台节目单目录(预授)' },
    })
  }
}

/** Per-item and total budgets for the opening patter's life-context block. */
const LIFE_CONTEXT_ITEM_MAX = 200
const LIFE_CONTEXT_TOTAL_MAX = 1_200
/** Variables with no narrative value for a radio host. */
const LIFE_CONTEXT_EXCLUDED = new Set(['music', 'workdir', 'background_jobs'])

/**
 * The listener's life right now, for the opening patter: a filtered snapshot
 * of the variable registry (notes, goals, custom variables — whatever
 * providers exist). Deliberately NOT a named list of variables: a future
 * weather/schedule provider joins the morning show with zero changes here.
 * Best-effort — an empty string just means a plain opening.
 */
async function buildRadioLifeContext(sessionId: string): Promise<string> {
  try {
    // Dynamic import mirrors the engine imports below: radio.ts is reachable
    // from the variable gateways, and static graph edges here have bitten
    // unrelated test module graphs before.
    const { getVariableRegistry } = await import('@onething/runtime/variables/registry')
    const variables = await getVariableRegistry().list({ sessionId })
    const lines: string[] = []
    let total = 0
    for (const variable of variables) {
      if (LIFE_CONTEXT_EXCLUDED.has(variable.name)) continue
      const value = (variable.value ?? '').trim()
      if (!value) continue
      const line = `- ${variable.name}: ${value.slice(0, LIFE_CONTEXT_ITEM_MAX)}`
      if (total + line.length > LIFE_CONTEXT_TOTAL_MAX) break
      lines.push(line)
      total += line.length
    }
    return lines.join('\n')
  } catch (error) {
    log.warn('life context unavailable, opening plain', {}, error)
    return ''
  }
}

/**
 * How long a stated intent survives without being re-set. Past this, the next
 * DJ wake drops it and self-directs by time + history — so last session's
 * 午睡歌曲 can't haunt tonight's late-night radio even if the station was only
 * resumed, never freshly opened. Ages from the last real set/open, not plays.
 */
const RADIO_INTENT_TTL_MS = 6 * 60 * 60 * 1_000

async function wakeRadioDj(): Promise<void> {
  if (!isMusicEnabled()) return
  const store = getRadioStore()
  // Before rendering the DJ prompt, age out a stale intent so a resumed or
  // conductor-woken station (no fresh open) doesn't quote an old direction.
  store.expireStaleIntent(RADIO_INTENT_TTL_MS)
  const brief = store.readBrief()
  const opening = !brief.sessionId || !sessions.getSession(brief.sessionId)
  const sessionId = ensureRadioSession(store)
  grantMusicDirAccess(sessionId, path.dirname(store.programmePath))
  // Nobody watches DJ turns; a permission dialog there is a silent hang.
  // Marked unattended, asks become immediate explained denials instead.
  markSessionUnattended(sessionId)

  // Dynamic imports: this module is reachable from the variable gateways, and
  // a static engine import would drag the whole provider stack into every
  // module graph that touches variables (which broke unrelated tests).
  const [{ getStreamEngineSafe }, { getEventBus }] = await Promise.all([
    import('../../engine/index.js'),
    import('../../events/index.js'),
  ])

  // A run already active in the radio session IS the DJ working — kicking
  // again would interleave two curations in one transcript.
  if (getStreamEngineSafe()?.getController(sessionId)) return

  const renderOptions = {
    brief: store.readBrief(),
    inboxPath: store.inboxPath,
    programmeRemaining: store.readProgramme().entries.map(entry => entry.title),
  }
  const content = opening
    ? renderRadioOpenPrompt({
        ...renderOptions,
        lifeContext: await buildRadioLifeContext(sessionId),
      })
    : renderRadioCurationPrompt(renderOptions)

  // The DJ's own model (设置 → 音乐 → 电台编排), same idea as toolCallModel:
  // curation is background work in a session nobody watches, so it should not
  // inherit whatever model the radio session last used. Empty providerId =
  // follow the session default. Think mode rides the override so it stays
  // independent of the global per-model toggle.
  const djModel = getSettings().music?.radioDj
  const modelOverride = djModel?.providerId
    ? {
        providerId: djModel.providerId,
        ...(djModel.model ? { model: djModel.model } : {}),
        ...(typeof djModel.thinking === 'boolean'
          ? { thinking: djModel.thinking, thinkingEffort: djModel.thinkingEffort }
          : {}),
      }
    : {}

  await getEventBus().emit(sessionId, {
    type: SESSION_COMMAND_TYPES.SEND_MESSAGE,
    content,
    source: 'radio',
    origin: { transport: 'api', source: 'radio', receivedAt: Date.now() },
    // The session is deliberately named 电台; the drive prompt is not a title.
    suppressTitleGeneration: true,
    ...modelOverride,
  })
}

/**
 * A song we started is audibly on. Lyrics and the play record fire here — no
 * title matching anywhere: LLM-written titles drift (bare '早春的树' vs the
 * player's '早春的树 - 陈鸿宇') and broke every title-keyed feature at once.
 * `playerTitle` is the player's own stable format, used for display and the
 * renderer's lyric guard. (The patter is NOT here: a real host talks BEFORE
 * the song — playProgrammeEntry speaks into the silence, then starts it. The
 * first field run had the song poke out for two seconds, get paused for the
 * intro, then resume — backwards.)
 */
function onSongStarted(entry: OnethingRadioProgrammeEntry, playerTitle: string): void {
  const store = getRadioStore()
  store.recordPlayed(playerTitle, entry.encryptedId)
  void pushLyricsFor(entry, playerTitle)
  // The song is on: minutes of idle ahead — warm the next entry's caches now
  // so its start pays neither the lyric fetch nor the TTS synthesis.
  prefetchUpcomingEntry()
}

/**
 * Background warm-up for the entry that will play next (first playable in the
 * programme): lyric timeline into lyricCache, patter audio into the TTS cache.
 * Best-effort and idempotent — both layers dedupe in-flight requests, so
 * calling this on every queue-head change costs at most one fetch per song.
 */
function prefetchUpcomingEntry(): void {
  try {
    const next = getRadioStore()
      .readProgramme()
      .entries.find(entry => entry.playFlag !== false)
    if (!next) return
    void getLyricLines(next).catch(() => {})
    if (next.say) prefetchDjPatter(next.say, next.title)
  } catch (error) {
    log.warn('prefetch for the upcoming entry failed', {}, error)
  }
}

/**
 * Read-back verify budget. A single fixed-delay check misjudged a slow night
 * (song came up at ~6s, we checked at 5s, wrote a false 起播失败 and dropped
 * the entry) — so poll instead, and let a late start still count as a start.
 * (Each state read is itself a ~250ms CLI call, so the effective cycle is
 * ~550ms.)
 */
const PLAY_VERIFY_INTERVAL_MS = 300
const PLAY_VERIFY_DEADLINE_MS = 12_000

/**
 * How long the start flow waits for the lyric timeline before deciding the
 * patter timing without it. The lyric API was field-measured at 11s on a bad
 * day — a nicety (talk over the intro vs before the song) must not cost that.
 */
const LYRIC_DECISION_TIMEOUT_MS = 3_000

const NCM_LOGIN_EXPIRED_MESSAGE =
  '网易云登录已过期,请到 设置 → 音乐 重新登录;登录恢复后电台会自动续播'

/**
 * The conductor's systemic-failure probe (see its option doc): an expired
 * NetEase login makes `play` exit 0 with no sound for EVERY song — 2026-07-17
 * that burned six curated entries under a generic 起播失败. `login --check` is
 * read-only (same command the bash whitelist trusts); a refusal envelope
 * arrives as a thrown `未登录` message. Anything else (timeout, missing
 * binary) is "can't tell" — fail open so per-song handling keeps working.
 */
export async function diagnoseRadioStartFailure(): Promise<string | null> {
  try {
    await getReliableRunner().run('read', getActiveMusicProvider().cli.build.loginCheck())
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (!message.includes('未登录')) return null
    // Push the discovery into the service state so the bar flips to its
    // 未登录 warning NOW — the boot-time probe is the only other writer, and
    // a mid-session expiry would otherwise leave the UI looking healthy.
    void getMusicService()
      .checkLogin()
      .catch(() => {})
    return NCM_LOGIN_EXPIRED_MESSAGE
  }
}

/**
 * Post-mortem for a silent start: `play` on a rights-restricted song exits 0
 * with no output and no sound (measured — six songs burned under a generic
 * 起播失败 before anyone knew why). Re-search the title and read the record's
 * playFlag with the entry's id as the join key. Only runs on the failure
 * path; any doubt (no match, search down) returns false and keeps the
 * generic verdict.
 */
async function isSongRightsRestricted(entry: OnethingRadioProgrammeEntry): Promise<boolean> {
  try {
    const provider = getActiveMusicProvider()
    // Deep enough that album variants surface: the curated version of a song
    // can rank low for its own bare title (field-hit: 琵琶语's chosen record
    // was not in the top five).
    const stdout = await getReliableRunner().run('server', provider.cli.build.search(entry.title, 20))
    return (
      songPlayFlagFromSearch(provider.cli.parse.searchRecords(stdout), {
        encryptedId: entry.encryptedId,
        originalId: entry.originalId,
      }) === false
    )
  } catch {
    return false
  }
}

/**
 * A start failure that is NOT the song's fault (another start already in
 * flight, expired login, wrong player backend). The popped programme entry
 * deserves to go back to the front — dropping it was how curated songs
 * (opening patter included) silently vanished when the user double-tapped ⏭
 * during a start. Genuine per-song failures still drop the entry (putting a
 * rejected song back would wedge the radio on it).
 */
class RadioStartNotSongsFaultError extends Error {
  readonly entryReusable = true
}

function isEntryReusableFailure(error: unknown): boolean {
  return error instanceof Error && (error as { entryReusable?: boolean }).entryReusable === true
}

/**
 * Timing probe for the start flow (investigating slow ⏭ → patter → song).
 * One line per phase: delta since the previous mark plus total since the
 * user's gesture (or, without one, since the start flow began). Remove once
 * the latency source is confirmed.
 */
/** Set at the IPC entry when a bar gesture initiates a start; consumed by the
 * next timer so `total` measures from the actual click. */
let gestureStart: { at: number; label: string } | null = null

export function markRadioGesture(label: string): void {
  gestureStart = { at: Date.now(), label }
}

function createRadioStartTimer(title: string) {
  // A stale mark (gesture that never reached a start) must not warp a later
  // conductor-initiated start's numbers — only adopt a fresh one.
  const gesture = gestureStart && Date.now() - gestureStart.at < 10_000 ? gestureStart : null
  gestureStart = null
  const t0 = gesture?.at ?? Date.now()
  let last = Date.now()
  log.debug('radio start requested', {
    title,
    ...(gesture ? { gesture: gesture.label, sinceGestureMs: Date.now() - gesture.at } : {}),
  })
  return {
    mark(phase: string) {
      const now = Date.now()
      log.debug('radio start phase', { title, phase, ms: now - last, totalMs: now - t0 })
      last = now
    },
  }
}

/** Serializes song starts; see playProgrammeEntry. */
let playStarting: Promise<void> | null = null
/** The entry the in-flight start is for; meaningful only while playStarting is set. */
let playStartingEntry: OnethingRadioProgrammeEntry | null = null

/**
 * The bar's "换歌中" signal: the title being started, undefined when no start
 * is in flight. Covers the whole deliberate-silence window — patter synthesis,
 * the spoken line, play spawn, verify — so the UI stops reading a normal
 * transition as "the radio stalled" (field complaint).
 */
export function getRadioStartingTitle(): string | undefined {
  return playStarting ? (playStartingEntry?.title ?? undefined) : undefined
}

/**
 * Start one song. NCM_LEGACY_PLAY=1 is the one starter that survived the
 * field test: the modern daemon pipeline (play's detached child, hard 3s
 * handshake, manifest revalidation blowing the deadline) went 0/12 in one
 * evening, while legacy in-process playback started every time and still
 * answers socket transport (pause/state). Throws unless the player is
 * actually playing afterwards — the read-back is the verdict, not play's own
 * exit code.
 *
 * Serialized: legacy sessions have no daemon arbitration, so two overlapping
 * starts would both sound. Concurrent callers (conductor advance, bar skip,
 * bar resume) wait for the in-flight start and then throw — by the time it
 * finishes, their own song choice is stale.
 */
async function playProgrammeEntry(entry: OnethingRadioProgrammeEntry): Promise<void> {
  if (playStarting) {
    await playStarting.catch(() => {})
    throw new RadioStartNotSongsFaultError(`另一次起播正在进行,放弃「${entry.title}」`)
  }

  const timer = createRadioStartTimer(entry.title)
  const start = (async () => {
    // Known-unplayable at curation time: refuse before ANY ceremony — a
    // spoken intro for a song that cannot come is the worst version of this
    // failure (field feedback). Callers' grey-skipping loops normally filter
    // these; this guard covers onDeck replays and hand-fed entries.
    if (entry.playFlag === false) {
      throw new Error('版权受限,无法播放——已跳过')
    }
    // The bar's 停止电台 can land at any moment in this multi-second flow;
    // a start that outlives the close would restart the music the user just
    // killed. Checked again after the patter (the longest gap).
    if (!getRadioStore().readBrief().active) {
      throw new RadioStartNotSongsFaultError('电台已停止')
    }
    const reliable = getReliableRunner()
    if (getMusicService().getState().playerBackend !== 'mpv') {
      throw new RadioStartNotSongsFaultError(
        '电台需要内置播放器(mpv);当前是网易云 App 模式,可在状态栏切换',
      )
    }
    // onDeck is written at issue time, not on verified success: a start judged
    // failed may still sound seconds later (the late-start case), and whoever
    // compensates then needs to know which song this was.
    getRadioStore().setOnDeck(entry)
    // Snapshot of the pre-start world, for the verify loop. "playing" alone is
    // NOT proof our song started: a missed stop once left the OLD song audible
    // and the loop confirmed THAT as ours, then paused it while the real start
    // was still loading — total wreckage (2026-07-19). Fresh playback means
    // playing AND (nothing was on before | the title changed | the position
    // rewound — the same-title ⏮ replay case; the cached position only grows,
    // so a smaller reading proves a restart).
    const prevSample = getMusicNowPlaying()
    const isFreshPlayback = (
      state: OnethingMusicNowPlaying | null,
    ): state is OnethingMusicNowPlaying =>
      state !== null &&
      state.status === 'playing' &&
      (prevSample?.status !== 'playing' ||
        state.title !== prevSample.title ||
        state.position < prevSample.position)
    // The host's timing, like a real radio: if the song's instrumental intro
    // is long enough (first sung lyric line vs estimated speech length), start
    // the music and talk OVER the intro, shutting up before the vocal — no
    // pause, no interruption. Too-short intro / no lyric timeline → speak
    // into silence BEFORE the song instead.
    let talkOverIntro = false
    // The speak-before patter runs CONCURRENTLY with the play command: the
    // song's load (URL fetch + mpv spawn + buffering, field-measured 5-6s)
    // hides under the voice instead of following it as dead air. The verify
    // loop below coordinates the two tracks.
    let patterInFlight: Promise<void> | null = null
    let patterFinished = false
    if (entry.say) {
      // TTS synthesis and the lyric fetch are independent — kick the synthesis
      // NOW so it runs during the lyric wait (serial was measured at 11s lyric
      // + 2.4s synth stacked); speakDjPatter below joins the in-flight result.
      prefetchDjPatter(entry.say, entry.title)
      // The lyric timeline only decides WHEN to talk. Past the deadline, decide
      // without it (speak into silence — the safe default) instead of letting a
      // slow lyric API hold the whole start hostage; the fetch itself keeps
      // running in the background for the lyrics push after the song starts.
      const lines = await Promise.race([
        getLyricLines(entry).catch(() => [] as MusicLyricLine[]),
        new Promise<MusicLyricLine[]>(resolve =>
          setTimeout(() => resolve([]), LYRIC_DECISION_TIMEOUT_MS),
        ),
      ])
      timer.mark('歌词获取(判定口播时机)')
      const vocalAt = firstVocalStartAt(lines)
      talkOverIntro =
        vocalAt !== undefined && vocalAt >= estimateSpeechSeconds(entry.say) + 1.5
      if (!talkOverIntro) {
        // Unconditional stop — no state read first. The pre-read once hung for
        // its full 8s timeout and came back null (2026-07-19), which skipped
        // this stop and left the old song playing under the patter. A stop
        // refusal on an already-silent player is harmless noise by comparison.
        await reliable.run('transport', getActiveMusicProvider().cli.build.stop()).catch(error => {
          log.warn('stop before patter failed', {}, error)
        })
        timer.mark('停当前播放')
        patterInFlight = speakDjPatter(entry.say, entry.title)
          .catch(error => {
            log.warn('patter before play failed, the song continues', {}, error)
          })
          .finally(() => {
            patterFinished = true
          })
        timer.mark('口播已开始(与 play 并行)')
      }
    }
    // 'start' class: zero retries — play is NOT idempotent, and an automatic
    // re-run after a "failure" that actually made sound plays the song twice.
    // Argv + env (ncm: NCM_LEGACY_PLAY=1) are the provider's measured law.
    const startCommand = getActiveMusicProvider().cli.build.start(entry)
    await reliable.run('start', startCommand.args, startCommand.env)
    timer.mark('play 命令返回')
    if (entry.say && talkOverIntro) {
      // Fire alongside the starting song: with the prefetched synthesis the
      // voice lands right at the top of the intro, before the first vocal.
      void speakDjPatter(entry.say, entry.title).catch(error => {
        log.warn('patter over intro failed', {}, error)
      })
    }
    const waitForFreshPlayback = async (
      budgetMs: number,
    ): Promise<OnethingMusicNowPlaying | null> => {
      const deadline = Date.now() + budgetMs
      for (;;) {
        // First check immediately — the old lead-in sleep added a flat second
        // of detection lag to every start.
        const state = await reliable.readState().catch(() => null)
        if (isFreshPlayback(state)) return state
        if (Date.now() >= deadline) return null
        await new Promise(resolve => setTimeout(resolve, PLAY_VERIFY_INTERVAL_MS))
      }
    }
    const confirmedState = await waitForFreshPlayback(PLAY_VERIFY_DEADLINE_MS)
    if (!confirmedState) {
      // Every caller (conductor advance, bar resume/skip/replay) surfaces
      // this message as the brief's lastError — say the true cause when we
      // know it instead of the generic shrug.
      const systemic = await diagnoseRadioStartFailure().catch(() => null)
      if (systemic) throw new RadioStartNotSongsFaultError(systemic)
      if (await isSongRightsRestricted(entry)) {
        throw new Error('版权受限,网易云不提供这首的播放权——已跳过')
      }
      throw new Error(`play 返回成功但播放器没有在放「${entry.title}」`)
    }
    timer.mark('确认播放器已在放')
    // 停止电台 may have landed during the load: the just-started song would
    // outlive the close — kill it instead of letting it play into a dead
    // station.
    if (!getRadioStore().readBrief().active) {
      await reliable.run('transport', getActiveMusicProvider().cli.build.stop()).catch(() => {})
      throw new RadioStartNotSongsFaultError('电台已停止')
    }
    if (patterInFlight) {
      if (!patterFinished) {
        // The song came up while the host is still talking: let it play — the
        // voice rides over the music, like a real broadcast. This used to hold
        // the song at the start line (pause + seek 0, verified resume on ack),
        // but the hold was audibly worse than the overlap it prevented: the
        // verify poll only sees the song AFTER it is making sound, so every
        // hold played as music blipping on and getting yanked back down
        // (field verdict 2026-07-25) — and the release chain it required has
        // died twice in the field on fresh legacy streams (resume refused
        // with 播放列表为空; a resumed stream expiring 40s in). No pause:
        // nothing to release, nothing to rescue.
        timer.mark('歌先出声,口播盖着说完')
        await patterInFlight
        // 停止电台 pressed while the host was talking: the station closed —
        // do NOT let the song it introduced keep playing.
        if (!getRadioStore().readBrief().active) {
          await reliable
            .run('transport', getActiveMusicProvider().cli.build.stop())
            .catch(() => {})
          throw new RadioStartNotSongsFaultError('电台已停止')
        }
      } else {
        // Patter ended before the song came up — the load was the longer leg;
        // the song starts the moment the player has it. Nothing else to do.
        await patterInFlight
      }
    }
    // Everything that used to hang off title-matching fires right here
    // instead: we KNOW which song this is — we just started it. The player's
    // own title (stable machine format) rides the pushes so the renderer's
    // display always agrees with the bar.
    onSongStarted(entry, confirmedState?.title ?? entry.title)
    await refreshMusicNowPlaying()
  })()

  playStartingEntry = entry
  playStarting = start.then(
    () => undefined,
    () => undefined,
  )
  // Announce the transition at both edges: the watcher only pushes CHANGES in
  // player state, and a start's whole point is that the player is silent while
  // it runs — without the nudges the bar would keep claiming 电台停了.
  nudgeMusicClients()
  try {
    await start
  } finally {
    playStarting = null
    nudgeMusicClients()
  }
}

/**
 * The bar's "next" is a skip — the strongest taste signal the DJ gets. Called
 * by the music IPC layer before it forwards the command.
 */
export function recordRadioSkip(): void {
  const store = getRadioStore()
  const brief = store.readBrief()
  if (!brief.active) return
  // Only a song that is audibly ON can be skipped away from. ⏭ pressed into
  // silence (a start that failed, a dead player) is the user un-sticking the
  // radio, not a taste verdict — the old onDeck fallback recorded the very
  // song that FAILED as "user skipped it", and the DJ then apologized on air
  // for skips that never happened (field-hit 2026-07-19).
  const sample = getMusicNowPlaying()
  if (sample?.status !== 'playing' && sample?.status !== 'paused') return
  const title = sample.title ?? brief.onDeck?.title
  if (title) store.recordSkipped(title, brief.onDeck?.encryptedId)
}

/**
 * Pop entries until one is worth trying: curation-flagged unplayable songs
 * (playFlag: false) are skipped with an honest note instead of being fed to a
 * start that would speak their intro and then fail silently for 12 seconds.
 */
function takeNextPlayableEntry(store: OnethingRadioStore): OnethingRadioProgrammeEntry | null {
  let entry = store.takeNextEntry()
  while (entry && entry.playFlag === false) {
    store.recordError(`「${entry.title}」版权受限,已跳过`)
    entry = store.takeNextEntry()
  }
  return entry
}

/** Undo a pop after a not-the-song's-fault failure — the DJ's order survives. */
function returnEntryToProgramme(store: OnethingRadioStore, entry: OnethingRadioProgrammeEntry): void {
  const programme = store.readProgramme()
  programme.entries.unshift(entry)
  store.writeProgramme(programme)
}

/**
 * The bar gestures' failure ledger: a systemic message (expired login) goes to
 * the status line verbatim — prefixing it with 起播失败(歌名) would bury the
 * one actionable sentence under the name of an innocent song.
 */
function recordStartFailure(entry: { title: string }, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const line = message === NCM_LOGIN_EXPIRED_MESSAGE ? message : `起播失败(${entry.title}):${message}`
  getRadioStore().recordError(line)
  return line
}

/** Resume playback by hand — the bar button. Same starter the conductor uses. */
export async function resumeRadioPlayback(): Promise<boolean> {
  const store = getRadioStore()
  // ▶ on a CLOSED station with songs left is a re-open: flip active back on so
  // the conductor re-engages (auto-advance, DJ wakes) instead of playing one
  // orphan song into a dead station. One button covers "stalled, continue"
  // and "closed earlier, pick it back up".
  const brief = store.readBrief()
  if (!brief.active) {
    const hasContent = store.readProgramme().entries.length > 0 || brief.onDeck !== undefined
    if (!hasContent) return false
    store.writeBrief({ ...brief, active: true })
  }
  // A bar gesture is re-engagement: owe the DJ a wake (and reset any breaker)
  // even if this very resume has nothing left to play.
  store.noteUserEngagement()
  // Prefer fresh curation; with the programme drained, replay the last song
  // known to have played (played songs die with the player's memory).
  const popped = takeNextPlayableEntry(store)
  const entry = popped ?? store.readBrief().onDeck
  if (!entry) return false
  try {
    await playProgrammeEntry(entry)
    store.recordError(undefined)
    return true
  } catch (error) {
    if (popped && isEntryReusableFailure(error)) returnEntryToProgramme(store, popped)
    recordStartFailure(entry, error)
    return false
  }
}

/**
 * The bar's "next" while the radio is on: a skip is recorded by the IPC layer,
 * and the next programme entry starts immediately — there is no player queue
 * to advance anymore, the conductor is the queue. No onDeck fallback: the user
 * is skipping AWAY from that song, replaying it would be mockery.
 */
export async function skipToNextRadioSong(): Promise<boolean> {
  const store = getRadioStore()
  store.noteUserEngagement()
  const entry = takeNextPlayableEntry(store)
  if (!entry) return false
  try {
    await playProgrammeEntry(entry)
    store.recordError(undefined)
    return true
  } catch (error) {
    if (isEntryReusableFailure(error)) returnEntryToProgramme(store, entry)
    recordStartFailure(entry, error)
    return false
  }
}

/**
 * The bar's "prev" while the radio is on: there is no player queue to step
 * back through, so ⏮ means "this song from the top" — replay onDeck.
 */
export async function replayCurrentRadioSong(): Promise<boolean> {
  const store = getRadioStore()
  const entry = store.readBrief().onDeck
  if (!entry) return false
  try {
    await playProgrammeEntry(entry)
    store.recordError(undefined)
    return true
  } catch (error) {
    recordStartFailure(entry, error)
    return false
  }
}

export function isRadioActive(): boolean {
  return getRadioStore().readBrief().active
}

// ----------------------------------------------------------------------------
// The radio tool (the main session's delegation handle)
// ----------------------------------------------------------------------------

function radioToolStatus(): {
  active: boolean
  intent: string
  programmeLength: number
  nowPlayingTitle?: string
  lastError?: string
} {
  const store = getRadioStore()
  const brief = store.readBrief()
  return {
    active: brief.active,
    intent: brief.intent,
    programmeLength: store.readProgramme().entries.length,
    nowPlayingTitle: getMusicNowPlaying()?.title,
    lastError: brief.lastError,
  }
}

/**
 * Open or retune the station. Writes the intent file and applies it
 * synchronously (mergeIntent stamps intentAppliedAt, which owes the conductor
 * one immediate wake), then nudges the watcher so the wake lands within
 * seconds instead of the next idle poll.
 */
/**
 * The one open/retune path, shared by the model's radio tool and the bar's
 * 开电台/新电台 buttons. An empty intent is legitimate here: the open prompt's
 * intent-line degradation turns it into "按时段和历史自主定调" — "让 DJ 看着办"
 * costs zero new logic.
 */
export function openRadioStation(intent: string, options: { clearProgramme: boolean }): void {
  const store = getRadioStore()
  if (options.clearProgramme) {
    store.writeProgramme({ entries: [] })
    writeJsonFile(store.inboxPath, { entries: [] })
  }
  writeJsonFile(store.intentPath, {
    active: true,
    intent,
    startedAt: new Date().toISOString(),
  })
  store.mergeIntent()
  void refreshMusicNowPlaying()
}

export async function radioToolOpen(
  intent: string,
  options: { clearProgramme: boolean },
): Promise<ReturnType<typeof radioToolStatus>> {
  if (!isMusicEnabled()) {
    // Honest failure beats a receipt that promises a DJ who will never wake.
    throw new Error('音乐电台未启用:请在 设置 → 音乐 完成配置并打开总开关')
  }
  openRadioStation(intent, options)
  return radioToolStatus()
}

/** Close the station: inactive FIRST, then stop — the order that avoids auto-revive. */
export async function radioToolClose(): Promise<ReturnType<typeof radioToolStatus>> {
  const store = getRadioStore()
  writeJsonFile(store.intentPath, { active: false })
  store.mergeIntent()
  try {
    await getReliableRunner().run('transport', getActiveMusicProvider().cli.build.stop())
  } catch (error) {
    log.warn('stop on close failed', {}, error)
  }
  await refreshMusicNowPlaying()
  return radioToolStatus()
}

export { radioToolStatus }

// ----------------------------------------------------------------------------
// Song requests (chat's radio tool + the panel's search, one shared channel)
// ----------------------------------------------------------------------------

/**
 * 「下一首放 xxx」 made real: search, pick the first PLAYABLE record, cut in
 * at the front of the programme. Requested songs carry no patter — the
 * listener asked for the song, not an introduction — and `note: '点歌'` marks
 * them in the panel. Honest failures: nothing found / only grey versions /
 * already queued or playing.
 */
export async function requestSong(
  query: string,
): Promise<{ success: boolean; title?: string; error?: string }> {
  if (!isMusicEnabled()) return { success: false, error: '音乐电台未启用' }
  const store = getRadioStore()
  if (!store.readBrief().active) {
    return { success: false, error: '电台未开——先开台再点歌' }
  }

  const provider = getActiveMusicProvider()
  let records
  try {
    const stdout = await getReliableRunner().run('server', provider.cli.build.search(query, 10))
    records = provider.cli.parse.searchRecords(stdout)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, error: `搜索失败:${message}` }
  }
  if (records.length === 0) return { success: false, error: `没搜到「${query}」` }

  const playable = records.find(record => record.playFlag !== false)
  if (!playable) return { success: false, error: `「${query}」搜到的版本都无播放版权` }

  const entry = provider.ids.normalizeEntry({
    encryptedId: playable.primaryId,
    originalId: playable.altId ?? playable.primaryId,
    title: playable.artist ? `${playable.title} - ${playable.artist}` : playable.title,
    note: '点歌',
    playFlag: playable.playFlag,
  })
  if (!entry) return { success: false, error: '搜索结果的 id 不可用' }

  const playingTitle = getMusicNowPlaying()?.title
  if (playingTitle === entry.title) {
    return { success: true, title: entry.title, error: '这首正在放' }
  }
  const programme = store.readProgramme()
  const queuedAt = programme.entries.findIndex(
    item => item.encryptedId.toLowerCase() === entry.encryptedId.toLowerCase(),
  )
  if (queuedAt !== -1) {
    // Already curated: a request means "sooner", so promote instead of dup.
    const [existing] = programme.entries.splice(queuedAt, 1)
    programme.entries.unshift(existing)
  } else {
    programme.entries.unshift(entry)
  }
  store.writeProgramme(programme)
  nudgeMusicClients()
  // The request cut in at the queue head — warm ITS caches, not the old head's.
  prefetchUpcomingEntry()
  return { success: true, title: entry.title }
}

// ----------------------------------------------------------------------------
// Programme panel (visible, editable queue)
// ----------------------------------------------------------------------------

export function getProgrammeSnapshot(): {
  entries: Array<{
    encryptedId: string
    title: string
    say?: string
    note?: string
    playFlag?: boolean
  }>
  onDeck?: string
} {
  const store = getRadioStore()
  return {
    entries: store.readProgramme().entries.map(entry => ({
      encryptedId: entry.encryptedId,
      title: entry.title,
      say: entry.say,
      note: entry.note,
      playFlag: entry.playFlag,
    })),
    onDeck: store.readBrief().onDeck?.title,
  }
}

/**
 * Panel edits. All synchronous read-modify-writes through the store in the
 * main process — the conductor pops entries on the same event loop, so there
 * is no interleaving to race. The conductor stays the only CONSUMER of the
 * programme; these are the user's explicit orders about what it consumes.
 */
export function applyProgrammeAction(
  action:
    | { kind: 'remove'; encryptedId: string }
    | { kind: 'promote'; encryptedId: string }
    | { kind: 'move'; encryptedId: string; toIndex: number },
): { success: boolean; error?: string } {
  const store = getRadioStore()
  const programme = store.readProgramme()
  const index = programme.entries.findIndex(
    entry => entry.encryptedId.toLowerCase() === action.encryptedId.toLowerCase(),
  )
  // The entry may have been popped by the conductor between the panel's read
  // and the click — a no-op, not an error.
  if (index === -1) return { success: true }

  const [entry] = programme.entries.splice(index, 1)
  if (action.kind === 'remove') {
    // Removing from the queue IS the strongest taste signal: the DJ's next
    // batch reads skipped history and steers away.
    store.recordSkipped(entry.title, entry.encryptedId)
  } else if (action.kind === 'promote') {
    programme.entries.unshift(entry)
  } else {
    const to = Math.max(0, Math.min(programme.entries.length, action.toIndex))
    programme.entries.splice(to, 0, entry)
  }
  store.writeProgramme(programme)
  nudgeMusicClients()
  // Remove/promote/move can all change which entry plays next.
  prefetchUpcomingEntry()
  return { success: true }
}

/**
 * Heart the current song. The AI is forbidden from touching 红心; the bar's
 * button is the legitimate path — the click IS the explicit user intent. The
 * song id comes from onDeck (the only place the current song's id survives),
 * so this works for radio-started songs only.
 */
export async function likeCurrentSong(): Promise<{ success: boolean; error?: string }> {
  const store = getRadioStore()
  // Radio-started songs are known via onDeck; anything else may have been
  // reverse-identified from the player's title (a same-source compare, which
  // is safe — the cross-source title comparison is what got banned).
  const playingTitle = getMusicNowPlaying()?.title
  const identified =
    identifiedCurrent && playingTitle === identifiedCurrent.title ? identifiedCurrent : null
  const candidate = identified ?? store.readBrief().onDeck
  if (!candidate) {
    return { success: false, error: '不知道这首歌的 id,暂时没法红心' }
  }
  try {
    await getReliableRunner().run(
      'server',
      getActiveMusicProvider().cli.build.like({
        encryptedId: candidate.encryptedId,
        originalId: candidate.originalId,
        title: candidate.title,
      }),
    )
    store.recordLoved(playingTitle ?? candidate.title, candidate.encryptedId)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '红心失败' }
  }
}

// ----------------------------------------------------------------------------
// Lyrics (the composer's placeholder)
// ----------------------------------------------------------------------------

const lyricCache = new Map<string, MusicLyricLine[]>()
/** In-flight lyric fetches, so a prefetch and the start flow share one call. */
const lyricInflight = new Map<string, Promise<MusicLyricLine[]>>()
let currentLyrics: MusicLyrics | null = null

export function getMusicLyrics(): MusicLyrics | null {
  return currentLyrics
}

/**
 * Fetch (once per song, cached) and push the timed lyrics for a song the radio
 * just started. Best-effort: no lyrics is ambience missing, never an error the
 * user sees. One server call per new song — the cache keeps replays free.
 */
/** Fetch (cached) the timed lyric lines for a song — shared by the lyric push
 * and the talk-over-the-intro timing decision. */
async function getLyricLines(entry: OnethingRadioProgrammeEntry): Promise<MusicLyricLine[]> {
  const cached = lyricCache.get(entry.encryptedId)
  if (cached) return cached
  let inflight = lyricInflight.get(entry.encryptedId)
  if (!inflight) {
    inflight = (async () => {
      try {
        const provider = getActiveMusicProvider()
        const stdout = await getReliableRunner().run('server', provider.cli.build.lyric(entry))
        // The provider's parser degrades garbage to "no lyrics", never a throw.
        const lines = provider.cli.parse.lyric(stdout)
        // Evict the oldest entry, not the whole cache — clear-all used to wipe
        // the CURRENT song's lines too, forcing a refetch mid-play.
        if (lyricCache.size > 20) {
          const oldest = lyricCache.keys().next().value
          if (oldest !== undefined) lyricCache.delete(oldest)
        }
        lyricCache.set(entry.encryptedId, lines)
        return lines
      } finally {
        // Failures are not cached: the next caller retries the fetch.
        lyricInflight.delete(entry.encryptedId)
      }
    })()
    lyricInflight.set(entry.encryptedId, inflight)
  }
  return inflight
}

async function pushLyricsFor(entry: OnethingRadioProgrammeEntry, playerTitle: string): Promise<void> {
  try {
    const lines = await getLyricLines(entry)
    // The PLAYER's title, not the DJ's: the renderer guards lyrics against the
    // bar's now-playing title, and only the player agrees with itself.
    currentLyrics = { title: playerTitle, lines }
    broadcastVoiceHostMessage({ channel: IPC_CHANNELS.MUSIC_LYRICS, payload: currentLyrics })
  } catch (error) {
    log.warn('fetch lyrics failed', { title: entry.title }, error)
  }
}

// ----------------------------------------------------------------------------
// Reverse identification (songs someone else started)
// ----------------------------------------------------------------------------

let lastObservedTitle: string | undefined
/** Titles we already failed to identify — do not burn a search per poll. */
const identifyMisses = new Set<string>()
/** The identified currently-playing song; title is the PLAYER's own string. */
let identifiedCurrent: (OnethingMusicIdentifiedSong & { title: string }) | null = null

/**
 * Ceremonies follow the song, not the code path: when a song WE did not start
 * shows up (the model's manual `play`), recover its id by exact-title search
 * and push its lyrics too. Exact or nothing — captioning the wrong song is
 * worse than no caption.
 */
async function observeUnknownSong(sample: OnethingMusicNowPlaying | null): Promise<void> {
  if (sample?.status !== 'playing' || !sample.title) return
  if (sample.title === lastObservedTitle) return
  lastObservedTitle = sample.title
  identifiedCurrent = null
  // Radio-started songs already had their ceremonies at start (the lyrics
  // push carries the player's title, so this same-source compare is safe).
  if (currentLyrics?.title === sample.title) return
  if (identifyMisses.has(sample.title)) return
  try {
    const provider = getActiveMusicProvider()
    const stdout = await getReliableRunner().run('server', provider.cli.build.search(sample.title, 10))
    const match = matchSongFromSearch(provider.cli.parse.searchRecords(stdout), sample.title)
    if (!match) {
      // Bounded: a long-running station observing many unidentifiable titles
      // must not leak; dropping the oldest only means one extra search someday.
      if (identifyMisses.size >= 200) {
        const oldest = identifyMisses.values().next().value
        if (oldest !== undefined) identifyMisses.delete(oldest)
      }
      identifyMisses.add(sample.title)
      return
    }
    identifiedCurrent = { ...match, title: sample.title }
    void pushLyricsFor(
      { encryptedId: match.encryptedId, originalId: match.originalId, title: sample.title },
      sample.title,
    )
  } catch (error) {
    log.warn('identify current track failed', { title: sample.title }, error)
  }
}

/**
 * Hook the conductor into the now-playing watcher. Idempotent; called at IPC
 * init right after the watcher starts. Costs nothing while the radio is off —
 * every sample begins with a brief read that says "inactive".
 */
/** The master switch, live-readable so a settings toggle needs no restart. */
function isMusicEnabled(): boolean {
  return getSettings().music?.enabled === true
}

/**
 * Evidence log for the premature-stop investigation (2026-07-19: 「与光」
 * audibly died ~40s into a 3m40s song after a pause→seek 0→resume hold; the
 * conductor then honestly advanced). One line per player state transition,
 * stamped with WHERE in the song it happened — a stop at 40s/220s is a stream
 * death, a stop at 218s/220s is a song ending. Remove with the other probes.
 */
let lastWatchedSample: OnethingMusicNowPlaying | null = null

function describeSample(sample: OnethingMusicNowPlaying | null): string {
  if (!sample) return 'null'
  const pos = Math.round(sample.position)
  const dur = sample.duration !== undefined ? `/${Math.round(sample.duration)}s` : ''
  return `${sample.status}「${sample.title ?? '?'}」${pos}s${dur}`
}

function logSampleTransition(sample: OnethingMusicNowPlaying | null): void {
  const prev = lastWatchedSample
  const changed =
    (prev?.status ?? 'null') !== (sample?.status ?? 'null') ||
    (prev?.title ?? '') !== (sample?.title ?? '')
  // Keep the freshest position even between logged transitions, so the
  // "playing → stopped" line carries where playback actually was.
  lastWatchedSample = sample
  if (!changed) return
  log.debug('player state changed', { from: describeSample(prev), to: describeSample(sample) })
}

export function startRadioConductor(): void {
  if (conductor) return
  // Cold-start correctness for the backend gate in playProgrammeEntry: the
  // in-memory playerBackend defaults to mpv until an env probe runs, and
  // nothing probes unless the settings tab is opened — an orpheus install
  // would be waved through. One boot-time probe pins the real value.
  void getMusicService()
    .refreshEnv()
    .catch(() => {})
  conductor = createOnethingRadioConductor({
    store: getRadioStore(),
    runner: getReliableRunner(),
    playSong: playProgrammeEntry,
    wakeDj: wakeRadioDj,
    diagnoseStartFailure: diagnoseRadioStartFailure,
    // A start's patter speaks into deliberate silence; without this the
    // conductor reads that silence as "song over" and pops entries into the
    // mutex (one song burned per long patter).
    startInFlight: () => playStarting !== null,
    onLateStart: () => {
      // A start we misjudged is audibly playing: onDeck knows which song —
      // fire the ceremonies it missed.
      const onDeck = getRadioStore().readBrief().onDeck
      if (!onDeck) return
      onSongStarted(onDeck, getMusicNowPlaying()?.title ?? onDeck.title)
    },
    logger: consoleLog,
  })
  setMusicSampleListener(sample => {
    // The master switch, enforced where everything converges: with music
    // disabled the conductor never ticks (no advance, no DJ wakes, no merges)
    // and the radio stays genuinely dormant — the switch used to be cosmetic.
    if (!isMusicEnabled()) return
    logSampleTransition(sample)
    conductor?.onSample(sample)
    void observeUnknownSong(sample)
  })
}

export function disposeRadioConductor(): void {
  setMusicSampleListener(null)
  conductor = null
  radioStore = null
  // Full module-state reset: a dispose→re-init cycle (tests, future hot
  // reconfiguration) must not inherit stale grants, caches, or a held mutex.
  grantedSessions.clear()
  lyricCache.clear()
  lyricInflight.clear()
  resetDjPatterCache()
  currentLyrics = null
  identifyMisses.clear()
  lastObservedTitle = undefined
  identifiedCurrent = null
  playStarting = null
  playStartingEntry = null
  gestureStart = null
  lastWatchedSample = null
}
