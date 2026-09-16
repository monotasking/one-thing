/**
 * `NativeViewLayout` —— 原生视图的几何、显隐、堆叠序与**遮挡快照**。
 *
 * ## 单位:DIP = CSS px(方案 §9-10)
 *
 * `setBounds` 收 DIP;渲染进程量出来的 `getBoundingClientRect()` 是 CSS px。
 * 两者相等的**前提**是渲染进程缩放因子为 1 —— 今天壳里零处 `setZoomFactor`
 * (核过)。将来谁加 ⌘+/− 缩放,要在**发帧那一侧**乘回去;这里永远只认 DIP,
 * 不认识缩放这回事。取整在这里做:分数矩形会在占位格与周边 chrome 之间留一道缝。
 *
 * ## 堆叠序:`z` 是壳报的名次,不是 CSS z-index(§9-6)
 *
 * 原生视图之间谁盖谁,由 `contentView.addChildView` 的**次序**定 —— 主进程不知道
 * 壳里两扇浮窗谁在上面。所以帧上带一格 `z`(壳里浮窗堆叠序的名次),这里按 `z`
 * 升序重排。`addChildView(view, index)` 收第二个参数(B0-④ 核过),所以重排是
 * **指名位置**,不是靠「依次重 attach 到末尾」把次序推出来。
 *
 * ## 遮挡 = 快照:先拍后藏,并且**遮挡期间按 1Hz 重拍**(§9-7 + B0-② 读数)
 *
 * Chromium 的视图永远压在 DOM 之上,不能开洞。浮窗 / 右键菜单 / 命令面板盖到浏览器
 * 那片时,治法是让主进程把视图藏起来、壳在占位格里画一张快照顶上。拍完把 PNG
 * dataURL 经推送交回壳,占位格**收到才换图** —— 在那之前画的仍然是真视图,于是最坏
 * 情况是「盖上来的那一瞬还能看见真页面」,而不是「闪一下白」。
 *
 * 顺序仍然是**先拍后藏**,但理由被 B0 的读数改小了一格:实测
 * `capturePage()` 对已经 `setVisible(false)` 的视图**照样拍得到,而且拍到的是活的**
 * (v2 写「拍不到」是猜的)。所以先拍不再是「不这样就拍不到」,而是「不这样就有一
 * 帧的空窗」—— 藏了之后那一拍要等一个 `capturePage` 的往返,占位格在那段时间里
 * 手上没有图。次序保留,判词换成真的。
 *
 * 真正被读数改掉的是另一件:**被遮期间每秒重拍一次**。隐藏的视图被 Chromium 节流到
 * 1Hz(`visibilityState=hidden`),但它**没有停** —— 视频还在放、聊天还在刷、进度条
 * 还在走。一张拍死在盖上来那一瞬的快照,盖的东西停留十秒就是一张十秒前的假页面。
 * 1Hz 正好是那个视图自己还能动的上限,重拍再密也拿不到新东西。`unocclude` /
 * `release` / `clear` 各自停表。
 *
 * 这是权宜。真解是壳里所有会盖到浏览器的弹层都做成原生视图(Flow 的
 * `portal-component-windows` 那条路),本批不走。
 *
 * ## 零 electron import(DIP)
 *
 * 宿主(`win.contentView`)与视图都是注入的结构化端口 —— 于是「z 重排的次序」
 * 与「occlude 先拍后藏」这两件真会出错的事在 vitest 里量得到。
 */

import type { NativeViewBounds, NativeViewPush } from '../native-view-protocol.js'
import type { NativeView } from './tab.js'

/** `win.contentView` 上用到的那两口。 */
export interface NativeViewHost {
  addChildView(view: NativeView, index?: number): void
  removeChildView(view: NativeView): void
}

/** 把一条推送交回渲染进程。真实现是 `webContents.send`。 */
export type NativeViewPushSink = (message: NativeViewPush) => void

export interface LayoutFrame {
  readonly viewId: string
  readonly bounds: NativeViewBounds
  readonly visible: boolean
  readonly z: number
}

interface LayoutEntry {
  view: NativeView
  bounds: NativeViewBounds
  /** 壳说它该不该看得见。 */
  visible: boolean
  /** 有东西盖在它上面 —— 壳说看得见也得藏。 */
  occluded: boolean
  z: number
}

/**
 * 被遮期间重拍的间隔。**1Hz 不是一个手感参数,是那个视图自己的上限**:Chromium 把
 * 隐藏视图(`visibilityState=hidden`)的渲染节流到每秒一帧,拍得再密也拿不到新东西。
 */
export const OCCLUDED_RESNAP_MS = 1000

/** `setBounds` 收整数 DIP;分数矩形会在占位格边上留一道缝。 */
export function roundBoundsToDip(bounds: NativeViewBounds): NativeViewBounds {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  }
}

function sameBounds(a: NativeViewBounds, b: NativeViewBounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

export class NativeViewLayout {
  isVisible(viewId: string): boolean {
    const entry = this.entries.get(viewId)
    return !!entry && entry.visible && !entry.occluded
  }
  private readonly host: NativeViewHost
  private readonly push: NativeViewPushSink
  private readonly entries = new Map<string, LayoutEntry>()
  /** 上一次排过的 z 次序,用来判「名次真的变了吗」。 */
  private order: string[] = []
  /** 被遮那几片各自的 1Hz 重拍表(见文件头)。 */
  private readonly resnapTimers = new Map<string, ReturnType<typeof setInterval>>()

  constructor(host: NativeViewHost, push: NativeViewPushSink) {
    this.host = host
    this.push = push
  }

  /**
   * 登记一片视图。**登记即入窗**(`addChildView`)但**缺省不可见** —— 壳还没报过
   * 帧,没人知道它该在哪;一片摆在 (0,0) 的白视图会盖住半个界面。
   */
  register(viewId: string, view: NativeView): void {
    if (this.entries.has(viewId)) return
    this.entries.set(viewId, {
      view,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      visible: false,
      occluded: false,
      z: 0,
    })
    this.host.addChildView(view)
    view.setVisible(false)
    this.reorder()
  }

  /** 摘掉一片视图(tab 关了)。幂等。 */
  release(viewId: string): void {
    this.stopResnap(viewId)
    const entry = this.entries.get(viewId)
    if (!entry) return
    this.entries.delete(viewId)
    try { this.host.removeChildView(entry.view) } catch { /* 窗已经没了 */ }
    this.order = this.order.filter(id => id !== viewId)
  }

  /**
   * 收一帧。没登记过的 `viewId` **静默忽略** —— 壳的 ResizeObserver 有可能比
   * 「视图建出来」早一拍到(惰性视图正是这个形),那不是错误。
   */
  applyFrame(frame: LayoutFrame): void {
    const entry = this.entries.get(frame.viewId)
    if (!entry) return
    const bounds = roundBoundsToDip(frame.bounds)
    if (!sameBounds(entry.bounds, bounds)) {
      entry.bounds = bounds
      entry.view.setBounds(bounds)
    }
    if (entry.visible !== frame.visible) {
      entry.visible = frame.visible
      this.applyVisibility(entry)
    }
    if (entry.z !== frame.z) {
      entry.z = frame.z
      this.reorder()
    }
  }

  /**
   * 有东西盖上来了:**先拍快照,再藏**,然后按 1Hz 一直重拍(见文件头)。
   *
   * 拍不到(视图刚建、页面还没画出第一帧、或者 `capturePage` 抛了)就只藏不推 ——
   * 占位格那边没收到图就继续画它自己的底,而不是画一张黑的。
   */
  async occlude(viewId: string): Promise<void> {
    const entry = this.entries.get(viewId)
    if (!entry || entry.occluded) return
    /*
     * **先记账,再拍照**(2026-09-15)。从前是拍完才写 `occluded = true`,于是拍照那
     * 几十毫秒里到的 `unocclude`(一下就松手的拖拽、一闪而过的提示条)看见的还是
     * `occluded: false`、什么都不撤;随后拍照落地,这里照旧把视图藏起来、开 1Hz 重拍
     * —— 盖的东西早走了,视图却从此藏着。所以账先立、拍完再问一次:这期间被撤了
     * (`unocclude` 把它翻回 false,或整格 `release` 了)就当这一发没发生过 ——
     * 不藏、不推图、不开表。视图在拍照期间仍然是显的,「先拍后藏」一个字没变。
     */
    entry.occluded = true
    const dataUrl = await this.snapshot(entry)
    if (this.entries.get(viewId) !== entry || !entry.occluded) return
    this.applyVisibility(entry)
    if (dataUrl) this.push({ kind: 'snapshot', viewId, dataUrl })
    this.startResnap(viewId)
  }

  /** 盖的东西走了:停表,视图回到壳说的显隐。 */
  unocclude(viewId: string): void {
    this.stopResnap(viewId)
    const entry = this.entries.get(viewId)
    if (!entry || !entry.occluded) return
    entry.occluded = false
    this.applyVisibility(entry)
  }

  /** 全摘。`dispose()` 用。 */
  clear(): void {
    for (const viewId of [...this.entries.keys()]) this.release(viewId)
  }

  private startResnap(viewId: string): void {
    if (this.resnapTimers.has(viewId)) return
    const timer = setInterval(() => { void this.resnap(viewId) }, OCCLUDED_RESNAP_MS)
    timer.unref?.()
    this.resnapTimers.set(viewId, timer)
  }

  private stopResnap(viewId: string): void {
    const timer = this.resnapTimers.get(viewId)
    if (!timer) return
    clearInterval(timer)
    this.resnapTimers.delete(viewId)
  }

  /**
   * 一发重拍。拍空 / 拍抛 **不推**也不停表:一次拍不到(页面正在换、进程忙)不等于
   * 这一格从此拍不到,占位格手上那张旧图仍然比一张黑的强。
   */
  private async resnap(viewId: string): Promise<void> {
    const entry = this.entries.get(viewId)
    if (!entry || !entry.occluded) {
      this.stopResnap(viewId)
      return
    }
    const dataUrl = await this.snapshot(entry)
    // 一个 await 之后再问一次:这中间可能已经 unocclude / release 了。
    if (!dataUrl || this.entries.get(viewId) !== entry || !entry.occluded) return
    this.push({ kind: 'snapshot', viewId, dataUrl })
  }

  private applyVisibility(entry: LayoutEntry): void {
    entry.view.setVisible(entry.visible && !entry.occluded)
  }

  private async snapshot(entry: LayoutEntry): Promise<string | undefined> {
    const wc = entry.view.webContents
    if (wc.isDestroyed()) return undefined
    try {
      const image = await wc.capturePage()
      return image.isEmpty() ? undefined : image.toDataURL()
    } catch {
      return undefined
    }
  }

  /**
   * 按 `z` 升序重排子视图 —— 名次小的先 `addChildView`,于是名次大的压在上面。
   *
   * 次序没变就什么都不做:`addChildView` 会让视图重新 attach,真机上那是一次
   * 可见的闪。判据是「排出来的 id 序列逐字相同」,不是「有没有人报过 z」。
   */
  private reorder(): void {
    const next = [...this.entries.entries()]
      .sort((a, b) => (a[1].z - b[1].z) || a[0].localeCompare(b[0]))
      .map(([viewId]) => viewId)
    if (next.length === this.order.length && next.every((id, at) => id === this.order[at])) return
    this.order = next
    // `addChildView(view, index)` 收第二个参数(B0-④ 核过),所以这里**指名位置**
    // 而不是靠「依次重 attach 到末尾」把次序推出来:后者要求遍历完整张表才成立,
    // 而且每一片都真的 detach/attach 一次(真机上是一次可见的闪)。
    next.forEach((viewId, index) => {
      const entry = this.entries.get(viewId)
      if (entry) this.host.addChildView(entry.view, index)
    })
  }
}
