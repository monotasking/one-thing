/**
 * 外壳布局协调器(L2 / L3)—— 降级表。
 *
 * 这张表就是"窄窗到底先收哪一列"的**规格**:预算 W = sidebar + chat + workbench,
 * chat ≥ 480px 是硬下限,不够就按 workbench 收窄 → workbench 折叠 → sidebar
 * 转浮层 的顺序收。L3 起大纲栏不再是一列(并入右栏页签),原来的第一步随之消失。
 *
 * 同样重要的是它**不做**的事:预算折叠从来不改用户偏好,所以每一档窄窗的输出都是
 * `(W, 偏好)` 的纯函数 —— 窗宽一恢复,原样弹回来,不需要任何"记得撤销"的代码。
 */
import { describe, expect, it } from 'vitest'
import {
  CHAT_MIN_WIDTH,
  resolveShellLayout,
  type ShellLayoutInput,
} from '../useShellLayout'
import {
  DEFAULT_SIDEBAR_WIDTH,
  DEFAULT_WORKBENCH_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_WORKBENCH_WIDTH,
} from '@/stores/layoutPrefs'

/** 默认偏好:三列全开、宽度都是默认值。 */
function input(overrides: Partial<ShellLayoutInput> = {}): ShellLayoutInput {
  return {
    shellWidth: 1800,
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    sidebarCollapsed: false,
    workbenchWidth: DEFAULT_WORKBENCH_WIDTH,
    workbenchOpen: true,
    ...overrides,
  }
}

/** 一行降级表的可读投影。 */
function row(width: number, overrides: Partial<ShellLayoutInput> = {}) {
  const layout = resolveShellLayout(input({ shellWidth: width, ...overrides }))
  return {
    sidebar: layout.sidebarDocked ? 'docked' : 'floating',
    workbench: layout.workbenchVisible ? layout.workbenchWidth : false,
    chat: layout.chatWidth,
  }
}

const WIDTHS = [700, 900, 1100, 1400, 1800]

describe('resolveShellLayout —— 降级顺序', () => {
  it('三列全开的偏好下,W 逐档变窄按 workbench 收窄 → workbench 折叠 → sidebar 浮层 收', () => {
    expect(WIDTHS.map(w => row(w))).toEqual([
      // 700:三步全用完,连侧栏都得让位
      { sidebar: 'floating', workbench: false, chat: 700 },
      // 900:收到第二步,侧栏还在
      { sidebar: 'docked', workbench: false, chat: 600 },
      // 1100:收到第一步,右栏收窄到刚好给聊天列留 480(1100 − 300 − 480 = 320)
      { sidebar: 'docked', workbench: 320, chat: 480 },
      // 1400:预算够了,偏好原样兑现
      { sidebar: 'docked', workbench: DEFAULT_WORKBENCH_WIDTH, chat: 740 },
      { sidebar: 'docked', workbench: DEFAULT_WORKBENCH_WIDTH, chat: 1140 },
    ])
  })

  it('每一档的聊天列都不低于 480px —— 这是硬下限,不是"尽量"', () => {
    for (const width of WIDTHS) {
      expect(resolveShellLayout(input({ shellWidth: width })).chatWidth)
        .toBeGreaterThanOrEqual(CHAT_MIN_WIDTH)
    }
  })

  it('降级只在协调器的输出里,输入(= 用户偏好)一个字节不改', () => {
    const prefs = input({ shellWidth: 700 })
    const layout = resolveShellLayout(prefs)

    expect(layout.sidebarDocked).toBe(false)
    expect(layout.workbenchVisible).toBe(false)
    // "被预算收的"两面旗都立着 —— 它们正是"这不是用户的意思"的记号
    expect(layout.sidebarFloatingByBudget).toBe(true)
    expect(layout.workbenchCollapsedByBudget).toBe(true)
    expect(prefs.sidebarCollapsed).toBe(false)
    expect(prefs.workbenchOpen).toBe(true)
  })

  it('窗宽恢复即回弹 —— 同一份偏好在宽窗下原样兑现', () => {
    const prefs = { sidebarCollapsed: false, workbenchOpen: true }
    expect(row(700, prefs).sidebar).toBe('floating')
    expect(row(1800, prefs)).toEqual({
      sidebar: 'docked',
      workbench: DEFAULT_WORKBENCH_WIDTH,
      chat: 1140,
    })
  })
})

describe('resolveShellLayout —— 偏好组合', () => {
  it('用户自己关掉右栏时,不算"预算折叠"', () => {
    const layout = resolveShellLayout(input({ shellWidth: 1800, workbenchOpen: false }))
    expect(layout.workbenchVisible).toBe(false)
    expect(layout.workbenchCollapsedByBudget).toBe(false)
  })

  it('自己关掉 vs 被预算收起:栏目摆放一样,记号不一样', () => {
    // 900 上右栏无论如何都在不了;差别只在这是谁的意思 —— 而这个差别决定了
    // 窗宽恢复后它会不会自己回来。
    expect(row(900, { workbenchOpen: false })).toEqual(row(900))

    const byUser = resolveShellLayout(input({ shellWidth: 900, workbenchOpen: false }))
    const byBudget = resolveShellLayout(input({ shellWidth: 900 }))
    expect(byUser.workbenchCollapsedByBudget).toBe(false)
    expect(byBudget.workbenchCollapsedByBudget).toBe(true)
  })

  it('用户关掉右栏后,窄窗能一直留住停靠侧栏', () => {
    expect(WIDTHS.map(w => row(w, { workbenchOpen: false }))).toEqual([
      { sidebar: 'floating', workbench: false, chat: 700 },
      { sidebar: 'docked', workbench: false, chat: 600 },
      { sidebar: 'docked', workbench: false, chat: 800 },
      { sidebar: 'docked', workbench: false, chat: 1100 },
      { sidebar: 'docked', workbench: false, chat: 1500 },
    ])
  })

  it('用户折叠侧栏后,窄窗把 300px 直接省下来', () => {
    expect(WIDTHS.map(w => row(w, { sidebarCollapsed: true }))).toEqual([
      { sidebar: 'floating', workbench: false, chat: 700 },
      { sidebar: 'floating', workbench: DEFAULT_WORKBENCH_WIDTH, chat: 540 },
      { sidebar: 'floating', workbench: DEFAULT_WORKBENCH_WIDTH, chat: 740 },
      { sidebar: 'floating', workbench: DEFAULT_WORKBENCH_WIDTH, chat: 1040 },
      { sidebar: 'floating', workbench: DEFAULT_WORKBENCH_WIDTH, chat: 1440 },
    ])
  })

  it('侧栏被拖宽后,同一档窗宽下留给别人的预算就少了', () => {
    // 300 的侧栏在 1250 上放得下默认宽的右栏;拖到 500 右栏就得收窄到预算内
    // (1250 − 500 − 480 = 270)
    expect(row(1250)).toEqual({
      sidebar: 'docked',
      workbench: DEFAULT_WORKBENCH_WIDTH,
      chat: 590,
    })
    expect(row(1250, { sidebarWidth: MAX_SIDEBAR_WIDTH })).toEqual({
      sidebar: 'docked',
      workbench: 270,
      chat: 480,
    })
  })

  it('窗宽还没量到(W=0)时一律兑现偏好,不凭空降级', () => {
    const layout = resolveShellLayout(input({ shellWidth: 0 }))
    expect(layout).toMatchObject({
      sidebarDocked: true,
      workbenchVisible: true,
      sidebarFloatingByBudget: false,
      workbenchCollapsedByBudget: false,
    })
    expect(layout.sidebarMaxWidth).toBe(MAX_SIDEBAR_WIDTH)
    expect(layout.workbenchMaxWidth).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('resolveShellLayout —— 拖拽上限', () => {
  it('右栏上限永远给聊天列留 480px —— 没有固定上限,屏幕越宽能拖越宽', () => {
    // 1800:余量 1800 − 300 − 480 = 1020
    expect(resolveShellLayout(input({ shellWidth: 1800 })).workbenchMaxWidth).toBe(1020)
    // 1100:余量 1100 − 300 − 480 = 320
    expect(resolveShellLayout(input({ shellWidth: 1100 })).workbenchMaxWidth).toBe(320)
    // 900:余量只剩 120,但 250 是硬地板,上限不许跌破它
    expect(resolveShellLayout(input({ shellWidth: 900 })).workbenchMaxWidth).toBe(MIN_WORKBENCH_WIDTH)
  })

  it('侧栏上限同理 —— 拖到头也不能把聊天列挤破 480', () => {
    expect(resolveShellLayout(input({ shellWidth: 1800 })).sidebarMaxWidth).toBe(MAX_SIDEBAR_WIDTH)
    // 1400:余量 1400 − 360 − 480 = 560 → 仍被 500 的产品上限收住
    expect(resolveShellLayout(input({ shellWidth: 1400 })).sidebarMaxWidth).toBe(MAX_SIDEBAR_WIDTH)
    // 1100:右栏已收窄到 320,余量 1100 − 320 − 480 = 300
    expect(resolveShellLayout(input({ shellWidth: 1100 })).sidebarMaxWidth).toBe(300)
  })
})
