import { useEffect, useState } from 'react'
import { MusicPanel } from '../content/MusicPanel'
import { configureMusicPort } from '../data/music-port'
import { resetMusicSource } from '../data/music-source'
import type { MusicPort, MusicResourceEvent } from '../data/music-port'
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
const WIDTHS = [
  { value: '300', label: '300' },
  { value: '360', label: '360' },
  { value: '480', label: '480' },
  { value: '620', label: '620' },
  { value: '820', label: '820' },
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
  setup: 'ready' | 'login'
  programme: 'five' | 'many' | 'empty'
  position: number
}

const INITIAL: LabState = {
  song: 0,
  player: 'playing',
  radio: 'on',
  starting: 'none',
  fault: 'none',
  setup: 'ready',
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
    'music:radio#programme': ok({ entries: on ? entries : [], onDeck: title }),
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
    'music:provider#state': ok({
      setupStage: state.setup,
      configured: true,
      loggedIn: state.setup === 'ready',
      playerBackend: 'mpv',
      source: 'daily',
      ...(state.fault === 'backend' ? { lastError: 'ncm-cli 退出码 1' } : {}),
    }),
  }
}

/** 一只活的假端口:读数跟着 lab 的开关走,改一格就推一次 `providerChanged`(五条读数全标脏)。 */
class LivePort implements MusicPort {
  private data: Record<string, ResourceReadView> = {}
  private listeners = new Set<(event: MusicResourceEvent) => void>()
  onOp: (op: string, params: Record<string, unknown> | undefined) => void = () => undefined

  update(state: LabState): void {
    this.data = table(state)
    for (const listener of this.listeners) listener({ ref: 'music:provider', event: 'providerChanged', payload: {} })
  }

  ready = async (): Promise<void> => undefined

  read = async (ref: string, name: string): Promise<ResourceReadView> =>
    this.data[`${ref}#${name}`] ?? { kind: 'denied', reason: `no ${ref}#${name}` }

  do = async (_ref: string, op: string, params?: Record<string, unknown>): Promise<ResourceOutcomeView> => {
    this.onOp(op, params)
    return { kind: 'ok', text: 'done' }
  }

  onResourceEvent = (_prefix: string, callback: (event: MusicResourceEvent) => void): (() => void) => {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }
}

/** 面板上的钮改样本:与后端端口的分档无关,只求 lab 里点得动。 */
function applyOp(state: LabState, op: string, params: Record<string, unknown> | undefined): LabState {
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
      { value: 'login', label: 'login' },
    ],
  },
]

export function MusicLab() {
  const [width, setWidth] = useState<string>('620')
  const [state, setState] = useState<LabState>(INITIAL)
  const [port] = useState(() => new LivePort())
  const [ready, setReady] = useState(false)
  const locale = useStageStore((st) => st.locale)

  useEffect(() => {
    port.onOp = (op, params) => setState((prev) => applyOp(prev, op, params))
    port.update(INITIAL)
    resetMusicSource()
    configureMusicPort(port)
    setReady(true)
    return () => {
      setReady(false)
      configureMusicPort(undefined)
    }
  }, [port])

  useEffect(() => {
    port.update(state)
  }, [port, state])

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
        style={{ width: Number(width), height: 760, border: '1px solid var(--line-1)', borderRadius: 12, overflow: 'hidden' }}
      >
        {ready && <MusicPanel />}
      </div>
    </div>
  )
}
