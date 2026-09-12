import { TERMINAL_SCOPED_KEYS } from '../content/terminal/key-courtesy'
import type { FocusScopeId, FocusScopeSpec, ScopedKey } from './types'

/**
 * **作用域封闭表**(R0)。一格 = 一种「能接键盘的面」的**声明**:它的行为档、
 * 它的名字、它自己那几个局部键。树上有几份实例与这张表无关(§4.8)。
 *
 * ── 加一格的规矩 ────────────────────────────────────────────────────────
 * 加一个作用域 = ①这张表加一行 ②`types.ts` 的 `FocusScopeId` 加一格
 * ③它的 labelKey 在 zh/en 两本字典里成对存在。三件缺一件当场红
 * (`__tests__/scopes.test.ts`)。**这张表是封闭的**:没有「运行时注册一个新
 * 作用域种类」这条路 —— 那正是浮层栈那种「谁在上面靠猜」的来源。
 *
 * ── labelKey 为什么有的复用有的新开 ──────────────────────────────────────
 * i18n 纪律是「同一句话只该有一个键」。查看器已经有 `viewer.label`、Dock 已经有
 * `dock.label`、四块内容面在 Dock 瓦上已经有 `item.*` —— 再开一份
 * `focus.scope.viewer` 就是同一句话的第二个产地。所以**能复用的复用,真缺的才补**,
 * 补的那 14 条统一在 `focus.scope.*` 家族下。哪一格复用了谁,下表 labelKey 那一列
 * 自己写着。
 *
 * ── 局部键:今天只有两格有 ───────────────────────────────────────────────
 * `viewer` 三条、`files` 两条 —— 它们是从 `keymap/scopes.ts` 的 `SCOPED_KEYS`
 * **搬进来**的(R0 只搬声明,落点仍在各面自己的 element listener 上,R2 才迁)。
 * 旧那张表现在从这里派生,所以两处不可能分叉:它们是同一份数据的两种投影。
 *
 * 一格声明的变化:旧表里叫 `files.row`(键长在**行**上),这里归到 `files`
 * 作用域名下 —— 树上不会有「一行」这么细的作用域(行是文件树内部的 roving 目标,
 * 不是一块能接键盘的面)。旧 id 由 `keymap/scopes.ts` 的兼容表原样发出去,
 * 所以既有测试与既有读者一个字都不用改;R2 迁落点时那格兼容表随之退役。
 */

const VIEWER_KEYS: readonly ScopedKey[] = [
  { scope: 'viewer', combo: { meta: true, key: 's' }, labelKey: 'viewer.save', action: 'save' },
  { scope: 'viewer', combo: { meta: true, key: 'l' }, labelKey: 'viewer.jumpLabel', action: 'jump' },
  { scope: 'viewer', combo: { meta: true, key: 'f' }, labelKey: 'viewer.findLabel', action: 'find' },
]

/**
 * 会话总览一条:⌘⇧P = 置顶 / 取消置顶**活动行**(09-04 方向 A §3.2)。
 *
 * 它为什么是一条**面域局部键**而不是行内结构键(像 ↑↓ / Space / ↵ 那样直接挂在
 * 作用域根的 onKeyDown 上):带修饰的组合会与全局键位撞车,而这张表正是撞键的
 * 唯一账本(设置页的撞键提示与键位速查都读 `FOCUS_SCOPED_KEYS`)。
 * 无修饰的单键不进表 —— 它们是这块面形态的语法,不是可改的键位。
 *
 * labelKey 复用行上那颗图钉的名字(`expose.pin`),不新开一句:同一个动作在
 * 两处出现只该有一个说法(i18c 纪律,与 `files` 那两行复用 `files.detailAction`
 * 同一条)。
 */
const EXPOSE_KEYS: readonly ScopedKey[] = [
  {
    scope: 'expose',
    combo: { meta: true, shift: true, key: 'p' },
    labelKey: 'expose.pin',
    action: 'pin.toggle',
  },
]

/**
 * 检索面两条:⌘[ / ⌘] = 查询历史的后退 / 前进(检索重建 S4b,设计
 * `docs/design/search-index-2026-09.md` §4.6 结论最后一段:「返回靠检索框本来就该
 * 有的**查询历史**(↑ 回上一条、⌘[ 后退),与浏览器地址栏同形」)。
 *
 * ── 为什么是**面域局部键**而不是全局命令 ────────────────────────────────
 * 判据是那条法的原话:「一个键属于哪一层,由**它需不需要一个目标**决定」。
 * 「回上一条查询」需要一个目标 —— 那块面自己的那条历史;检索面关着的时候它
 * 无处可去。全局档管的是「焦点在哪儿都响」的那一类(呼出一块面 / 做一件全局的事)。
 *
 * ── ↑ 那一下**不在这张表上**,这也是判据不是省事 ────────────────────────
 * §4.6 里 ↑ 与 ⌘[ 是同一条历史的两个入口,但它们属于**两层**:↑ 是行内结构键
 * (方向键的 DOM 焦点语义),它在这块面里先是「走行」、只在「输入框空着且停在
 * 第一行」那一形才轮到历史 —— 那是一句关于这套形态语法的话,而结构键**不进任何表**
 * (`keymap/types.ts` 顶部:可配置就等于不一致)。落点因此在面板自己的 onKeyDown 里。
 *
 * ⌘[ / ⌘] 与既有键位不撞:全壳的全局命令表里没有这两个组合,另一格局部键
 * (查看器 ⌘S/⌘L/⌘F、文件树 ⌘I/⌘↵、总览 ⌘⇧P)也没有 ——
 * 撞了会由 `scopedCollisionsOf` 在设置页说出来(撞车不是错误,但不许静默)。
 */
const SEARCH_KEYS: readonly ScopedKey[] = [
  {
    scope: 'search',
    combo: { meta: true, key: '[' },
    labelKey: 'search.historyBack',
    action: 'history.back',
  },
  {
    scope: 'search',
    combo: { meta: true, key: ']' },
    labelKey: 'search.historyForward',
    action: 'history.forward',
  },
]

/**
 * 文件树两条键面同一个动作(⌘I 与 ⌘↵ 都是「详情」)。**两行,不是一行两键**:
 * 表要能逐条说出「⌘↵ 被谁占着」,一行装两个组合就说不出口了。
 */
const FILES_KEYS: readonly ScopedKey[] = [
  { scope: 'files', combo: { meta: true, key: 'i' }, labelKey: 'files.detailAction', action: 'detail' },
  {
    scope: 'files',
    combo: { meta: true, key: 'enter' },
    labelKey: 'files.detailAction',
    action: 'detail',
  },
]

/**
 * 一片叶一条:⌘W = 关当前 tab(设计 §2.3 / 拍点 ④,09-04 用户已拍)。
 *
 * 它是**面域局部键**而不是全局命令:它需要一个目标(哪一片叶的哪一格),
 * 而「需不需要一个目标」正是三层立法的判据。全表零冲突 —— ⌘⇧W 是工作区命令面板,
 * shift 那一格就是两者的分界(`keymap-scopes.test` 的比对表钉着)。
 *
 * labelKey 复用 `common.close`,不新开一句(i18n 纪律:同一句话只该有一个键)。
 */
const LEAF_KEYS: readonly ScopedKey[] = [
  { scope: 'leaf', combo: { meta: true, key: 'w' }, labelKey: 'common.close', action: 'closeTab' },
]

export const FOCUS_SCOPES: Readonly<Record<FocusScopeId, FocusScopeSpec>> = {
  /* ── root:整台壳,只有一个 ──────────────────────────────────────────── */
  root: { id: 'root', kind: 'root', labelKey: 'a11y.appTitle' },

  /* ── region:内容面(§4.1 第三行)───────────────────────────────────── */
  viewer: { id: 'viewer', kind: 'region', labelKey: 'viewer.label', keys: VIEWER_KEYS },
  files: { id: 'files', kind: 'region', labelKey: 'item.files', keys: FILES_KEYS },
  composer: { id: 'composer', kind: 'region', labelKey: 'focus.scope.composer' },
  search: { id: 'search', kind: 'region', labelKey: 'item.search', keys: SEARCH_KEYS },
  expose: { id: 'expose', kind: 'region', labelKey: 'item.sessions', keys: EXPOSE_KEYS },
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
   *  · 局部键 = **键盘礼让表**。它是全表唯一一族「接住了什么都不做给应用、
   *    而是把这一下交给里面那台程序」的键 —— 判词与那五个字母是怎么选出来的,
   *    整段在 `content/terminal/key-courtesy.ts` 上(含它与方案原文的出入)。
   *    落点是 `TerminalLeaf` 注入的 `keyHandlers`。
   * labelKey 复用 Dock 瓦那一句(i18n 纪律:同一句话只该有一个键)。
   */
  terminal: {
    id: 'terminal',
    kind: 'region',
    labelKey: 'item.terminal',
    keys: TERMINAL_SCOPED_KEYS,
  },
  music: { id: 'music', kind: 'region', labelKey: 'item.music' },
  dock: { id: 'dock', kind: 'region', labelKey: 'dock.label' },
  /*
   * 拼贴树里的一片叶(W1)。行为档 `region` —— 它是一块能接键盘的面,不是一层
   * Placement 宿主:Tab 走得出去、Esc 不缺省认领(叶没有「关自己」这回事,
   * 关一格 tab 是 ⌘W 那条**显式**的键)。
   */
  /*
   * 叶是**家具**:进它就是进它装着的那块内容(`passThrough`,判词写在
   * `FocusScopeSpec.passThrough` 上)。它仍旧是 `region` —— 它有自己的局部键
   * (⌘W 关这一格),而那正是 `region` 与 `layer` 在快捷键三层里的分野。
   */
  leaf: {
    id: 'leaf',
    kind: 'region',
    labelKey: 'focus.scope.leaf',
    keys: LEAF_KEYS,
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

/** 全部局部键,拍平。设置页的撞键表与 `keymap/scopes.ts` 的派生都读它。 */
export const FOCUS_SCOPED_KEYS: readonly ScopedKey[] = FOCUS_SCOPE_LIST.flatMap(
  (spec) => spec.keys ?? [],
)

export function focusScopeKeysOf(scope: FocusScopeId): readonly ScopedKey[] {
  return FOCUS_SCOPES[scope].keys ?? []
}
