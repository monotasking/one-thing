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
})
