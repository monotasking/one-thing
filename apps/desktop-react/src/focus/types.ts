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
 * 声明 id。22 格(W1 加了 `leaf`)—— 加一格是**声明变更**,要同时改 `FOCUS_SCOPES`
 * 那张表与它的 labelKey,`focus/__tests__/scopes.test.ts` 逐条钉着。
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
  // 消息流。**同一个 id 会有好几份实例**(W5-b 会话多开):一片会话叶一份,
  // owner = 那一格的 refId —— 与 `leaf` 那一格同一个样板(见下)。
  | 'chat'
  // 一张权限卡(应用级许可 · 壳半边)。**同一个 id 会有好几份实例** —— 一次调用
  // 一张卡,owner = 那次调用的 toolCallId;声明这一头与实例份数无关(§4.8)。
  | 'permission'
  | 'settings'
  // 音乐面(音乐收尾 · 壳半边)。一块普通的内容面:它有自己的落点(播放 / 暂停
  // 那颗钮),没有局部键,不认 Esc。
  | 'music'
  // 一格终端(T1)。一格 PTY 一份实例;它是全表**唯一**带着「把这个键交给
  // 里面那台程序」这一族局部键的作用域(判词在 `content/terminal/key-courtesy.ts`)。
  | 'terminal'
  | 'browser'
  | 'dock'
  // 拼贴树里的一片叶(W1)。同一个 id 会有**好几份实例**:叶根一份(owner = 叶 id,
  // 它拿 ⌘W、也是跟焦的落点),每一格 tab 的内容层各一份(owner = refId,
  // 只为「看不见的那一格从活动路径上摘掉」而存在)。
  | 'leaf'
  // layer:三个 Placement 宿主层 + 全屏那一层(W2:`full-layer` 顶掉 `cover-layer`;
  // 全屏不是一种 Placement,但它与那三个一样是「装着一块面的一层」)。
  | 'stage-layer'
  | 'float-layer'
  | 'shelf-layer'
  | 'full-layer'
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
  /**
   * **这一格是家具,不是面**(W4)。进入它 = 进入它装着的那块内容,
   * 所以 `entryOf` 穿过它继续往里走(与 `kind: 'layer'` 那一档逐字同一条规矩:
   * 设计 §4.1 那张表 `layer` 行的「进入落点 = 第一个可交互子作用域,否则根」)。
   *
   * ── 为什么是**表上一格**而不是 `entryOf` 里一句判据 ──────────────────────
   * 把条件放宽成「凡自己说不出落点的就往里走」会一起放过两类不该穿的:
   * 内容面自己开出来的浮层(菜单在树上是它的孩子)、以及那些「停在这块面上」
   * 本就是对的区域。所以它是**自述**:哪一格是家具由那一格自己在表上说,
   * 内核只读表(与 `workbench/kinds` 那张内容表同一条法)。
   *
   * 今天只有 `leaf` 一格:一片叶是拼贴台的家具 —— W4 之前架子与浮窗的层下面
   * 直接就是那块面,W4 起中间隔了「叶根 + 那一格 tab 的层」两级,不穿过去的话
   * 键盘会落在 tab 条旁边那片空白上(真机门 `gate:focus` 场景 15 ③ 照出来的)。
   */
  passThrough?: boolean
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
   * 这一格**替谁摆着**(R2)。宿主层填它装着的那块面的 id(`stage/items` 的 item id);
   * 内容面这一族填**它自己那一格的 refId**(W5-b:`chat` 的每一片会话叶各一份)。
   *
   * 它存在的唯一理由是 §3.5 规则 3:「把面拼到舞台 / 钉到边 / 撕成浮窗,焦点跟着
   * **那块面**走」—— 落定那一刻要激活的不是「某个 float-layer」,而是**装着这块面
   * 的那一扇**。同一种 layer 同时有好几份(四条边的架子 / 几扇浮窗),按 scope id
   * 选 MRU 会选错人,所以宿主把自己此刻的住户名报上来,`activateScope(scope,
   * { owner })` 据此精确取那一格。
   *
   * **内容面从前不填**(「它们一种只有一份可交互的」)—— 会话多开之后这句话对
   * `chat` 不成立了:两片会话叶各有一份消息流,而「启动时焦点该进哪一片」
   * 只有 owner 说得清。所以 `ChatStream` 也报住户名,判据与宿主层逐字同源。
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
