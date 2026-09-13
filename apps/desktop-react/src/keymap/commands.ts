import { SESSIONS_ITEM_ID, STAGE_ITEMS } from '../stage/items'
import { WORKSPACE_SLOT_COUNT } from '../workspace/types'
import { FOCUS_SCOPE_LIST } from '../focus/scopes'
import type { ShelfSide } from '../stage/types'
import type { MessageKey } from '../i18n'
import type { FocusScopeId } from '../focus/types'
import { TAB_SELECT_SLOTS, tabSelectCommandId } from './tab-commands'
import { platformOf } from './platform'
import type { Combo, CommandId, KeymapCommand, KeymapPlatform } from './types'

/**
 * **命令表:键 ↔ 意义,全壳唯一一份**(K0,方案
 * `docs/keymap-responder-2026-09.md` §4 ①)。
 *
 * ── 它从哪儿来 ──────────────────────────────────────────────────────────
 * K0 之前一个键的意义散在三个产地:全局档 `KEYMAP_COMMANDS`(在
 * `transitions.ts` 里)、七块面各自的 `FOCUS_SCOPES[id].keys`、终端礼让表。
 * 没有一个人持有「⌘F 是什么」这句话 —— 它在查看器 / 终端 / 浏览器各写一遍,
 * 三个 labelKey、三个 combo,靠人手对齐。这只文件是那三处的合流:
 *
 *  · **一条命令一行**,`app` 与 `nativeView` 两格是**数据**(派发器一行都不读
 *    命令名);
 *  · 从前的面域局部键就是 `app: false` 的那九条 —— 「没有应用层兜底」正是
 *    「它需要一个由焦点决定的目标」那条三层判据的另一种说法;
 *  · 谁答得出一条命令,由 `FOCUS_SCOPES[id].answers` **自述**(响应者一侧),
 *    这张表一个作用域的名字都不出现。
 *
 * ── 为什么表住在这儿而不是 `transitions.ts` ────────────────────────────
 * `transitions.ts` 是**算术**(组合比对、有效键、写入、录制、迁移);这一只是
 * **表**。K0 之后表要读 `focus/scopes.ts`(冲突规则问「谁可能答」),而算术那一
 * 半要被 `focus/transitions.ts` 反过来读 —— 两半留在一个文件里就是一个模块环。
 * 分开之后依赖是一条直线:`transitions → commands → focus/scopes → key-courtesy
 * → platform`。`transitions.ts` 把这里的导出原样再导一次,所以既有调用点
 * (`run-command.ts` / 设置页 / 各门)一个字都不用改。
 */

/** toggle 族的 id 前缀。派发器按它分流,迁移按它铸新 id —— 全仓只此一处字面量。 */
export const TOGGLE_COMMAND_PREFIX = 'toggle:'

/**
 * 「第 n 格标签」那一族的 id 拼法住在 `./tab-commands.ts`(**断模块环** ——
 * 判词整段在那只文件头上:这张表要读 `focus/scopes.ts`,而 `focus/scopes.ts`
 * 要声明「叶答得出 ⌘1–⌘9」)。这里原样再导出,于是调用点只认识一张表。
 */
export {
  TAB_SELECT_COMMAND_PREFIX,
  TAB_SELECT_SLOTS,
  tabSelectCommandId,
  tabSelectSlotOf,
} from './tab-commands'

export function toggleCommandId(itemId: string): CommandId {
  return `${TOGGLE_COMMAND_PREFIX}${itemId}`
}

/** 工作区序号直达那一族的 id 前缀。派发器按它分流 —— 全仓唯一一处字面量。 */
export const WORKSPACE_SLOT_COMMAND_PREFIX = 'workspace.slot:'

/**
 * 序号直达那三条在设置页里的名字。命令名是**界面文案**,所以只持有 key
 * (同 StageItemSpec.titleKey 的判例);三条各一句而不是一句带 {n},
 * 是因为 KeymapCommand.labelKey 这一格不带插值 —— 加插值要动整张注册表。
 * 长度必须等于 WORKSPACE_SLOT_COUNT,由 `workspace-commands.test.ts` 钉住。
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
 * 九条各一句,而不是一句带 {n} —— 与 `WORKSPACE_SLOT_LABEL_KEYS` 逐字同一条
 * 理由(`KeymapCommand.labelKey` 这一格不带插值)。第 9 条说的是「最后一格」,
 * 因为它做的就是那件事。长度必须等于 `TAB_SELECT_SLOTS`,由用例钉住。
 */
const TAB_SELECT_LABEL_KEYS: MessageKey[] = [
  'keymap.tabSelect1',
  'keymap.tabSelect2',
  'keymap.tabSelect3',
  'keymap.tabSelect4',
  'keymap.tabSelect5',
  'keymap.tabSelect6',
  'keymap.tabSelect7',
  'keymap.tabSelect8',
  'keymap.tabSelect9',
]

/**
 * 四条架子的**收 / 展**命令(09-01 用户放权:「四条架子的快捷键」)。
 *
 * ── 键位:⌘⌥ + 那个方向的箭头 ────────────────────────────────────────────
 * **方向即语义**,不用记 —— 左架子是 ⌘⌥←,底架子是 ⌘⌥↓。施工前跑过全表冲突
 * 检查(`shelf-commands.test.ts` 把这条检查钉成了断言):四个组合**一条都不撞**,
 * 而且这台壳出厂表里此前一个带 ⌥ 的键都没有,所以这一族是干净地长出来的。
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

/**
 * 架子命令 id → 哪一侧。认不出就是 null —— 派发器据此放行,不去猜。
 *
 * 收 `string` 而不是 `CommandId`(K2b-1 放宽):它是**反解**,而反解的入参按定义
 * 是「还不知道是不是一条命令」的串 —— 收 `CommandId` 就等于要求调用方先知道答案。
 * 判据与 `run-command.ts` 的 `runShellCommand` 逐字相同,写在那只函数头上。
 */
export function shelfSideOfCommand(id: string): ShelfSide | null {
  const found = SHELF_TOGGLE_LABELS.find((row) => shelfToggleCommandId(row.side) === id)
  return found?.side ?? null
}

/* ── 出厂键按平台分档(K2 修一轮)────────────────────────────────────────── */

/**
 * 一条出厂键的**两档**:这台机器是 mac 就用 `mac`,其余用 `other`。
 *
 * ── 它为什么存在,而不是给 `Combo` 再开一根轴 ────────────────────────────
 * `Combo.offHand`(「另一枚」)指的是**非主修饰键**,所以同一行声明在两台机器上
 * 指的是两枚不同的物理键:mac 上是 ⌃、Win / Linux 上是 Win 键。对**召唤终端**
 * 那一条这正好错了半边 —— 它要的是「两台机器上都按 Ctrl」(VS Code /
 * Windows Terminal 三十年的手势),而那在 mac 上是「另一枚」、在 Win / Linux 上
 * 恰恰是**主修饰键**。一根新轴(「按物理键声明」)会让 `matchCombo` /
 * `sameCombo` / `formatCombo` / `chordOfCombo` 四处各多一支;而这件事的真名就是
 * 「**出厂表**这一行在两台机器上不一样」—— 那是**表**的事,不是 `Combo` 的事。
 *
 * ── 量一次,而且量在这儿 ────────────────────────────────────────────────
 * 判例与 `content/terminal/key-courtesy.ts` 的 `TERMINAL_CLAIMS` 逐字相同:
 * `FOCUS_SCOPES` / `KEYMAP_COMMANDS` 都是**静态封闭表**,所以平台必须在模块加载
 * 时就定下来;纯函数一行不许读 `navigator`,所以量它的是这只文件,分档那一半
 * (`comboForPlatform`)是导出的纯函数 —— 两档因此都测得到,不必去改 UA。
 */
export interface PlatformCombos {
  readonly mac: Combo
  readonly other: Combo
}

/** 这台机器是什么。**模块加载时量一次**(判词见上)。 */
const PLATFORM: KeymapPlatform = platformOf(
  typeof navigator === 'undefined' ? '' : navigator.userAgent,
)

/** 分档那一半,**纯函数**:给定平台,这一行是哪个组合。 */
export function comboForPlatform(rows: PlatformCombos, platform: KeymapPlatform): Combo {
  return platform === 'mac' ? rows.mac : rows.other
}

/** 出厂表里写「这一行按平台分档」的那一格。 */
function byPlatform(rows: PlatformCombos): readonly Combo[] {
  return [comboForPlatform(rows, PLATFORM)]
}

/**
 * **召唤终端**的出厂键两档。导出是为了用例能把两台机器都走一遍 ——
 * 它与 `terminalClaims(platform)` 是同一条纪律的两处用法。
 *
 *  · mac  = **⌃\`**(`offHand`:那台机器上 Ctrl 是「另一枚」,⌘\` 会与系统的
 *    「在本应用的窗口间轮换」撞车 —— T1 留的那条账就是这个);
 *  · 其余 = **Ctrl+\`**(`ctrl` 读作主修饰键,而那台机器上主修饰键就是 Ctrl)。
 *
 * 两档写出来是**同一个手势**:两台机器上按的都是 Ctrl 那一枚物理键。
 */
export const TERMINAL_SUMMON_COMBOS: PlatformCombos = {
  mac: { offHand: true, key: '`' },
  other: { ctrl: true, key: '`' },
}

/**
 * 出厂绑定表。只列**有**默认键的那几条,别的一律空 ——
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
 * 08-31 拍板点名的键。出厂表这一层**没有冲突检查**,而 `lookupCommands` 按
 * `KEYMAP_COMMANDS` 的次序取命中 —— 于是次序成了裁决,`toc.toggle` 的出厂键
 * 当下按不响。裁定走的是「工作区面板改一个键」那条:**⌘⇧W**,⌘⇧O 原样还给目录。
 *
 * **K0 起出厂表自己也要过冲突规则**(`comboConflictBetween`,全表用例钉着):
 * 从前「出厂表没有冲突检查」这句话本身就是那次撞车的土壤。
 *
 * 工作区**总览**没有、也不再要独立快捷键:单击那块瓦即达,快切面板里还有一条
 * 「打开总览」的入口。两个入口够了,第三个只是在花键位预算。
 */
const DEFAULT_COMBOS: Partial<Record<CommandId, readonly Combo[]>> = {
  /*
   * **检索面出厂改 ⌘⇧F**(K2,09-12 用户裁定 3)。⌘P 在全世界的浏览器里是
   * 「打印这一页」,而这台壳把已绑定的全局键**先于页面**截下来(保留表),
   * 于是在内嵌浏览器里按 ⌘P 弹出来的是 onething 的检索面 —— 那不是决定,
   * 是副作用。让出 ⌘P 之后它自然回到页面自己手里;⌘⇧F 是 VS Code
   * (Search)与 JetBrains(Find in Path)两家「全局搜索」的同一个键,
   * 而 ⌘F(`view.find`)差的正是那一格 ⇧,读起来是「找得更远一点」。
   */
  'toggle:search': [{ meta: true, shift: true, key: 'f' }],
  /*
   * **⌘,打开设置**(K2;方案 §7 留账「`⌘,` 绑 `toggle:settings` 归 K2 顺带」)。
   * 三十年来每一个 mac 应用的偏好设置都是这个键,不给它才是替用户做主。
   * 它是 `toggle:` 那一族里的一条,所以这里只补一个键位,零新命令。
   */
  'toggle:settings': [{ meta: true, key: ',' }],
  /*
   * **召唤终端**(T1,方案 §2.1-6;`desktop-os` §8.2 核过三平台都空着)。
   *
   * ── 它为什么不是一条新命令 ─────────────────────────────────────────────
   * 派工单写的是「加全局命令 `terminal.summon`」。表里**已经有那条命令**了:
   * `toggle:<瓦 id>` 这一族的语义就是**召唤**(`keymap/types.ts` 的 `CommandId`
   * 那一段:没打开就按它的打开方式开、看不见就露出来、看得见没聚焦就送焦点、
   * 焦点已经在里面就收起来),而 `toggle:terminal` 走的正是
   * `stage/open-item.summonStageItem` —— 那只函数**先问启动瓦**
   * (`stageLauncherOf(id)`),所以「有开着的就激活最近那格,没有就开一格」
   * 逐字就是它。再登记一条 `terminal.summon` 会得到两条做同一件事的命令、
   * 设置页两行、以及一对迟早分叉的落点。所以这里只给那一行补一个**出厂键位**。
   *
   * ── 键位:主修饰键 + 反引号 ──────────────────────────────────────────
   * 出厂全表零冲突(带 ⌥ 的只有架子那四条,带 ⇧ 的只有 ⌘⇧O / ⌘⇧W / ⌘⇧↩,
   * 反引号这个位子没有第二个人占),而且它是 VS Code / Windows Terminal 一族
   * 三十年的手势。
   *
   * ── K2:两台机器上都按 Ctrl 那一枚,而那要**出厂表分档**才说得出 ──────────
   * T1 写的是 `{ ctrl: true }`,而声明侧 `ctrl` 与 `meta` 同义(都读作「主修饰
   * 键」)—— 于是这一行在 mac 上实际是 **⌘`**,与系统的「在本应用的窗口间轮换」
   * 撞车,设置页还把它画成「⌘ + 反引号」。那是 T1 自己留下的两条账之一
   * (壳 CLAUDE.md 记着),K2 结清它。
   *
   * 结清的方式**不是**让整行改用 `offHand`:`offHand` 是「非主修饰键」,mac 上
   * 是 ⌃ 没错,Win / Linux 上却是 **Win 键** —— 那两台机器上要的恰恰是 Ctrl,
   * 而 Ctrl 在那儿就是主修饰键。一行声明说不出「两台都按 Ctrl」,因为那**本来
   * 就是两档**。所以走 `byPlatform`(判词整段在它上头):mac = `offHand`、
   * 其余 = `ctrl`,两档写出来是**同一个手势**,零键位回退。
   */
  'toggle:terminal': byPlatform(TERMINAL_SUMMON_COMBOS),
  [toggleCommandId(SESSIONS_ITEM_ID)]: [{ meta: true, key: 'e' }],
  'toc.toggle': [{ meta: true, shift: true, key: 'o' }],
  'agent.menu': [{ meta: true, key: 'j' }],

  /*
   * 真全屏(W2 / 拍点 ④,09-04 用户已拍 `⌘⇧↩`)。**全表零冲突**:出厂表里带 shift
   * 的只有 `⌘⇧O`(目录)与 `⌘⇧W`(工作区面板),回车这个位子没有第二个人占。
   * 不取 `⌘⇧F` 的理由写在设计 §4.5 上:它与「在文件中查找」的通用习惯撞。
   */
  'workbench.toggleFull': [{ meta: true, shift: true, key: 'enter' }],
  'workspace.palette': [{ meta: true, shift: true, key: 'w' }],
  /*
   * ── 标签换序(W7-c 裁定 3)。**规格写的是 ⌘⌥← / ⌘⌥→,那两个位子有人**:
   * 它们从 09-01 起就是**左 / 右架子的收展**(上面 `SHELF_TOGGLE_LABELS`,
   * 「方向即语义」那一族)。规格给的是「若与既有键撞就换并写明」,所以换成
   * **⌘⌥⇧← / ⌘⌥⇧→**:它与架子那一族**同一根轴、只多一个 ⇧**,而 ⇧ 在跨应用里
   * 正是「带着这个东西一起走」的意思。
   */
  'workbench.moveTabLeft': [{ meta: true, alt: true, shift: true, key: 'arrowleft' }],
  'workbench.moveTabRight': [{ meta: true, alt: true, shift: true, key: 'arrowright' }],
  /*
   * **工作区序号 ⌘1/2/3 出厂解绑**(K2,09-12 用户裁定 2,原话「非常讨厌这个
   * 设计」,推翻 08-31 那条)。命令本身留在表上 —— 想要的人自己绑一个,能力
   * 一格没少;⌘1–9 归下面那一族 `tab.select:n`(焦点叶的第 n 格标签),与
   * 浏览器 / 终端 / 编辑器的手一致。这里**一行都不写**就是「出厂不绑」。
   */
  /* ── 从前的面域局部键(K0:同一张表,`app: false`)────────────────────── */
  'view.find': [{ meta: true, key: 'f' }],
  'view.save': [{ meta: true, key: 's' }],
  'viewer.gotoLine': [{ meta: true, key: 'l' }],
  'browser.address': [{ meta: true, key: 'l' }],
  /*
   * **一条命令两个出厂键**(⌘I 与 ⌘↵)。旧表把它写成**两行**,理由是「表要能
   * 逐条说出『⌘↵ 被谁占着』」—— 而两行意味着两个意义,于是设置页也就说不出
   * 「详情」这一条到底绑着什么。K0 把它归位成一行两键:说得出「谁占着 ⌘↵」
   * 的是**冲突规则**(按组合找命令),不是表的行数。
   */
  'files.detail': [
    { meta: true, key: 'i' },
    { meta: true, key: 'enter' },
  ],
  'nav.back': [{ meta: true, key: '[' }],
  'nav.forward': [{ meta: true, key: ']' }],
  /* ── 内容族(K3,方案 §3 那张跨应用对照表的「本壳应当」列)──────────────
   *
   * 这四条与 `KEYS_RESERVED_FOR_CONTENT`(K1,`electron/app-menu.ts`)是**同一件事
   * 的两半**:K1 那张表说的是「⌘R / ⌘+ / ⌘− / ⌘0 不归应用菜单」,这里说的是
   * 「那它们归谁」。K1 落地到 K3 之间这四个键是**没有归宿**的(菜单让开了、
   * 还没人认领 —— 按下去什么都不发生),K3 把它们接住。
   */
  'view.reload': [{ meta: true, key: 'r' }],
  /*
   * **一条命令两个键面**,而这一对不是惯例是**键盘的事实**:⌘= 与 ⌘+ 在 US 布局
   * 上是同一枚物理键,按不按 ⇧ 决定 Chromium 报的是 `'='` 还是 `'+'`。两行都收
   * 是因为人两种都按(Chrome 自己也两种都收);第二行**必须带 `shift`** ——
   * `matchCombo` 是逐格比对(`(combo.shift === true) === e.shiftKey`),不写
   * `shift` 的话真按下 ⌘⇧= 那一下永远对不上。
   */
  'view.zoomIn': [
    { meta: true, key: '=' },
    { meta: true, shift: true, key: '+' },
  ],
  'view.zoomOut': [{ meta: true, key: '-' }],
  /*
   * ⌘0 这个位子今天是空的:`workspace.slot:1–3` 在 K2 出厂解绑,`tab.select:n`
   * 那一族占的是 ⌘1–⌘9(第 9 条是「最后一格」,没有第十条)。
   */
  'view.zoomReset': [{ meta: true, key: '0' }],
  'expose.pin': [{ meta: true, shift: true, key: 'p' }],
  'tab.close': [{ meta: true, key: 'w' }],
  /* ── 标签族(K2,方案 §3 那张跨应用对照表的「本壳应当」列)────────────── */
  'tab.new': [{ meta: true, key: 't' }],
  'content.new': [{ meta: true, key: 'n' }],
  'tab.reopen': [{ meta: true, shift: true, key: 't' }],
  /*
   * **一条命令两组出厂键**(⌘⇧] 与 ⌃Tab)。两家惯例都在:Safari / Chrome /
   * Terminal 的 ⌘⇧] ⌘⇧[,以及跨平台通用的 ⌃Tab ⌃⇧Tab。K0 起「一条命令好几个
   * 键面」是一等形状,所以它是**一行两键**而不是两行两义 —— 说得出「谁占着
   * ⌃Tab」的是冲突规则(按组合找命令),不是表的行数。
   *
   * ⌃Tab 那一枚用的是 `offHand`(判词在 `Combo.offHand` 上):它要的**就是**
   * Ctrl 那一枚物理键,而不是「主修饰键」。
   */
  'tab.next': [
    { meta: true, shift: true, key: ']' },
    { offHand: true, key: 'tab' },
  ],
  'tab.prev': [
    { meta: true, shift: true, key: '[' },
    { offHand: true, shift: true, key: 'tab' },
  ],
  ...Object.fromEntries(
    Array.from({ length: TAB_SELECT_SLOTS }, (_, i) => [
      tabSelectCommandId(i + 1),
      [{ meta: true, key: String(i + 1) }],
    ]),
  ),
}

function defaultCombosOf(id: CommandId): readonly Combo[] {
  return DEFAULT_COMBOS[id] ?? []
}

/** 应用级命令的共同形:有兜底实现、在原生视图里先于页面截下来。 */
function appCommand(id: CommandId, labelKey: MessageKey): KeymapCommand {
  return { id, labelKey, defaultCombos: defaultCombosOf(id), app: true, nativeView: 'reserve' }
}

/** 架子那四条的出厂键写在 `SHELF_TOGGLE_LABELS` 上(方向即语义,一处说完)。 */
const SHELF_TOGGLE_COMMANDS: KeymapCommand[] = SHELF_TOGGLE_LABELS.map((row) => ({
  id: shelfToggleCommandId(row.side),
  labelKey: row.labelKey,
  defaultCombos: [row.combo],
  app: true,
  nativeView: 'reserve',
}))

/**
 * 工作区序号直达的命令行。**三条是键位预算,不是能力上限** ——
 * 第四个工作区照样能切(菜单 / 面板 / 总览三处都在),只是没有直达键。
 * 数目由 WORKSPACE_SLOT_COUNT 说了算,这里不写死一个 3。
 */
const WORKSPACE_SLOT_COMMANDS: KeymapCommand[] = Array.from(
  { length: WORKSPACE_SLOT_COUNT },
  (_, i): KeymapCommand => appCommand(workspaceSlotCommandId(i + 1), WORKSPACE_SLOT_LABEL_KEYS[i]),
)

/**
 * 跟随焦点那十五条(`app: false`;K2 起标签族也在其中)。**没有应用层兜底** —— 活动路径上没人答得出
 * 就放行,而不是「退一步找个人做掉」。每块面的说法挂在 `FOCUS_SCOPES[*].answers`
 * 的 `labelKey` 上,这里只写命令自己那一句通名。
 */
function scopedCommand(id: CommandId, labelKey: MessageKey): KeymapCommand {
  return { id, labelKey, defaultCombos: defaultCombosOf(id), app: false, nativeView: 'reserve' }
}

/**
 * 第 n 格标签那九条。数目由 `TAB_SELECT_SLOTS` 说了算,这里不写死一个 9
 * (与 `WORKSPACE_SLOT_COMMANDS` 逐字同一条纪律)。
 */
const TAB_SELECT_COMMANDS: KeymapCommand[] = Array.from(
  { length: TAB_SELECT_SLOTS },
  (_, i): KeymapCommand => scopedCommand(tabSelectCommandId(i + 1), TAB_SELECT_LABEL_KEYS[i]),
)

const SCOPED_COMMANDS: KeymapCommand[] = [
  /*
   * **一条命令,三个响应者**(查看器「在这份文件里检索」/ 终端「在这块屏幕里
   * 查找」/ 浏览器「在这一页里查找」)。命令自己那一句是通名 `keymap.find`
   * ——「查找在每块面里都是 ⌘F」从此是**设计**,不再是三行恰好相同的巧合。
   * 三句面上的说法一句没少,它们挂在 `answers` 上(i18n 纪律:三句话三个键)。
   */
  scopedCommand('view.find', 'keymap.find'),
  scopedCommand('view.save', 'viewer.save'),
  scopedCommand('viewer.gotoLine', 'viewer.jumpLabel'),
  scopedCommand('browser.address', 'browser.address'),
  scopedCommand('files.detail', 'files.detailAction'),
  /*
   * **后退 / 前进:一条命令,两个响应者**(K3 收编)。K0 起名字就已经是通名
   * (`nav.*` 而不是 `search.*`),但那时只有检索面一个响应者,所以命令自己那
   * 一句借用了它的说法。今天浏览器也答它了,于是通名要真的是通名:两块面各自
   * 的话挂回 `answers`(检索面「查询历史的上一条」/ 浏览器「上一页」)。
   */
  scopedCommand('nav.back', 'keymap.navBack'),
  scopedCommand('nav.forward', 'keymap.navForward'),
  scopedCommand('expose.pin', 'expose.pin'),
  scopedCommand('tab.close', 'common.close'),
  /*
   * ── 标签族六条(K2)。全是 `app: false` —— 判词在 `keymap/types.ts` 的
   *    `CommandId` 那一段:它们要的目标是**焦点那片叶的那一排标签**,没有叶
   *    在场就放行,而不是退一步找个人做掉。⌘N 从前在浏览器里开出一条会话,
   *    病根正是它当年有一层应用兜底。
   */
  scopedCommand('tab.new', 'keymap.tabNew'),
  scopedCommand('content.new', 'keymap.contentNew'),
  scopedCommand('tab.reopen', 'keymap.tabReopen'),
  scopedCommand('tab.next', 'keymap.tabNext'),
  scopedCommand('tab.prev', 'keymap.tabPrev'),
  ...TAB_SELECT_COMMANDS,
  /*
   * ── 内容族四条(K3)。全是 `app: false`,判词与标签族逐字相同:它们要的目标是
   *    **焦点那块内容**。「重载」在会话里根本不是一件事(一条会话没有「再读一遍」
   *    这个动作),所以没有兜底就是对的 —— 从前 ⌘R 有一层兜底,而那层兜底是
   *    Electron 默认菜单的 `BrowserWindow.reload()`:重载整台壳(P2 的正题)。
   */
  scopedCommand('view.reload', 'keymap.viewReload'),
  scopedCommand('view.zoomIn', 'keymap.zoomIn'),
  scopedCommand('view.zoomOut', 'keymap.zoomOut'),
  scopedCommand('view.zoomReset', 'keymap.zoomReset'),
]

/**
 * 命令表 —— **封闭**。加一个命令就是在这里多一行:
 * 每块 Dock 瓦自动有一条 toggle(所以瓦表长出新瓦时这里不用改),
 * 加上不属于任何一块瓦的那些开关,再加上跟随焦点那一族(K0 的九条 + K2 的标签族)。
 *
 * 会话总览也在瓦那一族里:它有 Placement,「呼出 / 收回」对它和别的瓦是同一句话。
 */
export const KEYMAP_COMMANDS: KeymapCommand[] = [
  ...STAGE_ITEMS.map<KeymapCommand>((item) => appCommand(toggleCommandId(item.id), item.titleKey)),
  ...SHELF_TOGGLE_COMMANDS,
  appCommand('workspace.palette', 'workspace.paletteLabel'),
  ...WORKSPACE_SLOT_COMMANDS,
  // TOC 面板不是 StageItem,但它的开关同样是命令类快捷键(08-29 全称拍板:都可设置)
  appCommand('toc.toggle', 'toc.title'),
  // 顶栏 agent 切换器:同样不是瓦,同样是「呼出一块面」的命令(08-30)。
  appCommand('agent.menu', 'agent.menuLabel'),
  /*
   * 真全屏(W2)。它是**应用级**而不是跟随焦点的:按下去时焦点可能在任何地方
   * (侧栏、输入框、总览),而它要的目标是「焦点叶的活动 tab」—— 那是 store 答
   * 得出的一句话,不需要键盘落在那片叶里。判据即三层立法那一条:需不需要一个
   * **由焦点决定的目标**,而不是「有没有目标」。
   */
  appCommand('workbench.toggleFull', 'keymap.toggleFull'),
  /* 标签换序两条(W7-c)。与 `workbench.toggleFull` 同一族。 */
  appCommand('workbench.moveTabLeft', 'keymap.moveTabLeft'),
  appCommand('workbench.moveTabRight', 'keymap.moveTabRight'),
  ...SCOPED_COMMANDS,
]

export function findCommand(id: CommandId): KeymapCommand | undefined {
  return KEYMAP_COMMANDS.find((c) => c.id === id)
}

/* ── 谁可能答一条命令 ─────────────────────────────────────────────────────── */

/**
 * **可能**答这条命令的那几格作用域(从 `FOCUS_SCOPES[*].answers` 读)。
 *
 * 「可能」是声明这一头的话:树上有没有那一格实例、那一格此刻交不交得出处理器,
 * 是另一回事(实例那一头,`ScopeNode.commands`)。冲突规则要的正是声明这一头 ——
 * 「两条命令会不会同时在场」这句话不能等到按键那一刻才回答。
 */
export function scopesAnswering(command: CommandId): readonly FocusScopeId[] {
  const out: FocusScopeId[] = []
  for (const spec of FOCUS_SCOPE_LIST) {
    if (spec.answers?.some((answer) => answer.command === command)) out.push(spec.id)
  }
  return out
}

/* ── 冲突规则(一条,`bindCombo` 与出厂表同用)───────────────────────────── */

/**
 * 两条命令**共用一个键**时的裁决。null = 合法。
 *
 * 规则一条,两种红:
 *  · **`app: true` 的至多一条** —— 应用层兜底没有「谁先」可言,两条都有兜底
 *    就一定有一条永远轮不到;
 *  · 其余每两条的**作用域集合两两不交** —— 不同时在场才许共键。
 *
 * 合法的例子:⌘L 上 `browser.address` 与 `viewer.gotoLine`(浏览器与查看器不会
 * 同在一条活动路径上);一条 `app: true` 与一条 `app: false` 共键(局部先接、
 * 没接住放行全局,那正是三层立法那句裁定)。
 *
 * 回的是「与谁撞、按哪一条规则撞」,不是一个布尔 —— 设置页要把这句话说出口,
 * 而「与某某冲突」与「这块面里两个都可能答」是两种不同的话。
 */
export type ComboConflict =
  | { rule: 'app'; with: CommandId }
  | { rule: 'overlap'; with: CommandId; scope: FocusScopeId }

export function comboConflictBetween(a: CommandId, b: CommandId): ComboConflict | null {
  const left = findCommand(a)
  const right = findCommand(b)
  if (!left || !right) return null
  if (left.app && right.app) return { rule: 'app', with: b }
  const mine = new Set(scopesAnswering(a))
  for (const scope of scopesAnswering(b)) {
    if (mine.has(scope)) return { rule: 'overlap', with: b, scope }
  }
  return null
}
