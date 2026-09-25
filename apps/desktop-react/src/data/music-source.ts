import { useEffect, useSyncExternalStore } from 'react'
import type {
  MusicLyrics,
  MusicNowPlaying,
  MusicProgrammeEntryDTO,
  MusicRadioState,
  MusicRuntimeState,
  MusicSearchRecordDTO,
} from '@shared/ipc/music'
import type { ResourceOutcomeView, ResourceReadView } from '@shared/ipc/resources'
import { createMutation, createQuery } from './kernel'
import type { Mutation, Query, Rollback } from './kernel'
import { appendInstallOutput, clearInstallOutput, resetInstallLog } from './music-setup-log'
import { noteHostReplied, resetHostReply } from './music-talk'
import { reconcilePlayback, withPlaying } from './music-playback'
import type { PlaybackIntent } from './music-playback'
import { musicPort } from './music-port'
import type { MusicResourceEvent } from './music-port'

/**
 * 音乐面的数据层(音乐收尾 · 壳半边)。**面板上每一颗按钮都走资源路**
 * (`resources.do`),与模型调 `music:player` 的那只工具是同一条 —— 那正是
 * 444f915f 把 `music` 域十四条退成资源投影之后要兑现的那半句话:
 * 「界面点按钮也走它」。
 *
 * ── 表在这里,分支不在这里 ──────────────────────────────────────────────
 * 这只文件里有两张**数据**表:读法四条(外加节目单一条,见下)与做法十四条。
 * 每一条做法只说三件事 —— 它作用在哪个单例上、按下去屏幕先怎么变(乐观补丁)、
 * 跑完之后要重问哪几条读数。除此之外一行 `if (op === …)` 都没有:发命令那一段
 * 是同一句 `port.do(ref, op, params)`。
 *
 * ── 为什么 `do` 的非 ok 结局在这里**抛** ───────────────────────────────
 * 端口那一层原样交出五支(判词在 `music-port.ts` 的头上)。到了这一层要折成
 * 一次 throw,理由是 `createMutation` 的形状:**回滚只挂在 catch 上**
 * (`mutation.ts` 里那句「先回滚再报错:屏幕上不许留一张后端没认下的牌」)。
 * 一次被拒绝的 `pause` 如果 resolve,乐观补丁就会永远留在屏幕上说「已经暂停了」
 * —— 而音乐还在响。所以 `denied` / `invalid` / `failed` / `aborted` 一律抛,
 * 四支各自带**后端自己那句话**(不在这里发明文案);面板读的是
 * `mutation.get().error`,那一行就是它。
 *
 * 这与「被拒绝不是错误」那条纪律不冲突:纪律说的是**结局不许在传输层被折掉**
 * (端口那一层完整地交了五支),而这里是消费方自己决定「对我来说这四支是同
 * 一件事:这一下没算数,把屏幕退回去」。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 状态先行:三张表(施工纪律第一条)。②③ 两张在 `content/MusicPanel.tsx` 的
 * 组件头上(它们说的是屏幕);这里只写 ① 生命周期,因为这条线不是一个组件。
 * ══════════════════════════════════════════════════════════════════════════
 *
 *  · 挂载    —— import 这只文件只建了五格空 query 与十四只 mutation,
 *                **零往返、零订阅**;
 *  · 首载    —— `openMusicSource()`(面板挂载时调一次):等传输面 ready →
 *                订上 `resource:event`(前缀 `music:`)→ 五条读数各 `ensure()`
 *                一次。**先订后拉**:拉的那一刻起的 `nowPlayingChanged` 不能漏
 *                (与 meter-source 同一条理由);
 *  · 事件到达 —— 按 `EVENT_INVALIDATES` 那张表标脏。有人在看就后台补拉、
 *                **不清屏**(律②);没人看就留个脏标记;
 *  · 换宿主  —— 面板从架子拖成浮窗 / 抬上舞台,拼贴树的结构共享保证它**不重挂**,
 *                所以这条线一格都不动:不退订、不重拉、屏幕上的读数一帧不闪。
 *                (真的重挂了也只是 refcount 一减一加,订阅换一份、读数留着。)
 *  · 卸载    —— `closeMusicSource()`:refcount 归零才退订。**读数留在格子里** ——
 *                下次开面板 `ensure()` 命中缓存,先画旧的再后台对账;
 *  · HMR     —— `resetMusicSource()`(复用同一口拆卸,不写第二套)。
 */

/* ── 地址:三个恒在的单例(自述 `runtime/src/music/resource-spec.ts`)────── */

export const MUSIC_SCHEME_PREFIX = 'music:'
export const MUSIC_RADIO_REF = 'music:radio'
export const MUSIC_PLAYER_REF = 'music:player'
export const MUSIC_PROVIDER_REF = 'music:provider'

/* ── 读数的形 ────────────────────────────────────────────────────────────── */

/**
 * `nowPlaying` 读法的形。它是 `MusicNowPlaying` **多一格 `playing`** ——
 * 资源面刻意把「守护进程没起」折成一份「停着」的读数(自述那一格上写着理由),
 * 于是消费方不必再写一遍 `status === 'playing'`。
 */
export interface MusicNowPlayingView extends MusicNowPlaying {
  playing: boolean
  /**
   * `position` 是哪一刻的(墙钟 ms)。读回来那一刻由取数口盖上,乐观补丁换状态时一起换
   * (`music-playback.ts` `withPlaying`)。播放钟从这一刻往前推 —— 从前用的是「对象换了身份」
   * 的那一刻,于是暂停补丁一落,唱臂退回到那份旧读数的位置(09-25「暂停播放时的状态衔接」)。
   */
  sampledAt?: number
}

/** `programme` 读法的形。 */
export interface MusicProgrammeView {
  entries: MusicProgrammeEntryDTO[]
  onDeck?: string
}

/* ── 结局 → 一句人话 ─────────────────────────────────────────────────────── */

/**
 * 四支非 ok 的读结局各自那句话。**不发明文案** —— 每一支交的都是后端自己写的
 * 那一句,壳只负责挑出它在哪一格上。
 */
function readFailureText(view: ResourceReadView): string {
  switch (view.kind) {
    case 'invalid':
      return view.message
    case 'denied':
      return view.reason
    case 'failed':
      return view.error.message
    default:
      return ''
  }
}

/** 同上,做法那一侧多一支 `aborted`(读没有那一档)。 */
function outcomeFailureText(view: ResourceOutcomeView): string {
  switch (view.kind) {
    case 'invalid':
      return view.message
    case 'denied':
      return view.reason
    case 'aborted':
      return view.reason ?? ''
    case 'failed':
      return view.error.message
    default:
      return ''
  }
}

async function readResource<T>(
  ref: string,
  name: string,
  query?: Record<string, unknown>,
): Promise<T> {
  const port = await musicPort()
  await port.ready()
  const answer = await port.read(ref, name, query)
  if (answer.kind === 'ok') return answer.value as T
  throw new Error(readFailureText(answer))
}

/* ── 五条读数 ────────────────────────────────────────────────────────────── */

/** 音乐条画一帧要的那一份:开没开、简报、还剩几首、续得了播吗、音量。 */
export const musicBriefQuery = createQuery<MusicRadioState>('music.brief', () =>
  readResource<MusicRadioState>(MUSIC_RADIO_REF, 'brief'),
)

/**
 * 现在在放什么。**live** —— 靠 `nowPlayingChanged` 推着走,壳不轮询。
 *
 * 每一发读都领一个票号,读回来先过 `reconcilePlayback`:人刚按了 ⏯ 而后端还没确认时,
 * 「在放 / 停着」那一格听人的,不听这份(它可能是按下去之前就发出去的旧读数)。判据在 `music-playback.ts`。
 */
export const musicNowPlayingQuery = createQuery<MusicNowPlayingView>('music.nowPlaying', async () => {
  const ticket = ++playbackReadTicket
  const fetched = { ...(await readResource<MusicNowPlayingView>(MUSIC_PLAYER_REF, 'nowPlaying')), sampledAt: Date.now() }
  const settled = reconcilePlayback(fetched, ticket, playbackIntent)
  playbackIntent = settled.intent
  if (settled.disagreed) setPlaybackNotice('disagreed')
  return settled.view
})

/** 当前这首歌的定时歌词。**没有歌词是 `null`,不是一次失败**(自述原话)。 */
export const musicLyricsQuery = createQuery<MusicLyrics | null>('music.lyrics', () =>
  readResource<MusicLyrics | null>(MUSIC_PLAYER_REF, 'lyrics'),
)

/**
 * 排在后面的那些歌。
 *
 * **它是第五条**,派工单的读数清单里只列了四条 —— 但那张单子同时要求节目单
 * 列一列、并且要回答「100 条的形」。`brief` 只有 `programmeLength` 与 `upNext`
 * 两格,列不出一张表,所以这一条是列表**唯一**的产地(让面板拿 `upNext` 拼一张
 * 假名单才是「出口自己算事实」)。
 */
export const musicProgrammeQuery = createQuery<MusicProgrammeView>('music.programme', () =>
  readResource<MusicProgrammeView>(MUSIC_RADIO_REF, 'programme'),
)

/** 音乐后端装到哪一步了。面板据它画「还没配好」那一档。 */
export const musicRuntimeQuery = createQuery<MusicRuntimeState>('music.state', () =>
  readResource<MusicRuntimeState>(MUSIC_PROVIDER_REF, 'state'),
)

/** 面板首载要的全部。次序无所谓 —— 五发并行,各落各的格。 */
const ALL_QUERIES: readonly Query<unknown>[] = [
  musicBriefQuery,
  musicNowPlayingQuery,
  musicLyricsQuery,
  musicProgrammeQuery,
  musicRuntimeQuery,
] as unknown as readonly Query<unknown>[]

/* ── 十四条做法 ──────────────────────────────────────────────────────────── */

export type MusicOpName =
  | 'open'
  | 'retune'
  | 'close'
  | 'request'
  | 'radioResume'
  | 'radioStop'
  | 'pause'
  | 'resume'
  | 'next'
  | 'prev'
  | 'seek'
  | 'volume'
  | 'like'
  | 'programmeAction'

export type MusicOpParams = Record<string, unknown>

interface MusicOpSpec {
  /** 它作用在哪个单例上。**与后端那张 `MEMBER_TARGET` 同一份分工**。 */
  ref: string
  /** 按下去屏幕先怎么变(律①)。返回回滚 —— 补丁与撤销出自同一处。 */
  optimistic?: (params: MusicOpParams) => Rollback | void
  /** 跑完之后要重问哪几条读数(对账,后台补拉不清屏)。 */
  affects: readonly { invalidate(): void }[]
}

/** `nowPlaying` 上打一个补丁,读不到旧值时什么都不做(没有可乐观的对象)。 */
function patchNowPlaying(next: (prev: MusicNowPlayingView) => MusicNowPlayingView): Rollback {
  return musicNowPlayingQuery.patch((prev) => (prev ? next(prev) : prev))
}

function patchBrief(next: (prev: MusicRadioState) => MusicRadioState): Rollback {
  return musicBriefQuery.patch((prev) => (prev ? next(prev) : prev))
}

/**
 * 节目单的一次编辑,纯函数(`programmeAction` 的乐观补丁与单测共用)。
 * 形状照后端 `PROGRAMME_ACTION_PARAMS`:`{ action: { kind, encryptedId, toIndex? } }`。
 * 认不出的编辑原样交回 —— 读不懂就不猜,等对账那一发把真相拉回来。
 */
export function applyProgrammeAction(view: MusicProgrammeView, params: MusicOpParams): MusicProgrammeView {
  const action = params.action as { kind?: unknown; encryptedId?: unknown; toIndex?: unknown } | undefined
  if (!action || typeof action.encryptedId !== 'string') return view
  const from = view.entries.findIndex((e) => e.encryptedId === action.encryptedId)
  if (from < 0) return view
  const entries = [...view.entries]
  const [entry] = entries.splice(from, 1)
  if (action.kind === 'remove') return { ...view, entries }
  const to =
    action.kind === 'promote'
      ? 0
      : action.kind === 'move' && typeof action.toIndex === 'number' && Number.isFinite(action.toIndex)
        ? Math.max(0, Math.min(entries.length, Math.trunc(action.toIndex)))
        : undefined
  if (to === undefined) return view
  entries.splice(to, 0, entry)
  return { ...view, entries }
}

function numberParam(params: MusicOpParams, key: string): number | undefined {
  const value = params[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 做法表。**每一行三格,一个分支都没有** —— 加一条做法 = 这张表加一行
 * (以及面板上一颗钮),`runMusicOp` 与十四只 mutation 的装配一个字不动。
 */
const OPS: Readonly<Record<MusicOpName, MusicOpSpec>> = {
  /* ── 电台六条 ───────────────────────────────────────────────────────── */
  open: { ref: MUSIC_RADIO_REF, affects: [musicBriefQuery, musicProgrammeQuery, musicNowPlayingQuery] },
  retune: { ref: MUSIC_RADIO_REF, affects: [musicBriefQuery, musicProgrammeQuery, musicNowPlayingQuery] },
  close: {
    ref: MUSIC_RADIO_REF,
    // 关台:简报上那一格**先**变。开台不做乐观补丁 —— 开台是一段要跑约一分钟
    // 的活(DJ 现编节目单),抢着说「开了」比等着更不诚实。
    optimistic: () => patchBrief((prev) => ({ ...prev, active: false })),
    affects: [musicBriefQuery, musicProgrammeQuery, musicNowPlayingQuery],
  },
  request: { ref: MUSIC_RADIO_REF, affects: [musicProgrammeQuery, musicBriefQuery] },
  radioResume: { ref: MUSIC_RADIO_REF, affects: [musicBriefQuery, musicNowPlayingQuery, musicLyricsQuery] },
  radioStop: {
    ref: MUSIC_RADIO_REF,
    optimistic: () => patchBrief((prev) => ({ ...prev, active: false })),
    affects: [musicBriefQuery, musicNowPlayingQuery, musicLyricsQuery],
  },

  /* ── 播放器七条 ─────────────────────────────────────────────────────── */
  pause: {
    ref: MUSIC_PLAYER_REF,
    optimistic: () => patchNowPlaying((prev) => withPlaying(prev, false)),
    affects: [musicNowPlayingQuery],
  },
  resume: {
    ref: MUSIC_PLAYER_REF,
    optimistic: () => patchNowPlaying((prev) => withPlaying(prev, true)),
    affects: [musicNowPlayingQuery],
  },
  // 换歌会换掉歌词,也会让节目单少一首 —— 三条一起对账。
  next: { ref: MUSIC_PLAYER_REF, affects: [musicNowPlayingQuery, musicLyricsQuery, musicBriefQuery, musicProgrammeQuery] },
  prev: { ref: MUSIC_PLAYER_REF, affects: [musicNowPlayingQuery, musicLyricsQuery] },
  seek: {
    ref: MUSIC_PLAYER_REF,
    optimistic: (params) => {
      const position = numberParam(params, 'position')
      if (position === undefined) return undefined
      return patchNowPlaying((prev) => ({ ...prev, position, sampledAt: Date.now() }))
    },
    affects: [musicNowPlayingQuery],
  },
  volume: {
    ref: MUSIC_PLAYER_REF,
    // 音量住在**简报**里(`brief.volume` —— 播放器自己那份 prefs),不在 nowPlaying 上。
    optimistic: (params) => {
      const level = numberParam(params, 'level')
      if (level === undefined) return undefined
      return patchBrief((prev) => ({ ...prev, volume: level }))
    },
    affects: [musicBriefQuery],
  },
  // 红心不改任何一条读数上的格子(它落在服务端的喜欢列表里)。**不对账** ——
  // 为一件读不回来的事发一发请求,是拿刷新冒充反馈。
  like: { ref: MUSIC_PLAYER_REF, affects: [] },

  /* ── 节目单编辑(唱机面 M1,2026-09-17)──────────────────────────────── */
  // 拿掉 / 提前 / 挪位。行先在屏上动(律①),简报里那格「还剩几首」跟着对账。
  programmeAction: {
    ref: MUSIC_RADIO_REF,
    optimistic: (params) =>
      musicProgrammeQuery.patch((prev) => (prev ? applyProgrammeAction(prev, params) : prev)),
    affects: [musicProgrammeQuery, musicBriefQuery],
  },
}

/** 发一条做法。**全表共用这一句** —— 非 ok 一律抛,理由在文件头。 */
async function sendMusicOp(ref: string, op: string, params: MusicOpParams): Promise<void> {
  const port = await musicPort()
  const outcome = await port.do(ref, op, params)
  if (outcome.kind === 'ok') return
  throw new Error(outcomeFailureText(outcome))
}

function runMusicOp(op: MusicOpName, params: MusicOpParams): Promise<void> {
  return sendMusicOp(OPS[op].ref, op, params)
}

function createMusicOp(op: MusicOpName): Mutation<MusicOpParams, void> {
  const spec = OPS[op]
  return createMutation<MusicOpParams, void>(`music.${op}`, {
    run: (params) => runMusicOp(op, params),
    optimistic: (params) => spec.optimistic?.(params),
    settle: () => {
      for (const query of spec.affects) query.invalidate()
    },
  })
}

const OP_NAMES = Object.keys(OPS) as MusicOpName[]

/**
 * **一只做法一只 mutation**(派工单原话)。装配那一段只写一遍;每一只有自己的
 * `pending` 与自己的 `error`,于是「按了暂停,暂停那颗钮转、别的钮照常能点」
 * 是形状而不是自觉(律③逐格 pending,病型 B 的疫苗)。
 */
export const musicOps = Object.fromEntries(
  OP_NAMES.map((op) => [op, createMusicOp(op)]),
) as Readonly<Record<MusicOpName, Mutation<MusicOpParams, void>>>

/* ── 播放 / 暂停:意图先行(2026-09-25,正本 §11)──────────────────────────────── */

/**
 * 人要的「在放 / 停着」(见 `music-playback.ts`)。模块级,因为它说的是**那一台播放器**:同一块面在
 * 两处宿主里各画一份时,两份都该听同一个意图。`resetMusicSource` 清它。
 */
let playbackIntent: PlaybackIntent | null = null
/** 读数的票号(单调递增)。 */
let playbackReadTicket = 0
/** 有没有一发 pause / resume 在路上。同一时刻最多一发 —— 连点只会让**最后那个意图**被追上。 */
let playbackSending = false
/** 播放器最后一次被告知 / 被确认的状态。意图与它不同才需要发一发。 */
let playbackPlayerPlaying: boolean | undefined

/** 真正发出去的那一发。`true` = 后端说照做了;`undefined` = 没算数(错话在 `.get().error`)。 */
export const musicPlaybackOp = createMutation<{ playing: boolean }, true>('music.playback', {
  run: async ({ playing }) => {
    await sendMusicOp(MUSIC_PLAYER_REF, playing ? 'resume' : 'pause', {})
    return true
  },
})

/** 「后端说照做了、播放器却不是那样」这一句。屏幕上一行话,下一次按 ⏯ 时撤掉。 */
export type MusicPlaybackNotice = 'disagreed'
let playbackNotice: MusicPlaybackNotice | undefined
const playbackNoticeListeners = new Set<() => void>()
function setPlaybackNotice(next: MusicPlaybackNotice | undefined): void {
  if (playbackNotice === next) return
  playbackNotice = next
  for (const listener of playbackNoticeListeners) listener()
}
export function useMusicPlaybackNotice(): MusicPlaybackNotice | undefined {
  return useSyncExternalStore(
    (listener) => {
      playbackNoticeListeners.add(listener)
      return () => playbackNoticeListeners.delete(listener)
    },
    () => playbackNotice,
  )
}

/**
 * **按 ⏯**。屏幕这一帧就换(读数打补丁),不等任何往返;然后按序把播放器追到人要的那一格:
 *
 *  · 同一时刻只有一发在路上。它回来之后若意图又变了(连点),再发一发 —— 最后停在人最后按的那一格,
 *    不会三发并行、也不会乱序;
 *  · 一发没算数:意图作废,屏幕回到播放器上一次确认过的那一格,错话在 `musicPlaybackOp` 上(零 Toast);
 *  · 全部照做之后,**再问一次**:那一份读数是权威(票号在确认之后),与意图一致就交还给读数,不一致
 *    就照读数画并说一句 `disagreed`。
 *
 * 没歌(`title` 缺席)时什么都不做 —— 那时 ⏯ 的意思是「开台 / 续播」,不归这里。
 */
export function setMusicPlaying(playing: boolean): void {
  const shown = musicNowPlayingQuery.get().data
  if (!shown?.title) return
  setPlaybackNotice(undefined)
  if (!playbackIntent) {
    // 这一串按键的起点:播放器此刻(读数说)是什么样。
    playbackPlayerPlaying = shown.playing
    if (shown.playing === playing) return
  }
  playbackIntent = { playing }
  musicNowPlayingQuery.patch((prev) => (prev ? withPlaying(prev, playing) : prev))
  void pumpPlayback()
}

async function pumpPlayback(): Promise<void> {
  if (playbackSending) return
  playbackSending = true
  try {
    while (playbackIntent && playbackIntent.playing !== playbackPlayerPlaying) {
      const target = playbackIntent.playing
      const done = await musicPlaybackOp.run({ playing: target })
      if (!done) {
        playbackIntent = null
        const last = playbackPlayerPlaying
        musicNowPlayingQuery.patch((prev) => (prev && last !== undefined ? withPlaying(prev, last) : prev))
        break
      }
      playbackPlayerPlaying = target
    }
    // 追上了:从这一刻起发出去的读数才是权威。
    if (playbackIntent) playbackIntent = { ...playbackIntent, ackTicket: playbackReadTicket }
  } finally {
    playbackSending = false
  }
  musicNowPlayingQuery.invalidate()
}

/* ── 跟主持人说话(2026-09-18,正本 §7.2)────────────────────────────────── */

/**
 * `tell` 也是一条做法,**却不在上面那张表里**,理由只有一个:那张表的第三格是
 * 「跑完之后要重问哪几条读数」,而这一条一条都不重问 —— 它什么读数都不改。
 * 真正会变的东西(节目单、正在放的歌)是主持人自己接下来去改的,那些改动各自会
 * 发自己的事实,上面那张 `EVENT_INVALIDATES` 照旧接着。
 *
 * 它另有一处与那十四条不同:**要分得清成没成**。`createMusicOp` 交的是 `void`,
 * 于是成功与失败都 resolve 成 `undefined`,而这一条的失败有一件非做不可的事 ——
 * 把人打的字还回输入框(§7.3)。所以这里交 `true`:`undefined` = 这一下没算数,
 * 那句话在 `musicTellOp.get().error` 上。
 */
export const musicTellOp = createMutation<{ text: string }, true>('music.tell', {
  run: async ({ text }) => {
    await sendMusicOp(MUSIC_RADIO_REF, 'tell', { text })
    return true
  },
})

/* ── 搜索与「从搜索里点一首」(音乐面 v9,2026-09-25;正本 §10.5)──────────────── */

/**
 * 搜索是一条**带参数的读法**(`music:provider` · `search { query }`),可它不进那五格 query:
 * 查询键是人打的那句话,一格 query 装不下「每一句话一份答案」,而这块面也只要**最近那一次**
 * 的答案。所以它是一只 mutation —— 人按回车那一下才发,`pending` 让搜索钮自己转(律③),
 * 答案由调用方留在自己那一格里(旧结果在新结果回来之前一行不动,律②)。
 */
export const musicSearchOp = createMutation<{ query: string }, MusicSearchRecordDTO[]>('music.search', {
  run: async ({ query }) => {
    const answer = await readResource<{ records?: MusicSearchRecordDTO[] }>(MUSIC_PROVIDER_REF, 'search', { query })
    return answer.records ?? []
  },
})

/** 搜索结果里的一行被点了。`song` 是「歌名 歌手」,`radioOn` 决定走哪条做法。 */
export interface MusicPickInput {
  song: string
  radioOn: boolean
}

/**
 * **从搜索结果里放一首**。两条路,都是既有的做法,不新开:
 *  · 电台开着 → `request { song }`:插到下一首(自述原话:电台开着时**绝不**手动放);
 *  · 电台关着 → `open { intent }`:以「先放这首,再接相似的」开台 —— 这台机器上放歌的唯一正路
 *    就是电台,手动放单曲是模型经 bash 的事,不是面板的。
 * 按 `song` 分格(`key`),于是点了第三行只有第三行的钮在转(律③,病型 B 的疫苗)。
 */
export const musicPickOp = createMutation<MusicPickInput & { intent: string }, void>('music.pick', {
  key: ({ song }) => song,
  run: ({ song, radioOn, intent }) =>
    radioOn ? sendMusicOp(MUSIC_RADIO_REF, 'request', { song }) : sendMusicOp(MUSIC_RADIO_REF, 'open', { intent }),
  settle: () => {
    for (const query of OPS.request.affects) query.invalidate()
    for (const query of OPS.open.affects) query.invalidate()
  },
})

/**
 * 「重试」:五条读数全标脏,后台重问。状态条上那颗「重新连接」钮走这里 —— 后端刚刚没答上,
 * 人按一下就该再问一遍,而不是等下一条事实路过。
 */
export function refreshMusicSource(): void {
  for (const query of ALL_QUERIES) query.invalidate()
}

/* ── 接入向导那八步(2026-09-18,正本 §6.3)──────────────────────────────── */

/**
 * 向导那一条做法叫 `setup`,而**它的每一格该有自己的忙态与自己的错话**:
 * 第 ① 步屏上有两行工具,装 `ncm-cli` 的时候 `mpv` 那一行的钮不该跟着转圈,
 * `ncm-cli` 失败那句话更不该抄到 `mpv` 那一行上(律③逐格 pending,病型 B)。
 *
 * kernel 的 `pendingKey` 只把**忙态**分了格,`error` 仍是一只 mutation 一份。
 * 所以这里按格各建一只 —— `createMutation` 就是一只闭包,建十只与建一只同价,
 * 而换来的是「一格的失败只说在那一格上」。
 */
export type MusicSetupAction =
  | 'check-env'
  | 'install-tool'
  | 'set-credentials'
  | 'set-player'
  | 'login-start'
  | 'login-cancel'
  | 'login-check'
  | 'logout'

/** 一格 = 一个动作,外加 `install-tool` 的那一格工具 id。 */
function setupCell(action: MusicSetupAction, tool?: string): string {
  return tool ? `${action}:${tool}` : action
}

const setupMutations = new Map<string, Mutation<MusicOpParams, void>>()

/**
 * 那一格的 mutation。同一格永远是同一只(界面按 `pending` / `error` 读它,
 * 每次渲染换一只新的等于每次渲染都把忙态与错话清了)。
 */
export function musicSetupOp(action: MusicSetupAction, tool?: string): Mutation<MusicOpParams, void> {
  const cell = setupCell(action, tool)
  const existing = setupMutations.get(cell)
  if (existing) return existing
  const created = createMutation<MusicOpParams, void>(`music.setup.${cell}`, {
    run: (params) =>
      // 地址是 `music:provider` —— 与后端那张 `MEMBER_TARGET` 同一份分工。
      sendMusicOp(MUSIC_PROVIDER_REF, 'setup', { action, ...(tool ? { tool } : {}), ...params }),
    // 重装一次就把上一次的输出(尤其失败那一段)清掉 —— 新的一次不该顶着旧错话跑。
    optimistic: () => {
      if (action === 'install-tool' && tool) clearInstallOutput(tool)
    },
    // 每一步之后重问那一份状态。后端也会发一条 `setupChanged`,两边标的是同一格 ——
    // query 自己会把同一拍的两次标脏并成一发,所以这里照旧写全,不靠事件兜底。
    settle: () => musicRuntimeQuery.invalidate(),
  })
  setupMutations.set(cell, created)
  return created
}

/* ── 事实到了,重问哪几条 ─────────────────────────────────────────────── */

/**
 * `resource:event` → 标脏哪几格。**表,不是 switch**:后端将来多发一种事实,
 * 这里加一行;不在表上的事实**当没看见**(不是"保险起见全刷一遍" —— 那会让
 * 一条与音乐无关的事实每来一次就多五发请求)。
 */
const EVENT_INVALIDATES: Readonly<Record<string, readonly { invalidate(): void }[]>> = {
  nowPlayingChanged: [musicNowPlayingQuery, musicLyricsQuery, musicBriefQuery],
  /*
   * 这首的歌词取到了(或确认取不到)。歌词是换歌**之后**才取的,`nowPlayingChanged` 那一刻重读
   * 拿到的还是上一首的 —— 没有这一行,歌词要等下一次随便什么事实路过才上屏(09-18 报障)。
   */
  lyricsChanged: [musicLyricsQuery],
  radioOpened: [musicBriefQuery, musicProgrammeQuery, musicNowPlayingQuery],
  radioClosed: [musicBriefQuery, musicProgrammeQuery, musicNowPlayingQuery],
  providerChanged: [
    musicRuntimeQuery,
    musicBriefQuery,
    musicProgrammeQuery,
    musicNowPlayingQuery,
    musicLyricsQuery,
  ],
  /*
   * 向导走完一步(§6.1「壳订它重拉 `state`」)。发起那一步的人自己也会标脏同一格
   * —— 两处都写不是啰嗦:一次 `setup` 可能是**别处**发起的(模型、另一扇窗),
   * 那时只有这条事实能把屏幕拉回同一份真相。
   */
  setupChanged: [musicRuntimeQuery],
  /*
   * 主持人回了一句(§7.1)。**一条读数都不标脏**:他说的话不在任何一份读数里,
   * 而他顺手改掉的东西(节目单、换的歌)各自会发自己的事实。它在这张表上留着一行
   * 空的,是为了说清「看见了,而且确实不必重问」—— 不写的话下一个人会以为漏了。
   */
  hostReplied: [],
}

function onMusicFact(fact: MusicResourceEvent): void {
  // 他回话了。屏幕这边要的是那一下(撤气泡、黑豆回姿势),不是那句话本身 ——
  // 那句话走宠物那条路,判词在 `music-talk.ts`。
  if (fact.event === 'hostReplied') {
    noteHostReplied()
    return
  }
  // 安装输出不进读数 —— 它是推来的进度,不是可重读的答案(判词在 `music-setup-log`)。
  if (fact.event === 'setupOutput') {
    const payload = fact.payload as { tool?: unknown; chunk?: unknown } | undefined
    if (typeof payload?.tool === 'string' && typeof payload.chunk === 'string') {
      appendInstallOutput(payload.tool, payload.chunk)
    }
    return
  }
  for (const query of EVENT_INVALIDATES[fact.event] ?? []) query.invalidate()
}

/* ── 这条线的开与关 ──────────────────────────────────────────────────────── */

/** 有几份面板挂着。归零才退订 —— 见文件头「换宿主」那一行。 */
let openCount = 0
let unsubscribe: (() => void) | undefined

export async function openMusicSource(): Promise<void> {
  openCount += 1
  if (openCount > 1) return
  const port = await musicPort()
  await port.ready()
  // 等 ready 的这一段里面板又被关掉了:这一发作废。
  if (openCount === 0) return
  unsubscribe?.()
  unsubscribe = port.onResourceEvent(MUSIC_SCHEME_PREFIX, onMusicFact)
  // 先订后拉(见文件头)。五发并行,一发失败不拦住别的四发。
  // **手上有读数的也要重问一次**(09-25「重新打开的时候歌词、进度是否正常」):面板关着的那段时间没订事件,
  // 换歌、暂停、歌词到了都没人标脏 —— `ensure()` 只会拿那份过期的读数当真。重问是后台对账,旧读数留在屏上
  // 直到新的到(律②),所以打开那一刻不闪。
  await Promise.all(ALL_QUERIES.map((query) => (query.get().data === undefined ? query.ensure() : query.refetch())))
}

export function closeMusicSource(): void {
  if (openCount > 0) openCount -= 1
  if (openCount > 0) return
  unsubscribe?.()
  unsubscribe = undefined
}

/** 回到出厂:退订 + 五格读数归零 + 做法(含向导那几格)归零 + 安装输出清空。测试与 HMR 用。 */
export function resetMusicSource(): void {
  openCount = 0
  unsubscribe?.()
  unsubscribe = undefined
  for (const query of ALL_QUERIES) query.reset()
  for (const op of OP_NAMES) musicOps[op].reset()
  // 向导那几格是**按需建**的,所以清的是整张表而不是一张固定名单 —— 建过的那几只
  // 界面还拿着引用(`musicSetupOp` 认 cell 不认次数),归零而不是丢掉。
  for (const mutation of setupMutations.values()) mutation.reset()
  musicTellOp.reset()
  musicPlaybackOp.reset()
  playbackIntent = null
  playbackSending = false
  playbackPlayerPlaying = undefined
  setPlaybackNotice(undefined)
  musicSearchOp.reset()
  musicPickOp.reset()
  resetInstallLog()
  resetHostReply()
}

/**
 * 面板挂着的那一段就是这条线活着的那一段。**唯一的挂载点** —— 组件里不再写
 * 第二段 effect(两处订阅迟早漏一格)。
 */
export function useMusicLive(): void {
  useEffect(() => {
    void openMusicSource()
    return () => closeMusicSource()
  }, [])
}

/*
 * 模块级副作用 = 这个模块实例的寿命(09-01 立法)。这只文件有三样:那条
 * `resource:event` 订阅、`openCount` 那格记号、五格 query 各自的监听表。
 * 退役**复用已有的那一口拆卸**(`resetMusicSource`),不写第二套;它自身幂等。
 * 生产构建里 `import.meta.hot` 是 undefined,整段被 tree-shake。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(resetMusicSource)
}
