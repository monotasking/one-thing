/**
 * 卡高账本 —— **全壳一只 `ResizeObserver` 替所有工具卡记住「此刻多高」**,
 * 给 FLIP 当「改前」的起点。
 *
 * ── 病历(2026-09-10 第三轮真机 CPU profile)────────────────────────────
 * `useFlipHeight` 的首帧基线本来是逐卡一次 `node.offsetHeight`。f13a9411 把它
 * 挪进 `requestAnimationFrame` 之后,它从 click 的同步窗口里消失了(报表上的
 * 908 → 215ms),**但那 700 多毫秒一点没少,只是换了一栏记账**:同一次点击的
 * 长动画帧 prod 1041ms / dev 1600–2250ms,其中 916 张卡各读一次 `offsetHeight`
 * = prod 770ms / dev 750–990ms,占那一帧的 74%。rAF 回调与排版在**同一帧**里,
 * 排到下一帧只是把它挪出 click 的那一栏 —— 用户看到的仍然是一次一秒多的卡死。
 *
 * 更糟的是它把上一批省下的钱又花了回去:消息行挂着 `content-visibility: auto`
 * (`content/ChatStream.module.css`),没进过视口的行浏览器本来跳过排版;
 * 而**逐卡读一个几何属性会把那些行当场逼出来排一次版** ——
 * A/B 实测:摘掉 FLIP 基线读,长帧 1589 → 961ms;而关掉 `content-visibility`
 * 反而 826 → 1514ms(它是药不是病)。
 *
 * ── 修法:尺寸由浏览器**报**过来,不由我们去**问** ───────────────────────
 * `ResizeObserver` 的回调跑在排版**之后**:它交出来的那个数是浏览器刚刚算完的,
 * 读它不逼任何人重排,916 张卡攒成一次回调。所以「改前」那一格改成 RO 记账,
 * 结构真变了的那一次照旧同步读一次 `offsetHeight`(**一次只发生在一张卡上**,
 * 而且非同步不可 —— 要赶在浏览器绘制之前把起点钉住)。
 *
 * 三条退化路径都归到同一句「不做过渡,直切」:
 *  · RO 还没报过(挂载后第一次结构变化就来)—— 账上是 0;
 *  · 这张卡此刻在跳渲的子树里(`content-visibility` 把它跳过了)—— RO 报 0,
 *    而 0 不是一个读数(与 `blocks/shell/clamp-measurer.ts` 同一条判据、
 *    同一个理由),所以**上一次的读数原样留着**,不被 0 冲掉;
 *  · 宿主没有 `ResizeObserver`(jsdom / SSR)—— `observe` 是恒等,账上恒为 0。
 *
 * 直切不是降级事故:没人看得见的卡不需要过渡,而看得见的那张在挂载后的第一次
 * RO 回调(同一帧,绘制之前)就有数了。
 *
 * ── 为什么不是 `clamp-measurer` 那一只 ─────────────────────────────────
 * 那只的回调**读两轮**(先量完一批再报一批),它的存在理由是「报出去会引起写」;
 * 这只一个字都不读、也不报,只往表里记一格。两件事挤进一只观察者,读写分轮那条
 * 纪律就说不清了。今天它只有工具卡一个消费者,所以住在 `content/tools/` 下;
 * 哪天第二个块也要 FLIP,它该搬到 `blocks/shell/` 去与量尺做邻居。
 */

/** 记一格高就够了 —— 谁在观察由 `#heights` 的键说了算。 */
export class CardHeightBook {
  #observer: ResizeObserver | undefined
  readonly #heights = new Map<Element, number>()

  /** 此刻盯着几只盒子。测试口,产品代码不读。 */
  get size(): number {
    return this.#heights.size
  }

  /**
   * 盯住一张卡。**没有 `ResizeObserver` 的宿主是恒等**:账上永远是 0,
   * 于是调用方永远走直切那条路(而不是在脏布局上补一次同步读)。
   */
  observe(el: HTMLElement): void {
    if (typeof ResizeObserver === 'undefined') return
    this.#heights.set(el, 0)
    this.#observer ??= new ResizeObserver((entries) => this.#record(entries))
    this.#observer.observe(el)
  }

  unobserve(el: HTMLElement): void {
    this.#heights.delete(el)
    this.#observer?.unobserve(el)
  }

  /** 上一次报到的高;从没报过 = 0 —— 调用方据此直切。 */
  heightOf(el: HTMLElement): number {
    return this.#heights.get(el) ?? 0
  }

  /** 热更 / 测试之间把这只观察者退役。幂等。 */
  reset(): void {
    this.#observer?.disconnect()
    this.#observer = undefined
    this.#heights.clear()
  }

  /**
   * 只记账,不读、不报、不推 React 更新 —— 所以它不可能与自己形成
   * 「ResizeObserver loop」(那条报错的成因是回调里写了会改尺寸的东西)。
   */
  #record(entries: readonly ResizeObserverEntry[]): void {
    for (const entry of entries) {
      if (!this.#heights.has(entry.target)) continue
      /*
       * 取 **border box**:`offsetHeight` 量的是它,内联 `height` 写的也是它
       * (全局 `box-sizing: border-box`)。`contentRect` 是内容盒,拿它当起点
       * 会短掉一圈内边距,过渡的第一帧当场跳一下。`borderBoxSize` 是今天所有
       * 现役浏览器都有的(Electron 41 = 现役 Chromium),这一句的兜底是为了
       * 那些手写的假 RO —— 不是为了某个真的宿主。
       */
      const boxes = entry.borderBoxSize as readonly ResizeObserverSize[] | undefined
      const height = boxes && boxes.length > 0 ? boxes[0].blockSize : entry.contentRect.height
      // 0 说的是「此刻没有排版」,不是「高度是 0」—— 判据与理由见文件头。
      if (height <= 0) continue
      this.#heights.set(entry.target, height)
    }
  }
}

/**
 * 全壳唯一的那一本。模块级单例 —— 它的寿命就是这个模块实例的寿命,
 * 所以按 09-01 立法配一段 HMR 退役(复用它自己那口 `reset()`,不写第二套)。
 */
export const cardHeights = new CardHeightBook()

if (import.meta.hot) {
  import.meta.hot.dispose(() => cardHeights.reset())
}
