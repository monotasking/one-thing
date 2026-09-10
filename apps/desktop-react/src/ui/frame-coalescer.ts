/**
 * **观察器回调只读不写;它量到的东西一律在下一帧交出去**(09-10 立法,
 * 起因:用户拖右架子厚度把手时屏幕闪、弹「ResizeObserver loop completed with
 * undelivered notifications」;隔离真机给每只 `ResizeObserver` 包归因探针后,
 * 整条壳里**在派发循环内改了 DOM 的回调只有一处** —— `ui/Tabs.tsx` 量溢出名单
 * 那只。它 `onOverflow(...)` → zustand → `useSyncExternalStore` 让 React 在
 * **同一个 RO 派发循环**里同步提交,那一次提交挂上 / 卸下 ⋯ 钮(标签条随之变宽
 * 18px),还顺手把 `EdgeShelf` 排着的 `setLiveThickness` 一起冲了(`<aside>` 的
 * `style.width` 在派发循环里变)—— 两条都是 Chrome 判「同深度未派送」的形)。
 *
 * 这条法与 `services/perf.ts` 09-01 那条「观察器不许自伤」同源:那一半治的是
 * 观察器把自己拖垮,这一半治的是**布局观察器**在派发循环里改布局。
 *
 * **为什么是 `requestAnimationFrame` 不是微任务**:RO 的派发是在同一次布局之后
 * 一路把回调跑完,微任务队列**仍在那一趟里**清空 —— 排微任务等于没排,浏览器照旧
 * 判「这一深度上还有没派送的通知」。rAF 排到的是**下一帧**,派发循环早已收场。
 *
 * 降级:宿主没有 `requestAnimationFrame`(jsdom / 无 rAF 环境)时 `schedule()`
 * **当场同步跑** —— 那些环境里根本没有布局观察器的派发循环,同步跑与排一帧在
 * 语义上等价,而「一格都不交」会让单测与 SSR 静默少一份读数。
 *
 * 同形的三处手写待归拢(本单不迁移,迁移是等价替换要各自配反证):
 * `ui/scroll-memory.ts` 的帧末记账、`ui/float.ts` 的 resize/scroll 重定位、
 * `ui/tab-reorder.ts` 的落位闪一下。
 */
export class FrameCoalescer {
  readonly #run: () => void
  #frame = 0

  constructor(run: () => void) {
    this.#run = run
  }

  /**
   * 排一帧。**一帧内多次调用只排一次** —— 观察器一次派发里同一只条可能被报好几遍
   * (盒变了 + 滚了),交出去的应当是那一帧末的**一份**读数,不是三份。
   */
  schedule(): void {
    if (this.#frame) return
    if (typeof requestAnimationFrame !== 'function') {
      this.#run()
      return
    }
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0
      this.#run()
    })
  }

  /** 撤掉待发那一帧。卸载时必须调 —— 那一帧带的读数属于已经不在的那棵树。 */
  cancel(): void {
    if (this.#frame && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.#frame)
    }
    this.#frame = 0
  }
}
