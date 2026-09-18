import { useEffect, useRef, useState } from 'react'
import { MusicPanel } from '../content/MusicPanel'
import { configureMusicPort } from '../data/music-port'
import { resetMusicSource } from '../data/music-source'
import type { MusicPort, MusicResourceEvent } from '../data/music-port'
import { configurePetPort, resetPetSource } from '../data/pet-source'
import type { ResourceEventFact, ResourcePort } from '../data/resource-port'
import type { ResourceOutcomeView, ResourceReadView } from '@shared/ipc/resources'
import { Segmented } from '../ui/Segmented'
import { useStageStore } from '../stage/store'
import s from './Gallery.module.css'

/**
 * 音乐面实验台 —— dev 工具,不进产品外壳。入口:任何 URL 加 `?music-lab`。
 *
 * 为什么有它:音乐面落在架子 / 浮窗 / 舞台三种宿主里,形随面板自己的宽变;唱机场景
 * (宠物 P1)还要把 §8.1 的每一种活动、换歌那一串、口播气泡都演一遍。真机上要凑出
 * 这些得真装 CLI 真登录;这里用一只**活的**假端口把读数直接喂出来 —— 改一格开关就是
 * 一次 `providerChanged`,面板**不重挂**,所以换歌那一串、起转落针、关台暗灯都看得见。
 * 数据是内容样本,原样写中文,不进字典(与 Gallery 同一条判据)。
 *
 * 假端口不碰任何真实 store;面板上的钮也能用:暂停 / 继续 / 跳过 / 拖唱臂改的是
 * 这一台的样本。
 */
/*
 * 正本 §5 那六档:300 / 360(底部弹层)· 620(右侧抽屉,仍是一栏)· 900(两栏的门槛)·
 * 1040 / 1280(两栏)。截图就照这六档 × 四态(有歌 / 没歌 / 抽屉开 / 歌词页)。
 */
const WIDTHS = [
  { value: '300', label: '300' },
  { value: '360', label: '360' },
  { value: '620', label: '620' },
  { value: '900', label: '900' },
  { value: '1040', label: '1040' },
  { value: '1280', label: '1280' },
] as const

const SONGS = ['雨棚下 - 旧电扇', '慢车 - 林间录音', '一首名字特别特别特别长的歌用来看看截断会不会把整行撑破 - 一位名字也很长的乐队主唱与他的朋友们']

const SAY_LONG =
  '这首底下有条热评说:「每次下雨都会想起一个没带伞的下午,公交车晚了十分钟,晚到刚好可以把那句话说完」。今晚听,刚好。'

interface LabState {
  /** SONGS 下标;-1 = 播放器里没歌。 */
  song: number
  player: 'playing' | 'paused' | 'stopped'
  radio: 'on' | 'off'
  /** 换歌中:简报带 starting,节目单里那一首带一句 say。 */
  starting: 'none' | 'say'
  fault: 'none' | 'player' | 'backend'
  /**
   * 向导停在哪一格,以及那一格的几种样子(正本 §6.3 / §6.5)。
   *
   *  · `ready`              配好了 —— 向导不在场,唱机出现;
   *  · `env` / `env-half`   两件工具都没装 / 装好一件(第 ① 步的两种样子);
   *  · `env-probing`        `env` 还没查过:两行占位,钮停用;
   *  · `cred`               第 ② 步;
   *  · `login-idle`         第 ③ 步,还没开始;
   *  · `login-wait`         拿到地址了 —— **二维码那一态**,演的主场;
   *  · `login-failed`       一行原话 + 「再试一次」;
   *  · `login-quota`        额度用完(照后端原文,不劝人重试)。
   */
  setup:
    | 'ready'
    | 'env'
    | 'env-half'
    | 'env-probing'
    | 'cred'
    | 'login-idle'
    | 'login-wait'
    | 'login-failed'
    | 'login-quota'
  /**
   * 歌词那一格(§8.5)。`loading` = 那一发**挂着不回**:骨架的判据是
   * 「从来没有过内容」(`phase === 'initial'`),一发答「读不到」只会得到错话那一档。
   */
  lyrics: 'ready' | 'loading'
  /** 主持人开没开口(§8.4)。`speaking` = 推一条 `utterance`,歌词让位。 */
  host: 'quiet' | 'speaking'
  programme: 'five' | 'many' | 'empty'
  /** 节目单的当下顺序(按 encryptedId)。`undefined` = 还没动过,按生成序。 */
  order?: readonly string[]
  position: number
}

const INITIAL: LabState = {
  song: 0,
  player: 'playing',
  radio: 'on',
  starting: 'none',
  fault: 'none',
  setup: 'ready',
  lyrics: 'ready',
  host: 'quiet',
  programme: 'five',
  position: 31,
}

function table(state: LabState): Record<string, ResourceReadView> {
  const on = state.radio === 'on'
  const nextTitle = SONGS[(Math.max(0, state.song) + 1) % SONGS.length]
  const count = state.programme === 'many' ? 64 : state.programme === 'empty' ? 0 : 5
  const entries = Array.from({ length: count }, (_, i) => ({
    encryptedId: `e${i}`,
    title: i === 0 ? nextTitle : ['凌晨便利店 - 霜降乐队', '潮汐表 - 北岸电台', '十二楼的风 - 苏河'][i % 3],
    say: i === 0 ? (state.starting === 'say' ? '下一张,旧电扇的《雨棚下》。前奏那点雨声是录进去的。' : SAY_LONG) : i % 3 === 2 ? undefined : '接下来,这一首。',
    note: i === 1 ? '点歌' : undefined,
  }))
  // 换过序就按那串 id 重排 —— 没有这一步,lab 里拖完会弹回去(假端口不认 move)。
  const ordered = state.order
    ? [...entries].sort((a, b) => {
        const ai = state.order?.indexOf(a.encryptedId) ?? -1
        const bi = state.order?.indexOf(b.encryptedId) ?? -1
        return (ai < 0 ? entries.length : ai) - (bi < 0 ? entries.length : bi)
      })
    : entries
  const title = state.song >= 0 ? SONGS[state.song] : undefined
  const ok = (value: unknown): ResourceReadView => ({ kind: 'ok', value })
  return {
    'music:radio#brief': ok(
      on
        ? {
            active: true,
            intent: '下雨天,安静点的,最好是中文民谣,别太吵',
            programmeLength: entries.length,
            canResume: true,
            volume: 62,
            ...(state.starting === 'say' ? { starting: nextTitle } : {}),
          }
        : { active: false, intent: '下雨天,安静点的', programmeLength: 4, canResume: true },
    ),
    'music:radio#programme': ok({ entries: on ? ordered : [], onDeck: title }),
    'music:player#nowPlaying':
      state.fault === 'player'
        ? { kind: 'failed', error: { name: 'MusicCommandFailedError', message: '播放器没起来' } }
        : ok(
            title === undefined || state.player === 'stopped'
              ? { playing: false, status: 'stopped', position: 0, queueLength: 0, currentIndex: 0 }
              : {
                  playing: state.player === 'playing',
                  status: state.player,
                  title,
                  position: state.position,
                  duration: 197,
                  queueLength: 1,
                  currentIndex: 0,
                },
          ),
    'music:player#lyrics': ok({
      title: title ?? '',
      lines: [
        [0, '♪'],
        [22, '雨落在铁皮雨棚上 像有人在数零钱'],
        [31, '我们挤在同一块屋檐 谁也没带伞'],
        [41, '公交车晚了十分钟 真好'],
        [50, '晚到可以把这句话 说完'],
        [62, '♪'],
      ].map(([at, text]) => ({ at, text })),
    }),
    'music:provider#state': ok(setupState(state)),
  }
}

/** 第 ① 步那两件工具此刻装没装。`env-probing` = 还没查过,整格缺席。 */
function envOf(setup: LabState['setup']): Record<string, unknown> | undefined {
  if (setup === 'env-probing') return undefined
  // `env-half` = ncm-cli 装上了、mpv 还没(点一下「安装」之后的样子)。
  const cli = setup !== 'env'
  const mpv = setup !== 'env' && setup !== 'env-half'
  return {
    tools: {
      'ncm-cli': cli ? { installed: true, version: '0.1.6' } : { installed: false },
      mpv: mpv ? { installed: true, version: '0.40.0' } : { installed: false },
    },
    npmAvailable: true,
    brewAvailable: true,
  }
}

const SETUP_STAGE: Readonly<Record<LabState['setup'], 'env' | 'credentials' | 'login' | 'ready'>> = {
  ready: 'ready',
  env: 'env',
  'env-half': 'env',
  'env-probing': 'env',
  cred: 'credentials',
  'login-idle': 'login',
  'login-wait': 'login',
  'login-failed': 'login',
  'login-quota': 'login',
}

/** 第 ③ 步那一格。地址是**一条真的网易云登录地址的形状** —— 码要编得出来才看得见。 */
const LOGIN: Readonly<Record<string, { status: string; url?: string; message?: string }>> = {
  'login-idle': { status: 'idle' },
  'login-wait': { status: 'waiting', url: 'https://music.163.com/login?codekey=8f3c1d5e-7a20-4b6f-9c11-2de4a8b07f63' },
  'login-failed': { status: 'failed', message: 'ncm-cli login 启动失败(退出码 1)' },
  'login-quota': { status: 'quota', message: '请求总量超限' },
  ready: { status: 'ok' },
}

function setupState(state: LabState): Record<string, unknown> {
  const env = envOf(state.setup)
  return {
    setupStage: SETUP_STAGE[state.setup],
    // 凭据这一步之前 = 还没写;之后 = 写过了(向导就是靠这两格自己走的)。
    configured: state.setup !== 'env' && state.setup !== 'env-half' && state.setup !== 'env-probing' && state.setup !== 'cred',
    loggedIn: state.setup === 'ready',
    playerBackend: 'mpv',
    source: 'daily',
    login: LOGIN[state.setup] ?? { status: 'idle' },
    ...(env ? { env } : {}),
    ...(state.fault === 'backend' ? { lastError: 'ncm-cli 退出码 1' } : {}),
  }
}

/** 一只活的假端口:读数跟着 lab 的开关走,改一格就推一次 `providerChanged`(五条读数全标脏)。 */
class LivePort implements MusicPort {
  private data: Record<string, ResourceReadView> = {}
  private listeners = new Set<(event: MusicResourceEvent) => void>()
  /** 这几条读数**挂着不回**(lab 里演「还在读」那一档)。 */
  private held = new Set<string>()
  onOp: (op: string, params: Record<string, unknown> | undefined) => void = () => undefined

  update(state: LabState): void {
    this.data = table(state)
    this.held = state.lyrics === 'loading' ? new Set(['music:player#lyrics']) : new Set()
    for (const listener of this.listeners) listener({ ref: 'music:provider', event: 'providerChanged', payload: {} })
  }

  ready = async (): Promise<void> => undefined

  read = async (ref: string, name: string): Promise<ResourceReadView> => {
    const key = `${ref}#${name}`
    // 挂着不回 = 这一格永远停在「从来没有过内容」,骨架的判据就是它。
    if (this.held.has(key)) return new Promise<ResourceReadView>(() => undefined)
    return this.data[key] ?? { kind: 'denied', reason: `no ${key}` }
  }

  /** 一条资源事实(lab 里只用来演安装输出)。 */
  push(event: MusicResourceEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  do = async (_ref: string, op: string, params?: Record<string, unknown>): Promise<ResourceOutcomeView> => {
    /*
     * 跟主持人说话(§7.2):lab 里要看的是**那一整条**——你的气泡冒出来、黑豆转
     * busy、过一会儿他回了一句于是黑豆回到该在的姿势。所以这一发也要花时间:
     * 真机上他要跑几条 bash 才开口,一次瞬间回话什么都演不出来。
     */
    if (op === 'tell') {
      this.onOp(op, params)
      setTimeout(() => {
        this.push({
          ref: 'music:radio',
          event: 'hostReplied',
          payload: { text: HOST_REPLY, say: HOST_REPLY },
        })
      }, 1_800)
      return { kind: 'ok', text: 'told' }
    }
    // 装工具那一下在 lab 里也要**花时间并且一行一行吐**:第 ① 步要看的正是
    // 「钮转着圈、输出块跟着往下走」,一次瞬间成功什么都演不出来。
    if (op === 'setup' && params?.action === 'install-tool') {
      const tool = String(params.tool ?? '')
      for (const line of INSTALL_LINES[tool] ?? ['working…']) {
        await new Promise((resolve) => setTimeout(resolve, 700))
        this.push({ ref: 'music:provider', event: 'setupOutput', payload: { tool, chunk: `${line}\n` } })
      }
    }
    this.onOp(op, params)
    return { kind: 'ok', text: 'done' }
  }

  onResourceEvent = (_prefix: string, callback: (event: MusicResourceEvent) => void): (() => void) => {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }
}

/** 他回的那一句。内容样本,原样写,不进字典(与 SONGS 同一条判据)。 */
const HOST_REPLY = '好,往下收一收,慢一点。下一首换成林间录音的《慢车》。'

/** 他开口时说的那一句(§8.4 要演的就是这块话浮起来、歌词让位)。内容样本。 */
const HOST_ON_AIR = '这首是旧电扇的《雨棚下》。前奏那点雨声是真的录进去的 —— 别急着跳。'

/**
 * **一只假宠物端口**(lab 专用)。音乐面的歌词页要知道「主持人开没开口」,而那件事实住在
 * `pet:` 那条线上(`data/pet-source`),不在音乐端口里。产品里它由主进程的宠物宿主发;
 * 这里由一格开关推 `utterance` / `hushed` 两条事实 —— 形与真的逐字相同,所以壳那一侧
 * 一个字都不必知道自己面对的是假端口。
 */
class LabPetPort implements ResourcePort {
  private listeners = new Set<(event: ResourceEventFact) => void>()
  private seq = 0
  private saidId: string | null = null

  ready = async (): Promise<void> => undefined

  read = async (_ref: string, name: string) => {
    if (name === 'current') {
      return {
        kind: 'ok' as const,
        value: { pet: { id: 'heidou', name: '黑豆', rig: 'heidou-svg' }, speaking: false, utterances: [] },
      }
    }
    if (name === 'roster') return { kind: 'ok' as const, value: { pets: [] } }
    return { kind: 'denied' as const, reason: `no pet:current#${name}` }
  }

  do = async () => ({ kind: 'ok' as const, text: 'done' })

  onResourceEvent = (_prefix: string, callback: (event: ResourceEventFact) => void): (() => void) => {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  /** 开口。 */
  speak(text: string): void {
    this.saidId = `lab-say-${++this.seq}`
    this.push('utterance', {
      id: this.saidId,
      petId: 'heidou',
      mode: 'speak',
      text,
      at: Date.now(),
      duck: false,
    })
  }

  /** 说完了。没开过口就什么都不发(一条对不上 id 的 `hushed` 在产品里也是被丢掉的)。 */
  hush(): void {
    if (!this.saidId) return
    this.push('hushed', { utteranceId: this.saidId })
    this.saidId = null
  }

  private push(event: string, payload: unknown): void {
    for (const listener of this.listeners) listener({ ref: 'pet:current', event, payload })
  }
}

/** 装工具时那条命令吐出来的字。内容样本,原样写,不进字典(与 SONGS 同一条判据)。 */
const INSTALL_LINES: Readonly<Record<string, readonly string[]>> = {
  'ncm-cli': [
    'npm warn deprecated inflight@1.0.6: This module is not supported',
    'added 87 packages in 6s',
    '',
    '17 packages are looking for funding',
    'ncm-cli 0.1.6',
  ],
  mpv: [
    '==> Fetching mpv',
    '==> Downloading https://ghcr.io/v2/homebrew/core/mpv/blobs/sha256:9c1f',
    '==> Pouring mpv--0.40.0.arm64_sonoma.bottle.tar.gz',
    '🍺  /opt/homebrew/Cellar/mpv/0.40.0: 89 files, 62.1MB',
  ],
}

/** 向导那一步做完了,样本往哪一格走。**表,不是 switch** —— 与后端那张一一对得上。 */
function applySetup(state: LabState, params: Record<string, unknown> | undefined): LabState {
  const action = String(params?.action ?? '')
  if (action === 'check-env') return state.setup === 'env-probing' ? { ...state, setup: 'env' } : state
  if (action === 'install-tool') {
    const tool = String(params?.tool ?? '')
    if (state.setup !== 'env' && state.setup !== 'env-half') return state
    // ncm-cli 装完还剩 mpv(half);两件齐了才走到第 ② 步 —— 从 `env` 先装 mpv
    // 的话 ncm-cli 仍然缺着,这一格原地不动(与后端 `resolveSetupStage` 同一条判据)。
    if (tool === 'ncm-cli') return { ...state, setup: state.setup === 'env' ? 'env-half' : state.setup }
    return { ...state, setup: state.setup === 'env-half' ? 'cred' : state.setup }
  }
  if (action === 'set-credentials') return { ...state, setup: 'login-idle' }
  if (action === 'login-start') return { ...state, setup: 'login-wait' }
  if (action === 'login-cancel') return { ...state, setup: 'login-idle' }
  // `login-check` 在 lab 里恒答「还没」—— 要看成功那一下,把档位拨到 ready。
  if (action === 'logout') return { ...state, setup: 'login-idle' }
  return state
}

/** 面板上的钮改样本:与后端端口的分档无关,只求 lab 里点得动。 */
function applyOp(state: LabState, op: string, params: Record<string, unknown> | undefined): LabState {
  if (op === 'setup') return applySetup(state, params)
  switch (op) {
    case 'pause':
      return { ...state, player: 'paused' }
    case 'resume':
      return { ...state, player: 'playing' }
    case 'next':
      return { ...state, song: (Math.max(0, state.song) + 1) % SONGS.length, position: 0, player: 'playing' }
    case 'prev':
      return { ...state, position: 0 }
    case 'seek':
      return typeof params?.position === 'number' ? { ...state, position: params.position } : state
    case 'close':
    case 'radioStop':
      return { ...state, radio: 'off' }
    case 'open':
    case 'retune':
    case 'radioResume':
      return { ...state, radio: 'on' }
    case 'programmeAction': {
      // 只演 move / remove / promote 三种里的顺序那一半:lab 要看的是拖完留不留得住。
      const action = params?.action as { kind?: string; encryptedId?: string; toIndex?: number } | undefined
      const count = state.programme === 'many' ? 64 : state.programme === 'empty' ? 0 : 5
      const ids = state.order ?? Array.from({ length: count }, (_, i) => `e${i}`)
      const from = action?.encryptedId ? ids.indexOf(action.encryptedId) : -1
      if (from < 0) return state
      const rest = ids.filter((id) => id !== action?.encryptedId)
      if (action?.kind === 'remove') return { ...state, order: rest }
      const to =
        action?.kind === 'promote'
          ? 0
          : Math.max(0, Math.min(rest.length, typeof action?.toIndex === 'number' ? action.toIndex : from))
      return { ...state, order: [...rest.slice(0, to), ids[from], ...rest.slice(to)] }
    }
    default:
      return state
  }
}

type Choice<K extends keyof LabState> = { key: K; label: string; options: readonly { value: string; label: string }[] }

const CHOICES: readonly Choice<keyof LabState>[] = [
  {
    key: 'song',
    label: 'song',
    options: [
      { value: '0', label: '雨棚下' },
      { value: '1', label: '慢车' },
      { value: '2', label: 'long' },
      { value: '-1', label: 'none' },
    ],
  },
  {
    key: 'player',
    label: 'player',
    options: [
      { value: 'playing', label: 'playing' },
      { value: 'paused', label: 'paused' },
      { value: 'stopped', label: 'stopped' },
    ],
  },
  {
    key: 'radio',
    label: 'radio',
    options: [
      { value: 'on', label: 'on air' },
      { value: 'off', label: 'off' },
    ],
  },
  {
    key: 'starting',
    label: 'starting',
    options: [
      { value: 'none', label: '—' },
      { value: 'say', label: 'starting + say' },
    ],
  },
  {
    key: 'lyrics',
    label: 'lyrics',
    options: [
      { value: 'ready', label: 'ready' },
      { value: 'loading', label: '读中(骨架)' },
    ],
  },
  {
    key: 'host',
    label: 'host',
    options: [
      { value: 'quiet', label: '—' },
      { value: 'speaking', label: '他在说' },
    ],
  },
  {
    key: 'programme',
    label: 'programme',
    options: [
      { value: 'five', label: '5' },
      { value: 'many', label: '64' },
      { value: 'empty', label: 'empty' },
    ],
  },
  {
    key: 'fault',
    label: 'fault',
    options: [
      { value: 'none', label: '—' },
      { value: 'player', label: 'player' },
      { value: 'backend', label: 'backend' },
    ],
  },
  {
    key: 'setup',
    label: 'setup',
    options: [
      { value: 'ready', label: 'ready' },
      { value: 'env-probing', label: '① 探测中' },
      { value: 'env', label: '① 都没装' },
      { value: 'env-half', label: '① 装一半' },
      { value: 'cred', label: '② 凭据' },
      { value: 'login-idle', label: '③ 登录' },
      { value: 'login-wait', label: '③ 二维码' },
      { value: 'login-failed', label: '③ 失败' },
      { value: 'login-quota', label: '③ 超额' },
    ],
  },
]

export function MusicLab() {
  const [width, setWidth] = useState<string>('620')
  const [state, setState] = useState<LabState>(INITIAL)
  /*
   * 两个开关 = 面板的**初始**态。它们换的时候整块面重挂(`key`)—— 抽屉开合的主人
   * 自始至终是那块面自己(正本 §3.1「卸载:抽屉与歌词页状态不落盘」),这里不越权
   * 去控它,只是换一台从那个态开始的。假端口与读数都在外面,重挂不丢样本。
   */
  const [drawer, setDrawer] = useState<'closed' | 'open'>('closed')
  const [view, setView] = useState<'turntable' | 'lyrics'>('turntable')
  const [port] = useState(() => new LivePort())
  const [petPort] = useState(() => new LabPetPort())
  const [ready, setReady] = useState(false)
  /** 上一次的歌词档 —— 换档要把这条线**回出厂再重挂**(理由在下面那段)。 */
  const lyricsLane = useRef(INITIAL.lyrics)
  const locale = useStageStore((st) => st.locale)

  useEffect(() => {
    port.onOp = (op, params) => setState((prev) => applyOp(prev, op, params))
    port.update(INITIAL)
    resetMusicSource()
    resetPetSource()
    configureMusicPort(port)
    configurePetPort(petPort)
    setReady(true)
    return () => {
      setReady(false)
      configureMusicPort(undefined)
      configurePetPort(undefined)
    }
  }, [petPort, port])

  useEffect(() => {
    port.update(state)
  }, [port, state])

  /*
   * 「读中(骨架)」那一格(§8.5)。骨架的判据是**从来没有过内容**
   * (`phase === 'initial'`),而读数一旦到过手,把下一发挂住也回不到那一档 ——
   * 那正是律②:重拉期间旧内容留在屏上。所以换这一档要把整条线回出厂、面板重挂一次。
   * 产品里没有这条路(歌词读数只会往前走),它是 lab 专有的「倒带」。
   */
  useEffect(() => {
    if (lyricsLane.current === state.lyrics) return
    lyricsLane.current = state.lyrics
    setReady(false)
    resetMusicSource()
  }, [state.lyrics])

  useEffect(() => {
    // 面板卸掉之后的下一拍再挂回来 —— 挂回来的那一下才是「首载」。
    if (!ready) setReady(true)
  }, [ready])

  /*
   * 「他在说」那一格(§8.4)。拨过去推一条 `utterance`、拨回来推一条 `hushed` ——
   * 与真机上主持人开口 / 说完那两条事实同形,所以歌词的压暗、跟唱暂停、亮回来
   * 三件在这里演的就是产品里那一条路。
   */
  useEffect(() => {
    if (state.host === 'speaking') petPort.speak(HOST_ON_AIR)
    else petPort.hush()
  }, [petPort, state.host])

  return (
    <div className={s.page} data-testid="music-lab">
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <Segmented label="width" options={[...WIDTHS]} value={width} onChange={setWidth} />
        {CHOICES.map((choice) => (
          <Segmented
            key={choice.key}
            label={choice.label}
            options={[...choice.options]}
            value={String(state[choice.key])}
            onChange={(value) =>
              setState((prev) => ({
                ...prev,
                [choice.key]: choice.key === 'song' ? Number(value) : value,
                ...(choice.key === 'song' ? { position: 0 } : {}),
              }))
            }
          />
        ))}
        <Segmented
          label="drawer"
          options={[
            { value: 'closed', label: '—' },
            { value: 'open', label: 'open' },
          ]}
          value={drawer}
          onChange={(next) => setDrawer(next as 'closed' | 'open')}
        />
        <Segmented
          label="view"
          options={[
            { value: 'turntable', label: 'turntable' },
            { value: 'lyrics', label: 'lyrics page' },
          ]}
          value={view}
          onChange={(next) => setView(next as 'turntable' | 'lyrics')}
        />
        <Segmented
          label="locale"
          options={[
            { value: 'zh', label: '中' },
            { value: 'en', label: 'EN' },
          ]}
          value={locale}
          onChange={(next) => useStageStore.setState({ locale: next })}
        />
      </div>
      <div
        data-testid="music-lab-frame"
        /* box-sizing 明写成 content-box:全局是 border-box,那条 1px 的框会把
         * 面板真正拿到的宽吃掉 2px —— 选 900 量到 898,正好落在阈值的另一边。 */
        style={{
          boxSizing: 'content-box',
          width: Number(width),
          height: 760,
          border: '1px solid var(--line-1)',
          borderRadius: 12,
          overflow: 'hidden',
        }}
      >
        {ready && (
          <MusicPanel
            key={`${drawer}-${view}`}
            initialPlaylistOpen={drawer === 'open'}
            initialView={view}
          />
        )}
      </div>
    </div>
  )
}
