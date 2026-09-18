/**
 * K3-b —— 音乐这一 scheme 的实现(`docs/design/atom-2026-09.md` §9 K3 的第一个
 * 样板:**纯 core 驱动**)。
 *
 * 自述在产品层(`@onething/runtime/music/resource-spec`),实现在这里 —— 与会话那
 * 一对逐字同一个理由:只有装配层够得着脊柱(`backend.music`)。
 *
 * ── 一条端口都不重写 ───────────────────────────────────────────────────────
 * 与 K2c-1 给会话定的纪律逐字相同:**采用今天那一只端口**,不另写一份。
 *   · 电台四条 —— `radioAdapters()`(`wiring/toolkit/adapters.ts`)。它就是旧
 *     `radio` 工具吃的那一份,连 `assertMusicOperator(fixedExecutionContext(…))`
 *     那道信任门都是同一行;这里**复用**它,不把那四条转发抄第二遍。
 *   · 播放器四条 —— `runMusicCommand`(`wiring/music/operations.ts`),也就是音乐条
 *     与 `music` RPC 域今天调的同一只。它自己带着那些只有它知道的分档(电台开着时
 *     `next` 走 `skipToNextRadioSong` 而不是播放器队列、`like` 按 onDeck 走服务端
 *     而不是 argv 表)—— 绕过它去拼 argv 就是当场丢掉那几条,而且不会有任何东西红。
 *   · `nowPlaying` —— `getMusicNowPlaying()`(`wiring/music/service.ts`)。
 *
 * ── 参数校验为什么在 `plan` 里,而且是抛 ────────────────────────────────────
 * 旧 `radio` 把「request 缺 song」「open/retune 的 intent 不足两个字」写成**成功的
 * 结果**(`ok` + 一段解释文字)。这里搬进 `plan` 并抛出去,于是管线落
 * `Outcome.failed` —— 一次参数不成立的调用不该在账本上留成一次成功。**措辞一个字
 * 不改**:那两句话是写给模型看的行为指引,它们在 `MusicIntentRequiredError` /
 * `MusicSongRequiredError` 上原样带着。
 *
 * 长度判据也原样搬:`intent.length < 2`,旧文件的理由是「Length 1 is never a real
 * direction — historically always debris ('x'), and a station briefed with debris
 * curates blind」。
 *
 * ── 地址:两个固定单例,给不给都行 ─────────────────────────────────────────
 * 每条做法 / 读法只作用在电台或播放器其中一个上,所以 `ref` 缺席时按成员自己补
 * (`MEMBER_TARGET`),给了就必须是那一个 —— `music:player` 上 `open` 是一次真的
 * 说错了地址,而不是可以静默忽略的多余参数(内核对 ref 只查 scheme,实例这一层
 * 归实现)。
 *
 * ── `nowPlayingChanged` 订的是哪个产地 ──────────────────────────────────────
 * `NowPlayingWatcher` 的 `emit` —— 也就是 watcher **自己的变化检测之后**那一发
 * (`sameNowPlaying`:标题 / 状态 / 时长任一变了才响,位置与队列下标故意排除)。
 * 它今天唯一的消费者是渲染进程那条 `MUSIC_NOW_PLAYING` 广播,而广播是宿主端口、
 * 订阅不了,所以 K3-b 在同一处开了一条扇出口:`MusicSubsystem.onNowPlayingChanged`
 * (表住在子系统,理由写在它那一格上 —— 服务作用域会随音乐 CLI 切换整代重建)。
 *
 * 没有去抢 `setMusicSampleListener`:那一格是**单槽**、归电台指挥台独占(radio.ts
 * 在 `startRadioConductor` 里装、`quiesce` 里清),而且语义是「每一次成功轮询」而
 * 不是「变了」——抢它等于让电台失聪,顺带把一个每秒都响的采样当成事件发出去。
 *
 * 订在 `attach(hub)`、退在 `dispose()`。`ResourceProvider` 没有 detach 钩子,所以
 * 退订由**登记方**收(`index.ts` 的 `mountBuiltinResources` 把它排在 mount 之前
 * push,逆序跑时就落在 unmount 之后)——§10.2「不许摘了之后还在写」的同一句话。
 *
 * ── 音乐收尾:四张端口表,同样一条都不重写 ─────────────────────────────────
 * `music` RPC 域那十四条方法退成本文件的投影之后,要够得着的东西比 K3-b 多了三族,
 * 于是端口表从两张变四张。**判据没变**:每一族都是「今天那只端口」原样递进来。
 *   · `radio`   —— `RadioToolAdapters`(开 / 关 / 状态 / 点歌),K3-b 那张,未动;
 *   · `player`  —— 传输命令 + now-playing + 「变了」的订阅,新增一条 `lyrics`;
 *   · `station` —— 音乐条那份简报、节目单、节目单编辑(`wiring/music/{operations,radio}`);
 *   · `backend` —— 音乐后端自己:装到哪一步、跑一步向导、有哪几只 CLI、搜歌、换 CLI
 *                  (`wiring/music/{service,operations}` + `@onething/runtime/music`)。
 *
 * 构造参数从两个位置参数改成**一个对象**,理由是四个位置参数的调用点读起来是
 * 「第三个是 station 还是 backend」——那种记不住的顺序迟早会有人装反,而装反了
 * 不会红(两张表都是鸭子)。
 *
 * ── 一件事,两个出口,两句不同的话(音乐收尾踩到三处)────────────────────
 * 退成投影之后,同一次拒绝在两个出口上要说两句不同的话,而这不是缺陷:
 *   · `request` 点歌失败 —— 资源面照旧答 `Outcome.ok` 带那句坏消息(旧 `radio` 的
 *     口径,模型读到之后会改口去搜别的版本);而 RPC 那一路的契约要的是
 *     `{success:false,error}`。两者由**同一次 apply** 满足:结局照旧 `ok`,而回执
 *     的结构化那一份挂在 `Result.details.request` 上,域自己去折。
 *   · 参数没给全 —— 资源面那句话是写给模型的行为指引(「用一句话概括听众想要的
 *     氛围」),RPC 那句是 `query is required`。两句都留着,前置在各自的出口上。
 *   · 开台的意图 —— 模型给一个字是碎屑,人给空串是「你来挑」。判据按主体分档,
 *     写在 `plan` 里。
 */

import type { JsonObject } from '@onething/core'
import type { ResourceEventHub, ResourceProvider, ResourceReadContext } from '@onething/core/resource'
import { planFromSpec, type ResourceRef } from '@onething/core/resource'
import type { PlanContext, Result, RunContext } from '@onething/core/toolkit'
import { Intent } from '@onething/core/toolkit'
import type { RadioToolAdapters, RadioToolStatus } from '@onething/runtime/toolkit'
import {
  listMusicProviderDescriptors,
  runOnethingMusicSetupForIpc,
  type MusicProviderDescriptor,
  type OnethingMusicNowPlaying,
  type OnethingMusicRuntimeState,
  type OnethingMusicSetupRequest,
} from '@onething/runtime/music'
import {
  MUSIC_PLAYER_PATH,
  MUSIC_PROVIDER_PATH,
  MUSIC_RADIO_PATH,
  MUSIC_RESOURCE_SCHEME,
  musicResourceSpec,
} from '@onething/runtime/music/resource-spec'
import type {
  MusicCommand,
  MusicLyrics,
  MusicProgrammeAction,
  MusicProgrammeEntryDTO,
  MusicRadioState,
} from '@shared/ipc.js'
import { getCurrentBackendInstance } from '../../current.js'
import { assertMusicOperator } from '../music/access.js'
import { fixedExecutionContext } from '../engine/execution-context.js'
import { setMusicProvider } from '../music/operations.js'
import { radioAdapters } from '../toolkit/adapters.js'

/** 播放器那一半的端口。电台那一半是既有的 `RadioToolAdapters`,不另立。 */
export interface MusicPlayerAdapters {
  /**
   * 一条音乐条命令。回执与音乐条 / `music` 域拿到的是**同一份**(同一只
   * `runMusicCommand`),`nowPlaying` 那一格也照样带着 —— 交出去的读数是它读回来
   * 的那一份,不是这里再问一遍。
   */
  command(
    request: { command: MusicCommand; value?: number },
    executionContext?: unknown,
  ): Promise<{ success: boolean; error?: string; nowPlaying?: OnethingMusicNowPlaying | null }>
  /** 现在放什么。没有播放器在跑 = `null`(不是一次失败)。 */
  nowPlaying(executionContext?: unknown): OnethingMusicNowPlaying | null
  /** 当前这首歌的定时歌词。没有 = `null`(氛围少一样,不是错)。 */
  lyrics(executionContext?: unknown): MusicLyrics | null
  /** 「变了」的订阅。返回退订。 */
  watchNowPlaying(listener: (nowPlaying: OnethingMusicNowPlaying | null) => void): () => void
  /**
   * 听歌这件事的事实(宠物 P4,§11.1:`trackStarted` / `skipped` / `skipStreak` / `liked` /
   * `resumedAfterPause` / `interlude`)的订阅。返回退订。事件名就是自述里的名字,负载原样转发。
   */
  watchFacts(listener: (event: string, payload: Record<string, unknown>) => void): () => void
}

/** 电台这一半里 `RadioToolAdapters` 没有的那三件:简报、节目单、节目单编辑。 */
export interface MusicStationAdapters {
  /** 音乐条那份简报(`readRadioBrief()`)。 */
  brief(executionContext?: unknown): MusicRadioState
  /** 排着的那些歌,以及台上那一首。 */
  programme(executionContext?: unknown): { entries: MusicProgrammeEntryDTO[]; onDeck?: string }
  /** 编辑一次节目单。失败带着自己那句话回来,这里不发明文案。 */
  programmeAction(
    action: MusicProgrammeAction,
    executionContext?: unknown,
  ): { success: boolean; error?: string }
}

/** 音乐后端(那只 CLI)自己:装到哪一步、跑一步向导、有哪几只、搜歌、换一只。 */
export interface MusicBackendAdapters {
  /** 装到哪一步了。抛 = 真的问不出来(服务起不来)。 */
  state(executionContext?: unknown): OnethingMusicRuntimeState
  /** 跑一步向导。回执是**整份**状态,或者一句失败的话 —— 与旧 `setup` 逐字同形。 */
  setup(
    request: OnethingMusicSetupRequest,
    executionContext?: unknown,
  ): Promise<{ success: boolean; error?: string; state?: OnethingMusicRuntimeState }>
  /**
   * 停掉保活播放器。**只停不起**:起会拉起 TUI,而 TUI 会对着旁边的人放每日推荐,
   * 按一下电台设置的人没点过播放(判据逐字沿用旧 `setup` 处理器那段注释)。
   */
  stopKeepalive(executionContext?: unknown): void
  /** 这台机器上有哪几只音乐 CLI,现在用的是哪一只。 */
  providers(executionContext?: unknown): { providers: MusicProviderDescriptor[]; activeId: string }
  /** 搜歌。失败带着自己那句话回来。 */
  search(
    query: string,
    executionContext?: unknown,
  ): Promise<{ success: boolean; error?: string; records?: Array<{ title: string; artist?: string; playFlag?: boolean }> }>
  /** 换一只音乐 CLI。「未知的 CLI」「本来就是它」两条早退在端口里,不在这里。 */
  setProvider(providerId: string, executionContext?: unknown): Promise<{ success: boolean; error?: string }>
  /**
   * 接入向导那条线的订阅(2026-09-18)。返回退订。
   *
   * 今天它只为一件事而存在:装工具时那条命令吐出来的字。那是一段要跑几十秒的活,
   * 屏幕上那块输出是这一段唯一的「它还活着」的证据,而它到不了这台壳 —— 旧的
   * `install-output` 推送骑在宿主 voice 广播口上,React 壳的 `voice` 端口是 `null`。
   * 折成一条资源事实之后,它骑的是 `resource:event` 那条**已经在**的全局事件,
   * 与「不许新开推送通道」那条法一个字不冲突。
   */
  watchSetup(listener: (event: { type: string; tool?: string; chunk?: string }) => void): () => void
}

/** 这只 provider 要的四族端口。一个对象而不是四个位置参数,理由在文件头。 */
export interface MusicResourceAdapters {
  readonly radio: RadioToolAdapters
  readonly player: MusicPlayerAdapters
  readonly station: MusicStationAdapters
  readonly backend: MusicBackendAdapters
}

/** open/retune 没给一句像样的意图。措辞逐字沿用旧 `radio`。 */
export class MusicIntentRequiredError extends Error {
  constructor() {
    super('open/retune 需要 intent:用一句话概括听众想要的氛围(时间、心情、风格),不要用占位符或单个字符。')
    this.name = 'MusicIntentRequiredError'
  }
}

/** request 没给歌名。措辞逐字沿用旧 `radio`。 */
export class MusicSongRequiredError extends Error {
  constructor() {
    super('request 需要 song:用户点名想听的歌,尽量带歌手,如「晴天 周杰伦」。')
    this.name = 'MusicSongRequiredError'
  }
}

/**
 * `seek` / `volume` 没给一个数,或者给了一个不是数的东西。
 *
 * 措辞逐字沿用 `wiring/music/operations.ts` 的 `argsWithValue`(`${command} 需要一个
 * 数值参数`)——那句话原来是音乐条那条路上说的,退成投影之后两条路说的还是它。
 * 用的是**词表里的名字**(`seek` / `volume`),不是做法名,因为两者今天逐字相同,
 * 而将来若有一天不同,那句话要跟着调用方的词走。
 */
export class MusicCommandValueError extends Error {
  constructor(command: MusicCommand) {
    super(`${command} 需要一个数值参数`)
    this.name = 'MusicCommandValueError'
  }
}

/** 节目单编辑没给动作。措辞逐字沿用 `music` 域那条前置判据。 */
export class MusicProgrammeActionRequiredError extends Error {
  constructor() {
    super('action is required')
    this.name = 'MusicProgrammeActionRequiredError'
  }
}

/** 换 CLI 没给 id。措辞逐字沿用 `music` 域那条前置判据。 */
export class MusicProviderIdRequiredError extends Error {
  constructor() {
    super('providerId is required')
    this.name = 'MusicProviderIdRequiredError'
  }
}

/** 搜歌没给词。措辞逐字沿用 `music` 域那条前置判据。 */
export class MusicSearchQueryRequiredError extends Error {
  constructor() {
    super('query is required')
    this.name = 'MusicSearchQueryRequiredError'
  }
}

/** 向导那一步没给动作,或者给了一个词表外的动作。措辞沿用旧 `setup` 的兜底。 */
export class MusicSetupActionError extends Error {
  constructor() {
    super('未知的配置操作')
    this.name = 'MusicSetupActionError'
  }
}

/** 地址指着另一个单例。`music:player` 上的 `open` 是说错了,不是多写了一格。 */
export class MusicRefMismatchError extends Error {
  constructor(member: string, expected: string, got: string) {
    super(`${member} acts on ${MUSIC_RESOURCE_SCHEME}:${expected}, not ${MUSIC_RESOURCE_SCHEME}:${got}`)
    this.name = 'MusicRefMismatchError'
  }
}

/** 播放命令说不。带着回执自己那句话 —— 这里不发明文案。 */
export class MusicCommandFailedError extends Error {
  constructor(command: MusicCommand, reason: string) {
    super(reason)
    this.name = 'MusicCommandFailedError'
    this.command = command
  }

  readonly command: MusicCommand
}

/** 每个成员作用在哪个单例上。`ref` 缺席时按它补,给了就按它校。 */
const MEMBER_TARGET: Readonly<Record<string, string>> = {
  open: MUSIC_RADIO_PATH,
  retune: MUSIC_RADIO_PATH,
  close: MUSIC_RADIO_PATH,
  request: MUSIC_RADIO_PATH,
  radioResume: MUSIC_RADIO_PATH,
  radioStop: MUSIC_RADIO_PATH,
  programmeAction: MUSIC_RADIO_PATH,
  radio: MUSIC_RADIO_PATH,
  brief: MUSIC_RADIO_PATH,
  programme: MUSIC_RADIO_PATH,
  pause: MUSIC_PLAYER_PATH,
  resume: MUSIC_PLAYER_PATH,
  next: MUSIC_PLAYER_PATH,
  prev: MUSIC_PLAYER_PATH,
  seek: MUSIC_PLAYER_PATH,
  volume: MUSIC_PLAYER_PATH,
  like: MUSIC_PLAYER_PATH,
  nowPlaying: MUSIC_PLAYER_PATH,
  lyrics: MUSIC_PLAYER_PATH,
  setup: MUSIC_PROVIDER_PATH,
  setProvider: MUSIC_PROVIDER_PATH,
  state: MUSIC_PROVIDER_PATH,
  providers: MUSIC_PROVIDER_PATH,
  search: MUSIC_PROVIDER_PATH,
}

/**
 * 走 `MusicCommand` 词表的那几条做法 → 词表里的那个名字。
 *
 * `stop` 不在词表里,也不在这张表里。`radioResume` / `radioStop` 在:它们不是传输
 * 命令,但它们**是那只端口的词表成员**(端口自己按 kebab 名分档,`radio-resume`
 * 走保活重启、`radio-stop` 走关台),绕开它去拼 argv 就是当场丢掉那两条分档。
 */
const PLAYER_COMMANDS: Readonly<Record<string, MusicCommand>> = {
  pause: 'pause',
  resume: 'resume',
  next: 'next',
  prev: 'prev',
  like: 'like',
  seek: 'seek',
  volume: 'volume',
  radioResume: 'radio-resume',
  radioStop: 'radio-stop',
}

/** 那几条命令的回执抬头。中文一句,与电台那几条同一种语气。 */
const PLAYER_TITLES: Readonly<Record<string, string>> = {
  pause: '已暂停',
  resume: '已继续',
  next: '已切下一首',
  prev: '已回上一首',
  like: '已红心',
  seek: '已跳转',
  volume: '已调音量',
  radioResume: '已续播',
  radioStop: '电台已停',
}

/** 带数值参数的那两条:做法名 → 参数名。措辞的那一半在 `MusicCommandValueError`。 */
const VALUE_PARAM: Readonly<Record<string, string>> = {
  seek: 'position',
  volume: 'level',
}

/** `plan` 交给 `apply` 的载荷:已经解析好的这一次要做什么。 */
export type MusicOpPayload =
  | { readonly op: 'open' | 'retune'; readonly intent: string }
  | { readonly op: 'close' }
  | { readonly op: 'request'; readonly song: string }
  | { readonly op: 'programmeAction'; readonly action: MusicProgrammeAction }
  | { readonly op: 'setup'; readonly request: OnethingMusicSetupRequest }
  | { readonly op: 'setProvider'; readonly providerId: string }
  | {
      readonly op: 'pause' | 'resume' | 'next' | 'prev' | 'seek' | 'volume' | 'like' | 'radioResume' | 'radioStop'
      readonly command: MusicCommand
      readonly value?: number
    }

/**
 * 一份 now-playing 读数 → 自述里那份 schema。**一只函数两个出口**(读法与事件),
 * 因为它们本来就是同一件事的两种送达方式。
 *
 * `null`(守护进程没起)折成一份「停着」的读数,理由写在自述 `nowPlaying` 那一格上。
 */
function nowPlayingView(nowPlaying: OnethingMusicNowPlaying | null): Record<string, unknown> {
  if (!nowPlaying) {
    return { playing: false, status: 'stopped', position: 0, queueLength: 0, currentIndex: 0 }
  }
  return {
    playing: nowPlaying.status === 'playing',
    status: nowPlaying.status,
    ...(nowPlaying.title !== undefined ? { title: nowPlaying.title } : {}),
    position: nowPlaying.position,
    ...(nowPlaying.duration !== undefined ? { duration: nowPlaying.duration } : {}),
    ...(nowPlaying.progress !== undefined ? { progress: nowPlaying.progress } : {}),
    queueLength: nowPlaying.queueLength,
    currentIndex: nowPlaying.currentIndex,
  }
}

/** 电台状态 → 给模型看的几行。逐字沿用旧 `radio` 的 `describeStatus`。 */
function describeStatus(status: RadioToolStatus): string {
  return [
    `active: ${status.active}`,
    status.intent ? `intent: ${status.intent}` : null,
    `programme_left: ${status.programmeLength}`,
    status.nowPlayingTitle ? `now_playing: ${status.nowPlayingTitle}` : null,
    status.lastError ? `last_error: ${status.lastError}` : null,
  ]
    .filter(Boolean)
    .join('\n')
}

function stringParam(params: unknown, key: string): string {
  const value = params && typeof params === 'object' ? (params as Record<string, unknown>)[key] : undefined
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 一个真的数。`undefined` = 「这一格不成立」,把「没给」与「给了 NaN / Infinity」
 * 说成同一个答案 —— 判据逐字沿用 `operations.ts` 的 `argsWithValue`
 * (`typeof value !== 'number' || !Number.isFinite(value)`)。
 */
function numberParam(params: unknown, key: string): number | undefined {
  const value = params && typeof params === 'object' ? (params as Record<string, unknown>)[key] : undefined
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 节目单编辑的那一格。形状不对 = 「没给动作」,与域那条前置判据同一句话。 */
function programmeActionParam(params: unknown): MusicProgrammeAction {
  const raw = params && typeof params === 'object' ? (params as { action?: unknown }).action : undefined
  if (!raw || typeof raw !== 'object') throw new MusicProgrammeActionRequiredError()
  const action = raw as { kind?: unknown; encryptedId?: unknown; toIndex?: unknown }
  const encryptedId = typeof action.encryptedId === 'string' ? action.encryptedId : ''
  if (!encryptedId) throw new MusicProgrammeActionRequiredError()
  if (action.kind === 'remove' || action.kind === 'promote') return { kind: action.kind, encryptedId }
  if (action.kind === 'move' && typeof action.toIndex === 'number') {
    return { kind: 'move', encryptedId, toIndex: action.toIndex }
  }
  throw new MusicProgrammeActionRequiredError()
}

/**
 * 向导那一步。**判别联合自己判,不 `as`**:这坨东西来自模型参数 / deeplink /
 * 界面表单,而 `as` 在这里等于让一个字符串冒充一个联合成员 —— 词表外的动作原来在
 * `runOnethingMusicSetupForIpc` 的 `default` 分支上说「未知的配置操作」,这里提前
 * 一步说同一句话(端口那一句照旧留着,它是最后一道)。
 */
function setupRequestParam(params: unknown): OnethingMusicSetupRequest {
  const raw = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>
  const action = raw.action
  switch (action) {
    case 'check-env':
    case 'login-start':
    case 'login-cancel':
    case 'login-check':
    case 'logout':
      return { action }
    case 'install-tool':
      return { action, tool: String(raw.tool ?? '') as 'ncm-cli' | 'mpv' }
    case 'set-credentials':
      // 两个字段一个字都不动:空串的拒绝措辞归端口(`appId 与 privateKey 不能为空`)。
      return {
        action,
        appId: typeof raw.appId === 'string' ? raw.appId : '',
        privateKey: typeof raw.privateKey === 'string' ? raw.privateKey : '',
      }
    case 'set-player':
      return { action, player: String(raw.player ?? '') as 'mpv' | 'orpheus' }
    default:
      throw new MusicSetupActionError()
  }
}

export class MusicResourceProvider implements ResourceProvider<MusicOpPayload> {
  readonly spec = musicResourceSpec

  private readonly radio: RadioToolAdapters
  private readonly player: MusicPlayerAdapters
  private readonly station: MusicStationAdapters
  private readonly backend: MusicBackendAdapters
  private hub: ResourceEventHub | undefined
  private unwatch: (() => void) | undefined
  private unwatchFacts: (() => void) | undefined
  private unwatchSetup: (() => void) | undefined

  constructor(adapters: MusicResourceAdapters) {
    this.radio = adapters.radio
    this.player = adapters.player
    this.station = adapters.station
    this.backend = adapters.backend
  }

  attach(hub: ResourceEventHub): void {
    this.hub = hub
    this.unwatch?.()
    this.unwatch = this.player.watchNowPlaying(nowPlaying => {
      hub.emit(
        { scheme: this.spec.scheme, path: MUSIC_PLAYER_PATH },
        'nowPlayingChanged',
        nowPlayingView(nowPlaying),
      )
    })
    this.unwatchFacts?.()
    this.unwatchFacts = this.player.watchFacts((event, payload) => {
      hub.emit({ scheme: this.spec.scheme, path: MUSIC_PLAYER_PATH }, event, payload)
    })
    this.unwatchSetup?.()
    this.unwatchSetup = this.backend.watchSetup(event => {
      // **只转发安装输出**。`state` 那一种不转:向导那一步做完之后发一次
      // `setupChanged` 是 `apply` 的事(一步一发,读得出次数);把每一次内部 patch
      // 都发出去会让一次 `check-env` 变成两三发,而订阅方分不出哪一发是「做完了」。
      // `login-output` 那一种也不转:登录地址今天记在 `state.login` 那一格上,
      // 把它再当事实广播一遍就是同一条凭据两个产地。
      if (event.type !== 'install-output') return
      hub.emit({ scheme: this.spec.scheme, path: MUSIC_PROVIDER_PATH }, 'setupOutput', {
        tool: event.tool ?? '',
        chunk: event.chunk ?? '',
      })
    })
  }

  /**
   * 退订。由登记方在 unmount **之后**调(见文件头);幂等 —— 第二次什么都不做。
   */
  dispose(): void {
    this.unwatch?.()
    this.unwatch = undefined
    this.unwatchFacts?.()
    this.unwatchFacts = undefined
    this.unwatchSetup?.()
    this.unwatchSetup = undefined
    this.hub = undefined
  }

  /**
   * 两条读法。
   *
   * ## 为什么读这一侧不递信任上下文(留账)
   *
   * 端口那一道门(`assertMusicOperator(fixedExecutionContext(…))`)判的是
   * `RuntimeRequestContext`(`{userId, workspaceId}`),而**读的上下文里没有这一格**:
   * `ResourceReadContext` 带的是 `Principal`(`user:local` / `agent:<id>` /
   * `system:<component>`),两套词汇不通 —— 硬把 principal 折成一个执行上下文,就是
   * 凭一个字符串冒充凭据(`core/permission/principal.ts` 的 `parsePrincipal` 上写着
   * 那条:「a string is not a credential」)。
   *
   * 所以这里递 `undefined`,也就是那个固定的本机操作员 —— 与今天音乐条读 now-playing
   * 走的是同一档。代价说清楚:旧 `radio(action: "status")` 是一条**做法**,拿得到
   * `invocation.executionContext`,于是一条网关身份的会话读电台状态会被拒;退成读法
   * 之后这道门在读这一侧不成立了。两条读法本身不敏感(在放什么、还有几首),而读的
   * 把关正门是内核的 `readGuard`(命名空间许可 / owner 归属的落点,`kernel.ts` 上写
   * 着它就是为这类问题留的)—— 那是一次单独的拍板,不是这一单能顺手补的。
   */
  async read(name: string, ref: ResourceRef | null, query: unknown, _ctx: ResourceReadContext): Promise<unknown> {
    this.assertRef(name, ref)
    switch (name) {
      case 'nowPlaying':
        return nowPlayingView(this.player.nowPlaying())
      case 'radio':
        return this.radio.status()
      case 'brief':
        return this.station.brief()
      case 'programme':
        return this.station.programme()
      case 'lyrics':
        return this.player.lyrics()
      case 'state':
        return this.backend.state()
      case 'providers':
        return this.backend.providers()
      case 'search': {
        // 空词不是一次搜索。措辞与 `music` 域那条前置判据是同一句 —— 两条路上
        // 「你没给我要搜什么」只有一种说法。
        const term = stringParam(query, 'query')
        if (!term) throw new MusicSearchQueryRequiredError()
        const answered = await this.backend.search(term)
        if (!answered.success) throw new Error(answered.error ?? '搜索失败')
        return { records: answered.records ?? [] }
      }
      default:
        // 走不到:两条读路都先查过读法名在不在自述里。留一句诚实的错。
        throw new TypeError(`Music resource has no read named ${JSON.stringify(name)}`)
    }
  }

  async plan(op: string, ref: ResourceRef | null, params: unknown, ctx: PlanContext): Promise<Intent<MusicOpPayload>> {
    this.assertRef(op, ref)
    const plan = (payload: MusicOpPayload, title: string): Intent<MusicOpPayload> =>
      planFromSpec<MusicOpPayload>(this.spec, op, ref, payload, { title })

    if (op === 'open' || op === 'retune') {
      const intent = stringParam(params, 'intent')
      /*
       * 一个字从来不是一个方向 —— 历史上全是占位符('x'),而拿占位符当简报的电台
       * 是在盲编节目单(旧 `radio` 那一行的理由,原样)。
       *
       * **按主体分档**(与 K3-a' 的 `removeMessage` 同一种形状,理由却是另一条):
       * 那条判据从头到尾是冲着**模型**来的 —— 碎屑是模型给的。人这一侧,空简报
       * 从来是一句成立的话:「你来挑」(共享契约上 `openRadio.intent` 那一格写着
       * 「empty = let the DJ pick by time/history」)。所以判据本身没变,只是问清楚
       * 「谁在给这句简报」:模型 / 插件 / 脚本给碎屑当场说不,人给空串是一次真的
       * 授权。**这不是放宽**:界面那条路今天就允许空简报,退成投影不许把它弄丢。
       */
      if (intent.length < 2 && ctx.principal.kind !== 'user') throw new MusicIntentRequiredError()
      return plan({ op, intent }, op === 'retune' ? `Retune the radio to ${intent}` : `Open the radio: ${intent}`)
    }

    if (op === 'close') return plan({ op }, 'Close the radio')

    if (op === 'request') {
      const song = stringParam(params, 'song')
      if (!song) throw new MusicSongRequiredError()
      return plan({ op, song }, `Request ${song}`)
    }

    if (op === 'programmeAction') {
      const action = programmeActionParam(params)
      return plan({ op, action }, `Programme ${action.kind} ${action.encryptedId}`)
    }

    if (op === 'setup') {
      const request = setupRequestParam(params)
      /*
       * **预览标题里只有动作名**,一个凭据都不带:这句话会进权限卡、进
       * `<store>/audit/resource.jsonl` 的 `previewTitle`,而账本是长期留着的。
       * `params` 本身不进账本(审计只记 toolId / 效果 / 主体 / 结局 / 这句预览),
       * 所以「不把 appId / privateKey 写进这句话」就是全部要做的事。
       */
      return this.capabilityPlan(op, ref, { op, request }, `Music setup: ${request.action}`, ctx)
    }

    if (op === 'setProvider') {
      const providerId = stringParam(params, 'providerId')
      if (!providerId) throw new MusicProviderIdRequiredError()
      return this.capabilityPlan(
        op,
        ref,
        { op, providerId },
        `Switch the music backend to ${providerId}`,
        ctx,
      )
    }

    const command = Object.prototype.hasOwnProperty.call(PLAYER_COMMANDS, op) ? PLAYER_COMMANDS[op] : undefined
    if (!command) throw new TypeError(`Music resource has no op named ${JSON.stringify(op)}`)
    if (Object.prototype.hasOwnProperty.call(VALUE_PARAM, op)) {
      // 「缺」与「给错」在旧路上是同一句话,所以这里也只有一句(见 `SEEK_PARAMS`
      // 那一格:契约校验者不解释 params,数值这一关本来就归 plan)。
      const value = numberParam(params, VALUE_PARAM[op])
      if (value === undefined) throw new MusicCommandValueError(command)
      return plan({ op, command, value } as MusicOpPayload, `Player: ${command} ${value}`)
    }
    return plan({ op, command } as MusicOpPayload, `Player: ${command}`)
  }

  /**
   * 一条**动能力**的做法的计划:效果按主体分档(K3-a' 的口径)。
   *
   *   · `user` —— 设置页上那个按钮是人自己按下的,再弹一张卡问「准不准你按你刚按
   *     的那个按钮」是噪音不是保护(08-18 判例)。零效果**不等于不留痕迹**:照样
   *     落 `tool/audit`、照样发事件。
   *   · 其余(`agent` / `system`,含经它们进来的插件)—— 顶格,也就是自述里那条
   *     `capability_change`:装一个包、写一份凭据、换一只 CLI,不许静默发生。
   *
   * 分档在这里而不在权限核,理由与 `session-provider.ts` 那一段逐字相同:
   * `decidePermission` 至今不读主体,让它开始读主体是凭证级主体那一片地(09-03
   * 用户搁置),不是一次接线单能拍的。
   */
  private capabilityPlan(
    op: string,
    ref: ResourceRef | null,
    payload: MusicOpPayload,
    title: string,
    ctx: PlanContext,
  ): Intent<MusicOpPayload> {
    if (ctx.principal.kind === 'user') return Intent.of({ effects: [], payload, preview: { title } })
    return planFromSpec<MusicOpPayload>(this.spec, op, ref, payload, { title })
  }

  async apply(_op: string, intent: Intent<MusicOpPayload>, ctx: RunContext): Promise<Result> {
    const payload = intent.payload
    // 信任上下文原样从 invocation 上取,与旧 `radio` 工具逐字同一格
    // (`ctx.invocation.executionContext`)—— 端口那一侧的 `assertMusicOperator`
    // 因此判的是同一份东西。
    const operator = ctx.invocation.executionContext
    switch (payload.op) {
      case 'open':
      case 'retune': {
        const status = await this.radio.open(
          payload.intent,
          { clearProgramme: payload.op === 'retune' },
          operator,
        )
        this.emit(MUSIC_RADIO_PATH, 'radioOpened', { intent: payload.intent })
        return this.done(
          ctx,
          payload.op === 'retune' ? '已换台' : '电台已开',
          `${describeStatus(status)}\n\nDJ 正在编排:先凑一小批让音乐尽快响(通常两三分钟内第一首开播),然后边播边补全节目单、准备串词。可随时用 music(read: "radio") 查看进度;向用户转述时请如实说明这个节奏,不要承诺"马上"。`,
          payload.op,
        )
      }
      case 'close': {
        const status = await this.radio.close(operator)
        this.emit(MUSIC_RADIO_PATH, 'radioClosed', {})
        return this.done(ctx, '电台已关', describeStatus(status), payload.op)
      }
      case 'request': {
        const requested = await this.radio.request(payload.song, operator)
        // 点歌说不(没搜到 / 全无版权 / 电台没开)照旧是一次**成功的回执带坏消息**:
        // 旧 `radio` 就是这么答的,而模型要的正是那句话本身(它下一步会改口去搜别的
        // 版本)。这一条与下面播放器那四条的处理不同,理由写在那里。
        //
        // 结构化的那一份挂在 `details.request` 上:RPC 那一路的契约要的是
        // `{success:false,error}`,而**同一次 apply 两个出口**的办法是把回执原样带
        // 出去,让每个出口按自己的词汇折 —— 不是再跑一次,更不是让模型也改口。
        if (!requested.success) {
          return this.done(ctx, '点歌失败', requested.error ?? '点歌失败', payload.op, { request: requested })
        }
        return this.done(
          ctx,
          '已插队',
          `「${requested.title}」将在下一首播出${requested.error ? `(${requested.error})` : ''}。向用户确认时报这个完整歌名。`,
          payload.op,
          { request: requested },
        )
      }
      case 'programmeAction': {
        const applied = this.station.programmeAction(payload.action, operator)
        // 节目单编辑失败(那一条已经被指挥台取走了)= `failed`,与播放器那几条同一
        // 条判据:一次没发生的编辑不是一次成功的调用。那句话是端口写的。
        if (!applied.success) throw new Error(applied.error ?? '节目单操作失败')
        return this.done(ctx, '节目单已更新', `programme ${payload.action.kind} ok`, payload.op)
      }
      case 'setup': {
        const answered = await this.backend.setup(payload.request, operator)
        if (!answered.success || !answered.state) throw new Error(answered.error || '配置操作失败')
        /*
         * **只停不起**,而且只在「没停在 ready+mpv 这一格」时停 —— 判据与文案逐字
         * 沿用旧 `setup` 处理器那段注释:起会拉起 TUI,而 TUI 会对着旁边的人放每日
         * 推荐,没人按一下电台设置是为了听歌。换成 orpheus、或者把配置弄坏了,那台
         * 离屏 TUI 就是死重。
         *
         * 它搬到这里而不是留在域里,是因为它**是产品逻辑不是转调**:配置改完之后
         * 那台保活播放器该不该活着,与谁在问这件事无关。
         */
        if (!(answered.state.setupStage === 'ready' && answered.state.playerBackend === 'mpv')) {
          this.backend.stopKeepalive(operator)
        }
        /*
         * **一步一发**(2026-09-18,正本 §6.1「setup 的每一步结束后发一次;壳订它
         * 重拉 `state`」)。它是**事实不是命令**,与 `providerChanged` 同一句话:
         * 发出去的时候这一步已经做完了。
         *
         * 发在这里而不是在服务那一侧的每次 patch 上,是因为「一步」这个单位只有
         * 这里说得出来 —— 一次 `check-env` 在服务里会 patch 两三回,订阅方分不出
         * 哪一回是做完了。凭据一个字不带:`setupStage` 就是全部负载,其余去读
         * `state`(与这条做法的预览标题同一条纪律)。
         */
        this.emit(MUSIC_PROVIDER_PATH, 'setupChanged', { setupStage: answered.state.setupStage })
        return this.done(
          ctx,
          '配置已更新',
          `music setup: ${payload.request.action} → ${answered.state.setupStage}`,
          payload.op,
          { state: answered.state },
        )
      }
      case 'setProvider': {
        const switched = await this.backend.setProvider(payload.providerId, operator)
        if (!switched.success) throw new Error(switched.error ?? '切换音乐 CLI 失败')
        // 换完了才发,而且发的是事实:读到它的人该做的是重新拉一次自己那份读数。
        this.emit(MUSIC_PROVIDER_PATH, 'providerChanged', { providerId: payload.providerId })
        return this.done(ctx, '已换音乐后端', `music backend: ${payload.providerId}`, payload.op)
      }
      default: {
        const answered = await this.player.command(
          { command: payload.command, ...(payload.value !== undefined ? { value: payload.value } : {}) },
          operator,
        )
        /*
         * 音乐条那几条说不 = `Outcome.failed`,**与点歌那一条刻意不同**。
         *
         * 点歌有旧行为要守(`ok` + 那句话,见上);这一族是 K3-b 新开的,没有任何
         * 旧口径要照抄,于是按管线自己的规矩来:「暂停失败了」不是一次成功的调用。
         * 带出去的那句话是回执自己写的(守护进程走了 / CLI 拒绝了 / 没歌可续播),
         * 这里不发明文案 —— 而 RPC 那一路的 `{success:false,error}` 正好由同一句话
         * 折出来,两条路上同一次失败说的是同一句。
         */
        if (!answered.success) {
          throw new MusicCommandFailedError(payload.command, answered.error ?? `${payload.command} 失败`)
        }
        // 交出去的读数是**回执带回来的那一份**(端口在命令之后自己重读过一次),
        // 拿不到才回头问一次缓存 —— 假端口只答 `{success:true}` 时走的是后者。
        const nowPlaying = answered.nowPlaying !== undefined
          ? answered.nowPlaying
          : this.player.nowPlaying(operator)
        return this.done(
          ctx,
          PLAYER_TITLES[payload.op],
          nowPlaying?.title ? `${PLAYER_TITLES[payload.op]}:${nowPlaying.title}` : PLAYER_TITLES[payload.op],
          payload.op,
          { nowPlaying: nowPlaying ?? null },
        )
      }
    }
  }

  /**
   * 地址这一层的判定。缺席 = 按成员自己补(两个单例,补得出唯一答案);给了别人的
   * 那一个 = 当场说不(见文件头)。
   */
  private assertRef(member: string, ref: ResourceRef | null): void {
    const expected = Object.prototype.hasOwnProperty.call(MEMBER_TARGET, member)
      ? MEMBER_TARGET[member]
      : undefined
    if (!expected || !ref || !ref.path) return
    if (ref.path !== expected) throw new MusicRefMismatchError(member, expected, ref.path)
  }

  private emit(path: string, event: string, payload: unknown): void {
    this.hub?.emit({ scheme: this.spec.scheme, path }, event, payload)
  }

  /**
   * 一次成功的回执。
   *
   * `extra` 是**结构化的那一份**(K 音乐收尾):同一次 apply 要同时喂两个出口 ——
   * 模型读 `content` 那段话,`music` RPC 域读 `details` 里那几格(now-playing 读数 /
   * 向导状态 / 点歌回执)。它不进注记(`annotate` 是给人看的那一行,里面塞一份
   * JSON 只会把界面上那行字撑爆),只进结果。
   */
  private done(
    ctx: RunContext,
    title: string,
    output: string,
    op: string,
    extra: Record<string, unknown> = {},
  ): Result {
    // 注记与旧 `radio` 逐格同形(`title` + `details.action`),只是那一格的名字跟着
    // 词汇改了:资源面上「这次做的是哪一条」叫 op,不叫 action。
    ctx.emit({ type: 'annotate', title, details: { op } })
    // 一次断言,就在这里:`extra` 收的是端口交回来的那几只回执(接口类型,拿不到
    // 隐式索引签名),而它们逐格都是 JSON。让每个调用点各断言一次才是真的散。
    return { content: [{ type: 'text', text: output }], details: { op, ...extra } as JsonObject }
  }
}

/**
 * 音乐子系统的取法。三只成品工厂共用 —— 与 `radioAdapters()` 逐字同一句:
 * **装配那一刻捕获**(不是每次调用重问),不在就抛。
 */
function musicSubsystem(): () => NonNullable<ReturnType<typeof getCurrentBackendInstance>>['music'] {
  const captured = getCurrentBackendInstance()?.music
  return () => {
    if (!captured) throw new Error('Music service is unavailable')
    return captured
  }
}

/**
 * 播放器那一半的成品适配器:与 `radioAdapters()` 同一个形状、同一道信任门
 * (`assertMusicOperator(fixedExecutionContext(…))`)、同一个「音乐服务不在就抛」
 * 的取法。
 */
export function musicPlayerAdapters(): MusicPlayerAdapters {
  const music = musicSubsystem()
  return {
    command: (request, executionContext) => {
      assertMusicOperator(fixedExecutionContext(executionContext))
      // 整只请求原样递给端口:`value` 那一格是 `seek` / `volume` 的参数,而 argv 的
      // 拼法(以及 0-100 / 秒的钳位)只有它知道 —— 在这里拆开重拼就是抄第二份。
      return music().operations.runMusicCommand(request)
    },
    nowPlaying: executionContext => {
      assertMusicOperator(fixedExecutionContext(executionContext))
      return music().service.getMusicNowPlaying()
    },
    lyrics: executionContext => {
      assertMusicOperator(fixedExecutionContext(executionContext))
      return music().radio.getMusicLyrics()
    },
    watchNowPlaying: listener => music().onNowPlayingChanged(listener),
    watchFacts: listener => music().onPlayerFact(listener),
  }
}

/** 电台那三件(简报 / 节目单 / 节目单编辑)的成品适配器。 */
export function musicStationAdapters(): MusicStationAdapters {
  const music = musicSubsystem()
  return {
    brief: executionContext => {
      assertMusicOperator(fixedExecutionContext(executionContext))
      return music().operations.readRadioBrief()
    },
    programme: executionContext => {
      assertMusicOperator(fixedExecutionContext(executionContext))
      return music().radio.getProgrammeSnapshot()
    },
    programmeAction: (action, executionContext) => {
      assertMusicOperator(fixedExecutionContext(executionContext))
      return music().radio.applyProgrammeAction(action)
    },
  }
}

/**
 * 音乐后端自己那一族的成品适配器。
 *
 * `setup` 这一条走的是 `runOnethingMusicSetupForIpc` —— 产品层那只**纯**投影函数
 * (它只认一个 `MusicSetupService`,不认识 Electron 也不认识这台后端),与旧
 * `music` 域处理器吃的是同一只;那句「配置操作失败」的兜底也因此还是它写的。
 *
 * `setProvider` 走 `../music/operations.js` 的同名函数,它自己带着两条早退
 * (未知的 CLI / 本来就是它)与那次真正的重新调台。
 */
export function musicBackendAdapters(): MusicBackendAdapters {
  const music = musicSubsystem()
  return {
    state: executionContext => {
      assertMusicOperator(fixedExecutionContext(executionContext))
      return music().service.getMusicService().getState()
    },
    setup: (request, executionContext) => {
      assertMusicOperator(fixedExecutionContext(executionContext))
      return runOnethingMusicSetupForIpc({ request, service: music().service.getMusicService() })
    },
    stopKeepalive: executionContext => {
      assertMusicOperator(fixedExecutionContext(executionContext))
      void music().service.stopMusicPlayerKeepalive()
    },
    providers: executionContext => {
      assertMusicOperator(fixedExecutionContext(executionContext))
      return {
        providers: listMusicProviderDescriptors(),
        activeId: music().service.getActiveMusicProvider().descriptor.id,
      }
    },
    search: (query, executionContext) => {
      assertMusicOperator(fixedExecutionContext(executionContext))
      return music().operations.searchMusicSongs(query)
    },
    setProvider: (providerId, executionContext) => {
      assertMusicOperator(fixedExecutionContext(executionContext))
      return setMusicProvider(providerId)
    },
    // 订阅**不**过信任门,与 `watchNowPlaying` / `watchFacts` 逐字同一档:那道门判的
    // 是「谁在操作这台机器」,而订一条扇出口不是一次操作 —— 它连一个子进程都不起。
    watchSetup: listener => music().onSetupEvent(listener),
  }
}

/** 这台宿主上的音乐资源。四族端口全部**复用**既有工厂,不抄第二遍。 */
export function createMusicResourceProvider(): MusicResourceProvider {
  return new MusicResourceProvider({
    radio: radioAdapters(),
    player: musicPlayerAdapters(),
    station: musicStationAdapters(),
    backend: musicBackendAdapters(),
  })
}
