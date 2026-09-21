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
 * 与 `expand-intent` / `fold-intent` 同判:流之外照样有消费者(Gallery 样例页、
 * 单测里直接渲染折痕与思考段),缺省把 `open` 原样交回去,它们一个字都不必知道
 * 有这回事。
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

/** 报一句,拿回要写进 state 的那一格开合态(判词在文件头)。 */
export type ReportUserToggle = (change: UserToggle) => boolean

export const GeometryReportContext = createContext<ReportUserToggle>((change) => change.open)

export function useGeometryReport(): ReportUserToggle {
  return useContext(GeometryReportContext)
}
