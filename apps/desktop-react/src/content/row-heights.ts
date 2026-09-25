import type { RefCallback } from 'react'
import { HeightBook } from '../ui/flip-height'

/**
 * **行高账** —— 渲过的消息行多高,按消息 id 记下来;这条会话下一次挂载时,每一行一出生
 * 就带着上一次的真高(G 线 P4-b ①,正本 `docs/stream-geometry-2026-09.md` §22.2)。
 *
 * ── 病 ──────────────────────────────────────────────────────────────────────
 * 消息行挂着 `content-visibility: auto` + `contain-intrinsic-block-size: auto
 * var(--msg-intrinsic-h)`。那个 `auto` 让浏览器**记住**渲过的真高 —— 但记在**元素**上。
 * `ChatStream` 卸载再挂载(视图停靠池挤出去、关掉再打开)之后行是新建的,记忆随旧元素
 * 一起没了,每一行又占回那 240px 的估计。后果两条(§22.1,④ 改前基线):进场落回锚点
 * 要再对几轮(真店档一跳 552px,两写隔着一帧以上 —— 中间那一帧画的是没对准的那一份);
 * 往上翻时内容列一路长高、滚动条一路变短(关掉前后 `scrollHeight` 差 5,368px)。
 *
 * ── 治法:记忆从元素挪到身份上 ──────────────────────────────────────────────
 * 这本账按**消息 id** 记,行挂载那一刻把记着的真高写成行上的内联 `--msg-intrinsic-h`,
 * 于是 `contain-intrinsic-block-size` 一开始就是真的。CSS 一字不改:没账的行不写内联值,
 * 缺省 240px 照旧。**渲出来之后浏览器用的是它自己记的那一份**(`auto` 那一半),内联值
 * 只在「还没渲过」的那段时间里当估计 —— 所以它改变的只有跳渲行的**占位**,一个画出来
 * 的像素都不动。
 *
 * ── 只记渲过的行 ────────────────────────────────────────────────────────────
 * 跳渲中的行,RO 报的是它的占位(240px 或上一次的内联值),记进去就是把估计当真高。
 * 「渲着没有」由浏览器自己说:`contentvisibilityautostatechange`(`skipped` 为假 = 渲着)。
 * 不用 `checkVisibility` 逐行问 —— 那是一次布局读。Electron 41 真机实测的时序
 * (scratchpad 探针,写在这儿免得下一个人重测):**同一帧里 RO 先报、事件后到**,
 * 挂载那一帧每一行都会收到一发初始状态;所以「由跳渲转渲着」那一发事件到的时候,
 * `HeightBook` 手里已经是这一行渲出来之后的真高 —— 记账就在事件里记那一格。
 * 列尾那一行是 `content-visibility: visible`(`ChatStream.module.css` 的
 * `.row:last-of-type`),它**永远收不到事件**,也永远不跳渲 —— 由 DOM 上「后面还有没有
 * 别的 article」判(走兄弟指针,不读几何)。
 *
 * ── 列宽变了整本作废 ────────────────────────────────────────────────────────
 * 行高是列宽的函数。RO 报来的宽与本上的 `width` 不同,整本清空、记新宽。跳渲中的行此时
 * 还挂着旧宽下的内联值 —— 那不比 240px 的固定估计更差,而且它一渲出来浏览器就换成
 * 真高、账也跟着记下新宽下的那一格。**挂载时不查宽**:渲染期读不出列宽(那是一次布局
 * 读),别处改过宽之后回来的那一批估计同样「不比 240px 差」,第一发 RO 就把本清了。
 *
 * ── 寿命 ────────────────────────────────────────────────────────────────────
 * 一条会话一本,住模块级 Map,封顶 32 本(LRU;与 `chat-source` 停靠池同一条理由 ——
 * 它是一份按会话的缓存,没有上限就随打开过的会话线性长)。**不落盘**:它是「这次进程里
 * 见过」的记忆,重启就该忘(字体、缩放、窗宽都可能换过)。按 09-01 立法配 HMR 退役。
 * 一本里的行不随消息删除摘掉:删掉的消息不会再挂载,那几格只占几十字节,换本时一起走。
 *
 * ── 喂它的是谁 ──────────────────────────────────────────────────────────────
 * `RowHeightObserver`(下面)—— 一次 `ChatStream` 挂载一只,复用 `ui/flip-height` 的
 * `HeightBook` 那只观察者(不写第三份记账逻辑,§22.2)。同一格读数它还转告一声
 * `ViewportAnchor`(冻结线的 dev 断言,§22.3),那一路 prod 下是一句 `?.` 的空跳。
 */

/** 一条会话的那一本。 */
export class RowHeightBook {
  /** 这一本记的是哪一个列宽下的高。`undefined` = 还没记过。 */
  #width: number | undefined = undefined
  readonly #heights = new Map<string, number>()

  /** 这一行上一次渲出来多高;没记过 = `undefined`(调用方据此不写内联值)。 */
  heightOf(rowId: string): number | undefined {
    return this.#heights.get(rowId)
  }

  /**
   * 记一格。0 与非有限数不是读数(与 `HeightBook` 同判据);宽变了(超过亚像素那一格)
   * 先整本作废再记 —— 判词在文件头「列宽变了整本作废」。
   */
  record(rowId: string, height: number, width: number): void {
    if (!(height > 0) || !(width > 0) || !Number.isFinite(height) || !Number.isFinite(width)) return
    if (this.#width === undefined || Math.abs(width - this.#width) > 0.5) {
      this.#heights.clear()
      this.#width = width
    }
    this.#heights.set(rowId, height)
  }

  /** 单测读面。 */
  get width(): number | undefined {
    return this.#width
  }

  /** 单测读面。 */
  get size(): number {
    return this.#heights.size
  }
}

/**
 * 一进程最多记几条会话的行高。
 *
 * 它是条数,不进 `components/motion.ts` 也不进 tokens(同族判词在
 * `content/session-park.ts` 的 `SESSION_VIEW_PARK_LIMIT` 上)。32 = 停靠池 8 格的四倍:
 * 视图池挤出去的那几条最先要用它,而数据池之外的会话再回来是冷载,账仍然有用 ——
 * 行高与数据是不是还在手里无关。一本 400 行 ≈ 几十 KB,32 本是可以忽略的量。
 */
export const ROW_HEIGHT_BOOKS_LIMIT = 32

/** 会话 id → 那一本。Map 的插入序就是 LRU 序:用一次挪到队尾,满了从队头逐出。 */
const BOOKS = new Map<string, RowHeightBook>()

/** 这条会话的那一本(没有就建),顺手把它挪成「最近用过」。 */
export function rowHeightsOf(sessionId: string): RowHeightBook {
  let book = BOOKS.get(sessionId)
  if (book) BOOKS.delete(sessionId)
  else book = new RowHeightBook()
  BOOKS.set(sessionId, book)
  while (BOOKS.size > ROW_HEIGHT_BOOKS_LIMIT) {
    const oldest = BOOKS.keys().next().value
    if (oldest === undefined) break
    BOOKS.delete(oldest)
  }
  return book
}

/** 热更 / 测试之间把全部账本退役。 */
export function resetRowHeights(): void {
  BOOKS.clear()
}

/** 单测读面:此刻记着几本。 */
export function rowHeightBookCount(): number {
  return BOOKS.size
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => resetRowHeights())
}

/** 同一格读数转告给谁(冻结线的 dev 断言;判词在 `ViewportAnchor.noteRowHeight`)。 */
export type RowHeightSink = (rowId: string, height: number, width: number) => void

/**
 * **一次 `ChatStream` 挂载(一条会话)的那只观察者**:喂账、给挂载那一刻的估计、
 * 把同一格读数转告冻结线。
 *
 * 三件事为什么在一只对象上:它们说的是同一张「行 id ↔ 元素 ↔ 高」的表 —— 行靠
 * `refFor(id)` 登记元素,RO 按元素报高,账按 id 记,挂载时按 id 读。拆成三只就得在
 * 三处各维护一份 id↔元素的对照。
 */
export class RowHeightObserver {
  readonly #book: RowHeightBook
  readonly #sink: RowHeightSink | undefined
  readonly #heights: HeightBook
  /** 登记着的行:元素 → 行 id。 */
  readonly #ids = new Map<Element, string>()
  /**
   * 每一行上一次收到的跳渲状态(`true` = 跳渲中)。**缺席 = 还没收到过** —— 挂载那一帧
   * RO 先于事件到,那一发读数先不记,等事件说「渲着」时再记(时序判词在文件头)。
   */
  readonly #skipped = new Map<Element, boolean>()
  /** `refFor` 交出去的回调,按 id 记住 —— 身份恒定,React 才不会每次提交都摘了再挂。 */
  readonly #refs = new Map<string, RefCallback<HTMLElement>>()
  /** 挂载那一刻给出去的估计,按 id 记住(判词在 `heightAtMount`)。 */
  readonly #seeded = new Map<string, number | undefined>()
  /** 最近一次 RO 报来的列宽 —— 事件那一路记账时要一个宽,而事件自己不带。 */
  #width = 0
  #root: HTMLElement | undefined = undefined

  constructor(book: RowHeightBook, sink?: RowHeightSink) {
    this.#book = book
    this.#sink = sink
    this.#heights = new HeightBook((el, height, width) => this.#onReport(el, height, width))
  }

  /**
   * 这一行**挂载那一刻**该带的估计。
   *
   * 只在第一次问的时候读账,之后原样交回同一个数:行元素账(P4-a)按输入 `===` 判「这一行
   * 要不要重造元素」,而账会随着这一行渲出来被改写 —— 要是每次都现读,一行渲完下一帧
   * 它的输入就变了、元素重造一遍,P4-a 省下的那笔钱当场花回去。账的读者是**下一次挂载**,
   * 不是这一次(§22.2 末条)。
   */
  heightAtMount(rowId: string): number | undefined {
    if (this.#seeded.has(rowId)) return this.#seeded.get(rowId)
    const height = this.#book.heightOf(rowId)
    this.#seeded.set(rowId, height)
    return height
  }

  /**
   * 这一行的 ref 回调(React 19 的「回调返回清理函数」形)。按 id 缓存,身份恒定。
   * 挂上即观察,摘下即不再观察 —— 与 `useFlipHeight` 那一手同形。
   */
  refFor(rowId: string): RefCallback<HTMLElement> {
    let ref = this.#refs.get(rowId)
    if (!ref) {
      ref = (el) => {
        if (!el) return
        this.#ids.set(el, rowId)
        this.#heights.observe(el)
        return () => {
          this.#ids.delete(el)
          this.#skipped.delete(el)
          this.#heights.unobserve(el)
        }
      }
      this.#refs.set(rowId, ref)
    }
    return ref
  }

  /**
   * 接上滚动容器:`contentvisibilityautostatechange` **不冒泡**,但捕获阶段照样经过每一层
   * 祖先 —— 所以一只挂在容器上的捕获监听就收得到每一行的事件,不必逐行挂。
   */
  attach(root: HTMLElement): void {
    if (this.#root === root) return
    this.#root?.removeEventListener('contentvisibilityautostatechange', this.#onState, true)
    this.#root = root
    root.addEventListener('contentvisibilityautostatechange', this.#onState, true)
  }

  /** 卸载 / 换会话:观察者退役,监听摘掉。幂等(StrictMode 下会先退役一次再接回来)。 */
  dispose(): void {
    this.#root?.removeEventListener('contentvisibilityautostatechange', this.#onState, true)
    this.#root = undefined
    this.#heights.reset()
    this.#ids.clear()
    this.#skipped.clear()
  }

  /** 单测读面:此刻登记着几行。 */
  get observed(): number {
    return this.#ids.size
  }

  /** RO 报来一格读数(已经过 `HeightBook` 的「0 不算」)。 */
  #onReport(el: Element, height: number, width: number): void {
    this.#width = width
    const rowId = this.#ids.get(el)
    if (rowId === undefined) return
    if (!this.#rendered(el)) return
    this.#commit(rowId, height, width)
  }

  /** 浏览器说这一行跳渲 / 渲着了。捕获阶段收的,`target` 就是那一行。 */
  readonly #onState = (event: Event): void => {
    const el = event.target
    if (!(el instanceof Element)) return
    const rowId = this.#ids.get(el)
    if (rowId === undefined) return
    const skipped = (event as Event & { skipped?: unknown }).skipped === true
    this.#skipped.set(el, skipped)
    if (skipped) return
    /*
     * 由跳渲转渲着:同一帧里 RO 已经先报过这一行渲出来之后的高(时序判词在文件头),
     * 那一发因为「还不知道渲没渲」没记,这里补记。万一这一次事件先到,账上是占位 ——
     * 紧接着那一发 RO 会用真高覆盖它(此刻已经知道是渲着的了)。
     */
    const height = this.#heights.heightOf(el as HTMLElement)
    if (height > 0 && this.#width > 0) this.#commit(rowId, height, this.#width)
  }

  /** 这一行此刻渲着吗。事件说过就听事件的;没说过只有列尾那一行算(它永不跳渲)。 */
  #rendered(el: Element): boolean {
    const skipped = this.#skipped.get(el)
    if (skipped !== undefined) return !skipped
    return isLastArticle(el)
  }

  #commit(rowId: string, height: number, width: number): void {
    this.#book.record(rowId, height, width)
    this.#sink?.(rowId, height, width)
  }
}

/**
 * 它是不是列里最后一个 `article`(= `.row:last-of-type`,`content-visibility: visible` 那一格)。
 * 走兄弟指针,不读几何;列尾之后只有座位垫块与尾槽空位两个 `div`,所以最多走两三步。
 */
function isLastArticle(el: Element): boolean {
  for (let next = el.nextElementSibling; next; next = next.nextElementSibling) {
    if (next.tagName === el.tagName) return false
  }
  return true
}
