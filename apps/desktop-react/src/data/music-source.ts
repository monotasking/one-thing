import { useEffect } from 'react'
import type {
  MusicLyrics,
  MusicNowPlaying,
  MusicProgrammeEntryDTO,
  MusicRadioState,
  MusicRuntimeState,
} from '@shared/ipc/music'
import type { ResourceOutcomeView, ResourceReadView } from '@shared/ipc/resources'
import { createMutation, createQuery } from './kernel'
import type { Mutation, Query, Rollback } from './kernel'
import { musicPort } from './music-port'
import type { MusicResourceEvent } from './music-port'

/**
 * 音乐面的数据层(音乐收尾 · 壳半边)。**面板上每一颗按钮都走资源路**
 * (`resources.do`),与模型调 `music:player` 的那只工具是同一条 —— 那正是
 * 444f915f 把 `music` 域十四条退成资源投影之后要兑现的那半句话:
 * 「界面点按钮也走它」。
 *
 * ── 表在这里,分支不在这里 ──────────────────────────────────────────────
 * 这只文件里有两张**数据**表:读法四条(外加节目单一条,见下)与做法十三条。
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
 *  · 挂载    —— import 这只文件只建了五格空 query 与十三只 mutation,
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

/** 现在在放什么。**live** —— 靠 `nowPlayingChanged` 推着走,壳不轮询。 */
export const musicNowPlayingQuery = createQuery<MusicNowPlayingView>('music.nowPlaying', () =>
  readResource<MusicNowPlayingView>(MUSIC_PLAYER_REF, 'nowPlaying'),
)

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

/* ── 十三条做法 ──────────────────────────────────────────────────────────── */

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

function numberParam(params: MusicOpParams, key: string): number | undefined {
  const value = params[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 做法表。**每一行三格,一个分支都没有** —— 加一条做法 = 这张表加一行
 * (以及面板上一颗钮),`runMusicOp` 与十三只 mutation 的装配一个字不动。
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
    optimistic: () => patchNowPlaying((prev) => ({ ...prev, playing: false, status: 'paused' })),
    affects: [musicNowPlayingQuery],
  },
  resume: {
    ref: MUSIC_PLAYER_REF,
    optimistic: () => patchNowPlaying((prev) => ({ ...prev, playing: true, status: 'playing' })),
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
      return patchNowPlaying((prev) => ({ ...prev, position }))
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
}

/** 发一条命令。**十三条共用这一句** —— 非 ok 一律抛,理由在文件头。 */
async function runMusicOp(op: MusicOpName, params: MusicOpParams): Promise<void> {
  const port = await musicPort()
  const outcome = await port.do(OPS[op].ref, op, params)
  if (outcome.kind === 'ok') return
  throw new Error(outcomeFailureText(outcome))
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

/* ── 事实到了,重问哪几条 ─────────────────────────────────────────────── */

/**
 * `resource:event` → 标脏哪几格。**表,不是 switch**:后端将来多发一种事实,
 * 这里加一行;不在表上的事实**当没看见**(不是"保险起见全刷一遍" —— 那会让
 * 一条与音乐无关的事实每来一次就多五发请求)。
 */
const EVENT_INVALIDATES: Readonly<Record<string, readonly { invalidate(): void }[]>> = {
  nowPlayingChanged: [musicNowPlayingQuery, musicLyricsQuery, musicBriefQuery],
  radioOpened: [musicBriefQuery, musicProgrammeQuery, musicNowPlayingQuery],
  radioClosed: [musicBriefQuery, musicProgrammeQuery, musicNowPlayingQuery],
  providerChanged: [
    musicRuntimeQuery,
    musicBriefQuery,
    musicProgrammeQuery,
    musicNowPlayingQuery,
    musicLyricsQuery,
  ],
}

function onMusicFact(fact: MusicResourceEvent): void {
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
  await Promise.all(ALL_QUERIES.map((query) => query.ensure()))
}

export function closeMusicSource(): void {
  if (openCount > 0) openCount -= 1
  if (openCount > 0) return
  unsubscribe?.()
  unsubscribe = undefined
}

/** 回到出厂:退订 + 五格读数归零 + 十三只 mutation 归零。测试与 HMR 用。 */
export function resetMusicSource(): void {
  openCount = 0
  unsubscribe?.()
  unsubscribe = undefined
  for (const query of ALL_QUERIES) query.reset()
  for (const op of OP_NAMES) musicOps[op].reset()
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
