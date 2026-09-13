import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureBrowserPort } from '../browser-port'
import type { BrowserPort, BrowserResourceEvent } from '../browser-port'
import {
  BROWSER_COLLECTION_REF,
  browserOps,
  browserTabRef,
  browserTabsQuery,
  onBrowserFact,
  openBrowserTab,
  readBrowserPage,
  resetBrowserSource,
  type BrowserTabsView,
} from '../browser-source'

/**
 * **数据层那两张表的守卫**(B2)。
 *
 * 这只文件不量「浏览器能不能用」(那是 `gate:browser` 的活),它量的是壳这一侧
 * 那两条纪律:
 *  · **事实 → 标脏**那张表(四条事实各自重问哪一条读数,表外的事实当没看见);
 *  · **做法 → 就地更新**(按了后退,加载条当场亮;失败要退回去 —— 「屏幕上不许
 *    留一张后端没认下的牌」)。
 */

const TAB = {
  id: 't1',
  url: 'https://example.test/a',
  title: 'A',
  loading: false,
  canGoBack: true,
  canGoForward: false,
  zoomLevel: 0,
  active: true,
  profile: 'default',
}

function table(over: Partial<BrowserTabsView> = {}): BrowserTabsView {
  return { tabs: [{ ...TAB }], activeId: 't1', ...over }
}

interface Fake extends BrowserPort {
  reads: Array<{ ref: string; name: string; query?: Record<string, unknown> }>
  dos: Array<{ ref: string; op: string; params?: Record<string, unknown> }>
  nextTable: BrowserTabsView
  outcome: Awaited<ReturnType<BrowserPort['do']>>
  facts: Array<(event: BrowserResourceEvent) => void>
}

function fakePort(): Fake {
  const port: Fake = {
    reads: [],
    dos: [],
    nextTable: table(),
    outcome: { kind: 'ok', text: 'done' },
    facts: [],
    ready: () => Promise.resolve(undefined),
    read: (ref, name, query) => {
      port.reads.push({ ref, name, ...(query ? { query } : {}) })
      if (name === 'page') {
        return Promise.resolve({ kind: 'ok', value: { title: 'A', url: TAB.url, text: 'body' } })
      }
      return Promise.resolve({ kind: 'ok', value: port.nextTable })
    },
    do: (ref, op, params) => {
      port.dos.push({ ref, op, ...(params ? { params } : {}) })
      return Promise.resolve(port.outcome)
    },
    onResourceEvent: (_prefix, callback) => {
      port.facts.push(callback)
      return () => {
        port.facts = port.facts.filter((cb) => cb !== callback)
      }
    },
    nativeView: undefined,
  }
  return port
}

let port: Fake

beforeEach(() => {
  resetBrowserSource()
  port = fakePort()
  configureBrowserPort(port)
})

afterEach(() => {
  resetBrowserSource()
  configureBrowserPort(undefined)
})

describe('地址:命名空间级那两条走保留坐标', () => {
  it('`tabs` 读在 `browser:@all` 上 —— RPC 的 ref 是必填串,而 parseRef 不收空 path', async () => {
    await browserTabsQuery.ensure()
    expect(port.reads).toEqual([{ ref: BROWSER_COLLECTION_REF, name: 'tabs' }])
    expect(BROWSER_COLLECTION_REF).toBe('browser:@all')
  })

  it('`open` 也打在保留坐标上;其余六条打在那一格 tab 上', async () => {
    await browserOps.open.run({ url: 'https://x.test' })
    await browserOps.back.run({ tabId: 't1' })
    expect(port.dos[0]).toEqual({
      ref: BROWSER_COLLECTION_REF,
      op: 'open',
      params: { url: 'https://x.test' },
    })
    expect(port.dos[1]).toEqual({ ref: browserTabRef('t1'), op: 'back', params: {} })
  })
})

describe('事实 → 标脏', () => {
  it('四条事实各自把 tabs 标脏;表外的事实当没看见', async () => {
    await browserTabsQuery.ensure()
    const spy = vi.spyOn(browserTabsQuery, 'invalidate')
    for (const event of ['opened', 'closed', 'navigated', 'loading']) {
      onBrowserFact({ ref: 'browser:t1', event, payload: {} })
    }
    expect(spy).toHaveBeenCalledTimes(4)
    // **表外的一条**:后端哪天多发一种事实,这里不该"保险起见刷一遍"。
    onBrowserFact({ ref: 'browser:t1', event: 'somethingElse', payload: {} })
    expect(spy).toHaveBeenCalledTimes(4)
    spy.mockRestore()
  })
})

describe('做法:就地更新 + 失败回滚', () => {
  it('按了后退,加载条当场亮(不等后端那条 loading 绕回来)', async () => {
    await browserTabsQuery.ensure()
    expect(browserTabsQuery.get().data?.tabs[0].loading).toBe(false)
    let seen: boolean | undefined
    port.do = () => {
      seen = browserTabsQuery.get().data?.tabs[0].loading
      return Promise.resolve({ kind: 'ok', text: 'ok' })
    }
    await browserOps.back.run({ tabId: 't1' })
    expect(seen).toBe(true)
  })

  it('被拒绝就退回去 —— 屏幕上不许留一张后端没认下的牌', async () => {
    await browserTabsQuery.ensure()
    port.outcome = { kind: 'denied', reason: '不准去那儿' }
    await browserOps.navigate.run({ tabId: 't1', url: 'https://blocked.test' })
    expect(browserTabsQuery.get().data?.tabs[0].url).toBe(TAB.url)
    expect(browserTabsQuery.get().data?.tabs[0].loading).toBe(false)
    // 后端那句原话原样交给屏幕(不发明文案)。
    expect(browserOps.navigate.get().error).toBe('不准去那儿')
  })

  it('`activate` 就地改活动格', async () => {
    port.nextTable = { tabs: [{ ...TAB, active: true }, { ...TAB, id: 't2', active: false }], activeId: 't1' }
    await browserTabsQuery.ensure()
    let seen: string | undefined
    port.do = () => {
      seen = browserTabsQuery.get().data?.activeId
      return Promise.resolve({ kind: 'ok', text: 'ok' })
    }
    await browserOps.activate.run({ tabId: 't2' })
    expect(seen).toBe('t2')
  })

  it('`close` 就地把那一行摘掉', async () => {
    await browserTabsQuery.ensure()
    let seen: number | undefined
    port.do = () => {
      seen = browserTabsQuery.get().data?.tabs.length
      return Promise.resolve({ kind: 'ok', text: 'ok' })
    }
    await browserOps.close.run({ tabId: 't1' })
    expect(seen).toBe(0)
  })
})

describe('开一格:靠表的前后差认新那一格,不解析那句人话', () => {
  it('答出新 tab 的 id', async () => {
    await browserTabsQuery.ensure()
    port.nextTable = { tabs: [{ ...TAB }, { ...TAB, id: 't2', active: true }], activeId: 't2' }
    await expect(openBrowserTab({ url: 'https://x.test' })).resolves.toBe('t2')
  })

  it('开不出来答 null(表没变)', async () => {
    await browserTabsQuery.ensure()
    port.outcome = { kind: 'failed', error: { name: 'Error', message: '没有浏览器' } }
    await expect(openBrowserTab()).resolves.toBeNull()
  })
})

describe('读正文', () => {
  it('`page` 读在那一格 tab 上,`maxChars` 原样递下去', async () => {
    await readBrowserPage('t1', 2000)
    expect(port.reads.at(-1)).toEqual({
      ref: 'browser:t1',
      name: 'page',
      query: { maxChars: 2000 },
    })
  })
})
