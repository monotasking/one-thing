/**
 * `host:native-view` —— 渲染进程与主进程之间**唯一**那条原生视图管道的词汇表。
 *
 * ## 为什么它住在 `electron/` 而不是 `electron/browser/`
 *
 * 这条通道与浏览器无关。它回答的是「壳里那片叶此刻的矩形、显隐、堆叠序是多少」,
 * 而答得上这句话的将来会有好几种视图(方案 §7 演练乙的 PDF 阅读器是第一个排队的)。
 * 帧上带 `viewId`,主进程按 id 路由 —— 所以**钉数不再涨**:第二种原生视图不会
 * 长出第二条 IPC,它只会多几个 id。把词汇表放进 `browser/` 就是在教下一个人
 * 「原生视图 = 浏览器」,那正是「按能力枚举」的形状。
 *
 * ## 为什么它不在 `@shared/ipc`
 *
 * `@shared/ipc` 是**跨进程数据面**的契约(RPC 信封、会话事件);这一条是**窗口系统**
 * 的管道 —— 它只在这一个 Electron 壳里成立(`--mode web` 没有主进程,这条通道
 * 整条不存在),server / CLI 永远不会读它。判据与 `host:connection` /
 * `host:fullscreen` 同族:宿主自己的两端,词汇表就住在宿主自己的树里。
 *
 * ## 单位
 *
 * `bounds` 是 **DIP(= CSS px)**。两者相等的前提是渲染进程缩放因子为 1 —— 今天
 * 壳里零处 `setZoomFactor`(方案 §9-10 核过)。将来谁加 ⌘+/− 缩放,要在**发帧那
 * 一侧**乘回去,不是在这里改单位:主进程收到的永远是 DIP。
 *
 * 零运行时依赖(纯类型 + 一个字面量常量),所以 preload(Electron sandbox 上下文)、
 * 主进程、渲染层三边都 import 得起。
 */

/** 通道名。preload 与主进程各 import 这一个常量,不各写一遍字面量。 */
export const NATIVE_VIEW_CHANNEL = 'host:native-view'

/** 一片原生视图此刻该在哪、看不看得见、压在第几层。 */
export interface NativeViewBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * 渲染进程 → 主进程。
 *
 * `frame` 由占位格的 ResizeObserver 按 rAF 合批发出;其余四条是离散动作。
 * 一条通道一个 `verb`,而不是四条通道 —— 见文件头。
 */
export type NativeViewRequest =
  /** 这片叶此刻的几何与堆叠序。 */
  | { readonly verb: 'frame'; readonly viewId: string; readonly bounds: NativeViewBounds; readonly visible: boolean; readonly z: number }
  /**
   * 有东西盖上来了。主进程**先拍快照再藏**(方案 §9-7:`capturePage` 对已经
   * `setVisible(false)` 的视图拍不到),拍完把 PNG 经 `snapshot` 推回来。
   */
  | { readonly verb: 'occlude'; readonly viewId: string }
  /** 盖的东西走了。 */
  | { readonly verb: 'unocclude'; readonly viewId: string }
  /** 树把焦点交给了这片叶(开 tab、点瓦、规则 2)。 */
  | { readonly verb: 'focus'; readonly viewId: string }
  /**
   * 「已绑定的组合键」全表(全局命令 ∪ 该作用域的局部键),规范化成
   * `ctrl+shift+p` 这种串。主进程给每片视图挂 `before-input-event`:在表里的
   * 组合键 `preventDefault()` 并经 `key` 推回渲染进程照常派发,不在表里的归页面。
   *
   * 整表覆盖而不是增量:键位可以在设置里改绑,一份全表比一串增删更难对错。
   */
  | { readonly verb: 'keymap'; readonly chords: readonly string[] }

/**
 * 主进程 → 渲染进程(`webContents.send`,**不占** `transport:gate` 的 ipcMain 钉数
 * —— 那把尺子数的是 `ipcMain.handle/on`;`host:fullscreen` 是同一个先例)。
 */
export type NativeViewPush =
  /** 遮挡快照。占位格收到才换图 —— 在那之前画的仍然是真视图。 */
  | { readonly kind: 'snapshot'; readonly viewId: string; readonly dataUrl: string }
  /** 一次被主进程截下来的组合键,交还给渲染进程那**唯一**的派发器。 */
  | { readonly kind: 'key'; readonly viewId: string; readonly key: string; readonly code: string; readonly modifiers: readonly string[] }
  /** 页面自己拿到 / 失去了键盘焦点。 */
  | { readonly kind: 'focus'; readonly viewId: string }
  | { readonly kind: 'blur'; readonly viewId: string }

/** preload 挂出来的那两口(`window.onethingHost.nativeView`)。 */
export interface NativeViewBridge {
  send(message: NativeViewRequest): void
  /** 返回退订。订阅者卸载时必须调用,否则重挂之后旧回调还挂在 ipcRenderer 上。 */
  on(handler: (message: NativeViewPush) => void): () => void
}
