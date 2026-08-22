// @vitest-environment happy-dom
/**
 * S 状态带验收(E 期,docs/design/composer-bands-2026-08.md)。
 *
 * 三件事:① 三个内置成员都收敛成 chip、展开态整体进浮层且交互不降级;
 * ② 插件块穿静态 chip 壳而锚点契约不动;③ 电台迁出输入框骨架后,
 * `--music-bar-reserve` / NOW PLAYING 帧标签一族在代码里没有残留。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const rendererRoot = path.resolve(here, '../../..')
const read = (rel: string) => readFileSync(path.join(rendererRoot, rel), 'utf8')

const state = vi.hoisted(() => ({
  jobs: [] as any[],
  goal: null as any,
  music: null as any,
  settings: null as any,
}))

vi.mock('@/platform', () => ({
  platformApi: {
    goalSet: vi.fn(async () => ({ success: true })),
    openSettingsWindow: vi.fn(async () => ({ success: true })),
  },
}))

// P4c 第九批:后台任务表走通用 RPC 的 tools 域,客户端在 `@/platform/tools-client`。
vi.mock('@/platform/tools-client', () => ({
  toolsApi: {
    listBackgroundJobs: vi.fn(async () => ({ jobs: state.jobs })),
    stopBackgroundJob: vi.fn(async () => ({ success: true })),
  },
}))

vi.mock('@/stores/sessions', () => ({
  useSessionsStore: () => ({
    sessionGoals: new Map(state.goal ? [['s-1', state.goal]] : []),
    fetchGoal: vi.fn(),
    updateSessionGoal: vi.fn(),
  }),
}))

vi.mock('@/stores/music', () => ({ useMusicStore: () => state.music }))
vi.mock('@/stores/settings', () => ({ useSettingsStore: () => state.settings }))

const mounted: VueWrapper[] = []
function track<T extends VueWrapper>(wrapper: T): T {
  mounted.push(wrapper)
  return wrapper
}

beforeEach(() => {
  // 压缩位住 chatStore(C6),后台任务这枚 chip 因此要一个活的 pinia。
  setActivePinia(createPinia())
  state.jobs = []
  state.goal = null
  state.music = {
    nowPlaying: null,
    livePosition: 0,
    progressRatio: 0,
    djPatter: '',
    radio: { active: false, intent: '', programmeLength: 0, canResume: false, volume: 60 },
    state: { loggedIn: true, configured: true },
    playerBackend: 'mpv',
    currentLyricLine: '',
    initialize: vi.fn(async () => {}),
    useClock: vi.fn(() => () => {}),
    sendCommand: vi.fn(async () => ({ success: true })),
    setPlayer: vi.fn(async () => {}),
    stopDjPatter: vi.fn(),
    openRadio: vi.fn(async () => ({ success: true })),
  }
  state.settings = { settings: { music: { enabled: true } } }
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('S 状态带 · 后台任务', () => {
  it('没有运行中的任务时一个字节都不渲染(空态零高度的前提)', async () => {
    const { default: BackgroundJobsStatusBar } = await import('../BackgroundJobsStatusBar.vue')
    const wrapper = track(mount(BackgroundJobsStatusBar, { attachTo: document.body }))
    await flushPromises()

    expect(wrapper.find('.status-chip').exists()).toBe(false)
  })

  it('有任务时是一枚 `⚙ N jobs` chip,展开态保留逐 job + 端口 + 停止', async () => {
    state.jobs = [
      { id: 'j1', command: 'bun run dev', cwd: '/repo', status: 'running', childPids: [], ports: [5173] },
      { id: 'j2', command: 'bun run evals', cwd: '/repo', status: 'running', childPids: [] },
    ]
    const { default: BackgroundJobsStatusBar } = await import('../BackgroundJobsStatusBar.vue')
    const wrapper = track(mount(BackgroundJobsStatusBar, { attachTo: document.body }))
    await flushPromises()

    const chip = wrapper.find('button.status-chip')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('⚙')
    expect(chip.text()).toContain('2')
    expect(chip.text()).toContain('jobs')

    await chip.trigger('click')
    await flushPromises()

    const flyout = document.body.querySelector('.status-chip-flyout-body')
    expect(flyout?.textContent).toContain('bun run dev')
    expect(flyout?.textContent).toContain(':5173')
    expect(flyout?.querySelectorAll('.job-stop')).toHaveLength(2)
    expect(flyout?.querySelector('.refresh-btn')).not.toBeNull()
  })
})

describe('S 状态带 · 压缩(C6)', () => {
  async function mountBar(props: Record<string, unknown> = {}) {
    const { default: BackgroundJobsStatusBar } = await import('../BackgroundJobsStatusBar.vue')
    const wrapper = track(mount(BackgroundJobsStatusBar, { attachTo: document.body, props }))
    await flushPromises()
    return wrapper
  }

  it('压缩中:即使一个后台任务都没有,chip 也为它出场', async () => {
    const { useChatStore } = await import('@/stores/chat')
    useChatStore().setSessionCompacting('s-1', true)

    const wrapper = await mountBar({ sessionId: 's-1' })
    const chip = wrapper.find('button.status-chip')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('Compacting')
    // 没有进度就不带计数。
    expect(chip.text()).not.toMatch(/\d+\/\d+/)

    await chip.trigger('click')
    await flushPromises()
    expect(document.body.querySelector('.compact-row')?.textContent)
      .toContain('Compacting context…')
  })

  it('有分块进度时带 2/5', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const chatStore = useChatStore()
    chatStore.setSessionCompacting('s-1', true)
    chatStore.setSessionCompactProgress('s-1', { chunk: 2, totalChunks: 5 })

    const wrapper = await mountBar({ sessionId: 's-1' })
    expect(wrapper.find('button.status-chip').text()).toContain('2/5')

    await wrapper.find('button.status-chip').trigger('click')
    await flushPromises()
    expect(document.body.querySelector('.compact-row')?.textContent).toContain('2/5')
  })

  it('completed 即隐:没有任务也没在压缩时一个字节都不渲染', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const chatStore = useChatStore()
    chatStore.setSessionCompacting('s-1', true)
    chatStore.setSessionCompactProgress('s-1', { chunk: 2, totalChunks: 5 })

    const wrapper = await mountBar({ sessionId: 's-1' })
    expect(wrapper.find('.status-chip').exists()).toBe(true)

    // completed 的两条清位(ipc-hub 的 case 就是这么做的)。
    chatStore.setSessionCompacting('s-1', false)
    chatStore.setSessionCompactProgress('s-1', null)
    await flushPromises()

    expect(wrapper.find('.status-chip').exists()).toBe(false)
  })

  it('压缩是按会话的:别的会话在压不影响本会话的 chip', async () => {
    const { useChatStore } = await import('@/stores/chat')
    useChatStore().setSessionCompacting('s-other', true)

    const wrapper = await mountBar({ sessionId: 's-1' })
    expect(wrapper.find('.status-chip').exists()).toBe(false)
  })
})

describe('S 状态带 · 目标', () => {
  it('无目标 / 已完成的目标不出 chip', async () => {
    const { default: GoalStatusBar } = await import('../GoalStatusBar.vue')
    const wrapper = track(mount(GoalStatusBar, { attachTo: document.body, props: { sessionId: 's-1' } }))
    await flushPromises()
    expect(wrapper.find('.status-chip').exists()).toBe(false)
  })

  it('chip 是 `◎ <目标名> · <进度>`,浮层里 objective / budget 就地编辑都还在', async () => {
    state.goal = {
      objective: '插件系统 v2',
      status: 'active',
      tokensUsed: 2100,
      tokenBudget: 5000,
      continuationCount: 6,
      errorRetryCount: 0,
    }
    const { default: GoalStatusBar } = await import('../GoalStatusBar.vue')
    const wrapper = track(mount(GoalStatusBar, { attachTo: document.body, props: { sessionId: 's-1' } }))
    await flushPromises()

    const chip = wrapper.find('button.status-chip')
    expect(chip.text()).toContain('插件系统 v2')
    expect(chip.text()).toContain('run 6')

    await chip.trigger('click')
    await flushPromises()

    const flyout = document.body.querySelector('.status-chip-flyout-body')
    expect(flyout?.querySelector('.goal-objective')).not.toBeNull()
    expect(flyout?.textContent).toContain('CAP')
    expect(flyout?.textContent).toContain('Pause')
    expect(flyout?.textContent).toContain('Clear')

    // 就地编辑没降级:点目标名换成输入框。
    const objective = flyout?.querySelector('.goal-objective') as HTMLElement
    objective.click()
    await flushPromises()
    expect(document.body.querySelector('.goal-objective-input')).not.toBeNull()
  })
})

describe('S 状态带 · 电台', () => {
  it('电台没配好就没有 chip', async () => {
    state.settings = { settings: { music: { enabled: false } } }
    const { default: MusicStatusBar } = await import('../composer/MusicStatusBar.vue')
    const wrapper = track(mount(MusicStatusBar, { attachTo: document.body }))
    await flushPromises()
    expect(wrapper.find('.status-chip').exists()).toBe(false)
  })

  it('播放中的 chip 带曲名与脉冲点;悬停展开出整套播放器面板', async () => {
    state.music.nowPlaying = {
      title: '山丘',
      status: 'playing',
      duration: 336,
      queueLength: 3,
      currentIndex: 0,
    }
    const { default: MusicStatusBar } = await import('../composer/MusicStatusBar.vue')
    const wrapper = track(mount(MusicStatusBar, { attachTo: document.body }))
    await flushPromises()

    const chip = wrapper.find('button.status-chip')
    expect(chip.text()).toContain('山丘')
    expect(chip.classes()).toContain('is-playing')
    // 收起时浮层不在
    expect(document.body.querySelector('.music-bar')).toBeNull()

    await chip.trigger('mouseenter')
    await flushPromises()

    const bar = document.body.querySelector('.music-bar')
    expect(bar).not.toBeNull()
    expect(bar?.querySelector('.music-track')).not.toBeNull()
    expect(bar?.querySelector('.music-vol')).not.toBeNull()
    expect(document.body.querySelector('.music-frame-label')?.textContent).toContain('NOW PLAYING')
  })

  it('空闲但电台可用时仍留一枚「电台」chip —— 开台入口没丢', async () => {
    const { default: MusicStatusBar } = await import('../composer/MusicStatusBar.vue')
    const wrapper = track(mount(MusicStatusBar, { attachTo: document.body }))
    await flushPromises()

    const chip = wrapper.find('button.status-chip')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('电台')
    expect(chip.classes()).not.toContain('is-playing')
  })
})

describe('S 状态带 · 装配与退役面', () => {
  const chatPanel = read('components/chat/ChatPanel.vue')

  it('带容器住 composer 列,成员顺序 jobs → goal → music → 插件块', () => {
    const band = chatPanel.slice(chatPanel.indexOf('<div class="status-band">'))
    const order = ['BackgroundJobsStatusBar', 'GoalStatusBar', 'MusicStatusBar', 'UiSlotHost']
    let cursor = 0
    for (const name of order) {
      const at = band.indexOf(`<${name}`)
      expect(at, `${name} 不在带里`).toBeGreaterThan(-1)
      expect(at).toBeGreaterThan(cursor)
      cursor = at
    }
    expect(band).toContain('anchor="chat.status-bar"')
    expect(band).toContain('chip-shell')
  })

  it('空态零高度:带本身没有 padding / min-height,只有非空时补呼吸', () => {
    expect(chatPanel).toContain('.composer-container > .status-band:not(:empty)')
    const bandRule = chatPanel.slice(
      chatPanel.indexOf('.composer-container > .status-band {'),
      chatPanel.indexOf('.composer-container > .status-band::-webkit-scrollbar'),
    )
    expect(bandRule).not.toMatch(/\bpadding:/)
    expect(bandRule).not.toMatch(/min-height:/)
    expect(bandRule).toContain('overflow-x: auto')
  })

  it('电台占位机制与 composer 帧标签的 music 分支已连根拔除', () => {
    const inputBox = read('components/chat/InputBox.vue')
    const musicStore = read('stores/music.ts')

    for (const dead of ['--music-bar-reserve', 'musicBarReserve', 'showsMusicTag', 'musicBarExpanded', 'onMusicLabelEnter', 'musicNowPlayingTitle', 'MusicStatusBar']) {
      expect(inputBox, `InputBox 仍残留 ${dead}`).not.toContain(dead)
    }
    expect(inputBox).not.toContain('composer-frame-label.music')
    expect(inputBox).not.toContain('composer-frame-note')

    expect(chatPanel).not.toContain('goalMusicOffset')
    expect(chatPanel).not.toContain('--goal-music-offset')

    // store 侧的高度/固定汇报通道一并退役(没有消费者了)。
    expect(musicStore).not.toContain('const barHeight')
    expect(musicStore).not.toContain('const barPinned')
  })
})

describe('插件块 · chip 壳', () => {
  it('chipShell 只换外壳:块还是 UiSlotBlock,只是穿了静态 chip', async () => {
    vi.resetModules()
    vi.doMock('@/platform', () => ({
      platformApi: {
        environment: 'electron',
        onPluginNotification: () => () => {},
      },
    }))
    // P4 终态批 C2:统一请求通道走 `plugins` 域,客户端在 `@/platform/plugins-client`。
    vi.doMock('@/platform/plugins-client', () => ({
      pluginsApi: {
        pluginRequest: vi.fn(async () => ({
          success: true,
          result: { version: 2, body: { type: 'row', children: [{ type: 'badge', text: '5.2 tok/s' }] } },
        })),
      },
    }))
    const { default: UiSlotHost } = await import('@/components/plugins/UiSlotHost.vue')
    const { setPluginUiSlots } = await import('@/workspace/ui-anchor-registry')
    setPluginUiSlots([{
      pluginId: 'tps-meter',
      pluginName: 'TPS meter',
      anchor: 'chat.status-bar',
      slotId: 'main',
      label: 'tps',
      loaded: true,
      unsupported: false,
    }])

    const wrapper = track(mount(UiSlotHost, {
      attachTo: document.body,
      props: { anchor: 'chat.status-bar', chipShell: true, sessionId: 's-1' },
    }))
    await flushPromises()

    expect(wrapper.find('.ui-slot-host').attributes('data-chip-shell')).toBe('true')
    const chip = wrapper.find('.status-chip')
    expect(chip.exists()).toBe(true)
    expect(chip.classes()).toContain('is-static')
    expect(chip.element.querySelector('.ui-slot-block')).not.toBeNull()
    expect(wrapper.text()).toContain('5.2 tok/s')

    setPluginUiSlots([])
    await flushPromises()
    vi.doUnmock('@/platform')
    vi.doUnmock('@/platform/plugins-client')
    vi.resetModules()
  })
})
