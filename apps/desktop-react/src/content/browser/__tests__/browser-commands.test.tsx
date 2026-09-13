import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { configureBrowserPort } from '../../../data/browser-port'
import type { BrowserPort } from '../../../data/browser-port'
import { resetBrowserSource } from '../../../data/browser-source'
import { useFocusDispatch } from '../../../focus/dispatch'
import { focusTree } from '../../../focus/registry'
import { useKeymapStore } from '../../../keymap/store'
import { initialKeymapState } from '../../../keymap/transitions'
import { pinMacUserAgent } from '../../../test/mac-ua'
import { resetNativeViewKeymapDownlink } from '../../native-view/keymap-downlink'
import { BrowserLeaf } from '../BrowserLeaf'

/**
 * **浏览器叶答的那六条内容族命令**(K3,方案
 * `apps/desktop-react/docs/keymap-responder-2026-09.md` §5 K3)。
 *
 * 量的是**整条路**,不是一张表:真挂一个 `useFocusDispatch`(全壳那唯一的派发器)、
 * 真在 window 上按一下键 → 活动路径由深到浅 → 叶那一格 `commands[id]` → 一只
 * mutation → `resources.do`。所以它同时钉住了三件会各自坏掉的事:命令表上那几个
 * 出厂键、`BROWSER_ANSWERS` 上那几行声明、叶实例交出来的那几只处理器。
 *
 * **没有历史那两格**(`nav.back` / `nav.forward`)在这里也量得到,而那正是实例
 * 这一头与声明那一头的区别:声明说「这种面**可能**答」,实例说「此刻答不答得出」。
 */

const TAB = {
  id: 't1',
  url: 'https://example.test/a',
  title: 'Example',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  zoomLevel: 0,
  active: true,
  profile: 'default',
}

class SilentResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

type DoCall = { ref: string; op: string; params?: Record<string, unknown> }

function portWith(tab: Record<string, unknown>, calls: DoCall[]): BrowserPort {
  return {
    ready: () => Promise.resolve(undefined),
    read: () => Promise.resolve({ kind: 'ok', value: { tabs: [tab], activeId: 't1' } }),
    do: (ref: string, op: string, params?: Record<string, unknown>) => {
      calls.push({ ref, op, ...(params ? { params } : {}) })
      return Promise.resolve({ kind: 'ok', text: '' })
    },
    onResourceEvent: () => () => undefined,
    nativeView: { send: () => undefined, on: () => () => undefined },
  } as unknown as BrowserPort
}

function Harness() {
  useFocusDispatch({ runCommand: vi.fn() })
  return <BrowserLeaf id="t1" />
}

async function mount(over: Record<string, unknown> = {}): Promise<DoCall[]> {
  const calls: DoCall[] = []
  configureBrowserPort(portWith({ ...TAB, ...over }, calls))
  render(<Harness />)
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  // 叶要在活动路径上,键才轮得到它(与真机上「键盘在这一页里」同一个前提)。
  focusTree.activateScope('browser', { owner: 'browser:t1', reason: 'open' })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  calls.length = 0
  return calls
}

/** 按一下,并把那一发 `resources.do` 等出来(mutation 是异步的)。 */
async function press(init: KeyboardEventInit): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(window, { metaKey: true, ...init })
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

beforeEach(() => {
  pinMacUserAgent()
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = SilentResizeObserver
  useKeymapStore.setState({ ...initialKeymapState })
  resetBrowserSource()
  resetNativeViewKeymapDownlink()
})

afterEach(() => {
  resetBrowserSource()
  resetNativeViewKeymapDownlink()
  configureBrowserPort(undefined)
  focusTree.reset()
  document.body.innerHTML = ''
})

/** 这一格叶此刻交出来的那几条命令(注册表里那一格 `commands` 的键)。 */
function leafCommands(): string[] {
  const dump = focusTree.dump()
  const node = dump.nodes.find((n) => n.scope === 'browser')
  return (node?.keys ?? []).slice().sort()
}

describe('浏览器叶的 `commands`:有历史 / 没历史两档', () => {
  /**
   * **没有历史 = 不交那两格处理器**,派发器据此穿过去 —— 于是在一格刚开出来的
   * 标签里按 ⌘[ 什么都不发生,而不是「响了一下但没动」。
   *
   * 反证:把 `BrowserLeaf` 里那两句 `...(row?.canGoBack ? … : {})` 换成无条件交
   * → 这一条当场红(表里多出 `nav.back` / `nav.forward`)。
   */
  it('没历史:`nav.back` / `nav.forward` 一格都不交', async () => {
    await mount()
    expect(leafCommands()).toEqual([
      'browser.address',
      'view.find',
      'view.reload',
      'view.zoomIn',
      'view.zoomOut',
      'view.zoomReset',
    ])
  })

  it('有历史:那两格才交出来', async () => {
    await mount({ canGoBack: true, canGoForward: true })
    expect(leafCommands()).toEqual([
      'browser.address',
      'nav.back',
      'nav.forward',
      'view.find',
      'view.reload',
      'view.zoomIn',
      'view.zoomOut',
      'view.zoomReset',
    ])
  })

  it('只有后退可走时只交后退(两格各按各的旗,不是一对)', async () => {
    await mount({ canGoBack: true })
    expect(leafCommands()).toContain('nav.back')
    expect(leafCommands()).not.toContain('nav.forward')
  })
})

describe('按下去真的打到 `resources.do` 上', () => {
  it('⌘R → reload', async () => {
    const calls = await mount()
    await press({ key: 'r' })
    expect(calls).toEqual([{ ref: 'browser:t1', op: 'reload', params: {} }])
  })

  it('⌘[ / ⌘] → back / forward(有历史那一档)', async () => {
    const calls = await mount({ canGoBack: true, canGoForward: true })
    await press({ key: '[' })
    await press({ key: ']' })
    expect(calls.map((c) => c.op)).toEqual(['back', 'forward'])
    expect(calls.every((c) => c.ref === 'browser:t1')).toBe(true)
  })

  it('没历史时 ⌘[ 一发请求都不发(派发器穿过去)', async () => {
    const calls = await mount()
    await press({ key: '[' })
    expect(calls).toEqual([])
  })

  /**
   * 三条缩放各带各的方向。⌘= 与 ⌘⇧+ 是**同一条命令的两个键面**(同一枚物理键
   * 按不按 ⇧,Chromium 报的 `key` 不同),所以两下都该落成 `level: 'in'`。
   */
  it('⌘= / ⌘⇧+ / ⌘− / ⌘0 → zoom in / in / out / reset', async () => {
    const calls = await mount()
    await press({ key: '=' })
    await press({ key: '+', shiftKey: true })
    await press({ key: '-' })
    await press({ key: '0' })
    expect(calls).toEqual([
      { ref: 'browser:t1', op: 'zoom', params: { level: 'in' } },
      { ref: 'browser:t1', op: 'zoom', params: { level: 'in' } },
      { ref: 'browser:t1', op: 'zoom', params: { level: 'out' } },
      { ref: 'browser:t1', op: 'zoom', params: { level: 'reset' } },
    ])
  })
})
