import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scopedCollisionsOf } from '../scopes'
import { KEYMAP_COMMANDS, effectiveCombo } from '../transitions'
import { FOCUS_SCOPES, FOCUS_SCOPED_KEYS, focusScopeKeysOf } from '../../focus/scopes'
import type { Combo } from '../types'

/**
 * **快捷键三层立法的守卫**(09-01 报障:「快捷键要分清局部和全局」)。
 *
 * 三层是:① 全局档(KEYMAP_COMMANDS,可改绑)② 面域局部键(scopes.ts 这张表)
 * ③ 行内结构键(方向键 / ↵,不进任何表)。这一组守的是**中间那一层不撒谎**:
 * 表上写着的键,那块面里真接着;那块面接着的键,表上真写着。
 *
 * ── 09-03(R2):对表的**两头都换了** ─────────────────────────────────────
 * 声明那一头从 `keymap/scopes.ts` 的 `SCOPED_KEYS` 换成正本
 * `focus/scopes.ts` 的 `FOCUS_SCOPES[id].keys`(R0 起前者只是后者的投影,
 * R2 把那层兼容表连同 `files.row` 这个旧 id 一起退役);落点那一头从
 * 「那块面根元素上的 keydown」换成**作用域实例注入的 `keyHandlers`**——
 * 而实例只有在那块面真挂起来的时候才有,所以「注入的名单对不对」那一条
 * 落在各自的面里验(`content/__tests__/file-viewer.test.tsx` 与
 * `files-panel.test.tsx` 各有一条,读的是 `focusTree.dump()`),
 * 这只文件守的是**声明这一头**:表本身自洽、撞键说得出口、全局那一侧让位。
 *
 * 反证纪律:把 `FOCUS_SCOPES.viewer.keys` 删掉一行 → 第一条当场红。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.resolve(here, '../..')

function key(combo: Combo): string {
  return [combo.meta || combo.ctrl ? 'mod' : '', combo.shift ? 'shift' : '', combo.alt ? 'alt' : '', combo.key]
    .filter(Boolean)
    .join('+')
}

describe('面域局部键:声明这一头', () => {
  it('今天有局部键的六格:查看器三条、文件树两条、检索面两条、总览一条、终端五条、叶一条', () => {
    const withKeys = Object.values(FOCUS_SCOPES)
      .filter((spec) => (spec.keys?.length ?? 0) > 0)
      .map((spec) => spec.id)
    // 次序 = 表里的声明序(`leaf` 排在 region 那一族的末尾)。
    expect(withKeys).toEqual(['viewer', 'files', 'search', 'expose', 'terminal', 'leaf'])
    /*
     * **T1 的键盘礼让五行**(`content/terminal/key-courtesy.ts`)。它们是这张表
     * 里唯一一族**故意与全局命令撞车**的键:`^P/^E/^J/^N/^W` 在 readline 下是
     * 每天都在按的五个,而出厂全局表恰好用主修饰键占着同样五个字母。
     * 局部先接 → 终端拿到焦点时这五下进 PTY,别处照旧是那五条全局命令。
     * 撞车由下面那条用例逐条说出口(撞车不是错误,但不许静默)。
     */
    expect(focusScopeKeysOf('terminal').map((k) => key(k.combo))).toEqual([
      'mod+p',
      'mod+e',
      'mod+j',
      'mod+n',
      'mod+w',
    ])
    /*
     * W1 拍点 ④:**⌘W 关当前 tab**。它是面域局部键而不是全局命令 —— 判据是
     * 「它需不需要一个目标」(哪一片叶的哪一格)。⌘⇧W 是工作区命令面板,
     * shift 那一格就是两者的分界,下面那条全表零冲突的用例钉着它。
     */
    expect(focusScopeKeysOf('leaf').map((k) => key(k.combo))).toEqual(['mod+w'])
    /*
     * 检索重建 S4b:⌘[ / ⌘] = 查询历史的后退 / 前进(§4.6)。
     * **它们与既有键位不撞** —— 全局命令表与另外三格局部键里都没有这两个组合。
     * 撞了不是错误(设置页会由 `scopedCollisionsOf` 说出来),但不许静默,
     * 所以这一行把「今天不撞」这个事实钉住:哪天有人把某条全局命令改绑到 ⌘[,
     * 下面那条撞键用例会红。
     */
    expect(focusScopeKeysOf('search').map((k) => key(k.combo))).toEqual(['mod+[', 'mod+]'])
    // 09-04 方向 A:⌘⇧P = 置顶 / 取消置顶活动行(⌘P 是全局的 toggle:search,
    // shift 那一格正是两者的分界 —— 撞键表读的就是这一行)。
    expect(focusScopeKeysOf('expose').map((k) => key(k.combo))).toEqual(['mod+shift+p'])
    expect(focusScopeKeysOf('viewer').map((k) => key(k.combo)).sort()).toEqual([
      'mod+f',
      'mod+l',
      'mod+s',
    ])
    // 两条键面同一个动作(⌘I 与 ⌘↵ 都是「详情」)—— **两行,不是一行两键**。
    expect(focusScopeKeysOf('files').map((k) => key(k.combo)).sort()).toEqual([
      'mod+enter',
      'mod+i',
    ])
    expect(focusScopeKeysOf('files').map((k) => k.action)).toEqual(['detail', 'detail'])
  })

  it('每一行都报得出自己属于哪一格,而且那一格真的在表里(不许有无主的声明)', () => {
    for (const scoped of FOCUS_SCOPED_KEYS) {
      expect(FOCUS_SCOPES[scoped.scope]).toBeTruthy()
      expect(FOCUS_SCOPES[scoped.scope].keys).toContain(scoped)
    }
  })

  it('结构键一格都不在表里(§4.3 的封闭裁定:方向键 / ↵ / Space / Tab 不进任何表)', () => {
    /*
     * 这一条是**派发器相位**的前提:R2 之后那唯一的监听跑在**捕获**相位,
     * 它跑在元素级 onKeyDown 之前。之所以仍然抢不走那些键,靠的就是这张表里
     * 一条结构键都没有(唯一的例外 Esc 由树处理,那是设计 §4.3 明写的)。
     * 往表里加一条裸 ↵ / 方向键 → 这一条当场红,而红的正是那个前提。
     */
    for (const scoped of FOCUS_SCOPED_KEYS) {
      const bare = !scoped.combo.meta && !scoped.combo.ctrl && !scoped.combo.alt
      expect(bare).toBe(false)
    }
  })
})

describe('撞键:局部先接,没接住放行全局', () => {
  /*
   * **出厂撞车恰好五条,而且每一条都是有意的**(T1)。
   *
   * T1 之前这里断言的是「零撞车」。那句话随键盘礼让表一起作废,但作废的方式
   * 很重要:不是「多了几条不知道哪来的」,而是**那五条就是礼让表本身** ——
   * 终端拿到焦点时 `^P/^E/^J/^N/^W` 进 PTY,焦点不在终端里时它们照旧是那五条
   * 全局命令。设置页会把这五行说出来(`scopedCollisionsOf` 的唯一消费者)。
   *
   * 查看器的 ⌘S/⌘L/⌘F、文件树的 ⌘I/⌘↵、检索的 ⌘[/⌘]、总览的 ⌘⇧P、叶的 ⌘W
   * **仍然零撞车** —— 这一条把两半都钉住:撞的只有终端那五行,一条不多。
   */
  it('出厂撞车恰好是终端礼让那四行,别的局部键一条都不撞', () => {
    const collisions = scopedCollisionsOf({ overrides: {} })
    expect(collisions.map((c) => c.scoped.scope)).toEqual([
      'terminal',
      'terminal',
      'terminal',
      'terminal',
    ])
    expect(collisions.map((c) => c.command)).toEqual([
      'toggle:search', // ^P ↔ ⌘P 检索面
      'toggle:sessions', // ^E ↔ ⌘E 会话总览
      'agent.menu', // ^J ↔ ⌘J agent 切换器
      'session.new', // ^N ↔ ⌘N 新建会话
    ])
    /*
     * **第五行 `^W` 不在这张表上,而这不是漏网。** `scopedCollisionsOf` 问的是
     * 「全局命令与局部键撞了没有」,而 ⌘W 本来就**不是**全局命令 —— 它是 `leaf`
     * 那一格的局部键(W1 拍点 ④)。所以 `^W` 是一次**局部 ↔ 局部**的撞车,
     * 裁决由活动路径的深度给:终端比装着它的那片叶更深,局部由深到浅问,
     * 终端先接。结果正是要的那个 —— 终端里 `^W` 删一个词,别处 ⌘W 关这一格 tab。
     * 这一句钉住那条深度裁决:哪天 `leaf` 与 `terminal` 的父子关系反了,它会红。
     */
    expect(focusScopeKeysOf('leaf').map((k) => key(k.combo))).toEqual(['mod+w'])
    expect(focusScopeKeysOf('terminal').map((k) => key(k.combo))).toContain('mod+w')
  })

  it('用户把某条命令改绑到 ⌘I:撞车**说得出口**(而不是静默盖住行内键)', () => {
    const state = { overrides: { 'toc.toggle': { meta: true, key: 'i' } as Combo } }
    const collisions = scopedCollisionsOf(state)
    // 终端礼让那五行是出厂就在的(上一条用例钉着),这一条只看**新多出来的那一条**。
    const added = collisions.filter((c) => c.scoped.scope !== 'terminal')
    expect(added.map((c) => c.command)).toEqual(['toc.toggle'])
    expect(added[0].scoped.scope).toBe('files')
    /*
     * 撞车**不是错误**:局部先接、没接住放行,两者可以共存(⌘I 在文件行上开详情,
     * 在别处仍然是那条全局命令)。所以 `bindCombo` 的口径一个字不改 —— 它拦的是
     * 全局与全局的撞车,那种撞车才是真的「有一个按不响」。
     */
    expect(KEYMAP_COMMANDS.some((c) => c.id === 'toc.toggle')).toBe(true)
    expect(effectiveCombo(state, 'toc.toggle')).toEqual({ meta: true, key: 'i' })
  })

  it('派发器开头那句 `defaultPrevented` 就是裁决本身(源码级守卫)', () => {
    /*
     * 「局部先接」现在由**树的深度**保证(局部键由深到浅问,root 的命令表排最后),
     * 而这一句守的是另一半:**别人真接住了就让开**。R2 把派发器合成一个捕获相位
     * 的监听之后它恒为 false(window 捕获是整条传播路径的第一站),但它是一条
     * **契约**不是一处优化 —— 哪天前面再站一个更早的消费者,这一句就是它的出口。
     * 删掉它 = 把那条契约从代码里抹掉。
     */
    const source = readFileSync(path.join(srcRoot, 'focus/dispatch.ts'), 'utf-8')
    expect(source).toMatch(/if \(e\.defaultPrevented\) return/)
  })
})
