import { FOCUS_SCOPES } from './scopes'
import {
  activePathOf,
  isInteractive,
  nearestInteractiveAncestorOf,
  restingElementOf,
  returnTargetOf,
  scopeAtElement,
  shrinkPath,
} from './transitions'
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
  /** 局部键的落点,键是 `ScopedKey.action`。 */
  keyHandlers?: Readonly<Record<string, (() => void) | undefined>>
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
    const node: ScopeNode = {
      instanceId,
      scope,
      kind: FOCUS_SCOPES[scope].kind,
      parent,
      inert: opts.inert ?? false,
      root: null,
      lastFocused: null,
      restingTarget: opts.restingTarget,
      onEscape: opts.onEscape ?? undefined,
      keyHandlers: opts.keyHandlers,
    }
    this.map.set(instanceId, node)
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
        if ('keyHandlers' in patch) at.keyHandlers = patch.keyHandlers
        // 变得不可交互 = 结构变化(§4.2 来源 3),与卸载同一条路。
        if (patch.inert) this.settle(at)
        else this.notify()
      },
      activate: (reason: ActivateReason = 'programmatic') => this.activate(instanceId, reason),
      unregister: () => this.unregister(instanceId),
    }
  }

  /**
   * 摘掉一格。摘完**当场结算**:第一响应者要是它(或它的后代),路径缩到最近
   * 仍可交互的祖先,焦点按 `returnTargetOf` 回落 —— 这就是「归还是结构性的」
   * (§4.5):写跳转条的人不需要知道有归还这回事。
   */
  unregister(instanceId: FocusInstanceId): void {
    const node = this.map.get(instanceId)
    if (!node) return
    this.map.delete(instanceId)
    this.settle(node)
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
    this.focused = instanceId
    this.lastReason = reason
    if (this.policy.moveFocus) {
      const el = restingElementOf(node)
      el?.focus({ preventScroll: true })
    }
    this.notify()
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
    target?.focus({ preventScroll: true })
  }

  /* ── 内部 ────────────────────────────────────────────────────────────── */

  /** 最近一次 activate 的理由。只进 `__focus.dump()`,路由不看。 */
  private lastReason: ActivateReason | null = null

  /**
   * 结构变化之后的结算:路径缩、焦点回落。
   * `gone` 是刚消失 / 刚变 inert 的那一格 —— 焦点回哪儿从**它**往上问。
   */
  private settle(gone: ScopeNode): void {
    const stillHere = this.focused ? this.map.get(this.focused) : undefined
    const focusedGone =
      !stillHere || !isInteractive(stillHere) || this.isDescendantOf(this.focused, gone.instanceId)
    if (!focusedGone) {
      this.notify()
      return
    }
    /*
     * **路径缩到哪儿**与**焦点落到哪个元素**是两件事,分两句问。
     * 合成一句的后果被单测逮住过:祖先此刻还没铺上根元素(合法中间态)时,
     * 「焦点落哪儿」答不出来,于是整条路径被清空、第一响应者凭空消失。
     */
    this.focused = nearestInteractiveAncestorOf(this.map, gone)?.instanceId ?? null
    if (this.policy.moveFocus) {
      const back = returnTargetOf(this.map, gone)
      back?.element.focus({ preventScroll: true })
    }
    this.notify()
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
    this.focused = node.instanceId
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
    node.root?.focus({ preventScroll: true })
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
    this.listeners.clear()
    this.transients.clear()
    this.focused = null
    this.captured = null
    this.lastReason = null
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
        keys: Object.keys(n.keyHandlers ?? {}),
        escape: Boolean(n.onEscape),
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
