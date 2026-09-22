import { createContext, useContext } from 'react'

/**
 * **「人亲手开合了一块东西」这一件事的唯一通道**(G 线 P2-b,2026-09-21;
 * 正本 `docs/stream-geometry-2026-09.md` §15.4、§13.2.2 裁决表的 `user-toggle` 那一行)。
 *
 * ── 它治的是哪一件事 ──────────────────────────────────────────────────────
 * 贴底时手动收起一块东西:页面总高一缩,浏览器当场钳 `scrollTop`,屏上其余内容
 * 整体往下掉一截(正本 §0 ①,真机 849–15054px)。规矩是 §1 的 G1 与 G2 ——
 * **一轮之内页面总高不许变小**,所以**收缩要先申请、后执行**:块向锚定器申请,
 * 锚定器先把卷尾垫块加长,块再真的缩。
 *
 * ── 一个口,不是两条线 ────────────────────────────────────────────────────
 * 开与合都走这一个口,方向由 `open` 说。在这之前是两条各说一半的通道:
 * `content/expand-intent.ts`(只报展开)与 `content/fold-intent.ts`(只报收起,
 * 而且只有思考段与重试那一路在报)——**工具卡 / 压缩折痕 / 上下文更新折痕这三族
 * 一个字都不报**(勘察记在正本 §13.1.4 ①),那正是用户今天能感觉到的那个病。
 * 两条老通道这一期**留着**(重试那一路还在用 `fold-intent`,它没有「被点的那一块」);
 * 整件退役排在 P2-c。
 *
 * ── 「先申请后执行」由**返回值**保证,不靠注释 ────────────────────────────
 * `report()` 返回的就是要写进 state 的那一格开合态:
 *
 * ```tsx
 * <Fold open={open} onOpenChange={(next) => setOpen(report({ el, open: next, durationMs }))} />
 * ```
 *
 * 拿不到返回值就写不了状态,而拿到它意味着**垫块已经同步到位、锚已经钉住**。
 * 它在事件处理函数里同步跑完,而 React 的提交排在处理函数之后 —— 所以
 * 「量改后多高」那一次逼排版(`ui/flip-height` 的 `el.offsetHeight`)一定排在
 * 垫块之后。**这比把口开在 `FlipHeightOptions` 上还早一拍**,而且躲开了那条路上的
 * 一个真坑:`useFlipHeight` 的触发沿是 `structure`,工具卡的 `structure` 在流式期间
 * **每来一步就变一次** —— 申请放在那儿等于模型每吐一步就申请一次收缩、钉住视口
 * 220ms,跟底当场断掉。「这一下是不是人干的」只有点的那一处知道。
 * (另一半理由:压缩折痕与上下文更新折痕**根本没有调 `useFlipHeight`** ——
 * 它们的收起是 `display: none`,当拍到位。)
 *
 * ── 缺省是恒等 ────────────────────────────────────────────────────────────
 * 流之外照样有消费者(Gallery 样例页、单测里直接渲染折痕与思考段),缺省把 `open`
 * 原样交回去、`jump` 退回浏览器自己那一发 `scrollIntoView`,它们一个字都不必知道
 * 有这回事。
 *
 * ── 两个动词,一个口(G 线 P2-c)────────────────────────────────────────────
 * `toggle` 是「人亲手开合了一块东西」,`jump` 是「人说了要去哪」——点钢琴键、点检索
 * 命中的一条正文、点消息尾那条来源条。这三处从前各自写滚动位
 * (`toc/useChatToc.ts` 的 `el.scrollTo({behavior:'smooth'})`、
 * `research/ResearchSegment.tsx` 的 `scrollIntoView({block:'center'})`),
 * **一处都不经过跟随状态机**:往下跳时那一支的判据(「`scrollTop` 比上一次小没小」)
 * 读成「没往回走」,于是不翻档 —— 落到一条离底还有半屏的消息上之后状态机仍是
 * `pinned`,下一段 delta 到达时 RO 把人一把拽回底(勘察记在正本 §13.1.1 末)。
 * 收编之后由裁决者**落位之后显式重判一次跟随档**(问落点的 `gap`,不等下一发
 * 滚动事件),判词在 `ViewportAnchor.reportJump` 上。
 *
 * **平滑不许变瞬移**:`behavior` 一路传到 `ScrollPort.setTop`,`DomScrollPort` 在
 * `'smooth'` 那一档走 `el.scrollTo({ top, behavior })`。
 *
 * ── 一个口,两条到达的路 ──────────────────────────────────────────────────
 * 流里那几族经 context 拿它(身份恒定,下游 memo 一格不动);**站在 Provider 上面**
 * 的消费者(`toc/useChatToc` 住在会话叶上,而 Provider 在 `ChatStream` 里)经
 * `content/viewport/geometry-port.ts` 按 `sessionId` 拿**同一只对象** —— 两条路交出
 * 的是同一个实例,所以它仍然是一个口,不是两条线。
 */

export interface UserToggle {
  /**
   * **被点的那一块** —— 接下来它的顶边不许动(§1 推论二)。
   *
   * 拿不到(还没挂上 / 样例页)就只当一句「人动了手」:垫块不垫、锚退回由锚定器
   * 自己在下一帧现选(= 今天 `pickFoldAnchor` 那条路)。
   */
  readonly el: HTMLElement | null
  /** 这一下之后它是开着还是合着。 */
  readonly open: boolean
  /**
   * 接下来那段过渡有多长(ms)。0 = 当拍到位 —— 折痕的收起(`display: none`)与
   * 动效档「无」都是 0,**照报**:那一档没有过渡,但钳位照样发生。
   */
  readonly durationMs: number
}

/**
 * **人说了要去哪**(G 线 P2-c 的第七个 cause)。
 *
 * 两种点名法,给哪一种由调用方手上有什么决定:
 *  · `top` —— 调用方自己算得出落点(钢琴键 / 检索命中已经量过那条消息的位置);
 *  · `el` + `block` —— 交给锚定器按那一件的矩形算(来源条要把那一段送到视口正中)。
 */
export interface GeometryJump {
  /** 要送进视口的那一件。给了它就由锚定器按 `block` 算落点。 */
  readonly el?: HTMLElement | null
  /** 直接给落点(`scrollTop`)。与 `el` 二选一,两个都给时 `top` 说了算。 */
  readonly top?: number
  /** 落在视口的哪一档(只在给了 `el` 时有意义)。缺省 `nearest`。 */
  readonly block?: 'start' | 'center' | 'nearest'
  /** 平滑还是瞬移。缺省 `auto`;**不许把平滑改成瞬移**(动效档由调用方说)。 */
  readonly behavior?: ScrollBehavior
}

/**
 * 流里报几何意图的**唯一通道**。两个动词的判词都在文件头。
 *
 * 它是一只**身份恒定**的对象(`useViewportAnchor` 里一次 `useMemo`)——
 * 身份一变,`MessageRow` / `ToolCard` 那几层的 memo 短路就白短路了。
 */
export interface GeometryReport {
  /** 人亲手开合了一块东西 —— 返回要写进 state 的那一格开合态。 */
  toggle(change: UserToggle): boolean
  /** 人说了要去哪 —— 落位,并在落位之后显式重判一次跟随档。 */
  jump(change: GeometryJump): void
}

/**
 * 缺省:`toggle` 恒等,`jump` 退回浏览器自己那一发 `scrollIntoView`(= 收编之前
 * `research/ResearchSegment` 那一句逐字相同的行为)。**模块级常量**,所以流之外的
 * 消费者拿到的也是一个身份恒定的值。
 */
export const NOOP_GEOMETRY_REPORT: GeometryReport = {
  toggle: (change) => change.open,
  jump: (change) => {
    if (!change.el) return
    change.el.scrollIntoView({ block: change.block ?? 'nearest', behavior: change.behavior })
  },
}

export const GeometryReportContext = createContext<GeometryReport>(NOOP_GEOMETRY_REPORT)

export function useGeometryReport(): GeometryReport {
  return useContext(GeometryReportContext)
}
