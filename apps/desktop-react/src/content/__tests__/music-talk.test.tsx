import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MusicPanel } from '../MusicPanel'
import { enterSessionInWorkbench } from '../session-open'
import { FocusDispatchHarness } from '../../test/focus-harness'
import { configureMusicPort } from '../../data/music-port'
import type { MusicPort, MusicResourceEvent } from '../../data/music-port'
import { resetMusicSource } from '../../data/music-source'
import { musicPetActivity } from '../music/pet-activity'
import { useStageStore } from '../../stage/store'
import type { ResourceOutcomeView, ResourceReadView } from '@shared/ipc/resources'

// 「看他在做什么」打开的是拼贴台里的一条会话 —— 这里只证它点名了哪一条,不真去摆树。
vi.mock('../session-open', () => ({ enterSessionInWorkbench: vi.fn(() => null) }))

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
    // 两首排着(与 BRIEF_ON 的 programmeLength 同数)。空节目单 + 电台开着 = DJ 在补,黑豆会一直 busy(09-18)。
    'music:radio#programme': {
      entries: [
        { encryptedId: 'A1', title: '雨棚下 - 旧电扇' },
        { encryptedId: 'A2', title: '慢车 - 林间录音' },
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
  const input = await screen.findByTestId('pet-menu-input')
  await act(async () => {
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: words } })
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return input
}

/** 回车发。`<form>` 上的 submit —— 与真机按下 ↵ 是同一条路。 */
async function pressEnter() {
  const input = await screen.findByTestId('pet-menu-input')
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

/** 点黑豆:开出那一格(输入框 + 动作)。`click` 的 detail 是 0 —— 与键盘 ↵ 同一条路。 */
async function openTalk() {
  await act(async () => {
    fireEvent.click(await screen.findByTestId('pet-button'))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('跟黑豆说话(09-19:点黑豆开出一格输入框,不在控制栏里)', () => {
  it('控制栏里没有「说话」了', async () => {
    await mount()
    expect(screen.queryByTestId('music-talk')).toBeNull()
  })

  it('关着也有「说话」:占位问今晚想听什么', async () => {
    await mount(tableWith(BRIEF_OFF))
    await openTalk()
    expect(screen.getByTestId('pet-menu-input').getAttribute('placeholder')).toBe('想听什么？')
  })

  it('开着:占位是跟黑豆说点什么', async () => {
    await mount()
    await openTalk()
    expect(screen.getByTestId('pet-menu-input').getAttribute('placeholder')).toBe('和黑豆说点什么')
  })

  it('开着:回车发一次且只发一次(music:radio 上的 tell),那一格收起', async () => {
    await mount()
    await openTalk()
    await type('换个心情,别太吵')
    await pressEnter()
    expect(fake.dos).toEqual([{ ref: 'music:radio', op: 'tell', params: { text: '换个心情,别太吵' } }])
    expect(screen.queryByTestId('pet-menu')).toBeNull()
  })

  it('关着:说的那句话就是开台的意图 → do(music:radio, open)', async () => {
    await mount(tableWith(BRIEF_OFF))
    await openTalk()
    await type('下雨天,安静点的')
    await pressEnter()
    expect(fake.dos).toEqual([{ ref: 'music:radio', op: 'open', params: { intent: '下雨天,安静点的' } }])
  })

  it('空话不发,框还开着', async () => {
    await mount()
    await openTalk()
    await type('   ')
    await pressEnter()
    expect(fake.dos).toHaveLength(0)
    expect(screen.getByTestId('pet-menu-input')).toBeTruthy()
  })

  it('Esc:那一格收起,一发都不发', async () => {
    await mount()
    await openTalk()
    const input = await type('算了')
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Escape' })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.queryByTestId('pet-menu')).toBeNull()
    expect(fake.dos).toHaveLength(0)
  })

  it('点开了不嘀咕:浮层开着还在头顶冒一句是两个人抢着说', async () => {
    await mount()
    await openTalk()
    expect(screen.queryByTestId('pet-bubble-text')).toBeNull()
  })

  it('「看他在做什么」:还没有他的会话 → 停用;有了 → 在拼贴台里打开那条会话', async () => {
    await mount()
    await openTalk()
    expect((screen.getByTestId('pet-menu-session') as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    resetMusicSource()
    await mount(tableWith({ ...BRIEF_ON, hostSessionId: 'dj-session-1' }))
    await openTalk()
    await act(async () => {
      fireEvent.click(screen.getByTestId('pet-menu-session'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(enterSessionInWorkbench).toHaveBeenCalledWith('dj-session-1')
    expect(screen.queryByTestId('pet-menu')).toBeNull()
  })

  it('发送失败:错话在唱片上方就地一行(后端原话),字留着 —— 再点黑豆还在框里', async () => {
    await mount()
    fake.outcome = { kind: 'denied', reason: '电台没开' }
    await openTalk()
    await type('慢一点')
    await pressEnter()
    expect((await screen.findByTestId('music-backend-error')).textContent).toBe('电台没开')
    await openTalk()
    expect((screen.getByTestId('pet-menu-input') as HTMLInputElement).value).toBe('慢一点')
  })

  it('打字时黑豆 listening;发出去之后 busy,他回了就回到该在的姿势', async () => {
    await mount()
    const pet = () => screen.getByTestId('pet-button')
    await openTalk()
    await type('慢一点')
    expect(pet().dataset.pose).toBe('listening')

    await pressEnter()
    expect(pet().dataset.pose).toBe('busy')

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
    await act(async () => {
      fireEvent.click(screen.getByTestId('pet-button'))
      await vi.advanceTimersByTimeAsync(0)
    })
    const input = screen.getByTestId('pet-menu-input')
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
    expect(screen.queryByTestId('music-backend-error')).toBeNull()
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
