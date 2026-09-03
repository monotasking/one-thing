// @vitest-environment happy-dom
/**
 * 终端 refit 的"拖拽中"闸门(2026-08-25 拖拽掉帧根治)。
 *
 * 钉的是:外壳分隔条拖拽期间 ResizeObserver 再怎么响,`fitTerminal` 一次都
 * 不许被调;松手后恰好补一次。xterm 的 fit 会整本重排 scrollback 并把新列数
 * 同步给 PTY(SIGWINCH → shell 重绘回流),逐帧做就是拖拽掉帧的大头。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import TerminalView from '../TerminalView.vue'
import { resetShellLayoutRuntime, setShellResizing } from '@/composables/useShellLayout'
import { fitTerminal } from '@/services/terminal-registry'

vi.mock('@/services/terminal-registry', () => ({
  ensureAttached: vi.fn(async () => {}),
  fitTerminal: vi.fn(),
  focusTerminal: vi.fn(),
  detachView: vi.fn(),
}))

vi.mock('@/stores/terminals', () => ({
  useTerminalsStore: () => ({
    ensureLoaded: vi.fn(async () => {}),
    terminals: [],
    restartTerminal: vi.fn(async () => 'restarted'),
  }),
}))

/* rAF 手动泵:同步执行会让 scheduleFit 的 fitFrame 记账错位,必须先排队后冲刷。 */
let rafQueue: FrameRequestCallback[] = []
function flushRaf(): void {
  const queue = rafQueue
  rafQueue = []
  for (const callback of queue) callback(0)
}

/* ResizeObserver 手动触发桩:测试里代表"拖拽把容器改宽了一帧"。 */
const observers: Array<() => void> = []

beforeEach(() => {
  rafQueue = []
  observers.length = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    rafQueue.push(callback)
    return rafQueue.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) {
      observers.push(callback)
    }

    observe(): void {}
    disconnect(): void {}
  })
})

afterEach(() => {
  resetShellLayoutRuntime()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

async function mountView() {
  const wrapper = mount(TerminalView, { props: { terminalId: 't1' } })
  // onMounted 里的两个 await(ensureLoaded / ensureAttached)
  await nextTick()
  await nextTick()
  flushRaf()
  vi.mocked(fitTerminal).mockClear()
  return wrapper
}

describe('TerminalView 拖拽闸门', () => {
  it('拖拽中 ResizeObserver 连响多帧,fit 一次不调;松手恰好补一次', async () => {
    const wrapper = await mountView()

    setShellResizing(true)
    await nextTick()
    for (let frame = 0; frame < 5; frame++) {
      observers.forEach(fire => fire())
      flushRaf()
    }
    expect(fitTerminal).not.toHaveBeenCalled()

    setShellResizing(false)
    await nextTick()
    flushRaf()
    expect(fitTerminal).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })

  it('没拖拽时 ResizeObserver 响一声就 fit 一次(既有行为不回归)', async () => {
    const wrapper = await mountView()

    observers.forEach(fire => fire())
    flushRaf()
    expect(fitTerminal).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })

  it('拖拽期间没有尺寸变化,松手也不多补', async () => {
    const wrapper = await mountView()

    setShellResizing(true)
    await nextTick()
    setShellResizing(false)
    await nextTick()
    flushRaf()
    expect(fitTerminal).not.toHaveBeenCalled()

    wrapper.unmount()
  })
})
