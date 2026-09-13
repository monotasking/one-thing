import { KEYMAP_COMMANDS, comboConflictBetween, findCommand, toggleCommandId } from './commands'
import { SESSIONS_ITEM_ID } from '../stage/items'
import { BUILTIN_KEYMAP_PROFILES, DEFAULT_KEYMAP_PROFILE_ID, findBuiltinProfile } from './profiles'
import type { ComboConflict } from './commands'
import type { KeymapProfile } from './profiles'
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
export const KEYMAP_PERSIST_VERSION = 5

/**
 * 退役的命令 id。它只作为**老档案里的一个键**存在(v2 迁移读它、改挂它),
 * 不再是这套注册表认识的命令 —— 会话总览去接管化之后,它的开关就是它自己那条 toggle。
 */
const RETIRED_EXPOSE_TOGGLE_ID = 'expose.toggle'

/**
 * 同上,K2 退役的那一条(09-12 用户裁定 1:⌘N 不是全局键)。它只作为**老档案
 * 里的一个键**存在 —— v4 迁移把挂在它上头的覆盖整条改挂到 `content.new`,
 * 包括显式的 null(「用户把 ⌘N 解绑了」也是用户的意思)。
 */
const RETIRED_SESSION_NEW_ID = 'session.new'

export const initialKeymapState: KeymapState = {
  overrides: {},
  profileId: DEFAULT_KEYMAP_PROFILE_ID,
  userProfiles: [],
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

/**
 * 那枚**另一枚**修饰键此刻按着没有(见上面的 ②)。
 *
 * **K2 起它不再是「永远不参与绑定」**:`Combo.offHand` 让声明这一侧说得出
 * 「我要的就是这一枚」(mac 的 ⌃Tab / ⌃ 反引号)。对**不带** `offHand` 的绑定
 * 它照旧是那道闸 —— 判词与病历一个字没改。
 */
function offHandPressed(e: ComboEvent, platform: KeymapPlatform): boolean {
  return platform === 'mac' ? e.ctrlKey : e.metaKey
}

/**
 * 主修饰键那一枚**按着没有**(不问另一枚)。
 *
 * 它与 `primaryPressedIn` 差的正是 ② 那一句:`offHand` 的绑定要的是
 * 「另一枚按着 **且主修饰键没按**」,而 `primaryPressedIn` 在两枚同按时也答
 * false —— 拿它当判据的话 mac 上 ⌃⌘Tab 会命中 ⌃Tab。
 */
function primaryHeldIn(e: ComboEvent, platform: KeymapPlatform): boolean {
  return platform === 'mac' ? e.metaKey : e.ctrlKey
}

/** 两个组合是不是同一个。冲突判定用它,所以 ⌘P 与 Ctrl+P 判为同一个。 */
export function sameCombo(a: Combo, b: Combo): boolean {
  return (
    primaryOf(a) === primaryOf(b) &&
    /* K2:「另一枚」是身份的一部分 —— ⌃Tab 与 ⌘Tab 不是同一条绑定。 */
    (a.offHand === true) === (b.offHand === true) &&
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
  const alt = (combo.alt === true) === e.altKey
  const shift = (combo.shift === true) === e.shiftKey
  const key = normalizeKey(e.key) === combo.key
  /*
   * **`offHand` 那一支先判**(K2):这条绑定要的是「另一枚」那一枚物理键
   * (mac 的 ⌃、Win / Linux 的 Win 键),所以两条同时成立才算 —— 另一枚按着,
   * **而且主修饰键没按**(判词在 `primaryHeldIn` 上:拿 `primaryPressedIn`
   * 当这一句会让 mac 上的 ⌃⌘Tab 命中 ⌃Tab)。
   */
  if (combo.offHand === true) {
    return offHandPressed(e, platform) && !primaryHeldIn(e, platform) && alt && shift && key
  }
  return (
    primaryOf(combo) === primaryPressedIn(e, platform) &&
    !offHandPressed(e, platform) &&
    alt &&
    shift &&
    key
  )
}

/**
 * 一次按键读成组合。只按了修饰键 = null(还不成组合)。false 的位不写进对象。
 *
 * ── K5:**认得出「另一枚」**,所以 platform 是必填的 ──────────────────────
 * K2 给 `Combo` 开了 `offHand` 那一格,却没给**录制**开 —— 于是设置页上录 ⌃Tab
 * 读回来的是 `{ctrl: true, key: 'tab'}`,而那在 mac 上读作 **⌘Tab**:用户按的是
 * 一枚键,存下来的是另一枚(K2 留的账,原话「录制录不出 `offHand`」)。判据与
 * `matchCombo` 的 offHand 那一支**逐字相同**:另一枚按着 **且主修饰键没按**。
 *
 * 两枚同按(mac 的 ⌃⌘X)照旧读成 `{meta, ctrl}` —— 那是一条**匹配不上任何按键**
 * 的绑定(`matchCombo` 的 `!offHandPressed` 那道闸),K2 之前就是这样,K5 不顺手
 * 改它:那是「两枚都要的组合这台壳收不收」的拍点,不是录制的事(留账)。
 */
export function comboFromEvent(e: ComboEvent, platform: KeymapPlatform): Combo | null {
  if (isModifierKey(e.key)) return null
  const combo: Combo = { key: normalizeKey(e.key) }
  if (offHandPressed(e, platform) && !primaryHeldIn(e, platform)) {
    combo.offHand = true
  } else {
    if (e.metaKey) combo.meta = true
    if (e.ctrlKey) combo.ctrl = true
  }
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
 * 拼接留给视图,这里只回答「有哪几枚」。顺序固定:主修饰、另一枚、⌥、⇧、键。
 */
export function formatCombo(combo: Combo, platform: KeymapPlatform): string[] {
  const mac = platform === 'mac'
  const caps: string[] = []
  if (primaryOf(combo)) caps.push(mac ? '⌘' : 'Ctrl')
  /* 「另一枚」按平台画出它真正的名字:mac 是 ⌃,Win / Linux 是 Win 键(K2)。 */
  if (combo.offHand === true) caps.push(mac ? '⌃' : 'Win')
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
  return profileCombos(activeProfile(state), id)
}

/* ── 键位组:三层的中间那一层(K5)──────────────────────────────────────── */

/**
 * 此刻是哪一组。认不出的 id(用户组被删掉了、档案是别人的)**落回出厂组** ——
 * 不是报错,也不是空表:一个认不出的组名最坏的后果应该是「键位回到出厂」,
 * 而不是整台壳一个快捷键都没有。
 *
 * 内置组**先查**:用户组的 id 一律 `user:` 打头(`profile-io.ts` 铸的),所以
 * 这两族结构上不相交 —— 次序在这里只是把那句保证再说一遍。
 */
export function activeProfile(state: KeymapState): KeymapProfile | undefined {
  const id = state.profileId ?? DEFAULT_KEYMAP_PROFILE_ID
  return findBuiltinProfile(id) ?? state.userProfiles?.find((p) => p.id === id)
}

/**
 * 一条命令在**某一组**底下绑着什么(不含用户逐格覆盖)= 三层的下面两层。
 *
 * 判据与 `effectiveCombos` 上面那一句逐字相同:问的是 `in`,不是真值 ——
 * 组里显式的 `null` 是「这一组把它解绑了」,它赢过出厂值;缺席才往下落。
 */
export function profileCombos(
  profile: KeymapProfile | undefined,
  id: CommandId,
): readonly Combo[] {
  if (profile && id in profile.bindings) return profile.bindings[id] ?? []
  return findCommand(id)?.defaultCombos ?? []
}

/** 这条命令是**这一组**说的话,还是落下去的出厂值。设置页那一行据此说一句出处。 */
export function isProfileBound(profile: KeymapProfile | undefined, id: CommandId): boolean {
  return profile !== undefined && id in profile.bindings
}

/**
 * **一整组自己过一遍冲突规则**(K5)。回的是「这一组里哪两条撞在一个键上、
 * 按的是哪一条规则」,空数组 = 这一组干净。
 *
 * 它为什么必须存在:出厂表从 K0 起自己要过冲突规则(`__tests__/commands.test.ts`
 * 跑全表),而一个键位组是**出厂表的替身** —— 换一组就是换一张有效表,那张表
 * 一样会撞。三组各跑一遍由 `__tests__/profiles.test.ts` 钉着;反证是往 vscode 组
 * 里塞一条真撞的绑定,那条用例当场红。
 *
 * 判据用的是同一只 `comboConflictBetween`(规则只有一条,不许有第二份),
 * 同一只 `sameCombo`(⌘P 与 Ctrl+P 是同一条绑定)。
 */
export interface ProfileConflict {
  command: CommandId
  conflict: ComboConflict
}

export function profileConflicts(profile: KeymapProfile): ProfileConflict[] {
  const out: ProfileConflict[] = []
  for (let i = 0; i < KEYMAP_COMMANDS.length; i += 1) {
    const mine = profileCombos(profile, KEYMAP_COMMANDS[i].id)
    if (mine.length === 0) continue
    for (let j = i + 1; j < KEYMAP_COMMANDS.length; j += 1) {
      const other = profileCombos(profile, KEYMAP_COMMANDS[j].id)
      if (!other.some((b) => mine.some((a) => sameCombo(a, b)))) continue
      const conflict = comboConflictBetween(KEYMAP_COMMANDS[i].id, KEYMAP_COMMANDS[j].id)
      if (conflict) out.push({ command: KEYMAP_COMMANDS[i].id, conflict })
    }
  }
  return out
}

/** 选择器里列得出的全部组:内置三组在前,用户导入的在后。 */
export function listProfiles(state: KeymapState): readonly KeymapProfile[] {
  return [...BUILTIN_KEYMAP_PROFILES, ...(state.userProfiles ?? [])]
}

/** 换一组。**覆盖层一个字不动** —— 「换组不丢手」就是这一行里的那句话。 */
export function setProfile(state: KeymapState, profileId: string): KeymapState {
  return { ...state, profileId }
}

/**
 * 收一个导入进来的组。**同 id 覆盖**(再导入一次同一份文件是更新,不是堆一摞),
 * 并且当场切过去 —— 导入完还要自己去选一下,那一步没有第二种可能的意图。
 */
export function addUserProfile(state: KeymapState, profile: KeymapProfile): KeymapState {
  const rest = (state.userProfiles ?? []).filter((p) => p.id !== profile.id)
  return { ...state, userProfiles: [...rest, profile], profileId: profile.id }
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
 * ── K5:录一次 = **追加一个键**,不再整条替换 ────────────────────────────
 * K0 留的账原话是「`files.detail` 的第二个出厂键因此会丢」。那不是一格瑕疵,
 * 是**说不出口**:一条命令可以有好几个键面是 K0 就定下的形状,而唯一的写入口
 * 只会把它压回一个,于是「两个键面」这件事用户既看得见又做不出来。K5 把写入
 * 补齐成三件,一件一只函数:**追加**(这一只)、**删一个键面**(`removeCombo`)、
 * **整条解绑**(`unbindCombo`,录制态里的 Backspace)。
 *
 * 已经绑在自己身上的那个组合再按一次是**恒等成功**(不追加重复的一格,也不报
 * 「与自己冲突」)—— 用户按第二遍的意思是「我确认是它」,不是「我要两份」。
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
  const mine = effectiveCombos(state, id)
  if (mine.some((c) => sameCombo(c, combo))) return { ok: state }
  return { ok: { ...state, overrides: { ...state.overrides, [id]: [...mine, combo] } } }
}

/**
 * 删掉**一个键面**(设置页每个键帽尾巴上那颗 ×)。
 *
 * 删到一个不剩写的是**空数组**,不是把覆盖摘掉:「我把最后一个键也删了」与
 * 「我没改过」是两件事 —— 后者才该落回出厂值。这与 `unbindCombo` 写显式 null
 * 是同一句话的两种拼法(`effectiveCombos` 的 `?? []` 把它们读成同一个结果),
 * 分开只是因为一个是「删这一格」、一个是「这一条我不要了」。
 *
 * 删一个本来就不在的组合是恒等(不新建一格覆盖)—— 没发生的事不该留下痕迹。
 */
export function removeCombo(state: KeymapState, id: CommandId, combo: Combo): KeymapState {
  const mine = effectiveCombos(state, id)
  if (!mine.some((c) => sameCombo(c, combo))) return state
  const left = mine.filter((c) => !sameCombo(c, combo))
  return { ...state, overrides: { ...state.overrides, [id]: [...left] } }
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
export function recordKey(e: ComboEvent, platform: KeymapPlatform): RecordOutcome {
  const key = normalizeKey(e.key)
  if (key === 'escape') return { kind: 'cancel' }
  if (key === 'backspace' || key === 'delete') return { kind: 'unbind' }
  const combo = comboFromEvent(e, platform)
  if (!combo) return { kind: 'ignore' }
  return { kind: 'bind', combo }
}

/* ── 平台 / persist ───────────────────────────────────────────────────────── */

/**
 * persist 迁移。
 *
 * v4(K2):`session.new` 退役,⌘N 换成响应者级的 `content.new`。**用户改过的
 * 键跟着搬家,没改过的自然跟着新出厂表走** —— 后者不必做任何事:档案里只存
 * 覆盖(`partialize`),覆盖表里没有那一条时 `effectiveCombos` 当场落到出厂值,
 * 于是 `toggle:search` 改 ⌘⇧F、`workspace.slot:*` 出厂解绑、⌘1–9 归标签这三件
 * 对没改过的人是免费的。
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
  if (version < 4) {
    /*
     * v4(K2):`session.new` → `content.new`。与 v2 那一段逐字同一条判词 ——
     * 显式的 null 也搬(「用户把 ⌘N 解绑了」也是用户的意思,不搬就等于替他把
     * ⌘N 又装了回去),新 id 上已经有值则老值让路(不覆盖用户当下的设置)。
     */
    const overrides = out.overrides
    if (overrides && typeof overrides === 'object' && RETIRED_SESSION_NEW_ID in overrides) {
      const { [RETIRED_SESSION_NEW_ID]: legacy, ...rest } = overrides as Record<string, unknown>
      out = { ...out, overrides: 'content.new' in rest ? rest : { ...rest, 'content.new': legacy } }
    }
  }
  if (version < 5) {
    /*
     * v5(K5):档案里多了**键位组**这一层。老档案没有这两格,而「没有这两格」
     * 说的正是「我用的是出厂组、没导入过谁的键位」—— 所以这一段把那句话写实,
     * 覆盖层**一个字不动**(用户改过的键跟着他走,与换组不丢手同一条判词)。
     *
     * 已经有值的不覆盖(迁移要幂等),而且这里只补两格、不读也不改 `overrides`:
     * 三层里下面两层的变化(将来改内置组的键)对老用户是免费的,理由与 v4
     * 那一段逐字相同 —— 档案里只存覆盖。
     */
    if (!('profileId' in out)) out = { ...out, profileId: DEFAULT_KEYMAP_PROFILE_ID }
    if (!('userProfiles' in out)) out = { ...out, userProfiles: [] }
  }
  return out
}
