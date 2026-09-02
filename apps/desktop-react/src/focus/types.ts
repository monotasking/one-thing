import type { Combo } from '../keymap/types'
import type { MessageKey } from '../i18n'

/**
 * **响应链的形状**(R0,设计 `docs/design/react-shell-focus-2026-09.md` §4/§6)。
 *
 * 这只文件里只有类型,没有 React、没有 DOM 调用 —— 与 `keymap/types.ts`、
 * `stage/types.ts` 同一条纪律。
 *
 * ── 「kind」这个词在设计文档里担了两份工,这里拆成两个名字 ────────────────
 * 设计 §4.1 的表用 `kind` 指**行为档**(root / layer / region / float / modal ——
 * 决定 Tab 圈不圈禁、Esc 缺省答不答、进入落在哪);设计 §4.8 又说
 * 「FOCUS_SCOPES 按 kind 记标签与局部键表」,那里的 `kind` 指的是**声明 id**
 * (viewer / files / dialog…,21 格)。两件事合用一个词,写代码时第一处 `keys` 就
 * 会撞:`FOCUS_SCOPES['modal'].keys` 到底是「所有模态共用的键」还是「某一张
 * 对话框的键」?所以这里:
 *
 *  · `FocusScopeKind` = **行为档**,五格封闭,决定缺省行为;
 *  · `FocusScopeId`   = **声明 id**,21 格封闭,决定标签与局部键表;
 *  · `ScopeNode.instanceId` = **实例**,树上的一个节点(同一个 id 可以有好几份 ——
 *    两扇浮窗各一个查看器,架子 keep-alive 各一份)。
 *
 * 设计文档一个字没改;这里只是把它那一个词摊成三个,留账见交卷报。
 * ──────────────────────────────────────────────────────────────────────────
 */

/** 行为档(设计 §4.1 那张表的第一列)。 */
export type FocusScopeKind = 'root' | 'layer' | 'region' | 'float' | 'modal'

/**
 * 声明 id。首批 21 格 —— 加一格是**声明变更**,要同时改 `FOCUS_SCOPES` 那张表
 * 与它的 labelKey,`focus/__tests__/scopes.test.ts` 逐条钉着。
 */
export type FocusScopeId =
  // root:整台壳,只有一个
  | 'root'
  // region:内容面
  | 'viewer'
  | 'files'
  | 'composer'
  | 'search'
  | 'expose'
  | 'chat'
  | 'settings'
  | 'dock'
  // layer:Placement 宿主层
  | 'stage-layer'
  | 'float-layer'
  | 'shelf-layer'
  | 'cover-layer'
  // float:非模态临时面
  | 'jumpbar'
  | 'drawer'
  | 'zoom'
  | 'popover'
  | 'tooltip'
  // modal:Tab 出不去的
  | 'dialog'
  | 'menu'
  | 'palette'

/**
 * 一个**面域局部键**的声明。
 *
 * `action` 是这条键要触发的动作名 —— 它是声明与落点之间那根绳子:表里写
 * `{ scope:'viewer', action:'save' }`,实例注册时交出
 * `keyHandlers: { save: () => … }`。路由(`transitions.routeKey`)回的是这个名字,
 * 不是一个函数,所以路由本身仍然是纯的。
 *
 * 同一个 action 可以挂两个组合(文件树的 ⌘I 与 ⌘↵ 都是 `detail`),那是两行。
 */
export interface ScopedKey {
  scope: FocusScopeId
  combo: Combo
  /** 这个键干什么。设置页的撞键提示与键位速查读它。 */
  labelKey: MessageKey
  /** 实例注入的处理器名(`ScopeNode.keyHandlers` 的键)。 */
  action: string
}

/**
 * 一个节点**上一任第一响应者**的座位(§4.5 的 R1 审查裁定,R2 落地)。
 *
 * 「关掉什么,焦点回打开它的地方」(§3.5 规则 5)与「路径缩回父」(§4.2 来源 3)
 * 不是一回事:⌘P 开出来的检索面与它之前那块输入面板是**兄弟**,父链到不了。
 * 所以树在第一响应者**换人**的那一刻,给新任记下上一任是谁、焦点当时落在哪个
 * 元素上 —— 一格,不是一条链(§10「不做焦点历史」因此仍然成立)。
 */
export interface FocusReturnSeat {
  instanceId: FocusInstanceId
  element: HTMLElement
}

/** 一格**声明**。标签与局部键表按 id 记一次,树上有几份实例与它无关(§4.8)。 */
export interface FocusScopeSpec {
  id: FocusScopeId
  kind: FocusScopeKind
  /** 面域名是界面文案,所以只持有 key(同 StageItemSpec.titleKey 的判例)。 */
  labelKey: MessageKey
  keys?: readonly ScopedKey[]
}

/** 实例 id。树上每个 `<FocusScope>` 一个,由注册表发号。 */
export type FocusInstanceId = string

/**
 * 树上的一个**节点**。
 *
 * `parent` 是**逻辑父**(React 上下文的嵌套),不是 DOM 父 —— portal 到 body 的
 * 菜单在 DOM 上是对话框的兄弟,在这棵树上是它的孩子(§4.1)。这正是 `ui/float.ts`
 * 的 `topFloatLayer` 要用「DOM 包含 + 入栈序」两条判据去猜的那件事。
 *
 * `root` / `lastFocused` 是**元素引用**。纯函数只读传进来的这两格
 * (`.isConnected` / `.contains()`),从不查 `document` —— 「零 DOM」说的是
 * 不去问全局,不是不认识元素。
 */
export interface ScopeNode {
  instanceId: FocusInstanceId
  scope: FocusScopeId
  kind: FocusScopeKind
  parent: FocusInstanceId | null
  /**
   * 不可交互(宿主打了 `inert`,如架子 keep-alive 的后台层)。
   * 由注册表算好写在这儿,纯函数只读它 —— 判据(`closest('[inert]')`)是 DOM 的事。
   */
  inert: boolean
  /** 根元素。还没铺上 `scopeProps` 时是 null(挂载中的合法中间态)。 */
  root: HTMLElement | null
  /** 这个作用域**上一次**焦点落在哪个元素上。卸载后回哪儿读它(§4.5)。 */
  lastFocused: HTMLElement | null
  /** 进入这个作用域时焦点落在哪。答不出(null)就落在根上。 */
  restingTarget?: () => HTMLElement | null
  /** 这一层认不认 Esc。答 true = 这一下归我,别再往外传(§4.4)。 */
  onEscape?: () => boolean
  /** 局部键的落点。键是 `ScopedKey.action`。 */
  keyHandlers?: Readonly<Record<string, (() => void) | undefined>>
  /**
   * 这一格**替谁摆着**(R2)。宿主层填它装着的那块面的 id(`stage/items` 的 item id)。
   *
   * 它存在的唯一理由是 §3.5 规则 3:「把面拼到舞台 / 钉到边 / 撕成浮窗,焦点跟着
   * **那块面**走」—— 落定那一刻要激活的不是「某个 float-layer」,而是**装着这块面
   * 的那一扇**。同一种 layer 同时有好几份(四条边的架子 / 几扇浮窗),按 scope id
   * 选 MRU 会选错人,所以宿主把自己此刻的住户名报上来,`activateScope(scope,
   * { owner })` 据此精确取那一格。内容面不填(它们一种只有一份可交互的)。
   */
  owner?: string
  /**
   * 上一任第一响应者。**换人**那一刻由 `activate` / `focusin` 写(§4.5 R1 裁定),
   * 卸载 / 变 inert 时 `returnTargetOf` 第一个问它。
   *
   * 收回(I1)与 `pointerdown` 抢根这两种程序置焦**不算换人**,不写这一格 ——
   * 免得把「开检索面之前在输入框」记成「在壳根」。
   */
  returnTo?: FocusReturnSeat
  /**
   * 最近一次在活动路径上的**序号**(单调递增的 tick,不是时间戳)。
   * `activateScope` 的 MRU 读它:同一个 scope 有好几份可交互实例时,取最近用过的。
   * 从没上过路径的是 0。用 tick 不用 `Date.now()` 是因为同一帧里的两次切换必须分得开。
   */
  lastActiveAt: number
}

/** 不可变的树。键是实例 id。 */
export type FocusTreeNodes = ReadonlyMap<FocusInstanceId, ScopeNode>

/** 活动路径:**根在前、第一响应者在后**。 */
export type ActivePath = readonly FocusInstanceId[]

/**
 * 谁把焦点搬过来的。只进日志与 `__focus.dump()` —— 路由不看它,
 * 但「这一下是谁干的」是排障时最先要问的一句。
 */
export type ActivateReason =
  | 'open'
  | 'switch-tab'
  | 'placement'
  | 'restore'
  | 'pointer'
  | 'programmatic'

/** 一次按键的去向(`transitions.routeKey` 的返回值)。 */
export type KeyRoute =
  | { target: 'scope'; instanceId: FocusInstanceId; scope: FocusScopeId; action: string }
  | { target: 'root'; command: string }
  | null
