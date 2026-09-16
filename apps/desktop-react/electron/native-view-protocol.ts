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

/**
 * **应用菜单表**(K4)——命令表的一次投影,**纯数据**。
 *
 * ## 为什么菜单是渲染进程算的
 *
 * 三件东西主进程都没有:**字典**(`labelKey` → 人话,i18n 住在渲染层)、**有效键**
 * (用户覆盖 ▷ 键位组 ▷ 出厂表,三层都在渲染进程的 store 里)、**此刻谁答得出**
 * (活动路径是 `focus/` 那棵树)。主进程要是自己算,这三样就各有第二个产地 ——
 * 而 K4 的正题恰恰是「设置页 / 菜单栏 / 保留表三处只有一个产地」。
 * 所以主进程只做一件事:**把这张表画成 `Menu`**。
 *
 * ## 键写成 `chord` 串,不是 Electron 的 accelerator
 *
 * 串那一份规范住在 `keymap/chord.ts`(与下沉的保留键表逐字同一套写法,两端已经
 * 对了一年)。换成 accelerator 语法就是让渲染进程认识 Electron ——
 * 翻译那一步归主进程(`app-menu.ts` 的 `acceleratorOfChord`)。
 *
 * ## `enabled` 是事实,不是样式
 *
 * 它的判据与派发器逐字相同(`focus/transitions.routeCommand`):此刻活动路径上
 * 有人答得出,或者这条命令有应用层兜底。画灰的那一项按下去本来也不会有事发生
 * —— 菜单只是**投影**,不是第二条键盘路。
 */
export interface AppMenuItemSpec {
  /** 命令 id(渲染进程的 `CommandId`;这条通道上它只是一个串,主进程不解释它)。 */
  readonly id: string
  /** 已经翻好的人话。主进程没有字典。 */
  readonly label: string
  /** `cmd+shift+f` 那种规范串;没绑键就是 null。 */
  readonly chord: string | null
  /** 此刻答得出吗(判据见上)。false = 画灰。 */
  readonly enabled: boolean
}

export interface AppMenuSection {
  /** 这一节在菜单栏上的名字(已翻好)。 */
  readonly label: string
  readonly items: readonly AppMenuItemSpec[]
}

export interface AppMenuSpec {
  readonly sections: readonly AppMenuSection[]
}

/** 一片原生视图此刻该在哪、看不看得见、压在第几层。 */
export interface NativeViewBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** A popup is a presentation of renderer-owned actions, never a second executor. */
export type NativePopupItem =
  | { readonly type: 'separator' }
  | { readonly type: 'item'; readonly id: string; readonly label: string; readonly enabled: boolean }

export interface NativePopupSpec {
  readonly requestId: string
  readonly x: number
  readonly y: number
  readonly items: readonly NativePopupItem[]
}

/**
 * 渲染进程 → 主进程。
 *
 * `frame` 由占位格的 ResizeObserver 按 rAF 合批发出;其余请求是离散动作。
 * 同一条通道用 `verb` 区分动作 —— 见文件头。
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
  | { readonly verb: 'focus'; readonly viewId: string; readonly revision?: number }
  /** A newer DOM focus intent cancels pending native focus. */
  | { readonly verb: 'focus-shell'; readonly revision: number }
  | ({ readonly verb: 'popup' } & NativePopupSpec)
  | { readonly verb: 'popup-close'; readonly requestId: string }
  /**
   * 「已绑定的组合键」全表(全局命令 ∪ 该作用域的局部键),规范化成
   * `ctrl+shift+p` 这种串。主进程给每片视图挂 `before-input-event`:在表里的
   * 组合键 `preventDefault()` 并经 `key` 推回渲染进程照常派发,不在表里的归页面。
   *
   * 整表覆盖而不是增量:键位可以在设置里改绑,一份全表比一串增删更难对错。
   *
   * **K4 起同一条帧还捎着菜单表**(`menu`)。两件事共用一个动词而不是各占一条,
   * 理由是它们**同源同时**:两张表都是命令表的投影,改绑一次两张一起变,
   * 分成两条只会让「这一拍哪张新哪张旧」变成一个真问题。`menu` 可缺席 ——
   * 缺席的意思是「这一帧没说菜单」(主进程保留上一份),不是「菜单是空的」。
   */
  | { readonly verb: 'keymap'; readonly chords: readonly string[]; readonly menu?: AppMenuSpec }
  /**
   * 在这片视图里找一个词(B3-a)。
   *
   * ── 它为什么在**这条**通道上,而不是一条读法 / 一条做法 ──────────────────
   * 查找是**视图状态**,不是这格资源的事实(方案 §6「只有拿着鼠标的人才有这个
   * 动作」):它没有结局、不该落审计、AI 要在页面里找东西走的是 `page` 那条读法
   * (整篇正文交给它,它自己会读)。把它做成 `browser:` 的一条做法,等于在模型
   * 面上多一件它永远不该用的东西,而每一件这样的东西都要在权限、审计、事件三处
   * 各占一格。所以它与 `frame` / `occlude` / `focus` 同族:壳里那块面的显隐几何
   * 归这条通道,**钉数不涨**(帧带 `viewId`,主进程按 id 路由)。
   *
   * ── 为什么没有「这是不是同一个词」那一格 ────────────────────────────────
   * `webContents.findInPage` 的 `findNext` 说的是「接着上次往下找」还是「从头
   * 重找」。那个判据是**「词变了没有」**,而记得上一个词的是主进程(它才是那台
   * 查找器的持有者)。让壳报一格 `again: boolean` 就是让同一个判据有两个产地 ——
   * 壳只要在 `onChange` 与 ↵ 两条路上写错一处,手感就分叉。所以壳只说「找这个词,
   * 往哪个方向」,同不同是主进程自己比出来的。
   */
  | { readonly verb: 'find'; readonly viewId: string; readonly text: string; readonly forward: boolean }
  /** 收起查找:清掉高亮与选区。壳那一行关掉、这一格 tab 的视图摘掉时各发一次。 */
  | { readonly verb: 'findStop'; readonly viewId: string }

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
  | { readonly kind: 'focus'; readonly viewId: string; readonly revision?: number }
  | { readonly kind: 'blur'; readonly viewId: string }
  /**
   * 一次查找的读数(B3-a)。`active` 是**从 1 起**的当前命中序号(Chromium 的
   * `activeMatchOrdinal` 原样),`total` 是总命中数;一处都没有时两格都是 0。
   *
   * 口径原样带出来而不是在这里折成 0 起:折了之后「壳算错了」与「Chromium 报的
   * 就是这个数」再也分不开,而这条通道的职责是**转述**,不是解释。
   */
  | { readonly kind: 'find'; readonly viewId: string; readonly active: number; readonly total: number }
  /**
   * **菜单栏上点了一项**(K4)。
   *
   * 它是这条通道上**唯一不带 `viewId`** 的一推 —— 菜单不属于任何一片视图,它属于
   * 这扇窗。走这条通道而不是新开一条,理由与 `keymap` 那条动词同族:菜单表是从
   * 这条通道下去的,点击的回程走同一条才只有一个词汇表(而 `transport:gate`
   * 钉着 ipcMain 的条数 —— 那把尺子数的是 `ipcMain.handle/on`,这一推不占它)。
   *
   * 收它的那一侧把它交给壳里**唯一那个派发器**(`focus/dispatch.ts` 的
   * `dispatchHostCommand`),与页面里截下来的那一下按键(`kind: 'key'`)同一条路:
   * 局部先接、没接住才应用层兜底。**菜单不是第二条键盘路**。
   */
  | { readonly kind: 'command'; readonly id: string }
  /**
   * **这扇窗真的失焦了**(2026-09-15)。渲染进程自己的 DOM `blur` 说的是 webContents
   * 失焦 —— 焦点在壳与原生视图之间换手时它也响,而窗口并没有失去 key 状态。
   * 只有 `BrowserWindow` 的 `blur` 是「用户离开了这扇窗」,由主进程推;
   * 接的人是 `content/native-view/window-focus-downlink.ts`(判词在 `focus/window-focus.ts`)。
   */
  | { readonly kind: 'window-blur' }
  | { readonly kind: 'popup-result'; readonly requestId: string; readonly itemId?: string }

/** preload 挂出来的那两口(`window.onethingHost.nativeView`)。 */
export interface NativeViewBridge {
  /** Capability negotiation also permits a renderer to outlive an older main process. */
  readonly nativePopup?: boolean
  send(message: NativeViewRequest): void
  /** 返回退订。订阅者卸载时必须调用,否则重挂之后旧回调还挂在 ipcRenderer 上。 */
  on(handler: (message: NativeViewPush) => void): () => void
}
