/**
 * `shell` 域 —— 把一个网址交给系统浏览器、用默认程序打开一个本地路径、问 store 根在哪。
 *
 * 契约 `@shared/ipc/shell.ts` 立于 A1-b,那时走 Vue 壳的 `shell:invoke`;Vue 宿主 09-04
 * 退役后它一直**没有处理者**。批 1(`docs/design/provider-settings-rework-2026-09.md` §3.1)
 * 让 React 壳注入 `shell` 宿主口,于是这件能力改走通用 RPC —— 同 `dialog` 域的判例:
 * 处理者住装配层,真正的那一下由宿主经 `configureShellHost` 递进来
 * (`@onething/backend/shell/shell-host-ports`);没注入的宿主拿到结构化失败。
 *
 * 两道闸,理由各一句:
 *  - **只有本机可信的宿主面才替调用方动这台机器**(`isHostLocallyTrusted()`)。
 *    打开路径 = 用默认程序执行一个本地文件,打开网址 = 在这台机器上拉起浏览器;
 *    一个不可信的远端调用方两件都不该做得成。
 *  - **网址只放行 http(s) 与 mailto**。`file:` / 自定义 scheme 会拉起本机程序,
 *    那是 `openPath` 的事,不该借 `openExternal` 这扇门进来。宿主口自己也拒一遍
 *    (`apps/desktop-react/electron/host-ports.ts`),两层各守各的。
 */
import { getOnethingStorePath } from '@onething/backend/storage'
import { getShellHost } from '@onething/backend/shell/shell-host-ports'
import { shellRouter, type ShellRoutes } from '@shared/ipc/shell.js'
import { isHostLocallyTrusted } from '@onething/backend/http-server/http-server-host-trust.js'
import { defineClientApi, type RpcRouteHandlers } from '@onething/backend/http-server/http-server-dispatch-table.js'

const NOT_TRUSTED = 'shell actions are only available to a locally trusted host'
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

/** 这个网址能不能交给系统浏览器。不能 → 回一句为什么;能 → `null`。 */
export function externalUrlProblem(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim()) return 'url is required'
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'url is not a valid absolute URL'
  }
  if (!EXTERNAL_SCHEMES.has(parsed.protocol)) return `scheme ${parsed.protocol} is not allowed`
  return null
}

export const shellRpcHandlers: RpcRouteHandlers<ShellRoutes> = {
  async openExternal(request) {
    if (!isHostLocallyTrusted()) return { success: false, error: NOT_TRUSTED }
    const problem = externalUrlProblem(request?.url)
    if (problem) return { success: false, error: problem }
    return getShellHost().openExternal(request.url)
  },
  async openPath(request) {
    if (!isHostLocallyTrusted()) return NOT_TRUSTED
    const filePath = typeof request?.filePath === 'string' ? request.filePath : ''
    if (!filePath) return 'filePath is required'
    return getShellHost().openPath(filePath)
  },
  async getDataPath() {
    // 本机绝对路径:不可信的调用方拿空串(同 mcp / settings 两域对路径的出界脱敏口径)。
    return isHostLocallyTrusted() ? getOnethingStorePath() : ''
  },
}

/** 名册 `http-server/http-server-client-api-roster.ts` 里的一行:域 `shell` 的契约与处理者。 */
export const SHELL_CLIENT_API = defineClientApi({ id: 'rpc:shell', router: shellRouter, handlers: shellRpcHandlers })
