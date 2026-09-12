import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureBrowserPort } from '../browser-port'
import type { BrowserPort, BrowserResourceEvent } from '../browser-port'
import {
  browserTabsQuery,
  onBrowserFact,
  resetBrowserSource,
  setBrowserTabAdopter,
  type BrowserTabsView,
} from '../browser-source'
import { useWorkbenchStore } from '../../workbench/store'
import { registerContentKind, resetContentKinds, refId } from '../../workbench/kinds'
import { makeLeaf } from '../../workbench/tree'
import { CENTER_REGION } from '../../workbench/regions'
import { BROWSER_KIND, browserRef } from '../../content/browser/browser-ref'

/**
 * **页面自己开出来的那一格,壳这一半**(2026-09-12 真机报障的修法)。
 *
 * 报障:搜索结果页点一条 `target=_blank` 的链接 → 主进程建了 tab、视图也建了、
 * 页面真的在跑 —— 壳里**一片叶都没有**。于是「点了没反应」「页面跑到不知道哪儿
 * 去了」「关不掉」是同一件事。主进程那一半在
 * `electron/browser/__tests__/browser-spawn.test.ts`,真机那一半是 `gate:browser` ⑲。
 *
 * 这份用例钉两件:①`spawned` 这条事实**真的把那格单槽叫起来**(而且先把表拉新
 * 再叫 —— 拿旧表摆叶会先闪一下「这一页找不到了」);②收养的落点是**开它的那片
 * 叶的旁边**,不是另起一扇窗。
 */

const TAB = {
  id: 't1',
  url: 'https://search.test/q',
  title: 'search',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  active: true,
  profile: 'default',
}

interface Fake extends BrowserPort {
  reads: number
  facts: Array<(event: BrowserResourceEvent) => void>
  nextTable: BrowserTabsView
}

function fakePort(): Fake {
  const port: Fake = {
    reads: 0,
    facts: [],
    nextTable: { tabs: [{ ...TAB }], activeId: 't1' },
    ready: () => Promise.resolve(undefined),
    read: () => {
      port.reads += 1
      return Promise.resolve({ kind: 'ok', value: port.nextTable })
    },
    do: () => Promise.resolve({ kind: 'ok', text: 'done' }),
    onResourceEvent: (_prefix, cb) => {
      port.facts.push(cb)
      return () => { port.facts = port.facts.filter((x) => x !== cb) }
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
  setBrowserTabAdopter(null)
  configureBrowserPort(undefined)
})

describe('`spawned`:页面自己开的那一格', () => {
  it('标脏 tabs,**先把表拉新再交给收养人**', async () => {
    await browserTabsQuery.ensure()
    const before = port.reads
    const seen: unknown[] = []
    setBrowserTabAdopter((spawn) => {
      // 叫到这里的时候表已经是新的了 —— 不然叶会先画一帧「这一页找不到了」。
      seen.push({ ...spawn, reads: port.reads })
    })
    port.nextTable = { tabs: [{ ...TAB }, { ...TAB, id: 't2', url: 'https://video.test/w' }], activeId: 't2' }

    onBrowserFact({
      ref: 'browser:t2',
      event: 'spawned',
      payload: { id: 't2', url: 'https://video.test/w', openerId: 't1', background: false },
    })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toEqual({ id: 't2', openerId: 't1', background: false, reads: before + 1 })
    expect(browserTabsQuery.get().data?.tabs.map((r) => r.id)).toEqual(['t1', 't2'])
  })

  it('`background` 原样递(⌘-click 那一档不抢人正看着的那一格)', async () => {
    await browserTabsQuery.ensure()
    const seen: boolean[] = []
    setBrowserTabAdopter((spawn) => { seen.push(spawn.background) })
    onBrowserFact({ ref: 'browser:t3', event: 'spawned', payload: { id: 't3', url: 'u', openerId: 't1', background: true } })
    await vi.waitFor(() => expect(seen).toEqual([true]))
  })

  it('`spawnBlocked`:今天只记一行,不标脏任何读数(那一下是页面按的,人没做任何事)', async () => {
    await browserTabsQuery.ensure()
    const spy = vi.spyOn(browserTabsQuery, 'invalidate')
    onBrowserFact({
      ref: 'browser:t1',
      event: 'spawnBlocked',
      payload: { openerId: 't1', url: 'https://evil.test/9' },
    })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('载荷缺 `openerId` = 认不出该摆哪儿 = 不摆(而不是瞎摆一处)', async () => {
    await browserTabsQuery.ensure()
    const adopt = vi.fn()
    setBrowserTabAdopter(adopt)
    onBrowserFact({ ref: 'browser:t4', event: 'spawned', payload: { id: 't4', url: 'u' } })
    await Promise.resolve()
    expect(adopt).not.toHaveBeenCalled()
  })
})

describe('收养的落点:开它的那片叶的旁边', () => {
  beforeEach(() => {
    resetContentKinds()
    registerContentKind({
      id: BROWSER_KIND,
      singleton: true,
      title: (ref) => ({ text: ref.key }),
      icon: () => 'Globe',
      render: () => null,
    })
    useWorkbenchStore.getState().reset()
  })
  afterEach(() => { resetContentKinds() })

  async function place(background: boolean) {
    const opener = browserRef('t1')
    const other = browserRef('zzz')
    useWorkbenchStore.setState({
      regions: { [CENTER_REGION]: makeLeaf('leaf-1', [opener, other], 0) },
      hidden: [],
      focusLeafId: 'leaf-1',
    })
    const { placeBrowserTabNear } = await import('../../content/browser-launcher')
    placeBrowserTabNear('t1', 't2', background)
    const tree = useWorkbenchStore.getState().regions[CENTER_REGION]
    const leaf = tree && 'tabs' in tree ? tree : null
    return leaf
  }

  it('前台:插在开它的那一格**后面一位**,并且就是活动那一格', async () => {
    const leaf = await place(false)
    expect(leaf?.tabs.map((r) => refId(r))).toEqual([
      refId(browserRef('t1')),
      refId(browserRef('t2')),
      refId(browserRef('zzz')),
    ])
    expect(leaf?.active).toBe(1)
  })

  it('后台:标签条上多一格,而人正看着的那一格**不换**', async () => {
    const leaf = await place(true)
    expect(leaf?.tabs).toHaveLength(3)
    // 活动下标仍旧指着 t1(插在它后面,所以下标都不必挪)。
    expect(refId(leaf!.tabs[leaf!.active])).toBe(refId(browserRef('t1')))
  })

  it('**开它的那一格不在屏上:照样摆**(后台档不激活、不抢焦点)—— 不摆就是本单在治的那个病', async () => {
    // 树上只有一格别的内容:开它的那一格(t1)根本不在场。
    const other = browserRef('zzz')
    useWorkbenchStore.setState({
      regions: { [CENTER_REGION]: makeLeaf('leaf-1', [other], 0) },
      hidden: [],
      focusLeafId: 'leaf-1',
    })
    const { placeBrowserTabNear } = await import('../../content/browser-launcher')
    placeBrowserTabNear('t1', 't2', true)
    const tree = useWorkbenchStore.getState().regions[CENTER_REGION]
    const leaf = tree && 'tabs' in tree ? tree : null
    expect(leaf?.tabs.map((r) => refId(r))).toContain(refId(browserRef('t2')))
    // 人正看着的仍旧是原来那一格。
    expect(refId(leaf!.tabs[leaf!.active])).toBe(refId(other))
  })

  it('孤儿口径:表里有、树上没有的那几格 —— 右键那一行照它画', async () => {
    const { offscreenBrowserTabs } = await import('../../content/browser-launcher')
    useWorkbenchStore.setState({
      regions: { [CENTER_REGION]: makeLeaf('leaf-1', [browserRef('t1')], 0) },
      hidden: [],
      focusLeafId: 'leaf-1',
    })
    expect(offscreenBrowserTabs(['t1', 't2', 't3'])).toEqual(['t2', 't3'])
    // 一格都不缺 = 那一行不画(消费方判 `length > 0`)。
    expect(offscreenBrowserTabs(['t1'])).toEqual([])
  })
})
