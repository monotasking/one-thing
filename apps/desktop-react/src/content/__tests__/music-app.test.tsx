import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MusicPanel } from '../MusicPanel'
import { FocusDispatchHarness } from '../../test/focus-harness'
import { configureMusicPort } from '../../data/music-port'
import type { MusicPort, MusicResourceEvent } from '../../data/music-port'
import { resetMusicSource } from '../../data/music-source'
import { useStageStore } from '../../stage/store'
import type { ResourceOutcomeView, ResourceReadView } from '@shared/ipc/resources'

/**
 * 音乐面 v9「成熟的音乐 App」的用例(正本 `docs/music-panel-2026-09.md` §10)。判的是用户那一条要求的
 * 四句话各自兑现了没有:
 *
 *  ① 状态:播放条上的状态丸恒在、说此刻怎样;要人注意的状态(连不上 / 出错)上状态条、带一颗钮;
 *  ② 指引:没在放时播放条那一行告诉人下一步去哪,一颗钮带过去;
 *  ③ 登录:没登上时自动落到账号那一格(三步清单 + 向导),檐上一颗「登录」,别的分区是登录引导卡;
 *  ④ 扩展 / 分区:导航读分区表;切走再切回来,那一格的东西还在、还是同一只节点(保挂载)。
 * 另有电台与搜索两格发出去的 `(ref, op, params)` 逐字钉住 —— 它们走的是既有做法,不新开路。
 */

type ReadTable = Record<string, unknown>

interface Fake {
  port: MusicPort
  reads: Array<{ ref: string; name: string; query?: Record<string, unknown> }>
  dos: Array<{ ref: string; op: string; params: Record<string, unknown> | undefined }>
  listeners: Array<(event: MusicResourceEvent) => void>
  table: ReadTable
  outcome: ResourceOutcomeView
}

const READY_STATE = {
  setupStage: 'ready',
  configured: true,
  loggedIn: true,
  playerBackend: 'mpv',
  source: 'daily',
  login: { status: 'ok' },
}

const NOW_PLAYING = {
  playing: true,
  status: 'playing' as const,
  title: '可惜没如果 - 林俊杰',
  position: 61,
  duration: 298,
  queueLength: 0,
  currentIndex: 0,
}
const NOTHING = { playing: false, status: 'stopped' as const, position: 0, queueLength: 0, currentIndex: 0 }
const BRIEF_ON = { active: true, intent: '下雨天,安静的中文民谣', programmeLength: 2, canResume: true, volume: 42 }
const BRIEF_OFF = { active: false, intent: '', programmeLength: 0, canResume: false }

function table(patch: ReadTable = {}): ReadTable {
  return {
    'music:radio#brief': BRIEF_ON,
    'music:radio#programme': { entries: [{ encryptedId: 'a', title: '第一首' }] },
    'music:player#nowPlaying': NOW_PLAYING,
    'music:player#lyrics': null,
    'music:provider#state': READY_STATE,
    'music:provider#search': {
      records: [
        { title: '晴天', artist: '周杰伦', playFlag: true },
        { title: '七里香', artist: '周杰伦', playFlag: false },
      ],
    },
    ...patch,
  }
}

function makeFake(t: ReadTable): Fake {
  const fake: Fake = { reads: [], dos: [], listeners: [], table: t, outcome: { kind: 'ok', text: 'done' }, port: undefined as unknown as MusicPort }
  fake.port = {
    ready: async () => undefined,
    read: async (ref, name, query): Promise<ResourceReadView> => {
      fake.reads.push({ ref, name, query: query as Record<string, unknown> | undefined })
      const key = `${ref}#${name}`
      if (!(key in fake.table)) return { kind: 'denied', reason: `no ${key}` }
      return { kind: 'ok', value: fake.table[key] }
    },
    do: async (ref, op, params): Promise<ResourceOutcomeView> => {
      fake.dos.push({ ref, op, params: params as Record<string, unknown> | undefined })
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

let fake: Fake

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount(t: ReadTable = table()) {
  fake = makeFake(t)
  configureMusicPort(fake.port)
  const view = render(
    <>
      <FocusDispatchHarness />
      <MusicPanel />
    </>,
  )
  await settle()
  return view
}

async function click(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** 点导航里的一段。分段器每一段带 `data-value`。 */
async function go(sectionId: string) {
  const nav = screen.getByTestId('music-nav')
  const seg = nav.querySelector<HTMLElement>(`[data-value="${sectionId}"]`)
  if (!seg) throw new Error(`no nav segment ${sectionId}`)
  await click(seg)
}

function sectionBody(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-music-section="${id}"]`)
  if (!el) throw new Error(`section ${id} not mounted`)
  return el
}

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  resetMusicSource()
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.dataset.testid === 'music-panel') return 620
      if (this.dataset.testid === 'music-deck') return 596
      return 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.testid === 'music-deck' ? 300 : 0
    },
  })
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver
})

afterEach(() => {
  cleanup()
  resetMusicSource()
  configureMusicPort(undefined)
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
})

describe('① 状态有反馈', () => {
  it('在放:播放条第一行是歌名 · 歌手,状态丸说「正在播放」;没有状态条', async () => {
    await mount()
    const line = screen.getByTestId('music-now-line')
    expect(line.textContent).toContain('可惜没如果')
    expect(line.textContent).toContain('林俊杰')
    expect(screen.getByTestId('music-status-pill').dataset.kind).toBe('playing')
    expect(screen.getByTestId('music-status-pill').textContent).toBe('正在播放')
    expect(screen.queryByTestId('music-status-banner')).toBeNull()
  })

  it('连不上:状态条说清楚、带「重新连接」;按下去真的重问一遍', async () => {
    const t = table()
    delete t['music:provider#state']
    await mount(t)
    const banner = screen.getByTestId('music-status-banner')
    expect(banner.dataset.kind).toBe('unreachable')
    expect(banner.getAttribute('role')).toBe('alert')
    const before = fake.reads.filter((r) => r.name === 'state').length
    fake.table['music:provider#state'] = READY_STATE
    await click(within(banner).getByTestId('music-status-action'))
    await settle()
    expect(fake.reads.filter((r) => r.name === 'state').length).toBeGreaterThan(before)
    expect(screen.queryByTestId('music-status-banner')).toBeNull()
  })

  it('后端报错:状态条是那句话(原话套一层),状态丸说「出错了」', async () => {
    await mount(table({ 'music:provider#state': { ...READY_STATE, lastError: 'ncm-cli 超时' } }))
    expect(screen.getByTestId('music-backend-error').textContent).toBe('音乐服务出错：ncm-cli 超时')
    expect(screen.getByTestId('music-status-pill').dataset.kind).toBe('error')
  })

  it('电台开着但播放器停了:不上状态条(不是故障),状态丸说「已停止」,按 ⏯ 继续 → do(music:radio, radioResume)', async () => {
    await mount(table({ 'music:player#nowPlaying': NOTHING }))
    expect(screen.queryByTestId('music-status-banner')).toBeNull()
    expect(screen.getByTestId('music-status-pill').textContent).toBe('已停止')
    expect(screen.getByTestId('music-now-line').textContent).toContain('点击播放继续收听。')
    await click(screen.getByTestId('music-play'))
    expect(fake.dos.at(-1)).toMatchObject({ ref: 'music:radio', op: 'radioResume' })
  })
})

describe('② 操作指引', () => {
  it('电台关着、什么都没放:播放条那一行说「没在放」+ 去哪 + 一颗「去开台」,按下去到电台那一格', async () => {
    await mount(table({ 'music:radio#brief': BRIEF_OFF, 'music:player#nowPlaying': NOTHING }))
    const line = screen.getByTestId('music-now-line')
    expect(line.textContent).toContain('在「电台」中选择一种心情即可开始。')
    await click(within(line).getByTestId('music-status-action'))
    expect(screen.getByTestId('music-panel').dataset.section).toBe('radio')
    expect(sectionBody('radio').hidden).toBe(false)
  })
})

describe('③ 没登录引导登录', () => {
  const NOT_LOGGED_IN = {
    setupStage: 'login',
    configured: true,
    loggedIn: false,
    playerBackend: 'mpv',
    source: 'daily',
    login: { status: 'idle' },
    env: { tools: { 'ncm-cli': { installed: true }, mpv: { installed: true } }, npmAvailable: true, brewAvailable: true },
  }

  it('自动落到账号那一格:三步清单(前两步已完成、第三步是当前)+ 向导;檐上一颗「登录」;没有播放条', async () => {
    await mount(table({ 'music:provider#state': NOT_LOGGED_IN }))
    expect(screen.getByTestId('music-panel').dataset.section).toBe('account')
    const steps = within(screen.getByTestId('music-onboard-steps')).getAllByRole('listitem')
    expect(steps.map((li) => li.dataset.state)).toEqual(['done', 'done', 'current'])
    expect(steps[2].getAttribute('aria-current')).toBe('step')
    expect(screen.getByTestId('music-setup').dataset.step).toBe('login')
    expect(screen.getByTestId('music-login').textContent).toContain('登录')
    expect(screen.queryByTestId('music-player-bar')).toBeNull()
  })

  it('没登录时点「电台」:画登录引导卡(不是空白),卡上的钮带回账号那一格', async () => {
    await mount(table({ 'music:provider#state': NOT_LOGGED_IN }))
    await go('radio')
    const gate = within(sectionBody('radio')).getByTestId('music-login-gate')
    expect(gate.textContent).toContain('登录后即可使用')
    expect(gate.textContent).toContain('第 3/3 步')
    expect(screen.queryByTestId('music-section-radio')).toBeNull()
    await click(within(gate).getByTestId('music-gate-login'))
    expect(screen.getByTestId('music-panel').dataset.section).toBe('account')
  })

  it('登上了:檐上换成账号钮;菜单里多一项直达账号那一格', async () => {
    await mount()
    expect(screen.queryByTestId('music-login')).toBeNull()
    await click(screen.getByTestId('music-account'))
    await click(screen.getByRole('menuitem', { name: '账号设置' }))
    expect(screen.getByTestId('music-panel').dataset.section).toBe('account')
    expect(screen.getByTestId('music-section-account').textContent).toContain('已登录')
  })

  it('账号那一格:换出声方式 → setup set-player', async () => {
    await mount()
    await click(screen.getByTestId('music-account'))
    await click(screen.getByRole('menuitem', { name: '账号设置' }))
    const player = screen.getByTestId('music-account-player')
    await click(within(player).getByRole('radio', { name: '网易云音乐 App' }))
    expect(fake.dos.at(-1)).toMatchObject({ ref: 'music:provider', op: 'setup', params: { action: 'set-player', player: 'orpheus' } })
  })
})

describe('④ 分区:导航读表,切走不丢', () => {
  it('导航三段:正在放 / 电台 / 搜索(账号不在导航里,它的入口在檐右端)', async () => {
    await mount()
    const segs = within(screen.getByTestId('music-nav')).getAllByRole('radio')
    expect(segs.map((el) => el.textContent)).toEqual(['正在播放', '电台', '搜索'])
    expect(segs[0].getAttribute('aria-checked')).toBe('true')
  })

  it('搜过之后切到别处再切回来:结果还在,而且是同一只节点(保挂载)', async () => {
    await mount()
    await go('search')
    fireEvent.change(screen.getByTestId('music-search-input'), { target: { value: '周杰伦' } })
    await click(screen.getByTestId('music-search-submit'))
    const list = screen.getByTestId('music-search-results')
    await go('now')
    expect(sectionBody('search').hidden).toBe(true)
    await go('search')
    expect(screen.getByTestId('music-search-results')).toBe(list)
    expect((screen.getByTestId('music-search-input') as HTMLInputElement).value).toBe('周杰伦')
  })

  it('唱机那一格切走再切回来也是同一只节点', async () => {
    await mount()
    const deck = screen.getByTestId('music-deck')
    await go('radio')
    await go('now')
    expect(screen.getByTestId('music-deck')).toBe(deck)
  })
})

describe('电台那一格', () => {
  it('关着:点一枚心情块 = 以整句意图开台', async () => {
    await mount(table({ 'music:radio#brief': BRIEF_OFF, 'music:player#nowPlaying': NOTHING }))
    await go('radio')
    expect(screen.getByTestId('music-station-state').textContent).toBe('未开启')
    await click(screen.getByTestId('music-station-mood-rain'))
    expect(fake.dos.at(-1)).toEqual({ ref: 'music:radio', op: 'open', params: { intent: '下雨天,安静点的' } })
  })

  it('开着:状态行带剩几首;心情块变换台;点歌与说话两块在', async () => {
    await mount()
    await go('radio')
    expect(screen.getByTestId('music-station-state').textContent).toBe('已开启 · 剩余 2 首')
    await click(screen.getByTestId('music-station-mood-focus'))
    expect(fake.dos.at(-1)).toEqual({ ref: 'music:radio', op: 'retune', params: { intent: '写代码,少点人声' } })

    fireEvent.change(screen.getByTestId('music-station-request'), { target: { value: '晴天 周杰伦' } })
    await click(screen.getByTestId('music-station-request-send'))
    expect(fake.dos.at(-1)).toEqual({ ref: 'music:radio', op: 'request', params: { song: '晴天 周杰伦' } })

    fireEvent.change(screen.getByTestId('music-station-talk'), { target: { value: '来点老歌' } })
    await click(screen.getByTestId('music-station-talk-send'))
    expect(fake.dos.at(-1)).toEqual({ ref: 'music:radio', op: 'tell', params: { text: '来点老歌' } })
    expect(screen.getByTestId('music-station-echo').textContent).toBe('来点老歌')
  })

  it('开台失败:那一块下面一行原话,输入里的字留着', async () => {
    await mount(table({ 'music:radio#brief': BRIEF_OFF, 'music:player#nowPlaying': NOTHING }))
    await go('radio')
    fake.outcome = { kind: 'failed', error: { message: 'DJ 没起来' } } as ResourceOutcomeView
    fireEvent.change(screen.getByTestId('music-station-intent'), { target: { value: '周五晚上' } })
    await click(screen.getByTestId('music-station-tune'))
    expect(screen.getByTestId('music-station-error').textContent).toBe('DJ 没起来')
    expect((screen.getByTestId('music-station-intent') as HTMLInputElement).value).toBe('周五晚上')
  })
})

describe('搜索那一格', () => {
  it('回车搜的是人打的那句话;没版权的那行灰着、没有钮', async () => {
    await mount()
    await go('search')
    fireEvent.change(screen.getByTestId('music-search-input'), { target: { value: '周杰伦' } })
    await click(screen.getByTestId('music-search-submit'))
    expect(fake.reads.at(-1)).toEqual({ ref: 'music:provider', name: 'search', query: { query: '周杰伦' } })
    const rows = within(screen.getByTestId('music-search-results')).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[1]).queryByTestId('music-search-pick')).toBeNull()
    expect(rows[1].textContent).toContain('暂无版权')
  })

  it('电台开着:「插到下一首」→ request { song: 歌名 歌手 }', async () => {
    await mount()
    await go('search')
    fireEvent.change(screen.getByTestId('music-search-input'), { target: { value: '晴天' } })
    await click(screen.getByTestId('music-search-submit'))
    const pick = screen.getByTestId('music-search-pick')
    expect(pick.textContent).toBe('下一首播放')
    await click(pick)
    expect(fake.dos.at(-1)).toEqual({ ref: 'music:radio', op: 'request', params: { song: '晴天 周杰伦' } })
  })

  it('电台关着:「用它开台」→ open,意图里带这首;成了就带人去电台那一格', async () => {
    await mount(table({ 'music:radio#brief': BRIEF_OFF, 'music:player#nowPlaying': NOTHING }))
    await go('search')
    fireEvent.change(screen.getByTestId('music-search-input'), { target: { value: '晴天' } })
    await click(screen.getByTestId('music-search-submit'))
    await click(screen.getByTestId('music-search-pick'))
    expect(fake.dos.at(-1)).toEqual({
      ref: 'music:radio',
      op: 'open',
      params: { intent: '先放「晴天 周杰伦」,然后接着放风格相似的歌' },
    })
    expect(screen.getByTestId('music-panel').dataset.section).toBe('radio')
  })

  it('没搜到:一句「没搜到」+ 换个说法', async () => {
    await mount(table({ 'music:provider#search': { records: [] } }))
    await go('search')
    fireEvent.change(screen.getByTestId('music-search-input'), { target: { value: 'zzzz' } })
    await click(screen.getByTestId('music-search-submit'))
    expect(screen.getByTestId('music-search-empty').textContent).toBe('未找到「zzzz」相关的歌曲。')
  })
})

describe('衔接(09-25):切分区回来歌词不乱、暂停不倒退', () => {
  const LINE_H = 30
  const LYRICS = {
    title: NOW_PLAYING.title,
    lines: Array.from({ length: 12 }, (_, i) => ({ at: 60 + i * 0.3, text: `第${i + 1}句` })),
  }

  beforeEach(() => {
    // jsdom 没有布局:给歌词行一个行高,**藏着(祖先带 hidden)时量出来是 0** —— 与真机 display:none 同形。
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.dataset.lyricIndex === undefined) return 0
        return this.closest('[hidden]') ? 0 : LINE_H
      },
    })
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.dataset.lyricIndex === undefined || this.closest('[hidden]')) return 0
        return Number(this.dataset.lyricIndex) * LINE_H
      },
    })
  })
  afterEach(() => {
    delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight
    delete (HTMLElement.prototype as { offsetTop?: number }).offsetTop
  })

  /** 正在唱那一句的对位常数:y + 行顶 + 半行高 = 唱针高度,对哪一句都一样。 */
  function anchorOf(): number {
    const list = screen.getByTestId('music-lyrics').querySelector('ol') as HTMLElement
    const y = parseFloat(list.style.getPropertyValue('--lyrics-y'))
    const current = document.querySelector<HTMLElement>('[data-lyric-index][data-current="true"]')
    const index = current ? Number(current.dataset.lyricIndex) : 0
    return y + index * LINE_H + LINE_H / 2
  }

  it('切到电台再切回来:歌词直接落在正在唱的那一句,对位与切走前一致', async () => {
    await mount(table({ 'music:player#lyrics': LYRICS }))
    await settle()
    const before = anchorOf()
    await go('radio')
    // 藏着的这段时间里唱过去好几句(播放钟 250ms 一拍)。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900))
    })
    await go('now')
    expect(anchorOf()).toBeCloseTo(before)
    const list = screen.getByTestId('music-lyrics').querySelector('ol') as HTMLElement
    expect(list.dataset.jump).toBe('true') // 回来那一下不带滚动动画
  })

  it('在放一会儿再暂停:进度停在按下那一秒,不退回上一次读数的位置', async () => {
    await mount()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700))
    })
    // 按下那一帧(同步提交,后端还没回话):位置冻在此刻推到的那一秒。
    act(() => {
      fireEvent.click(screen.getByTestId('music-play'))
    })
    expect(screen.getByTestId('music-play').getAttribute('aria-label')).toBe('播放')
    const value = Number(screen.getByTestId('music-seek').getAttribute('aria-valuenow'))
    expect(value).toBeGreaterThan(NOW_PLAYING.position + 0.5)
    await settle()
  })
})
