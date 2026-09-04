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
  it('今天有局部键的四格:查看器三条、文件树两条、会话总览一条、叶一条', () => {
    const withKeys = Object.values(FOCUS_SCOPES)
      .filter((spec) => (spec.keys?.length ?? 0) > 0)
      .map((spec) => spec.id)
    // 次序 = 表里的声明序(`leaf` 排在 region 那一族的末尾)。
    expect(withKeys).toEqual(['viewer', 'files', 'expose', 'leaf'])
    /*
     * W1 拍点 ④:**⌘W 关当前 tab**。它是面域局部键而不是全局命令 —— 判据是
     * 「它需不需要一个目标」(哪一片叶的哪一格)。⌘⇧W 是工作区命令面板,
     * shift 那一格就是两者的分界,下面那条全表零冲突的用例钉着它。
     */
    expect(focusScopeKeysOf('leaf').map((k) => key(k.combo))).toEqual(['mod+w'])
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
  it('出厂表下 ⌘I / ⌘F 都没有全局命令占着 —— 今天零撞车', () => {
    expect(scopedCollisionsOf({ overrides: {} })).toEqual([])
  })

  it('用户把某条命令改绑到 ⌘I:撞车**说得出口**(而不是静默盖住行内键)', () => {
    const state = { overrides: { 'toc.toggle': { meta: true, key: 'i' } as Combo } }
    const collisions = scopedCollisionsOf(state)
    expect(collisions.map((c) => c.command)).toEqual(['toc.toggle'])
    expect(collisions[0].scoped.scope).toBe('files')
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
