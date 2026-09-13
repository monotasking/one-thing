import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { answerersOf, claimantsOf } from '../scopes'
import { KEYMAP_COMMANDS, effectiveCombos, sameCombo, sharedChordOf } from '../transitions'
import { FOCUS_SCOPES, focusScopeAnswersOf } from '../../focus/scopes'
import type { Combo, CommandId } from '../types'
import type { FocusScopeId } from '../../focus/types'

/**
 * **旧表 ↔ 新表的比对表**(K0 的交卷凭据,派工单 §9)。
 *
 * K0 之前「面域局部键」是一张 `(scope, combo, action)` 的表,散在
 * `focus/scopes.ts` 的七格 `keys` 与 `content/terminal/key-courtesy.ts` 里;
 * K0 之后它是**命令表的九行**加**七格 `answers`**加**一格 `claims`**。
 * 这一组把旧表**逐条写成字面量**,再证明新表里每一条都有唯一的落点 ——
 * 一条不许少、一个键不许变、一块面不许换人。
 *
 * 为什么是字面量而不是从新表反算:反算等于拿新表证明新表。旧表今天已经不在
 * 代码里了,所以它只能以「上一版真实的样子」这个形式存在 —— 下面那张
 * `LEGACY_ROWS` 就是 2026-09-12 K0 开工前 `git show HEAD` 里的那十六行。
 *
 * 反证纪律:把 `FOCUS_SCOPES.terminal.answers` 删掉 → 第一条红;把
 * `files.detail` 的 `defaultCombos` 砍成一个 → 第二条红。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.resolve(here, '../..')

function key(combo: Combo): string {
  return [combo.meta || combo.ctrl ? 'mod' : '', combo.shift ? 'shift' : '', combo.alt ? 'alt' : '', combo.key]
    .filter(Boolean)
    .join('+')
}

/**
 * **K0 开工前那张表,逐字**(`(scope, combo, action)`),外加它今天的落点
 * `(command, responder)`。十一行局部键 + 五行终端礼让 = 十六行。
 */
const LEGACY_ROWS: ReadonlyArray<{
  scope: FocusScopeId
  chord: string
  action: string
  /** 今天这一行落在哪条命令上;`null` = 它不再是命令(改成了认领)。 */
  command: CommandId | null
}> = [
  { scope: 'viewer', chord: 'mod+s', action: 'save', command: 'view.save' },
  { scope: 'viewer', chord: 'mod+l', action: 'jump', command: 'viewer.gotoLine' },
  { scope: 'viewer', chord: 'mod+f', action: 'find', command: 'view.find' },
  { scope: 'files', chord: 'mod+i', action: 'detail', command: 'files.detail' },
  { scope: 'files', chord: 'mod+enter', action: 'detail', command: 'files.detail' },
  { scope: 'search', chord: 'mod+[', action: 'history.back', command: 'nav.back' },
  { scope: 'search', chord: 'mod+]', action: 'history.forward', command: 'nav.forward' },
  { scope: 'expose', chord: 'mod+shift+p', action: 'pin.toggle', command: 'expose.pin' },
  { scope: 'leaf', chord: 'mod+w', action: 'closeTab', command: 'tab.close' },
  { scope: 'browser', chord: 'mod+l', action: 'address', command: 'browser.address' },
  { scope: 'browser', chord: 'mod+f', action: 'find', command: 'view.find' },
  { scope: 'terminal', chord: 'mod+f', action: 'find', command: 'view.find' },
  // 礼让五行:K0 起它们是 `claims`,**不是命令** —— 所以 command 那一格是 null。
  { scope: 'terminal', chord: 'mod+p', action: 'pty:p', command: null },
  { scope: 'terminal', chord: 'mod+e', action: 'pty:e', command: null },
  { scope: 'terminal', chord: 'mod+j', action: 'pty:j', command: null },
  { scope: 'terminal', chord: 'mod+n', action: 'pty:n', command: null },
  { scope: 'terminal', chord: 'mod+w', action: 'pty:w', command: null },
]

describe('比对表:旧表每一条在新表里都有唯一的落点', () => {
  it('十二条局部键 → 九条命令 + 七格 `answers`,键位逐字不变', () => {
    const factory = { overrides: {} }
    for (const row of LEGACY_ROWS) {
      if (row.command === null) continue
      // ① 那块面今天答得出这条命令(响应者那一头)。
      const answers = focusScopeAnswersOf(row.scope).map((a) => a.command)
      expect(answers, `${row.scope} 该答 ${row.command}`).toContain(row.command)
      // ② 这条命令今天绑着那个键(键位那一头,出厂档)。
      const chords = effectiveCombos(factory, row.command).map(key)
      expect(chords, `${row.command} 该绑着 ${row.chord}`).toContain(row.chord)
    }
  })

  it('`files.detail` 一条命令**两个**出厂键(旧表的两行合成了一行)', () => {
    const chords = effectiveCombos({ overrides: {} }, 'files.detail').map(key)
    expect(chords).toEqual(['mod+i', 'mod+enter'])
    // 旧表那两行的 action 是同一个字,所以它们本来就是一件事。
    const legacy = LEGACY_ROWS.filter((r) => r.scope === 'files')
    expect(new Set(legacy.map((r) => r.action)).size).toBe(1)
  })

  it('`view.find` 收编了三块面各写一遍的那三行(一条命令,三个响应者)', () => {
    const legacy = LEGACY_ROWS.filter((r) => r.command === 'view.find')
    expect(legacy.map((r) => r.scope)).toEqual(['viewer', 'browser', 'terminal'])
    // 三行的键逐字相同 —— 那正是「它本该是一条命令」的证据。
    expect(new Set(legacy.map((r) => r.chord))).toEqual(new Set(['mod+f']))
    expect(answerersOf('view.find').map((a) => a.scope).sort()).toEqual([
      'browser',
      'terminal',
      'viewer',
    ])
  })

  it('礼让那五行改成了认领(K0 一个键都没变;K2 换了一格),而且不再是命令', () => {
    const legacy = LEGACY_ROWS.filter((r) => r.command === null)
    expect(legacy.map((r) => r.chord)).toEqual(['mod+p', 'mod+e', 'mod+j', 'mod+n', 'mod+w'])
    const claims = (FOCUS_SCOPES.terminal.claims ?? []).map(key)
    /*
     * **K0 那一版逐字相等,K2 换了一格**:`mod+p` 出去(检索面让出 ⌘P,于是
     * `Ctrl+P` 不再与任何命令抢键,它本来就到得了 PTY)、`mod+t` 进来(⌘T
     * `tab.new` 占了一个字母,而 `^T` 在 readline 下是交换前后两个字符)。
     * 判据一个字没改 —— 变的是被判的那张出厂表,判词在 `key-courtesy.ts` 上。
     */
    expect(new Set(claims)).toEqual(new Set(['mod+e', 'mod+j', 'mod+n', 'mod+w', 'mod+t']))
    expect(new Set(claims)).not.toContain('mod+p')
    // 它们不在命令表上(认领不是命令,不进设置页的改绑表)。
    for (const claim of FOCUS_SCOPES.terminal.claims ?? []) {
      const asCommand = KEYMAP_COMMANDS.find((c) =>
        effectiveCombos({ overrides: {} }, c.id).some((combo) => sameCombo(combo, claim)),
      )
      // 撞得上的只会是**本来就占着那个字母**的那几条全局命令,不是一条新长出来的。
      expect(
        asCommand === undefined ||
          ['toggle:sessions', 'agent.menu', 'tab.close', 'tab.new', 'content.new'].includes(
            asCommand.id,
          ),
      ).toBe(true)
    }
  })

  /*
   * **K0 那九条一条不多、一条不少**;K2 在它们之后又加了一族(标签),而那一族
   * 与旧表无关 —— 所以这一条改成「前九条逐字相等 ∧ 它们恰好就是旧表那十六行
   * 归出来的集合」,后面新长出来的逐条列在下面那一句里。这样既守住了 K0 的
   * 「没多长出来」,也不会在每次加一条命令时无声失效。
   */
  it('K0 那九条跟随焦点的命令一条不多,K2 之后新长出来的是标签族', () => {
    const scoped = KEYMAP_COMMANDS.filter((c) => !c.app).map((c) => c.id)
    const fromLegacy = new Set(LEGACY_ROWS.map((r) => r.command).filter(Boolean))
    expect(scoped.slice(0, 9)).toEqual([
      'view.find',
      'view.save',
      'viewer.gotoLine',
      'browser.address',
      'files.detail',
      'nav.back',
      'nav.forward',
      'expose.pin',
      'tab.close',
    ])
    expect(new Set(scoped.slice(0, 9))).toEqual(fromLegacy)
    expect(scoped.slice(9)).toEqual([
      'tab.new',
      'content.new',
      'tab.reopen',
      'tab.next',
      'tab.prev',
      ...Array.from({ length: 9 }, (_, i) => `tab.select:${i + 1}`),
    ])
  })
})

describe('结构键一格都不在表里(§4.3 的封闭裁定)', () => {
  it('每一条出厂绑定都带修饰键 —— 方向键 / ↵ / Space / Tab 不进任何表', () => {
    /*
     * 这一条是**派发器相位**的前提:那唯一的监听跑在**捕获**相位,它跑在元素级
     * onKeyDown 之前。之所以仍然抢不走那些键,靠的就是命令表里一条裸结构键都
     * 没有(唯一的例外 Esc 由树处理,那是设计 §4.3 明写的)。
     * 往表里加一条裸 ↵ / 方向键 → 这一条当场红,而红的正是那个前提。
     */
    for (const command of KEYMAP_COMMANDS) {
      for (const combo of effectiveCombos({ overrides: {} }, command.id)) {
        /*
         * K2:`offHand` **也是一枚修饰键**(mac 的 ⌃、Win / Linux 的 Win 键)——
         * 漏掉它的话 ⌃Tab 会被读成「一条裸 Tab」,这一条当场假红,而假红比不测
         * 更糟:下一个人会把它删掉。
         */
        const bare = !combo.meta && !combo.ctrl && !combo.alt && !combo.offHand
        expect(bare, `${command.id} ${key(combo)}`).toBe(false)
      }
    }
  })
})

describe('共键与认领:合法,但不许静默', () => {
  /**
   * **⌘L 上两条命令**(浏览器的地址栏 / 查看器的跳行)。它们合法 —— 冲突规则
   * 批的是「作用域集合两两不交」,而 browser 与 viewer 不会同在一条活动路径上。
   * 设置页据此说一句「与「跳转到」共用这个键(不同时在场)」。
   */
  it('⌘L:两条命令共用,两边都说得出对方', () => {
    const state = { overrides: {} }
    expect(sharedChordOf(state, 'browser.address')).toEqual(['viewer.gotoLine'])
    expect(sharedChordOf(state, 'viewer.gotoLine')).toEqual(['browser.address'])
  })

  /**
   * **认领那一句,K0 之前是 `scopedCollisionsOf` 说的**(它列出「全局命令与面域
   * 局部键撞在同一个组合上」的那几行,出厂档下正好是终端礼让的四行)。
   * 那只函数退役,这句话改由 `claimantsOf` 说 —— 而且比从前多说一条:
   * `tab.close`(⌘W)从前不是全局命令,所以旧表说不出它的 `^W`。
   */
  /*
   * **K2 起换了一格**:`toggle:search` 出去(它的出厂键从 ⌘P 改成 ⌘⇧F,
   * 09-12 裁定 3,于是终端认领的 `^P` 不再与任何一条命令共键),`tab.new` 进来
   * (⌘T);⌘N 那一行还在,只是命令换了名字(`session.new` → `content.new`)。
   */
  it('出厂档下「这个键在终端里归 PTY」恰好五条,一条都不静默', () => {
    const state = { overrides: {} }
    const claimed = KEYMAP_COMMANDS.filter((c) => claimantsOf(state, c.id).length > 0).map((c) => c.id)
    expect(claimed).toEqual([
      'toggle:sessions', // ^E ↔ ⌘E 会话总览
      'agent.menu', // ^J ↔ ⌘J agent 切换器
      'tab.close', // ^W ↔ ⌘W 关当前 tab(K0 起它也是一条命令,所以也说得出口)
      'tab.new', // ^T ↔ ⌘T 同类再开一格(K2 新长出来的那一格)
      'content.new', // ^N ↔ ⌘N 新建这一种内容(K2 之前是 `session.new`,次序随表)
    ])
    for (const id of claimed) expect(claimantsOf(state, id)).toEqual(['terminal'])
  })

  it('用户把某条命令改绑到 ⌘I:共键**说得出口**(而不是静默盖住文件树那一条)', () => {
    const state = { overrides: { 'toc.toggle': [{ meta: true, key: 'i' }] as Combo[] } }
    expect(sharedChordOf(state, 'toc.toggle')).toEqual(['files.detail'])
    /*
     * 共键**不是错误**:局部先接、没接住放行,两者可以共存(⌘I 在文件树里开详情,
     * 在别处仍然是那条全局命令)。规则拦的是「一个键上两条全局命令」与「两条
     * 可能同时在场的命令」,这一对两条都不是。
     */
    expect(effectiveCombos(state, 'toc.toggle')).toEqual([{ meta: true, key: 'i' }])
  })

  it('每一条 answer 的 labelKey 说得出人话(设置页的「谁答」列读它)', () => {
    for (const command of KEYMAP_COMMANDS) {
      for (const a of answerersOf(command.id)) {
        expect(FOCUS_SCOPES[a.scope], `${command.id} → ${a.scope}`).toBeTruthy()
        expect(a.labelKey).toBeTruthy()
      }
    }
  })

  it('派发器开头那句 `defaultPrevented` 就是裁决本身(源码级守卫)', () => {
    /*
     * 「局部先接」由**树的深度**保证(响应者由深到浅问,应用层兜底排最后),
     * 而这一句守的是另一半:**别人真接住了就让开**。R2 把派发器合成一个捕获相位
     * 的监听之后它恒为 false(window 捕获是整条传播路径的第一站),但它是一条
     * **契约**不是一处优化 —— 哪天前面再站一个更早的消费者,这一句就是它的出口。
     * 删掉它 = 把那条契约从代码里抹掉。
     */
    const source = readFileSync(path.join(srcRoot, 'focus/dispatch.ts'), 'utf-8')
    expect(source).toMatch(/if \(e\.defaultPrevented\) return/)
  })
})
