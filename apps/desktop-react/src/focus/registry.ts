import { FOCUS_SCOPES } from './scopes'
import { focusElement } from './target'
import {
  activePathOf,
  isInteractive,
  isReachablyInteractive,
  nearestInteractiveAncestorOf,
  restingElementOf,
  returnTargetOf,
  scopeAtElement,
  shrinkPath,
} from './transitions'
import type { CommandId } from '../keymap/types'
import type {
  ActivePath,
  ActivateReason,
  FocusInstanceId,
  FocusScopeId,
  FocusTreeNodes,
  ScopeNode,
} from './types'

/**
 * **`FocusTree` —— 响应链上唯一有状态的东西**(R0,设计 §6)。
 *
 * 它持有三样:那张 `Map<instanceId, ScopeNode>`、当前的第一响应者、以及
 * 两个 document 监听(`focusin` / `pointerdown`)。别的一切都是
 * `transitions.ts` 里的纯函数算出来的。
 *
 * ══ 三张状态表(施工纪律「状态先行」)═══════════════════════════════════
 *
 * ① **生命周期**(这个对象与它每个节点的一生)
 *
 * | 事件 | 树 | 节点 | 谁触发 |
 * | --- | --- | --- | --- |
 * | 首次 `register` | 装上两个 document 监听 | 入表(root 可能还没到,合法) | `<FocusScope>` 的 layout effect |
 * | 铺上 `scopeProps` | — | `root` 从 null 变成真元素 | 同一次提交的 ref 回调 |
 * | 换宿主(面从架子撕成浮窗) | 路径重算 | **同一个实例**换 `parent` + 换 `root` | 宿主 re-parent 后 `update()` |
 * | 宿主打 `inert`(架子切 tab) | 路径缩到最近可交互祖先 | `inert:true`,不再当第一响应者 | 宿主 `update({inert})` |
 * | `unregister` | 出表 → 路径缩 → 焦点按 `returnTargetOf` 回落 | 消失 | 卸载时的 effect 清理 |
 * | 表空 / HMR dispose | `reset()` 拆监听、清表、清独占口 | 全消失 | `reset()`(唯一那口拆卸) |
 *
 * **换宿主 = 一次生命周期事件**,不是一次重挂:实例 id 不变,所以
 * `lastFocused` 活过这次搬家 —— 「把面拼到舞台 / 钉到边 / 撕成浮窗,焦点跟着
 * 那块面走」(§3.5 规则 3)靠的就是这一格。
 *
 * ② **树的生命状态**(读的人问「这棵树此刻答得出话吗」)
 *
 * | 状态 | 判据 | 答案 |
 * | --- | --- | --- |
 * | empty | 一格节点都没有(壳还没挂载) | `current()` = null,路由一律回 root 命令或 null |
 * | ready | 有根、第一响应者在路径上 | 正常路由 |
 * | detached | 第一响应者已卸载 / 变 inert | 路径当场缩(`shrinkPath`),缩到哪儿哪儿接手 |
 * | orphan | DOM 焦点掉出所有作用域(掉到 body) | **路径不变**;`policy.moveFocus` 开着时同帧送回落点(I1) |
 * | captured | 录制态申请了独占 | 所有按键先给独占口,树一格都不问(§5 唯一例外) |
 *
 * 没有 loading / error 两格:这棵树不取数,也没有会失败的操作 —— 登记一个
 * 父还没到的孩子是**合法中间态**而不是错误(见 `activePathOf` 的注释)。
 * **超量**:同一个 id 几十份实例(架子 keep-alive + 两扇浮窗)是设计内的
 * (§4.8),表按实例 id 索引,查询全是 O(节点数) 的一遍走 —— 路径长度是树深,
 * 不是节点数。
 *
 * ③ **节点的交互状态**(一个作用域此刻处在哪一格)
 *
 * | 状态 | 判据 | 可感知的样子 |
 * | --- | --- | --- |
 * | rest | 不在活动路径上 | 它的局部键不响,Esc 不问它 |
 * | active | 在活动路径上但不是最深 | 局部键仍然响(由深到浅问到它) |
 * | first-responder | 路径最深那一格 | 键先问它;Esc 先问它 |
 * | inert | 宿主打了 `inert` | 一律不响,路径经过它就在那儿截断 |
 * | pending | 已登记但 `root` 还是 null | 不当第一响应者(`scopeAtElement` 选不到它) |
 *
 * 没有 hover / disabled 两格:作用域不是控件,鼠标经过它不改变任何状态
 * (「hover ≠ active」那条法在这里的读法是**根本没有 hover 这一格**);
 * 「不许用」由 `inert` 一格表达,不需要第二个词。
 * ══════════════════════════════════════════════════════════════════════
 *
 * ── 闸:`policy.moveFocus`(R0 关着,**R1 起缺省打开**)────────────────────
 * R0 只观察不搬焦点:两个监听照装,内部路径与 `lastFocused` 照更新,但「孤儿
 * 焦点收回」(I1)与「点空白处进作用域」(§4.6)两件**会动 DOM 焦点**的事被它
 * 关着。R1 把它翻成 `true`,同一刻 `<FocusScope>` 才开始铺 `tabIndex={-1}` ——
 * 那个属性存在的唯一理由就是「焦点能被送到根上」,一个开关管一件事。
 * 它留着是因为**关掉即回到只观察**:测试要验「不搬焦点时一个 `focus()` 都不发」
 * 靠它,真机上万一发现某条搬焦点的路有害也靠它一句话退回去。
 *
 * ── I1 的收回有**三处**,少一处都不成立(R0 审查补的那一格,设计 §4.1)────
 *  ① `settle()` —— 卸载 / 变 inert 这条结构路(R0 已写);
 *  ② `focusout` 且 `relatedTarget === null` —— 焦点从一个元素上掉下来、又没有
 *     落到下一个元素上。**掉到 body 本身不发 `focusin`**,所以光靠 `focusin`
 *     那一路收不回来;
 *  ③ 唯一派发器每次 keydown 开头 —— 被聚焦的元素**被静默移除**时 Chrome 连
 *     `focusout` 都不发,这一条兜住剩下的一切:下一次按键之前先把焦点接回来,
 *     于是「按键没反应」在时间上不可能发生。
 * 三处走的是同一只 `recoverOrphanFocus()`(不写第二套):落点 =
 * `restingElementOf(current())`,第一响应者答不出(树刚起来 / 它没铺根)就落 root 根。
 *
 * ── 瞬态口 `registerTransient`(R1 补,给 Tooltip 那一族)──────────────────
 * 有一种面**不占焦点、也没有一个包着触发元素的根**:Tooltip 把提示体 portal 出去,
 * 而锚点是消费方自己那颗按钮 —— 把作用域根铺在锚点上会让「焦点在那颗按钮上」
 * 等于「tooltip 是第一响应者」,那是假的。它又确实要在 Esc 时消失(WCAG 1.4.13)。
 * 所以给它一张**瞬态表**:登记一个 `onEscape`,派发器在问活动路径**之前**先问
 * 这张表。它仍然住在 `src/focus/` 里、仍然只有那一个派发器,没有第二个 window 监听。
 * 答 true = 这一下我吃了(tooltip 答 **false**:APG 说它的 Esc 不该拦别人)。
 *
 * ── R2 补的三格 ──────────────────────────────────────────────────────────
 *  · **`returnTo`**(§4.5 的 R1 审查裁定):第一响应者**换人**那一刻,给新任记下
 *    上一任是谁 + 焦点当时落在它的哪个元素上。⌘P 开出来的检索面与它之前那块
 *    输入面板是**兄弟**,父链到不了 —— 这一格就是「关掉什么,焦点回打开它的
 *    地方」的结构答案。收回(I1)与 `pointerdown` 抢根**不算换人**
 *    (`noReturnDepth`),否则记下的会是「壳根」而不是那个输入框。
 *  · **`activateScope(scope, { owner })`**:调用方说得出「要哪一种面」却说不出
 *    「哪一份实例」。挑法 = 可交互 ∧ 已铺根 ∧(给了 owner 就对上)→ MRU。
 *  · **`owner`**:宿主层报出它此刻装着哪块面。同一种 layer 有好几份时(四条边的
 *    架子 / 几扇浮窗),「装着这块面的那一扇」不是 MRU 猜得出来的。
 */

/** 注册时可以交代的东西。全是可选 —— 一个什么都不声明的作用域也是合法的。 */
export interface FocusScopeRegisterOptions {
  /** 宿主此刻可不可交互(架子后台 tab 传 false)。缺省 true。 */
  inert?: boolean
  /** 进入这个作用域时焦点落在哪。答不出就落根上。 */
  restingTarget?: () => HTMLElement | null
  /**
   * 这一层认不认 Esc。答 true = 这一下归我(§4.4)。
   * **没声明**(`undefined` / `null`)与「声明了但答 false」是两件事:前者
   * 根本不进 Esc 候选表,后者进表但把这一下让出去。
   */
  onEscape?: (() => boolean) | null
  /** 「我此刻能做哪些命令」的落点,键是命令 id(K0)。 */
  commands?: Readonly<Partial<Record<CommandId, (() => void) | undefined>>>
  /** 这一格此刻认领它声明的那几个键吗(见 `FocusScopeSpec.claims`)。缺省认领。 */
  claiming?: boolean
  /** 这一格替谁摆着(宿主层填住户的 item id,见 `ScopeNode.owner`)。 */
  owner?: string
}

/** 登记之后拿到的句柄。它是**唯一**能改这一格的口子。 */
export interface FocusScopeHandle {
  readonly instanceId: FocusInstanceId
  readonly scope: FocusScopeId
  /** 把根元素交出来(`scopeProps.ref` 的落点)。传 null = 摘掉。 */
  setRoot(el: HTMLElement | null): void
  /** 改可交互性 / 落点 / Esc / 键落点。只改传进来的那几格。 */
  update(patch: FocusScopeRegisterOptions): void
  /** 把焦点送进这个作用域(§4.2 来源 2)。 */
  activate(reason?: ActivateReason): void
  unregister(): void
}

/** 独占口的处理器(录制态)。答 true = 这一下我吃了。 */
export type FocusCaptureHandler = (e: KeyboardEvent) => boolean

/** 瞬态口的处理器(Tooltip 那一族)。答 true = 这一下我认领了。 */
export type FocusTransientEscapeHandler = () => boolean

type Listener = () => void

/**
 * 一格「摘掉了、还没结算完」的账(S4)。判词写在 `FocusTree.pendingUnregister` 头上。
 *
 * 三格各有各的用处,缺一格就答不出话:
 *  · `node` —— 那个节点对象**原样**。复活时整只放回表里,于是 `root` / `lastFocused` /
 *    `returnTo` / `lastActiveAt` 全都活过这一次重挂;
 *  · `departing` —— 摘掉那一刻**离场的那一任**(`focusedNode`)。归还要从它问起,而
 *    路径一缩它就问不到了,所以必须在缩之前存下来;
 *  · `focusedBefore` —— 摘掉那一刻的第一响应者,**只在这一摘真的把路径缩了时才记**。
 *    复活时把它还回去(焦点从头到尾没搬过,路径也该回原样);`null` = 这一格根本不在
 *    活动路径上,摘不摘都不影响谁在接键盘,复活时无事可做、真走了也不必归还;
 *  · `shrunkTo` —— 同步那一步**缩到了哪一格**。微任务醒来时第一响应者还是它,归还才
 *    轮得到;不是了 = 这一拍里**别人接管了键盘**,归还这个问题当场作废。
 *    这一格不是保险丝,是判据:文件树右键菜单里点「详情」走的正是这一形 —— 菜单卸载
 *    (排下归还)与详情面挂载(`activateOnMount` 入焦)在同一拍里,少了这一格,归还
 *    醒来会把键盘从刚开出来的详情面里抢回树行上,随后那一下 Esc 就关不掉详情了
 *    (施工时 `files-panel.test` 的两条当场红,读数即此)。
 */
interface PendingUnregister {
  node: ScopeNode
  departing: ScopeNode
  focusedBefore: FocusInstanceId | null
  shrunkTo: FocusInstanceId | null
}

let seq = 0

export class FocusTree {
  /**
   * 会不会真的搬 DOM 焦点。R0 = false(只观察);**R1 起缺省 true**。
   * 见文件头那一段 —— 它同时管着 `scopeProps` 铺不铺 `tabIndex`。
   */
  policy = { moveFocus: true }

  private readonly map = new Map<FocusInstanceId, ScopeNode>()
  private readonly listeners = new Set<Listener>()
  /**
   * 瞬态 Esc 口。**有序集合**:后登记的后问,与浮层的「后开的在上面」同向。
   * 存的是处理器本身,解除函数按身份删 —— 同一个组件重挂拿到的是新闭包,
   * 按身份删才不会误伤别人那一格(与 `popFloatLayer` 当年那条判例同型)。
   */
  private readonly transients = new Set<FocusTransientEscapeHandler>()
  private focused: FocusInstanceId | null = null
  private captured: FocusCaptureHandler | null = null
  private attached = false

  /* ── 登记 ────────────────────────────────────────────────────────────── */

  /**
   * 登记一格。`parent` 是**逻辑父的实例 id**(从 React 上下文里拿),
   * 父此刻在不在表上都行 —— 同一次提交里父子一起挂载时,子的 effect 先跑。
   */
  register(
    scope: FocusScopeId,
    parent: FocusInstanceId | null,
    opts: FocusScopeRegisterOptions = {},
    /**
     * 实例 id。`<FocusScope>` 传自己的 `useId()` —— 这样 StrictMode 的
     * 挂载→卸载→再挂载拿到的是**同一个 id**,渲染里交出去的 id 不会作废。
     * 不传就现发一个(命令式调用与单测走这条)。
     */
    explicitId?: FocusInstanceId,
  ): FocusScopeHandle {
    seq += 1
    const instanceId = explicitId ?? `${scope}#${seq}`
    /*
     * **同一格实例刚被摘掉、这一发又把它登记回来 = 它没走**(S4;判词写在
     * `pendingUnregister` 头上)。原样复用那个节点对象 —— `root` / `lastFocused` /
     * `returnTo` / `lastActiveAt` 全留着,于是「关掉什么焦点回打开它的地方」
     * (§3.5 规则 5)与 MRU 都活过这一次重挂;声明那几格按新的这一发覆写
     * (重挂之后 `restingTarget` / `commands` 都是新闭包)。
     */
    const revived = this.pendingUnregister.get(instanceId)
    const node: ScopeNode = revived?.node ?? {
      instanceId,
      scope,
      kind: FOCUS_SCOPES[scope].kind,
      parent,
      inert: opts.inert ?? false,
      root: null,
      lastFocused: null,
      restingTarget: opts.restingTarget,
      onEscape: opts.onEscape ?? undefined,
      commands: opts.commands,
      claiming: opts.claiming,
      owner: opts.owner,
      lastActiveAt: 0,
    }
    if (revived) {
      this.pendingUnregister.delete(instanceId)
      node.parent = parent
      node.inert = opts.inert ?? false
      node.restingTarget = opts.restingTarget
      node.onEscape = opts.onEscape ?? undefined
      node.commands = opts.commands
      node.claiming = opts.claiming
      node.owner = opts.owner
    }
    this.map.set(instanceId, node)
    /*
     * 路径还回去。**直接写这两格,不走 `setFocused`** —— 后者是「换人」那一口
     * (要写 `returnTo`、要盖 MRU 戳),而这里根本没换过人:焦点从头到尾没搬过,
     * 这一句只是把摘掉那一刻同步缩掉的那一段接回来。
     */
    if (revived?.focusedBefore) {
      this.focused = revived.focusedBefore
      this.focusedNode = this.map.get(revived.focusedBefore) ?? this.focusedNode
    }
    this.attach()
    this.notify()
    return {
      instanceId,
      scope,
      setRoot: (el) => {
        const at = this.map.get(instanceId)
        if (!at || at.root === el) return
        at.root = el
        this.notify()
      },
      /*
       * 判「传没传这一格」用 `in` 而不是 `!== undefined`:`onEscape: undefined`
       * 的意思是**摘掉它**(那一层不再认 Esc),与「这次不改这一格」必须分得开 ——
       * 分不开的话一个条件渲染的 Esc 声明就永远摘不掉,那一层会一直吃 Esc。
       */
      update: (patch) => {
        const at = this.map.get(instanceId)
        if (!at) return
        if ('inert' in patch && patch.inert !== undefined) at.inert = patch.inert
        if ('restingTarget' in patch) at.restingTarget = patch.restingTarget
        if ('onEscape' in patch) at.onEscape = patch.onEscape ?? undefined
        if ('commands' in patch) at.commands = patch.commands
        if ('claiming' in patch) at.claiming = patch.claiming
        if ('owner' in patch) at.owner = patch.owner
        // 变得不可交互 = 结构变化(§4.2 来源 3),与卸载同一条路。
        if (patch.inert) this.settle(at)
        else this.notify()
      },
      activate: (reason: ActivateReason = 'programmatic') => this.activate(instanceId, reason),
      unregister: () => this.unregister(instanceId),
    }
  }

  /**
   * **刚摘掉、还没结算的那些格**(S4,09-04)。键是实例 id,值是那个节点对象原样。
   *
   * ── 为什么归还要晚一个微任务 ────────────────────────────────────────────────
   * 「摘掉一格」与「这一层真的走了」是两件事,而树从前把它们当成一件:`unregister`
   * 当场 `settle()`,焦点按 `returnTargetOf` 回落。**一次重挂**(同一个实例 id 先注销
   * 再登记)于是被读成了「它走了」——归还把键盘送回按键之前的输入框,而随后挂回来的
   * 那一份没有人再叫它。这不是开发期才有的假象:React StrictMode 的模拟卸载→再挂载、
   * 错误边界重试、换宿主、热更,发出的是**同一串**树操作。
   *
   * 真机时间线(09-04,离屏 StrictMode 实例,files 记忆钉左架子、那条架子上另有一个
   * tab,按召唤键之后 1s 内的全部树操作;判据就是从这份读数上读出来的):
   * ```
   * +30.8ms activateScope(shelf-layer) → activate → 焦点进 files-panel   ✔ 送成功
   * +31.4ms unregister shelf-layer@_r_s_   ← **隔壁那一格 tab** 的模拟卸载先到
   * +31.5ms unregister expose@_r_t_
   * +31.5ms unregister shelf-layer@_r_10_  ← 装着 files 的那一层 → settle → 焦点回 composer-input
   * +31.8ms unregister files@_r_11_
   * +31.9ms register ×4(同一批实例 id 原样回来)
   * ```
   * 用户数的三下正是这个:出现(焦点没进)/ 没反应(第二下补一次聚焦,那些层不画环
   * 所以无声)/ 隐藏。
   *
   * 所以判据改成:**摘掉 → 排一个微任务 → 那时同一个实例 id 还没回来,才算它真的走了**。
   * React 的一次重挂(卸载 effect 与再挂载 effect)全部落在同一个宏任务里,微任务
   * 一定排在它后面 —— 这不是一个时间窗口(没有毫秒数可调),是一个**次序**。
   *
   * ── 延后的**只有焦点搬家**,路径当场就缩 ────────────────────────────────────
   * 结算本来是两件事:①路径缩到最近仍可交互的祖先;②焦点按 `returnTargetOf` 回落。
   * 只有②会把键盘从刚开出来的那块面里拽走,所以只延后②。①必须当场做 —— 这棵树
   * 对读的人许过「`activePath()` 拿到的永远是可交互的那一段」,而节点已经出表了,
   * 不缩的话 `current()` 在那个微任务里答 undefined。施工时用**同步连按两下 Esc**
   * 那条既有用例证过:全部延后的话第二下 Esc 找不到对话框(两下之间没有微任务)。
   *
   * 于是这一格记的是「摘掉那一刻的第一响应者」:复活时把它还回去(焦点根本没搬过,
   * 所以路径也该回到原样),真走了就在微任务里让焦点回落。
   *
   * ── 与 I1 收回的次序,不会打架 ──────────────────────────────────────────────
   * 真卸载时:React 先跑卸载 effect(这里排下微任务)、**再**把 DOM 摘掉;摘掉那一刻
   * 焦点掉到 body,`focusout` 那一路也排一个微任务去 `recoverOrphanFocus`。两者都在
   * 微任务队列上,而**这一个先排**,所以归还先跑、`activeElement` 已经不是 body,
   * 随后那一发收回自己判掉(它只在「此刻真的在 body 上」时动手)。没有「先收回到
   * root 落点、归还再搬一次」的双跳 —— `registry.test.ts` 里有一条用例钉着次序。
   */
  private readonly pendingUnregister = new Map<FocusInstanceId, PendingUnregister>()

  /**
   * 摘掉一格。**路径当场缩,焦点回落晚一个微任务**(判词见 `pendingUnregister`):
   * 同一个实例 id 要是在那之前又登记回来,这一次就根本不是「走了」——归还一句都不发,
   * 第一响应者也还回原位。
   *
   * 真的走了的话,焦点按 `returnTargetOf` 回落,这就是「归还是结构性的」(§4.5):
   * 写跳转条的人不需要知道有归还这回事。
   */
  unregister(instanceId: FocusInstanceId): void {
    const node = this.map.get(instanceId)
    if (!node) return
    // 「焦点原来在谁身上」要在缩之前问 —— 缩完再问拿到的是缩到的那个祖先。
    const departing = this.focusedNode ?? node
    const focusedBefore = this.focused
    this.map.delete(instanceId)
    const wasFirstResponder = this.shrinkPathAfter(node)
    this.pendingUnregister.set(instanceId, {
      node,
      departing,
      // 没缩过就没什么可还的(它不在活动路径上,摘不摘都不影响谁在接键盘)。
      focusedBefore: wasFirstResponder ? focusedBefore : null,
      shrunkTo: this.focused,
    })
    this.notify()
    queueMicrotask(() => {
      const pending = this.pendingUnregister.get(instanceId)
      // 被 `register` 领回去了 = 那是一次重挂,不是一次卸载。什么都不做。
      if (!pending) return
      this.pendingUnregister.delete(instanceId)
      if (!pending.focusedBefore) return
      // 这一拍里别人接管了键盘(新开的那一层自己入了焦)→ 归还作废,不去抢。
      if (this.focused !== pending.shrunkTo) return
      this.returnFocusAfter(pending.node, pending.departing)
      this.notify()
    })
  }

  /* ── 查询 ────────────────────────────────────────────────────────────── */

  /** 不可变视图。给 `transitions.*` 与 `__focus.dump()` 用。 */
  nodes(): FocusTreeNodes {
    return this.map
  }

  /** 第一响应者(活动路径最深那一格)。 */
  current(): ScopeNode | undefined {
    const path = this.activePath()
    const last = path[path.length - 1]
    return last ? this.map.get(last) : undefined
  }

  /** 活动路径,根在前。已经缩过 —— 读的人拿到的永远是可交互的那一段。 */
  activePath(): ActivePath {
    return shrinkPath(this.map, activePathOf(this.map, this.focused))
  }

  /** 有没有人申请了独占。`dispatch` 问它。 */
  capturedHandler(): FocusCaptureHandler | null {
    return this.captured
  }

  /** 此刻挂着的瞬态 Esc 口,按登记序。`dispatch` 在问路径之前问它。 */
  transientEscapeHandlers(): readonly FocusTransientEscapeHandler[] {
    return [...this.transients]
  }

  /**
   * 树上的那一格 root。收回焦点时的最后落点 —— 第一响应者答不出话
   * (树刚起来、或它此刻没铺根元素)时焦点回这儿,而不是留在 body 上。
   */
  private rootNode(): ScopeNode | undefined {
    for (const node of this.map.values()) {
      if (node.kind === 'root' && !node.inert) return node
    }
    return undefined
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /* ── 写 ──────────────────────────────────────────────────────────────── */

  /**
   * 宿主激活一格(§4.2 来源 2):打开一块面、切 tab、程序置顶浮窗。
   *
   * 它做两件事:把第一响应者指过去,并**把焦点送到那一格的落点** —— 后者由
   * `policy.moveFocus` 闸着(R1 起缺省开)。指针操作不该调它:点击本身就落焦。
   */
  activate(instanceId: FocusInstanceId, reason: ActivateReason = 'programmatic'): void {
    const node = this.map.get(instanceId)
    if (!isInteractive(node)) return
    /*
     * **已经在我里面了就不往回拽**(R1 补)。`activate` 的意思是「让这一格成为
     * 当前」,而第一响应者要是我的**后代**,这句话早就成立了 —— 路径上有我。
     *
     * 不判这一条会踩 React 的 effect 次序:**子先于父**跑,所以同一次提交里一起
     * 挂载的父子两层(对话框里一开始就带着一张菜单),菜单先登记先入焦,随后
     * 父那一句 `activate` 把第一响应者拽回自己身上,层序整个倒过来。
     * 这正是 `ui/float.ts` 的浮层栈当年要用判据①(DOM 包含)去兜的那一形 ——
     * 树里它是一句结构判断,不必猜。
     */
    if (this.focused && this.focused !== instanceId) {
      const current = this.map.get(this.focused)
      if (isInteractive(current) && this.isDescendantOf(this.focused, instanceId)) {
        this.lastReason = reason
        return
      }
    }
    const entry = this.entryOf(node)
    this.setFocused(entry.instanceId, true)
    this.lastReason = reason
    if (this.policy.moveFocus) {
      const el = restingElementOf(entry)
      /*
       * 送焦点的这一下会同步发一个 `focusin`,而那一路会再跑一次 `setFocused` ——
       * 那时第一响应者已经是 `instanceId` 了(上面刚写),所以「换人」不成立,
       * `returnTo` 不会被自己覆盖一遍。次序在这里是判据,不是巧合。
       */
      focusElement(el)
    }
    this.notify()
  }

  /**
   * **按声明 id 激活一格**(R2,设计 §3.5 规则 2/3 与 §11 拍点 2/3 的落点)。
   *
   * 调用方多半说得出「要哪一种面」却说不出「哪一份实例」:文件树 ↵ 开文件时
   * 查看器可能在舞台 / 浮窗 / 架子任一宿主里,壳启动时输入面板还没登记完。
   * 所以这一口收的是**声明 id**,实例由树自己挑:
   *  · 只在**可交互且已经铺上根**的那几份里挑(inert 的架子后台层、还没到位的
   *    半挂载实例都不算);
   *  · `owner` 给了就再筛一道 —— 同一种 layer 同时有好几份时(四条边的架子 /
   *    几扇浮窗),「装着这块面的那一扇」不是 MRU 能猜出来的(§3.5 规则 3);
   *  · 剩下不止一份时取 **MRU**(`lastActiveAt` 最大 = 最近一次在活动路径上的
   *    那一份),都没用过就取登记序第一个 —— 「最近用过的那一份」是用户心里
   *    那块面,而登记序是 React 的实现细节,只配当兜底。
   *
   * 回 false = 这一种面此刻一份可交互的实例都没有。调用方据此决定要不要退而求
   * 其次(壳启动那条链就是这么串起来的),**不抛** —— 「这块面还没开出来」
   * 是常态,不是错误。
   */
  activateScope(
    scope: FocusScopeId,
    opts: { owner?: string; reason?: ActivateReason } = {},
  ): boolean {
    let best: ScopeNode | null = null
    for (const node of this.map.values()) {
      // 连祖先链一起判(2026-09-12):收起来的架子里那片叶自己的旗是干净的,但它不可达。
      if (node.scope !== scope || !isReachablyInteractive(this.map, node) || !node.root) continue
      if (opts.owner !== undefined && node.owner !== opts.owner) continue
      if (!best || node.lastActiveAt > best.lastActiveAt) best = node
    }
    if (!best) return false
    this.activate(best.instanceId, opts.reason ?? 'programmatic')
    return true
  }

  /**
   * **活动路径上有没有一格替 `owner` 摆着**(S1 召唤三态判「焦点在不在它里面」)。
   *
   * 问的是 `ScopeNode.owner`(宿主层报的住户 = `stage/items` 的 item id),不是
   * scope id：同一种 layer 同时有好几份,而「焦点在文件树那块面里」问的正是
   * **哪一块面**。路径已经缩过,所以 inert 的架子后台层不会答 true。
   */
  isOwnerActive(owner: string): boolean {
    return this.activePath().some((id) => this.map.get(id)?.owner === owner)
  }

  /**
   * **录制态独占**(§5 唯一例外)。键位设置在录键时要吃**所有**键(含全局命令),
   * 而那个集合不可枚举,所以它不是一张 keys 表能表达的东西 —— 它向注册表申请
   * 一个独占口。返回解除函数;第二次申请会顶掉第一次(录制态只可能有一处)。
   */
  capture(handler: FocusCaptureHandler): () => void {
    this.captured = handler
    this.notify()
    return () => {
      if (this.captured === handler) {
        this.captured = null
        this.notify()
      }
    }
  }

  /**
   * **瞬态 Esc 口**(见文件头)。给「不占焦点、也没有自己的根」的那一族用 ——
   * 今天只有 Tooltip 一个消费者。返回解除函数,幂等。
   *
   * 它与作用域的差别只有一条:作用域答「这一下键归谁」要先证明自己在活动路径上,
   * 而瞬态口没有位置可言(提示体 portal 出去了,锚点是别人的按钮),所以它按
   * **登记序**被问,并且被问在路径之前。能这么放心是因为它只被允许**不认领**地
   * 消费(答 false),真要认领也只能是它自己那一层。
   */
  registerTransient(handler: FocusTransientEscapeHandler): () => void {
    this.transients.add(handler)
    return () => {
      this.transients.delete(handler)
    }
  }

  /**
   * **孤儿焦点收回**(I1)。三处收回共用的那一只 —— 文件头列了是哪三处。
   *
   * 判据只有一条:`document.activeElement` 是 body(或 null)。**路径不变**:
   * 第一响应者不会因为一个 DOM 节点消失而消失(§4.2),所以这里只搬焦点、
   * 一个字都不改树。落点答不出来就什么都不做 —— 往一个不连通的元素上 focus
   * 只会再掉一次 body。
   */
  recoverOrphanFocus(): void {
    if (!this.policy.moveFocus || typeof document === 'undefined') return
    const active = document.activeElement
    if (active && active !== document.body) return
    const target = restingElementOf(this.current()) ?? restingElementOf(this.rootNode())
    // 收回**不算换人**(§4.5 裁定点名排除):不写 `returnTo`,否则「开检索面之前
    // 我在输入框」会被记成「我在壳根」。
    if (target) this.withoutReturnSeat(() => focusElement(target))
  }

  /* ── 内部 ────────────────────────────────────────────────────────────── */

  /** 最近一次 activate 的理由。只进 `__focus.dump()`,路由不看。 */
  private lastReason: ActivateReason | null = null

  /** MRU 的单调计数。用序号不用时间戳:同一帧里的两次切换必须分得开。 */
  private tick = 0

  /**
   * **激活一格 layer,焦点其实该落进它装着的那块面**(设计 §4.1 那张表的
   * `layer` 行:「进入落点 = 第一个可交互子作用域,否则根」)。
   *
   * 少了这一格,「切 tab / 开面 / 挪位置之后键盘立刻可用」只兑现一半:焦点停在
   * 层的根上,而那块面(查看器 / 文件树 / 检索)不在活动路径上 —— 于是紧接着按
   * ⌘F 一样落空,正是这条链要治的那个病换了个地方犯。
   *
   * 三条判据:
   *  · 只对 `layer` 生效 —— region / float / modal 的落点是它们自己声明的事;
   *  · 层**自己此刻真答得出落点**就听它的(那是宿主的显式意见,比这条缺省规矩优先);
   *  · 孩子按**登记序**取第一个可交互且已经铺了根的(登记序 = 挂载序 = 屏幕上
   *    从上到下的次序);孩子还是层就再往里走一层(架子层里套内容层的形)。
   *
   * ── 第二条判的是**答案**,不是**闭包在不在**(09-04 S1 修的 R2 偏离)────────
   * 从前这里写的是 `!at.restingTarget`,而 `FocusScope` 给**每一格**都无条件登记
   * 一个 `restingTarget` 闭包(prop 缺席时它答 null,理由是那三个声明走 ref 不进
   * 依赖表)—— 于是这一格对所有真组件恒为真,整条「进层先进它装着的那块面」的
   * 规矩是死码:焦点一律停在层的根上(`<section>` / `<div>`)。设计 §4.1 那张表里
   * `layer` 行写的是「进入落点 = 第一个可交互子作用域,否则根」,那是**已拍的规则**,
   * 所以这不是一次裁定而是一次修正。改判返回值之后,「声明了但此刻答 null」
   * (条件渲染、ref 还没挂上)与「根本没声明」是同一回事 —— 两者都该回落到子作用域,
   * 这正是设计要的那一档。
   */
  private entryOf(node: ScopeNode): ScopeNode {
    const seen = new Set<FocusInstanceId>()
    let at: ScopeNode = node
    /*
     * ── W4:`passThrough` 那一格也穿 ──────────────────────────────────────
     * 从前只穿 `layer`。W4 把架子与浮窗的身子换成了拼贴树,于是宿主层与那块面
     * 之间多了两级「叶」(叶根 + 那一格 tab 的层)—— 不穿过去的话键盘会落在
     * tab 条旁边那片空白上,而不是那块面里(真机门 `gate:focus` 场景 15 ③)。
     * 哪一格该穿由**那一格自己在表上说**(`FOCUS_SCOPES[...].passThrough`),
     * 内核不认识任何一个 scope 的名字。
     */
    while ((at.kind === 'layer' || FOCUS_SCOPES[at.scope]?.passThrough) && !seen.has(at.instanceId)) {
      const declared = at.restingTarget?.() ?? null
      if (declared && declared.isConnected) break
      seen.add(at.instanceId)
      let child: ScopeNode | undefined
      for (const candidate of this.map.values()) {
        if (candidate.parent !== at.instanceId) continue
        if (!isInteractive(candidate) || !candidate.root) continue
        child = candidate
        break
      }
      if (!child) break
      at = child
    }
    return at
  }

  /**
   * 这一发程序置焦**不算换人**(I1 收回 / `pointerdown` 抢根)。
   *
   * 两者都会同步发 `focusin`,而那一路要写 `returnTo`。写了的话「⌘P 之前我在
   * 输入框」就会被记成「我在壳根」——§4.5 的裁定原话点名排除的正是这两种。
   * 计数而不是布尔:两条路有可能嵌套(收回落在根上,根的 pointerdown…),
   * 布尔会被内层提前清掉。
   */
  private noReturnDepth = 0

  /** 一段「这一发不算换人」的程序置焦。`focus()` 同步发事件,所以同步包一层就够。 */
  private withoutReturnSeat(run: () => void): void {
    this.noReturnDepth += 1
    try {
      run()
    } finally {
      this.noReturnDepth -= 1
    }
  }

  /**
   * **第一响应者换人的唯一一口**(R2)。两件事在这里一起做,不许分开:
   *  ① 给新任写 `returnTo`(上一任是谁 + 焦点当时落在它的哪个元素上,§4.5);
   *  ② 沿新路径盖 MRU 戳(`activateScope` 靠它挑实例)。
   *
   * `recordReturn` 由**调用路**决定,不由这只函数猜:`activate` 与 `focusin`
   * 是真换人(写),I1 收回与 `pointerdown` 抢根不是(不写,见 `noReturnDepth`)。
   */
  private setFocused(next: FocusInstanceId | null, recordReturn: boolean): void {
    if (next !== this.focused && next && recordReturn && this.noReturnDepth === 0) {
      const node = this.map.get(next)
      const prev = this.focused ? this.map.get(this.focused) : undefined
      const element = prev?.lastFocused
      /*
       * 上一任那格元素要**此刻仍连通**才记:记一个已经离开文档的节点,等于把
       * 「回哪儿」这个问题在写的时候就答错了(读的时候还得再判一次,那是两处判据)。
       */
      if (node && prev && element && element.isConnected) {
        node.returnTo = { instanceId: prev.instanceId, element }
      }
    }
    this.focused = next
    /*
     * 节点**对象**也留一份(不只是 id):卸载一整层时,那一格常常先从表里出去,
     * 而「回哪儿」的那一格 `returnTo` 正记在它身上(检索面开在浮窗里 —— 拿到
     * 焦点的是 `search` 那一格,先卸载的可能是装着它的层)。留着这个引用,
     * 归还才问得到真正的那一任(见 `settle`)。
     */
    this.focusedNode = next ? (this.map.get(next) ?? null) : null
    this.stampPath(next)
  }

  /** 当前第一响应者的节点对象。出表之后仍然留着,只给 `settle` 问归还用。 */
  private focusedNode: ScopeNode | null = null

  /** 从第一响应者往上,给整条路径盖一次 MRU 戳。 */
  private stampPath(from: FocusInstanceId | null): void {
    const seen = new Set<FocusInstanceId>()
    let at = from
    this.tick += 1
    while (at && !seen.has(at)) {
      seen.add(at)
      const node = this.map.get(at)
      if (!node) break
      node.lastActiveAt = this.tick
      at = node.parent
    }
  }

  /**
   * 结构变化之后的结算:路径缩、焦点回落。**同步**的那一条路 —— 今天只剩
   * 「宿主打 `inert`」走它(架子切 tab)。卸载那条路把这两半拆开了,判词见
   * `pendingUnregister`:那里路径当场缩,焦点回落晚一个微任务。
   *
   * `gone` 是刚消失 / 刚变 inert 的那一格 —— 焦点回哪儿从**它**往上问。
   */
  private settle(gone: ScopeNode): void {
    const departing = this.focusedNode ?? gone
    if (!this.shrinkPathAfter(gone)) {
      this.notify()
      return
    }
    this.returnFocusAfter(gone, departing)
    this.notify()
  }

  /**
   * 结算的**前半**:路径缩到最近仍可交互的祖先。
   * 回 true = 第一响应者真的没了(所以焦点也该回落),false = 它还在,什么都没动。
   *
   * **路径缩到哪儿**与**焦点落到哪个元素**是两件事,所以它们是两只函数。
   * 合成一句的后果被单测逮住过:祖先此刻还没铺上根元素(合法中间态)时,
   * 「焦点落哪儿」答不出来,于是整条路径被清空、第一响应者凭空消失。
   */
  private shrinkPathAfter(gone: ScopeNode): boolean {
    const stillHere = this.focused ? this.map.get(this.focused) : undefined
    const focusedGone =
      !stillHere || !isInteractive(stillHere) || this.isDescendantOf(this.focused, gone.instanceId)
    if (!focusedGone) return false
    this.setFocused(nearestInteractiveAncestorOf(this.map, gone)?.instanceId ?? null, false)
    return true
  }

  /**
   * 结算的**后半**:结构归还 —— 焦点落到 `returnTargetOf` 答的那个元素上,随后那一发
   * `focusin` 把第一响应者指到它所在的那一格。**不算换人**(这是归还,不是新的接管),
   * 所以 `returnTo` 不在这条路上写。
   *
   * 从**离场的那一任**(`departing`)问起,答不出再问刚消失的这一格:一整层塌下去时,
   * `returnTo` 记在拿过焦点的那一格上(检索面),而先触发结算的可能是装着它的层。
   * 两问一句 `??`,不是两套判据 —— 同一只 `returnTargetOf`。
   */
  private returnFocusAfter(gone: ScopeNode, departing: ScopeNode): void {
    if (!this.policy.moveFocus) return
    const back =
      returnTargetOf(this.map, departing) ?? (departing === gone ? null : returnTargetOf(this.map, gone))
    if (back) this.withoutReturnSeat(() => focusElement(back.element))
  }

  private isDescendantOf(
    id: FocusInstanceId | null,
    ancestor: FocusInstanceId,
  ): boolean {
    const seen = new Set<FocusInstanceId>()
    let at = id
    while (at && !seen.has(at)) {
      if (at === ancestor) return true
      seen.add(at)
      at = this.map.get(at)?.parent ?? null
    }
    return false
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  /* ── 两个 document 监听(§4.2 来源 1 与 §4.6)────────────────────────── */

  private readonly onFocusIn = (e: FocusEvent): void => {
    const target = e.target as Node | null
    const node = scopeAtElement(this.map, target)
    if (!node) {
      /*
       * 焦点掉出了所有作用域(十有八九是掉到 body 上 —— 本仓一切「按键没反应」
       * 的病根)。**路径不变**:第一响应者不会因为一个 DOM 节点消失而消失(§4.2)。
       * 收回是 I1 的落地,三处共用 `recoverOrphanFocus()`(它自己判 policy 与
       * 「此刻真的在 body 上吗」——焦点落进一个还没登记的元素里也会走到这里,
       * 那时候什么都不该做)。
       */
      this.recoverOrphanFocus()
      return
    }
    /*
     * `lastFocused` **只记最内层那一格**,不往祖先上抹。抹了的话跳转条一开,
     * 查看器的 lastFocused 就变成跳转条的输入框;跳转条一卸载,那个元素已经
     * 不连通,「回查看器上次那一行」当场落空(§4.5 要的正是那一行)。
     */
    if (target instanceof HTMLElement) node.lastFocused = target
    if (this.focused === node.instanceId) return
    this.setFocused(node.instanceId, true)
    this.notify()
  }

  /**
   * **I1 收回的第二处**(设计 §4.1 修正段)。
   *
   * `relatedTarget === null` = 焦点从这个元素上掉下来、并没有落到下一个元素上
   * (点了空白、元素被禁用、容器被 `inert`…)。此时 `activeElement` 变成 body,
   * 而 **body 不发 `focusin`** —— 所以 `onFocusIn` 那一路根本收不到这一刻。
   *
   * 推到**微任务**再看:`focusout` 是在焦点转移的**中途**发的,同一拍里浏览器
   * 常常紧接着把焦点交给下一个元素(点一颗按钮就是这么两步)。当场判会把
   * 每一次正常的焦点转移都误判成孤儿,然后把焦点抢回上一格 —— 那是比孤儿
   * 更糟的一种病。微任务落在这一串同步事件之后、下一次渲染之前。
   */
  private readonly onFocusOut = (e: FocusEvent): void => {
    if (!this.policy.moveFocus) return
    if (e.relatedTarget !== null) return
    queueMicrotask(() => this.recoverOrphanFocus())
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.policy.moveFocus) return
    const target = e.target
    if (!(target instanceof HTMLElement)) return
    // 点在一个自己能接焦点的东西上 → 浏览器自己会落焦,不插手。
    if (target.closest('a[href],button,input,select,textarea,[tabindex],[contenteditable]')) return
    const node = scopeAtElement(this.map, target)
    if (!isInteractive(node)) return
    const root = node.root
    // 抢根**不算换人**(§4.5 裁定点名排除的第二种):点在空白处说的是「我在看这块面」,
    // 不是「我从别处交接过来」。
    if (root) this.withoutReturnSeat(() => focusElement(root))
  }

  private attach(): void {
    if (this.attached || typeof document === 'undefined') return
    document.addEventListener('focusin', this.onFocusIn)
    document.addEventListener('focusout', this.onFocusOut)
    document.addEventListener('pointerdown', this.onPointerDown, true)
    this.attached = true
  }

  /**
   * **唯一那口拆卸**(HMR dispose 复用它,不写第二套)。幂等。
   * 单测的 `afterEach` 也走这里 —— 两套拆卸迟早漏一格。
   */
  reset(): void {
    if (this.attached && typeof document !== 'undefined') {
      document.removeEventListener('focusin', this.onFocusIn)
      document.removeEventListener('focusout', this.onFocusOut)
      document.removeEventListener('pointerdown', this.onPointerDown, true)
    }
    this.attached = false
    this.map.clear()
    // 挂着的那几格「等一个微任务再结算」一并作废:它们的微任务醒来时会发现自己
    // 不在表上,于是什么都不做(见 `pendingUnregister`)。
    this.pendingUnregister.clear()
    this.listeners.clear()
    this.transients.clear()
    this.focused = null
    this.focusedNode = null
    this.captured = null
    this.lastReason = null
    this.tick = 0
    this.noReturnDepth = 0
  }

  /** 排障口的内容。见 `window.__focus.dump()`。 */
  dump(): {
    focused: FocusInstanceId | null
    reason: ActivateReason | null
    captured: boolean
    transients: number
    path: ActivePath
    nodes: {
      instanceId: string
      scope: FocusScopeId
      kind: string
      parent: string | null
      inert: boolean
      hasRoot: boolean
      keys: string[]
      escape: boolean
      owner: string | null
      returnTo: string | null
    }[]
  } {
    return {
      focused: this.focused,
      reason: this.lastReason,
      captured: Boolean(this.captured),
      transients: this.transients.size,
      path: this.activePath(),
      nodes: [...this.map.values()].map((n) => ({
        instanceId: n.instanceId,
        scope: n.scope,
        kind: n.kind,
        parent: n.parent,
        inert: n.inert,
        hasRoot: Boolean(n.root),
        keys: Object.keys(n.commands ?? {}),
        escape: Boolean(n.onEscape),
        owner: n.owner ?? null,
        returnTo: n.returnTo?.instanceId ?? null,
      })),
    }
  }
}

/**
 * 模块单例。与 `ui/float.ts` 的 `floatStack` 同一条生命周期纪律:寿命 =
 * 这个模块实例,所以文件末尾配 HMR dispose。
 */
export const focusTree = new FocusTree()

declare global {
  interface Window {
    /** 排障口(照 `__perf` / `__onethingLog` 的惯例)。 */
    __focus?: { dump: () => ReturnType<FocusTree['dump']> }
  }
}

if (typeof window !== 'undefined') {
  window.__focus = { dump: () => focusTree.dump() }
}

/*
 * 热更退役(09-01 立法)。这只模块在模块作用域里起了两样东西:那棵树(可变状态)
 * 与两个 document 监听。换掉模块时旧那一份会连同它的监听一起留下 —— 两台树
 * 同时听 focusin、各自算各自的路径,而组件只认新那一台,于是键盘路由当场分叉
 * (与 chat-source 那次「两台折叠器同时活着」同型)。
 * 拆卸**复用既有的那一口** `reset()`,它自己幂等;生产构建里
 * `import.meta.hot` 是 undefined,整段被 tree-shake 掉。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    focusTree.reset()
    if (typeof window !== 'undefined') delete window.__focus
  })
}
