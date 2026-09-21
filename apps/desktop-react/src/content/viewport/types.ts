/**
 * **视口锚定器的词汇表**(G 线 P2,正本 `docs/stream-geometry-2026-09.md` §13.2.2)。
 *
 * ── 这一期它们**只是类型,没有接线** ──────────────────────────────────────
 * P2-a 的自述是「抽件不改行为」:`GeometryChange` / `GeometryVerdict` 与那张裁决表
 * 是 P2-b/c 的落点,今天一个生产者都没有。先把词定下来,是因为搬迁过程中每一支
 * `if` 都要说得出「我此刻在判的是哪一格 cause」—— `ScrollPort.setTop(top, cause)`
 * 吃的那一格就是它,今天只用于**埋点与将来的 dev 断言,不改行为**。
 *
 * 零 DOM、零 React:这份文件里没有一个 `HTMLElement`。
 */

/** 这一次几何变化是谁引起的 —— 裁决表按它分档,里面不出现任何一件东西的名字。 */
export type GeometryCause =
  /** 内容自己长出来(流式 delta、异步高亮、图片解码完)。只增。 */
  | 'tail-growth'
  /** 用户亲手开合了一块东西。可增可减,减的那一半是 P2-b 要治的。 */
  | 'user-toggle'
  /** 事后插进列里的一行(上下文更新折痕、收场通知、扩窗 prepend)。 */
  | 'late-insert'
  /** 一轮收场:内容形态换了但不许改高。报它是为了让 dev 断言查得出违例。 */
  | 'settle'
  /** 发送 / 重试要把视口挪到一个新落点。唯一允许「主动移动视口」的 cause。 */
  | 'send-landing'
  /** 恢复一个已知位置:进场落锚点、停靠取回、扩窗保位。 */
  | 'restore'
  /** 明确的跳转:点钢琴键、点检索命中、点来源条。人说了要去哪。 */
  | 'jump'

/** 一件东西在这一刻相对视口的位置 —— 裁决只认这三档,不认像素。 */
export type GeometryZone = 'above' | 'inside' | 'below'

export interface GeometryChange {
  /**
   * 报的人。**不是 `blockId`** —— 报这件事的未必是块:座位垫块、尾槽那格空位、
   * 扩窗那一批 prepend 都要报,而它们都不是块。`string` 而不是枚举,因为
   * 这一层里不许出现任何一件能力的名字(仓根「加功能不许改骨架」)。
   */
  readonly sourceId: string
  readonly cause: GeometryCause
  /**
   * 这一件**接下来**会变多高(正 = 长高,负 = 缩)。
   *
   * **它是「申请」不是「事后通报」**:G2 说的收缩先申请后执行,靠的就是这一格在
   * 块真的缩之前先到。报的人算得出它(`ui/flip-height` 手里那格 `before` 就是);
   * 算不出就报 `undefined`,锚定器退回「事后按锚点自校正」那条路(= 今天
   * `foldHold` 那一支的行为,不是新写一条)。
   */
  readonly deltaH?: number
  /**
   * 这一段变化要持续多久(毫秒)。0 / 缺席 = 一次性。
   *
   * 过渡会**逐帧**报好几次尺寸变化,一次性闩被第一帧消费掉之后后面那几帧就裸奔了
   * —— 判词原文在 `content/fold-intent.ts`,那是 09-15 真机踩出来的。
   */
  readonly durationMs?: number
  /** 这一件此刻的矩形,由报的人给(它手上已经有了)或由锚定器现量。 */
  readonly rect?: { readonly top: number; readonly bottom: number }
}

/** 裁决结果 —— **锚定器答「做什么」,由它自己执行;报的人拿不到这个值。** */
export type GeometryVerdict =
  | { readonly kind: 'ignore'; readonly why: string }
  /** 跟随:把视口贴到底。 */
  | { readonly kind: 'follow' }
  /** 钉住:锁住某一件东西的顶边,接下来 `holdMs` 毫秒里每帧把它按回去。 */
  | { readonly kind: 'pin'; readonly anchor: 'reported' | 'first-visible'; readonly holdMs: number }
  /** 补偿:视口上方长了 / 缩了,按同样的量改 scrollTop,屏上一像素不动。 */
  | { readonly kind: 'compensate'; readonly deltaH: number }
  /** 吸收:把缩掉的高记进卷尾垫块,页面总高不变(G1)。 */
  | { readonly kind: 'absorb'; readonly deltaH: number }
  /** 违例:dev 下报错,prod 下退回 `ignore`。 */
  | { readonly kind: 'violation'; readonly why: string }
