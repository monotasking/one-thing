/**
 * 桌面(Electron)宿主的能力表 —— 一份**静态事实**,不问服务器。
 *
 * C2 从 `platform/electron.ts` 抽到这只单独的文件里,理由只有一条:
 * `platform/client.ts` 造 IPC 传输时要把它递给 `Transport.capabilities()`,
 * 而 `platform/electron.ts` 反过来要 `client.ts` 的 `clientApi` ——
 * 留在原处就是一条模块环。表的内容一位没改。
 */
import type { PlatformCapabilities } from './types'

export const ELECTRON_HOST_CAPABILITIES: PlatformCapabilities = {
  localFileSystem: true,
  workspaceFileSystem: true,
  nativeWindowControls: true,
  shellTools: true,
  terminal: true,
  embeddedBrowser: true,
  collabRooms: true,
  music: true,
  interactionRespond: true,
  evals: true,
  pluginsManage: true,
  clipboardWrite: true,
  desktopWindows: true,
  globalMenuEvents: true,
}
