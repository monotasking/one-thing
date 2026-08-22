/**
 * 外壳能力的 **web 处理者**(结构债 P4 终态批 A1-b,2026-08-23)。
 *
 * 三条里只有一条在浏览器上做得到,而且迁移前就做得到:`openExternal` 是
 * `window.open(url, '_blank', 'noopener,noreferrer')` —— 那段实现整块从
 * `platform/web.ts` 搬过来,一字未改(包括「这个浏览器没有 window.open」时那句)。
 *
 * `openPath` / `getDataPath` 没有等价物(浏览器里既没有本地路径也没有 store 根),
 * 逐字沿用迁移前那份不支持名单生成的那句。
 */
import type {
  ShellOpenExternalRequest,
  ShellRoutes,
} from '@shared/ipc/shell.js'
import { shellRouter } from '@shared/ipc/shell.js'
import { registerWebShellDomain, type WebShellRouteHandlers } from './registry'
import { webShellUnsupported } from './unsupported'

export function createShellWebShellHandlers(): WebShellRouteHandlers<ShellRoutes> {
  return {
    // `openPath` 的契约输出是一个字符串(Electron 的错误串),web 上没有这个东西 ——
    // 回的仍是迁移前那个 `{ success:false, error }`,就地断言(同 shell-web/browser.ts)。
    openPath: async () => webShellUnsupported('openPath') as unknown as string,
    openExternal: async (request: ShellOpenExternalRequest) => {
      if (typeof window === 'undefined' || typeof window.open !== 'function') {
        return {
          success: false,
          error: 'Opening external URLs is not available in this browser.',
        }
      }
      window.open(request?.url ?? '', '_blank', 'noopener,noreferrer')
      return { success: true }
    },
    getDataPath: async () => webShellUnsupported('getDataPath') as unknown as string,
  }
}

export function registerShellWebShellDomain(): () => void {
  return registerWebShellDomain(shellRouter, createShellWebShellHandlers())
}
