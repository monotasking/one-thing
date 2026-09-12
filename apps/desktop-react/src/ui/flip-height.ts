import { useLayoutEffect } from 'react'
import type { RefObject } from 'react'
import { currentMotionTier } from '../components/motion'

/**
 * **高度 FLIP 的通用原语**(09-12 从 `content/tools/ToolCard.tsx` 抽出来)。
 *
 * 一件事:一块盒子的**内容换了**,它的高就该走过去,而不是跳过去。
 * 从前这件事只有工具卡一个消费者,于是整只住在 ToolCard 里;composer 的候选
 * 抽屉(候选从「正在找…」一行长成整列)要的是逐字同一件事 —— 按「基础件先行」
 * 那条法,**第二个消费者出现的那一刻就该立件**,而不是在业务面再抄一份。
 *
 * ── 病历(2026-09-10 第三轮真机 CPU profile,原样搬过来)────────────────
 * 「改前」那一格本来是逐卡一次 `node.offsetHeight`。把它挪进 rAF 之后它从 click
 * 的同步窗口里消失了(报表上的 908 → 215ms),**但那 700 多毫秒一点没少,只是
 * 换了一栏记账**:同一次点击的长动画帧 prod 1041ms / dev 1600–2250ms,其中
 * 916 张卡各读一次 `offsetHeight` = prod 770ms,占那一帧的 74%。
 * 更糟的是它把上一批省下的钱又花了回去:消息行挂着 `content-visibility: auto`,
 * 没进过视口的行浏览器本来跳过排版,而**逐卡读一个几何属性会把那些行当场逼出来
 * 排一次版** —— A/B 实测:摘掉 FLIP 基线读,长帧 1589 → 961ms;而关掉
 * `content-visibility` 反而 826 → 1514ms(它是药不是病)。
 *
 * ── 修法:尺寸由浏览器**报**过来,不由我们去**问** ───────────────────────
 * `ResizeObserver` 的回调跑在排版**之后**:它交出来的那个数是浏览器刚刚算完的,
 * 读它不逼任何人重排,916 张卡攒成一次回调。所以「改前」那一格是 RO 记账
 * (`HeightBook`),结构真变了的那一次照旧同步读一次 `offsetHeight`
 * (**一次只发生在一只盒子上**,而且非同步不可 —— 要赶在浏览器绘制之前把起点钉住)。
 *
 * 三条退化路径都归到同一句「不做过渡,直切」:
 *  · RO 还没报过(挂载后第一次结构变化就来)—— 账上是 0;
 *  · 这只盒子此刻在跳渲的子树里(`content-visibility` 把它跳过了)—— RO 报 0,
 *    而 0 不是一个读数(与 `blocks/shell/clamp-measurer.ts` 同一条判据、
 *    同一个理由),所以**上一次的读数原样留着**,不被 0 冲掉;
 *  · 宿主没有 `ResizeObserver`(jsdom / SSR)—— `observe` 是恒等,账上恒为 0。
 *
 * 直切不是降级事故:没人看得见的盒子不需要过渡,而看得见的那只在挂载后的第一次
 * RO 回调(同一帧,绘制之前)就有数了。
 *
 * ── 为什么不是 `clamp-measurer` 那一只 ─────────────────────────────────
 * 那只的回调**读两轮**(先量完一批再报一批),它的存在理由是「报出去会引起写」;
 * 这只一个字都不读、也不报,只往表里记一格。两件事挤进一只观察者,读写分轮那条
 * 纪律就说不清了。
 */

/** 记一格高就够了 —— 谁在观察由 `#heights` 的键说了算。 */
export class HeightBook {
  #observer: ResizeObserver | undefined
  readonly #heights = new Map<Element, number>()

  /** 此刻盯着几只盒子。测试口,产品代码不读。 */
  get size(): number {
    return this.#heights.size
  }

  /**
   * 盯住一只盒子。**没有 `ResizeObserver` 的宿主是恒等**:账上永远是 0,
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
 * 没指名账本的消费者共用的那一本。模块级单例 —— 它的寿命就是这个模块实例的
 * 寿命,所以按 09-01 立法配一段 HMR 退役(复用它自己那口 `reset()`,不写第二套)。
 *
 * 工具卡**另有一本**(`content/tools/card-heights.ts`),不是疏忽:那一族是
 * 916 只一起进场的盒子,把它们与零星几只浮层挤进同一只观察者,下一个人读
 * `size` 时就说不清那个数在说谁。两只 RO 的成本是常数。
 */
export const heightBook = new HeightBook()

if (import.meta.hot) {
  import.meta.hot.dispose(() => heightBook.reset())
}

export interface FlipHeightOptions {
  /**
   * 过渡时长的 **CSS token 名**(`--dur-card-flip` / `--dur-drawer`)。
   * 写 token 而不是写数:动效档换的就是这一族 var,内联 transition 因此跟着换。
   */
  durVar: string
  /**
   * 那个 token 在 JS 侧的镜像 —— 定时器读不了 var()。产地是
   * `components/motion.ts`,由 `__tests__/motion-tokens.test.ts` 与 tokens.css
   * 逐条比对(这里只是把它接过来,不许现写一个数)。
   */
  durMs: number
  /** 缓动的 CSS token 名。缺省 `--ease`(工具卡的既有配方,迁移时一个字不动)。 */
  easeVar?: string
  /** 记「改前」那一格的账本。缺省是上面那一本。 */
  book?: HeightBook
}

/** 过渡跑完到摘掉内联 height 之间留的一点余量 —— 定时器与合成器不是同一个时钟。 */
const FLIP_SETTLE_MS = 40

/**
 * 盒高从「改前」到「改后」做过渡。
 *
 * 把内联 height 先钉回旧值、强制一次排版、再钉到新值让它自己走过去 —— 不突变。
 *
 * 只在 `structure` 变了时跑:逐帧的文字补丁不改高度,量它只是白白强排一次版。
 * 动效档 `none` 直切(不是「快一点」,是压根不做)。
 *
 * **三条次序纪律**(病历在文件头):
 *  ① 判据排在读之前 —— `none` 档整段不做,那就一个几何属性都不该碰;
 *  ② 「改前」那一格**不问,只收**:由共享 `ResizeObserver` 报过来。挂载那一次
 *     因此**一个几何属性都不读** —— 账上还是 0,那就不做过渡;
 *  ③ 只有真有「改前」的那一次照旧**同步**量「改后」并当场 FLIP。
 *
 * 过渡跑的那几百毫秒里 RO 会一路报中间高度,账上于是停在「它此刻真的多高」——
 * 万一第二次结构变化压着上一次的过渡到,起点就是它当下的位置,而不是一个
 * 早就不成立的旧值。那正是 FLIP 想要的语义,所以这里不去纠正它。
 */
export function useFlipHeight(
  ref: RefObject<HTMLElement | null>,
  structure: string,
  options: FlipHeightOptions,
): void {
  const { durVar, durMs, easeVar = '--ease', book = heightBook } = options

  // 挂载即上账,卸载即销账 —— 依赖表里没有 `structure`,一次结构变化不折腾观察者。
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    book.observe(el)
    return () => book.unobserve(el)
  }, [ref, book])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // ① none 档压根不做这件事 —— 连基线都不必问(读在前判在后,就是白排版)。
    if (currentMotionTier() === 'none') return

    // ② 账上没有「改前」= 直切(三种情形逐条理由见文件头)。
    const before = book.heightOf(el)
    if (!before) return

    // ③ 真有「改前」:同步量「改后」,当场把两头钉住。
    const after = el.offsetHeight
    if (before === after) return

    el.style.transition = 'none'
    el.style.height = `${before}px`
    // 强制一次排版,让上面那一句成为动画的起点(不读它的话浏览器会把两次写合并)。
    void el.offsetHeight
    el.style.transition = `height var(${durVar}) var(${easeVar})`
    el.style.height = `${after}px`

    const clear = () => {
      el.style.height = ''
      el.style.transition = ''
    }
    const timer = window.setTimeout(clear, durMs + FLIP_SETTLE_MS)
    return () => {
      window.clearTimeout(timer)
      clear()
    }
  }, [ref, structure, durVar, durMs, easeVar, book])
}
