import { STAGE_ITEMS } from '../stage/items'
import type {
  Combo,
  ComboEvent,
  CommandId,
  KeymapCommand,
  KeymapPlatform,
  KeymapState,
  RecordOutcome,
} from './types'

/** persist 档案版本。改这个数就必须在 migrateKeymapPersisted 里加一段,两者同生共死。 */
export const KEYMAP_PERSIST_VERSION = 1

/**
 * 出厂绑定表。只列**有**默认键的那几条,别的一律 null ——
 * 「大多数命令出厂不绑键」是有意的:键位是稀缺资源,预占等于替用户做主。
 *
 * ⌘E 给会话总览:Exposé 的正名(⌘P 在 08-29 那次拍板里归了检索面板,
 * 总览此前借住的那个 ⌘P 键帽同时删掉,这里是它拿回自己的键)。
 */
const DEFAULT_COMBOS: Partial<Record<CommandId, Combo>> = {
  'toggle:search': { meta: true, key: 'p' },
  'expose.toggle': { meta: true, key: 'e' },
  'toc.toggle': { meta: true, shift: true, key: 'o' },
}

/**
 * 命令表 —— **封闭**。加一个命令就是在这里多一行:
 * 每个非 takeover 的 Dock 瓦自动有一条 toggle(所以瓦表长出新瓦时这里不用改),
 * 加上两条不属于任何一块瓦的开关。
 *
 * takeover 的瓦(会话总览)不进 toggle 族 —— 它没有 Placement,
 * 「呼出 / 收回」对它没意义;它的开关就是 expose.toggle 本身。
 */
export const KEYMAP_COMMANDS: KeymapCommand[] = [
  ...STAGE_ITEMS.filter((item) => !item.takeover).map<KeymapCommand>((item) => {
    const id: CommandId = `toggle:${item.id}`
    return { id, labelKey: item.titleKey, defaultCombo: DEFAULT_COMBOS[id] ?? null }
  }),
  {
    id: 'expose.toggle',
    labelKey: 'item.sessions',
    defaultCombo: DEFAULT_COMBOS['expose.toggle'] ?? null,
  },
  { id: 'shelf.right.toggle', labelKey: 'shelf.labelRight', defaultCombo: null },
  // TOC 面板不是 StageItem,但它的开关同样是命令类快捷键(08-29 全称拍板:都可设置)
  { id: 'toc.toggle', labelKey: 'toc.title', defaultCombo: DEFAULT_COMBOS['toc.toggle'] ?? null },
]

export const initialKeymapState: KeymapState = { overrides: {} }

export function findCommand(id: CommandId): KeymapCommand | undefined {
  return KEYMAP_COMMANDS.find((c) => c.id === id)
}

/* ── 键与组合(纯算术,与 state 无关,所以能单独测) ────────────────────────── */

/** KeyboardEvent.key → 规范形。全仓唯一一处规范化,别处不许再 toLowerCase 一次。 */
export function normalizeKey(key: string): string {
  return key.toLowerCase()
}

/** 只按住修饰键不算一个组合 —— 录制态要等真正的那个键。 */
const MODIFIER_KEYS = new Set(['meta', 'control', 'alt', 'shift'])

export function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.has(normalizeKey(key))
}

/**
 * 主修饰键:mac 的 ⌘ 与别处的 Ctrl 是同一个位子。
 * 匹配、冲突判定、录制全都问这一个函数 —— 平台差异只活在 formatCombo 里。
 */
function primaryOf(combo: Combo): boolean {
  return combo.meta === true || combo.ctrl === true
}

/** 两个组合是不是同一个。冲突判定用它,所以 ⌘P 与 Ctrl+P 判为同一个。 */
export function sameCombo(a: Combo, b: Combo): boolean {
  return (
    primaryOf(a) === primaryOf(b) &&
    (a.alt === true) === (b.alt === true) &&
    (a.shift === true) === (b.shift === true) &&
    a.key === b.key
  )
}

/** 一次按键是不是这个组合。修饰键逐位相等 —— 多按一个 Shift 就不是同一条绑定。 */
export function matchCombo(e: ComboEvent, combo: Combo): boolean {
  return (
    primaryOf(combo) === (e.metaKey || e.ctrlKey) &&
    (combo.alt === true) === e.altKey &&
    (combo.shift === true) === e.shiftKey &&
    normalizeKey(e.key) === combo.key
  )
}

/** 一次按键读成组合。只按了修饰键 = null(还不成组合)。false 的位不写进对象。 */
export function comboFromEvent(e: ComboEvent): Combo | null {
  if (isModifierKey(e.key)) return null
  const combo: Combo = { key: normalizeKey(e.key) }
  if (e.metaKey) combo.meta = true
  if (e.ctrlKey) combo.ctrl = true
  if (e.altKey) combo.alt = true
  if (e.shiftKey) combo.shift = true
  return combo
}

/** 一次按键有没有带修饰键。输入框里「无修饰的单键归输入框」那条闸问它。 */
export function hasModifier(e: ComboEvent): boolean {
  return e.metaKey || e.ctrlKey || e.altKey
}

/**
 * 键面字符。这些是**键盘上印的字**,不是界面文案 —— 两种语言里逐字相同,
 * 而且组合由用户当场按出来,不可能预先枚举成字典键。
 */
const KEY_CAPS: Record<string, string> = {
  ' ': 'Space',
  escape: 'Esc',
  enter: '↵',
  tab: 'Tab',
  backspace: '⌫',
  delete: 'Del',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
}

export function keyCap(key: string): string {
  return KEY_CAPS[key] ?? key.toUpperCase()
}

/**
 * 组合 → 一串键面。返回数组而不是一句话,是因为呈现方式是「一枚键帽一个 <Kbd>」——
 * 拼接留给视图,这里只回答「有哪几枚」。顺序固定:主修饰、⌥、⇧、键。
 */
export function formatCombo(combo: Combo, platform: KeymapPlatform): string[] {
  const mac = platform === 'mac'
  const caps: string[] = []
  if (primaryOf(combo)) caps.push(mac ? '⌘' : 'Ctrl')
  if (combo.alt === true) caps.push(mac ? '⌥' : 'Alt')
  if (combo.shift === true) caps.push(mac ? '⇧' : 'Shift')
  caps.push(keyCap(combo.key))
  return caps
}

/* ── 注册表查询 ───────────────────────────────────────────────────────────── */

/**
 * 一条命令**当下**绑的键:覆盖优先,没登记才落到出厂默认。
 * 显式的 null 是「用户解绑了」,它赢过默认 —— 所以这里问的是 `in`,不是真值。
 */
export function effectiveCombo(state: KeymapState, id: CommandId): Combo | null {
  if (id in state.overrides) return state.overrides[id]
  return findCommand(id)?.defaultCombo ?? null
}

/** 这条命令有没有被用户改过 —— 「恢复默认」那颗按钮只在它为真时出现。 */
export function hasOverride(state: KeymapState, id: CommandId): boolean {
  return id in state.overrides
}

/** 一次按键落在哪条命令上。没人认领 = null。 */
export function lookupCommand(state: KeymapState, e: ComboEvent): CommandId | null {
  for (const command of KEYMAP_COMMANDS) {
    const combo = effectiveCombo(state, command.id)
    if (combo && matchCombo(e, combo)) return command.id
  }
  return null
}

/* ── 写入(唯一的写入口,冲突不静默覆盖) ─────────────────────────────────── */

/**
 * 绑一个组合。**已经被别人占着就不写** —— 返回占它的那条命令,由调用方去说话。
 * 静默覆盖是最难查的一类 bug:用户会以为老键还在。
 * 绑到自己身上是恒等成功(再按一次同一个组合不该报「与自己冲突」)。
 */
export function bindCombo(
  state: KeymapState,
  id: CommandId,
  combo: Combo,
): { ok: KeymapState } | { conflict: CommandId } {
  for (const command of KEYMAP_COMMANDS) {
    if (command.id === id) continue
    const other = effectiveCombo(state, command.id)
    if (other && sameCombo(other, combo)) return { conflict: command.id }
  }
  return { ok: { ...state, overrides: { ...state.overrides, [id]: combo } } }
}

/** 解绑:写一条显式的 null。它不是「恢复默认」—— 默认键也不再生效。 */
export function unbindCombo(state: KeymapState, id: CommandId): KeymapState {
  return { ...state, overrides: { ...state.overrides, [id]: null } }
}

/** 恢复默认:把覆盖整条摘掉,重新落回出厂值。 */
export function resetCombo(state: KeymapState, id: CommandId): KeymapState {
  if (!(id in state.overrides)) return state
  const overrides = { ...state.overrides }
  delete overrides[id]
  return { ...state, overrides }
}

/* ── 录制态 ───────────────────────────────────────────────────────────────── */

/**
 * 录制态里一次按键该怎么读。四条分支,一条不多:
 *  Esc 取消 / Backspace 与 Delete 解绑 / 只按修饰键继续等 / 别的就是这一下要绑的组合。
 */
export function recordKey(e: ComboEvent): RecordOutcome {
  const key = normalizeKey(e.key)
  if (key === 'escape') return { kind: 'cancel' }
  if (key === 'backspace' || key === 'delete') return { kind: 'unbind' }
  const combo = comboFromEvent(e)
  if (!combo) return { kind: 'ignore' }
  return { kind: 'bind', combo }
}

/* ── 平台 / persist ───────────────────────────────────────────────────────── */

/** 纯函数不许读 navigator,所以「这是什么机器」由调用方量一次递进来。 */
export function platformOf(ua: string): KeymapPlatform {
  return /mac|iphone|ipad/i.test(ua) ? 'mac' : 'other'
}

/**
 * persist 迁移。version 1 是第一版档案,没有更老的形状要往上补,
 * 所以这里是「放行」而不是「空实现」—— 它存在是为了下一版有地方落笔。
 */
export function migrateKeymapPersisted(persisted: unknown, _version: number): unknown {
  return persisted
}
