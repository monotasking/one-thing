import { KEYMAP_COMMANDS, comboConflictBetween, findCommand, toggleCommandId } from './commands'
import { SESSIONS_ITEM_ID } from '../stage/items'
import type { ComboConflict } from './commands'
import type {
  Combo,
  ComboEvent,
  CommandId,
  KeymapPlatform,
  KeymapState,
  RecordOutcome,
} from './types'

/**
 * **键位注册表的算术**(K0 之后这只文件只剩这一半)。
 *
 * 表本身搬去了 `./commands.ts`(判词写在那只文件头上:表要读 `focus/scopes.ts`
 * 的 `answers`,而算术这一半要被 `focus/transitions.ts` 反过来读,两半留在一个
 * 文件里就是一个模块环)。这里管的是:组合怎么比、一条命令当下绑着什么、
 * 一次按键落在哪几条命令上、写入怎么拦冲突、录制怎么读、档案怎么迁。
 *
 * 下面那几行 `export ... from './commands'` 是**原样再导出**:既有调用点
 * (`run-command.ts` / 设置页 / 各门 / 各用例)一个字都不用改,而它们读到的
 * 仍然是唯一那张表。
 */
export {
  KEYMAP_COMMANDS,
  TOGGLE_COMMAND_PREFIX,
  WORKSPACE_SLOT_COMMAND_PREFIX,
  comboConflictBetween,
  findCommand,
  shelfSideOfCommand,
  shelfToggleCommandId,
  toggleCommandId,
  workspaceSlotCommandId,
} from './commands'
export type { ComboConflict } from './commands'
/** 「这是什么机器」搬去了 `./platform.ts`(断环,判词在那只文件头上)。 */
export { platformOf } from './platform'

/** persist 档案版本。改这个数就必须在 migrateKeymapPersisted 里加一段,两者同生共死。 */
export const KEYMAP_PERSIST_VERSION = 3

/**
 * 退役的命令 id。它只作为**老档案里的一个键**存在(v2 迁移读它、改挂它),
 * 不再是这套注册表认识的命令 —— 会话总览去接管化之后,它的开关就是它自己那条 toggle。
 */
const RETIRED_EXPOSE_TOGGLE_ID = 'expose.toggle'

export const initialKeymapState: KeymapState = { overrides: {} }

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
 * **声明**这一侧的主修饰键:一条绑定写 `meta` 还是写 `ctrl`,说的是同一件事
 * ——「按住那枚主修饰键」。表里两种拼法都合法,冲突判定因此把 ⌘P 与 Ctrl+P
 * 判为同一条绑定(`sameCombo`),这一格一个字没改。
 *
 * **平台差异不在这里**(T1-fix 改口):从前 `matchCombo` 也问这一只,于是
 * 「按下的是哪一枚」与「声明写的是哪一枚」共用一个判据 —— 结果是**两枚键都
 * 命中**:mac 上按 Ctrl+W 会触发 ⌘W(关当前 tab),Win 上按 Win+W 会触发 Ctrl+W。
 * 平常看不出来,直到有一块面**真的要 Ctrl 那一枚**(终端:`^W` 删一个词、
 * `^P` 上一条历史)—— 那时「两枚皆可」就成了「终端里删一个词会把 shell 关掉」。
 * 按下的那一侧现在归 `primaryPressedIn`,判词写在它上头。
 */
function primaryOf(combo: Combo): boolean {
  return combo.meta === true || combo.ctrl === true
}

/**
 * **按下**这一侧的主修饰键:mac 是 ⌘,其余平台是 Ctrl(T1-fix)。
 *
 * 两条,缺一不可:
 *  ① 主修饰键那一枚按下了;
 *  ② **另一枚没按下**。另一枚在这台壳的键位表里永远不参与绑定,所以按着它就
 *     不是这一条(mac 上 ⌃⌘P 不是 ⌘P;Win 上 Win+Ctrl+P 不是 Ctrl+P)。
 *     没有 ② 的话,一条不带主修饰的绑定(`{alt:true,key:'x'}`)会被 mac 上的
 *     Ctrl+⌥X 命中 —— 因为那时 ① 恰好也答 false。
 *
 * 纯函数,平台由调用方量一次递进来(与 `formatCombo` 逐字同一条纪律:
 * 「这是什么机器」是宿主的事实,不是注册表的)。
 */
export function primaryPressedIn(e: ComboEvent, platform: KeymapPlatform): boolean {
  return platform === 'mac' ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
}

/** 那枚**永远不参与绑定**的修饰键此刻按着没有(见上面的 ②)。 */
function offHandPressed(e: ComboEvent, platform: KeymapPlatform): boolean {
  return platform === 'mac' ? e.ctrlKey : e.metaKey
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

/**
 * 一次按键是不是这个组合。修饰键逐位相等 —— 多按一个 Shift 就不是同一条绑定。
 *
 * **`platform` 是必填的**(T1-fix):它决定「主修饰键」指的是哪一枚物理键。
 * 给它一个默认值会让每个忘了传的调用点悄悄回到「两枚皆可」那条老路上 ——
 * 而那正是这一改要治的病,所以让 tsc 在每一处问一遍。
 */
export function matchCombo(e: ComboEvent, combo: Combo, platform: KeymapPlatform): boolean {
  return (
    primaryOf(combo) === primaryPressedIn(e, platform) &&
    !offHandPressed(e, platform) &&
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
 * 一条命令**当下**绑的那几个键:覆盖优先,没登记才落到出厂默认。
 * 显式的 null 是「用户解绑了」,它赢过默认 —— 所以这里问的是 `in`,不是真值。
 *
 * 回**数组**(K0):一条命令可以有好几个键面(`files.detail` 的 ⌘I 与 ⌘↵)。
 * 空数组 = 此刻没绑,与「绑了一个」在形状上是同一种东西 —— 从前那个
 * `Combo | null` 让每个调用点各自判一次 null,而那正是「两个出厂键」说不出口的
 * 根由。
 */
export function effectiveCombos(state: KeymapState, id: CommandId): readonly Combo[] {
  if (id in state.overrides) return state.overrides[id] ?? []
  return findCommand(id)?.defaultCombos ?? []
}

/** 这条命令有没有被用户改过 —— 「恢复默认」那颗按钮只在它为真时出现。 */
export function hasOverride(state: KeymapState, id: CommandId): boolean {
  return id in state.overrides
}

/**
 * 一次按键落在**哪几条**命令上(K0:一个键可以绑好几条,见冲突规则)。
 *
 * 回候选**集**而不是第一个命中的那一条:⌘L 上同时有 `viewer.gotoLine` 与
 * `browser.address`,谁做由**活动路径**说了算(`focus/transitions.routeKey`),
 * 不该由这张表的行序说了算 —— 行序决定键的去向正是 08-31 那次 ⌘⇧O 撞车的形状。
 * 次序按表的声明序,`routeKey` 只把它当候选池,不当优先级。
 */
export function lookupCommands(
  state: KeymapState,
  e: ComboEvent,
  platform: KeymapPlatform,
): CommandId[] {
  const out: CommandId[] = []
  for (const command of KEYMAP_COMMANDS) {
    for (const combo of effectiveCombos(state, command.id)) {
      if (matchCombo(e, combo, platform)) {
        out.push(command.id)
        break
      }
    }
  }
  return out
}

/**
 * 这个键上**别的**命令(设置页说「⌘L 与查看器的『跳到某行』共用,不同时在场」)。
 *
 * 共键不是错误 —— 冲突规则允许的那些共键正是**设计**(一条命令三个响应者、
 * 两条命令两块永不同框的面)。但不许**静默**:一行键位旁边要说得出还有谁在这
 * 个键上。判据与 `bindCombo` 同一只 `sameCombo`,所以两处不会分叉。
 */
export function sharedChordOf(state: KeymapState, id: CommandId): CommandId[] {
  const mine = effectiveCombos(state, id)
  if (mine.length === 0) return []
  const out: CommandId[] = []
  for (const command of KEYMAP_COMMANDS) {
    if (command.id === id) continue
    const other = effectiveCombos(state, command.id)
    if (other.some((b) => mine.some((a) => sameCombo(a, b)))) out.push(command.id)
  }
  return out
}

/* ── 写入(唯一的写入口,冲突不静默覆盖) ─────────────────────────────────── */

/**
 * 绑一个组合。**规则不许的共键就不写** —— 返回撞的是谁、按哪一条规则撞,
 * 由调用方去说话。静默覆盖是最难查的一类 bug:用户会以为老键还在。
 * 绑到自己身上是恒等成功(再按一次同一个组合不该报「与自己冲突」)。
 *
 * ── K0:从「一个键至多一条命令」改成一条**规则**(`comboConflictBetween`)──
 * 从前这里拦的是「这个组合已经被任何一条命令占着」。那条口径把面域局部键排除在
 * 外(它们不在这张表里),于是设置页只好另开一张「撞车表」把它们说出来 ——
 * 说得出、却拦不住,而且拦不住是对的:⌘I 在文件树里开详情、在别处仍是那条全局
 * 命令,本来就该共存。K0 把「什么时候共键是对的」写成了一条可跑的规则,于是两
 * 件事合一:合法的共键**放行并说出口**(`sharedChordOf`),不合法的**拦住并说清
 * 是哪一条规则**。规则本身与出厂表同用一只函数,出厂表自己也得过
 * (`__tests__/commands.test.ts` 跑全表)。
 *
 * 录一次 = **整条换成那一个键**(数组长度回到 1)。`files.detail` 的第二个出厂键
 * 因此会丢,「恢复默认」拿得回来 —— 多键改绑是 K5 的事,这里先把形状留对。
 */
export function bindCombo(
  state: KeymapState,
  id: CommandId,
  combo: Combo,
): { ok: KeymapState } | { conflict: ComboConflict } {
  for (const command of KEYMAP_COMMANDS) {
    if (command.id === id) continue
    const other = effectiveCombos(state, command.id)
    if (!other.some((c) => sameCombo(c, combo))) continue
    const conflict = comboConflictBetween(id, command.id)
    if (conflict) return { conflict }
  }
  return { ok: { ...state, overrides: { ...state.overrides, [id]: [combo] } } }
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

/**
 * persist 迁移。
 *
 * v3(K0):覆盖的值从一个 `Combo` 变成一串 `Combo[]` —— 一条命令可以有好几个
 * 键面。判词写在下面那一段上。
 *
 * v2:会话总览去接管化,它的开关从独立的 'expose.toggle' 变成自己那条 toggle。
 * 老档案里挂在旧 id 上的覆盖整条改挂过去 —— 包括用户显式解绑的那条 null:
 * 「解绑」也是用户的意思,不迁移就等于替他把 ⌘E 又装了回去。
 * 新 id 上已经有值(理论上不可能,那条命令 v2 才出生)则老值让路,不覆盖用户当下的设置。
 */
export function migrateKeymapPersisted(persisted: unknown, version: number): unknown {
  if (version >= KEYMAP_PERSIST_VERSION) return persisted
  if (!persisted || typeof persisted !== 'object') return persisted
  let out = persisted as Record<string, unknown>
  if (version < 2) {
    const overrides = out.overrides
    if (overrides && typeof overrides === 'object' && RETIRED_EXPOSE_TOGGLE_ID in overrides) {
      const { [RETIRED_EXPOSE_TOGGLE_ID]: legacy, ...rest } = overrides as Record<string, unknown>
      const id = toggleCommandId(SESSIONS_ITEM_ID)
      out = { ...out, overrides: id in rest ? rest : { ...rest, [id]: legacy } }
    }
  }
  if (version < 3) {
    /*
     * v3:一条命令可以有好几个键面,所以覆盖的值从 `Combo` 变成 `Combo[]`。
     * 老档案里每一格是**一个**组合 —— 包成一格数组。
     *
     * **显式的 null 原样留着**:它是「用户把这一条解绑了」,不是「没绑过」,
     * 包成 `[]` 会让 v2 的迁移判词(「解绑也是用户的意思」)在这一版失效。
     * 已经是数组的(理论上不会有,v3 才出生)照旧不动 —— 迁移要幂等。
     */
    const overrides = out.overrides
    if (overrides && typeof overrides === 'object') {
      const wrapped: Record<string, unknown> = {}
      for (const [id, value] of Object.entries(overrides as Record<string, unknown>)) {
        wrapped[id] = value === null || Array.isArray(value) ? value : [value]
      }
      out = { ...out, overrides: wrapped }
    }
  }
  return out
}
