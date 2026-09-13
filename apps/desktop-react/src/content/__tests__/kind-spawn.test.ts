import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * **两只启动瓦被替掉的是它们的「创建半段」**,不是整只模块的别的东西 ——
 * 这两发 mock 因此只列那一口(`vi.mock` 的工厂里不许出现真模块的其余导出:
 * 少写一口比多写一口安全,多写的那一口会在下一次真模块改动时悄悄骗过用例)。
 */
vi.mock('../browser-launcher', () => ({
  createBrowserTab: vi.fn(async (init: { url?: string; profile?: string } = {}) =>
    init.url === 'x://fail' ? null : `tab-${init.url ?? 'blank'}-${init.profile ?? 'none'}`,
  ),
}))
vi.mock('../terminal-launcher', () => ({
  createTerminalTab: vi.fn(async (cwd?: string) => `pty-${cwd ?? 'default'}`),
}))

import '../kinds/browser'
import { pickTerminalCwd } from '../kinds/terminal'
import '../kinds/session'
import { canSpawnContent, contentKindOf, restoreContent, snapshotContent, spawnContent } from '../../workbench/kinds'
import { useWorkbenchStore } from '../../workbench/store'
import { useExposeStore } from '../../expose/store'
import { BROWSER_KIND, browserRef } from '../browser/browser-ref'
import { TERMINAL_KIND, terminalRef } from '../terminal/terminal-ref'
import { SESSION_KIND, sessionRefOf } from '../session-ref'
import { takeBrowserFocusRequest } from '../browser/focus-request'
import { takeTerminalFocusRequest } from '../terminal/registry'
import { rememberTerminalCwd, resetTerminalMemory } from '../terminal/terminal-memory'

/**
 * **`spawn` / `snapshot` / `restore` 三格自述**(K2,方案 §4 ④)。
 *
 * 契约只有一句话,三种内容各答一遍:**只创建,不摆放**。摆到哪儿由叫它的那片叶
 * 说了算(⌘T 是「紧挨着当前那一格」,⌘N 是「按这种内容自己的打开方式」),而把
 * 摆法焊进创建里就等于两条键各要一条创建路。
 *
 * 「不摆放」这一句在这一组里是**可证的**:调 `spawn` 前后拼贴树的引用逐字相同。
 * 焦点那一半也在:三种里有点名机制的两种(浏览器 / 终端)必须在 `spawn` 里留下
 * 那张条子 —— 「开的人点名、被开的那一格挂载时自己取走」(真机病历在
 * `content/browser/focus-request.ts` 上:在外面排一拍够不着 `lazy` 进来的叶)。
 */

function treeRef() {
  return useWorkbenchStore.getState().regions
}

beforeEach(() => {
  // 条子是模块级的一次性集合 —— 上一份用例留下的不该被下一份看见。
  takeBrowserFocusRequest('tab-blank-none')
  takeTerminalFocusRequest('pty-default')
  // cwd 小账本同理(它落在 localStorage 上)。
  resetTerminalMemory()
})

describe('浏览器:再开一格空白页,身份跟着开它的那一格走', () => {
  it('`spawn` 答一格新 ref,而且**没动过树**', async () => {
    const before = treeRef()
    const made = await spawnContent(browserRef('t1'))
    expect(made).toEqual(browserRef('tab-blank-none'))
    expect(treeRef()).toBe(before)
  })

  it('`spawn` 顺手留下那张焦点条子(点名在这儿,不在叶那一头)', async () => {
    const made = await spawnContent(browserRef('t1'))
    expect(takeBrowserFocusRequest(made!.key)).toBe(true)
  })

  /**
   * **关一格 tab 是删一行**,那个 tabId 从此不存在 —— 所以这一种是全表唯一
   * 需要自述快照的。表里读不到那一格(测试环境没有读数)时 url 是空串,
   * 而 `restore` 对空 url 答 `null`(一格指着空白的「重开」比不响更糟)。
   */
  it('`snapshot` 是 `{url, profile}`,空 url 的影重开不出来', async () => {
    expect(snapshotContent(browserRef('t1'))).toEqual({ url: '', profile: undefined })
    expect(await restoreContent(BROWSER_KIND, { url: '' })).toBeNull()
    expect(await restoreContent(BROWSER_KIND, null)).toBeNull()
  })

  it('`restore` 按 url 再开一格,同样不摆放、同样点名', async () => {
    const before = treeRef()
    const made = await restoreContent(BROWSER_KIND, { url: 'https://a.test', profile: 'work' })
    expect(made).toEqual(browserRef('tab-https://a.test-work'))
    expect(treeRef()).toBe(before)
    expect(takeBrowserFocusRequest(made!.key)).toBe(true)
  })
})

describe('终端:在同一个目录里再开一台 shell', () => {
  it('`spawn` 答一格新 ref、不动树、留下条子', async () => {
    const before = treeRef()
    const made = await spawnContent(terminalRef('p1'))
    expect(made).toEqual(terminalRef('pty-default'))
    expect(treeRef()).toBe(before)
    expect(takeTerminalFocusRequest(made!.key)).toBe(true)
  })

  /**
   * **⌘⇧T 拿回来的必须是一台新 shell,不是一格「已退出」的死壳**(K2 修一轮)。
   *
   * 关一格终端 = 杀 PTY,所以缺省那一档(影 = ref 自己)在这一种上是错的:
   * 那个 id 背后的东西已经没了。影里装的是**可复现的那一半** —— 它在哪个目录
   * 开着;重开 = 照这个目录开一台新的。
   */
  it('`snapshot` 装的是 cwd,`restore` 照它开一台**新**终端', async () => {
    rememberTerminalCwd('p1', '/tmp/gate-project')
    expect(snapshotContent(terminalRef('p1'))).toEqual({ cwd: '/tmp/gate-project' })

    const before = treeRef()
    const made = await restoreContent(TERMINAL_KIND, { cwd: '/tmp/gate-project' })
    // **新 ref**:不等于被关掉的那一格(那正是「重开」与「把尸体捡回来」的分界)。
    expect(made).toEqual(terminalRef('pty-/tmp/gate-project'))
    expect(made).not.toEqual(terminalRef('p1'))
    // 与 `spawn` 同一条契约:只创建不摆放,焦点在这儿点名。
    expect(treeRef()).toBe(before)
    expect(takeTerminalFocusRequest(made!.key)).toBe(true)
  })

  /**
   * **活的优先**(K2 修一轮的判词,`pickTerminalCwd`)。
   *
   * 人在项目里 `cd` 过之后关掉那一格,⌘⇧T 该回到**他离开时在的那个目录**,
   * 不是回到它出生的目录。反证:把两个产地的次序对调 → 第一句当场红。
   */
  it('cwd 两个产地:活的赢记的那一笔,活的没有才回落', () => {
    expect(pickTerminalCwd('/live/after-cd', '/born/at-create')).toBe('/live/after-cd')
    expect(pickTerminalCwd(undefined, '/born/at-create')).toBe('/born/at-create')
    expect(pickTerminalCwd('', '/born/at-create')).toBe('/born/at-create')
    expect(pickTerminalCwd(undefined, undefined)).toBeUndefined()
  })

  it('读不到 cwd 就交一格空影,重开按缺省目录落地', async () => {
    expect(snapshotContent(terminalRef('never-seen'))).toEqual({})
    const made = await restoreContent(TERMINAL_KIND, {})
    expect(made).toEqual(terminalRef('pty-default'))
    // 影的形状不对(手改过的档案 / 换过版本)照样按缺省开 —— cwd 那一格是可选的。
    expect(await restoreContent(TERMINAL_KIND, { cwd: 42 })).toEqual(terminalRef('pty-default'))
  })
})

describe('会话:建一条新的,但不摆、不换当前会话', () => {
  it('`spawn` 走 `newSessionDetached`,答那条会话的 ref,树一个字不动', async () => {
    const before = treeRef()
    const restore = useExposeStore.getState().newSessionDetached
    useExposeStore.setState({ newSessionDetached: async () => 'sess-9' })
    try {
      expect(await spawnContent(sessionRefOf('s1'))).toEqual(sessionRefOf('sess-9'))
      expect(treeRef()).toBe(before)
    } finally {
      useExposeStore.setState({ newSessionDetached: restore })
    }
  })

  it('建不成(后端拒 / 一次创建已经在飞)答 null,叶那一头什么都不做', async () => {
    const restore = useExposeStore.getState().newSessionDetached
    useExposeStore.setState({ newSessionDetached: async () => undefined })
    try {
      expect(await spawnContent(sessionRefOf('s1'))).toBeNull()
    } finally {
      useExposeStore.setState({ newSessionDetached: restore })
    }
  })
})

describe('没自述 `spawn` 的种类:⌘T 是一个诚实的哑键', () => {
  it('`canSpawnContent` 答 false,`spawnContent` 答 null', async () => {
    expect(canSpawnContent(browserRef('t1'))).toBe(true)
    expect(canSpawnContent(terminalRef('p1'))).toBe(true)
    expect(canSpawnContent(sessionRefOf('s1'))).toBe(true)
    // 没登记的种类同理(存量档案里的未知种类走的是同一条)。
    expect(canSpawnContent({ kind: 'nope', key: 'x' })).toBe(false)
    expect(await spawnContent({ kind: 'nope', key: 'x' })).toBeNull()
  })

  it('三种里 `session` 不自述快照(它的 ref 就是它的身份)', () => {
    expect(contentKindOf(SESSION_KIND)?.snapshot).toBeUndefined()
    expect(snapshotContent(sessionRefOf('s1'))).toEqual(sessionRefOf('s1'))
  })
})
