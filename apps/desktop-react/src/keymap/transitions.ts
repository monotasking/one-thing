import { SESSIONS_ITEM_ID, STAGE_ITEMS } from '../stage/items'
import type { ShelfSide } from '../stage/types'
import { WORKSPACE_SLOT_COUNT } from '../workspace/types'
import type { MessageKey } from '../i18n'
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
export const KEYMAP_PERSIST_VERSION = 2

/** toggle 族的 id 前缀。派发器按它分流,迁移按它铸新 id —— 全仓只此一处字面量。 */
export const TOGGLE_COMMAND_PREFIX = 'toggle:'

export function toggleCommandId(itemId: string): CommandId {
  return `${TOGGLE_COMMAND_PREFIX}${itemId}`
}

/** 工作区序号直达那一族的 id 前缀。派发器按它分流 —— 全仓唯一一处字面量。 */
export const WORKSPACE_SLOT_COMMAND_PREFIX = 'workspace.slot:'

/**
 * 序号直达那三条在设置页里的名字。命令名是**界面文案**,所以只持有 key
 * (同 StageItemSpec.titleKey 的判例);三条各一句而不是一句带 {n},
 * 是因为 KeymapCommand.labelKey 这一格不带插值 —— 加插值要动整张注册表。
 * 长度必须等于 WORKSPACE_SLOT_COUNT,由 __tests__/keymap-workspace.test.ts 钉住。
 */
const WORKSPACE_SLOT_LABEL_KEYS: MessageKey[] = [
  'workspace.slot1',
  'workspace.slot2',
  'workspace.slot3',
]

export function workspaceSlotCommandId(slot: number): CommandId {
  return `${WORKSPACE_SLOT_COMMAND_PREFIX}${slot}`
}

/**
 * 退役的命令 id。它只作为**老档案里的一个键**存在(v2 迁移读它、改挂它),
 * 不再是这套注册表认识的命令 —— 会话总览去接管化之后,它的开关就是它自己那条 toggle。
 */
const RETIRED_EXPOSE_TOGGLE_ID = 'expose.toggle'

/**
 * 出厂绑定表。只列**有**默认键的那几条,别的一律 null ——
 * 「大多数命令出厂不绑键」是有意的:键位是稀缺资源,预占等于替用户做主。
 *
 * ⌘E 给会话总览那块瓦(⌘P 在 08-29 那次拍板里归了检索面板),
 * ⌘J 给顶栏那枚 agent 切换器(08-30 拍板)。
 * ⌘N 给新建会话 —— 这一条是**跨应用惯例**(新建文档 / 新建标签页),
 * 预占它不算替用户做主,不给它才是。
 * ⌘⇧W 给工作区命令面板、⌘1/2/3 给前三个工作区的直达(08-31 切换器 v1 拍板)。
 *
 * ── ⌘⇧O 撞键已解(08-31 用户裁定)─────────────────────────────────────────
 * 那次撞车是这样来的:目录面板的 ⌘⇧O 在先(08-29),工作区命令面板的 ⌘⇧O 是
 * 08-31 拍板点名的键。出厂表这一层**没有冲突检查**(`bindCombo` 只拦用户改绑),
 * 而 `lookupCommand` 按 KEYMAP_COMMANDS 的次序取第一个命中 —— 于是次序成了裁决,
 * `toc.toggle` 的出厂键当下按不响。
 *
 * 裁定走的是「工作区面板改一个键」那条:**⌘⇧W**(W = workspace,好记;
 * 与 ⌘W 关窗那条跨应用惯例不同键,不受影响),⌘⇧O 原样还给目录。
 * 于是次序不再决定任何一个键的去向 —— 下面命令表里那段排序注释也跟着改了。
 *
 * 工作区**总览**没有、也不再要独立快捷键:单击那块瓦即达,快切面板里还有一条
 * 「打开总览」的入口。两个入口够了,第三个只是在花键位预算。
 * ──────────────────────────────────────────────────────────────────────────
 */
/**
 * 四条架子的**收 / 展**命令(09-01 用户放权:「四条架子的快捷键」)。
 *
 * ── 键位:⌘⌥ + 那个方向的箭头 ────────────────────────────────────────────
 * **方向即语义**,不用记 —— 左架子是 ⌘⌥←,底架子是 ⌘⌥↓。施工前跑过全表冲突
 * 检查(9 条出厂全局键 + 5 条面域局部键,`shelf-commands.test.ts` 把这条检查
 * 钉成了断言):四个组合**一条都不撞**,而且这台壳出厂表里此前一个带 ⌥ 的键
 * 都没有,所以这一族是干净地长出来的,没有挤掉谁。
 *
 * 行内结构键(裸方向键的焦点语义)也不受影响:那一层根本不看修饰键,
 * 而这四条必须同时按住 ⌘ 与 ⌥。
 *
 * ── 为什么是折叠而不是关整栏 ─────────────────────────────────────────────
 * 语义写在 `types.ts` 的命令族注释里:关整栏会把架子上的瓦全收回 Dock,
 * 那是**有后果**的;折叠是可逆的,按同一个键就回来。
 */
const SHELF_TOGGLE_LABELS: Array<{ side: ShelfSide; labelKey: MessageKey; combo: Combo }> = [
  { side: 'left', labelKey: 'shelf.labelLeft', combo: { meta: true, alt: true, key: 'arrowleft' } },
  { side: 'right', labelKey: 'shelf.labelRight', combo: { meta: true, alt: true, key: 'arrowright' } },
  { side: 'bottom', labelKey: 'shelf.labelBottom', combo: { meta: true, alt: true, key: 'arrowdown' } },
  { side: 'top', labelKey: 'shelf.labelTop', combo: { meta: true, alt: true, key: 'arrowup' } },
]

/** 架子命令 id。**全仓唯一一处**这个字符串的拼法(派发器按它反解出哪一侧)。 */
export function shelfToggleCommandId(side: ShelfSide): CommandId {
  return `shelf.${side}.toggle`
}

/** 架子命令 id → 哪一侧。认不出就是 null —— 派发器据此放行,不去猜。 */
export function shelfSideOfCommand(id: CommandId): ShelfSide | null {
  const found = SHELF_TOGGLE_LABELS.find((row) => shelfToggleCommandId(row.side) === id)
  return found?.side ?? null
}

const SHELF_TOGGLE_COMMANDS: KeymapCommand[] = SHELF_TOGGLE_LABELS.map((row) => ({
  id: shelfToggleCommandId(row.side),
  labelKey: row.labelKey,
  defaultCombo: row.combo,
}))

const DEFAULT_COMBOS: Partial<Record<CommandId, Combo>> = {
  'toggle:search': { meta: true, key: 'p' },
  [toggleCommandId(SESSIONS_ITEM_ID)]: { meta: true, key: 'e' },
  'toc.toggle': { meta: true, shift: true, key: 'o' },
  'agent.menu': { meta: true, key: 'j' },
  'session.new': { meta: true, key: 'n' },
  'workspace.palette': { meta: true, shift: true, key: 'w' },
  [workspaceSlotCommandId(1)]: { meta: true, key: '1' },
  [workspaceSlotCommandId(2)]: { meta: true, key: '2' },
  [workspaceSlotCommandId(3)]: { meta: true, key: '3' },
}

/**
 * 工作区序号直达的命令行。**三条是键位预算,不是能力上限** ——
 * 第四个工作区照样能切(菜单 / 面板 / 总览三处都在),只是没有直达键。
 * 数目由 WORKSPACE_SLOT_COUNT 说了算,这里不写死一个 3。
 */
const WORKSPACE_SLOT_COMMANDS: KeymapCommand[] = Array.from(
  { length: WORKSPACE_SLOT_COUNT },
  (_, i): KeymapCommand => {
    const id = workspaceSlotCommandId(i + 1)
    return { id, labelKey: WORKSPACE_SLOT_LABEL_KEYS[i], defaultCombo: DEFAULT_COMBOS[id] ?? null }
  },
)

/**
 * 命令表 —— **封闭**。加一个命令就是在这里多一行:
 * 每块 Dock 瓦自动有一条 toggle(所以瓦表长出新瓦时这里不用改),
 * 加上两条不属于任何一块瓦的开关。
 *
 * 会话总览也在瓦那一族里:它有 Placement,「呼出 / 收回」对它和别的瓦是同一句话。
 */
export const KEYMAP_COMMANDS: KeymapCommand[] = [
  ...STAGE_ITEMS.map<KeymapCommand>((item) => {
    const id = toggleCommandId(item.id)
    return { id, labelKey: item.titleKey, defaultCombo: DEFAULT_COMBOS[id] ?? null }
  }),
  ...SHELF_TOGGLE_COMMANDS,
  /*
   * 工作区那一族排在 toc.toggle 之前,现在**只是排版**了 —— 从前不是:
   * 两者出厂键都是 ⌘⇧O 时,这个次序就是那次撞车的裁决。08-31 工作区面板改到
   * ⌘⇧W 之后出厂表里再没有两条命令共用一个组合,次序不决定任何一个键的去向。
   * 「不再撞键」由 workspace-commands.test.ts 钉着(它守的是全表两两不同,
   * 而不是某一对谁赢 —— 后者会在下次加键时无声地失效)。
   */
  {
    id: 'workspace.palette',
    labelKey: 'workspace.paletteLabel',
    defaultCombo: DEFAULT_COMBOS['workspace.palette'] ?? null,
  },
  ...WORKSPACE_SLOT_COMMANDS,
  // TOC 面板不是 StageItem,但它的开关同样是命令类快捷键(08-29 全称拍板:都可设置)
  { id: 'toc.toggle', labelKey: 'toc.title', defaultCombo: DEFAULT_COMBOS['toc.toggle'] ?? null },
  // 顶栏 agent 切换器:同样不是瓦,同样是「呼出一块面」的命令(08-30)。
  { id: 'agent.menu', labelKey: 'agent.menuLabel', defaultCombo: DEFAULT_COMBOS['agent.menu'] ?? null },
  // 新建会话(D1 开工批)。它不开面,它**做一件事** —— 这一族里的第一条。
  { id: 'session.new', labelKey: 'session.new', defaultCombo: DEFAULT_COMBOS['session.new'] ?? null },
]

export const initialKeymapState: KeymapState = { overrides: {} }

export function findCommand(id: CommandId): KeymapCommand | undefined {
  return KEYMAP_COMMANDS.find((c) => c.id === id)
}

/**
 * 一条命令的名字要不要套一层**动词壳**(S1,设计 §14 的文案那一句)。
 *
 * `KeymapCommand.labelKey` 存的是**这块面自己的名字**(「文件」「查看器」),
 * 因为一条命令的名字与那块面的名字本来就该是同一个产地。可 `toggle:` 那一族
 * 的语义在 S1 之后不再是「开 / 关」而是**召唤**(把它弄到眼前 + 把键盘交给它,
 * 不关面),而「召唤」这个动作只有在设置页的键位表里说出来才有意义 —— 光写
 * 「文件」的那一行没告诉用户这个键会做什么。
 *
 * 收在这里而不是各消费方自己判:「哪一族带动词」是命令表的事实,
 * 设置页只是读它。回 null = 名字就是那块面的名字,不加壳。
 */
export function commandVerbKeyOf(id: CommandId): MessageKey | null {
  return id.startsWith(TOGGLE_COMMAND_PREFIX) ? 'keymap.summonOf' : null
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
 * persist 迁移。
 *
 * v2:会话总览去接管化,它的开关从独立的 'expose.toggle' 变成自己那条 toggle。
 * 老档案里挂在旧 id 上的覆盖整条改挂过去 —— 包括用户显式解绑的那条 null:
 * 「解绑」也是用户的意思,不迁移就等于替他把 ⌘E 又装了回去。
 * 新 id 上已经有值(理论上不可能,那条命令 v2 才出生)则老值让路,不覆盖用户当下的设置。
 */
export function migrateKeymapPersisted(persisted: unknown, version: number): unknown {
  if (version >= KEYMAP_PERSIST_VERSION) return persisted
  if (!persisted || typeof persisted !== 'object') return persisted
  const out = persisted as Record<string, unknown>
  if (version < 2) {
    const overrides = out.overrides
    if (overrides && typeof overrides === 'object' && RETIRED_EXPOSE_TOGGLE_ID in overrides) {
      const { [RETIRED_EXPOSE_TOGGLE_ID]: legacy, ...rest } = overrides as Record<string, unknown>
      const id = toggleCommandId(SESSIONS_ITEM_ID)
      return { ...out, overrides: id in rest ? rest : { ...rest, [id]: legacy } }
    }
  }
  return out
}
