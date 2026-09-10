/**
 * 限高折叠的**量尺** —— 全壳只有一只 `ResizeObserver`,读写分两轮。
 *
 * ── 病历(09-03 真机 CPU profile,`probe-hotspots`)────────────────────────
 * 从前每一只 `ClampedBody` 自己起一只 RO,并且在 `useLayoutEffect` 里同步
 * `measure()` 一次;那条 effect 的依赖表里带着 `children`(一个 ReactNode ——
 * 父组件每渲一次就是新引用),于是**每一次提交、每一个块**都要:
 *  ① 在 commit 里同步读一次 `scrollHeight/clientHeight`(刚改过 DOM ⇒ 强制排版),
 *  ② 注销并重建一只 ResizeObserver。
 * 切一次常规档会话的读数:`measure` self **59.5ms**,是整份 profile 里 `/src/` 的
 * 第一热点(commit 的 48%、主导任务的 21%)。
 *
 * ── 修法:量这件事搬出 commit,并且一批只排一次版 ─────────────────────────
 * 1. **只有一只观察者**。N 个块共用它,浏览器把这一批尺寸变化攒成**一次**回调。
 * 2. **回调里读写分两轮**:先把这一批 entry 的 `scrollHeight > clientHeight + 1`
 *    全读完(读之间没有任何写,所以只排一次版),再逐个回调出去。混着写的话
 *    每个回调触发的 React 更新都会把下一次读打回强制排版,N 个块就是 N 次。
 * 3. **首次回调就是初量**。RO 规范保证注册之后会派一次初始回调,所以宿主的
 *    `useLayoutEffect` 里一行同步测量都不写 —— 依赖表因此只剩 `expanded`,
 *    `children` 一变就重挂那条路整个消失(内容后来才长高,由内层盒子的尺寸变化
 *    自己触发,那正是内层那一层 div 存在的理由)。
 *
 * 代价如实记一笔:遮罩与展开钮从「与内容同一帧出现」变成「下一帧出现」——
 * RO 回调虽然在绘制前跑,但它排的是 React 的**默认车道**更新,不进当前这一帧。
 * **钳高不受影响**:`max-height` 无条件写在 `.body` 上(见 BlockShell.module.css),
 * `overflows` 只决定雾遮罩与展开钮,所以永远不会出现「先铺满再被钳住」那一闪。
 *
 * 没有 `ResizeObserver` 的环境(jsdom)由宿主退化成「effect 里量一次」——
 * 那里两个值都是 0,本来就永远不折叠。
 */

/** 一格登记:外层(被钳的那只,量它)+ 报数口。 */
interface ClampEntry {
  outer: HTMLElement
  report: (overflows: boolean) => void
}

export class ClampMeasurer {
  #observer: ResizeObserver | undefined
  /** 键 = **内层**盒子(被观察的那只);值里带着要量的外层。 */
  readonly #entries = new Map<Element, ClampEntry>()

  /** 此刻观察着几只盒子。测试口,产品代码不读。 */
  get size(): number {
    return this.#entries.size
  }

  /**
   * 盯住一只块。`inner` 是跟着内容长的那层(被观察),`outer` 是被 `max-height`
   * 钳住的那层(被量)—— 盯 outer 没用:它的高度从头到尾就是那个数,永不触发。
   */
  observe(inner: HTMLElement, outer: HTMLElement, report: (overflows: boolean) => void): void {
    if (typeof ResizeObserver === 'undefined') return
    this.#entries.set(inner, { outer, report })
    this.#observer ??= new ResizeObserver((entries) => this.#flush(entries))
    this.#observer.observe(inner)
  }

  unobserve(inner: HTMLElement): void {
    this.#entries.delete(inner)
    this.#observer?.unobserve(inner)
  }

  /** 热更 / 测试之间把这只观察者退役。幂等。 */
  reset(): void {
    this.#observer?.disconnect()
    this.#observer = undefined
    this.#entries.clear()
  }

  /** 先读完一批,再报一批 —— 顺序是这只对象存在的全部理由。 */
  #flush(entries: readonly ResizeObserverEntry[]): void {
    const measured: Array<[ClampEntry, boolean]> = []
    for (const entry of entries) {
      const record = this.#entries.get(entry.target)
      if (!record) continue
      // 量的是 outer:被钳的是它,「下面还有没有」问的也是它。
      const client = record.outer.clientHeight
      /*
       * ── 没排版的那一格报 0,而 0 不是一个读数(2026-09-10)────────────────
       * 消息行从这一批起挂 `content-visibility: auto`(理由在
       * `content/ChatStream.module.css`)。渲染被跳过的子树里,元素**没有排版**:
       * ResizeObserver 照旧派回调(规范规定跳渲 / 复渲各派一次),而这一格量出来
       * 是 0 —— 它说的是「此刻没有排版」,不是「没有溢出」。照字面算下去
       * `0 > 0 + 1` 为假,于是每一条滚出视口的消息里的每一个限高块都会被报一次
       * `overflows = false`:①雾遮罩与展开钮要等它滚回来的下一帧才补上(闪一下);
       * ②几百个块各推一次 React 更新,滚动期间白烧一片 —— 而这一整批治的正是
       * 「按整份账本计价」。
       *
       * 所以 0 一律不报:**上一次的读数原样留着**(遮罩与展开钮因此跨视口稳定),
       * 等它真的排出来再报一次真值。判据取 outer 的 `clientHeight` 而不是
       * `entry.contentRect`:接下来要读的就是 outer,它没排版的话这一读本来就
       * 没有意义 —— 一个判据管住「能不能读」与「读什么」两件事。真·空块
       * (高度就是 0)本来也不溢出,而 `overflows` 的初值就是 false,不欠它什么。
       */
      if (client <= 0) continue
      measured.push([record, record.outer.scrollHeight > client + 1])
    }
    for (const [record, overflows] of measured) record.report(overflows)
  }
}

/**
 * 全壳唯一的那一只。模块级单例 —— 它的寿命就是这个模块实例的寿命,
 * 所以按 09-01 立法配一段 HMR 退役(复用它自己那口 `reset()`,不写第二套)。
 */
export const clampMeasurer = new ClampMeasurer()

if (import.meta.hot) {
  import.meta.hot.dispose(() => clampMeasurer.reset())
}
