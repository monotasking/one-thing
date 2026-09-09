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
 */

import type { ResourceEventHub, ResourceProvider, ResourceReadContext } from '@onething/core/resource'
import { planFromSpec, type ResourceRef } from '@onething/core/resource'
import type { PlanContext, Result, RunContext } from '@onething/core/toolkit'
import { Intent } from '@onething/core/toolkit'
import type { RadioToolAdapters, RadioToolStatus } from '@onething/runtime/toolkit'
import type { OnethingMusicNowPlaying } from '@onething/runtime/music'
import {
  MUSIC_PLAYER_PATH,
  MUSIC_RADIO_PATH,
  MUSIC_RESOURCE_SCHEME,
  musicResourceSpec,
} from '@onething/runtime/music/resource-spec'
import type { MusicCommand } from '@shared/ipc.js'
import { getCurrentBackendInstance } from '../../current.js'
import { assertMusicOperator } from '../music/access.js'
import { fixedExecutionContext } from '../engine/execution-context.js'
import { radioAdapters } from '../toolkit/adapters.js'

/** 播放器那一半的端口。电台那一半是既有的 `RadioToolAdapters`,不另立。 */
export interface MusicPlayerAdapters {
  /** 一条播放命令。回执与音乐条 / `music` 域拿到的是同一份。 */
  command(command: MusicCommand, executionContext?: unknown): Promise<{ success: boolean; error?: string }>
  /** 现在放什么。没有播放器在跑 = `null`(不是一次失败)。 */
  nowPlaying(executionContext?: unknown): OnethingMusicNowPlaying | null
  /** 「变了」的订阅。返回退订。 */
  watchNowPlaying(listener: (nowPlaying: OnethingMusicNowPlaying | null) => void): () => void
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
  radio: MUSIC_RADIO_PATH,
  pause: MUSIC_PLAYER_PATH,
  resume: MUSIC_PLAYER_PATH,
  next: MUSIC_PLAYER_PATH,
  like: MUSIC_PLAYER_PATH,
  nowPlaying: MUSIC_PLAYER_PATH,
}

/** 播放器四条做法 → `MusicCommand` 词表。`stop` 不在词表里,也不在这张表里。 */
const PLAYER_COMMANDS: Readonly<Record<string, MusicCommand>> = {
  pause: 'pause',
  resume: 'resume',
  next: 'next',
  like: 'like',
}

/** 播放器四条的回执抬头。中文一句,与电台那几条同一种语气。 */
const PLAYER_TITLES: Readonly<Record<string, string>> = {
  pause: '已暂停',
  resume: '已继续',
  next: '已切下一首',
  like: '已红心',
}

/** `plan` 交给 `apply` 的载荷:已经解析好的这一次要做什么。 */
export type MusicOpPayload =
  | { readonly op: 'open' | 'retune'; readonly intent: string }
  | { readonly op: 'close' }
  | { readonly op: 'request'; readonly song: string }
  | { readonly op: 'pause' | 'resume' | 'next' | 'like'; readonly command: MusicCommand }

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

export class MusicResourceProvider implements ResourceProvider<MusicOpPayload> {
  readonly spec = musicResourceSpec

  private readonly radio: RadioToolAdapters
  private readonly player: MusicPlayerAdapters
  private hub: ResourceEventHub | undefined
  private unwatch: (() => void) | undefined

  constructor(radio: RadioToolAdapters, player: MusicPlayerAdapters) {
    this.radio = radio
    this.player = player
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
  }

  /**
   * 退订。由登记方在 unmount **之后**调(见文件头);幂等 —— 第二次什么都不做。
   */
  dispose(): void {
    this.unwatch?.()
    this.unwatch = undefined
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
  async read(name: string, ref: ResourceRef | null, _query: unknown, _ctx: ResourceReadContext): Promise<unknown> {
    this.assertRef(name, ref)
    switch (name) {
      case 'nowPlaying':
        return nowPlayingView(this.player.nowPlaying())
      case 'radio':
        return this.radio.status()
      default:
        // 走不到:两条读路都先查过读法名在不在自述里。留一句诚实的错。
        throw new TypeError(`Music resource has no read named ${JSON.stringify(name)}`)
    }
  }

  async plan(op: string, ref: ResourceRef | null, params: unknown, _ctx: PlanContext): Promise<Intent<MusicOpPayload>> {
    this.assertRef(op, ref)
    const plan = (payload: MusicOpPayload, title: string): Intent<MusicOpPayload> =>
      planFromSpec<MusicOpPayload>(this.spec, op, ref, payload, { title })

    if (op === 'open' || op === 'retune') {
      const intent = stringParam(params, 'intent')
      // 一个字从来不是一个方向 —— 历史上全是占位符('x'),而拿占位符当简报的电台
      // 是在盲编节目单(旧 `radio` 那一行的理由,原样)。
      if (intent.length < 2) throw new MusicIntentRequiredError()
      return plan({ op, intent }, op === 'retune' ? `Retune the radio to ${intent}` : `Open the radio: ${intent}`)
    }

    if (op === 'close') return plan({ op }, 'Close the radio')

    if (op === 'request') {
      const song = stringParam(params, 'song')
      if (!song) throw new MusicSongRequiredError()
      return plan({ op, song }, `Request ${song}`)
    }

    const command = Object.prototype.hasOwnProperty.call(PLAYER_COMMANDS, op) ? PLAYER_COMMANDS[op] : undefined
    if (!command) throw new TypeError(`Music resource has no op named ${JSON.stringify(op)}`)
    return plan({ op, command } as MusicOpPayload, `Player: ${command}`)
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
        if (!requested.success) {
          return this.done(ctx, '点歌失败', requested.error ?? '点歌失败', payload.op)
        }
        return this.done(
          ctx,
          '已插队',
          `「${requested.title}」将在下一首播出${requested.error ? `(${requested.error})` : ''}。向用户确认时报这个完整歌名。`,
          payload.op,
        )
      }
      default: {
        const answered = await this.player.command(payload.command, operator)
        /*
         * 播放器四条说不 = `Outcome.failed`,**与点歌那一条刻意不同**。
         *
         * 点歌有旧行为要守(`ok` + 那句话,见上);这四条是 K3-b 新开的,没有任何
         * 旧口径要照抄,于是按管线自己的规矩来:「暂停失败了」不是一次成功的调用。
         * 带出去的那句话是回执自己写的(守护进程走了 / CLI 拒绝了),这里不发明文案。
         */
        if (!answered.success) {
          throw new MusicCommandFailedError(payload.command, answered.error ?? `${payload.command} 失败`)
        }
        const nowPlaying = this.player.nowPlaying(operator)
        return this.done(
          ctx,
          PLAYER_TITLES[payload.op],
          nowPlaying?.title ? `${PLAYER_TITLES[payload.op]}:${nowPlaying.title}` : PLAYER_TITLES[payload.op],
          payload.op,
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

  private done(ctx: RunContext, title: string, output: string, op: string): Result {
    // 注记与旧 `radio` 逐格同形(`title` + `details.action`),只是那一格的名字跟着
    // 词汇改了:资源面上「这次做的是哪一条」叫 op,不叫 action。
    ctx.emit({ type: 'annotate', title, details: { op } })
    return { content: [{ type: 'text', text: output }], details: { op } }
  }
}

/**
 * 播放器那一半的成品适配器:与 `radioAdapters()` 同一个形状、同一道信任门
 * (`assertMusicOperator(fixedExecutionContext(…))`)、同一个「音乐服务不在就抛」
 * 的取法。
 */
export function musicPlayerAdapters(): MusicPlayerAdapters {
  const captured = getCurrentBackendInstance()?.music
  const music = () => {
    if (!captured) throw new Error('Music service is unavailable')
    return captured
  }
  return {
    command: (command, executionContext) => {
      assertMusicOperator(fixedExecutionContext(executionContext))
      return music().operations.runMusicCommand({ command })
    },
    nowPlaying: executionContext => {
      assertMusicOperator(fixedExecutionContext(executionContext))
      return music().service.getMusicNowPlaying()
    },
    watchNowPlaying: listener => music().onNowPlayingChanged(listener),
  }
}

/** 这台宿主上的音乐资源。电台那一半**复用**既有工厂,不抄第二遍。 */
export function createMusicResourceProvider(): MusicResourceProvider {
  return new MusicResourceProvider(radioAdapters(), musicPlayerAdapters())
}
