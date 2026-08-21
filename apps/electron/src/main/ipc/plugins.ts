/**
 * Plugin IPC Handlers
 *
 * Bridges the renderer (Settings UI) to the PluginManager in the main process.
 */

import type {
  PluginConfigRequest,
  SetPluginConfigRequest,
  UninstallPluginRequest,
  InstallPluginRequest,
  UpdatePluginRequest,
} from '@shared/ipc/plugins.js'
import { createPluginConfigAccess } from '@onething/app/plugins/config-access.js'
import {
  registerElectronPluginsIpcHandlers,
  type ElectronPluginAbortRequestPayload,
  type ElectronPluginExecuteCommandRequest,
  type ElectronPluginRequestPayload,
  type ElectronPluginToggleRequest,
} from '@onething/electron-host/ipc/plugins'
import {
  abortOnethingPluginRequestForIpc,
  getOnethingPluginMarketForIpc,
  disableOnethingPluginForIpc,
  getOnethingPluginConfigForIpc,
  getOnethingPluginFootprintForIpc,
  setOnethingPluginConfigForIpc,
  uninstallOnethingPluginForIpc,
  installOnethingPluginForIpc,
  updateOnethingPluginForIpc,
  checkOnethingPluginUpdatesForIpc,
  enableOnethingPluginForIpc,
  handleOnethingPluginRequestForIpc,
  executeOnethingPluginCommandForIpc,
  getOnethingPluginLifecycleInfoForIpc,
  type ListOnethingPluginCommandsForIpcResult,
  listOnethingPluginCommandsForIpc,
  listOnethingPluginCommandsForIpcAllowingUninitialized,
  listOnethingPluginsForIpc,
  refreshOnethingPluginsForIpc,
} from '@onething/runtime/plugins'
import type { GatewayCommandProvider } from '@onething/gateway'
import { pickPluginFileOnDesktop } from '@onething/electron-host/plugins/file-pick'
import { IPC_CHANNELS } from '@shared/ipc.js'
import { getPluginManager } from '@onething/app/plugins/index.js'
import { clearPluginRuntimeHealth } from '@onething/app/plugins/health.js'
import { getPluginFootprint } from '@onething/app/plugins/loader.js'
import { getPluginBackgroundParams } from '@onething/app/plugins/background.js'
import { getPluginMarketIndexSnapshot, probePluginNpmAvailability } from '@onething/app/plugins/install.js'
import { readPluginTarballSummary } from '@onething/app/plugins/tarball.js'
import { getPluginAppVersion } from '@onething/app/plugins/app-version.js'
import { getEventBus } from '@onething/app/events/index.js'
import * as store from '@onething/app/store.js'
import { getLogger } from '@onething/app/logging/index.js'

const log = getLogger('ipc.plugins')

export function createGatewayPluginCommandProvider(): GatewayCommandProvider {
  return {
    async listCommands() {
      const result = await listPluginCommandsForGateway()
      return result.success ? result.commands : []
    },
    executeCommand(request) {
      return executePluginCommand({
        commandName: request.command.name,
        args: request.args,
        sessionId: request.sessionId,
      })
    },
  }
}

async function listPluginCommandsForGateway(): Promise<ListOnethingPluginCommandsForIpcResult> {
  return listOnethingPluginCommandsForIpcAllowingUninitialized({
    manager: getPluginManager(),
    logger: console,
  })
}

function executePluginCommand(request: ElectronPluginExecuteCommandRequest) {
  const eventBus = getEventBus()
  return executeOnethingPluginCommandForIpc({
    manager: getPluginManager(),
    commandName: request.commandName,
    args: request.args,
    sessionId: request.sessionId,
    getSession: sessionId => store.getSession(sessionId),
    emitSessionCommand: (sessionId, event) => eventBus.emit(sessionId, event),
    emitGlobalEvent: event => eventBus.emitGlobal(event),
    async exec(commandToRun, args = [], options) {
      const { execa } = await import('execa')
      try {
        const result = await execa(commandToRun, args, {
          cwd: options.cwd,
          reject: false,
        })
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode ?? 0,
        }
      } catch (error: any) {
        return {
          stdout: error.stdout || '',
          stderr: error.stderr || error.message || '',
          exitCode: error.exitCode ?? 1,
        }
      }
    },
    onEmitError(label, error) {
      log.error('plugin event emit failed', { label }, error)
    },
    logger: console,
  })
}

const pluginConfigAccess = createPluginConfigAccess()

export function registerPluginHandlers(): void {
  registerElectronPluginsIpcHandlers({
    channels: {
      list: IPC_CHANNELS.PLUGINS_LIST,
      enable: IPC_CHANNELS.PLUGINS_ENABLE,
      disable: IPC_CHANNELS.PLUGINS_DISABLE,
      refresh: IPC_CHANNELS.PLUGINS_REFRESH,
      commands: IPC_CHANNELS.PLUGINS_COMMANDS,
      executeCommand: IPC_CHANNELS.PLUGINS_EXECUTE_COMMAND,
      request: IPC_CHANNELS.PLUGINS_REQUEST,
      abortRequest: IPC_CHANNELS.PLUGINS_REQUEST_ABORT,
      configGet: IPC_CHANNELS.PLUGINS_CONFIG_GET,
      configSet: IPC_CHANNELS.PLUGINS_CONFIG_SET,
      uninstall: IPC_CHANNELS.PLUGINS_UNINSTALL,
      footprint: IPC_CHANNELS.PLUGINS_FOOTPRINT,
      install: IPC_CHANNELS.PLUGINS_INSTALL,
      update: IPC_CHANNELS.PLUGINS_UPDATE,
      checkUpdates: IPC_CHANNELS.PLUGINS_CHECK_UPDATES,
      lifecycleInfo: IPC_CHANNELS.PLUGINS_LIFECYCLE_INFO,
      readTarball: IPC_CHANNELS.PLUGINS_READ_TARBALL,
      market: IPC_CHANNELS.PLUGINS_MARKET,
      pickFile: IPC_CHANNELS.PLUGINS_PICK_FILE,
    },
    /**
     * `file-pick` 的一次导入(B 期,用户壁纸)。
     *
     * 全程在主进程:对话框 → 闸 → 拷贝 → 返回一个 `storage:` 地址。
     * renderer 收到的是地址,插件收到的也是地址 —— **字节两边都不过手**。
     *
     * 手势锚定是天然的:原生对话框只能由用户那一次点击拉起来。这里不需要
     * (也无法伪造)一个 `userGesture` 布尔。
     */
    pickPluginFile: (request, sender) => pickPluginFileOnDesktop(request, sender),
    listPlugins: () => {
      return listOnethingPluginsForIpc({
        manager: getPluginManager(),
        logger: console,
        // 设置页从列表一次拿全配置材料(字段表 + 当前值),不必逐插件再问一轮。
        getPluginConfig: pluginConfigAccess.read,
        // G 期(L2.5):背景层的运行期调参是内存态,只有桌面宿主有它 ——
        // 方案 A 下只有这一个宿主执行插件代码,也就只有这里存在 updateBackground。
        getPluginBackgroundParams: getPluginBackgroundParams,
      })
    },
    enablePlugin: (request: ElectronPluginToggleRequest) => {
      return enableOnethingPluginForIpc({
        manager: getPluginManager(),
        pluginId: request.pluginId,
        logger: console,
      })
    },
    disablePlugin: (request: ElectronPluginToggleRequest) => {
      return disableOnethingPluginForIpc({
        manager: getPluginManager(),
        pluginId: request.pluginId,
        logger: console,
        // 用户亲手关的 = 清账。熔断的自动禁用不经过这条 IPC,所以两者天然分得开。
        onManualDisable: clearPluginRuntimeHealth,
      })
    },
    refreshPlugins: () => {
      return refreshOnethingPluginsForIpc({
        manager: getPluginManager(),
        logger: console,
      })
    },
    // 统一请求通道:分发与序列化判断全在 core 的 manager.handleRequest,
    // 这里只把 progress 接到 renderer 的推送通道上(@main 只做薄接线)。
    pluginRequest: (request: ElectronPluginRequestPayload, sender) => {
      return handleOnethingPluginRequestForIpc({
        manager: getPluginManager(),
        pluginId: request.pluginId,
        action: request.action,
        payload: request.payload,
        requestId: request.requestId,
        bypassDegraded: request.bypassDegraded,
        // 定向回送给发起这次 invoke 的窗口。走 IPCBridge 的话只投主窗单 sender:
        // 设置窗(独立 BrowserWindow,R3 插件设置 UI 的宿主)发起的请求进度会
        // 永远静默,主窗关闭时更是全丢。
        onProgress: progress => {
          if (!sender || sender.isDestroyed()) return
          try {
            sender.send(IPC_CHANNELS.PLUGINS_REQUEST_PROGRESS, progress)
          } catch (error) {
            log.warn('request progress send failed', { likelyCause: 'window closed' }, error)
          }
        },
        logger: console,
      })
    },
    abortPluginRequest: (request: ElectronPluginAbortRequestPayload) => {
      return abortOnethingPluginRequestForIpc({
        manager: getPluginManager(),
        requestId: request.requestId,
        logger: console,
      })
    },
    // 配置读写不碰插件代码:schema 在 manifest,存储与校验在宿主 ——
    // 所以未启用(甚至从没加载过)的插件也能配。
    getPluginConfig: (request: PluginConfigRequest) => {
      return getOnethingPluginConfigForIpc({
        access: pluginConfigAccess,
        pluginId: request.pluginId,
        logger: console,
      })
    },
    getPluginFootprint: (request: UninstallPluginRequest) => {
      return getOnethingPluginFootprintForIpc({
        readFootprint: pluginId => {
          const footprint = getPluginFootprint(pluginId)
          return {
            pluginId: footprint.pluginId,
            dataDir: footprint.dataDir,
            dataDirExists: footprint.dataDirExists,
            entries: footprint.entries,
            legacyKvExists: footprint.legacyKvExists,
            settingsKeys: footprint.settingsKeys,
          }
        },
        pluginId: request.pluginId,
        logger: console,
      })
    },
    uninstallPlugin: (request: UninstallPluginRequest) => {
      return uninstallOnethingPluginForIpc({
        manager: getPluginManager(),
        pluginId: request.pluginId,
        logger: console,
      })
    },
    setPluginConfig: (request: SetPluginConfigRequest) => {
      return setOnethingPluginConfigForIpc({
        access: pluginConfigAccess,
        pluginId: request.pluginId,
        config: request.config,
        logger: console,
      })
    },
    // ── P1:npm 生命周期 —— 命令链在 core manager,这里只做薄接线。──
    installPlugin: (request: InstallPluginRequest) => {
      return installOnethingPluginForIpc({
        manager: getPluginManager(),
        pkg: request.pkg,
        tarballUrl: request.tarballUrl,
        path: request.path,
        integrity: request.integrity,
        logger: console,
      })
    },
    updatePlugin: (request: UpdatePluginRequest) => {
      return updateOnethingPluginForIpc({
        manager: getPluginManager(),
        pluginId: request.pluginId,
        logger: console,
      })
    },
    checkPluginUpdates: () => {
      return checkOnethingPluginUpdatesForIpc({
        manager: getPluginManager(),
        logger: console,
      })
    },
    // 裁决 8:v1 依赖本机 npm —— 能力面先行,设置页据此置灰并说明。
    getPluginLifecycleInfo: () => {
      return getOnethingPluginLifecycleInfoForIpc({
        probeNpmAvailability: probePluginNpmAvailability,
      })
    },
    // 装前清单预读:包名与声明都在 tarball 里,宿主自己读出来。
    // 纯读取,不落任何盘 —— 安装闸一条不松(预读不是信任来源)。
    readPluginTarball: request => {
      return readPluginTarballSummary(request?.path ?? '')
    },
    // P3:市场 —— 索引视图在主进程 join 好(安装态 + 版本兼容 + 缓存龄),
    // renderer 只渲染;拉取失败回上次缓存并 stale 置位(断网容忍)。
    getPluginMarket: (request) => {
      return getOnethingPluginMarketForIpc({
        manager: getPluginManager(),
        logger: console,
        refresh: request?.refresh === true,
        getMarketSnapshot: getPluginMarketIndexSnapshot,
        appVersion: getPluginAppVersion(),
      })
    },
    listCommands: () => {
      return listOnethingPluginCommandsForIpc({
        manager: getPluginManager(),
        logger: console,
      })
    },
    executeCommand: (request: ElectronPluginExecuteCommandRequest) => {
      return executePluginCommand(request)
    },
  })

  log.info('handlers registered')
}
