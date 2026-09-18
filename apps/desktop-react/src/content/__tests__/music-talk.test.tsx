import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MusicPanel } from '../MusicPanel'
import { FocusDispatchHarness } from '../../test/focus-harness'
import { configureMusicPort } from '../../data/music-port'
import type { MusicPort, MusicResourceEvent } from '../../data/music-port'
import { resetMusicSource } from '../../data/music-source'
import { musicPetActivity } from '../music/pet-activity'
import { useStageStore } from '../../stage/store'
import type { ResourceOutcomeView, ResourceReadView } from '@shared/ipc/resources'

/**
 * 跟主持人说话 —— 壳这一侧(2026-09-18,正本
 * `apps/desktop-react/docs/music-panel-2026-09.md` §7.2 / §7.3 / §7.4)。
 *
 * §7.4 那张门表逐条:回车发一次且只发一次、失败把字还回来、建议词只填不发、
 * `busy` 起止、电台关着不画、打字时 `listening`。
 *
 * 与 `music-panel.test.tsx` 分开住:那只文件已经 800 行,而这一条是一整块新面 ——
 * 它自己的夹具(挂着不回的 `do`、事后推一条 `hostReplied`)在那边一次都用不到。
 */

type ReadTable = Record<string, unknown>

interface FakeMusic {
  port: MusicPort
  dos: Array<{ ref: string; op: string; params: Record<string, unknown> | undefined }>
  listeners: Array<(event: MusicResourceEvent) => void>
  table: ReadTable
  outcome: ResourceOutcomeView
  /** 给了它,`do` 就挂着不回 —— 用来看「发出去了还没回来」那一帧。 */
  hold?: { release: () => void }
}

const NOW_PLAYING = {
  playing: true,
  status: 'playing' as const,
  title: '可惜没如果 - 林俊杰',
  position: 61,
  duration: 298,
  queueLength: 3,
  currentIndex: 0,
}

const BRIEF_ON = { active: true, intent: '下雨天', programmeLength: 2, canResume: true, volume: 42 }
const BRIEF_OFF = { active: false, intent: '', programmeLength: 0, canResume: false }

function makeFake(table: ReadTable): FakeMusic {
  const fake: FakeMusic = {
    dos: [],
    listeners: [],
    table,
    outcome: { kind: 'ok', text: 'done' },
    port: undefined as unknown as MusicPort,
  }
  fake.port = {
    ready: async () => undefined,
    read: async (ref, name): Promise<ResourceReadView> => {
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

function tableWith(brief: unknown): ReadTable {
  return {
    'music:radio#brief': brief,
    'music:radio#programme': { entries: [], onDeck: '可惜没如果 - 林俊杰' },
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

async function mount(table: ReadTable = tableWith(BRIEF_ON)) {
  fake = makeFake(table)
  configureMusicPort(fake.port)
  const view = render(
    <>
      <FocusDispatchHarness />
      <MusicPanel />
    </>,
  )
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return view
}

/** 打一句话进输入框(顺便把焦点落上去 —— 建议词那一排靠它现身)。 */
async function type(words: string) {
  const input = await screen.findByTestId('music-talk-input')
  await act(async () => {
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: words } })
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return input
}

/** 回车发。`<form>` 上的 submit —— 与真机按下 ↵ 是同一条路。 */
async function pressEnter() {
  const input = await screen.findByTestId('music-talk-input')
  await act(async () => {
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
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
  cleanup()
  configureMusicPort(undefined)
  resetMusicSource()
  vi.useRealTimers()
})

describe('跟主持人说话', () => {
  it('电台关着不画:没有主持人可说话', async () => {
    await mount(tableWith(BRIEF_OFF))
    expect(screen.queryByTestId('music-talk')).toBeNull()
  })

  it('电台开着才画,占位问的是那只宠物的名字', async () => {
    await mount()
    const input = await screen.findByTestId('music-talk-input')
    // 名册读不到(壳里没有宠物端口)时落到通名「主持人」—— 不留一个空格。
    expect(input.getAttribute('placeholder')).toBe('跟主持人说点什么')
  })

  it('回车发一次且只发一次,发的是 music:radio 上的 tell', async () => {
    await mount()
    await type('换个心情,别太吵')
    await pressEnter()
    await pressEnter() // 框已经清空了,第二下什么都不该发

    expect(fake.dos).toEqual([
      { ref: 'music:radio', op: 'tell', params: { text: '换个心情,别太吵' } },
    ])
  })

  it('空话不发', async () => {
    await mount()
    await type('   ')
    await pressEnter()
    expect(fake.dos).toHaveLength(0)
  })

  it('发出去:框当场清空、你自己那枚气泡冒出来', async () => {
    await mount()
    await type('慢一点')
    await pressEnter()

    expect((await screen.findByTestId('music-talk-input') as HTMLInputElement).value).toBe('')
    expect((await screen.findByTestId('music-talk-echo')).textContent).toBe('慢一点')
  })

  it('发送失败:气泡撤掉、字还回来、错话就地一行(后端原话)', async () => {
    await mount()
    fake.outcome = { kind: 'denied', reason: '电台没开' }
    await type('慢一点')
    await pressEnter()

    expect((await screen.findByTestId('music-talk-input') as HTMLInputElement).value).toBe('慢一点')
    expect(screen.queryByTestId('music-talk-echo')).toBeNull()
    expect((await screen.findByTestId('music-talk-error')).textContent).toBe('电台没开')
  })

  it('建议词只填进输入框,不直接发', async () => {
    await mount()
    await type('')
    const chips = await screen.findAllByTestId('music-talk-suggestion')
    expect(chips.map((chip) => chip.textContent)).toEqual(['换个心情', '点一首歌', '现在放的是什么'])

    await act(async () => {
      fireEvent.click(chips[0])
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect((await screen.findByTestId('music-talk-input') as HTMLInputElement).value).toBe('换个心情')
    expect(fake.dos).toHaveLength(0)
  })

  it('打字时黑豆 listening;发出去之后 busy,他回了就回到该在的姿势', async () => {
    await mount()
    const pet = () => screen.getByTestId('pet-button')

    await type('慢一点')
    expect(pet().dataset.pose).toBe('listening')

    await pressEnter()
    expect(pet().dataset.pose).toBe('busy')

    // 他回了一句:那条事实推过来(壳这边只认「回了」这一下,那句话走宠物那条路)。
    await act(async () => {
      for (const listener of [...fake.listeners]) {
        listener({ ref: 'music:radio', event: 'hostReplied', payload: { text: '好。', say: '好。' } })
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(pet().dataset.pose).not.toBe('busy')
  })

  it('60s 没回也自己回到该在的姿势,无提示', async () => {
    vi.useFakeTimers()
    fake = makeFake(tableWith(BRIEF_ON))
    configureMusicPort(fake.port)
    render(
      <>
        <FocusDispatchHarness />
        <MusicPanel />
      </>,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const input = screen.getByTestId('music-talk-input')
    await act(async () => {
      fireEvent.change(input, { target: { value: '在吗' } })
      fireEvent.submit(input.closest('form') as HTMLFormElement)
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByTestId('pet-button').dataset.pose).toBe('busy')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(screen.getByTestId('pet-button').dataset.pose).not.toBe('busy')
    // 放手是安静的:屏上不留一句「他没回你」。
    expect(screen.queryByTestId('music-talk-error')).toBeNull()
  })
})

/**
 * 活动那张表多出来的一行(§7.3「发送中 → busy」)。纯函数直接判 —— 行号就是设计。
 */
describe('musicPetActivity —— 等他回话那一行', () => {
  it('等着他回话 = busy,压过「电台关着」与「没歌」', () => {
    expect(musicPetActivity({ brief: BRIEF_OFF, awaitingHost: true })).toBe('busy')
    expect(musicPetActivity({ brief: BRIEF_ON, awaitingHost: true })).toBe('busy')
  })

  it('后端报错仍然赢过它:装作在翻唱片是撒谎', () => {
    expect(musicPetActivity({ brief: BRIEF_ON, awaitingHost: true, nowError: '播放器没起来' })).toBe('fault')
  })

  it('没在等他的时候这一行不存在(原来那几行逐字不变)', () => {
    expect(musicPetActivity({ brief: BRIEF_OFF })).toBe('off')
    expect(musicPetActivity({ brief: BRIEF_ON, nowPlaying: { ...NOW_PLAYING } })).toMatchObject({ kind: 'rhythm' })
  })
})
