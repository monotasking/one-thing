import type { Combo } from '../../keymap/types'

/**
 * 待办编辑区**正在编辑时**认领的键(`FOCUS_SCOPES.todo.claims`,实例侧 `claiming` 开关)。
 *
 * 认领 = 「这几个键归编辑区,壳别碰」:派发器命中时不跑命令、不 `preventDefault`,事件照常落到
 * 编辑区的 `onKeyDown`,由光标控制器处理(`content/editing/caret-controller.ts`)。
 *
 * 为什么要认领:这几个组合在命令表里有应用层兜底或别的面的含义 —— ⌘E 是会话总览、
 * ⌘Z / ⇧⌘Z / ⌘A 是应用菜单 Edit 那几个角色、⌘↑ ⌘↓ 在别的面是跳首尾。编辑一段文字时,
 * 它们应该是加行内码、撤销、全选这一项、跳到全文首尾。不编辑时不认领(`claiming` 为 false),
 * 一切照旧。
 *
 * 只收「编辑时有定义」的那几个;⌘⌥ 方向键(四条架子)不收,那是窗口级的手势。
 */
export const TODO_EDITOR_CLAIMS: readonly Combo[] = [
  { meta: true, key: 'b' },
  { meta: true, key: 'i' },
  { meta: true, key: 'e' },
  { meta: true, key: 'z' },
  { meta: true, shift: true, key: 'z' },
  { meta: true, key: 'a' },
  { meta: true, key: 'arrowup' },
  { meta: true, key: 'arrowdown' },
  { meta: true, key: 'arrowleft' },
  { meta: true, key: 'arrowright' },
  { meta: true, shift: true, key: 'arrowup' },
  { meta: true, shift: true, key: 'arrowdown' },
  { meta: true, key: 'enter' },
]
