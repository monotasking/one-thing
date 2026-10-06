/**
 * React 壳的 preload —— 三条 `invoke` / `send` 口:`host:connection`(连哪台后端)、`host:native-view`
 * (窗口系统给原生视图的管道)、`host:client-action`(第④步批 1:只在用户屏幕上发生的事 —— 原生对话框、
 * 打开外链、打开路径、在访达中显示;契约 `@shared/contracts/client-action`)。三条都不是数据通道,
 * 数据只走 HTTP/SSE。
 *
 * 刻意不叫 `electronAPI`:那个名字是旧 Vue 壳的桥,`packages/renderer/platform/index.ts`
 * 见到它就会切到 Electron 传输面(旧壳那张表)。新壳走的是 HTTP/SSE,所以这里挂的是
 * `onethingHost`,渲染层照旧解析到 web 传输面,只是基址与 token 由这一条口交过去。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { NATIVE_VIEW_CHANNEL } from './native-view-protocol.js'
import { CLIENT_ACTION_CHANNEL, type ClientActionBridge } from '@shared/contracts/client-action'
import type { NativeViewBridge, NativeViewPush, NativeViewRequest } from './native-view-protocol.js'

export type { NativeViewBridge, NativeViewPush, NativeViewRequest }

export type HostConnectionResult =
  | { ok: true; baseUrl: string; token?: string }
  | { ok: false; error: string }

const clientAction: ClientActionBridge = action => ipcRenderer.invoke(CLIENT_ACTION_CHANNEL, action)

contextBridge.exposeInMainWorld('onethingHost', {
  getConnection: (): Promise<HostConnectionResult> => ipcRenderer.invoke('host:connection'),
  /**
   * **只在用户屏幕上发生的事**(第④步批 1,决策 D5 / D278)。主进程逐格校验(`./client-action.ts`),
   * 渲染层只经 `src/platform/host.ts` 那几只函数用它 —— 浏览器壳没有这一格,判据就是它在不在。
   */
  clientAction,
  /**
   * 这扇窗跑在哪个平台上。**一个事实,不是一个结论**(W1-b)。
   *
   * 渲染层要答的问题是「顶栏左端要不要给红绿灯让位」,而那件事在 macOS 之外
   * 根本不存在:`electron/main.ts` 的 `FRAMELESS_ON_MAC` 只在 darwin 上摘系统
   * 标题栏,Windows / Linux 照旧用系统边框,壳里那条顶带上一颗灯都没有。
   * 判断留在渲染层(`components/useHostTrafficLights.ts`),这里只交平台名 ——
   * 交结论的话,下一个想问平台的人就得再开一条口。
   *
   * 为什么不让渲染层读 `navigator.platform`:那是 UA 的一部分(会被伪装、已弃用),
   * 而且它答的是「用户的操作系统」而非「这扇窗有没有灯」—— macOS 上开着的
   * **浏览器壳**会被它判成有灯,正好判反。这一格只有宿主答得对。
   */
  platform: process.platform,
  /**
   * 「此刻是不是 macOS 原生全屏」。**渲染层自己看不见这件事** —— 真机实测
   * `matchMedia('(display-mode: fullscreen)')` 恒 false、`document.fullscreenElement`
   * 恒 null,只有 `innerHeight` 会变(而那个数当判据是错的:手动拉到可用高度
   * 一样命中)。所以由窗口自己说,主进程在 enter/leave-full-screen 与
   * `did-finish-load`(首帧对齐)三处推。
   *
   * 通道名与 `electron/main.ts` 的 `HOST_FULLSCREEN_CHANNEL` 是同一个字面量
   * (两个打包目标,import 不到对方)。返回退订函数:订阅者卸载时必须调用,
   * 否则热更/重挂之后旧回调还挂在 ipcRenderer 上。
   */
  onFullScreenChange: (handler: (fullScreen: boolean) => void): (() => void) => {
    const listener = (_event: unknown, fullScreen: boolean) => handler(fullScreen)
    ipcRenderer.on('host:fullscreen', listener)
    return () => { ipcRenderer.removeListener('host:fullscreen', listener) }
  },
  /**
   * **原生视图**那条管道(`host:native-view`)。词汇表在
   * `electron/native-view-protocol.ts` —— 主进程、preload、渲染层三边共用一份,
   * 而不是各写一遍字面量。
   *
   * 它与浏览器无关:帧上带 `viewId`,主进程按 id 路由,第二种原生视图(PDF 阅读器)
   * 复用同一条通道。所以这一格叫 `nativeView` 而不是 `browser`。
   *
   * **`send` 而不是 `invoke`**:五个动词没有一个要回执(`frame` 是每帧都在发的,
   * 要回执就是每帧一次 Promise 往返;`occlude` 的回执是那张 `snapshot` 推送)。
   * 主进程那一侧因此是 `ipcMain.on`,`transport:gate` 的钉数 1 → 2,基线文件那一行
   * 写明理由。
   *
   * `on` 返回退订,形与 `onFullScreenChange` 逐字相同:订阅者卸载时必须调用,
   * 否则热更 / 重挂之后旧回调还挂在 ipcRenderer 上。
   */
  nativeView: {
    nativePopup: true,
    send: (message: NativeViewRequest): void => { ipcRenderer.send(NATIVE_VIEW_CHANNEL, message) },
    on: (handler: (message: NativeViewPush) => void): (() => void) => {
      const listener = (_event: unknown, message: NativeViewPush) => handler(message)
      ipcRenderer.on(NATIVE_VIEW_CHANNEL, listener)
      return () => { ipcRenderer.removeListener(NATIVE_VIEW_CHANNEL, listener) }
    },
  } satisfies NativeViewBridge,
})
