import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { configureBrowserPort } from '../../../data/browser-port'
import type { BrowserPort } from '../../../data/browser-port'
import type { NativeViewPush, NativeViewRequest } from '../../../data/browser-port'
import { onBrowserFact, resetBrowserSource } from '../../../data/browser-source'
import {
  browserFindOf,
  openBrowserFind,
  resetBrowserFind,
} from '../../../data/browser-find'
import { browserNoticesOf, resetBrowserNotices } from '../../../data/browser-notices'
import { FOCUS_SCOPES } from '../../../focus/scopes'
import { focusTree } from '../../../focus/registry'
import { resetNativeViewKeymapDownlink } from '../../native-view/keymap-downlink'
import { BrowserLeaf } from '../BrowserLeaf'

/**
 * **B3-a 壳半边的守卫**:查找行四态、权限卡两键、下载行三态。
 *
 * 这里不量真机上视图有没有真的找到那个词(那是 `gate:browser` ⑫⑬⑭),也不量主
 * 进程那一侧怎么折(那是 `electron/browser/__tests__/browser-b3a.test.ts`)——
 * 这一份量的是**壳这一侧的形**:屏幕上画了什么、按下去发出了什么。
 */

const TAB = {
  id: 't1',
  url: 'https://example.test/a',
  title: 'Example',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  active: true,
  profile: 'default',
}

class SilentResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

interface Harness {
  port: BrowserPort
  sent: NativeViewRequest[]
  did: { ref: string; op: string; params?: Record<string, unknown> }[]
  push: (message: NativeViewPush) => void
}

function harness(over: Partial<BrowserPort> = {}): Harness {
  const sent: NativeViewRequest[] = []
  const did: { ref: string; op: string; params?: Record<string, unknown> }[] = []
  const handlers = new Set<(message: NativeViewPush) => void>()
  const port: BrowserPort = {
    ready: () => Promise.resolve(undefined),
    read: () => Promise.resolve({ kind: 'ok', value: { tabs: [{ ...TAB }], activeId: 't1' } }),
    do: (ref, op, params) => {
      did.push({ ref, op, ...(params ? { params } : {}) })
      return Promise.resolve({ kind: 'ok', text: '' })
    },
    onResourceEvent: () => () => undefined,
    nativeView: {
      send: (message) => { sent.push(message) },
      on: (handler) => {
        handlers.add(handler)
        return () => { handlers.delete(handler) }
      },
    },
    ...over,
  }
  configureBrowserPort(port)
  return {
    port,
    sent,
    did,
    push: (message) => { for (const handler of [...handlers]) handler(message) },
  }
}

beforeEach(() => {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = SilentResizeObserver
  resetBrowserSource()
  resetNativeViewKeymapDownlink()
})

afterEach(() => {
  resetBrowserSource()
  resetBrowserFind()
  resetBrowserNotices()
  resetNativeViewKeymapDownlink()
  configureBrowserPort(undefined)
  focusTree.reset()
})

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

// ── 查找行 ───────────────────────────────────────────────────────────────

/*
 * 读数三档那组纯函数断言**不在这里了**(B3-b):判据与终端查找行合成了一只
 * (`content/find-readout.ts`),断言跟着搬去 `content/__tests__/find-readout.test.ts`。
 * 下面「开有命中 / 开零命中」两条留着 —— 它们量的是这块屏幕消费了它。
 */

describe('查找行四态', () => {
  it('关着的时候整行不画', async () => {
    harness()
    render(<BrowserLeaf id="t1" />)
    await settle()
    expect(screen.queryByTestId('browser-find')).toBeNull()
  })

  it('开 · 无词:上下两颗钮禁用、读数不画;打字 → 发一发 find', async () => {
    const h = harness()
    render(<BrowserLeaf id="t1" />)
    await settle()
    await act(async () => { openBrowserFind('t1') })
    expect(screen.getByTestId('browser-find')).toBeTruthy()
    expect(screen.getByTestId('browser-find-prev')).toHaveProperty('disabled', true)
    expect(screen.queryByTestId('browser-find-count')).toBeNull()

    fireEvent.change(screen.getByTestId('browser-find').querySelector('input')!, {
      target: { value: 'abc' },
    })
    expect(h.sent.at(-1)).toEqual({ verb: 'find', viewId: 't1', text: 'abc', forward: true })
  })

  it('开 · 有命中 / 零命中:读数按推送走,**只认开着的那一格**', async () => {
    const h = harness()
    render(<BrowserLeaf id="t1" />)
    await settle()
    await act(async () => { openBrowserFind('t1') })
    fireEvent.change(screen.getByTestId('browser-find').querySelector('input')!, {
      target: { value: 'abc' },
    })
    await act(async () => { h.push({ kind: 'find', viewId: 't1', active: 3, total: 17 }) })
    expect(screen.getByTestId('browser-find-count').textContent).toBe('3/17')
    await act(async () => { h.push({ kind: 'find', viewId: 't1', active: 0, total: 0 }) })
    expect(screen.getByTestId('browser-find-count').textContent).toBe('0')
  })

  it('↵ / ⇧↵ 是行内结构键;× 收起 → 发 findStop,读数归零、**词留着**', async () => {
    const h = harness()
    render(<BrowserLeaf id="t1" />)
    await settle()
    await act(async () => { openBrowserFind('t1') })
    const input = screen.getByTestId('browser-find').querySelector('input')!
    fireEvent.change(input, { target: { value: 'abc' } })
    h.sent.length = 0
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(h.sent.map((m) => (m as { forward: boolean }).forward)).toEqual([true, false])

    await act(async () => { fireEvent.click(screen.getByTestId('browser-find-close')) })
    // 收起 = 先 `findStop`、再把键盘还给占位格(那一句是作用域内部的移动,
    // 于是占位格的 `onFocus` 又发一发 `focus`)—— 所以查的是这一段里有没有它。
    expect(h.sent).toContainEqual({ verb: 'findStop', viewId: 't1' })
    expect(screen.queryByTestId('browser-find')).toBeNull()
    expect(browserFindOf('t1')).toMatchObject({ open: false, query: 'abc', active: 0, total: 0 })
  })

  it('Esc 在输入框里 = 收起这一行,**不冒泡**(不然同一下既收行又退一层)', async () => {
    const h = harness()
    render(<BrowserLeaf id="t1" />)
    await settle()
    await act(async () => { openBrowserFind('t1') })
    const input = screen.getByTestId('browser-find').querySelector('input')!
    const outer = vi.fn()
    window.addEventListener('keydown', outer, true)
    await act(async () => { fireEvent.keyDown(input, { key: 'Escape' }) })
    window.removeEventListener('keydown', outer, true)
    expect(h.sent).toContainEqual({ verb: 'findStop', viewId: 't1' })
    expect(screen.queryByTestId('browser-find')).toBeNull()
  })

  it('空掉输入框 = 清高亮,**不是**「找一个空串」', async () => {
    const h = harness()
    render(<BrowserLeaf id="t1" />)
    await settle()
    await act(async () => { openBrowserFind('t1') })
    const input = screen.getByTestId('browser-find').querySelector('input')!
    fireEvent.change(input, { target: { value: 'abc' } })
    h.sent.length = 0
    fireEvent.change(input, { target: { value: '' } })
    expect(h.sent).toEqual([{ verb: 'findStop', viewId: 't1' }])
  })

  it('⌘F 在 `browser` 作用域的局部键表里(拆掉它 → 这一条与 scopes 那两条一起红)', () => {
    expect(FOCUS_SCOPES.browser.keys?.length).toBe(2)
    expect(FOCUS_SCOPES.browser.keys?.some((k) => k.action === 'find')).toBe(true)
  })
})

// ── 网页权限卡 ───────────────────────────────────────────────────────────

function ask(over: Record<string, unknown> = {}) {
  onBrowserFact({
    ref: 'browser:t1',
    event: 'permissionRequested',
    payload: { tabId: 't1', requestId: 'p1', permission: 'geolocation', origin: 'https://a.test', ...over },
  })
}

describe('网页权限卡', () => {
  it('一问到了 → 一张卡;两颗键各发一发 `respondPermission`', async () => {
    const h = harness()
    render(<BrowserLeaf id="t1" />)
    await settle()
    await act(async () => { ask() })
    const card = screen.getByTestId('browser-permission-card')
    expect(card.textContent).toContain('https://a.test')

    await act(async () => { fireEvent.click(screen.getByTestId('browser-permission-allow')) })
    expect(h.did.at(-1)).toEqual({
      ref: 'browser:t1',
      op: 'respondPermission',
      params: { requestId: 'p1', allow: true },
    })

    await act(async () => { fireEvent.click(screen.getByTestId('browser-permission-reject')) })
    expect(h.did.at(-1)).toEqual({
      ref: 'browser:t1',
      op: 'respondPermission',
      params: { requestId: 'p1', allow: false },
    })
  })

  it('**卡由 `permissionResolved` 撤,不由点下去那一下撤**(超时 / 另一扇窗答掉同一条路)', async () => {
    harness()
    render(<BrowserLeaf id="t1" />)
    await settle()
    await act(async () => { ask() })
    await act(async () => { fireEvent.click(screen.getByTestId('browser-permission-allow')) })
    // 点完卡还在 —— 等后端认下来。
    expect(screen.getByTestId('browser-permission-card')).toBeTruthy()
    await act(async () => {
      onBrowserFact({
        ref: 'browser:t1',
        event: 'permissionResolved',
        payload: { tabId: 't1', requestId: 'p1', allow: false, reason: 'timeout' },
      })
    })
    expect(screen.queryByTestId('browser-permission-card')).toBeNull()
  })

  it('同一 tab 多问**排队**:只画队头', async () => {
    harness()
    render(<BrowserLeaf id="t1" />)
    await settle()
    await act(async () => {
      ask()
      ask({ requestId: 'p2', permission: 'notifications' })
      // 同一个 requestId 再来一遍不进第二次(SSE 是广播)。
      ask()
    })
    expect(browserNoticesOf('t1').asks.map((row) => row.requestId)).toEqual(['p1', 'p2'])
    expect(screen.getAllByTestId('browser-permission-card')).toHaveLength(1)
    expect(screen.getByTestId('browser-permission-card').dataset.webPermission).toBe('p1')
  })

  it('来源说不出 → 标题退成「这个网页」,那一格不画;认不出的能力也念得出一句话', async () => {
    harness()
    render(<BrowserLeaf id="t1" />)
    await settle()
    await act(async () => { ask({ origin: '', permission: 'weird-future-thing' }) })
    const card = screen.getByTestId('browser-permission-card')
    expect(card.textContent).not.toContain('undefined')
    expect(card.querySelector('[class*="resource"]')).toBeNull()
  })
})

// ── 下载行 ───────────────────────────────────────────────────────────────

function download(state: 'started' | 'done' | 'failed', over: Record<string, unknown> = {}) {
  onBrowserFact({
    ref: 'browser:t1',
    event: 'download',
    payload: { tabId: 't1', filename: 'a.zip', state, path: '/d/a.zip', ...over },
  })
}

describe('下载行三态', () => {
  it('started:一行字、**没有 spinner**、没有「显示」、没有 ×', async () => {
    harness()
    render(<BrowserLeaf id="t1" />)
    await settle()
    await act(async () => { download('started') })
    const row = screen.getByTestId('browser-download')
    expect(row.dataset.downloadState).toBe('started')
    expect(row.textContent).toContain('a.zip')
    expect(screen.queryByTestId('browser-download-reveal')).toBeNull()
    expect(screen.queryByTestId('browser-download-dismiss')).toBeNull()
  })

  it('done:「显示」走 `dir:` 的 reveal(与 AI 同一条路);× 只收读数', async () => {
    const h = harness()
    render(<BrowserLeaf id="t1" />)
    await settle()
    await act(async () => { download('started') })
    await act(async () => { download('done') })
    expect(screen.getByTestId('browser-download').dataset.downloadState).toBe('done')
    await act(async () => { fireEvent.click(screen.getByTestId('browser-download-reveal')) })
    expect(h.did.at(-1)).toEqual({ ref: 'dir:/d/a.zip', op: 'reveal', params: {} })

    await act(async () => { fireEvent.click(screen.getByTestId('browser-download-dismiss')) })
    expect(screen.queryByTestId('browser-download')).toBeNull()
  })

  it('failed:一句话 + ×,没有「显示」(那份文件不在那儿)', async () => {
    harness()
    render(<BrowserLeaf id="t1" />)
    await settle()
    await act(async () => { download('failed') })
    expect(screen.getByTestId('browser-download').dataset.downloadState).toBe('failed')
    expect(screen.queryByTestId('browser-download-reveal')).toBeNull()
    expect(screen.getByTestId('browser-download-dismiss')).toBeTruthy()
  })

  it('**同一条下载不换行身份**(started → done 是就地换字,不是两行)', async () => {
    harness()
    render(<BrowserLeaf id="t1" />)
    await settle()
    await act(async () => { download('started') })
    const before = screen.getByTestId('browser-download')
    await act(async () => { download('done') })
    expect(screen.getByTestId('browser-download')).toBe(before)
    expect(browserNoticesOf('t1').downloads).toHaveLength(1)
  })

  it('两条下载:画的是**最近变动的那一条**', async () => {
    harness()
    render(<BrowserLeaf id="t1" />)
    await settle()
    await act(async () => {
      download('started')
      download('started', { filename: 'b.zip', path: '/d/b.zip' })
      download('done')
    })
    expect(screen.getAllByTestId('browser-download')).toHaveLength(1)
    expect(screen.getByTestId('browser-download').textContent).toContain('a.zip')
  })

  it('这一格 tab 关掉 → 檐下那两件与查找状态一起扔掉', async () => {
    harness()
    render(<BrowserLeaf id="t1" />)
    await settle()
    await act(async () => {
      ask()
      download('done')
      openBrowserFind('t1')
    })
    await act(async () => {
      onBrowserFact({ ref: 'browser:t1', event: 'closed', payload: { id: 't1' } })
    })
    // `closed` 也标脏那张 tab 表 —— 等那一发后台补拉落定,免得它在 act 外面改状态。
    await settle()
    expect(browserNoticesOf('t1')).toEqual({ asks: [], downloads: [] })
    expect(browserFindOf('t1').open).toBe(false)
  })
})
