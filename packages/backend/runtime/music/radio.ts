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
  MUSIC_APP_ID,
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
  renderRadioTalkPrompt,
  type OnethingMusicIdentifiedSong,
  type OnethingMusicNowPlaying,
  type OnethingRadioConductor,
  type OnethingRadioProgrammeEntry,
  type OnethingRadioStore,
} from '@onething/backend/runtime/music/index'
import { broadcastVoiceHostMessage } from '@onething/backend/runtime/voice/host-ports.wiring'
import { IPC_CHANNELS } from '@shared/ipc.js'
import type { MusicHostDoing, MusicHostLog, MusicHostState, MusicLyricLine, MusicLyrics } from '@shared/ipc/music.js'
import { describeHostDoing, projectHostLog } from '@onething/backend/runtime/music/host-log'
import { addGrant } from '@onething/backend/core'
import { writeJsonFile } from '@onething/backend/runtime/storage/storage-primitives'
import { agentExists, createAgent, findAgent, updateAgent } from '@onething/backend/runtime/agents/store-bound.wiring'
import { markSessionUnattended } from '@onething/backend/runtime/permissions/unattended'
import { resolveCollabVenue } from '@onething/backend/runtime/collab'
import { getSettings } from '@onething/backend/stores/settings.js'
import * as sessions from '@onething/backend/stores/sessions.js'
import { sessionReads } from '../../session/reads.js'
import { DEFAULT_SESSION_OWNER, sessionAccess, SessionAccessError } from '@onething/backend/session/access.js'
import type { MusicServiceScope } from './service.js'
import type { HostVoice } from './host-voice.js'
import type { MusicMoments } from './moments.js'
// 类型口 —— 编译期擦除,不给这只模块添一条到事件系统的**运行时**边(见 `wakeRadioDj`
// 里那段动态 import 的理由)。
import type { EventBus } from '@onething/backend/events/event-bus.js'

import { SESSION_COMMAND_TYPES, SESSION_EVENT_TYPES } from '@shared/events/index.js'
import { consolePort, getLogger } from '@onething/backend/runtime/logging/configure-logging'
import type { OnethingRadioConductorOptions } from '@onething/backend/runtime/music/radio-conductor'

const log = getLogger('music.radio')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog = consolePort(log)


import { MusicWorkOwner } from './lifetime.js'
import { LastPlaybackRecorder } from './last-playback.js'
import { getCurrentBackend } from '@onething/backend/current.js'

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

/**
 * 「电台能往这条会话里发话吗」。只有普通聊天场子(`resolveCollabVenue(kind) === 'chat'`)能:
 * 协作房 / 派工 / agent 私聊由协作协调器驱动,引擎对非协调器来源的内部消息**直接拒收**
 * (`stream-engine.ts`「internal source refused on coordinator-driven session」)。
 * 09-26 真机:复用挑到了 7 月那条与 DJ 的私聊房 `agent-dm-radio-dj`,每一次唤醒都被这么
 * 静默拒掉,电台「排了半个小时啥也没」。判据只认协作域那一句,不自己认 id 前缀。
 */
export function isDrivableDjSession(session: { kind?: string | null } | null | undefined): boolean {
  return session !== null && session !== undefined && resolveCollabVenue(session.kind) === 'chat'
}

/** Newest radio-dj session light enough to keep using (index metadata only). */
export function pickReusableRadioDjSession(
  list: Array<{ id: string; agentId?: string; kind?: string | null; updatedAt: number; messageCount?: number }>,
): string | null {
  const candidates = list
    .filter(
      meta =>
        meta.agentId === RADIO_DJ_AGENT_ID
        && isDrivableDjSession(meta)
        && (meta.messageCount ?? 0) <= DJ_SESSION_MAX_MESSAGES,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
  return candidates[0]?.id ?? null
}

export function createRadioScope(options: {
  storePath: string; assertOwned?: () => void; service: MusicServiceScope
  /**
   * 主持人声音(宠物 P3,§10.2):每次说话现问一次 —— 组合根可能在这一代作用域建好之后
   * 才把宠物接管绑上来。电台只认这个接口,不认识谁在说。
   */
  hostVoice: () => HostVoice
  /**
   * 听歌这件事的事实(宠物 P4,§11.1)。实例住在音乐子系统上(寿命 = backend),电台只在
   * 那几处真发生的地方报一声;缺席 = 不报(测试)。
   */
  moments?: MusicMoments
  /** 手上那份歌词换了(子系统把它发成 `lyricsChanged`)。缺席 = 不报(测试)。 */
  announceLyrics?: (lyrics: MusicLyrics) => void
  /**
   * 主持人抽屉的两条事实(§16.3):`hostActivity`(状态牌那一句变了,负载 = `hostState()`)与
   * `hostLogChanged`(记录流多了东西,负载空)。子系统把它们发成 `music:radio` 上的资源事件。
   * 缺席 = 不报(测试)。
   */
  announceHostFact?: (event: 'hostActivity' | 'hostLogChanged', payload: Record<string, unknown>) => void
}) {
  const owner = new MusicWorkOwner(options.assertOwned)
  const { getActiveMusicProvider, getMusicNowPlaying, getMusicService, nudgeMusicClients,
    refreshMusicNowPlaying, setMusicSampleListener, beginMusicCommand, assumeMusicNowPlaying } = options.service
  const prefetchDjPatter = (text: string, title: string): void => options.hostVoice().prefetch(text, title)
  /**
   * 报一件听歌的事实(§11.1)。**不抛**:一个坏掉的订阅者不该让起播 / 跳过 / 红心那条正事失败。
   */
  const reportMoment = (report: (moments: MusicMoments) => void): void => {
    const moments = options.moments
    if (!moments || owner.signal.aborted) return
    try {
      report(moments)
    } catch (error) {
      log.warn('music moment report failed', {}, error)
    }
  }
  /**
   * 报一条主持人事实。**不抛**,理由同 `reportMoment`:一个坏掉的订阅者不该让发消息 /
   * 收工那条正事失败。
   */
  const reportHostFact = (event: 'hostActivity' | 'hostLogChanged', payload: Record<string, unknown>): void => {
    const announce = options.announceHostFact
    if (!announce) return
    try {
      announce(event, payload)
    } catch (error) {
      log.warn('music host fact report failed', { event }, error)
    }
  }
  /** 正在说的口播各自的中止源:关台 / 停止电台时一起拉掉(§10.6「关台中途」那一行)。 */
  const patterAborts = new Set<AbortController>()

  /**
   * 说一句口播,说完 resolve(不抛)。
   *
   * P4 起电台**不再自己压音量**(§11.3):出声的那一方在放之前 / 之后发一对 `speech:activity`,
   * 音乐子系统订它,播放器正在放时压到 35%、说完恢复(`SpeechActivityDuck`)。两处各压一次会把
   * 音量压到 35% 的 35%。
   */
  const speakDjPatter = async (text: string, title: string, overMusic = false): Promise<void> => {
    const abort = new AbortController()
    patterAborts.add(abort)
    try {
      await options.hostVoice().speak(text, {
        title,
        overMusic,
        signal: AbortSignal.any([abort.signal, owner.signal]),
      })
    } finally {
      patterAborts.delete(abort)
    }
  }
let radioStore: OnethingRadioStore | null = null
/** 上次放到哪了(09-19):守护进程还活着时抄进简报,续播从那一秒接着放。 */
const lastPlayback = new LastPlaybackRecorder(() => getRadioStore())
let conductor: OnethingRadioConductor | null = null
/** 订着「这批会话没了」的那只退订;开台时接上,收尾时拆(见 `startRadioConductor`)。 */
const deletedSessionsWatch: { stop: (() => void) | null } = { stop: null }
/** Sessions this process already pre-granted music-dir writes to. */
const grantedSessions = new Set<string>()

function getRadioStore(): OnethingRadioStore {
  owner.assertActive()
  const provider = getActiveMusicProvider()
  if (!radioStore) {
    const instance = createOnethingRadioStore(path.join(options.storePath, 'music'), {
      ids: provider.ids, providerId: provider.descriptor.id,
    })
    radioStore = new Proxy(instance, {
      get(target, property) {
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? owner.wrap(value.bind(target)) : value
      },
    })
  }
  const sessionId = radioStore.readBrief().sessionId
  if (sessionId) sessionAccess.resolveOptional(DEFAULT_SESSION_OWNER, sessionId, 'read')
  return radioStore
}

function getReliableRunner() {
  const provider = getActiveMusicProvider()
  return createOnethingMusicReliableRunner({
    runner: options.service.runner,
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
  const brief = store.readBrief()
  if (brief.sessionId) sessionAccess.resolveOptional(DEFAULT_SESSION_OWNER, brief.sessionId, 'write')
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

  if (brief.sessionId) {
    const existing = sessions.getSession(brief.sessionId)
    if (existing && !isDrivableDjSession(existing)) {
      // 简报指着一间协作房(09-26 真机):往里发话会被引擎拒收,换一条能驱动的。
      log.warn('dj session is a collab venue, not drivable by the radio; picking another', {
        sessionId: brief.sessionId,
        kind: existing.kind,
      })
    } else if (existing && !isDjSessionOversized(existing)) {
      claimDjSessionForMusic(brief.sessionId, existing)
      return brief.sessionId
    } else if (existing) {
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
  if (brief.sessionId && !isDrivableDjSession(sessions.getSession(brief.sessionId))) {
    const candidate = pickReusableRadioDjSession(sessionAccess.filter(DEFAULT_SESSION_OWNER, sessions.getSessionsList()))
    if (candidate) {
      sessionAccess.resolve(DEFAULT_SESSION_OWNER, candidate, 'write')
      claimDjSessionForMusic(candidate, sessions.getSession(candidate))
      store.writeBrief({ ...brief, sessionId: candidate })
      log.info('radio dj session reused', { sessionId: candidate, previous: brief.sessionId })
      return candidate
    }
  }

  const sessionId = randomUUID()
  // 音乐 app 自己的会话(`app: 'music'`,2026-09-26 用户:「电台的 session 不想在列表里
  // 能看见,最好只和音乐 app 绑定」):会话列表不列它、检索不给它、建它不抢当前会话;
  // 只有音乐面上点主持人能打开它。
  sessions.createSession(sessionId, '电台', { initialOwner: DEFAULT_SESSION_OWNER, app: MUSIC_APP_ID })
  sessions.updateSessionAgent(sessionId, RADIO_DJ_AGENT_ID)
  store.writeBrief({ ...brief, sessionId })
  log.info('radio dj session created', { sessionId, previous: brief.sessionId })
  return sessionId
}

/**
 * 把一条 DJ 会话盖上音乐 app 的归属戳。老会话(09-26 之前建的、以及 7 月留下的那些
 * 「电台」会话)没有这一格,列表里就还看得见 —— 复用或续用到哪一条就盖哪一条,
 * 开台时再把索引里所有 radio-dj 的存量一次盖完(`startRadioConductor`)。
 */
function claimDjSessionForMusic(sessionId: string, session: { app?: string; kind?: string | null } | undefined): void {
  if (!session || session.app === MUSIC_APP_ID || !isDrivableDjSession(session)) return
  sessions.patchSessionFields(sessionId, { app: MUSIC_APP_ID }, meta => { meta.app = MUSIC_APP_ID })
  log.info('radio dj session claimed by the music app', { sessionId })
}

/**
 * 存量:索引里每一条**普通场子**的 radio-dj 会话都归音乐 app,不管是哪一代留下的。
 * 协作房(与 DJ 的私聊房之流)不是电台的记录,不盖;09-26 那一版误盖过的这里摘回来。
 */
function claimLegacyDjSessions(): void {
  const metas = sessionAccess.filter(DEFAULT_SESSION_OWNER, sessions.getSessionsList())
  let claimed = 0
  let released = 0
  for (const meta of metas) {
    if (meta.agentId !== RADIO_DJ_AGENT_ID) continue
    const drivable = isDrivableDjSession(meta)
    if (drivable && meta.app !== MUSIC_APP_ID) {
      sessions.patchSessionFields(meta.id, { app: MUSIC_APP_ID }, index => { index.app = MUSIC_APP_ID })
      claimed += 1
    } else if (!drivable && meta.app === MUSIC_APP_ID) {
      sessions.patchSessionFields(meta.id, { app: undefined }, index => { delete index.app })
      released += 1
    }
  }
  if (claimed > 0 || released > 0) {
    log.info('legacy radio dj sessions reconciled with the music app', { claimed, released })
  }
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
  sessionAccess.resolve(DEFAULT_SESSION_OWNER, sessionId, 'permission')
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
  owner.assertActive()
  return owner.track((async () => {
  sessionAccess.resolve(DEFAULT_SESSION_OWNER, sessionId, 'read')
  try {
    // Dynamic import mirrors the engine imports below: radio.ts is reachable
    // from the variable gateways, and static graph edges here have bitten
    // unrelated test module graphs before.
    const { getVariableRegistry } = await import('@onething/backend/runtime/variables/registry')
    sessionAccess.resolve(DEFAULT_SESSION_OWNER, sessionId, 'read')
    const variables = await getVariableRegistry().list({ sessionId })
    sessionAccess.resolve(DEFAULT_SESSION_OWNER, sessionId, 'read')
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
    if (error instanceof SessionAccessError) throw error
    log.warn('life context unavailable, opening plain', {}, error)
    return ''
  }

  })())
}

/**
 * How long a stated intent survives without being re-set. Past this, the next
 * DJ wake drops it and self-directs by time + history — so last session's
 * 午睡歌曲 can't haunt tonight's late-night radio even if the station was only
 * resumed, never freshly opened. Ages from the last real set/open, not plays.
 */
const RADIO_INTENT_TTL_MS = 6 * 60 * 60 * 1_000

/**
 * The DJ session, ready to be driven: it exists, it may write the music dir, and
 * nobody is watching it. Shared by the automated wakes and by 「跟主持人说话」 —
 * both land in the SAME session, so their preconditions are one piece of code.
 */
function ensureDjSessionReady(store: OnethingRadioStore): string {
  const sessionId = ensureRadioSession(store)
  grantMusicDirAccess(sessionId, path.dirname(store.programmePath))
  // Nobody watches DJ turns; a permission dialog there is a silent hang.
  // Marked unattended, asks become immediate explained denials instead.
  markSessionUnattended(sessionId)
  return sessionId
}

/**
 * One message into the DJ session. The model override (设置 → 音乐 → 电台编排) and
 * `suppressTitleGeneration` ride here, so 「人说的话」 and the automated wakes reach
 * the engine through **one** `SEND_MESSAGE` — different words, identical delivery.
 */
async function emitDjMessage(sessionId: string, content: string, bus: EventBus): Promise<void> {
  // The DJ's own model, same idea as toolCallModel: curation is background work
  // in a session nobody watches, so it should not inherit whatever model the
  // radio session last used. Empty providerId = follow the session default.
  // Think mode rides the override so it stays independent of the global
  // per-model toggle.
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

  owner.assertActive()
  sessionAccess.resolve(DEFAULT_SESSION_OWNER, sessionId, 'write')
  markDjWorking(sessionId, bus)
  await bus.emit(sessionId, {
    type: SESSION_COMMAND_TYPES.SEND_MESSAGE,
    content,
    source: 'radio',
    origin: { transport: 'api', source: 'radio', receivedAt: Date.now() },
    // The session is deliberately named 电台; the drive prompt is not a title.
    suppressTitleGeneration: true,
    ...modelOverride,
  }, { executionContext: DEFAULT_SESSION_OWNER })
  log.info('radio dj message sent', { sessionId, provider: djModel?.providerId, model: djModel?.model })
}

/**
 * 「主持人此刻在不在干活」(2026-09-26,起因:界面上「正在准备歌曲」是按「电台开着 +
 * 节目单空」算出来的,后端其实什么都没在做)。每发一条消息进 DJ 会话就点亮,那条
 * 会话的流结束 / 报错就熄灭;十分钟没等到任何一句也熄灭 —— 一只挂死的订阅不该让
 * 界面永远说「在准备」。读的人是 `radioToolStatus` / `readRadioBrief`(`djWorking`)。
 */
const DJ_WORKING_TIMEOUT_MS = 10 * 60_000
/**
 * 同一只持有者再装两格(主持人抽屉,§16.3):
 *  · `doing` —— 状态牌那一句。发消息 = 在想;每一次工具调用 = 那条调用经动词表
 *    (`runtime/music/host-log.ts`)翻成的现在时;这一轮收场 = 清空。
 *  · `published` —— 上一次报出去的 `hostActivity` 长什么样,一样就不重报。
 *  · `replacing` —— 新一轮顶掉旧一轮时,旧一轮的收场不报「收工了」:紧接着就是「在想」,
 *    中间那一帧 `working: false` 是假话。
 */
const djWorking: {
  cleanup: (() => void) | null
  doing: MusicHostDoing | undefined
  published: string
  replacing: boolean
} = { cleanup: null, doing: undefined, published: '', replacing: false }

/** 主持人此刻的状态牌(简报的 `host` 一格,也是 `hostActivity` 的负载)。 */
function hostState(): MusicHostState {
  const working = djWorking.cleanup !== null
  return working && djWorking.doing ? { working, doing: { ...djWorking.doing } } : { working }
}

/** 状态牌变了就报一条 `hostActivity`;没变不报。 */
function publishHostState(): void {
  const state = hostState()
  const key = JSON.stringify(state)
  if (key === djWorking.published) return
  djWorking.published = key
  reportHostFact('hostActivity', { ...state })
}

function markDjWorking(sessionId: string, bus: EventBus): void {
  djWorking.replacing = true
  try {
    djWorking.cleanup?.()
  } finally {
    djWorking.replacing = false
  }
  const cleanups: Array<() => void> = []
  const finish = (reason: string): void => {
    if (djWorking.cleanup !== stop) return
    djWorking.cleanup = null
    djWorking.doing = undefined
    for (const cleanup of cleanups.splice(0)) {
      try { cleanup() } catch { /* 退订失败不该拦住别的退订 */ }
    }
    log.info('radio dj finished', { sessionId, reason })
    nudgeMusicClients()
    // 收件箱只有指挥会并,而指挥的拍子是采样:不补这一拍,刚排好的歌要等下一次轮询
    // (没在放时 20 秒)才进节目单、才起播。一次 `state` 读 = 一次采样 = 指挥马上走一拍。
    void owner.track(refreshMusicNowPlaying()).catch(() => undefined)
    if (!djWorking.replacing) {
      publishHostState()
      reportHostFact('hostLogChanged', {})
    }
  }
  const stop = (): void => finish('replaced')
  /** 一次工具调用(参数流开头 / 参数齐了)→ 状态牌那一句。参数还没流出来 = 在想。 */
  const doingFrom = (toolCall: unknown, toolName?: string): void => {
    if (djWorking.cleanup !== stop) return
    const call = toolCall && typeof toolCall === 'object' ? toolCall as Parameters<typeof describeHostDoing>[0] : { toolName }
    djWorking.doing = describeHostDoing(call)
    publishHostState()
  }
  cleanups.push(
    bus.on(sessionId, SESSION_EVENT_TYPES.STREAM_COMPLETE, () => finish('complete'), 'radio dj working'),
    bus.on(sessionId, SESSION_EVENT_TYPES.STREAM_ERROR, () => finish('error'), 'radio dj working'),
    bus.on(sessionId, SESSION_EVENT_TYPES.STREAM_ABORTED, () => finish('aborted'), 'radio dj working'),
    bus.on(sessionId, SESSION_EVENT_TYPES.TOOL_INPUT_START, ({ event }) => doingFrom(event.toolCall, event.toolName), 'radio dj working'),
    bus.on(sessionId, SESSION_EVENT_TYPES.TOOL_CALL, ({ event }) => {
      doingFrom(event.toolCall)
      if (djWorking.cleanup === stop) reportHostFact('hostLogChanged', {})
    }, 'radio dj working'),
    // 结果落定:卡片上多了摘要。状态牌不动 —— 他下一步干什么由下一条调用说。
    bus.on(sessionId, SESSION_EVENT_TYPES.TOOL_RESULT, () => {
      if (djWorking.cleanup === stop) reportHostFact('hostLogChanged', {})
    }, 'radio dj working'),
  )
  const timer = setTimeout(() => finish('timeout'), DJ_WORKING_TIMEOUT_MS)
  timer.unref?.()
  cleanups.push(() => clearTimeout(timer))
  djWorking.cleanup = stop
  djWorking.doing = { kind: 'thinking', label: '在想' }
  publishHostState()
}
function isDjWorking(): boolean {
  return djWorking.cleanup !== null
}

/**
 * 主持人抽屉的记录流(§16.3):DJ 那条会话翻成的人话行,只交尾部。会话不在(简报没 id /
 * 被删)= 空行 + `absent`,不是一次失败。
 */
function readHostLog(limit?: number): MusicHostLog {
  owner.assertActive()
  const sessionId = getRadioStore().readBrief().sessionId
  if (!sessionId || !sessions.getSession(sessionId)) return { rows: [], absent: true, truncated: false }
  sessionAccess.resolve(DEFAULT_SESSION_OWNER, sessionId, 'read')
  const { messages } = sessionReads.listMessages(sessionId)
  return projectHostLog(messages, limit === undefined ? {} : { limit })
}

async function wakeRadioDj(): Promise<void> {
  owner.assertActive()
  return owner.track((async () => {
  const store = getRadioStore()
  // Before rendering the DJ prompt, age out a stale intent so a resumed or
  // conductor-woken station (no fresh open) doesn't quote an old direction.
  const brief = store.readBrief()
  if (brief.sessionId) sessionAccess.resolveOptional(DEFAULT_SESSION_OWNER, brief.sessionId, 'write')
  store.expireStaleIntent(RADIO_INTENT_TTL_MS)
  const opening = !brief.sessionId || !sessions.getSession(brief.sessionId)
  const sessionId = ensureDjSessionReady(store)

  // Dynamic imports: this module is reachable from the variable gateways, and
  // a static engine import would drag the whole provider stack into every
  // module graph that touches variables (which broke unrelated tests).
  const [{ getStreamEngineSafe }, { getEventBus }] = await Promise.all([
    import('@onething/backend/runtime/engine/engine-layer'),
    import('@onething/backend/events/index.js'),
  ])
  sessionAccess.resolve(DEFAULT_SESSION_OWNER, sessionId, 'write')

  // A run already active in the radio session IS the DJ working — kicking
  // again would interleave two curations in one transcript.
  if (getStreamEngineSafe()?.getController(sessionId)) {
    log.info('radio dj already working, wake skipped', { sessionId })
    return
  }
  log.info('waking radio dj', {
    sessionId,
    opening,
    intent: brief.intent,
    programmeRemaining: store.readProgramme().entries.length,
  })

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

  await emitDjMessage(sessionId, content, getEventBus())

  })())
}

/**
 * ── 跟主持人说话(2026-09-18,正本 `apps/desktop-react/docs/music-panel-2026-09.md` §7.1)──
 *
 * 人打的一句话,当作一条用户消息发进 DJ 那条真会话。**这一条自己什么都不改** ——
 * 不出声、不动播放、不碰节目单;真正的改动是主持人自己用他的工具做的,各自过各自的闸。
 *
 * 回话怎么拿到:发之前就订上这条会话的流结束事件,说完了取这一轮**最后一条 assistant
 * 文本**。三条收手的规矩,每一条都有理由:
 *  · **空文本不算回话** —— 他用工具干完活不吭声是合法的,硬编一句「好的」是替他说话;
 *  · **消息 id 没换也不算** —— 这一轮一条 assistant 消息都没落下时,上一轮那句话还在
 *    那儿摆着,把它当成「他刚回的」就是把旧话冒充新话(发之前先记下那个 id);
 *  · **60s 没说完就放手** —— 不发事件、不报错。他可能正在跑一长串 bash,而人早已不在等了。
 * 关台 / 换 CLI(`owner.signal`)同样是放手:一代作用域收尾时没人再该收到他的回话。
 *
 * 等待**不进 `owner.track`**:drain 要等的是真活儿,不是一只最长 60 秒的闹钟。
 */
const HOST_REPLY_TIMEOUT_MS = 60_000

/** 这一轮他说的那句话。拿不到 / 是空的 = `undefined`(判据写在 `tellRadioHost` 上)。 */
function readDjReply(sessionId: string, sinceMessageId: string | undefined): string | undefined {
  sessionAccess.resolve(DEFAULT_SESSION_OWNER, sessionId, 'read')
  const message = sessionReads.lastMessageOfRole(sessionId, 'assistant')
  if (!message || message.id === sinceMessageId) return undefined
  const text = typeof message.content === 'string' ? message.content.trim() : ''
  return text || undefined
}

async function tellRadioHost(text: string): Promise<{ reply: Promise<string | undefined> }> {
  owner.assertActive()
  return owner.track((async () => {
    const store = getRadioStore()
    const sessionId = ensureDjSessionReady(store)
    const { getEventBus } = await import('@onething/backend/events/index.js')

    sessionAccess.resolve(DEFAULT_SESSION_OWNER, sessionId, 'read')
    const lastBefore = sessionReads.lastMessageOfRole(sessionId, 'assistant')?.id

    // 先订后发:一条回得极快的消息不该因为我们还在 await 自己那一发而漏掉。
    let settle: ((value: string | undefined) => void) | undefined
    const reply = new Promise<string | undefined>(resolve => { settle = resolve })
    let done = false
    const cleanups: Array<() => void> = []
    const finish = (value: string | undefined): void => {
      if (done) return
      done = true
      for (const stop of cleanups.splice(0)) {
        try { stop() } catch { /* 退订失败不该拦住别的退订 */ }
      }
      settle?.(value)
    }

    const bus = getEventBus()
    cleanups.push(
      bus.on(sessionId, SESSION_EVENT_TYPES.STREAM_COMPLETE, () => finish(readDjReply(sessionId, lastBefore)), 'radio tell'),
      // 炸了 = 没有回话。那条错话是会话自己的事,音乐这一侧不转述。
      bus.on(sessionId, SESSION_EVENT_TYPES.STREAM_ERROR, () => finish(undefined), 'radio tell'),
    )
    const timer = setTimeout(() => finish(undefined), HOST_REPLY_TIMEOUT_MS)
    // Node 的 timer 会吊住进程;这一只只是闹钟,不该让谁多活 60 秒。
    timer.unref?.()
    cleanups.push(() => clearTimeout(timer))
    const giveUp = (): void => finish(undefined)
    owner.signal.addEventListener('abort', giveUp, { once: true })
    cleanups.push(() => owner.signal.removeEventListener('abort', giveUp))

    try {
      await emitDjMessage(sessionId, renderRadioTalkPrompt({
        message: text,
        brief: store.readBrief(),
        inboxPath: store.inboxPath,
        programmeRemaining: store.readProgramme().entries.map(entry => entry.title),
      }), bus)
    } catch (error) {
      // 没发出去就没有人会回话 —— 当场退订,别留一只挂 60 秒的订阅。
      finish(undefined)
      throw error
    }
    return { reply }
  })())
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
function onSongStarted(
  entry: OnethingRadioProgrammeEntry,
  playerTitle: string,
  options: { lyricsPushed?: boolean } = {},
): void {
  const store = getRadioStore()
  store.recordPlayed(playerTitle, entry.encryptedId, entry.durationS ?? getMusicNowPlaying()?.duration)
  lastPlayback.songStarted(playerTitle, entry.encryptedId, entry.durationS ?? getMusicNowPlaying()?.duration)
  // 节目单条目没有单独的歌手一格(播放器的标题本来就是「歌名 - 歌手」),`artist` 就不填 —— 不从
  // 标题里拆一个出来冒充。
  reportMoment(moments => moments.trackStarted({ title: playerTitle, encryptedId: entry.encryptedId }))
  if (!options.lyricsPushed) void pushLyricsFor(entry, playerTitle)
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
  '网易云登录过期了,在音乐面里重新登录;登录恢复后电台会自动续播'

/**
 * The conductor's systemic-failure probe (see its option doc): an expired
 * NetEase login makes `play` exit 0 with no sound for EVERY song — 2026-07-17
 * that burned six curated entries under a generic 起播失败. `login --check` is
 * read-only (same command the bash whitelist trusts); a refusal envelope
 * arrives as a thrown `未登录` message. Anything else (timeout, missing
 * binary) is "can't tell" — fail open so per-song handling keeps working.
 */
async function diagnoseRadioStartFailure(): Promise<string | null> {
  owner.assertActive()
  return owner.track((async () => {
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

  })())
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
  owner.assertActive()
  return owner.track((async () => {
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

  })())
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

function markRadioGesture(label: string): void {
  owner.assertActive()
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
 * The in-flight start's song is already audible (verify confirmed it) and the
 * start is only waiting for the host to finish talking over it. From here the
 * bar must say 在放, not 换歌中 (2026-09-27 真机: the song sounded for the whole
 * patter while the panel still said 正在切换, with no lyrics).
 */
let playStartSounding = false

/**
 * The bar's "换歌中" signal: the title being started, undefined when no start
 * is in flight. Covers the whole deliberate-silence window — patter synthesis,
 * the spoken line, play spawn, verify — so the UI stops reading a normal
 * transition as "the radio stalled" (field complaint).
 */
function getRadioStartingTitle(): string | undefined {
  owner.assertActive()
  return playStarting && !playStartSounding ? (playStartingEntry?.title ?? undefined) : undefined
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
  owner.assertActive()
  return owner.track((async () => {
  if (playStarting) {
    await playStarting.catch(() => {})
    throw new RadioStartNotSongsFaultError(`另一次起播正在进行,放弃「${entry.title}」`)
  }

  const timer = createRadioStartTimer(entry.title)
  // Start the lyric fetch with the load, not after it (cached / in flight = no
  // second call): the lyrics should be in hand the moment the song is heard.
  void getLyricLines(entry).catch(() => {})
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
        owner.sleep(LYRIC_DECISION_TIMEOUT_MS).then(() => [] as MusicLyricLine[]),
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
    owner.assertActive()
    const startCommand = getActiveMusicProvider().cli.build.start(entry)
    await reliable.run('start', startCommand.args, startCommand.env)
    timer.mark('play 命令返回')
    if (entry.say && talkOverIntro) {
      // Fire alongside the starting song: with the prefetched synthesis the
      // voice lands right at the top of the intro, before the first vocal.
      void speakDjPatter(entry.say, entry.title, true).catch(error => {
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
        await owner.sleep(PLAY_VERIFY_INTERVAL_MS)
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
    // The song is audible NOW — tell every client at once, before any wait on
    // the patter below: 在放 + the player's title + this song's lyrics.
    // (It used to happen only after the host finished talking, so a patter
    // over the music left the panel on 正在切换 without lyrics for its whole
    // length.) The rest of the ceremony — the played record, the moment, the
    // prefetch — still waits for the start to be final (the station can be
    // stopped mid-patter, and that song must not count as played).
    const playerTitle = confirmedState.title ?? entry.title
    playStartSounding = true
    beginMusicCommand()
    assumeMusicNowPlaying(() => confirmedState)
    void pushLyricsFor(entry, playerTitle)
    nudgeMusicClients()
    void owner.track(refreshMusicNowPlaying()).catch(() => undefined)
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
    // The start is final: the rest of what used to hang off title-matching.
    // 在放 and the lyrics already went out the moment the song was confirmed
    // (above — announce first, lyrics second: 2026-09-25 the lyrics used to
    // land ~200ms before now-playing and every client dropped them).
    onSongStarted(entry, playerTitle, { lyricsPushed: true })
  })()

  playStartingEntry = entry
  playStartSounding = false
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
    playStartSounding = false
    nudgeMusicClients()
  }

  })())
}

/**
 * The bar's "next" is a skip — the strongest taste signal the DJ gets. Called
 * by the music IPC layer before it forwards the command.
 */
function recordRadioSkip(): void {
  owner.assertActive()
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
  if (title) {
    store.recordSkipped(title, brief.onDeck?.encryptedId)
    reportMoment(moments => moments.skipped(title))
  }
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
  log.warn('radio start failed', { title: entry.title }, error)
  getRadioStore().recordError(line)
  return line
}

/** Resume playback by hand — the bar button. Same starter the conductor uses. */
async function resumeRadioPlayback(): Promise<boolean> {
  owner.assertActive()
  return owner.track((async () => {
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
  // The song that was cut off mid-way comes first (09-19: 「播放状态找上次播放的状态」):
  // ⏯ on a stopped player means "continue", and continue means that song, from that second.
  // Otherwise prefer fresh curation; with the programme drained, replay the last song
  // known to have played (played songs die with the player's memory).
  const onDeck = store.readBrief().onDeck
  const resumeAt = onDeck ? lastPlayback.resumePoint(onDeck.encryptedId) : undefined
  const popped = resumeAt === undefined ? takeNextPlayableEntry(store) : undefined
  const entry = popped ?? onDeck
  if (!entry) return false
  try {
    await playProgrammeEntry(entry)
    store.recordError(undefined)
    if (resumeAt !== undefined) {
      await getReliableRunner()
        .run('transport', getActiveMusicProvider().cli.build.seek(resumeAt))
        .catch(error => log.warn('seek to the resume point failed; playing from the top', { resumeAt }, error))
    }
    return true
  } catch (error) {
    if (popped && isEntryReusableFailure(error)) returnEntryToProgramme(store, popped)
    recordStartFailure(entry, error)
    return false
  }

  })())
}

/**
 * The bar's "next" while the radio is on: a skip is recorded by the IPC layer,
 * and the next programme entry starts immediately — there is no player queue
 * to advance anymore, the conductor is the queue. No onDeck fallback: the user
 * is skipping AWAY from that song, replaying it would be mockery.
 */
async function skipToNextRadioSong(): Promise<boolean> {
  owner.assertActive()
  return owner.track((async () => {
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

  })())
}

/**
 * The bar's "prev" while the radio is on: there is no player queue to step
 * back through, so ⏮ means "this song from the top" — replay onDeck.
 */
async function replayCurrentRadioSong(): Promise<boolean> {
  owner.assertActive()
  return owner.track((async () => {
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

  })())
}

function isRadioActive(): boolean {
  owner.assertActive()
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
  djWorking: boolean
} {
  owner.assertActive()
  const store = getRadioStore()
  const brief = store.readBrief()
  return {
    active: brief.active,
    intent: brief.intent,
    programmeLength: store.readProgramme().entries.length,
    nowPlayingTitle: getMusicNowPlaying()?.title,
    lastError: brief.lastError,
    djWorking: isDjWorking(),
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
function openRadioStation(intent: string, options: { clearProgramme: boolean }): void {
  owner.assertActive()
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
  log.info('radio station opened', { intent, retune: options.clearProgramme, sessionId: store.readBrief().sessionId })
  void refreshMusicNowPlaying()
}

async function radioToolOpen(
  intent: string,
  options: { clearProgramme: boolean },
): Promise<ReturnType<typeof radioToolStatus>> {
  owner.assertActive()
  return owner.track((async () => {
  openRadioStation(intent, options)
  return radioToolStatus()

  })())
}

/** Close the station: inactive FIRST, then stop — the order that avoids auto-revive. */
async function radioToolClose(): Promise<ReturnType<typeof radioToolStatus>> {
  owner.assertActive()
  return owner.track((async () => {
  const store = getRadioStore()
  writeJsonFile(store.intentPath, { active: false })
  store.mergeIntent()
  // 正在说的那句口播跟着关台停下(出声的子进程被杀,压下去的音量恢复)。
  for (const abort of patterAborts) abort.abort()
  try {
    await getReliableRunner().run('transport', getActiveMusicProvider().cli.build.stop())
  } catch (error) {
    log.warn('stop on close failed', {}, error)
  }
  await refreshMusicNowPlaying()
  return radioToolStatus()

  })())
}


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
async function requestSong(
  query: string,
): Promise<{ success: boolean; title?: string; error?: string }> {
  owner.assertActive()
  return owner.track((async () => {
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
    durationS: playable.durationS,
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

  })())
}

// ----------------------------------------------------------------------------
// Programme panel (visible, editable queue)
// ----------------------------------------------------------------------------

function getProgrammeSnapshot(): {
  entries: Array<{
    encryptedId: string
    title: string
    say?: string
    note?: string
    playFlag?: boolean
    durationS?: number
  }>
  onDeck?: string
} {
  owner.assertActive()
  const store = getRadioStore()
  return {
    entries: store.readProgramme().entries.map(entry => ({
      encryptedId: entry.encryptedId,
      title: entry.title,
      say: entry.say,
      note: entry.note,
      playFlag: entry.playFlag,
      durationS: entry.durationS,
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
function applyProgrammeAction(
  action:
    | { kind: 'remove'; encryptedId: string }
    | { kind: 'promote'; encryptedId: string }
    | { kind: 'move'; encryptedId: string; toIndex: number },
): { success: boolean; error?: string } {
  owner.assertActive()
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
async function likeCurrentSong(): Promise<{ success: boolean; error?: string }> {
  owner.assertActive()
  return owner.track((async () => {
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
    reportMoment(moments => moments.liked(playingTitle ?? candidate.title))
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '红心失败' }
  }

  })())
}

// ----------------------------------------------------------------------------
// Lyrics (the composer's placeholder)
// ----------------------------------------------------------------------------

const lyricCache = new Map<string, MusicLyricLine[]>()
/** In-flight lyric fetches, so a prefetch and the start flow share one call. */
const lyricInflight = new Map<string, Promise<MusicLyricLine[]>>()
let currentLyrics: MusicLyrics | null = null

/** 换手上那份歌词并告诉读者(推送一条给旧宿主,再报一条事实给资源订阅方)。 */
function setCurrentLyrics(next: MusicLyrics): void {
  currentLyrics = next
  broadcastVoiceHostMessage({ channel: IPC_CHANNELS.MUSIC_LYRICS, payload: next })
  try {
    options.announceLyrics?.(next)
  } catch (error) {
    log.warn('announce lyrics failed', {}, error)
  }
}

function getMusicLyrics(): MusicLyrics | null {
  owner.assertActive()
  if (currentLyrics === null) fetchLastPlaybackLyrics()
  return currentLyrics
}

/**
 * 重新打开应用时,播放器还没起、这台进程手上没有任何歌词 —— 而面板画的是「上次放到哪」那首、停在那一秒
 * (09-19)。歌词也该是那一首的(09-25「重新打开的时候,歌词、进度等是否正常」):只要上次那首是电台起的
 * (手上有它的 id),就照起播时同一条路去取、取到了照样推一声,读者据那一声重读。
 * 播放器此刻在放别的歌就不取 —— 那时该有歌词的是正在放的那首,由它自己的起播 / 采样去推。
 * 只取一次不靠额外的记号:取到(或确认取不到)之后手上就有了一份歌词,不再是 `null`;取的路上再问,
 * `getLyricLines` 按 id 合并成同一发。
 */
function fetchLastPlaybackLyrics(): void {
  if (getMusicNowPlaying()?.title) return
  const last = getRadioStore().readBrief().lastPlayback
  if (!last?.encryptedId) return
  void pushLyricsFor({ encryptedId: last.encryptedId, originalId: '', title: last.title }, last.title)
}

/**
 * Fetch (once per song, cached) and push the timed lyrics for a song the radio
 * just started. Best-effort: no lyrics is ambience missing, never an error the
 * user sees. One server call per new song — the cache keeps replays free.
 */
/** Fetch (cached) the timed lyric lines for a song — shared by the lyric push
 * and the talk-over-the-intro timing decision. */
async function getLyricLines(entry: OnethingRadioProgrammeEntry): Promise<MusicLyricLine[]> {
  owner.assertActive()
  return owner.track((async () => {
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

  })())
}

async function pushLyricsFor(entry: OnethingRadioProgrammeEntry, playerTitle: string): Promise<void> {
  owner.assertActive()
  return owner.track((async () => {
  try {
    const lines = await getLyricLines(entry)
    // The PLAYER's title, not the DJ's: the renderer guards lyrics against the
    // bar's now-playing title, and only the player agrees with itself.
    if (owner.signal.aborted) return
    setCurrentLyrics({ title: playerTitle, lines })
  } catch (error) {
    log.warn('fetch lyrics failed', { title: entry.title }, error)
    // 说出来:没取到。不说的话面板会一直等下去(「正在取歌词」永远不结束)。
    if (!owner.signal.aborted) setCurrentLyrics({ title: playerTitle, lines: [], failed: true })
  }

  })())
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
  owner.assertActive()
  return owner.track((async () => {
  if (sample?.status !== 'playing' || !sample.title) return
  if (sample.title === lastObservedTitle) return
  lastObservedTitle = sample.title
  identifiedCurrent = null
  // Radio-started songs already had their ceremonies at start (the lyrics
  // push carries the player's title, so this same-source compare is safe).
  if (currentLyrics?.title === sample.title) return
  if (identifyMisses.has(sample.title)) {
    setCurrentLyrics({ title: sample.title, lines: [], failed: true })
    return
  }
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
      // 认不出这首是谁 = 歌词没处取。说一句,别让面板一直等。
      setCurrentLyrics({ title: sample.title, lines: [], failed: true })
      return
    }
    if (owner.signal.aborted) return
    identifiedCurrent = { ...match, title: sample.title }
    void pushLyricsFor(
      { encryptedId: match.encryptedId, originalId: match.originalId, title: sample.title },
      sample.title,
    )
  } catch (error) {
    log.warn('identify current track failed', { title: sample.title }, error)
    if (!owner.signal.aborted) setCurrentLyrics({ title: sample.title, lines: [], failed: true })
  }

  })())
}

/**
 * Hook the conductor into the now-playing watcher. Idempotent; called at IPC
 * init right after the watcher starts. Costs nothing while the radio is off —
 * every sample begins with a brief read that says "inactive".
 */
/** The master switch, live-readable so a settings toggle needs no restart. */
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

function startRadioConductor(): void {
  owner.assertActive()
  if (conductor) return
  const store = getRadioStore()
  // Cold-start correctness for the backend gate in playProgrammeEntry: the
  // in-memory playerBackend defaults to mpv until an env probe runs, and
  // nothing probes unless the settings tab is opened — an orpheus install
  // would be waved through. One boot-time probe pins the real value.
  void getMusicService()
    .refreshEnv()
    .catch(() => {})
  const radioConductorOptions: OnethingRadioConductorOptions = {
    store,
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
    onProgrammeChanged: nudgeMusicClients,
    logger: consoleLog,
  };
  conductor = createOnethingRadioConductor(radioConductorOptions)
  setMusicSampleListener(sample => {
    if (owner.signal.aborted) return
    logSampleTransition(sample)
    conductor?.onSample(sample)
    lastPlayback.observe(sample)
    // 间奏检测吃的是同一拍采样 + 此刻推着的歌词(对不上这首歌就不发,判据在 moments.ts)。
    reportMoment(moments => moments.observeSample(sample, currentLyrics))
    void observeUnknownSong(sample)
  })
  // 简报里那条 DJ 会话被删了(09-26 真机:简报指着一条已不存在的会话,音乐面上「看他在
  // 做什么」打不开)—— 删除是店里的事实,简报跟着改,而不是等下一次唤醒才发现。
  deletedSessionsWatch.stop?.()
  deletedSessionsWatch.stop = sessions.onSessionsDeleted(deletedIds => {
    if (owner.signal.aborted) return
    const brief = getRadioStore().readBrief()
    if (!brief.sessionId || !deletedIds.includes(brief.sessionId)) return
    const { sessionId: _dropped, ...rest } = brief
    getRadioStore().writeBrief(rest)
    log.info('radio dj session was deleted, brief unlinked', { sessionId: brief.sessionId })
    nudgeMusicClients()
  })
  try {
    claimLegacyDjSessions()
  } catch (error) {
    log.warn('claiming legacy radio dj sessions failed', {}, error)
  }
}

function quiesce(): void {
  if (owner.signal.aborted) return
  try { setMusicSampleListener(null) } finally {
    deletedSessionsWatch.stop?.()
    deletedSessionsWatch.stop = null
    djWorking.cleanup?.()
    conductor?.quiesce()
    owner.quiesce()
  }
}
async function drain(): Promise<void> {
  quiesce()
  await Promise.all([owner.drain(), conductor?.idle()])
  grantedSessions.clear()
  lyricCache.clear()
  lyricInflight.clear()
}

  return { quiesce, drain,
    getRadioStore,
    diagnoseRadioStartFailure,
    markRadioGesture,
    getRadioStartingTitle,
    recordRadioSkip,
    resumeRadioPlayback,
    skipToNextRadioSong,
    replayCurrentRadioSong,
    isRadioActive,
    openRadioStation,
    radioToolOpen,
    radioToolClose,
    requestSong,
    tellRadioHost,
    getProgrammeSnapshot,
    applyProgrammeAction,
    likeCurrentSong,
    getMusicLyrics,
    startRadioConductor,
    radioToolStatus,
    isDjWorking,
    hostState,
    readHostLog,
  }
}

export type RadioScope = ReturnType<typeof createRadioScope>
export const getRadioStore: RadioScope['getRadioStore'] = (...args) => getCurrentBackend('music').music.radio.getRadioStore(...args)
export const diagnoseRadioStartFailure: RadioScope['diagnoseRadioStartFailure'] = (...args) => getCurrentBackend('music').music.radio.diagnoseRadioStartFailure(...args)
export const markRadioGesture: RadioScope['markRadioGesture'] = (...args) => getCurrentBackend('music').music.radio.markRadioGesture(...args)
export const getRadioStartingTitle: RadioScope['getRadioStartingTitle'] = (...args) => getCurrentBackend('music').music.radio.getRadioStartingTitle(...args)
export const recordRadioSkip: RadioScope['recordRadioSkip'] = (...args) => getCurrentBackend('music').music.radio.recordRadioSkip(...args)
export const resumeRadioPlayback: RadioScope['resumeRadioPlayback'] = (...args) => getCurrentBackend('music').music.radio.resumeRadioPlayback(...args)
export const skipToNextRadioSong: RadioScope['skipToNextRadioSong'] = (...args) => getCurrentBackend('music').music.radio.skipToNextRadioSong(...args)
export const replayCurrentRadioSong: RadioScope['replayCurrentRadioSong'] = (...args) => getCurrentBackend('music').music.radio.replayCurrentRadioSong(...args)
export const isRadioActive: RadioScope['isRadioActive'] = (...args) => getCurrentBackend('music').music.radio.isRadioActive(...args)
export const openRadioStation: RadioScope['openRadioStation'] = (...args) => getCurrentBackend('music').music.radio.openRadioStation(...args)
export const radioToolOpen: RadioScope['radioToolOpen'] = (...args) => getCurrentBackend('music').music.radio.radioToolOpen(...args)
export const radioToolClose: RadioScope['radioToolClose'] = (...args) => getCurrentBackend('music').music.radio.radioToolClose(...args)
export const requestSong: RadioScope['requestSong'] = (...args) => getCurrentBackend('music').music.radio.requestSong(...args)
export const tellRadioHost: RadioScope['tellRadioHost'] = (...args) => getCurrentBackend('music').music.radio.tellRadioHost(...args)
export const getProgrammeSnapshot: RadioScope['getProgrammeSnapshot'] = (...args) => getCurrentBackend('music').music.radio.getProgrammeSnapshot(...args)
export const applyProgrammeAction: RadioScope['applyProgrammeAction'] = (...args) => getCurrentBackend('music').music.radio.applyProgrammeAction(...args)
export const likeCurrentSong: RadioScope['likeCurrentSong'] = (...args) => getCurrentBackend('music').music.radio.likeCurrentSong(...args)
export const getMusicLyrics: RadioScope['getMusicLyrics'] = (...args) => getCurrentBackend('music').music.radio.getMusicLyrics(...args)
export const startRadioConductor: RadioScope['startRadioConductor'] = (...args) => getCurrentBackend('music').music.radio.startRadioConductor(...args)
export const radioToolStatus: RadioScope['radioToolStatus'] = (...args) => getCurrentBackend('music').music.radio.radioToolStatus(...args)
export const isDjWorking: RadioScope['isDjWorking'] = (...args) => getCurrentBackend('music').music.radio.isDjWorking(...args)
export const hostState: RadioScope['hostState'] = (...args) => getCurrentBackend('music').music.radio.hostState(...args)
export const readHostLog: RadioScope['readHostLog'] = (...args) => getCurrentBackend('music').music.radio.readHostLog(...args)
export function disposeRadioConductor(): Promise<void> { return getCurrentBackend('music').music.resetRadio() }
