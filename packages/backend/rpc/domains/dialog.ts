/**
 * `dialog` 域 —— 原生打开对话框(选目录 / 选文件)。
 *
 * 契约 `@shared/ipc/dialog.ts` 早就立着(从前走 Vue 壳的 `shell:invoke`,随它一起没了
 * 处理者)。React 壳的渲染层只走 HTTP/SSE,所以这件宿主能力改走通用 RPC:处理者住在
 * 装配层,真正拉起对话框的那一下由宿主经 `dialog` 端口递进来
 * (`@onething/runtime/dialog/host-ports`)。没注入的宿主答 `unavailable: true`,客户端退到路径输入框。
 */
import type { DialogRoutes } from '@shared/ipc/dialog.js'
import { showOpenDialogViaHost } from '@onething/runtime/dialog/host-ports'
import type { RpcRouteHandlers } from '../registry.js'

export const dialogRpcHandlers: RpcRouteHandlers<DialogRoutes> = {
  async showOpen(request) {
    return showOpenDialogViaHost(request ?? {})
  },
}
