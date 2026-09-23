import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureBrowserPort } from '../../../data/browser-port'
import { focusTree } from '../../../focus/registry'
import { useKeymapStore } from '../../../keymap/store'
import { useStageStore } from '../../../stage/store'
import { __resetLogForTests, dumpLog } from '../../../services/log'
import {
  menuFrameChangedKeys,
  resetNativeViewKeymapDownlink,
  startKeymapDownlink,
  startNativeViewKeymapDownlink,
} from '../keymap-downlink'
import type { BrowserPort } from '../../../data/browser-port'
import type { NativeViewPush, NativeViewRequest } from '../../../data/browser-port'

/**
 * **K4:同一条帧的另一半**。
 *
 * 这一组钉的是四件在真机上会咬人的事:
 *  · 菜单表**整台壳一份**、没有原生视图时也推得出去(菜单栏在屏幕顶上,
 *    一格浏览器都没开的时候也得是对的);
 *  · **签名去重**(菜单 + 键表两半一起算):焦点换一次人就重投一次,一条与上次
 *    逐字相同的帧不该跑一趟 IPC —— 而主进程收到菜单就会整台重建 `Menu`;
 *  · **焦点换人要重投**:`enabled` 是活动路径算出来的;
 *  · **菜单点击的回程收在这条链上**,不在占位格里(占位格只在有原生视图时挂载)。
 */

const sent: NativeViewRequest[] = []
let pushHandlers: ((message: NativeViewPush) => void)[] = []

function stubPort(): void {
  configureBrowserPort({
    ready: () => Promise.resolve(),
    read: () => Promise.reject(new Error('not used')),
    do: () => Promise.reject(new Error('not used')),
    onResourceEvent: () => () => {},
    nativeView: {
      send: (message) => { sent.push(message) },
      on: (handler) => {
        pushHandlers.push(handler)
        return () => { pushHandlers = pushHandlers.filter((h) => h !== handler) }
      },
    },
  } as BrowserPort)
}

function menuFrames(): Extract<NativeViewRequest, { verb: 'keymap' }>[] {
  return sent.filter((m): m is Extract<NativeViewRequest, { verb: 'keymap' }> => m.verb === 'keymap')
}

beforeEach(() => {
  sent.length = 0
  pushHandlers = []
  stubPort()
})

afterEach(() => {
  resetNativeViewKeymapDownlink()
  focusTree.reset()
  configureBrowserPort(undefined)
})

describe('菜单表骑同一条帧下去', () => {
  it('一片原生视图都没有也推得出菜单 —— 菜单栏不等浏览器', () => {
    const stop = startKeymapDownlink()
    const frames = menuFrames()
    expect(frames.length).toBe(1)
    expect(frames[0].chords.length).toBeGreaterThan(0)
    const items = (frames[0].menu?.sections ?? []).flatMap((s) => s.items)
    expect(items.some((item) => item.id === 'tab.new')).toBe(true)
    expect(items.find((item) => item.id === 'tab.new')?.chord).toBe(
      // 这台机器上 ⌘T / Ctrl+T —— 串已经解释过平台(判词在 `keymap/chord.ts`)。
      frames[0].chords.includes('cmd+t') ? 'cmd+t' : 'ctrl+t',
    )
    stop()
  })

  it('签名一样就不发(菜单 + 键表两半一起算)', () => {
    const stop = startKeymapDownlink()
    expect(menuFrames().length).toBe(1)
    // store 上一次无关的写:改绑再改回去,有效表逐字相同。
    useKeymapStore.setState((s) => ({ ...s }))
    expect(menuFrames().length).toBe(1)
    stop()
  })

  it('**改绑**会重投:键表与菜单上的键面同时变', () => {
    const stop = startKeymapDownlink()
    const before = menuFrames().length
    useKeymapStore.getState().unbind('tab.new')
    const frames = menuFrames()
    expect(frames.length).toBe(before + 1)
    const row = (frames.at(-1)?.menu?.sections ?? []).flatMap((s) => s.items)
      .find((item) => item.id === 'tab.new')
    expect(row?.chord).toBeNull()
    useKeymapStore.getState().reset('tab.new')
    stop()
  })

  /**
   * **焦点换人要重投**。反证:把 `focusTree.subscribe(push)` 那一条订阅拆掉,
   * 这一条当场红 —— 而真机上的表现是「开了一格浏览器,菜单里的『新标签』还是灰的」。
   */
  it('活动路径变了要重投 —— `enabled` 是它算出来的', () => {
    const stop = startKeymapDownlink()
    const before = menuFrames().length
    const root = document.createElement('div')
    document.body.append(root)
    const handle = focusTree.register('root', null)
    handle.setRoot(root)
    const leaf = focusTree.register('leaf', handle.instanceId, {
      commands: { 'tab.close': () => {} },
    })
    leaf.setRoot(root)
    leaf.activate('open')
    expect(menuFrames().length).toBeGreaterThan(before)
    const row = (menuFrames().at(-1)?.menu?.sections ?? []).flatMap((s) => s.items)
      .find((item) => item.id === 'tab.close')
    expect(row?.enabled).toBe(true)
    leaf.unregister()
    handle.unregister()
    root.remove()
    stop()
  })

  it('换语言要重投 —— 标签是当场翻好的串', () => {
    const stop = startKeymapDownlink()
    const before = menuFrames().length
    const locale = useStageStore.getState().locale
    useStageStore.setState({ locale: 'zh' })
    useStageStore.setState({ locale: 'en' })
    // 两次换语言 = 两帧(两张字典的标签不一样);签名去重挡不住真的变化。
    expect(menuFrames().length).toBe(before + 2)
    useStageStore.setState({ locale })
    stop()
  })

  it('菜单点击的回程收在这条链上,不在占位格里', () => {
    const ran: string[] = []
    const root = document.createElement('div')
    document.body.append(root)
    const handle = focusTree.register('root', null, {
      commands: { 'tab.close': () => { ran.push('tab.close') } },
    })
    handle.setRoot(root)
    handle.activate('open')
    const stop = startKeymapDownlink()
    expect(pushHandlers.length).toBe(1)
    for (const handler of pushHandlers) handler({ kind: 'command', id: 'tab.close' })
    expect(ran).toEqual(['tab.close'])
    stop()
    handle.unregister()
    root.remove()
  })

  it('两条链共用一只订阅:视图那一条走了,整壳那一条还在', () => {
    const stop = startKeymapDownlink()
    const release = startNativeViewKeymapDownlink('browser')
    /*
     * 串已经解释过平台了(mac 写 `cmd+…`、其余写 `ctrl+…`),而 jsdom 这台机器
     * 是哪一档由 `navigator.userAgent` 说了算 —— 所以这里问的是「浏览器地址栏
     * 那一条在不在」,不是一个写死的串。
     */
    const addressChord = menuFrames().at(-1)?.menu?.sections
      .flatMap((s) => s.items).find((item) => item.id === 'browser.address')?.chord
    expect(addressChord).toBeTruthy()
    expect(menuFrames().at(-1)?.chords).toContain(addressChord)
    release()
    // 视图走了 —— 表重投一次(少了浏览器那一格的局部键),但推送口还连着。
    expect(pushHandlers.length).toBe(1)
    expect(menuFrames().at(-1)?.chords).not.toContain(addressChord)
    stop()
    expect(pushHandlers.length).toBe(0)
  })

  it('没有宿主(`--mode web`)就什么都不推,也不抛', () => {
    configureBrowserPort({
      ready: () => Promise.resolve(),
      read: () => Promise.reject(new Error('not used')),
      do: () => Promise.reject(new Error('not used')),
      onResourceEvent: () => () => {},
      nativeView: undefined,
    } as BrowserPort)
    const stop = startKeymapDownlink()
    expect(menuFrames().length).toBe(0)
    expect(() => { stop() }).not.toThrow()
  })
})

/**
 * **排障口**(「点了聊天里的目录 chip 之后菜单栏一直闪」那条报障立的)。
 *
 * 报障的形状是「chip 拿到焦点之后,每帧一次 `setApplicationMenu`」。这一组钉两件:
 *  · chip 聚焦之后,树上再来多少次**不改任何事实**的 notify(同一格再聚焦、同一份
 *    声明再交一遍),帧都只发 ≤ 1 次 —— 签名去重是这条链的第一道闸;
 *  · 每一帧真发出去,日志环里都有一条 `shell.menu` 的 debug,说清是谁叫醒的
 *    (`trigger`)、比上一帧变了哪几格(`changedKeys`)。
 */
describe('排障口:chip 聚焦后重复 notify 不重复推帧', () => {
  it('chip 聚焦并停 60 帧:推帧 ≤ 1,日志 ≤ 1 条且带 trigger / changedKeys', () => {
    __resetLogForTests()
    const stop = startKeymapDownlink()
    const root = document.createElement('div')
    document.body.append(root)
    const chat = document.createElement('div')
    chat.tabIndex = -1
    const chip = document.createElement('button')
    chip.dataset.refKind = 'dirRef'
    chat.append(chip)
    root.append(chat)
    const shell = focusTree.register('root', null)
    shell.setRoot(root)
    const leaf = focusTree.register('leaf', shell.instanceId, {
      commands: { 'tab.close': () => {} },
    })
    leaf.setRoot(chat)

    const before = menuFrames().length
    const logsBefore = dumpLog().filter((r) => r.ns === 'shell.menu').length
    chip.focus()
    expect(document.activeElement).toBe(chip)
    const afterFocus = menuFrames().length
    // 聚焦本身是一次真换人(路径从空到 root>leaf):恰好一帧。
    expect(afterFocus - before).toBe(1)

    // 60 帧:同一格再聚焦、同一份声明再交一遍 —— 每一下都会叫醒 `focusTree.subscribe`。
    for (let frame = 0; frame < 60; frame += 1) {
      chip.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      leaf.update({ owner: undefined })
    }
    expect(menuFrames().length).toBe(afterFocus)

    const records = dumpLog().filter((r) => r.ns === 'shell.menu').slice(logsBefore)
    expect(records.length).toBe(afterFocus - before)
    for (const record of records) {
      expect(record.level).toBe('debug')
      expect(record.msg).toBe('menu frame sent')
      const fields = JSON.parse(record.args[0]) as { trigger: string; changedKeys: string[] }
      expect(fields.trigger).toBe('focus')
      expect(fields.changedKeys.length).toBeGreaterThan(0)
    }

    leaf.unregister()
    shell.unregister()
    root.remove()
    stop()
  })

  it('changedKeys:第一帧答 *,之后只列真变了的那几格', () => {
    const menu = (enabled: boolean) => ({
      sections: [{ label: '标签', items: [
        { id: 'tab.new', label: '新标签', chord: 'cmd+t', enabled: true },
        { id: 'tab.close', label: '关闭', chord: 'cmd+w', enabled },
      ] }],
    })
    expect(menuFrameChangedKeys(undefined, { menu: menu(true), chords: ['cmd+t'] })).toEqual(['*'])
    expect(menuFrameChangedKeys(
      { menu: menu(true), chords: ['cmd+t'] },
      { menu: menu(false), chords: ['cmd+t'] },
    )).toEqual(['tab.close'])
    expect(menuFrameChangedKeys(
      { menu: menu(true), chords: ['cmd+t'] },
      { menu: menu(true), chords: ['cmd+t', 'cmd+w'] },
    )).toEqual(['chords'])
  })
})
