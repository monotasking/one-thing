import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MusicPanel } from '../MusicPanel'
import { FocusDispatchHarness } from '../../test/focus-harness'
import { configureMusicPort } from '../../data/music-port'
import type { MusicPort, MusicResourceEvent } from '../../data/music-port'
import { resetMusicSource } from '../../data/music-source'
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
 *  ⑥ 空态两句(播放器没在跑 / 电台没开);
 *  ⑦ HMR dispose 走的那一口(`resetMusicSource`)真的退订;
 *  ⑧ 唱臂(唱机场景上)只发一条 seek;♥ 成功才让黑豆冒爱心。
 *
 * v7(整面布局)又加了一组,判的是**形与那两格开合**(正本 §5):抽屉开关与焦点归还、
 * Esc 两级、≥900 两栏时没有歌词钮、跨 900 的两条规矩、歌词页进出。
 * 节目单从 v7 起住在抽屉里,所以凡是要碰它的用例先 `openPlaylist()` ——
 * 这不是夹具绕路,那正是今天人要走的路。
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
      return this.dataset.testid === 'music-panel' ? panelWidth : 0
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
    ['music-prev', 'music:player', 'prev', {}],
    ['music-play', 'music:player', 'pause', {}],
    ['music-next', 'music:player', 'next', {}],
    ['music-like', 'music:player', 'like', {}],
    // 「关台」只有一颗:`close` 与 `radioStop` 在后端是同一件事的两个回执。
    ['music-radio-stop', 'music:radio', 'radioStop', {}],
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

  it('换台要先开浮层、填意图、按「换台」才发 —— 开浮层本身什么都不发', async () => {
    await mount()
    fireEvent.click(await screen.findByTestId('music-retune-open'))
    expect(fake.dos).toEqual([])
    const input = await screen.findByTestId('music-intent')
    fireEvent.change(input, { target: { value: '深夜爵士' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('music-retune'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(fake.dos).toEqual([
      { ref: 'music:radio', op: 'retune', params: { intent: '深夜爵士' } },
    ])
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
  it('nowPlayingChanged 一到,nowPlaying 那一格重问一次', async () => {
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

describe('错误就地一行', () => {
  it('do 回 failed,面上多一行原话,零 Toast', async () => {
    await mount()
    await screen.findByTestId('music-play')
    fake.outcome = { kind: 'failed', error: { name: 'MusicCommandFailedError', message: '播放器没起来' } }
    await act(async () => {
      fireEvent.click(screen.getByTestId('music-play'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const line = await screen.findByTestId('music-player-error')
    expect(line.textContent).toBe('播放器没起来')
  })

  it('failed 之后乐观补丁回滚 —— 屏幕上不留一张后端没认下的牌', async () => {
    await mount()
    await screen.findByTestId('music-play')
    // 「被拒绝」不是错误,但对屏幕来说与失败是同一件事:这一下没算数,退回去。
    fake.outcome = { kind: 'denied', reason: '不行' }
    await act(async () => {
      fireEvent.click(screen.getByTestId('music-play'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.getByTestId('music-play').getAttribute('aria-label')).toBe('暂停')
  })
})

describe('空态两句', () => {
  it('播放器没在跑说一句;电台没开只给心情色块与开台,不写旁白', async () => {
    await mount({
      'music:radio#brief': BRIEF_OFF,
      'music:radio#programme': { entries: [] },
      'music:player#nowPlaying': {
        playing: false,
        status: 'stopped',
        position: 0,
        queueLength: 0,
        currentIndex: 0,
      },
      'music:player#lyrics': null,
      'music:provider#state': {
        setupStage: 'ready',
        configured: true,
        loggedIn: true,
        playerBackend: 'ncm',
        source: 'daily',
      },
    })
    expect(await screen.findByText('播放器没在跑。')).toBeTruthy()
    // 「电台关着」那句旁白已删(用户 09-17 的那条:界面不是用来跟用户解释设计的)——
    // 关着这件事由开台卡自己说:意图输入 + 开台 + 四枚心情色块。
    expect(screen.queryByText(/电台关着/)).toBeNull()
    expect(screen.getByTestId('music-open')).toBeTruthy()
    expect(screen.getAllByTestId(/^music-mood:/).length).toBe(4)
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

describe('唱机面:操作不许有两个意思', () => {
  it('电台开着时 ⏮ ⏭ 说出后端真做的事', async () => {
    await mount()
    expect((await screen.findByTestId('music-prev')).getAttribute('aria-label')).toBe('重播这首')
    expect(screen.getByTestId('music-next').getAttribute('aria-label')).toBe('跳过(以后少排这类)')
  })

  it('电台关着:开台卡 + 继续这一台 → do(music:radio, radioResume)', async () => {
    const table = fullTable()
    table['music:radio#brief'] = { ...BRIEF_OFF, intent: '下雨天', canResume: true, programmeLength: 3 }
    await mount(table)
    expect(screen.queryByTestId('music-radio-stop')).toBeNull()
    await act(async () => {
      fireEvent.click(await screen.findByTestId('music-radio-resume'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(fake.dos).toEqual([{ ref: 'music:radio', op: 'radioResume', params: {} }])
  })

  it('♥ 一次性:成功后停用并改名「已收藏到网易云」', async () => {
    await mount()
    await act(async () => {
      fireEvent.click(await screen.findByTestId('music-like'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const like = screen.getByTestId('music-like')
    expect(like.getAttribute('aria-label')).toBe('已收藏到网易云')
    expect((like as HTMLButtonElement).disabled).toBe(true)
  })

  it('串联单「⋯」开的菜单:拿掉 → programmeAction remove,行当场消失', async () => {
    await mount()
    await openPlaylist()
    fireEvent.click(await screen.findByTestId('music-entry-more:a'))
    fake.hold = { release: () => undefined }
    await act(async () => {
      fireEvent.click(await screen.findByText('拿掉(以后少排这类)'))
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
    const promote = await screen.findByText('提到下一首')
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

describe('唱臂:只表示「跳到这里」(宠物 P1 起在唱机场景上)', () => {
  // jsdom 里场景容器宽是 0,视口 = 原大,client 坐标就是 640×420 画布坐标。
  // jsdom 没有 PointerEvent:手搓一个带 button 与坐标的 MouseEvent,类型名仍是 pointer*
  // (与 ui/__tests__/Splitter.test.tsx 同一条判词)。
  const pointer = (type: string, x: number, y: number) =>
    new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: x, clientY: y })

  it('拖到唱片最内圈之内松手 → 一条 seek 到结尾;拖动期间一发都不发', async () => {
    await mount()
    const grab = await screen.findByTestId('music-arm')
    await act(async () => {
      grab.dispatchEvent(pointer('pointerdown', 400, 330))
      // 唱片左边很远:夹到结尾那一圈
      window.dispatchEvent(pointer('pointermove', 0, 175))
    })
    expect(fake.dos).toEqual([])
    await act(async () => {
      window.dispatchEvent(pointer('pointerup', 0, 175))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(fake.dos).toEqual([{ ref: 'music:player', op: 'seek', params: { position: 298 } }])
  })

  it('指针被系统收走 = 这一下不算,什么都不发', async () => {
    await mount()
    const grab = await screen.findByTestId('music-arm')
    await act(async () => {
      grab.dispatchEvent(pointer('pointerdown', 400, 330))
      window.dispatchEvent(pointer('pointermove', 0, 175))
      window.dispatchEvent(pointer('pointercancel', 0, 175))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(fake.dos).toEqual([])
  })

  it('♥ 成功 → 黑豆冒爱心', async () => {
    await mount()
    await act(async () => {
      fireEvent.click(await screen.findByTestId('music-like'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    // 一次性动画要等一帧(先撤后给)
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

describe('v7 整面布局:抽屉 · 两栏 · 歌词页(正本 §5)', () => {
  const esc = () => fireEvent.keyDown(window, { key: 'Escape' })

  it('抽屉:那颗钮开 / 关,关掉时焦点结构性地回到它身上', async () => {
    await mount()
    const button = await screen.findByTestId('music-playlist-toggle')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('music-playlist')).toBeNull()

    await openPlaylist()
    expect(screen.getByTestId('music-playlist')).toBeTruthy()
    expect(screen.getByTestId('music-playlist-toggle').getAttribute('aria-expanded')).toBe('true')
    // 开出来焦点落在抽屉里第一个可聚焦元素(✕)。
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
    // 换档不关抽屉。
    expect(screen.getByTestId('music-playlist-toggle').getAttribute('aria-expanded')).toBe('true')
  })

  it('Esc 两级:有抽屉先关抽屉,再一下才从歌词页回唱机;都没有不拦', async () => {
    await mount()
    await act(async () => {
      fireEvent.click(await screen.findByTestId('music-lyrics-toggle'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await openPlaylist()
    expect(screen.getByTestId('music-playlist')).toBeTruthy()

    // 第一下:抽屉。歌词页还在。
    await act(async () => {
      esc()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.queryByTestId('music-playlist')).toBeNull()
    expect(screen.getByTestId('music-lyrics-back')).toBeTruthy()

    // 第二下:歌词页。
    await act(async () => {
      esc()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.queryByTestId('music-lyrics-back')).toBeNull()

    // 第三下:都没有 —— 不拦(没人 preventDefault)。
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => {
      window.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(false)
  })

  it('歌词页:进去唱机场景整块换成歌词,页头小碟点回唱机', async () => {
    await mount()
    expect(screen.getByTestId('music-turntable')).toBeTruthy()

    await act(async () => {
      fireEvent.click(await screen.findByTestId('music-lyrics-toggle'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.queryByTestId('music-turntable')).toBeNull()
    expect(screen.getByTestId('music-lyrics').getAttribute('data-mode')).toBe('page')
    expect(screen.getByTestId('music-lyrics-toggle').getAttribute('aria-pressed')).toBe('true')

    await act(async () => {
      fireEvent.click(screen.getByTestId('music-lyrics-back'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.getByTestId('music-turntable')).toBeTruthy()
    // 一栏下歌词**整件不在场** —— 它不是收起来了,是这块面上没有它(§1)。
    expect(screen.queryByTestId('music-lyrics')).toBeNull()
  })

  it('≥ 900 两栏:歌词常驻右栏,歌条上没有「歌词」钮', async () => {
    panelWidth = 1040
    await mount()
    await waitFor(() => expect(screen.getByTestId('music-lyrics')).toBeTruthy())
    expect(screen.getByTestId('music-lyrics').getAttribute('data-mode')).toBe('column')
    expect(screen.queryByTestId('music-lyrics-toggle')).toBeNull()
  })

  it('跨 900 两条规矩:两栏 → 一栏不自动进歌词页;一栏(停在歌词页)→ 两栏退回唱机', async () => {
    panelWidth = 1040
    await mount()
    await waitFor(() => expect(screen.queryByTestId('music-lyrics-toggle')).toBeNull())

    // 规矩一:变一栏,回到唱机(不是歌词页),歌词钮长出来。
    await resizePanel(620)
    expect(screen.getByTestId('music-turntable')).toBeTruthy()
    expect(screen.getByTestId('music-lyrics-toggle').getAttribute('aria-pressed')).toBe('false')

    // 规矩二:停在歌词页时变两栏 → 退回唱机,歌词改在右栏。
    await act(async () => {
      fireEvent.click(screen.getByTestId('music-lyrics-toggle'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.queryByTestId('music-turntable')).toBeNull()

    await resizePanel(1040)
    expect(screen.getByTestId('music-turntable')).toBeTruthy()
    expect(screen.getByTestId('music-lyrics').getAttribute('data-mode')).toBe('column')

    // 再变回一栏:仍然是唱机 —— 「变一栏不自动进歌词页」对这条路也成立。
    await resizePanel(620)
    expect(screen.getByTestId('music-turntable')).toBeTruthy()
    expect(screen.getByTestId('music-lyrics-toggle').getAttribute('aria-pressed')).toBe('false')
  })

  it('没歌:歌词页退回唱机,抽屉留着', async () => {
    await mount()
    await act(async () => {
      fireEvent.click(await screen.findByTestId('music-lyrics-toggle'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await openPlaylist()

    fake.table['music:player#nowPlaying'] = {
      playing: false,
      status: 'stopped',
      position: 0,
      queueLength: 0,
      currentIndex: 0,
    }
    await act(async () => {
      for (const listener of [...fake.listeners]) {
        listener({ ref: 'music:player', event: 'nowPlayingChanged', payload: {} })
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    await waitFor(() => expect(screen.getByTestId('music-turntable')).toBeTruthy())
    expect(screen.getByTestId('music-playlist')).toBeTruthy()
  })

  it('电台开着但播放器没在跑:有一颗播放钮,按下去走 radio-resume', async () => {
    // 用户 09-18:「我现在没办法控制播放,好像没有播放按钮」。没歌有两种,
    // 电台开着那一种必须留一条让它响的路。
    const table = fullTable()
    table['music:player#nowPlaying'] = {
      playing: false,
      status: 'stopped',
      position: 0,
      queueLength: 0,
      currentIndex: 0,
    }
    await mount(table)

    const play = await screen.findByTestId('music-idle-play')
    await act(async () => {
      fireEvent.click(play)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(fake.dos.filter((call) => call.op === 'radioResume')).toHaveLength(1)
  })

  it('没歌:歌条不画,但「播放列表」钮还在(歌单要够得着)', async () => {
    const table = fullTable()
    table['music:player#nowPlaying'] = {
      playing: false,
      status: 'stopped',
      position: 0,
      queueLength: 0,
      currentIndex: 0,
    }
    await mount(table)

    await waitFor(() => expect(screen.queryByTestId('music-play')).toBeNull())
    const toggle = await screen.findByTestId('music-playlist-toggle')
    await act(async () => {
      fireEvent.click(toggle)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.getByTestId('music-playlist')).toBeTruthy()
  })
})
