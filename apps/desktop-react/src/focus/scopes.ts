import { TERMINAL_CLAIMS } from '../content/terminal/key-courtesy'
import type { Combo, CommandId } from '../keymap/types'
import type { FocusScopeId, FocusScopeSpec, ScopeAnswer } from './types'

/**
 * **作用域封闭表**(R0;K0 起它声明的是「答哪些命令」而不是「有哪几个键」)。
 * 一格 = 一种「能接键盘的面」的**声明**:它的行为档、它的名字、它答得出的那
 * 几条命令(以及它替里面那台程序认领的那几个键)。树上有几份实例与这张表无关
 * (§4.8)。
 *
 * ── 加一格的规矩 ────────────────────────────────────────────────────────
 * 加一个作用域 = ①这张表加一行 ②`types.ts` 的 `FocusScopeId` 加一格
 * ③它的 labelKey 在 zh/en 两本字典里成对存在。三件缺一件当场红
 * (`__tests__/scopes.test.ts`)。**这张表是封闭的**:没有「运行时注册一个新
 * 作用域种类」这条路 —— 那正是浮层栈那种「谁在上面靠猜」的来源。
 *
 * ── K0:`keys` → `answers`,键位不在这里了 ───────────────────────────────
 * 从前每块面在这里自报键位(`ScopedKey { combo, labelKey, action }`)。于是
 * 「⌘F 在哪几块面里是查找」要靠三行恰好写着同一个组合,而**键位语义**由每块
 * 面自己发明、自己保证与邻居一致;设置页的「谁在用 ⌘F」只能从撞车里反推。
 * K0 把键与意义搬进唯一那张命令表(`keymap/commands.ts`),这里只剩一句自述:
 * **我答得出哪几条命令**(`answers`)。用户改绑一次,每个响应者自动跟着;
 * 三块面各自的说法挂在 `answers` 那一格的 `labelKey` 上,一句没少。
 *
 * ── labelKey 为什么有的复用有的新开 ──────────────────────────────────────
 * i18n 纪律是「同一句话只该有一个键」。查看器已经有 `viewer.label`、Dock 已经有
 * `dock.label`、四块内容面在 Dock 瓦上已经有 `item.*` —— 再开一份
 * `focus.scope.viewer` 就是同一句话的第二个产地。所以**能复用的复用,真缺的才补**,
 * 补的那 14 条统一在 `focus.scope.*` 家族下。哪一格复用了谁,下表 labelKey 那一列
 * 自己写着。
 */

/** 一行 `answers`,写起来短一点(`answers: [answer('view.find', 'terminal.find')]`)。 */
function answer(command: CommandId, labelKey?: ScopeAnswer['labelKey']): ScopeAnswer {
  return labelKey ? { command, labelKey } : { command }
}

/**
 * 查看器三条:⌘S 存、⌘L 跳到某一行、⌘F 在这份文件里检索。
 *
 * 三条都是 `app: false` 的命令 —— 判据仍是那一句「一个键属不属于这一层,由它
 * 需不需要一个目标决定」:要存的是**这一份文件**,没有查看器在场时它无处可去。
 *
 * `view.find` 复用命令表里那一条通名,说法覆盖成 `viewer.findLabel`
 * (「在这份文件里检索」—— 说的是文件);`viewer.gotoLine` 与 `browser.address`
 * 共用 ⌘L,合法的理由写在命令表的冲突规则上(两块面不会同时在场)。
 */
const VIEWER_ANSWERS: readonly ScopeAnswer[] = [
  answer('view.save'),
  answer('viewer.gotoLine'),
  answer('view.find', 'viewer.findLabel'),
]

/**
 * 文件树一条:⌘I 与 ⌘↵ 都是「详情」。
 *
 * **一条 answer,不是两条** —— 它们是同一件事的两个键面,而「一条命令可以有
 * 好几个出厂键」现在由命令表的 `defaultCombos` 说得出口(K0 之前这里是两行,
 * 两行意味着两个意义)。
 *
 * 一格声明的历史:更早的表里叫 `files.row`(键长在**行**上),R0 归到 `files`
 * 作用域名下 —— 树上不会有「一行」这么细的作用域(行是文件树内部的 roving 目标,
 * 不是一块能接键盘的面)。
 */
const FILES_ANSWERS: readonly ScopeAnswer[] = [answer('files.detail')]

/**
 * 检索面两条:⌘[ / ⌘] = 查询历史的后退 / 前进(检索重建 S4b,设计
 * `docs/design/search-index-2026-09.md` §4.6)。
 *
 * K0 起它们叫 `nav.back` / `nav.forward` —— **后退 / 前进**这件事在浏览器上也是
 * 同一条命令(K3 接),所以名字先立成通名,说法仍是这块面自己的那一句
 * (命令的通名就用 `search.historyBack` / `search.historyForward`,今天只有一个
 * 响应者,不必先造一句没人读的通名)。
 *
 * ── ↑ 那一下**不在这张表上**,这也是判据不是省事 ────────────────────────
 * §4.6 里 ↑ 与 ⌘[ 是同一条历史的两个入口,但它们属于**两层**:↑ 是行内结构键
 * (方向键的 DOM 焦点语义),它在这块面里先是「走行」、只在「输入框空着且停在
 * 第一行」那一形才轮到历史 —— 那是一句关于这套形态语法的话,而结构键**不进任何表**
 * (`keymap/types.ts` 顶部:可配置就等于不一致)。落点因此在面板自己的 onKeyDown 里。
 */
const SEARCH_ANSWERS: readonly ScopeAnswer[] = [answer('nav.back'), answer('nav.forward')]

/**
 * 会话总览一条:⌘⇧P = 置顶 / 取消置顶**活动行**(09-04 方向 A §3.2)。
 *
 * 它为什么是一条**命令**而不是行内结构键(像 ↑↓ / Space / ↵ 那样直接挂在作用域
 * 根的 onKeyDown 上):带修饰的组合会与别的键撞车,而命令表正是撞车的唯一账本。
 * 无修饰的单键不进表 —— 它们是这块面形态的语法,不是可改的键位。
 *
 * 命令的通名复用行上那颗图钉的名字(`expose.pin`),不新开一句:同一个动作在
 * 两处出现只该有一个说法。
 */
const EXPOSE_ANSWERS: readonly ScopeAnswer[] = [answer('expose.pin')]

/**
 * 一片叶一条:⌘W = 关当前 tab(设计 §2.3 / 拍点 ④,09-04 用户已拍)。
 *
 * 它是 `app: false` 而不是应用级命令:它需要一个目标(哪一片叶的哪一格),
 * 而「需不需要一个目标」正是三层立法的判据。⌘⇧W 是工作区命令面板,shift 那一格
 * 就是两者的分界。命令的通名复用 `common.close`(i18n 纪律)。
 */
const LEAF_ANSWERS: readonly ScopeAnswer[] = [answer('tab.close')]

/**
 * 内嵌浏览器两条:⌘L 回地址栏(B2,方案 §9-1 末段)、⌘F 在这一页里查找(B3-a)。
 *
 * ── 它们同时是**保留键**,而那是从命令表派生的 ──────────────────────────
 * 键盘此刻可能就在那片原生视图里(人正在看那一页),而页面自己也想要 ⌘L / ⌘F。
 * 键位下沉那张表(`content/native-view/keymap-downlink.ts`)收的是
 * 「`nativeView === 'reserve'` 且这几格作用域答得出」的命令 —— 所以**在这里加
 * 一行,主进程那张保留键表就自动多一格**:页面有焦点时按 ⌘F,
 * `before-input-event` 先截下来推回壳,开的是壳自己那一行。这正是 Chrome
 * 「保留键先于页面」的形。
 *
 * ⌘F 的说法覆盖成 `browser.find`(「在这一页里查找」—— 说的是页),与终端的
 * 「这块屏幕」、查看器的「这份文件」是三句话。
 *
 * Esc **不声明**:Esc 在页面里归页面(vim 式网页、编辑器网页都要它)。离开页面
 * 的路是 ⌘L 与点别处 —— 与 `terminal` 那一格不声明 Esc 是同一句判词。
 */
const BROWSER_ANSWERS: readonly ScopeAnswer[] = [
  answer('browser.address'),
  answer('view.find', 'browser.find'),
]

/**
 * 终端一条:⌘F = 在这块屏幕里查找(T2)。
 *
 * ── 为什么它是一条命令而不是「全局的」 ──────────────────────────────────
 * 判据仍是那一句「一个键属不属于这一层,由它需不需要一个目标决定」:要找的是
 * **这一格终端的回滚缓冲**,没有终端在场时它无处可去 —— 也就是 `app: false`。
 *
 * ── 它与查看器 / 浏览器的 ⌘F 撞不撞 ──────────────────────────────────────
 * K0 之后这个问题不成立了:三块面答的是**同一条命令** `view.find`,不是三条
 * 恰好同键的局部键。设置页那一行右边列着「谁答」:浏览器(这一页)/ 终端
 * (这块屏幕)/ 查看器(这份文件)。
 *
 * ── 它与认领表并排,次序是有意的 ────────────────────────────────────────
 * 认领表那几行(Win / Linux 的 `Ctrl+P/E/J/N/W`,`claims` 那一格)说的是
 * 「这几个键归 PTY」,这一条说的是「这一个键归应用」。两句话住在同一格声明上,
 * 下一个想往认领表里加字母的人一眼看得见还有谁在这块面上占着位子 —— `f` 不在
 * 认领表里(`^F` 在 readline 里是「右移一格」,而右移一格有方向键;查找没有
 * 第二条路)。
 *
 * 说法覆盖成 `terminal.find`(原话「在这块屏幕里查找」),不复用查看器那一句
 * 「在这份文件里检索」—— i18n 纪律管的是「同一句话只该有一个键」,这里是两句话。
 */
const TERMINAL_ANSWERS: readonly ScopeAnswer[] = [answer('view.find', 'terminal.find')]

export const FOCUS_SCOPES: Readonly<Record<FocusScopeId, FocusScopeSpec>> = {
  /* ── root:整台壳,只有一个 ──────────────────────────────────────────── */
  root: { id: 'root', kind: 'root', labelKey: 'a11y.appTitle' },

  /* ── region:内容面(§4.1 第三行)───────────────────────────────────── */
  viewer: { id: 'viewer', kind: 'region', labelKey: 'viewer.label', answers: VIEWER_ANSWERS },
  files: { id: 'files', kind: 'region', labelKey: 'item.files', answers: FILES_ANSWERS },
  composer: { id: 'composer', kind: 'region', labelKey: 'focus.scope.composer' },
  search: { id: 'search', kind: 'region', labelKey: 'item.search', answers: SEARCH_ANSWERS },
  expose: { id: 'expose', kind: 'region', labelKey: 'item.sessions', answers: EXPOSE_ANSWERS },
  /*
   * 消息流。**W5-b 起它是一族带 owner 的实例**(裁定 6,照下面 `leaf` 那一格
   * 的样板):会话多开之后同一个 scope id 会有好几份 —— 一片会话叶一份,
   * owner = 那一格的 refId(`content/session-ref.sessionRefIdOf`)。
   * `activateScope('chat', { owner })` 据此精确取到**那一条会话**的消息流,
   * 而壳启动那条三级回落(composer → chat(焦点叶的)→ root)问的正是它。
   * 声明这一头一个字没改:owner 是**实例**的事,不是声明的事(§4.8)。
   */
  chat: { id: 'chat', kind: 'region', labelKey: 'focus.scope.chat' },
  /*
   * 一张**权限卡**(应用级许可 · 壳半边,2026-09-10)。一次调用一份实例,
   * owner = 那次调用的 `toolCallId`。
   *
   * 行为档是 `region` 而不是 `float`:`float` 的缺省 Esc 是「关自己」,而一张
   * 权限卡**关不掉** —— 那头有一台引擎在等一个答案,把卡收起来只会让人以为
   * 这件事过去了。它因此也**不声明 `onEscape`**(不传 = 根本不进 Esc 候选表),
   * Esc 照旧穿过去交给外面那一层(消息流 / 叶 / 全屏)。
   *
   * 它没有局部键:五个答案各是一颗真按钮,走的是 Tab + ↵ / Space 那套结构键语义
   * (数字快捷键 1/2/3 是另一次拍板,本单不做,留账在回报里)。
   */
  permission: { id: 'permission', kind: 'region', labelKey: 'focus.scope.permission' },
  settings: { id: 'settings', kind: 'region', labelKey: 'item.settings' },
  /*
   * 音乐面(音乐收尾 · 壳半边)。**三件声明**里它只填两件:
   *  · 落点(`restingTarget`)= 播放 / 暂停那颗钮 —— 进这块面第一件想做的事就是
   *    让它响或者让它停;
   *  · Esc **不声明**(不传 = 根本不进 Esc 候选表)。一块摆在架子上的内容面没有
   *    「关自己」这回事(关一格 tab 是 ⌘W 那条显式的键),Esc 该穿过去交给外面
   *    那一层 —— 与 `permission` 那一格不声明 `onEscape` 是同一句判词。
   * 没有局部键:面上每一件都是一颗真按钮或一条 `role="slider"`,走的是 Tab + ↵ /
   * Space / 方向键那套**结构键**语义(第三层,不进任何表)。
   * labelKey 复用 Dock 瓦那一句(i18n 纪律:同一句话只该有一个键)。
   */
  /*
   * 一格终端(T1,方案 `apps/desktop-react/docs/terminal-browser-2026-09.md`
   * §2.1-7,按深查 9-1 末段改判)。**三件声明**:
   *  · 落点(`restingTarget`)= 那块屏幕的容器(实例侧声明;进去之后键盘落在
   *    xterm 自己的 textarea 上,那是**作用域内部**的移动);
   *  · Esc **不声明** —— Esc 是 PTY 的键(vim 一秒按三次)。不传 = 不进 Esc
   *    候选表 = 派发器问不到人 = 不 `preventDefault` = xterm 照常把它发下去。
   *    与 `permission` / `music` 两格不声明 Esc 是同一句判词的三种用法;
   *  · 答一条命令(`view.find`,判词在 `TERMINAL_ANSWERS` 上)+ **认领五个键**
   *    (`claims`:Win / Linux 上 PTY 要的 `Ctrl+P/E/J/N/W`)。认领那一族是全表
   *    唯一一族「壳不碰、原样交给里面那台程序」的键 —— 判词与那五个字母是怎么
   *    选出来的,整段在 `content/terminal/key-courtesy.ts` 上。
   *    命令的落点是 `TerminalLeaf` 注入的 `commands`;认领此刻在不在,由那一格
   *    实例的 `claiming` 说(查找框里打字时整族让开)。
   * labelKey 复用 Dock 瓦那一句(i18n 纪律:同一句话只该有一个键)。
   */
  terminal: {
    id: 'terminal',
    kind: 'region',
    labelKey: 'item.terminal',
    answers: TERMINAL_ANSWERS,
    claims: TERMINAL_CLAIMS,
  },
  music: { id: 'music', kind: 'region', labelKey: 'item.music' },
  /*
   * 一格内嵌浏览器(B2,方案 §9-1)。**三件声明**:
   *  · 落点(`restingTarget`)= 那片原生视图的占位格(实例侧声明)。进去之后键盘
   *    落在 `WebContentsView` 里 —— I1 在这一格的读法是「activeElement = 占位格,
   *    原生视图是它的**里面**」,与终端「键盘落在 xterm 的 textarea 上」同形;
   *  · Esc **不声明** —— Esc 在页面里归页面。不传 = 不进 Esc 候选表 = 派发器问
   *    不到人 = 不 `preventDefault` = 那一下归页面自己。与 `terminal` / `music` /
   *    `permission` 三格不声明 Esc 是同一句判词的第四种用法;
   *  · 答两条命令 = ⌘L 回地址栏 + ⌘F 在这一页里查找(判词整段写在
   *    `BROWSER_ANSWERS` 上,含「它们同时是保留键」那一半)。
   * labelKey 复用 Dock 瓦那一句(i18n 纪律:同一句话只该有一个键)。
   */
  browser: { id: 'browser', kind: 'region', labelKey: 'item.browser', answers: BROWSER_ANSWERS },
  dock: { id: 'dock', kind: 'region', labelKey: 'dock.label' },
  /*
   * 拼贴树里的一片叶(W1)。行为档 `region` —— 它是一块能接键盘的面,不是一层
   * Placement 宿主:Tab 走得出去、Esc 不缺省认领(叶没有「关自己」这回事,
   * 关一格 tab 是 ⌘W 那条**显式**的键)。
   */
  /*
   * 叶是**家具**:进它就是进它装着的那块内容(`passThrough`,判词写在
   * `FocusScopeSpec.passThrough` 上)。它仍旧是 `region` —— 它有自己的局部键
   * (⌘W 关这一格 = 它答 `tab.close`),而那正是 `region` 与 `layer` 在快捷键
   * 三层里的分野。
   */
  leaf: {
    id: 'leaf',
    kind: 'region',
    labelKey: 'focus.scope.leaf',
    answers: LEAF_ANSWERS,
    passThrough: true,
  },

  /* ── layer:三个 Placement 宿主 + 全屏那一层(§4.1 第二行;W2 起 `full-layer`
   *    顶掉了 `cover-layer` —— 全屏不是一种 Placement,但它同样是「装着一块面的
   *    一层」,行为档与那三个逐字相同)────────────────────────────────── */
  'stage-layer': { id: 'stage-layer', kind: 'layer', labelKey: 'focus.scope.stageLayer' },
  'float-layer': { id: 'float-layer', kind: 'layer', labelKey: 'focus.scope.floatLayer' },
  'shelf-layer': { id: 'shelf-layer', kind: 'layer', labelKey: 'focus.scope.shelfLayer' },
  'full-layer': { id: 'full-layer', kind: 'layer', labelKey: 'focus.scope.fullLayer' },

  /* ── float:非模态临时面,Esc 缺省关自己 ─────────────────────────────── */
  jumpbar: { id: 'jumpbar', kind: 'float', labelKey: 'focus.scope.jumpbar' },
  drawer: { id: 'drawer', kind: 'float', labelKey: 'focus.scope.drawer' },
  zoom: { id: 'zoom', kind: 'float', labelKey: 'focus.scope.zoom' },
  tooltip: { id: 'tooltip', kind: 'float', labelKey: 'focus.scope.tooltip' },

  /* ── modal:Tab 出不去 ──────────────────────────────────────────────── */
  dialog: { id: 'dialog', kind: 'modal', labelKey: 'focus.scope.dialog' },
  menu: { id: 'menu', kind: 'modal', labelKey: 'focus.scope.menu' },
  palette: { id: 'palette', kind: 'modal', labelKey: 'focus.scope.palette' },
  /*
   * **popover 归 modal,不是 float**(R1 收编时改的一格,设计 §4.1 那张表里它
   * 写在 float 行)。理由是那张表的 `float` 行括号里写着「非模态」,而**那个
   * 「模态」说的是 ARIA**(要不要 `aria-modal`、读屏能不能看见外面);行为档
   * `modal` 说的是**Tab 走不走得出去**,两个词在这里刚好错开。
   * `ui/Popover` 今天就在圈禁 Tab(它消费 `useFocusTrap`,文件头写着「圈禁与
   * aria-modal 是两件事:附属浮层要前者不要后者」)。归 float 会当场少掉圈禁 ——
   * 那是可感知的行为变化,而 R1 守的是逐条相同。所以按**它今天的行为**归档。
   */
  popover: { id: 'popover', kind: 'modal', labelKey: 'focus.scope.popover' },
}

/** 全表,按声明序。 */
export const FOCUS_SCOPE_LIST: readonly FocusScopeSpec[] = Object.values(FOCUS_SCOPES)

/** 一格作用域答得出的那几条命令(声明这一头)。 */
export function focusScopeAnswersOf(scope: FocusScopeId): readonly ScopeAnswer[] {
  return FOCUS_SCOPES[scope].answers ?? []
}

/** 一格作用域替里面那台程序认领的那几个键(今天只有 `terminal` 非空)。 */
export function focusScopeClaimsOf(scope: FocusScopeId): readonly Combo[] {
  return FOCUS_SCOPES[scope].claims ?? []
}
