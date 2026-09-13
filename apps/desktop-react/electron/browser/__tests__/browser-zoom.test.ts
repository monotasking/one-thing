/**
 * **页面缩放**(K3,方案 `apps/desktop-react/docs/keymap-responder-2026-09.md` §5 K3)。
 *
 * 三层各测一层,而分层与产品的分层逐字相同:
 *  · **算术**(`tab-state.nextZoomLevel`)—— 纯函数,梯子与两头的夹;
 *  · **一格 tab**(`BrowserTab.zoom`)—— 真源是 webContents 那一格,状态是它的投影;
 *  · **自述与 provider**(`resource-spec` / `BrowserResourceProvider`)—— 效果分档、
 *    参数校验、真打了电话。
 *
 * **零 electron 值导入**(与 `browser-host.test.ts` / `app-menu.test.ts` 同一族纪律):
 * `BrowserTab` 吃的是注入的 `createView`,所以这只文件在 vitest 下跑得起来。
 */

import { describe, expect, it } from 'vitest'
import { BrowserTab, type NativeView, type NativeWebContents } from '../tab.js'
import {
  BROWSER_ZOOM_MAX,
  BROWSER_ZOOM_MIN,
  BROWSER_ZOOM_STEP,
  createTabState,
  nextZoomLevel,
} from '../tab-state.js'
import { browserResourceSpec } from '../resource-spec.js'
import {
  BrowserResourceProvider,
  BrowserZoomLevelError,
  type BrowserOps,
  type BrowserTabView,
} from '../resource-provider.js'

// ── ① 算术 ──────────────────────────────────────────────────────────────────

describe('nextZoomLevel —— 梯子与两头的夹', () => {
  it('一格是 0.5(Chrome 那把梯子)', () => {
    expect(BROWSER_ZOOM_STEP).toBe(0.5)
    expect(nextZoomLevel(0, 'in')).toBe(0.5)
    expect(nextZoomLevel(0.5, 'in')).toBe(1)
    expect(nextZoomLevel(0, 'out')).toBe(-0.5)
  })

  it('`reset` 回 0,不管此刻在哪一级', () => {
    expect(nextZoomLevel(3.5, 'reset')).toBe(0)
    expect(nextZoomLevel(-2, 'reset')).toBe(0)
    expect(nextZoomLevel(0, 'reset')).toBe(0)
  })

  /**
   * **夹是判据不是保险**(判词在 `tab-state.ts` 上):不夹的话按住 ⌘= 十秒就能把
   * 一页缩成一行看不见的像素,而那一格状态还会随 `navigated` 出网被当成读数。
   *
   * 反证:把 `Math.min` / `Math.max` 那一行拆掉 → 这一条当场红。
   */
  it('夹在 [-3, 5] 两头,到顶了再按就不动', () => {
    expect(BROWSER_ZOOM_MIN).toBe(-3)
    expect(BROWSER_ZOOM_MAX).toBe(5)
    expect(nextZoomLevel(5, 'in')).toBe(5)
    expect(nextZoomLevel(4.8, 'in')).toBe(5)
    expect(nextZoomLevel(-3, 'out')).toBe(-3)
    expect(nextZoomLevel(-2.9, 'out')).toBe(-3)
  })

  /** 真源答了一个 NaN / Infinity(Chromium 那一口坏了)也不许把状态带歪。 */
  it('读回来的级数不是个有限数 → 当 0 算', () => {
    expect(nextZoomLevel(Number.NaN, 'in')).toBe(0.5)
    expect(nextZoomLevel(Number.POSITIVE_INFINITY, 'out')).toBe(-0.5)
  })

  it('一格新 tab 出厂就是 100%', () => {
    expect(createTabState({ id: 't1', profile: 'default' }).zoomLevel).toBe(0)
  })
})

// ── ② 一格 tab ──────────────────────────────────────────────────────────────

function fakeWc(): NativeWebContents & { level: number; sets: number[] } {
  const wc = {
    level: 0,
    sets: [] as number[],
    on() {},
    setWindowOpenHandler() {},
    async loadURL() {},
    reload() {},
    stop() {},
    focus() {},
    close() {},
    isDestroyed: () => false,
    async executeJavaScript() { return '' },
    async capturePage() { return { isEmpty: () => true, toDataURL: () => '' } },
    findInPage: () => 1,
    stopFindInPage() {},
    getZoomLevel() { return wc.level },
    setZoomLevel(level: number) { wc.level = level; wc.sets.push(level) },
    navigationHistory: {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack() {},
      goForward() {},
    },
  }
  return wc as unknown as NativeWebContents & { level: number; sets: number[] }
}

function tabWithView(): {
  tab: BrowserTab
  wc: NativeWebContents & { level: number; sets: number[] }
  states: number[]
} {
  const wc = fakeWc()
  const states: number[] = []
  const view = { webContents: wc, setVisible() {}, setBounds() {} } as unknown as NativeView
  const tab = new BrowserTab(
    { id: 't1', profile: 'default' },
    {
      createView: () => view,
      preferencesFor: () => ({}) as never,
      observer: {
        onOpened() {}, onClosed() {}, onWindowOpen() {}, onSpawned() {},
        onSpawnBlocked() {}, onNavigated() {}, onLoading() {},
        onMaterialized() {}, onDematerialized() {}, onFind() {},
        onState(t: BrowserTab) { states.push(t.state.zoomLevel) },
        onPermission() {}, onDownload() {},
      } as never,
    } as never,
  )
  tab.materialize()
  return { tab, wc, states }
}

describe('BrowserTab.zoom', () => {
  it('落到 `setZoomLevel`,而且状态跟着走', () => {
    const { tab, wc } = tabWithView()
    tab.zoom('in')
    tab.zoom('in')
    tab.zoom('in')
    expect(wc.sets).toEqual([0.5, 1, 1.5])
    expect(tab.state.zoomLevel).toBe(1.5)
    tab.zoom('reset')
    expect(wc.sets.at(-1)).toBe(0)
    expect(tab.state.zoomLevel).toBe(0)
  })

  /**
   * **真源是 Chromium 那一格,状态是它的投影**(判词在 `NativeWebContents.getZoomLevel`
   * 上)。别人(页面自己的 ⌘滚轮)在中途动过之后,下一下 ⌘= 要从**它现在那一级**
   * 往上走,而不是从我们记着的那一级。
   *
   * 反证:把 `zoom()` 里的 `wc.getZoomLevel()` 换成 `this.current.zoomLevel` →
   * 这一条读回 0.5 而不是 2.5。
   */
  it('从 webContents 现问那一级往上加,不是从自己记的那一格', () => {
    const { tab, wc } = tabWithView()
    wc.level = 2 // 别人动过(页面自己的 ⌘滚轮)
    tab.zoom('in')
    expect(tab.state.zoomLevel).toBe(2.5)
  })

  /**
   * **没有视图 = 什么都不做,状态也不动**(与 `findInPage` / `readText` 同判据)。
   * 记下一个没有视图去兑现的级数,就是让 `zoomLevel` 这一格开始说谎。
   */
  it('惰性的那一格:不建视图,也不改状态', () => {
    const tab = new BrowserTab(
      { id: 't2', profile: 'default' },
      {
        createView: () => { throw new Error('一次缩放不该把视图建出来') },
        preferencesFor: () => ({}) as never,
        observer: {} as never,
      } as never,
    )
    expect(tab.materialized).toBe(false)
    tab.zoom('in')
    expect(tab.materialized).toBe(false)
    expect(tab.state.zoomLevel).toBe(0)
  })
})

// ── ③ 自述与 provider ───────────────────────────────────────────────────────

function fakeTab(init: Partial<BrowserTabView> = {}): BrowserTabView {
  return {
    id: 't1', url: 'https://example.com', title: 'Example', loading: false,
    canGoBack: false, canGoForward: false, active: true, profile: 'default', zoomLevel: 0, ...init,
  }
}

function fakeOps(): BrowserOps & { log: string[] } {
  const log: string[] = []
  const tab = fakeTab()
  return {
    log,
    list: () => [tab],
    activeId: () => 't1',
    open: () => tab,
    navigate: () => {},
    back: () => {}, forward: () => {}, reload: () => {},
    activate: () => {}, close: () => {},
    zoom: (id, level) => { log.push(`zoom:${id}:${level}`) },
    has: id => id === 't1',
    readText: async () => '',
    capture: async () => undefined,
    get: id => (id === 't1' ? tab : undefined),
    respondPermission: () => true,
  }
}

const planCtx = (kind: 'user' | 'agent') => ({
  principal: kind === 'user'
    ? { kind: 'user' as const, id: 'local' }
    : { kind: 'agent' as const, id: 'a1' },
  invocation: {} as never,
  abort: {} as never,
  now: () => 0,
}) as never

const runCtx = () => ({ emit: () => {}, invocation: {} } as never)
const REF = { scheme: 'browser', path: 't1' }

describe('browser 自述:`zoom` 那一条', () => {
  /**
   * **`ui_change`,与 `activate` 同一档**,而判据在自述文件头那一句上:
   * 分档问的是「它以谁的身份动了什么」。缩放不发一个请求、不带 cookie、不改这一页
   * 是谁 —— 它动的是这个人自己那扇窗里的一格摆设。
   *
   * 反证:把那一行改成 `['browser_navigate']` → 这一条当场红。
   */
  it('效果是 `ui_change`,不是 `browser_navigate`', () => {
    expect(browserResourceSpec.ops.zoom.effects).toEqual(['ui_change'])
    expect(browserResourceSpec.ops.activate.effects).toEqual(['ui_change'])
    expect(browserResourceSpec.ops.reload.effects).toEqual(['browser_navigate'])
  })

  it('参数是三个词之一,而且必填', () => {
    const params = browserResourceSpec.ops.zoom.params as {
      properties: { level: { enum: string[] } }
      required: string[]
    }
    expect(params.properties.level.enum).toEqual(['in', 'out', 'reset'])
    expect(params.required).toEqual(['level'])
  })

  it('`read tabs` 把 `zoomLevel` 一起投影出来(壳檐上那颗百分比丸读的是它)', () => {
    const tabs = browserResourceSpec.reads.tabs.result as {
      properties: { tabs: { items: { properties: Record<string, unknown>; required: string[] } } }
    }
    const item = tabs.properties.tabs.items
    expect(item.properties.zoomLevel).toBeTruthy()
    expect(item.required).toContain('zoomLevel')
  })

  it('三个方向各有一句给人看的话', () => {
    const describe_ = browserResourceSpec.ops.zoom.describe!
    expect(describe_({ level: 'in' })).toContain('in')
    expect(describe_({ level: 'out' })).toContain('out')
    expect(describe_({ level: 'reset' })).toContain('100%')
  })
})

describe('BrowserResourceProvider —— zoom', () => {
  it('plan 按主体分档:人零效果,模型 `ui_change`', async () => {
    const provider = new BrowserResourceProvider(fakeOps())
    const byUser = await provider.plan('zoom', REF, { level: 'in' }, planCtx('user'))
    expect(byUser.effects).toEqual([])
    const byAgent = await provider.plan('zoom', REF, { level: 'in' }, planCtx('agent'))
    expect(byAgent.effects.map(e => e.kind)).toEqual(['ui_change'])
  })

  it('apply 真的打了电话,三个方向逐字带下去', async () => {
    const ops = fakeOps()
    const provider = new BrowserResourceProvider(ops)
    for (const level of ['in', 'out', 'reset'] as const) {
      const intent = await provider.plan('zoom', REF, { level }, planCtx('user'))
      await provider.apply('zoom', intent, runCtx())
    }
    expect(ops.log).toEqual(['zoom:t1:in', 'zoom:t1:out', 'zoom:t1:reset'])
  })

  /**
   * **认不出就拒,不回落成 `reset`**(判词在 `BrowserZoomLevelError` 上):一次写错了
   * 参数的调用悄悄把页面缩回 100%,看起来会像是「它就是这么设计的」。
   */
  it('缺 level / 认不出的 level 都是说得出口的拒绝', async () => {
    const provider = new BrowserResourceProvider(fakeOps())
    await expect(provider.plan('zoom', REF, {}, planCtx('user')))
      .rejects.toThrow(BrowserZoomLevelError)
    await expect(provider.plan('zoom', REF, { level: 'bigger' }, planCtx('user')))
      .rejects.toThrow(/'in' \| 'out' \| 'reset'/)
  })

  it('要一格地址;指着一格不存在的 tab 也是说得出口的拒绝', async () => {
    const provider = new BrowserResourceProvider(fakeOps())
    await expect(provider.plan('zoom', null, { level: 'in' }, planCtx('user')))
      .rejects.toThrow(/browser:<tabId>/)
    await expect(provider.plan('zoom', { scheme: 'browser', path: 'gone' }, { level: 'in' }, planCtx('user')))
      .rejects.toThrow(/not an open tab/)
  })
})
