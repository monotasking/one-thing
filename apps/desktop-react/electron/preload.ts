/**
 * React 壳的 preload —— 全部内容就是**一条**通道。
 *
 * 刻意不叫 `electronAPI`:那个名字是旧 Vue 壳的桥,`packages/renderer/platform/index.ts`
 * 见到它就会切到 Electron 传输面(旧壳那张表)。新壳走的是 HTTP/SSE,所以这里挂的是
 * `onethingHost`,渲染层照旧解析到 web 传输面,只是基址与 token 由这一条口交过去。
 */
import { contextBridge, ipcRenderer } from 'electron'

export type HostConnectionResult =
  | { ok: true; baseUrl: string; token?: string }
  | { ok: false; error: string }

contextBridge.exposeInMainWorld('onethingHost', {
  getConnection: (): Promise<HostConnectionResult> => ipcRenderer.invoke('host:connection'),
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
})
