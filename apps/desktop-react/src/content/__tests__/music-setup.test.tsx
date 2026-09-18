import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MusicPanel } from '../MusicPanel'
import { ConfirmHost } from '../../ui/Dialog'
import { FocusDispatchHarness } from '../../test/focus-harness'
import { configureMusicPort } from '../../data/music-port'
import type { MusicPort, MusicResourceEvent } from '../../data/music-port'
import { resetMusicSource } from '../../data/music-source'
import { useStageStore } from '../../stage/store'
import type { ResourceOutcomeView, ResourceReadView } from '@shared/ipc/resources'

/**
 * **接入向导的用例**(2026-09-18;正本 `apps/desktop-react/docs/music-panel-2026-09.md`
 * §6.6 那张门的清单)。判的是三步与那条缝,不是屏幕好不好看:
 *
 *  ① 后端没配好 = 画向导(而不是今天那一句提示),而且电台条 / 歌条这几步里不画;
 *  ② 读不到 `state` = 向导不画、顶上仍是那一句(后端都不在,装什么都没用);
 *  ③ 三步各自发出去的 `(ref, op, params)` **逐字**是那一条 —— 地址永远是
 *     `music:provider`,做法永远是 `setup`,没有第二条路;
 *  ④ 三步各自的失败:就地一行原话,输入不清空,零 Toast;
 *  ⑤ 安装输出跟到底(`setupOutput` 那条资源事实 → 那一块 `<pre>` 滚到底);
 *  ⑥ 登录轮询起停(假计时器):`waiting` 才跑,取消 / 卸载当场停;
 *  ⑦ `ok` 之后向导留屏 1.5 秒说一句「进电台了」,然后自己消失;
 *  ⑧ 账号菜单两项各发一次,退出登录先确认。
 */

type ReadTable = Record<string, unknown>

interface FakeMusic {
  port: MusicPort
  dos: Array<{ ref: string; op: string; params: Record<string, unknown> | undefined }>
  listeners: Array<(event: MusicResourceEvent) => void>
  table: ReadTable
  /** 下一次 `do` 的答案。缺省 ok。 */
  outcome: ResourceOutcomeView
  /** 按 `op:action` 记的定制答案 —— 一步失败、别步照常。 */
  outcomes: Record<string, ResourceOutcomeView>
}

const BRIEF_OFF = { active: false, intent: '', programmeLength: 0, canResume: false }
const NOTHING = { playing: false, status: 'stopped' as const, position: 0, queueLength: 0, currentIndex: 0 }
const LOGIN_URL = 'https://music.163.com/login?codekey=8f3c1d5e-7a20-4b6f-9c11-2de4a8b07f63'

/** 一份后端状态。默认停在第 ① 步,两件工具都没装。 */
function runtime(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    setupStage: 'env',
    configured: false,
    loggedIn: false,
    playerBackend: 'mpv',
    source: 'daily',
    login: { status: 'idle' },
    env: {
      tools: { 'ncm-cli': { installed: false }, mpv: { installed: false } },
      npmAvailable: true,
      brewAvailable: true,
    },
    ...patch,
  }
}

function tableWith(state: Record<string, unknown> | undefined): ReadTable {
  return {
    'music:radio#brief': BRIEF_OFF,
    'music:radio#programme': { entries: [] },
    'music:player#nowPlaying': NOTHING,
    'music:player#lyrics': null,
    ...(state ? { 'music:provider#state': state } : {}),
  }
}

function makeFake(table: ReadTable): FakeMusic {
  const fake: FakeMusic = {
    dos: [],
    listeners: [],
    table,
    outcome: { kind: 'ok', text: 'done' },
    outcomes: {},
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
      const action = typeof params?.action === 'string' ? params.action : ''
      return fake.outcomes[`${op}:${action}`] ?? fake.outcome
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

let fake: FakeMusic

/** 与 `music-panel.test.tsx` 逐字同一套夹具:jsdom 里没有布局,也没有观察器。 */
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

async function mount(table: ReadTable) {
  fake = makeFake(table)
  configureMusicPort(fake.port)
  const view = render(
    <>
      <FocusDispatchHarness />
      <ConfirmHost />
      <MusicPanel />
    </>,
  )
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return view
}

/** 后端把状态换了一版,并推一条 `setupChanged`(真机上向导就是这样换格的)。 */
async function backendMovedTo(state: Record<string, unknown>) {
  fake.table['music:provider#state'] = state
  await act(async () => {
    for (const listener of [...fake.listeners]) {
      listener({ ref: 'music:provider', event: 'setupChanged', payload: { setupStage: state.setupStage } })
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** 一条 `setupOutput` 资源事实到了。 */
async function outputArrived(tool: string, chunk: string) {
  await act(async () => {
    for (const listener of [...fake.listeners]) {
      listener({ ref: 'music:provider', event: 'setupOutput', payload: { tool, chunk } })
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function click(testId: string) {
  const element = await screen.findByTestId(testId)
  await act(async () => {
    fireEvent.click(element)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const setupCalls = () => fake.dos.filter((call) => call.op === 'setup')

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  resetMusicSource()
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.testid === 'music-panel' ? 620 : 0
    },
  })
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver
})

afterEach(() => {
  cleanup()
  resetMusicSource()
  configureMusicPort(undefined)
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  vi.useRealTimers()
})

describe('后端没配好:画向导,不是画一句话', () => {
  it('向导占唱片那一块;唱片面与按钮那一行这几步里不画', async () => {
    await mount(tableWith(runtime()))
    expect(screen.getByTestId('music-setup').dataset.step).toBe('env')
    // 今天那句提示只留给「后端整个读不到」那一档。
    expect(screen.queryByTestId('music-not-ready')).toBeNull()
    expect(screen.queryByTestId('music-deck')).toBeNull()
    expect(screen.queryByTestId('music-playlist-toggle')).toBeNull()
  })

  it('读不到 state:向导不画,顶上仍是今天那句话', async () => {
    await mount(tableWith(undefined))
    expect(screen.queryByTestId('music-setup')).toBeNull()
    expect(screen.getByTestId('music-not-ready')).toBeTruthy()
  })

  it('配好了:向导不在场,唱片面回来', async () => {
    await mount(tableWith(runtime({ setupStage: 'ready', configured: true, loggedIn: true })))
    expect(screen.queryByTestId('music-setup')).toBeNull()
    expect(screen.getByTestId('music-deck')).toBeTruthy()
  })
})

describe('① 装工具', () => {
  it('两行工具由后端自述;点安装发的是 music:provider 上的 setup', async () => {
    await mount(tableWith(runtime()))
    expect(screen.getByTestId('music-tool-ncm-cli')).toBeTruthy()
    expect(screen.getByTestId('music-tool-mpv')).toBeTruthy()

    await click('music-install-ncm-cli')
    expect(setupCalls()).toContainEqual({
      ref: 'music:provider',
      op: 'setup',
      params: { action: 'install-tool', tool: 'ncm-cli' },
    })
  })

  it('装好的那一行画版本,不画钮', async () => {
    await mount(
      tableWith(
        runtime({
          env: {
            tools: { 'ncm-cli': { installed: true, version: '0.1.6' }, mpv: { installed: false } },
            npmAvailable: true,
            brewAvailable: true,
          },
        }),
      ),
    )
    expect(screen.getByTestId('music-tool-ok-ncm-cli').textContent).toContain('0.1.6')
    expect(screen.queryByTestId('music-install-ncm-cli')).toBeNull()
    expect(screen.getByTestId('music-install-mpv')).toBeTruthy()
  })

  it('env 还没查过:两行占位、钮停用,而且自己去查一次(只查一次)', async () => {
    await mount(tableWith(runtime({ env: undefined })))
    // 占位:两行还在,名字是「正在看这台电脑上有什么…」,钮点不动。
    const buttons = screen.getAllByRole('button', { name: '安装' }) as HTMLButtonElement[]
    expect(buttons).toHaveLength(2)
    expect(buttons.every((button) => button.disabled)).toBe(true)
    expect(screen.queryByTestId('music-tool-ncm-cli')).toBeNull()

    expect(setupCalls()).toEqual([
      { ref: 'music:provider', op: 'setup', params: { action: 'check-env' } },
    ])
    // 一次失败之后也不再自己重来 —— 那会变成对着坏掉的 npm 每秒起一个子进程。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(setupCalls()).toHaveLength(1)
  })

  it('那一行失败:就地一行原话,钮变「重试」,零 Toast;别的行不受连累', async () => {
    await mount(tableWith(runtime()))
    fake.outcomes['setup:install-tool'] = { kind: 'failed', error: { name: 'Error', message: 'npm 不在这台机器上' } }
    await click('music-install-ncm-cli')

    expect(screen.getByTestId('music-install-error-ncm-cli').textContent).toBe('npm 不在这台机器上')
    expect(screen.getByTestId('music-install-ncm-cli').textContent).toBe('重试')
    // 逐格:mpv 那一行的钮还是「安装」,也没有错话。
    expect(screen.getByTestId('music-install-mpv').textContent).toBe('安装')
    expect(screen.queryByTestId('music-install-error-mpv')).toBeNull()
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  it('安装输出铺在那一行上,而且自动跟到底', async () => {
    await mount(tableWith(runtime()))
    // jsdom 没有布局,`scrollHeight` 恒 0 —— 给它一个读数,才判得出「跟到底」。
    Object.defineProperty(HTMLPreElement.prototype, 'scrollHeight', { configurable: true, get: () => 999 })
    try {
      await outputArrived('ncm-cli', 'npm warn deprecated\nadded 87 packages')
      const log = screen.getByTestId('music-install-log')
      expect(log.textContent).toContain('added 87 packages')
      expect(log.scrollTop).toBe(999)
      // 另一件工具的输出不串行到这一行上。
      await outputArrived('mpv', '==> Pouring mpv\n')
      expect(screen.getAllByTestId('music-install-log')).toHaveLength(2)
    } finally {
      delete (HTMLPreElement.prototype as { scrollHeight?: number }).scrollHeight
    }
  })
})

describe('② 填凭据', () => {
  const CRED = runtime({
    setupStage: 'credentials',
    env: {
      tools: { 'ncm-cli': { installed: true, version: '0.1.6' }, mpv: { installed: true, version: '0.40.0' } },
      npmAvailable: true,
      brewAvailable: true,
    },
  })

  async function fill(appId: string, key: string) {
    await act(async () => {
      fireEvent.change(screen.getByTestId('music-app-id'), { target: { value: appId } })
      fireEvent.change(screen.getByTestId('music-private-key'), { target: { value: key } })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  it('两格都填满才按得动保存;发出去的是 setup / set-credentials', async () => {
    await mount(tableWith(CRED))
    expect((screen.getByTestId('music-credentials-save') as HTMLButtonElement).disabled).toBe(true)
    await fill('1234', 'sk-secret')
    await click('music-credentials-save')
    expect(setupCalls()).toEqual([
      {
        ref: 'music:provider',
        op: 'setup',
        params: { action: 'set-credentials', appId: '1234', privateKey: 'sk-secret' },
      },
    ])
  })

  it('私钥永远不回显(输入框是密码形)', async () => {
    await mount(tableWith(CRED))
    await fill('1234', 'sk-secret')
    expect(screen.getByTestId('music-private-key').getAttribute('type')).toBe('password')
  })

  it('失败:就地一行原话,输入不清空', async () => {
    await mount(tableWith(CRED))
    fake.outcomes['setup:set-credentials'] = { kind: 'invalid', message: 'appId 与 privateKey 不能为空' }
    await fill('1234', 'sk-secret')
    await click('music-credentials-save')
    expect(screen.getByTestId('music-credentials-error').textContent).toBe('appId 与 privateKey 不能为空')
    expect((screen.getByTestId('music-app-id') as HTMLInputElement).value).toBe('1234')
    expect((screen.getByTestId('music-private-key') as HTMLInputElement).value).toBe('sk-secret')
  })
})

describe('③ 登录', () => {
  const READY_TOOLS = {
    tools: { 'ncm-cli': { installed: true, version: '0.1.6' }, mpv: { installed: true, version: '0.40.0' } },
    npmAvailable: true,
    brewAvailable: true,
  }
  const login = (state: Record<string, unknown>) =>
    runtime({ setupStage: 'login', configured: true, env: READY_TOOLS, login: state })

  it('idle:一颗「开始登录」,码不画', async () => {
    await mount(tableWith(login({ status: 'idle' })))
    expect(screen.queryByTestId('music-login-qr')).toBeNull()
    await click('music-login-start')
    expect(setupCalls()).toEqual([
      { ref: 'music:provider', op: 'setup', params: { action: 'login-start' } },
    ])
  })

  it('waiting:码 + 地址的文字形态 + 两颗钮 + 取消', async () => {
    await mount(tableWith(login({ status: 'waiting', url: LOGIN_URL })))
    const qr = screen.getByTestId('music-login-qr')
    expect(qr.getAttribute('role')).toBe('img')
    expect(qr.getAttribute('aria-label')).toBe('登录二维码')
    // 地址不能只剩一张图:读屏用户扫不了码,他要的是这条地址本身。
    expect(screen.getByTestId('music-login-url').textContent).toBe(LOGIN_URL)
    expect(screen.getByTestId('music-login-open')).toBeTruthy()
    expect(screen.getByTestId('music-login-copy')).toBeTruthy()

    await click('music-login-cancel')
    expect(setupCalls()).toContainEqual({
      ref: 'music:provider',
      op: 'setup',
      params: { action: 'login-cancel' },
    })
  })

  it.each([
    ['failed', 'ncm-cli login 启动失败(退出码 1)'],
    ['quota', '请求总量超限'],
  ])('%s:一行后端原话 + 「再试一次」,码不画', async (status, message) => {
    await mount(tableWith(login({ status, message })))
    expect(screen.queryByTestId('music-login-qr')).toBeNull()
    expect(screen.getByTestId('music-login-error').textContent).toBe(message)
    expect(screen.getByTestId('music-login-start').textContent).toBe('再试一次')
  })

  it('waiting 期间每 2.5s 问一次;取消之后停', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await mount(tableWith(login({ status: 'waiting', url: LOGIN_URL })))
    expect(setupCalls()).toHaveLength(0)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500)
    })
    expect(setupCalls().filter((call) => call.params?.action === 'login-check')).toHaveLength(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(setupCalls().filter((call) => call.params?.action === 'login-check')).toHaveLength(3)

    // 后端说不等了(取消 / 失败都会把状态换掉)—— 轮询当场停。
    await backendMovedTo(login({ status: 'idle' }))
    const before = setupCalls().filter((call) => call.params?.action === 'login-check').length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(setupCalls().filter((call) => call.params?.action === 'login-check')).toHaveLength(before)
  })

  it('卸载之后不再问', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await mount(tableWith(login({ status: 'waiting', url: LOGIN_URL })))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500)
    })
    const before = setupCalls().length
    cleanup()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(setupCalls()).toHaveLength(before)
  })

  it('登上了:向导当场换成唱机,不留一句旁白', async () => {
    await mount(tableWith(login({ status: 'waiting', url: LOGIN_URL })))
    await backendMovedTo(runtime({ setupStage: 'ready', configured: true, loggedIn: true, env: READY_TOOLS, login: { status: 'ok' } }))

    // 「登上了」这件事由唱机出现自己说(用户 09-18:「进电台了」这是让用户读的吗)。
    await waitFor(() => expect(screen.queryByTestId('music-setup')).toBeNull())
    expect(screen.getByTestId('music-deck')).toBeTruthy()
  })
})

/** 账号那颗钮住在播放列表抽屉的檐上(音乐面 v8:电台条并掉之后)。 */
async function openAccount() {
  if (!screen.queryByTestId('music-playlist')) await click('music-playlist-toggle')
  await click('music-account')
}

describe('账号菜单(在播放列表抽屉的檐上)', () => {
  const READY = runtime({
    setupStage: 'ready',
    configured: true,
    loggedIn: true,
    login: { status: 'ok' },
    env: {
      tools: { 'ncm-cli': { installed: true, version: '0.1.6' }, mpv: { installed: true, version: '0.40.0' } },
      npmAvailable: true,
      brewAvailable: true,
    },
  })

  it('出声方式两项:当前那个打勾,换一个发一次 set-player', async () => {
    await mount(tableWith(READY))
    await openAccount()

    const here = screen.getByRole('menuitemradio', { name: '在这台电脑上出声' })
    const inApp = screen.getByRole('menuitemradio', { name: '交给网易云音乐 App' })
    expect(here.getAttribute('aria-checked')).toBe('true')
    expect(inApp.getAttribute('aria-checked')).toBe('false')

    await act(async () => {
      fireEvent.click(inApp)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(setupCalls()).toEqual([
      { ref: 'music:provider', op: 'setup', params: { action: 'set-player', player: 'orpheus' } },
    ])
  })

  it('点已经打着勾的那一项:一发都不发', async () => {
    await mount(tableWith(READY))
    await openAccount()
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitemradio', { name: '在这台电脑上出声' }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(setupCalls()).toEqual([])
  })

  it('退出登录:先确认 —— 取消 = 一发都不发,确认才发 logout', async () => {
    await mount(tableWith(READY))
    await openAccount()
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: '退出登录' }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    // 抽屉本身就是一格 dialog;确认框是叠在它上面的第二格。
    expect(screen.getAllByRole('dialog')).toHaveLength(2)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '取消' }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(setupCalls()).toEqual([])

    await openAccount()
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: '退出登录' }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '退出登录' }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(setupCalls()).toEqual([
      { ref: 'music:provider', op: 'setup', params: { action: 'logout' } },
    ])
  })

})
