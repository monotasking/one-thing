import { SESSIONS_ITEM_ID } from '../stage/items'
import {
  TAB_SELECT_SLOTS,
  TERMINAL_SUMMON_COMBOS,
  comboForPlatform,
  tabSelectCommandId,
  toggleCommandId,
} from './commands'
import { platformOf } from './platform'
import type { PlatformCombos } from './commands'
import type { Combo, CommandId, KeymapPlatform } from './types'

/**
 * **键位组**(K5,方案 `docs/keymap-responder-2026-09.md` §5 K5;09-12 用户提出:
 * 「VS Code 组、JetBrains 组可整组切换;可从文件导入」)。
 *
 * ── 有效键三层 ──────────────────────────────────────────────────────────
 *   用户逐格覆盖  ▷  当前键位组  ▷  出厂表
 * 缺席往下落,显式 `null` = 解绑(在**哪一层**写的 null 都一样:它是一句话,
 * 不是一个空位)。落地在 `transitions.effectiveCombos` / `profileCombos`。
 *
 * 三层而不是两层的理由是**换组不丢手**:用户改过的那几格是他自己的东西,不该
 * 因为「试一下 VS Code 组」就被一整组盖掉;而组本身是一份**出厂表的替身** ——
 * 它只说自己映射到的那几条,没说的往下落回出厂值。所以一条命令在 vscode 组里
 * 缺席,意思是「VS Code 没有对应物,用这台壳自己的键」,不是「解绑」。
 *
 * ── 组里只写**有对应物**的命令,而且逐条写来自哪 ────────────────────────
 * 硬映射一堆没有对应物的命令只会得到一组假货。每一行后面那句注释是**可核对的
 * 出处**(VS Code / JetBrains 里那条命令叫什么),而不是装饰:将来有人要改一格,
 * 他改的是「我们对那条命令的理解」,不是「某个人当年顺手按的键」。
 *
 * ── 这只文件不许长出第二种东西 ──────────────────────────────────────────
 * 它是**数据**:`import` 只有出厂表那一侧(平台分档与 id 拼法),没有 store、
 * 没有 React、没有算术。三层怎么落、冲突怎么判在 `transitions.ts`
 * (`profileCombos` / `profileConflicts`),文件读写在 `profile-io.ts` /
 * `profile-file.ts`。加一个组 = `keymapProfilesFor` 里多一张表。
 *
 * ── 表**按平台算出来**,而这台机器的那一份量一次 ────────────────────────
 * 判例与 `content/terminal/key-courtesy.ts` 的 `terminalClaims(platform)` /
 * `TERMINAL_CLAIMS` 逐字相同:纯函数那一半收 platform(于是**两台机器都测得到**,
 * 不必去改 UA),模块加载时量一次得到这台机器的那一份。有它才说得出「⌃G 在两台
 * 机器上是同一枚物理键」这种话 —— `Combo.offHand` 指的是「非主修饰键」,而
 * Ctrl 那一枚在 mac 上是它、在 Win / Linux 上恰恰是主修饰键。
 */
export interface KeymapProfile {
  /** 组 id。内置三组是 `default` / `vscode` / `jetbrains`;用户组一律 `user:` 打头。 */
  id: string
  /**
   * 组名。**内置组的名字是界面文案,用户组的名字是用户自己写的字** ——
   * 所以这一格存的是**成品串**,不是字典键:内置三组的名字(default / VS Code /
   * JetBrains)在两种语言里逐字相同(前两个是专名,「默认」那一个由设置页按
   * `builtin` 那一格改用字典键画,判词写在 `KeymapSettings` 上)。
   */
  name: string
  /** 内置组不许被导入覆盖、不许被删。 */
  builtin?: true
  /**
   * 这一组说了话的那几条命令。**缺席 = 往下落到出厂表**,显式 `null` = 解绑。
   * 与 `KeymapState.overrides` 同一种「缺席 vs null」口径,同一条判词。
   */
  bindings: Partial<Record<CommandId, readonly Combo[] | null>>
}

/** 出厂组的 id。`KeymapState.profileId` 缺席时就是它。 */
export const DEFAULT_KEYMAP_PROFILE_ID = 'default'

/** 用户组 id 的前缀。**结构上**保证用户组盖不住内置组(判词在 `profile-io` 上)。 */
export const USER_PROFILE_ID_PREFIX = 'user:'

/** 「这台机器是什么」量一次(判词见文件头末段)。 */
const PLATFORM: KeymapPlatform = platformOf(
  typeof navigator === 'undefined' ? '' : navigator.userAgent,
)

/** 「这一条按平台分档」的那一格。两档都写出来是**同一个手势**。 */
function byPlatform(rows: PlatformCombos, platform: KeymapPlatform): readonly Combo[] {
  return [comboForPlatform(rows, platform)]
}

/**
 * **默认组 = 出厂表本身**,所以 `bindings` 是空的。
 *
 * 它不是一张重复抄写的表:出厂键的正本是 `commands.ts` 的 `DEFAULT_COMBOS`,
 * 这一组存在的唯一理由是让「键位组」这个选择器有**三个**平等的选项,而不是
 * 「两个组 + 一个特殊的没有组」。空 bindings 逐格落到出厂表,一个字都不重复。
 */
const DEFAULT_PROFILE: KeymapProfile = {
  id: DEFAULT_KEYMAP_PROFILE_ID,
  name: 'default',
  builtin: true,
  bindings: {},
}

/**
 * **VS Code 组**。出处逐行写在注释里(命令 id 是 VS Code 自己那套 `workbench.*`,
 * 与 `import-vscode.ts` 的对照表是同一份知识的两种用法 —— 那只文件是这张表的
 * **反向**,加一行要两边一起加,用例钉着两张表互为反函数)。
 *
 * ── 一格取舍写在这儿,因为它有可感知的后果 ──────────────────────────────
 * `tab.next` / `tab.prev` 的 **⌥⌘→ / ⌥⌘←** 与这台壳的**左右架子收展**
 * (`shelf.right.toggle` / `shelf.left.toggle`,09-01「方向即语义」那一族)是
 * 同一个组合。它**过冲突规则**(架子那两条 `app: true`、标签这两条 `app: false`,
 * 作用域集合不交),但过规则不等于没后果:切到 VS Code 组之后,**焦点在一片叶
 * 里时** ⌥⌘→ 归「下一个标签」,架子的收展让位(局部先接,那正是三层立法那句
 * 裁定);焦点不在叶里时它照旧收展架子。设置页那一行会自己说出这句话
 * (`sharedChordOf` →「与『右架子』共用这个键」)—— 合法的共键不拦写入,但不许
 * 静默。切回 default 组即恢复。
 *
 * ── 内容族那四条(K3)**故意不写**,理由不是「VS Code 没有」而是「不是同一件事」──
 * VS Code 里确有 `workbench.action.reloadWindow`(⌘R)与 `zoomIn / zoomOut /
 * zoomReset`(⌘= / ⌘− / ⌘0),但它们作用在**整台 IDE 窗口**上;这台壳的
 * `view.reload` / `view.zoom*` 作用在**焦点那块内容**(浏览器叶里的那一页)。
 * 名字一样、键一样、做的事不一样 —— 那正是「假货」的定义(见上「组里只写有对应物
 * 的命令」)。而且「⌘R 重载整台壳」恰恰是 K1 从 Electron 默认菜单里拿掉的那一条,
 * 由一个键位组把它装回来是反着走。缺席 = 落回出厂键(K3 定的就是 ⌘R / ⌘= / ⌘− /
 * ⌘0),用户什么都没少。`nav.back` / `nav.forward` 同理不写:VS Code 的
 * `navigateBack` 是「编辑器位置历史」,与这台壳的「这一页 / 这次检索的上一步」
 * 不是一回事,而出厂那两个键(⌘[ / ⌘])本来就是跨应用的那一对。
 */
const vscodeProfile = (platform: KeymapPlatform): KeymapProfile => ({
  id: 'vscode',
  name: 'VS Code',
  builtin: true,
  bindings: {
    /* workbench.action.findInFiles —— Search: Find in Files。与出厂同键。 */
    'toggle:search': [{ meta: true, shift: true, key: 'f' }],
    /* workbench.action.showCommands —— Command Palette。 */
    'workspace.palette': [{ meta: true, shift: true, key: 'p' }],
    /* workbench.action.nextEditor —— ⌥⌘→,另 ⌘⇧] 也是(VS Code 两个键都绑)。 */
    'tab.next': [
      { meta: true, alt: true, key: 'arrowright' },
      { meta: true, shift: true, key: ']' },
    ],
    /* workbench.action.previousEditor —— ⌥⌘←,另 ⌘⇧[ 也是。 */
    'tab.prev': [
      { meta: true, alt: true, key: 'arrowleft' },
      { meta: true, shift: true, key: '[' },
    ],
    /* workbench.action.reopenClosedEditor。 */
    'tab.reopen': [{ meta: true, shift: true, key: 't' }],
    /* workbench.action.closeActiveEditor。 */
    'tab.close': [{ meta: true, key: 'w' }],
    /* actions.find —— 在这块内容里查找。 */
    'view.find': [{ meta: true, key: 'f' }],
    /*
     * workbench.action.gotoLine —— **⌃G**。两台机器上按的都是 Ctrl 那一枚物理键
     * (VS Code 在 mac 与 Win / Linux 上这条都是 Ctrl+G),而「Ctrl 那一枚」在
     * mac 上是**另一枚**、在别处恰恰是**主修饰键** —— 一行声明说不出,所以走
     * `byPlatform`(判词整段在 `commands.ts` 的 `PlatformCombos` 上)。
     */
    'viewer.gotoLine': byPlatform(
      { mac: { offHand: true, key: 'g' }, other: { ctrl: true, key: 'g' } },
      platform,
    ),
    /*
     * workbench.action.terminal.toggleTerminal —— ⌃\`。与出厂那一行**同一份**
     * 两档表(`TERMINAL_SUMMON_COMBOS`):VS Code 那个手势本来就是这台壳出厂
     * 抄的,所以这里不该再手抄一遍两档。
     */
    'toggle:terminal': byPlatform(TERMINAL_SUMMON_COMBOS, platform),
    /* workbench.action.openSettings —— ⌘,。与出厂同键。 */
    'toggle:settings': [{ meta: true, key: ',' }],
  },
})

/**
 * **JetBrains 组**。出处是 JetBrains 的 macOS 默认 keymap 那一列。
 *
 * 没有对应物的那几条**不写**,于是它们往下落回出厂表:`workspace.palette`
 * (JetBrains 是 ⇧⇧ 双击 —— 这台壳的组合键表达不出「同一枚键连按两下」,
 * 硬塞一个别的键就是编造)、`tab.reopen`(JetBrains 没有「重开刚关掉的标签」
 * 这一条),以及内容族那四条
 * (`view.reload` / `view.zoom*`,K3)—— JetBrains 的缩放是改编辑器字号、
 * 它没有「重载这块内容」,判词与 VS Code 组那一段同一条:不是同一件事就不写。
 * 它的 Back / Forward(⌘[ / ⌘])**与出厂键逐字相同**,所以写了也是白写。
 *
 * ── K7:**⌘n 在 JetBrains 那边是工具窗,不是标签**(09-13 用户原话
 *    「jetbrains cmd 1 绑定 project,cmd 0 绑定 changes」)──────────────────
 * JetBrains 的 ⌘1 / ⌘7 / ⌘0 是**激活某个工具窗**(Project / Structure /
 * Commit),换标签在那边是 ⌃→ / ⌃←(本组上面已有那两条)。这台壳里与它们对应
 * 的东西就是三块**瓦**:文件列表 / 目录 / 改动面 —— 所以这一组把 ⌘1 / ⌘7 / ⌘0
 * 给它们,并且把 `tab.select:1`…`tab.select:9` **逐条显式写成 `null`**。
 *
 * 为什么是显式 `null` 而不是缺席:缺席**往下落**(判词在文件头「有效键三层」
 * 那一段),落下去就是出厂表的 ⌘1–⌘9 —— 那正好是要让开的那九个键,于是 ⌘1
 * 会同时落在「文件列表」与「第 1 个标签」两条命令上。`null` 是这一组说的一句
 * 话(「这一组里没有编辑器序号直达」),它赢过出厂值。
 */
const jetbrainsProfile = (platform: KeymapPlatform): KeymapProfile => ({
  id: 'jetbrains',
  name: 'JetBrains',
  builtin: true,
  bindings: {
    /* Find in Path —— ⌘⇧F。与出厂同键。 */
    'toggle:search': [{ meta: true, shift: true, key: 'f' }],
    /* Find —— ⌘F。 */
    'view.find': [{ meta: true, key: 'f' }],
    /*
     * Select Next / Previous Tab —— **⌃→ / ⌃←**。同 `viewer.gotoLine` 那一条:
     * 「Ctrl 那一枚物理键」在两台机器上分属两侧,所以按平台分两档。
     */
    'tab.next': byPlatform(
      { mac: { offHand: true, key: 'arrowright' }, other: { ctrl: true, key: 'arrowright' } },
      platform,
    ),
    'tab.prev': byPlatform(
      { mac: { offHand: true, key: 'arrowleft' }, other: { ctrl: true, key: 'arrowleft' } },
      platform,
    ),
    /* Close Tab —— ⌘W。 */
    'tab.close': [{ meta: true, key: 'w' }],
    /*
     * ── 工具窗三条(K7,判词整段在上面文件注释里)──────────────────────────
     * `ActivateProjectToolWindow` —— **⌘1**,JetBrains 的 Project 面板,
     * 这台壳里对应的是「文件列表」那块瓦。
     */
    [toggleCommandId('files')]: [{ meta: true, key: '1' }],
    /* `ActivateStructureToolWindow` —— **⌘7**,那边的 Structure = 这台壳的目录。 */
    'toc.toggle': [{ meta: true, key: '7' }],
    /*
     * `ActivateCommitToolWindow` —— **⌘0**,那边叫 Commit / Changes(用户原话
     * 「cmd 0 绑定 changes」),这台壳里是「改动」那块瓦。
     *
     * ⌘0 上还有一条 `view.zoomReset`(出厂键,跟焦点那一族),两条**合法共键**:
     * 冲突规则问的是「`app: true` 的至多一条 + 其余作用域两两不交」,而瓦的
     * toggle 是应用级、`view.zoomReset` 只有浏览器答得出 —— 一条 app 级与一条
     * 跟焦点的共键正是三层立法那句裁定。`profileConflicts` 跑这一组时会再证一遍。
     */
    [toggleCommandId('diff')]: [{ meta: true, key: '0' }],
    /*
     * 序号直达那九条在这一组里**全部解绑**:JetBrains 换标签是 ⌃→ / ⌃←,
     * ⌘n 在那边从来不是标签。写 `null` 而不是不写,理由在文件注释 K7 那一段。
     */
    ...Object.fromEntries(
      Array.from({ length: TAB_SELECT_SLOTS }, (_, i) => [tabSelectCommandId(i + 1), null]),
    ),
    /* Navigate | Line/Column… —— ⌘L。与出厂同键。 */
    'viewer.gotoLine': [{ meta: true, key: 'l' }],
    /* Terminal 工具窗 —— ⌥F12。 */
    'toggle:terminal': [{ alt: true, key: 'f12' }],
    /* Recent Files —— ⌘E(义近:这台壳的会话总览就是「最近在做的那些」)。 */
    [toggleCommandId(SESSIONS_ITEM_ID)]: [{ meta: true, key: 'e' }],
    /* Preferences —— ⌘,。与出厂同键。 */
    'toggle:settings': [{ meta: true, key: ',' }],
  },
})

/**
 * 内置三组**按平台算出来**(纯函数,两台机器都测得到)。次序就是设置页
 * 选择器里的次序。
 */
export function keymapProfilesFor(platform: KeymapPlatform): readonly KeymapProfile[] {
  return [DEFAULT_PROFILE, vscodeProfile(platform), jetbrainsProfile(platform)]
}

/** 这台机器的那一份(模块加载时量一次,判词在文件头末段)。 */
export const BUILTIN_KEYMAP_PROFILES: readonly KeymapProfile[] = keymapProfilesFor(PLATFORM)

/** 内置组按 id 取。认不出就是 `undefined` —— 调用方据此落回出厂表,不去猜。 */
export function findBuiltinProfile(id: string): KeymapProfile | undefined {
  return BUILTIN_KEYMAP_PROFILES.find((p) => p.id === id)
}

/** 这个 id 是不是内置组占着的。导入那一侧靠它保证用户组盖不住内置组。 */
export function isBuiltinProfileId(id: string): boolean {
  return findBuiltinProfile(id) !== undefined
}
