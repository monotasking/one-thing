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
