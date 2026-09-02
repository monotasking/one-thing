import { FOCUS_SCOPE_LIST } from '../focus/scopes'
import { KEYMAP_COMMANDS, effectiveCombo, sameCombo } from './transitions'
import type { FocusScopeId } from '../focus/types'
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
 * ── 09-02(R0):表搬走了,这只文件成了它的**投影** ────────────────────────
 * 声明的正本现在是 `focus/scopes.ts` 的 `FOCUS_SCOPES` —— 面域局部键本来就是
 * 「作用域自己的键」,而作用域是响应链上的东西,不是快捷键系统里的东西。这只
 * 文件保留下来只做一件事:**把那张表投影成三层立法这一侧的旧形状**,让今天的
 * 读者(设置页的撞键提示、`__tests__/keymap-scopes.test.ts`)一个字都不用改。
 *
 * 投影里唯一一处不是恒等的:旧表把文件树那两条键的面域叫 `files.row`(键长在
 * **行**上),新表归到 `files` 作用域名下 —— 树上不会有「一行」这么细的作用域
 * (行是文件树内部的 roving 目标,不是一块能接键盘的面)。下面那张兼容表把
 * 新 id 翻回旧 id,连 labelKey 都是原来那一条。R2 把落点迁进作用域实例时,
 * 这只文件与那张兼容表一起退役。
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
 * 机制只有一条,而且不需要任何调度器:面域局部键**接住了才 `preventDefault()`**,
 * 而全局派发器开头一句 `if (e.defaultPrevented) return`。于是
 *  · 局部接住 → 全局当场让开(修前是两边都响,那正是 ⌘I 那条留账的病);
 *  · 局部没接(比如查看器里按 ⌘P)→ 事件原样冒到 window,全局照常派发。
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

/**
 * **兼容表**:新作用域 id → 三层立法这一侧的旧面域 id 与旧名字。
 * 只列有局部键的那几格;R2 迁落点时整张表随这只文件退役。
 */
const LEGACY_SCOPE: Partial<Record<FocusScopeId, KeyScopeSpec>> = {
  viewer: { id: 'viewer', labelKey: 'viewer.label' },
  files: { id: 'files.row', labelKey: 'keys.scopeFilesRow' },
}

export const KEY_SCOPES: readonly KeyScopeSpec[] = FOCUS_SCOPE_LIST.filter(
  (spec) => (spec.keys?.length ?? 0) > 0,
).map((spec) => {
  const legacy = LEGACY_SCOPE[spec.id]
  if (!legacy) throw new Error(`[keymap/scopes] ${spec.id} 有局部键却没有旧 id 的兼容行`)
  return legacy
})

export interface ScopedKey {
  scope: KeyScopeId
  combo: Combo
  /** 这个键干什么。设置页的撞键提示与将来的键位速查都读它。 */
  labelKey: MessageKey
}

/**
 * **面域局部键的全表**(从 `FOCUS_SCOPES` 投影)。加一个局部键 = 在**那边**加一行
 * + 在那块面里真接上,两件事缺一个都会被 keymap-scopes 那条测试抓住。
 *
 * `viewer` 那三条与 `content/viewer/keymaps.ts` 的默认档逐条对应(⌘F 是 F2 新加的
 * 查看器局部检索);`files.row` 那两条是文件树行上的行内键。
 */
export const SCOPED_KEYS: readonly ScopedKey[] = FOCUS_SCOPE_LIST.flatMap((spec) =>
  (spec.keys ?? []).map((k) => {
    const legacy = LEGACY_SCOPE[k.scope]
    if (!legacy) throw new Error(`[keymap/scopes] 局部键的作用域 ${k.scope} 没有旧 id 的兼容行`)
    return { scope: legacy.id, combo: k.combo, labelKey: k.labelKey }
  }),
)

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
