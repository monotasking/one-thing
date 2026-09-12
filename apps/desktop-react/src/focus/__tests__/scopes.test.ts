import { describe, expect, it } from 'vitest'
import {
  FOCUS_SCOPES,
  FOCUS_SCOPE_LIST,
  focusScopeAnswersOf,
  focusScopeClaimsOf,
} from '../scopes'
import { findCommand } from '../../keymap/commands'
import { zh } from '../../i18n/zh'
import { en } from '../../i18n/en'
import type { FocusScopeId, FocusScopeKind } from '../types'

/**
 * **封闭表的守卫**。加一格作用域 = 三件事(表加一行 / `FocusScopeId` 加一格 /
 * labelKey 在两本字典里成对存在),这一组保证缺一件当场红,而不是等到真机上
 * 某块面的名字读成一个键名。
 *
 * 反证:把 `FOCUS_SCOPES.viewer` 的 labelKey 改成一个不存在的键 → 第二条红;
 * 把 `viewer` 那三条 `answers` 删一条 → 下面那一组红(以及 keymap-scopes 的比对表)。
 */

const ALL_IDS: readonly FocusScopeId[] = [
  'root',
  'viewer',
  'files',
  'composer',
  'search',
  'expose',
  'chat',
  // 一张权限卡(应用级许可 · 壳半边,2026-09-10)。
  'permission',
  'settings',
  // 音乐面(音乐收尾 · 壳半边,2026-09-10)。
  'music',
  // 一格终端(T1,2026-09-12)。
  'terminal',
  // 一格内嵌浏览器(B2,2026-09-12)。
  'browser',
  'dock',
  // 拼贴树里的一片叶(W1)。
  'leaf',
  'stage-layer',
  'float-layer',
  'shelf-layer',
  // W2:`full-layer` 顶掉 `cover-layer`(「盖」退役,接替它的是真全屏)。
  'full-layer',
  'jumpbar',
  'drawer',
  'zoom',
  'popover',
  'tooltip',
  'dialog',
  'menu',
  'palette',
]

describe('FOCUS_SCOPES 封闭表', () => {
  it('26 格(浏览器是第 26 格),一格不多一格不少', () => {
    expect(FOCUS_SCOPE_LIST.map((s) => s.id).sort()).toEqual([...ALL_IDS].sort())
  })

  it('每一格的 key 与它自己的 id 一致(表是按 id 索引的,不许对不上)', () => {
    for (const [key, spec] of Object.entries(FOCUS_SCOPES)) expect(spec.id).toBe(key)
  })

  it('每一格的 labelKey 在 zh / en 两本字典里都真有一条', () => {
    for (const spec of FOCUS_SCOPE_LIST) {
      expect(zh[spec.labelKey], `zh ${spec.id}`).toBeTruthy()
      expect(en[spec.labelKey], `en ${spec.id}`).toBeTruthy()
    }
  })

  it('行为档只有五种,而且 root 只有一格', () => {
    const kinds: FocusScopeKind[] = ['root', 'layer', 'region', 'float', 'modal']
    for (const spec of FOCUS_SCOPE_LIST) expect(kinds).toContain(spec.kind)
    expect(FOCUS_SCOPE_LIST.filter((s) => s.kind === 'root').map((s) => s.id)).toEqual(['root'])
  })

  it('四个宿主层都是 layer,三种临时面各归其档', () => {
    for (const id of ['stage-layer', 'float-layer', 'shelf-layer', 'full-layer'] as const) {
      expect(FOCUS_SCOPES[id].kind).toBe('layer')
    }
    /*
     * `popover` 在 modal 这一格(R1 改),理由写在 `scopes.ts` 那一行上:
     * 行为档 `modal` 说的是 **Tab 走不走得出去**,与 ARIA 的 `aria-modal`
     * 不是一个词 —— 而 `ui/Popover` 今天就在圈禁 Tab。
     */
    for (const id of ['dialog', 'menu', 'palette', 'popover'] as const) {
      expect(FOCUS_SCOPES[id].kind).toBe('modal')
    }
    for (const id of ['jumpbar', 'drawer', 'zoom', 'tooltip'] as const) {
      expect(FOCUS_SCOPES[id].kind).toBe('float')
    }
  })
})

describe('答哪些命令:查看器 / 文件树 / 检索面 / 会话总览 / 终端 / 浏览器 / 叶七格', () => {
  it('七格各自答得出哪几条,别的作用域一条都不答', () => {
    expect(focusScopeAnswersOf('viewer').map((a) => a.command)).toEqual([
      'view.save',
      'viewer.gotoLine',
      'view.find',
    ])
    /*
     * **一条 answer,不是两条**(K0)。⌘I 与 ⌘↵ 是同一件事的两个键面,而
     * 「一条命令可以有好几个出厂键」现在由 `defaultCombos` 说得出口 ——
     * 旧表把它写成两行,两行意味着两个意义。
     */
    expect(focusScopeAnswersOf('files').map((a) => a.command)).toEqual(['files.detail'])
    // 检索重建 S4b:⌘[ / ⌘] = 查询历史的后退 / 前进(§4.6,与浏览器地址栏同形)。
    expect(focusScopeAnswersOf('search').map((a) => a.command)).toEqual(['nav.back', 'nav.forward'])
    // 09-04 方向 A:⌘⇧P = 置顶 / 取消置顶活动行。
    expect(focusScopeAnswersOf('expose').map((a) => a.command)).toEqual(['expose.pin'])
    /*
     * T2:终端答一条 `view.find`(出厂 ⌘F)。它与 `claims` 那一族是**反着的**
     * 两句话:那五个键归 PTY,这一条归应用 —— 判词在 `scopes.ts` 的
     * `TERMINAL_ANSWERS` 上。拆掉它 → `gate:terminal` ⑨ 的查找行开不出来。
     */
    expect(focusScopeAnswersOf('terminal').map((a) => a.command)).toEqual(['view.find'])
    /*
     * B2 / B3-a:⌘L 回地址栏 + ⌘F 在这一页里查找。两条同时是**保留键**
     * (`nativeView: 'reserve'` 且这一格答得出 → 键位下沉那张表自动带上),
     * 判词在 `scopes.ts` 的 `BROWSER_ANSWERS` 上。
     */
    expect(focusScopeAnswersOf('browser').map((a) => a.command)).toEqual([
      'browser.address',
      'view.find',
    ])
    // W1 拍点 ④:⌘W 关当前 tab(`app: false` —— 它需要一个目标)。
    expect(focusScopeAnswersOf('leaf').map((a) => a.command)).toEqual(['tab.close'])
    const withAnswers = FOCUS_SCOPE_LIST.filter((s) => (s.answers?.length ?? 0) > 0).map((s) => s.id)
    // 次序 = 表里的声明序(`terminal` 在 region 那一族里,`leaf` 排在它们末尾)。
    expect(withAnswers).toEqual(['viewer', 'files', 'search', 'expose', 'terminal', 'browser', 'leaf'])
  })

  /**
   * **一条命令,三个响应者**(K0 要的那件事)。从前这是三行恰好写着同一个组合;
   * 现在它是一条命令,谁答得出由三块面自述 —— 用户改绑一次,三块面一起跟着。
   * 把 `terminal` 那一行的 `answers` 删掉 → 这一条红(设置页的「谁答」列也少一格)。
   */
  it('`view.find` 有三个响应者,而且三块面各说各的话', () => {
    const says = (scope: 'viewer' | 'terminal' | 'browser') =>
      focusScopeAnswersOf(scope).find((a) => a.command === 'view.find')?.labelKey
    expect(says('viewer')).toBe('viewer.findLabel')
    expect(says('terminal')).toBe('terminal.find')
    expect(says('browser')).toBe('browser.find')
    // 三句话三个键(i18n 纪律),而命令自己那一句是第四个 —— 通名。
    expect(new Set([says('viewer'), says('terminal'), says('browser')]).size).toBe(3)
    expect(findCommand('view.find')?.labelKey).toBe('keymap.find')
  })

  /**
   * **认领**(`claims`):全表唯一一格,而且它与 `answers` 方向相反 ——
   * 那五个键壳不碰,原样交给里面那台 PTY。判词整段在
   * `content/terminal/key-courtesy.ts`;这一条只钉「表上只有终端有、而且它只收
   * `Ctrl+字母`」。
   */
  it('认领表:只有终端一格,五个 Ctrl+字母(Win / Linux 那一档)', () => {
    const withClaims = FOCUS_SCOPE_LIST.filter((s) => (s.claims?.length ?? 0) > 0).map((s) => s.id)
    // 测试跑在 jsdom 上(UA 不是 mac),所以这里是 Win / Linux 那一档。
    expect(withClaims).toEqual(['terminal'])
    expect(focusScopeClaimsOf('terminal').map((c) => c.key)).toEqual(['p', 'e', 'j', 'n', 'w'])
    for (const claim of focusScopeClaimsOf('terminal')) {
      expect(claim.ctrl).toBe(true)
      expect(claim.key).toMatch(/^[a-z]$/)
    }
  })

  it('每条 answer 指的命令在命令表里真有一条(不许有指向空气的自述)', () => {
    for (const spec of FOCUS_SCOPE_LIST) {
      for (const a of spec.answers ?? []) expect(findCommand(a.command), a.command).toBeTruthy()
    }
  })

  it('每条 answer 的说法(覆盖的那一句)也在两本字典里', () => {
    for (const spec of FOCUS_SCOPE_LIST) {
      for (const a of spec.answers ?? []) {
        if (!a.labelKey) continue
        expect(zh[a.labelKey], `zh ${a.command}`).toBeTruthy()
        expect(en[a.labelKey], `en ${a.command}`).toBeTruthy()
      }
    }
  })
})

/*
 * ── 「keymap/scopes 是它的投影」那一组 09-03(R2)退役 ──────────────────────
 * R0 时 `keymap/scopes.ts` 还留着一层兼容投影(`KEY_SCOPES` / `SCOPED_KEYS` /
 * `comboFromChord`,连 `files.row` 这个旧面域 id 都原样发出去),那一组用例守的
 * 正是「投影不许与正本分叉」。R2 把落点也迁进了作用域实例,旧形状一个消费者都
 * 没有了,整层连同那三条用例一起退役 —— **没有第二份声明可对**,这只文件上面
 * 那几组守的就是正本本身。
 *
 * K0 之后连「键位」都不在这张表上了(它们在 `keymap/commands.ts`),所以
 * 「⌘⇧P 与全局的 ⌘P 不是同一个组合」那一条也搬去了 `keymap/__tests__/commands.test.ts`
 * 的全表冲突规则里 —— 那才是它今天的家:两条命令共不共得了一个键,是规则的事。
 */
