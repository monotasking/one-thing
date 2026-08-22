/**
 * 本文件在 P4 终态批 C2 之后只剩**三件要 Electron 本体的事的注入**加**一条推送**:
 *
 * 十九条数据面(目录读/启停/刷新、命令表与执行、统一请求通道与取消、配置读写、
 * 足迹与卸载、npm 生命周期四条、装前预读、市场、file-pick)已整只迁到通用 RPC
 * 通道(`@shared/ipc/plugins.ts` 的 `pluginsRouter` +
 * `packages/backend/rpc/domains/plugins.ts`),桌面和 web 走同一条 dispatch。
 * 那只 portable 工厂(`apps/electron/src/ipc/plugins.ts`)整只删掉了。
 *
 * 留在这里的:
 *  - `configurePluginsHost` —— 原生文件对话框(`pickFile`)与插件命令的子进程
 *    执行器(`execCommand`,execa 是桌面这棵树的依赖)。两件的实现都在
 *    `@onething/electron-host/plugins/ipc-host`,这里只做注入。
 *  - `configurePluginRequestProgressBroadcaster` —— `PLUGINS_REQUEST_PROGRESS`
 *    的**定向回送**(router 没有推送面)。「谁在问」由 `@main/ipc/rpc.ts` 从
 *    `event.sender.id` 铸进 `RpcDispatchContext.callerId`,域处理者原样递回来。
 *    **不能退化成全窗广播**:设置窗是独立 BrowserWindow(R3 插件设置 UI 的宿主),
 *    广播出去等于每扇窗都收一份别人的进度。
 *
 * 另一条推送 `PLUGINS_NOTIFICATION` 连注入都不用:它是总线上的全局事件,
 * 由 IPCBridge 扇给所有窗,从头到尾不经过请求面。
 *
 * `createGatewayPluginCommandProvider` 留在这里**不是 IPC** —— 它是网关的命令
 * 提供者,由 `app/main-process.ts` 在 `configureGatewayLifecycle` 里递进去。
 * 它的两件事(列命令 / 执行一条)已经和域共用装配层那份接线
 * (`@onething/backend/wiring/plugins/commands`),不再各写一份。
 */
import type { GatewayCommandProvider } from '@onething/gateway'
import {
  execPluginCommandOnDesktop,
  pickPluginFileForCaller,
  sendPluginRequestProgressToCaller,
} from '@onething/electron-host/plugins/ipc-host'
import { IPC_CHANNELS } from '@shared/ipc.js'
import {
  executePluginCommandOnHost,
  listPluginCommandsForGateway,
} from '@onething/backend/wiring/plugins/commands.js'
import { configurePluginRequestProgressBroadcaster } from '@onething/backend/wiring/plugins/events.js'
import { configurePluginsHost } from '@onething/backend/wiring/plugins/host-ports.js'
import { getLogger } from '@onething/backend/wiring/logging/index.js'

const log = getLogger('ipc.plugins')

export function createGatewayPluginCommandProvider(): GatewayCommandProvider {
  return {
    async listCommands() {
      const result = await listPluginCommandsForGateway()
      return result.success ? result.commands : []
    },
    executeCommand(request) {
      return executePluginCommandOnHost({
        commandName: request.command.name,
        args: request.args,
        sessionId: request.sessionId,
      })
    },
  }
}

export function registerPluginHandlers(): void {
  configurePluginsHost({
    /**
     * `file-pick` 的一次导入(B 期,用户壁纸)。
     *
     * 全程在主进程:对话框 → 闸 → 拷贝 → 返回一个 `storage:` 地址。
     * renderer 收到的是地址,插件收到的也是地址 —— **字节两边都不过手**。
     *
     * 手势锚定是天然的:原生对话框只能由用户那一次点击拉起来。这里不需要
     * (也无法伪造)一个 `userGesture` 布尔。
     */
    pickFile: (request, callerId) => pickPluginFileForCaller(request, callerId),
    execCommand: (command, args, options) =>
      execPluginCommandOnDesktop(command, args, options),
  })

  configurePluginRequestProgressBroadcaster((progress, callerId) => {
    sendPluginRequestProgressToCaller(
      IPC_CHANNELS.PLUGINS_REQUEST_PROGRESS,
      progress,
      callerId,
      error => log.warn('request progress send failed', { likelyCause: 'window closed' }, error),
    )
  })

  log.info('handlers registered')
}
