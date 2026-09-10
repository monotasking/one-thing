import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MusicPanel } from '../MusicPanel'
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
 *  ⑦ HMR dispose 走的那一口(`resetMusicSource`)真的退订。
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

async function mount(table: ReadTable = fullTable()) {
  fake = makeFake(table)
  configureMusicPort(fake.port)
  const view = render(<MusicPanel />)
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
})

afterEach(() => {
  // **先卸载再归零**:`resetMusicSource()` 会 emit(五格读数回出厂),而 vitest 的
  // afterEach 是后注册先跑 —— 不显式 cleanup 的话这一声会打在还挂着的组件上,
  // React 当场报「不在 act 里的更新」。RTL 自己那格 cleanup 是幂等的。
  cleanup()
  resetMusicSource()
  configureMusicPort(undefined)
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
    await screen.findByText('可惜没如果 - 林俊杰')
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
    ['music-close', 'music:radio', 'close', {}],
    ['music-radio-resume', 'music:radio', 'radioResume', {}],
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

  it('换台带着输入框里那句意图', async () => {
    await mount()
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
    await screen.findByText('晴天 - 周杰伦')
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
  it('播放器没在跑 / 电台没开,各说各的', async () => {
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
    expect(screen.getByText('电台没开 —— 说一句想听什么就能开台。')).toBeTruthy()
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
