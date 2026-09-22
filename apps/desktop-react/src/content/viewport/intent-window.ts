import type { AnchoredElement } from './scroll-port'

/**
 * **「人动了手,接下来这么久归他」那一格时限窗口**(G 线 P2-c 合一;正本
 * `docs/stream-geometry-2026-09.md` §18.1)。
 *
 * ── 一格,不是两格 ────────────────────────────────────────────────────────
 * P2-a 抽件时这里是**两格**:`#expandUntil`(一个时刻,配 `noteExpand` /
 * `expanding` / `clearExpand`)与 `#fold`(一个 `Hold`,带锚、带 `rejudge`)——
 * 那是两条老通道(`content/expand-intent.ts` / `content/fold-intent.ts`)在引擎
 * 这一侧的影子,P2-a 的自述是「只搬不合一」。
 *
 * P2-b 之后**报出来的那一下开与合都走这一格**(`ViewportAnchor.reportUserToggle`
 * 两侧都开窗、都钉锚),`expand-intent` 的生产者归零,于是 `#expandUntil` 成了
 * 一格没人开的空位。P2-c 把它收掉:**方向由报的人给的 `open` 说,不由「你调了
 * 哪一个函数」说** —— 那正是 §13.2.2 要的「块只报几何变化,裁决归裁决者」。
 *
 * ── 为什么记的是「到什么时候为止」,不是一个布尔闩 ────────────────────────
 * 展开 / 折叠都是一段**过渡 / FLIP**,尺寸变化会**逐帧**来好几次,一次性闩被第一帧
 * 消费掉之后,后面那几帧照旧跟底(2026-09-12 报障二仍在);而且短会话里第一帧往往
 * 还没溢出,gap 仍是 0,状态压根不会翻成 browsing。
 *
 * **为什么不是 `transitionend`**:动效档「无」下它根本不发、被打断时也不发,而且
 * 四个消费者(折痕 / 压缩折痕 / 思考段 / 工具卡)各自的过渡挂在各自的元素上,要
 * 一一接线;截止时刻是一个数,谁报都一样。
 *
 * **零 DOM**:`now` 由调用方给(今天 `performance.now()`),锚是 `AnchoredElement`。
 */
export class IntentWindow {
  /**
   * **人亲手开合了一块东西,这段时间钉住视口**。
   *
   * `anchor` 在报的那一刻就选定(报的人点得出「被点的是哪一块」);点不出来时
   * 留空,由**这一段的第一帧**在 RO 回调里 `pickFoldAnchor()` 现选并记下位置,
   * 之后每一帧把它按回去 —— 选锚要在排版之后,所以报的那一头只记截止时刻。
   */
  #hold: Hold | undefined = undefined

  /** 刚过期、还没被重判过的那一个窗口(判词在 `takeExpired`)。 */
  #justExpired: Hold | undefined = undefined

  /**
   * **开一格窗**。`ms` 已含余量;`anchor` 缺席 = 退回「第一帧现选锚」那条路
   * (点不出被点的那一块时走它 —— 重试那一路的 `MessageRow`、样例页、单测)。
   * `rejudge` 与锚**分家**:点不出那一块照样可能要重判(展开那一侧),
   * 也可能不许重判(重试那一路,判词在 `Hold.rejudge`)。
   *
   * **后到的那一句说了算**:同一格窗被重开时旧的整格丢掉 —— 「收到一半又展开」
   * 不撤的话那一下展开会被当成还在折(这一支整段早退、不派 `scrolled`),
   * 窗口一过 `stick()` 就把人拽到底。
   */
  open(
    now: number,
    ms: number,
    pinned?: { anchor?: AnchoredElement; top?: number; rejudge?: boolean },
  ): void {
    this.#hold = {
      until: now + ms,
      anchor: pinned?.anchor,
      top: pinned?.top,
      rejudge: pinned?.rejudge ?? false,
    }
  }

  /**
   * 撤掉这一格窗。
   *
   * 调用点只有换会话 / 离场:那格截止时刻说的是「**那边**有人动了手」,
   * 不清的话那边点开的那一下会把这边的第一批尺寸变化整段早退掉。
   */
  clear(): void {
    this.#hold = undefined
  }

  /**
   * **这一段还在长,把截止时刻往后推**(P2-b 审查裁定 2 落地那一趟真机抓出来的)。
   *
   * 定长窗口在**超量档**上不够用:400 条 / 十一万像素那条会话上,一帧本身就可能
   * 跑 1158ms —— 窗口在第一批尺寸变化到达之前就过期了,于是「点开不贴底」那句话
   * 当场失效(实测 6 万字思考段展开后视口被拽走 20,478px)。所以窗口**跟着那段
   * 过渡走**:只要这一批还在长,就把截止时刻推到「此刻 + 余量」。
   * 它有界 —— 内容不长了就不再推,余量一过自然收。
   */
  extend(now: number, ms: number): void {
    const hold = this.#hold
    if (!hold) return
    const until = now + ms
    if (until > hold.until) this.#hold = { ...hold, until }
  }

  /**
   * 此刻的窗。**过期就当场清掉并答 `undefined`**(注意是 `>` 不是 `>=`,
   * 与合一之前那两句 `if (now > hold.until) … else …` 逐字同义)。
   */
  current(now: number): Hold | undefined {
    const hold = this.#hold
    if (!hold) return undefined
    if (now > hold.until) {
      this.#hold = undefined
      // 交给下面那一格:窗口刚过期的那一次要**重判跟随档**(P2-b 审查裁定 2)。
      this.#justExpired = hold
      return undefined
    }
    return hold
  }

  /**
   * **刚过期的那一个窗口,只交出一次**(P2-b 审查裁定 2)。
   *
   * 起因:窗口整段是**早退**的 —— 不判跟底、不判丸。窗口一过要是什么都不做,
   * `stick()` 就会按「这一轮还 pinned」把人拽到底(用户报的「第二次展开视口被
   * 拽走 166–435px」正是这条)。所以过期那一次要补一发「此刻离底这么远」,
   * 让状态机自己翻档。
   *
   * 一次性:同一个窗口只交出一次,不然每一批尺寸变化都会重判一遍。
   */
  takeExpired(): Hold | undefined {
    const done = this.#justExpired
    this.#justExpired = undefined
    return done
  }

  /** 单测读面。 */
  get holdUntil(): number {
    return this.#hold?.until ?? 0
  }
}

/**
 * 这一段钉住的是谁、钉在哪。
 *
 * 两格都是**可选**的:报的人点不出那一块时,这一段的第一帧才选锚(选锚要在排版
 * 之后),而在选到之前每一帧都会再试一次 —— 那一句 `if (!hold.anchor ||
 * !hold.anchor.alive())`。
 */
export interface Hold {
  readonly until: number
  anchor?: AnchoredElement
  top?: number
  /**
   * 窗口里每一批(以及过期那一次)要不要**按此刻离底多远重判跟随档**
   * (P2-b 审查裁定 2)。
   *
   * 「人亲手开合了一块东西」那条路给 true(点不点得出被点的那一块都给 ——
   * 展开那一侧合一之前走的另一格窗原本就在重判);**重试那一路不给**:它刚由
   * `landOnRetry` 滑到置顶线、座位正握着这一轮,重判会把它翻成 browsing,
   * 新回答当场不跟底。
   */
  readonly rejudge?: boolean
}
