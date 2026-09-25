import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MusicPanel } from '../MusicPanel'
import { FocusDispatchHarness } from '../../test/focus-harness'
import { configureMusicPort } from '../../data/music-port'
import type { MusicPort, MusicResourceEvent } from '../../data/music-port'
import { resetMusicSource } from '../../data/music-source'
import { angleForSide, deckGeometry, needleAt } from '../music/record-geometry'
import { useStageStore } from '../../stage/store'
import type { ResourceOutcomeView, ResourceReadView } from '@shared/ipc/resources'

/**
 * 音乐面的用例。判的是**这块面与资源路之间那条缝**,不是屏幕好不好看:
 *
 *  ① 首载真的问了五条读数,而且问的是自述里那五个地址 / 名字;
 *  ② 每颗钮点下去发出去的 `(ref, op, params)` **逐字**是那一条 ——
 *     这一条就是「面板不许绕开资源路去调 music RPC 域」的反证钉子;
 *  ③ 暂停**就地更新**(律①):`do` 还没回来,屏幕上那颗钮已经变成「播放」;
 *  ④ `resource:event` 的 `nowPlayingChanged` 到了要重拉;
 *  ⑤ 一次 `failed` 就地一行,零 Toast;
 *  ⑥ 关着 / 没歌:唱片与按钮那一行照样在,只换里面的字(v8「布局从不跟着状态变」);
 *  ⑦ HMR dispose 走的那一口(`resetMusicSource`)真的退订;
 *  ⑧ 唱臂:这一圈里松手 = 一条 seek,拖到后面那一圈 = 放那首;♥ 成功才让黑豆冒爱心。
 *
 * v8(唱针读歌词,2026-09-18)那一组判的是**形**:没有歌词钮、歌词一直在;宽的面板只是
 * `data-wide`;抽屉开关与焦点归还、Esc 先关抽屉再退出说话;关台与「放过的」住在抽屉里。
 * 节目单住在抽屉里,所以凡是要碰它的用例先 `openPlaylist()` —— 那正是今天人要走的路。
 */

/** 一次读的答案表:`<ref>#<name>` → 值。 */
type ReadTable = Record<string, unknown>

interface FakeMusic {
  port: MusicPort
  reads: Array<{ ref: string; name: string }>
  dos: Array<{ ref: string; op: string; params: Record<string, unknown> | undefined }>
  /** 此刻订着的那几只回调(退订会把自己摘掉)。 */
  listeners: Array<(event: MusicResourceEvent) => void>
  table: ReadTable
  /** 下一次 `do` 的答案。缺省 ok。 */
  outcome: ResourceOutcomeView
  /** 给了它,`do` 就挂着不回 —— 用来看乐观补丁那一帧。 */
  hold?: { release: () => void }
}

const NOW_PLAYING = {
  playing: true,
  status: 'playing' as const,
  title: '可惜没如果 - 林俊杰',
  position: 61,
  duration: 298,
  progress: '1:01 / 4:58',
  queueLength: 3,
  currentIndex: 0,
}

const BRIEF_ON = {
  active: true,
  intent: '下雨天,安静的中文民谣',
  programmeLength: 2,
  canResume: true,
  volume: 42,
}

const BRIEF_OFF = { active: false, intent: '', programmeLength: 0, canResume: false }

function makeFake(table: ReadTable): FakeMusic {
  const fake: FakeMusic = {
    reads: [],
    dos: [],
    listeners: [],
    table,
    outcome: { kind: 'ok', text: 'done' },
    port: undefined as unknown as MusicPort,
  }
  fake.port = {
    ready: async () => undefined,
    read: async (ref, name): Promise<ResourceReadView> => {
      fake.reads.push({ ref, name })
      const key = `${ref}#${name}`
      if (!(key in fake.table)) return { kind: 'denied', reason: `no ${key}` }
      return { kind: 'ok', value: fake.table[key] }
    },
    do: async (ref, op, params): Promise<ResourceOutcomeView> => {
      fake.dos.push({ ref, op, params })
      if (fake.hold) {
        await new Promise<void>((resolve) => {
          fake.hold = { release: resolve }
        })
      }
      return fake.outcome
    },
    onResourceEvent: (_prefix, callback) => {
      fake.listeners.push(callback)
      return () => {
        const at = fake.listeners.indexOf(callback)
        if (at >= 0) fake.listeners.splice(at, 1)
      }
    },
  }
  return fake
}

function fullTable(): ReadTable {
  return {
    'music:radio#brief': BRIEF_ON,
    'music:radio#programme': {
      entries: [
        { encryptedId: 'a', title: '第一首', note: '点歌' },
        { encryptedId: 'b', title: '第二首' },
      ],
      onDeck: '可惜没如果 - 林俊杰',
    },
    'music:player#nowPlaying': NOW_PLAYING,
    'music:player#lyrics': null,
    'music:provider#state': {
      setupStage: 'ready',
      configured: true,
      loggedIn: true,
      playerBackend: 'ncm',
      source: 'daily',
    },
  }
}

let fake: FakeMusic

/**
 * **jsdom 里没有布局,也没有 `ResizeObserver`** —— 而这块面的形完全由它自己的宽决定
 * (`music/panel-width.ts`)。两件夹具补上这两样:`clientWidth` 只给面板那一格答数
 * (别的元素照旧 0,唱机场景的视口算法本来就吃 0),`ResizeObserver` 记下回调,
 * `resizePanel()` 改宽之后亲手敲一下 —— 真机上那一下是浏览器敲的。
 */
let panelWidth = 620
const deckWidth = () => panelWidth - 24
const deckHeight = () => (panelWidth >= 900 ? 380 : 300)
const resizeCallbacks: Array<() => void> = []

class FakeResizeObserver {
  constructor(callback: () => void) {
    resizeCallbacks.push(callback)
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** 改面板的宽并敲一下观察器。`FrameCoalescer` 排的是下一帧,所以要等一小会儿。 */
async function resizePanel(width: number) {
  panelWidth = width
  await act(async () => {
    for (const callback of [...resizeCallbacks]) callback()
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
}

/**
 * 开抽屉:节目单从 v7 起住在这后面。
 *
 * **先 `focus()` 再 click**:真机上按一颗钮这两件一起发生,而 jsdom 的 `fireEvent.click`
 * 只派事件、不搬焦点 —— 不补这一下,焦点树记下的「上一任」就还是这块面的落点(播放钮),
 * 抽屉关掉时焦点归还的那条断言会对着错的人。夹具驱动焦点是允许的(执法三条不管测试文件)。
 */
async function openPlaylist() {
  const button = await screen.findByTestId('music-playlist-toggle')
  await act(async () => {
    button.focus()
    fireEvent.click(button)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount(table: ReadTable = fullTable()) {
  fake = makeFake(table)
  configureMusicPort(fake.port)
  const view = render(
    <>
      {/* 响应链上那唯一的派发器 —— Esc 现在是一句声明,没有它谁都不会响。 */}
      <FocusDispatchHarness />
      <MusicPanel />
    </>,
  )
  // 首载是异步的(等 ready → 订 → 五发并行),让它整个跑完再断言 ——
  // 一个宏任务把微任务队列排干,五发的落地与随之而来的重渲都在 act 里面。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return view
}

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  resetMusicSource()
  panelWidth = 620
  resizeCallbacks.length = 0
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.dataset.testid === 'music-panel') return panelWidth
      // 唱片面自己量自己(`RecordDeck` 的几何吃它):宽 = 面板减两侧内距,高由 token 定
      // (窄 300 / 宽 380)—— jsdom 不读 CSS,这里直接答。
      if (this.dataset.testid === 'music-deck') return deckWidth()
      return 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.testid === 'music-deck' ? deckHeight() : 0
    },
  })
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver
})

afterEach(() => {
  // **先卸载再归零**:`resetMusicSource()` 会 emit(五格读数回出厂),而 vitest 的
  // afterEach 是后注册先跑 —— 不显式 cleanup 的话这一声会打在还挂着的组件上,
  // React 当场报「不在 act 里的更新」。RTL 自己那格 cleanup 是幂等的。
  cleanup()
  resetMusicSource()
  configureMusicPort(undefined)
  // 把原型上那一格还回去(jsdom 自己的 clientWidth 长在 Element.prototype 上)。
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
})

describe('首载:五条读数,五个地址', () => {
  it('问的是自述里那五条,一条不多一条不少', async () => {
    await mount()
    await waitFor(() => expect(fake.reads.length).toBeGreaterThanOrEqual(5))
    expect(fake.reads.map((r) => `${r.ref}#${r.name}`).sort()).toEqual([
      'music:player#lyrics',
      'music:player#nowPlaying',
      'music:provider#state',
      'music:radio#brief',
      'music:radio#programme',
    ])
  })

  it('读回来的东西上了屏', async () => {
    await mount()
    // 展示串「歌名 - 歌手」只为显示拆两半,不当键用。
    await waitFor(() => expect(screen.getByTestId('music-now-title').textContent).toBe('可惜没如果'))
    // v7:节目单不铺在页面上,它在抽屉里(§1)。
    expect(screen.queryByTestId('music-programme')).toBeNull()
    await openPlaylist()
    expect(screen.getByText('第一首')).toBeTruthy()
    expect(screen.getByTestId('music-programme')).toBeTruthy()
  })
})

describe('每颗钮发出去的是那一条 do', () => {
  /** 钮的 testId → 期望的 `(ref, op, params)`。**这张表就是那条缝的契约**。 */
  const TABLE: Array<[string, string, string, Record<string, unknown>]> = [
    ['music-play', 'music:player', 'pause', {}],
    ['music-next', 'music:player', 'next', {}],
    ['music-like', 'music:player', 'like', {}],
  ]

  for (const [testId, ref, op, params] of TABLE) {
    it(`${testId} → do(${ref}, ${op})`, async () => {
      await mount()
      await screen.findByTestId(testId)
      await act(async () => {
        fireEvent.click(screen.getByTestId(testId))
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(fake.dos).toEqual([{ ref, op, params }])
    })
  }

  it('关台住在抽屉的檐上,只有一颗 → do(music:radio, radioStop)', async () => {
    await mount()
    await openPlaylist()
    await act(async () => {
      fireEvent.click(await screen.findByTestId('music-radio-close'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(fake.dos).toEqual([{ ref: 'music:radio', op: 'radioStop', params: {} }])
  })

  it('点歌带着歌名', async () => {
    await mount()
    await openPlaylist()
    const input = await screen.findByTestId('music-song')
    fireEvent.change(input, { target: { value: '晴天 周杰伦' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('music-request'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(fake.dos).toEqual([
      { ref: 'music:radio', op: 'request', params: { song: '晴天 周杰伦' } },
    ])
  })
})

describe('就地更新(律①)', () => {
  it('按了暂停,`do` 还没回来,那颗钮已经变成「播放」', async () => {
    await mount()
    await screen.findByTestId('music-play')
    expect(screen.getByTestId('music-play').getAttribute('aria-label')).toBe('暂停')

    fake.hold = { release: () => undefined }
    await act(async () => {
      fireEvent.click(screen.getByTestId('music-play'))
    })
    // 这一刻 `do` 还挂着(hold 没放),屏幕已经是「播放」了 —— 乐观补丁。
    expect(screen.getByTestId('music-play').getAttribute('aria-label')).toBe('播放')
    await act(async () => {
      fake.hold?.release()
      fake.hold = undefined
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  })
})

describe('事件到了要重拉', () => {
  it('nowPlayingChanged 一到,nowPlaying 那一格重问一次;标签上换成新歌名', async () => {
    await mount()
    await waitFor(() => expect(fake.reads.length).toBeGreaterThanOrEqual(5))
    const before = fake.reads.filter((r) => r.name === 'nowPlaying').length

    fake.table['music:player#nowPlaying'] = { ...NOW_PLAYING, title: '晴天 - 周杰伦' }
    await act(async () => {
      for (const listener of [...fake.listeners]) {
        listener({ ref: 'music:player', event: 'nowPlayingChanged', payload: {} })
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    await waitFor(() =>
      expect(fake.reads.filter((r) => r.name === 'nowPlaying').length).toBeGreaterThan(before),
    )
    await waitFor(() => expect(screen.getByTestId('music-now-title').textContent).toBe('晴天'))
  })
})

describe('歌词三态(09-18 报障:「歌曲开始播放了,然后显示没歌词,歌词过了一会出来了」)', () => {
  const lines = [{ at: 12, text: '第一句' }, { at: 40, text: '第二句' }]

  it('手上那份歌词是上一首的 → 「正在取歌词」,不说「没有」;lyricsChanged 一到 → 这一首的行上屏', async () => {
    const table = fullTable()
    table['music:player#lyrics'] = { title: '上一首 - 谁', lines: [] }
    await mount(table)
    expect(screen.getByTestId('music-lyrics-loading').textContent).toBe('正在加载歌词')
    expect(screen.queryByTestId('music-lyrics-empty')).toBeNull()

    fake.table['music:player#lyrics'] = { title: NOW_PLAYING.title, lines }
    await act(async () => {
      for (const listener of [...fake.listeners]) {
        listener({ ref: 'music:player', event: 'lyricsChanged', payload: { title: NOW_PLAYING.title, lineCount: 2 } })
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await screen.findByText('第二句')
    expect(screen.queryByTestId('music-lyrics-loading')).toBeNull()
  })

  it('这一首的、没有行 → 「这首没有歌词。」;这一首的、failed → 「歌词没取到。」', async () => {
    const empty = fullTable()
    empty['music:player#lyrics'] = { title: NOW_PLAYING.title, lines: [] }
    await mount(empty)
    expect(screen.getByTestId('music-lyrics-empty').textContent).toBe('暂无歌词')
    cleanup()
    resetMusicSource()

    const failed = fullTable()
    failed['music:player#lyrics'] = { title: NOW_PLAYING.title, lines: [], failed: true }
    await mount(failed)
    expect(screen.getByTestId('music-lyrics-failed').textContent).toBe('歌词加载失败')
  })
})

describe('没有下一首、DJ 在补歌单:交给黑豆(09-18 用户:「这个状态交给 pet 啊」)', () => {
  const refillingTable = (): ReadTable => ({
    ...fullTable(),
    'music:radio#programme': { entries: [], onDeck: NOW_PLAYING.title },
  })

  it('在放着最后一首、节目单空 → 黑豆在翻(busy),面板上没有一行字', async () => {
    await mount(refillingTable())
    await waitFor(() => expect(screen.getByTestId('pet-rig').dataset.pose).toBe('busy'))
    expect(screen.queryByTestId('music-backend-error')).toBeNull()
    // 首载落地不算「刚进这一态」:打开面板时他不插嘴。
    expect(screen.queryByTestId('pet-bubble-text')).toBeNull()
  })

  it('从有歌排着变成空了 → 他嘀咕一句(刚进这一态)', async () => {
    await mount()
    expect(screen.queryByTestId('pet-bubble-text')).toBeNull()
    fake.table['music:radio#programme'] = { entries: [], onDeck: NOW_PLAYING.title }
    await act(async () => {
      for (const listener of [...fake.listeners]) {
        listener({ ref: 'music:radio', event: 'radioOpened', payload: { intent: 'x' } })
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await waitFor(() => expect(screen.getByTestId('pet-bubble-text').textContent).not.toBe(''))
  })

  it('这时按 ⏭:照样发出去(记口味),回执 ok,不出错话;黑豆嘀咕一句', async () => {
    await mount(refillingTable())
    fake.outcome = { kind: 'ok', text: '下一首还没排好:DJ 正在补节目单,这首先放着' }
    await act(async () => {
      fireEvent.click(screen.getByTestId('music-next'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(fake.dos).toEqual([{ ref: 'music:player', op: 'next', params: {} }])
    expect(screen.queryByTestId('music-backend-error')).toBeNull()
    // 首载没嘀咕(上一例钉着),所以这一句只能是 ⏭ 那一下要来的。
    await waitFor(() => expect(screen.getByTestId('pet-bubble-text').textContent).not.toBe(''))
  })
})

describe('错误就地一行', () => {
  it('do 回 failed,唱片上方多一行原话,零 Toast', async () => {
    await mount()
    await screen.findByTestId('music-play')
    fake.outcome = { kind: 'failed', error: { name: 'MusicCommandFailedError', message: '播放器没起来' } }
    await act(async () => {
      fireEvent.click(screen.getByTestId('music-play'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const line = await screen.findByTestId('music-backend-error')
    expect(line.textContent).toBe('播放器没起来')
  })

  it('failed 之后乐观补丁回滚 —— 屏幕上不留一张后端没认下的牌', async () => {
    await mount()
    await screen.findByTestId('music-play')
    fake.outcome = { kind: 'denied', reason: '不行' }
    await act(async () => {
      fireEvent.click(screen.getByTestId('music-play'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.getByTestId('music-play').getAttribute('aria-label')).toBe('暂停')
  })
})

describe('关着 / 没歌:唱片与那一行照样在,只换里面的字', () => {
  const offTable = (): ReadTable => ({
    ...fullTable(),
    'music:radio#brief': BRIEF_OFF,
    'music:radio#programme': { entries: [] },
    'music:player#nowPlaying': {
      playing: false,
      status: 'stopped',
      position: 0,
      queueLength: 0,
      currentIndex: 0,
    },
  })

  it('从没放过(09-19):标签「黑豆电台 · 关着」、问话 + 四枚心情块;时间 0:00;除了音量与播放列表都按不了', async () => {
    await mount(offTable())
    expect(screen.getByTestId('music-label').textContent).toContain('黑豆电台')
    expect(screen.getByTestId('music-label').textContent).toContain('未开启')
    expect(screen.getByTestId('music-invite').textContent).toContain('想听什么？')
    expect(screen.getAllByRole('button').filter((b) => b.dataset.testid?.startsWith('music-mood-'))).toHaveLength(4)
    const clocks = screen.getByTestId('music-row').textContent ?? ''
    expect(clocks.match(/0:00/g)?.length).toBe(2)
    expect((screen.getByTestId('music-play') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('music-next') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('music-like') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('music-playlist-toggle')).not.toHaveProperty('disabled', true)
    expect(screen.getByTestId('music-volume').getAttribute('aria-disabled')).not.toBe('true')
  })

  it('上次放到一半(09-19「播放状态找上次播放的状态」):画那一首、停在那一秒;⏯ = 接着放(radioResume),⏭ ♥ 按不了', async () => {
    await mount({
      ...offTable(),
      'music:radio#brief': { ...BRIEF_OFF, canResume: true, lastPlayed: { title: '柔软 - 房东的猫', position: 102, durationS: 195 } },
    })
    expect(screen.getByTestId('music-now-title').textContent).toBe('柔软')
    const row = screen.getByTestId('music-row').textContent ?? ''
    expect(row).toContain('1:42')
    expect(row).toContain('3:15')
    const play = screen.getByTestId('music-play') as HTMLButtonElement
    expect(play.disabled).toBe(false)
    expect(play.getAttribute('aria-label')).toBe('继续播放')
    expect((screen.getByTestId('music-next') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('music-like') as HTMLButtonElement).disabled).toBe(true)
    // 没人在取歌词:不说「正在取歌词」。
    expect(screen.queryByTestId('music-lyrics-loading')).toBeNull()
    await act(async () => {
      fireEvent.click(play)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(fake.dos).toEqual([{ ref: 'music:radio', op: 'radioResume', params: {} }])
  })

  it('音量杆:松手 → do(music:player, volume, {level})', async () => {
    await mount()
    const slider = screen.getByTestId('music-volume')
    await act(async () => {
      fireEvent.keyDown(slider, { key: 'ArrowRight' })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(fake.dos.some((d) => d.op === 'volume')).toBe(true)
  })

  it('关着:按一枚心情块 = 以那一整句意图开台(块上只印两个字)', async () => {
    await mount(offTable())
    await act(async () => {
      fireEvent.click(screen.getByTestId('music-mood-rain'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(fake.dos).toEqual([{ ref: 'music:radio', op: 'open', params: { intent: '下雨天,安静点的' } }])
  })

  it('电台开着但播放器没在跑:⏯ 走 radio-resume', async () => {
    const table = fullTable()
    table['music:player#nowPlaying'] = {
      playing: false,
      status: 'stopped',
      position: 0,
      queueLength: 0,
      currentIndex: 0,
    }
    await mount(table)
    const play = await screen.findByTestId('music-play')
    expect(play.getAttribute('aria-label')).toBe('播放')
    await act(async () => {
      fireEvent.click(play)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(fake.dos).toEqual([{ ref: 'music:radio', op: 'radioResume', params: {} }])
  })

  it('电台关着但播放器自己在放:⏯ 只听播放器的(暂停,不是开台)', async () => {
    const table = fullTable()
    table['music:radio#brief'] = BRIEF_OFF
    await mount(table)
    expect(screen.getByTestId('music-play').getAttribute('aria-label')).toBe('暂停')
    // 「A 面 · …」只在电台开着时有意义。
    expect(screen.queryByTestId('music-side')).toBeNull()
  })

  it('四种状态下唱片面与那一行都是同一对节点(零重挂)', async () => {
    await mount()
    const deck = screen.getByTestId('music-deck')
    const row = screen.getByTestId('music-row')
    fake.table['music:player#nowPlaying'] = {
      playing: false,
      status: 'stopped',
      position: 0,
      queueLength: 0,
      currentIndex: 0,
    }
    fake.table['music:radio#brief'] = BRIEF_OFF
    await act(async () => {
      for (const listener of [...fake.listeners]) listener({ ref: 'music:radio', event: 'radioClosed', payload: {} })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await waitFor(() => expect(screen.getByTestId('music-play').getAttribute('aria-label')).toBe('开启电台'))
    expect(screen.getByTestId('music-deck')).toBe(deck)
    expect(screen.getByTestId('music-row')).toBe(row)
  })
})

describe('拆卸', () => {
  it('resetMusicSource(HMR dispose 走的那一口)真的退订', async () => {
    await mount()
    await waitFor(() => expect(fake.listeners.length).toBe(1))
    act(() => {
      resetMusicSource()
    })
    expect(fake.listeners.length).toBe(0)
  })
})

describe('按钮那一行:操作不许有两个意思', () => {
  it('电台开着时 ⏭ 说出后端真做的事', async () => {
    await mount()
    expect((await screen.findByTestId('music-next')).getAttribute('aria-label')).toBe('跳过')
  })

  it('♥ 一次性:成功后停用并改名「已收藏到网易云」', async () => {
    await mount()
    await act(async () => {
      fireEvent.click(await screen.findByTestId('music-like'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const like = screen.getByTestId('music-like')
    expect(like.getAttribute('aria-label')).toBe('已收藏')
    expect((like as HTMLButtonElement).disabled).toBe(true)
  })

  it('串联单「⋯」开的菜单:拿掉 → programmeAction remove,行当场消失', async () => {
    await mount()
    await openPlaylist()
    fireEvent.click(await screen.findByTestId('music-entry-more:a'))
    fake.hold = { release: () => undefined }
    await act(async () => {
      fireEvent.click(await screen.findByText('移除'))
    })
    expect(fake.dos).toEqual([
      { ref: 'music:radio', op: 'programmeAction', params: { action: { encryptedId: 'a', kind: 'remove' } } },
    ])
    // do 还挂着,行已经没了(乐观补丁)。
    expect(screen.getByTestId('music-programme').textContent).not.toContain('第一首')
    await act(async () => {
      fake.hold?.release()
      fake.hold = undefined
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  })

  it('右键一行开的是同一张菜单;第一行「提到下一首」停用', async () => {
    await mount()
    await openPlaylist()
    const row = (await screen.findByText('第一首')).closest('li')
    expect(row).toBeTruthy()
    fireEvent.contextMenu(row as HTMLElement)
    const promote = await screen.findByText('下一首播放')
    expect((promote.closest('button') as HTMLButtonElement).disabled).toBe(true)
  })
})

/**
 * **拖拽换序**(09-18:节目单接上 `ui/list-reorder`)。判的是这块面与那件基础件
 * 之间的那条缝 —— 编舞本身的守卫在 `ui/__tests__/list-reorder.test.tsx`,这里只问
 * 三句话:发出去的 `programmeAction` 逐字对不对、失败回不回滚、抽屉两档都拖得动。
 *
 * **几何要自己摆**:jsdom 里 `getBoundingClientRect` 恒为全 0,而落点判据全靠它。
 * 桩按「第 i 行在 y = i × 40」摆(与那件的用例同一手);事件仍是手搓 `MouseEvent`,
 * 类型名是 pointer*(jsdom 没有 `PointerEvent` 构造器)。
 */
describe('串联单:拖拽换序', () => {
  const ROW_H = 40
  const rect = (top: number, height: number): DOMRect =>
    ({
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 100,
      width: 100,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect

  const rowsOf = (list: Element) => Array.from(list.querySelectorAll<HTMLElement>('[data-list-reorder-item]'))

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-list-reorder')) return rect(0, ROW_H * rowsOf(this).length)
      if (this.hasAttribute('data-list-reorder-item')) {
        const list = this.closest('[data-list-reorder]')
        const at = list ? rowsOf(list).indexOf(this) : -1
        return rect(at < 0 ? 0 : at * ROW_H, ROW_H)
      }
      return rect(0, 0)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const pointer = (type: string, y: number) =>
    new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: y })

  /**
   * 把某一行从把手拖到下一行下面再松手。
   *
   * **`fake.hold` 在这里不是可选项**:`do` 一回来 `settle` 就把五条读数作废重拉,
   * 而假口的答案表是**不动的**(它不认识刚发出去那条命令),于是乐观补丁当场被
   * 一份原序盖回去 —— 那不是回滚,是夹具没有后端。所以「补丁真的上了屏」这句话
   * 只有在 `do` 还挂着的那一帧问得出来(与上面「拿掉」那条用例逐字同一手)。
   */
  async function dragDown(entryId: string) {
    const handle = await screen.findByTestId(`music-entry-drag:${entryId}`)
    await act(async () => {
      handle.dispatchEvent(pointer('pointerdown', 10))
      handle.dispatchEvent(pointer('pointermove', 60))
      handle.dispatchEvent(pointer('pointerup', 60))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  async function release() {
    await act(async () => {
      fake.hold?.release()
      fake.hold = undefined
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  const titles = () =>
    Array.from(screen.getByTestId('music-programme').querySelectorAll('li')).map((li) =>
      li.getAttribute('data-music-entry'),
    )

  it('拖完发的是 move,`toIndex` 是最终位置;行当场就换了(乐观补丁)', async () => {
    await mount()
    await openPlaylist()
    fake.hold = { release: () => undefined }
    await dragDown('a')
    expect(fake.dos).toEqual([
      { ref: 'music:radio', op: 'programmeAction', params: { action: { kind: 'move', encryptedId: 'a', toIndex: 1 } } },
    ])
    // do 还挂着,行已经换位了。
    expect(titles()).toEqual(['b', 'a'])
    await release()
  })

  it('后端不认就回滚 —— 屏幕上不留一张后端没认下的牌', async () => {
    await mount()
    await openPlaylist()
    fake.hold = { release: () => undefined }
    await dragDown('a')
    expect(titles()).toEqual(['b', 'a'])
    fake.outcome = { kind: 'failed', error: { name: 'MusicCommandFailedError', message: '挪不动' } }
    await release()
    expect(titles()).toEqual(['a', 'b'])
    expect((await screen.findByTestId('music-programme-error')).textContent).toBe('挪不动')
  })

  it('抽屉两档都拖得动(sheet 与 side 装的是同一件)', async () => {
    panelWidth = 360
    await mount()
    await openPlaylist()
    expect(screen.getByTestId('music-playlist').getAttribute('data-form')).toBe('sheet')
    await dragDown('a')
    expect(fake.dos).toHaveLength(1)

    await resizePanel(620)
    expect(screen.getByTestId('music-playlist').getAttribute('data-form')).toBe('side')
    fake.dos.length = 0
    await dragDown('a')
    expect(fake.dos).toEqual([
      { ref: 'music:radio', op: 'programmeAction', params: { action: { kind: 'move', encryptedId: 'a', toIndex: 1 } } },
    ])
  })

  it('键盘那条路同样落在这块面上:把手上按 ↓ 也发一条 move', async () => {
    await mount()
    await openPlaylist()
    await act(async () => {
      fireEvent.keyDown(await screen.findByTestId('music-entry-drag:a'), { key: 'ArrowDown' })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(fake.dos).toEqual([
      { ref: 'music:radio', op: 'programmeAction', params: { action: { kind: 'move', encryptedId: 'a', toIndex: 1 } } },
    ])
  })
})

describe('唱臂:这一圈里 = 跳到这一秒,后面那一圈 = 放那首', () => {
  // jsdom 里唱片面的矩形在 (0,0):client 坐标就是画面坐标。几何与组件吃的是同一只函数。
  const pointer = (type: string, x: number, y: number) =>
    new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: x, clientY: y })
  /** 这一面放到 `p` 时唱针所在的那一点。 */
  const at = (p: number) => {
    const g = deckGeometry(deckWidth(), deckHeight(), false)
    return needleAt(g, angleForSide(g, p))
  }
  // 这一面 = 正在放的这首(298s)+ 节目单里两首(不知道时长,各按 210s):共 718s。
  const TOTAL = 298 + 210 + 210

  it('在这一圈里松手 → 一条 seek 到那一秒;拖动期间一发都不发', async () => {
    await mount()
    const grab = await screen.findByTestId('music-arm')
    const target = at(0.2)
    await act(async () => {
      grab.dispatchEvent(pointer('pointerdown', target.x, target.y))
      window.dispatchEvent(pointer('pointermove', target.x, target.y))
    })
    expect(fake.dos).toEqual([])
    await act(async () => {
      window.dispatchEvent(pointer('pointerup', target.x, target.y))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(fake.dos).toEqual([{ ref: 'music:player', op: 'seek', params: { position: Math.round(0.2 * TOTAL) } }])
  })

  it('拖到最后那一圈松手 → 放那首:先提到第一位,再换歌', async () => {
    await mount()
    const grab = await screen.findByTestId('music-arm')
    const target = at(0.95)
    await act(async () => {
      grab.dispatchEvent(pointer('pointerdown', target.x, target.y))
      window.dispatchEvent(pointer('pointermove', target.x, target.y))
      window.dispatchEvent(pointer('pointerup', target.x, target.y))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await waitFor(() =>
      expect(fake.dos).toEqual([
        { ref: 'music:radio', op: 'programmeAction', params: { action: { kind: 'promote', encryptedId: 'b' } } },
        { ref: 'music:player', op: 'next', params: {} },
      ]),
    )
  })

  it('指针被系统收走 = 这一下不算,什么都不发', async () => {
    await mount()
    const grab = await screen.findByTestId('music-arm')
    const target = at(0.3)
    await act(async () => {
      grab.dispatchEvent(pointer('pointerdown', target.x, target.y))
      window.dispatchEvent(pointer('pointermove', target.x, target.y))
      window.dispatchEvent(pointer('pointercancel', target.x, target.y))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(fake.dos).toEqual([])
  })

  it('点歌词里的一句 → seek 到那一句', async () => {
    const table = fullTable()
    table['music:player#lyrics'] = { title: NOW_PLAYING.title, lines: [{ at: 12, text: '第一句' }, { at: 40, text: '第二句' }] }
    await mount(table)
    await act(async () => {
      fireEvent.click(await screen.findByText('第二句'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(fake.dos).toEqual([{ ref: 'music:player', op: 'seek', params: { position: 40 } }])
  })

  it('♥ 成功 → 黑豆冒爱心', async () => {
    await mount()
    await act(async () => {
      fireEvent.click(await screen.findByTestId('music-like'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await waitFor(() => expect(screen.getByTestId('pet-rig').dataset.oneShot).toBe('love'))
  })

  it('♥ 被拒 → 黑豆不冒爱心', async () => {
    await mount()
    fake.outcome = { kind: 'denied', reason: '没登录' }
    await act(async () => {
      fireEvent.click(await screen.findByTestId('music-like'))
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(screen.getByTestId('pet-rig').dataset.oneShot).toBeUndefined()
  })
})

describe('v8 整面:一块唱片 + 一行按钮', () => {
  const esc = () => fireEvent.keyDown(window, { key: 'Escape' })

  it('没有歌词钮;歌词一直在唱片旁边;宽面板只是 data-wide', async () => {
    await mount()
    expect(screen.queryByTestId('music-lyrics-toggle')).toBeNull()
    expect(screen.getByTestId('music-lyrics')).toBeTruthy()
    expect(screen.getByTestId('music-deck').dataset.wide).toBeUndefined()
    await resizePanel(1040)
    await waitFor(() => expect(screen.getByTestId('music-deck').dataset.wide).toBe('true'))
    expect(screen.getByTestId('music-lyrics')).toBeTruthy()
  })

  it('标签上印着歌名与歌手,还有这是第几面第几首', async () => {
    const table = fullTable()
    table['music:radio#brief'] = {
      ...BRIEF_ON,
      recent: [
        { title: NOW_PLAYING.title, at: '2026-09-18T12:10:00Z' },
        { title: '慢车 - 林间录音', at: '2026-09-18T12:05:00Z' },
      ],
    }
    await mount(table)
    expect(screen.getByTestId('music-now-title').textContent).toBe('可惜没如果')
    expect(screen.getByTestId('music-label').textContent).toContain('林俊杰')
    expect(screen.getByTestId('music-side').textContent).toBe('A 面 · 2 / 4')
  })

  it('抽屉:那颗钮开 / 关,关掉时焦点结构性地回到它身上', async () => {
    await mount()
    const button = await screen.findByTestId('music-playlist-toggle')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('music-playlist')).toBeNull()

    await openPlaylist()
    expect(screen.getByTestId('music-playlist')).toBeTruthy()
    expect(screen.getByTestId('music-playlist-toggle').getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(screen.getByTestId('music-playlist-close'))

    await act(async () => {
      fireEvent.click(screen.getByTestId('music-playlist-close'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.queryByTestId('music-playlist')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('music-playlist-toggle'))
  })

  it('抽屉:点遮罩也关', async () => {
    await mount()
    await openPlaylist()
    await act(async () => {
      fireEvent.mouseDown(screen.getByTestId('music-playlist-scrim'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.queryByTestId('music-playlist')).toBeNull()
  })

  it('抽屉两档:< 560 从底下升起,≥ 560 从右边滑出', async () => {
    panelWidth = 360
    await mount()
    await openPlaylist()
    expect(screen.getByTestId('music-playlist').getAttribute('data-form')).toBe('sheet')
    await resizePanel(620)
    expect(screen.getByTestId('music-playlist').getAttribute('data-form')).toBe('side')
    expect(screen.getByTestId('music-playlist-toggle').getAttribute('aria-expanded')).toBe('true')
  })

  it('Esc:点黑豆开出的那一格,焦点落在输入框、Esc 收起;抽屉开着先关抽屉;都没有不拦', async () => {
    await mount()
    await act(async () => {
      fireEvent.click(await screen.findByTestId('pet-button'))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    // 开出来那一刻,焦点由浮层的落点交给输入框(响应链,不是一句手写 focus)。
    expect(document.activeElement).toBe(screen.getByTestId('pet-menu-input'))
    await act(async () => {
      esc()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(screen.queryByTestId('pet-menu')).toBeNull()

    await openPlaylist()
    await act(async () => {
      esc()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.queryByTestId('music-playlist')).toBeNull()

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => {
      window.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(false)
  })

  it('抽屉里:这一面在哪首之后结束画一条「翻面以后」;「放过的」默认收起,展开有喜欢 / 跳过', async () => {
    const table = fullTable()
    table['music:radio#brief'] = {
      ...BRIEF_ON,
      recent: [
        { title: NOW_PLAYING.title, at: '2026-09-18T12:20:00Z' },
        { title: '三 - 丙', at: '2026-09-18T12:15:00Z', durationS: 200, verdict: 'skip' },
        { title: '二 - 乙', at: '2026-09-18T12:10:00Z', durationS: 190, verdict: 'love' },
        { title: '一 - 甲', at: '2026-09-18T12:05:00Z' },
      ],
    }
    await mount(table)
    await openPlaylist()
    // 本场第 4 首 → 这一面还能再排 1 首:线画在节目单第 2 首之前。
    const line = await screen.findByTestId('music-flip-line')
    expect(line.nextElementSibling?.getAttribute('data-music-entry')).toBe('b')
    expect(screen.queryByTestId('music-history')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByTestId('music-history-toggle'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const history = screen.getByTestId('music-history')
    expect(history.querySelectorAll('li')).toHaveLength(3)
    expect(history.textContent).toContain('已跳过')
    expect(history.textContent).toContain('♥ 已收藏')
    // 正在放的那一首已经在顶上那一段了,这里不重复。
    expect(history.textContent).not.toContain('可惜没如果')
  })

  it('没歌:「播放列表」钮还在(歌单要够得着)', async () => {
    const table = fullTable()
    table['music:player#nowPlaying'] = {
      playing: false,
      status: 'stopped',
      position: 0,
      queueLength: 0,
      currentIndex: 0,
    }
    await mount(table)
    const toggle = await screen.findByTestId('music-playlist-toggle')
    await act(async () => {
      fireEvent.click(toggle)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.getByTestId('music-playlist')).toBeTruthy()
  })
})

/**
 * ⏯ 意图先行(09-25,正本 §11):「保证前后端一致,保证用户的使用体验、点击及时响应」。
 * 第一条就是当天用夹具复现出来的那一跳:暂停还在路上,一份旧读数把屏幕打回「在放」。
 */
describe('⏯:屏幕按人的意图走,后端追上来', () => {
  const label = () => screen.getByTestId('music-play').getAttribute('aria-label')
  const PAUSED_NOW = { ...NOW_PLAYING, playing: false, status: 'paused' as const }

  async function clickPlay() {
    await act(async () => {
      fireEvent.click(screen.getByTestId('music-play'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  async function pushNowPlayingChanged() {
    await act(async () => {
      for (const listener of [...fake.listeners]) listener({ ref: 'music:player', event: 'nowPlayingChanged', payload: {} } as never)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  async function release() {
    await act(async () => {
      const held = fake.hold
      fake.hold = undefined
      held?.release()
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  it('暂停在路上时,一份「还在放」的旧读数到了:屏幕不跳回去,钮也不被按住', async () => {
    await mount()
    fake.hold = { release: () => undefined }
    await clickPlay()
    expect(label()).toBe('播放')
    expect((screen.getByTestId('music-play') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByTestId('music-status-pill').dataset.kind).toBe('paused')

    await pushNowPlayingChanged() // 后端 5s 一拍的轮询,带着暂停之前的读数
    expect(label()).toBe('播放')
    expect(screen.getByTestId('music-status-pill').dataset.kind).toBe('paused')

    fake.table['music:player#nowPlaying'] = PAUSED_NOW
    await release()
    expect(label()).toBe('播放')
    expect(fake.dos.filter((d) => d.op === 'pause' || d.op === 'resume').map((d) => d.op)).toEqual(['pause'])
  })

  it('连点三下(暂停 / 播放 / 暂停):同一时刻只有一发在路上,最后停在最后那一下', async () => {
    await mount()
    fake.hold = { release: () => undefined }
    await clickPlay() // 暂停(发出,挂住)
    await clickPlay() // 播放
    await clickPlay() // 暂停
    expect(label()).toBe('播放')
    expect(fake.dos.filter((d) => d.op === 'pause' || d.op === 'resume')).toHaveLength(1)

    fake.table['music:player#nowPlaying'] = PAUSED_NOW
    await release()
    // 播放器已经是「停着」,最后那一下要的也是「停着」—— 不再多发一发。
    expect(fake.dos.filter((d) => d.op === 'pause' || d.op === 'resume').map((d) => d.op)).toEqual(['pause'])
    expect(label()).toBe('播放')
  })

  it('连点两下(暂停 / 播放):第一发回来之后补发一发播放,屏幕全程是最后那一下', async () => {
    await mount()
    fake.hold = { release: () => undefined }
    await clickPlay()
    await clickPlay()
    expect(label()).toBe('暂停')
    // 播放器照做:先停,再放 —— 最后那份读数是「在放」。
    fake.table['music:player#nowPlaying'] = NOW_PLAYING
    await release()
    expect(fake.dos.filter((d) => d.op === 'pause' || d.op === 'resume').map((d) => d.op)).toEqual(['pause', 'resume'])
    expect(label()).toBe('暂停')
    await pushNowPlayingChanged()
    expect(label()).toBe('暂停')
    expect(screen.queryByTestId('music-backend-error')).toBeNull()
  })

  it('后端不认:屏幕回到播放器上一次的样子,错话就地一行', async () => {
    await mount()
    fake.outcome = { kind: 'failed', error: { message: '当前无播放进程' } } as ResourceOutcomeView
    await clickPlay()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(label()).toBe('暂停')
    expect(screen.getByTestId('music-backend-error').textContent).toBe('当前无播放进程')
  })

  it('后端说照做了、确认之后的读数却还在放:照读数画,并说一句「播放器没有照做」', async () => {
    await mount()
    await clickPlay() // 立刻回 ok,但播放器(读数)还在放
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(label()).toBe('暂停')
    expect(screen.getByTestId('music-backend-error').textContent).toBe('操作未生效，已恢复为当前播放状态。')
    // 下一次按 ⏯,那句话撤掉。
    fake.table['music:player#nowPlaying'] = PAUSED_NOW
    await clickPlay()
    expect(screen.queryByTestId('music-backend-error')).toBeNull()
  })
})
