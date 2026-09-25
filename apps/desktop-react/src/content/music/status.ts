import type { MusicRadioState, MusicRuntimeState } from '@shared/ipc/music'
import type { MusicNowPlayingView } from '../../data/music-source'
import type { MessageKey } from '../../i18n'
import type { StatusDotTone } from '../../ui/StatusDot'
import { MUSIC_ACCOUNT_SECTION, MUSIC_RADIO_SECTION } from './section-ids'

/**
 * **音乐面的状态单产地**(音乐面 v9「成熟的音乐 App」,2026-09-25;正本 `docs/music-panel-2026-09.md` §10)。
 *
 * 用户那一条硬要求:「状态有反馈、用户能够知道状态」。从前这句话散在五处 —— 顶上一行错话、唱片里的
 * 「关着」、黑豆的姿势、⏯ 的标签、向导 —— 每一处答对了自己那一格,却没有一处能回答「**音乐这边此刻
 * 怎么样**」。这只文件就是那一句话:读进后端的几份读数,吐出**一个**状态,檐上的状态丸、状态条、
 * 读屏播报都读它,于是三处永远说同一句话。
 *
 * ── 表在这里,判据只有一条优先序 ────────────────────────────────────────
 * 每一种状态是 `MUSIC_STATUS_TABLE` 上的一行:色调、一句名字、一句「接下来怎么办」、要不要上状态条、
 * 一个动作(去哪一格 / 重试 / 接着放)。`deriveMusicStatus` 只负责按优先序挑出是哪一行,**不写文案、
 * 不画东西**。加一种状态 = 表上一行 + 优先序里一格;面板一个字不动。
 *
 * 优先序(先命中先赢,理由逐条):
 *  ① 连接中 / 连不上 —— 后端都不在,别的读数没有意义;
 *  ② 还没装好 / 还没登录 —— 没登录什么都放不出来,这是第一件要让人知道的事;
 *  ③ 出错 —— 后端或某一颗钮刚说了一句坏消息;
 *  ④ 开台中 / 换歌中 —— 一段要等的活,说清「在忙,不是卡了」;
 *  ⑤ 在放 —— 最常见的一格;
 *  ⑥ DJ 在补歌单 —— 只在**没在放**时才上来(在放时这件事归黑豆,09-18 用户:「这个状态交给 pet 啊」);
 *  ⑦ 暂停 / 停在上次 / 电台开着但播放器没跑 / 关着。
 */

export type MusicStatusKind =
  | 'connecting'
  | 'unreachable'
  | 'setupEnv'
  | 'setupCredentials'
  | 'setupLogin'
  | 'loginWaiting'
  | 'error'
  | 'opening'
  | 'starting'
  | 'playing'
  | 'refilling'
  | 'paused'
  | 'resumable'
  | 'stationIdle'
  | 'off'

/** 状态条上那颗钮做什么。**是数据**:面板按 `kind` 分发,不认状态名。 */
export type MusicStatusAction =
  /** 去面板里的某一格(分区 id 见 `sections.tsx`,这里只是一个字符串)。 */
  | { kind: 'section'; section: string; labelKey: MessageKey }
  /** 重新问一遍后端(五条读数全标脏)。 */
  | { kind: 'retry'; labelKey: MessageKey }
  /** 从上次停下的地方接着放(`radioResume`)。 */
  | { kind: 'resume'; labelKey: MessageKey }

export interface MusicStatusRow {
  tone: StatusDotTone
  /** 状态丸上那一句(短,名词性)。 */
  labelKey: MessageKey
  /** 接下来怎么办 —— 操作指引。状态条与状态丸的 Tooltip 都读它。 */
  hintKey?: MessageKey
  /** 要不要在分区上方画一条状态条。**只有需要人注意的才画**:在放、暂停不值一条横幅。 */
  banner: boolean
  /**
   * 这一格本身是一段**进行中的等待**(开台、换歌、等扫码……):状态丸上的点换成转圈。说不出还要多久,
   * 所以不是进度条。它是状态的属性,不是某一发请求的忙态 —— 那一种归各自的 mutation。
   */
  ongoing?: boolean
  action?: MusicStatusAction
}

export { MUSIC_ACCOUNT_SECTION, MUSIC_RADIO_SECTION }

export const MUSIC_STATUS_TABLE: Readonly<Record<MusicStatusKind, MusicStatusRow>> = {
  connecting: { tone: 'idle', labelKey: 'music.status.connecting', banner: false, ongoing: true },
  unreachable: {
    tone: 'bad',
    labelKey: 'music.status.unreachable',
    hintKey: 'music.status.unreachableHint',
    banner: true,
    action: { kind: 'retry', labelKey: 'music.status.retry' },
  },
  setupEnv: {
    tone: 'warn',
    labelKey: 'music.status.setupEnv',
    hintKey: 'music.status.setupEnvHint',
    banner: false,
    action: { kind: 'section', section: MUSIC_ACCOUNT_SECTION, labelKey: 'music.status.goSetup' },
  },
  setupCredentials: {
    tone: 'warn',
    labelKey: 'music.status.setupCredentials',
    hintKey: 'music.status.setupCredentialsHint',
    banner: false,
    action: { kind: 'section', section: MUSIC_ACCOUNT_SECTION, labelKey: 'music.status.goSetup' },
  },
  setupLogin: {
    tone: 'warn',
    labelKey: 'music.status.setupLogin',
    hintKey: 'music.status.setupLoginHint',
    banner: false,
    action: { kind: 'section', section: MUSIC_ACCOUNT_SECTION, labelKey: 'music.status.goLogin' },
  },
  loginWaiting: {
    tone: 'info',
    labelKey: 'music.status.loginWaiting',
    hintKey: 'music.status.loginWaitingHint',
    banner: false,
    ongoing: true,
    action: { kind: 'section', section: MUSIC_ACCOUNT_SECTION, labelKey: 'music.status.goLogin' },
  },
  error: { tone: 'bad', labelKey: 'music.status.error', hintKey: 'music.status.errorHint', banner: true },
  opening: { tone: 'info', labelKey: 'music.status.opening', hintKey: 'music.status.openingHint', banner: true, ongoing: true },
  starting: { tone: 'info', labelKey: 'music.status.starting', banner: false, ongoing: true },
  playing: { tone: 'ok', labelKey: 'music.status.playing', banner: false },
  refilling: { tone: 'info', labelKey: 'music.status.refilling', hintKey: 'music.status.refillingHint', banner: true, ongoing: true },
  paused: { tone: 'idle', labelKey: 'music.status.paused', banner: false },
  resumable: {
    tone: 'idle',
    labelKey: 'music.status.resumable',
    hintKey: 'music.status.resumableHint',
    banner: false,
    action: { kind: 'resume', labelKey: 'music.deckContinue' },
  },
  // 电台开着、播放器停了:不是故障,按 ▶ 就接着放 —— 不上状态条(09-25 用户:「这是啥啊」)。
  stationIdle: {
    tone: 'idle',
    labelKey: 'music.status.stationIdle',
    hintKey: 'music.status.stationIdleHint',
    banner: false,
    action: { kind: 'resume', labelKey: 'music.radioResume' },
  },
  off: {
    tone: 'off',
    labelKey: 'music.status.off',
    hintKey: 'music.status.offHint',
    banner: false,
    action: { kind: 'section', section: MUSIC_RADIO_SECTION, labelKey: 'music.status.goRadio' },
  },
}

export interface MusicStatusInput {
  runtime?: MusicRuntimeState
  /** `state` 那一发读完了但没读到(后端整个不在)。 */
  runtimeUnreachable: boolean
  brief?: MusicRadioState
  /** 画在屏上的那一首(可能是「上次放到哪」拼出来的)。 */
  nowPlaying?: MusicNowPlayingView
  /** 画的是上次那一首,不是此刻在放的。 */
  restored: boolean
  /** 开台那一发在路上。 */
  opening: boolean
  /** 电台开着、节目单空了:DJ 在补。 */
  refilling: boolean
  /**
   * 后端或某颗钮刚说的那句坏话。**调用方已经排好版**(后端的 `lastError` 套一句「音乐后端报了一句」,
   * 钮的错话原样)—— 这里只认「有没有」,不写文案。
   */
  error?: string
}

export interface MusicStatus {
  kind: MusicStatusKind
  row: MusicStatusRow
  /** 表里那句话要填的空(错话原文、歌名)。 */
  vars: Record<string, string>
}

function status(kind: MusicStatusKind, vars: Record<string, string> = {}): MusicStatus {
  return { kind, row: MUSIC_STATUS_TABLE[kind], vars }
}

/** 按文件头那条优先序挑一行。纯函数,单测钉每一格。 */
export function deriveMusicStatus(input: MusicStatusInput): MusicStatus {
  const { runtime, brief, nowPlaying } = input
  if (runtime === undefined) return status(input.runtimeUnreachable ? 'unreachable' : 'connecting')
  switch (runtime.setupStage) {
    case 'env':
      return status('setupEnv')
    case 'credentials':
      return status('setupCredentials')
    case 'login':
      return status(runtime.login.status === 'waiting' ? 'loginWaiting' : 'setupLogin')
    default:
      break
  }
  if (input.error) return status('error', { message: input.error })
  if (input.opening) return status('opening')
  if (brief?.starting) return status('starting', { title: brief.starting })
  const title = nowPlaying?.title
  if (title && nowPlaying?.playing && !input.restored) return status('playing', { title })
  if (input.refilling) return status('refilling')
  if (title && input.restored) return status('resumable', { title })
  if (title) return status('paused', { title })
  if (brief?.active) return status(brief.canResume ? 'stationIdle' : 'refilling')
  return status('off')
}
