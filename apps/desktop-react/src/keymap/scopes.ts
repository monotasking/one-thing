import { FOCUS_SCOPED_KEYS } from '../focus/scopes'
import { KEYMAP_COMMANDS, effectiveCombo, sameCombo } from './transitions'
import type { ScopedKey } from '../focus/types'
import type { CommandId, KeymapState } from './types'

/**
 * **快捷键三层立法**(09-01 用户报障「快捷键要分清局部和全局」后立)。
 *
 * 从前这台壳只承认两种键:进 `KEYMAP_COMMANDS` 的全局命令,和「不进表」的结构
 * 导航键(见 `types.ts` 顶上那段)。中间那一层一直是没名字的:查看器的 ⌘S/⌘L、
 * 文件行的 ⌘I —— 它们**有名字、能撞车、却不在任何一张表里**。F1 那批已经把这条
 * 债记下了(FilesPanel 文件头:「用户把某条命令改绑到 ⌘I,bindCombo 看不见这条
 * 行内键,会静默把它盖住」)。这个文件就是那条债的还款。
 *
 * ── 09-02(R0)→ 09-03(R2):表搬走了,这只文件只剩**撞键那一问** ──────────
 * 声明的正本是 `focus/scopes.ts` 的 `FOCUS_SCOPES` —— 面域局部键本来就是
 * 「作用域自己的键」,而作用域是响应链上的东西,不是快捷键系统里的东西。
 * R0 时这只文件还留着一层投影(把新表翻回旧形状:`KeyScopeId` / `KEY_SCOPES` /
 * `SCOPED_KEYS` / `comboFromChord`,连 `files.row` 这个旧面域 id 都原样发出去),
 * 好让当时的读者一个字不改。R2 把落点也迁进了作用域实例(`keyHandlers`),
 * 旧形状于是一个消费者都没有了 —— 整层兼容表连同 `files.row` 那个 id 一起退役,
 * 这只文件只剩下**一件**别处没有的事:
 *
 *   `scopedCollisionsOf` —— 「用户把某条全局命令改绑到了一个已经被面域局部键
 *   占着的组合上」这句话说给用户听。它读的是正本那张表,不再有第二份数据。
 *
 * ── 三层 ────────────────────────────────────────────────────────────────
 *
 * ① **全局档** —— `KEYMAP_COMMANDS`(transitions.ts)。焦点在哪儿都响,可改绑,
 *    派发器(`dispatch.ts`)是唯一产地。语义:呼出一块面 / 做一件全局的事。
 *
 * ② **面域局部键** —— 就是这张表。焦点落在**那块面的根元素里**才响;监听挂在
 *    面域根上(不是 window),所以它天然先于全局派发器收到这一下(事件先冒泡过
 *    面域根,才到 window)。语义:这块面自己的动作(存这个文件 / 跳这份内容的行)。
 *    **R2 之后**这条「先」不再靠冒泡序,靠活动路径的深度(设计 §4.3)。
 *
 * ③ **行内结构键** —— 方向键 / Enter / Space / Tab / Esc 的 DOM 焦点语义。
 *    **不进任何表**,理由与 `types.ts` 里那段逐字相同:它们是这套语法本身,
 *    一旦可配置,「Esc 就是退一层」这条全局承诺就没了。
 *
 * ── 撞键裁决:局部先接,没接住放行全局 ───────────────────────────────────
 * **R2 起这条「先」不靠冒泡序,靠树的深度**:唯一那个派发器沿活动路径由深到浅
 * 问局部键表,都没命中才轮到全局命令表(`focus/dispatch.ts` 的 ⑧⑨)。
 *  · 局部接住 → 全局当场轮不到(修前是两边都响,那正是 ⌘I 那条留账的病);
 *  · 局部没接(比如查看器里按 ⌘P,或者那一格没交出处理器)→ 落全局命令表。
 *
 * 撞车**说得出口**是这只文件唯一还在做的事:设置页要能讲出「⌘I 已经被文件树
 * 占着」。声明与落点会不会分叉由 `__tests__/keymap-scopes.test.ts`(声明这一头)
 * 与各面自己的用例(落点那一头,读 `focusTree.dump()`)一起钉着。
 */

/**
 * 全局命令与局部键撞在同一个组合上的那些。
 *
 * 撞车**不是错误**:局部先接、没接住放行,两者可以共存(⌘I 在文件行上开详情,
 * 在别处仍然是那条全局命令)。所以这里回的是一张**要说给用户听的表**,不是
 * 一个要拦住写入的判据 —— `bindCombo` 一个字都不改口径(它拦的是全局与全局的
 * 撞车,那种撞车才是真的「有一个按不响」)。
 */
export function scopedCollisionsOf(
  state: KeymapState,
): { command: CommandId; scoped: ScopedKey }[] {
  const out: { command: CommandId; scoped: ScopedKey }[] = []
  for (const command of KEYMAP_COMMANDS) {
    const combo = effectiveCombo(state, command.id)
    if (!combo) continue
    for (const scoped of FOCUS_SCOPED_KEYS) {
      if (sameCombo(combo, scoped.combo)) out.push({ command: command.id, scoped })
    }
  }
  return out
}

