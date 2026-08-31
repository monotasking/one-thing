import { KEYMAP_COMMANDS, effectiveCombo, sameCombo } from './transitions'
import type { Combo, CommandId, KeymapState } from './types'
import type { MessageKey } from '../i18n'

/**
 * **快捷键三层立法**(09-01 用户报障「快捷键要分清局部和全局」后立)。
 *
 * 从前这台壳只承认两种键:进 `KEYMAP_COMMANDS` 的全局命令,和「不进表」的结构
 * 导航键(见 `types.ts` 顶上那段)。中间那一层一直是没名字的:查看器的 ⌘S/⌘L、
 * 文件行的 ⌘I —— 它们**有名字、能撞车、却不在任何一张表里**。F1 那批已经把这条
 * 债记下了(FilesPanel 文件头:「用户把某条命令改绑到 ⌘I,bindCombo 看不见这条
 * 行内键,会静默把它盖住」)。这个文件就是那条债的还款。
 *
 * ── 三层 ────────────────────────────────────────────────────────────────
 *
 * ① **全局档** —— `KEYMAP_COMMANDS`(transitions.ts)。焦点在哪儿都响,可改绑,
 *    派发器(`dispatch.ts`)是唯一产地。语义:呼出一块面 / 做一件全局的事。
 *
 * ② **面域局部键** —— 就是这张表。焦点落在**那块面的根元素里**才响;监听挂在
 *    面域根上(不是 window),所以它天然先于全局派发器收到这一下(事件先冒泡过
 *    面域根,才到 window)。语义:这块面自己的动作(存这个文件 / 跳这份内容的行)。
 *
 * ③ **行内结构键** —— 方向键 / Enter / Space / Tab / Esc 的 DOM 焦点语义。
 *    **不进任何表**,理由与 `types.ts` 里那段逐字相同:它们是这套语法本身,
 *    一旦可配置,「Esc 就是退一层」这条全局承诺就没了。
 *
 * ── 撞键裁决:局部先接,没接住放行全局 ───────────────────────────────────
 * 机制只有一条,而且不需要任何调度器:面域局部键**接住了才 `preventDefault()`**,
 * 而全局派发器开头一句 `if (e.defaultPrevented) return`。于是
 *  · 局部接住 → 全局当场让开(修前是两边都响,那正是 ⌘I 那条留账的病);
 *  · 局部没接(比如查看器里按 ⌘P)→ 事件原样冒到 window,全局照常派发。
 * 「先」由 DOM 的冒泡序保证,不由谁去排一张优先级表 —— 那种表会和真实的
 * 挂载顺序分叉。
 *
 * ── 这张表为什么是**声明**而不是注册 ─────────────────────────────────────
 * 局部键真正的落点在各自那块面里(查看器的 `keymaps.ts` / 文件行的 onKeyDown),
 * 表在这里是为了两件事:**一处查得全**(设置页要能说出「⌘I 已经被文件行占着」),
 * 与**撞车说得出口**(`scopedCollisionsOf`)。两处会不会分叉?由
 * `__tests__/keymap-scopes.test.ts` 逐条比对查看器注册表钉着 —— 声明与落点对不上
 * 当场红,而不是等用户按下去才发现。
 */

/** 面域 id。它同时是那块面根元素上 `data-key-scope` 的值(门与单测按它取件)。 */
export type KeyScopeId = 'viewer' | 'files.row'

export interface KeyScopeSpec {
  id: KeyScopeId
  /** 面域名是界面文案,所以只持有 key(同 StageItemSpec.titleKey 的判例)。 */
  labelKey: MessageKey
}

export const KEY_SCOPES: readonly KeyScopeSpec[] = [
  { id: 'viewer', labelKey: 'viewer.label' },
  { id: 'files.row', labelKey: 'keys.scopeFilesRow' },
]

export interface ScopedKey {
  scope: KeyScopeId
  combo: Combo
  /** 这个键干什么。设置页的撞键提示与将来的键位速查都读它。 */
  labelKey: MessageKey
}

/**
 * **面域局部键的全表**。加一个局部键 = 在这里加一行 + 在那块面里真接上,
 * 两件事缺一个都会被 keymap-scopes 那条测试抓住。
 *
 * `viewer` 那三条与 `content/viewer/keymaps.ts` 的默认档逐条对应(⌘F 是 F2 新加的
 * 查看器局部检索);`files.row` 那两条是文件树行上的行内键 —— 它们从前是
 * FilesPanel 文件头里的一段留账,现在是表里的两行。
 */
export const SCOPED_KEYS: readonly ScopedKey[] = [
  { scope: 'viewer', combo: { meta: true, key: 's' }, labelKey: 'viewer.save' },
  { scope: 'viewer', combo: { meta: true, key: 'l' }, labelKey: 'viewer.jumpLabel' },
  { scope: 'viewer', combo: { meta: true, key: 'f' }, labelKey: 'viewer.findLabel' },
  { scope: 'files.row', combo: { meta: true, key: 'i' }, labelKey: 'files.detailAction' },
  { scope: 'files.row', combo: { meta: true, key: 'enter' }, labelKey: 'files.detailAction' },
]

export function scopedKeysOf(scope: KeyScopeId): ScopedKey[] {
  return SCOPED_KEYS.filter((k) => k.scope === scope)
}

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
    for (const scoped of SCOPED_KEYS) {
      if (sameCombo(combo, scoped.combo)) out.push({ command: command.id, scoped })
    }
  }
  return out
}

/**
 * 查看器键位表那种写法(`mod+s` / `mod+shift+l`)→ Combo。
 *
 * 它只服务**对表**(测试拿它把两处的写法折成同一种形状再比),不参与匹配 ——
 * 查看器自己那条路走的是 `registry.commandFor`,一个字都不经过这里。
 */
export function comboFromChord(chord: string): Combo {
  const parts = chord.split('+')
  const key = parts[parts.length - 1]
  const combo: Combo = { key }
  if (parts.includes('mod')) combo.meta = true
  if (parts.includes('shift')) combo.shift = true
  if (parts.includes('alt')) combo.alt = true
  return combo
}
