/**
 * `dialog` 域 —— 原生打开对话框(选目录 / 选文件)。
 *
 * 契约 `@shared/ipc/dialog.ts` 早就立着(从前走 Vue 壳的 `shell:invoke`,随它一起没了
 * 处理者)。React 壳的渲染层只走 HTTP/SSE,所以这件宿主能力改走通用 RPC:处理者住在
 * 装配层,真正拉起对话框的那一下由宿主经 `dialog` 端口递进来
 * (`@onething/backend/dialog/host-ports`)。没注入的宿主答 `unavailable: true`,客户端退到路径输入框。
 */
import { dialogRouter, type DialogRoutes } from '@shared/ipc/dialog.js'
import { showOpenDialogViaHost } from '@onething/backend/dialog/host-ports'
import { defineClientApi, type RpcRouteHandlers } from '@onething/backend/http-server/http-server-dispatch-table.js'

export const dialogRpcHandlers: RpcRouteHandlers<DialogRoutes> = {
  async showOpen(request) {
    return showOpenDialogViaHost(request ?? {})
  },
}

/** 名册 `http-server/http-server-client-api-roster.ts` 里的一行:域 `dialog` 的契约与处理者。 */
export const DIALOG_CLIENT_API = defineClientApi({ id: 'rpc:dialog', router: dialogRouter, handlers: dialogRpcHandlers })
