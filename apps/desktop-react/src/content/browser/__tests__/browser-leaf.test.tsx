import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { configureBrowserPort } from '../../../data/browser-port'
import type { BrowserPort } from '../../../data/browser-port'
import { browserTabsQuery, resetBrowserSource } from '../../../data/browser-source'
import { focusTree } from '../../../focus/registry'
import { resetNativeViewKeymapDownlink } from '../../native-view/keymap-downlink'
import { BrowserLeaf, browserTabTitle } from '../BrowserLeaf'

/**
 * **叶那张 ② 表的守卫**:三档降级各画各的(没有宿主 / 还不知道 / 找不到),
 * 加上活标题那三档(页标题 → 主机名 → 空)。
 *
 * 这里**不**量导航按下去有没有发对请求 —— 那是 `browser-source.test.ts` 的活
 * (表在那儿),也不量真机上视图有没有画对(那是 `gate:browser`)。
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

function portWith(over: Partial<BrowserPort> = {}): BrowserPort {
  return {
    ready: () => Promise.resolve(undefined),
    read: () => Promise.resolve({ kind: 'ok', value: { tabs: [{ ...TAB }], activeId: 't1' } }),
    do: () => Promise.resolve({ kind: 'ok', text: '' }),
    onResourceEvent: () => () => undefined,
    nativeView: { send: () => undefined, on: () => () => undefined },
    ...over,
  }
}

beforeEach(() => {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = SilentResizeObserver
  resetBrowserSource()
  resetNativeViewKeymapDownlink()
})

afterEach(() => {
  resetBrowserSource()
  resetNativeViewKeymapDownlink()
  configureBrowserPort(undefined)
  focusTree.reset()
})

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

describe('三档降级', () => {
  it('没有宿主(`--mode web`)→ 一句话,**不画地址栏**', async () => {
    configureBrowserPort(portWith({ nativeView: undefined }))
    render(<BrowserLeaf id="t1" />)
    await settle()
    expect(screen.getByTestId('browser-leaf').dataset.browserState).toBe('no-host')
    expect(screen.queryByTestId('browser-address')).toBeNull()
  })

  it('读数还没到 → 地址栏画着、导航钮禁用、**不清屏不画骨架**', async () => {
    // `read` 永不 resolve = 「还不知道」那一档。
    configureBrowserPort(portWith({ read: () => new Promise(() => {}) }))
    render(<BrowserLeaf id="t1" />)
    await settle()
    expect(screen.getByTestId('browser-leaf').dataset.browserState).toBe('unknown')
    expect(screen.getByTestId('browser-address')).toBeTruthy()
    expect(screen.getByTestId('browser-back')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('browser-reload')).toHaveProperty('disabled', true)
  })

  it('表到了、里面没有这一格 → 「这一页找不到了」+ 一颗关掉', async () => {
    configureBrowserPort(portWith())
    render(<BrowserLeaf id="ghost" />)
    await settle()
    expect(screen.getByTestId('browser-leaf').dataset.browserState).toBe('missing')
    expect(screen.getByTestId('browser-gone-close')).toBeTruthy()
  })

  it('正常那一档:地址栏显示真地址', async () => {
    configureBrowserPort(portWith())
    render(<BrowserLeaf id="t1" />)
    await settle()
    expect(screen.getByTestId('browser-leaf').dataset.browserState).toBe('live')
    expect((screen.getByTestId('browser-address') as HTMLInputElement).value).toBe(TAB.url)
  })

  it('加载中:状态位翻成 loading,那条 1px 描线亮着', async () => {
    configureBrowserPort(
      portWith({
        read: () =>
          Promise.resolve({
            kind: 'ok',
            value: { tabs: [{ ...TAB, loading: true }], activeId: 't1' },
          }),
      }),
    )
    render(<BrowserLeaf id="t1" />)
    await settle()
    expect(screen.getByTestId('browser-leaf').dataset.browserState).toBe('loading')
    expect(screen.getByTestId('browser-progress').hasAttribute('data-on')).toBe(true)
  })

  it('出错:后端那句原话原样上屏(不发明文案)', async () => {
    configureBrowserPort(
      portWith({
        read: () =>
          Promise.resolve({
            kind: 'ok',
            value: { tabs: [{ ...TAB, error: 'ERR_NAME_NOT_RESOLVED' }], activeId: 't1' },
          }),
      }),
    )
    render(<BrowserLeaf id="t1" />)
    await settle()
    expect(screen.getByTestId('browser-error').textContent).toBe('ERR_NAME_NOT_RESOLVED')
  })
})

describe('活标题三档', () => {
  it('页标题 → 主机名 → 空(空那一档交给字典里那句静态的)', () => {
    expect(browserTabTitle({ ...TAB })).toBe('Example')
    expect(browserTabTitle({ ...TAB, title: '' })).toBe('example.test')
    expect(browserTabTitle({ ...TAB, title: '', url: '' })).toBe('')
    expect(browserTabTitle(undefined)).toBe('')
  })
})

describe('地址栏草稿', () => {
  it('后端推来新地址时**不冲掉**人正在打的那一句', async () => {
    configureBrowserPort(portWith())
    render(<BrowserLeaf id="t1" />)
    await settle()
    const input = screen.getByTestId('browser-address') as HTMLInputElement
    act(() => {
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'half-typed' } })
    })
    // 后端那一格换了地址(等价于一条 `navigated` 事实落地)。
    act(() => {
      browserTabsQuery.patch((prev) =>
        prev ? { ...prev, tabs: [{ ...prev.tabs[0], url: 'https://elsewhere.test' }] } : prev,
      )
    })
    await settle()
    expect((screen.getByTestId('browser-address') as HTMLInputElement).value).toBe('half-typed')
  })
})
