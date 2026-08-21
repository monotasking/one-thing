import type {
  CorePluginCommandContext,
  CorePluginCommandDefinition,
  CorePluginMarketIndex,
  CorePluginRequestInput,
  CorePluginRequestResult,
  PluginAmbientDescriptor,
  PluginBackgroundDescriptor,
  PluginBackgroundParamsPatch,
} from '@onething/core/plugins'
import { compareCoreSemver, unscopedPluginIdFromPackageName } from '@onething/core/plugins'
import {
  executeOnethingPluginCommand,
  type ExecuteOnethingPluginCommandOptions,
  type ExecuteOnethingPluginCommandResult,
  type OnethingPluginCommandSessionLike,
} from './plugin-command-execution.js'
import type { PluginConfigError, PluginConfigField } from './config-schema.js'
import {
  projectOnethingPluginCommandsForRenderer,
  projectOnethingPluginsForRenderer,
  resolveOnethingPluginAmbientForRenderer,
  resolveOnethingPluginBackgroundForRenderer,
  type OnethingPluginCommandLike,
  type OnethingPluginListItemLike,
  type OnethingRendererPluginCommandInfo,
  type OnethingRendererPluginInfo,
} from './plugin-list.js'

type MaybePromise<T> = T | Promise<T>

export const ONETHING_PLUGIN_SYSTEM_NOT_INITIALIZED = 'Plugin system not initialized'

export interface OnethingPluginIpcLogger {
  error?: (...args: unknown[]) => void
}

export interface OnethingPluginCommandsLike<TCommand extends OnethingPluginCommandLike = OnethingPluginCommandLike> {
  values(): Iterable<TCommand>
}

export interface OnethingPluginIpcManagerLike<
  TPlugin extends OnethingPluginListItemLike = OnethingPluginListItemLike,
  TCommandInfo extends OnethingPluginCommandLike = OnethingPluginCommandLike,
  TCommand extends CorePluginCommandDefinition<CorePluginCommandContext> =
    CorePluginCommandDefinition<CorePluginCommandContext>,
> {
  getPlugins(): TPlugin[]
  enablePlugin(pluginId: string): MaybePromise<unknown>
  disablePlugin(pluginId: string): MaybePromise<unknown>
  refreshPlugins(): MaybePromise<unknown>
  getPluginCommands(): OnethingPluginCommandsLike<TCommandInfo>
  getCommandHandler(commandName: string): MaybePromise<TCommand | undefined>
  /** 统一请求通道(R2)。分发逻辑在 core,这里只是宿主的转发面。 */
  uninstallPlugin?(pluginId: string): Promise<{ success: boolean; archivePath?: string; error?: string }>
  /** npm 生命周期(P1)。 */
  installPlugin?(input: {
    pkg: string
    tarballUrl?: string
    path?: string
    integrity?: string
  }): Promise<{ success: boolean; pluginId?: string; error?: string }>
  updatePlugin?(pluginId: string): Promise<{
    success: boolean
    pluginId: string
    version?: string
    rolledBack?: boolean
    error?: string
  }>
  checkPluginUpdates?(): Promise<Array<{ pluginId: string; current: string; latest: string }>>
  handleRequest?(input: CorePluginRequestInput): Promise<CorePluginRequestResult>
  abortRequest?(requestId: string): boolean
  getRequestActions?(pluginId: string): string[]
}

interface OnethingPluginIpcOperationOptions<
  TPlugin extends OnethingPluginListItemLike = OnethingPluginListItemLike,
  TCommandInfo extends OnethingPluginCommandLike = OnethingPluginCommandLike,
  TCommand extends CorePluginCommandDefinition<CorePluginCommandContext> =
    CorePluginCommandDefinition<CorePluginCommandContext>,
> {
  manager?: OnethingPluginIpcManagerLike<TPlugin, TCommandInfo, TCommand> | null
  logger?: OnethingPluginIpcLogger
  /** 有效配置取值器(R3);省略时列表里的配置值退回默认。 */
  getPluginConfig?(pluginId: string): Record<string, unknown>
  /**
   * 背景层运行期参数取值器(G 期,L2.5);省略时只按 manifest 缺省投影。
   * 方案 A 下 server 只读镜像不跑插件代码,那侧天然省略。
   */
  getPluginBackgroundParams?(pluginId: string): PluginBackgroundParamsPatch | undefined
}

export type ListOnethingPluginsForIpcResult =
  | {
    success: true
    plugins: OnethingRendererPluginInfo[]
    /**
     * 胜出的插件背景(G 期,L2.5)。`null` = 没有任何一个已启用插件声明了背景。
     *
     * 挂在清单响应上而不是新开一条通道:renderer 已经在
     * `onething:plugins-changed` 上重拉这份清单(面板入口、锚点块、主题都走它),
     * 背景描述符搭同一班车 —— 零新事件、零新 IPC channel。
     */
    background: PluginBackgroundDescriptor | null
    /**
     * 胜出的氛围层(G2 —— 全窗动画覆盖)。`null` = 没有任何一个已启用插件声明了
     * 合法的氛围。
     *
     * 与背景层同规:搭清单响应这一班车,零新事件、零新 IPC channel —— renderer
     * 已经在 `onething:plugins-changed` 上重拉清单。用户的总闸 / 每插件静音在
     * renderer 侧据 preference 决定这个 winner 到底画不画(裁决与主权分层)。
     */
    ambient: PluginAmbientDescriptor | null
  }
  | { success: false; error: string }

export async function listOnethingPluginsForIpc<
  TPlugin extends OnethingPluginListItemLike,
  TCommandInfo extends OnethingPluginCommandLike,
  TCommand extends CorePluginCommandDefinition<CorePluginCommandContext>,
>(
  options: OnethingPluginIpcOperationOptions<TPlugin, TCommandInfo, TCommand>,
): Promise<ListOnethingPluginsForIpcResult> {
  try {
    const manager = requireOnethingPluginManager(options.manager)
    const plugins = manager.getPlugins()
    const projectionOptions = {
      getRequestActions: (pluginId: string) => manager.getRequestActions?.(pluginId) ?? [],
      getConfig: options.getPluginConfig,
      getBackgroundParams: options.getPluginBackgroundParams,
    }
    return {
      success: true,
      plugins: projectOnethingPluginsForRenderer(plugins, projectionOptions),
      // 同一份 options 喂两次裁决 —— 卡片上的明细与画在屏幕上的那一张必须同源。
      background: resolveOnethingPluginBackgroundForRenderer(plugins, projectionOptions),
      // 氛围层(G2)只按 manifest 声明裁决,不吃 options(它没有运行期调参这回事)。
      ambient: resolveOnethingPluginAmbientForRenderer(plugins),
    }
  } catch (error) {
    return pluginIpcError(options.logger, 'list', error, 'Failed to list plugins')
  }
}

export type ToggleOnethingPluginForIpcResult =
  | { success: true }
  | { success: false; error: string }

export async function enableOnethingPluginForIpc<
  TPlugin extends OnethingPluginListItemLike,
  TCommandInfo extends OnethingPluginCommandLike,
  TCommand extends CorePluginCommandDefinition<CorePluginCommandContext>,
>(
  options: OnethingPluginIpcOperationOptions<TPlugin, TCommandInfo, TCommand> & { pluginId: string },
): Promise<ToggleOnethingPluginForIpcResult> {
  try {
    const manager = requireOnethingPluginManager(options.manager)
    await manager.enablePlugin(options.pluginId)
    return { success: true }
  } catch (error) {
    return pluginIpcError(options.logger, `enable ${options.pluginId}`, error, 'Failed to enable plugin')
  }
}

export async function disableOnethingPluginForIpc<
  TPlugin extends OnethingPluginListItemLike,
  TCommandInfo extends OnethingPluginCommandLike,
  TCommand extends CorePluginCommandDefinition<CorePluginCommandContext>,
>(
  options: OnethingPluginIpcOperationOptions<TPlugin, TCommandInfo, TCommand> & {
    pluginId: string
    /**
     * 手动停用的清账钩子。
     *
     * 熔断的自动禁用**不走这个入口**(它直接调 manager.disablePlugin),所以
     * 这里天然只对"用户亲手关的"生效:清掉后端 tracker 与盘上的原因,否则
     * 重开设置页红条照样复现。
     */
    onManualDisable?: (pluginId: string) => void
  },
): Promise<ToggleOnethingPluginForIpcResult> {
  try {
    const manager = requireOnethingPluginManager(options.manager)
    await manager.disablePlugin(options.pluginId)
    options.onManualDisable?.(options.pluginId)
    return { success: true }
  } catch (error) {
    return pluginIpcError(options.logger, `disable ${options.pluginId}`, error, 'Failed to disable plugin')
  }
}

export type UninstallOnethingPluginForIpcResult = {
  success: boolean
  archivePath?: string
  error?: string
}

/**
 * 卸载的宿主转发面(R4)。
 *
 * 生命周期本身在 core 的 manager.uninstallPlugin;这里只负责把结果原样带出去
 * (含 archivePath —— 用户要知道自己的数据被搬去了哪)。
 */
export async function uninstallOnethingPluginForIpc<
  TPlugin extends OnethingPluginListItemLike,
  TCommandInfo extends OnethingPluginCommandLike,
  TCommand extends CorePluginCommandDefinition<CorePluginCommandContext>,
>(
  options: OnethingPluginIpcOperationOptions<TPlugin, TCommandInfo, TCommand> & { pluginId: string },
): Promise<UninstallOnethingPluginForIpcResult> {
  try {
    const manager = requireOnethingPluginManager(options.manager)
    if (!manager.uninstallPlugin) {
      return { success: false, error: 'Plugin uninstall is unavailable on this host' }
    }
    return await manager.uninstallPlugin(options.pluginId)
  } catch (error) {
    return pluginIpcError(options.logger, `uninstall ${options.pluginId}`, error, 'Failed to uninstall plugin')
  }
}

export async function refreshOnethingPluginsForIpc<
  TPlugin extends OnethingPluginListItemLike,
  TCommandInfo extends OnethingPluginCommandLike,
  TCommand extends CorePluginCommandDefinition<CorePluginCommandContext>,
>(
  options: OnethingPluginIpcOperationOptions<TPlugin, TCommandInfo, TCommand>,
): Promise<ToggleOnethingPluginForIpcResult> {
  try {
    const manager = requireOnethingPluginManager(options.manager)
    await manager.refreshPlugins()
    return { success: true }
  } catch (error) {
    return pluginIpcError(options.logger, 'refresh', error, 'Failed to refresh plugins')
  }
}

// ── P1:npm 生命周期的转发面 —— 命令链全在 core manager,这里只带结果。──

export interface InstallOnethingPluginForIpcOptions<
  TPlugin extends OnethingPluginListItemLike = OnethingPluginListItemLike,
  TCommandInfo extends OnethingPluginCommandLike = OnethingPluginCommandLike,
  TCommand extends CorePluginCommandDefinition<CorePluginCommandContext> =
    CorePluginCommandDefinition<CorePluginCommandContext>,
> extends OnethingPluginIpcOperationOptions<TPlugin, TCommandInfo, TCommand> {
  pkg: string
  tarballUrl?: string
  path?: string
  integrity?: string
}

export async function installOnethingPluginForIpc<
  TPlugin extends OnethingPluginListItemLike,
  TCommandInfo extends OnethingPluginCommandLike,
  TCommand extends CorePluginCommandDefinition<CorePluginCommandContext>,
>(
  options: InstallOnethingPluginForIpcOptions<TPlugin, TCommandInfo, TCommand>,
) {
  try {
    const manager = requireOnethingPluginManager(options.manager)
    if (!manager.installPlugin) {
      return { success: false as const, error: 'Plugin installation is unavailable on this host' }
    }
    return await manager.installPlugin({
      pkg: options.pkg,
      tarballUrl: options.tarballUrl,
      path: options.path,
      integrity: options.integrity,
    })
  } catch (error) {
    return pluginIpcError(options.logger, `install ${options.pkg}`, error, 'Failed to install plugin')
  }
}

export async function updateOnethingPluginForIpc<
  TPlugin extends OnethingPluginListItemLike,
  TCommandInfo extends OnethingPluginCommandLike,
  TCommand extends CorePluginCommandDefinition<CorePluginCommandContext>,
>(
  options: OnethingPluginIpcOperationOptions<TPlugin, TCommandInfo, TCommand> & { pluginId: string },
) {
  try {
    const manager = requireOnethingPluginManager(options.manager)
    if (!manager.updatePlugin) {
      return { success: false as const, pluginId: options.pluginId, error: 'Plugin updates are unavailable on this host' }
    }
    return await manager.updatePlugin(options.pluginId)
  } catch (error) {
    const failed = pluginIpcError(options.logger, `update ${options.pluginId}`, error, 'Failed to update plugin')
    return { ...failed, pluginId: options.pluginId }
  }
}

export async function checkOnethingPluginUpdatesForIpc<
  TPlugin extends OnethingPluginListItemLike,
  TCommandInfo extends OnethingPluginCommandLike,
  TCommand extends CorePluginCommandDefinition<CorePluginCommandContext>,
>(
  options: OnethingPluginIpcOperationOptions<TPlugin, TCommandInfo, TCommand>,
) {
  try {
    const manager = requireOnethingPluginManager(options.manager)
    if (!manager.checkPluginUpdates) {
      return { success: true as const, offers: [] }
    }
    return { success: true as const, offers: await manager.checkPluginUpdates() }
  } catch (error) {
    const failed = pluginIpcError(options.logger, 'check-updates', error, 'Failed to check plugin updates')
    return { ...failed, offers: [] }
  }
}

// ── P3:市场 ──

/** 市场条目视图(主进程 join 好:索引声明 + 本机安装态 + 版本兼容;renderer 只渲染)。 */
export interface OnethingPluginMarketEntry {
  id: string
  pkg: string
  version: string
  description?: string
  author?: string
  minAppVersion?: string
  /** 原始 contributes 声明 —— 装前确认页呈现的就是 manifest,不是营销文案。 */
  contributes?: unknown
  tarballUrl: string
  integrity?: string
  repository?: string
  /** 已装版本;未装 = null。 */
  installedVersion: string | null
  /** 已装且索引版本更新。 */
  hasUpdate: boolean
  /** minAppVersion 不满足时的说明(Install 置灰依据);满足 = null。 */
  versionBlockedReason: string | null
}

/** 宿主注入的索引快照形状(实现:app/plugins/install.ts 的 getPluginMarketIndexSnapshot)。 */
export interface OnethingPluginMarketSnapshot {
  index: CorePluginMarketIndex | null
  fetchedAt: number | null
  stale: boolean
  error: string | null
}

export type GetOnethingPluginMarketForIpcResult =
  | {
    success: true
    entries: OnethingPluginMarketEntry[]
    fetchedAt: number | null
    stale: boolean
    /** stale 时附带的本次拉取失败原因 —— UI 可以说"为什么过期",不猜断网。 */
    error?: string
  }
  | { success: false; entries: []; fetchedAt: number | null; stale: boolean; error: string }

export interface GetOnethingPluginMarketForIpcOptions<
  TPlugin extends OnethingPluginListItemLike = OnethingPluginListItemLike,
  TCommandInfo extends OnethingPluginCommandLike = OnethingPluginCommandLike,
  TCommand extends CorePluginCommandDefinition<CorePluginCommandContext> =
    CorePluginCommandDefinition<CorePluginCommandContext>,
> extends OnethingPluginIpcOperationOptions<TPlugin, TCommandInfo, TCommand> {
  /** true = 强制重新拉取;省略/false = 有缓存先用缓存。 */
  refresh?: boolean
  /** 宿主注入:索引快照口;省略 = 市场不可用。 */
  getMarketSnapshot?: (input: { refresh: boolean }) => Promise<OnethingPluginMarketSnapshot>
  /** 宿主版本 —— minAppVersion 比对;省略 = 跳过比对(不置灰)。 */
  appVersion?: string
}

export async function getOnethingPluginMarketForIpc<
  TPlugin extends OnethingPluginListItemLike,
  TCommandInfo extends OnethingPluginCommandLike,
  TCommand extends CorePluginCommandDefinition<CorePluginCommandContext>,
>(
  options: GetOnethingPluginMarketForIpcOptions<TPlugin, TCommandInfo, TCommand>,
): Promise<GetOnethingPluginMarketForIpcResult> {
  try {
    const manager = requireOnethingPluginManager(options.manager)
    if (!options.getMarketSnapshot) {
      return {
        success: false as const,
        entries: [],
        fetchedAt: null,
        stale: false,
        error: 'Plugin market is unavailable on this host',
      }
    }
    const snapshot = await options.getMarketSnapshot({ refresh: options.refresh === true })
    if (!snapshot.index) {
      // 连缓存都没有 = 真空失败;有缓存时 snapshot.index 非空,
      // 走成功 + stale 路径(断网容忍)。
      return {
        success: false as const,
        entries: [],
        fetchedAt: snapshot.fetchedAt,
        stale: false,
        error: snapshot.error ?? 'market index unavailable',
      }
    }
    const installed = new Map(manager.getPlugins().map(info => [info.definition.id, info]))
    const entries: OnethingPluginMarketEntry[] = []
    for (const entry of snapshot.index.plugins) {
      // 索引内部一致性(端到端审查 S4 的展示侧):id 必须等于 pkg 去 scope,
      // 不一致的条目会把"已装/有更新"join 到错误的插件上 —— 滤掉并警告。
      if (unscopedPluginIdFromPackageName(entry.pkg) !== entry.id) {
        options.logger?.error?.(`[PluginMarket] Index entry "${entry.id}" has inconsistent pkg "${entry.pkg}" — skipped`)
        continue
      }
      const info = installed.get(entry.id)
      const installedVersion = info?.definition.manifest.version ?? null
      entries.push({
        id: entry.id,
        pkg: entry.pkg,
        version: entry.version,
        ...(entry.description ? { description: entry.description } : {}),
        ...(entry.author ? { author: entry.author } : {}),
        ...(entry.minAppVersion ? { minAppVersion: entry.minAppVersion } : {}),
        ...(entry.contributes !== undefined ? { contributes: entry.contributes } : {}),
        tarballUrl: entry.tarballUrl,
        ...(entry.integrity ? { integrity: entry.integrity } : {}),
        ...(entry.repository ? { repository: entry.repository } : {}),
        installedVersion,
        hasUpdate: installedVersion !== null && compareCoreSemver(entry.version, installedVersion) > 0,
        versionBlockedReason: entry.minAppVersion && options.appVersion
          && compareCoreSemver(options.appVersion, entry.minAppVersion) < 0
          ? `requires app >= ${entry.minAppVersion} (current ${options.appVersion})`
          : null,
      })
    }
    return {
      success: true as const,
      entries,
      fetchedAt: snapshot.fetchedAt,
      stale: snapshot.stale,
      ...(snapshot.stale && snapshot.error ? { error: snapshot.error } : {}),
    }
  } catch (error) {
    const failed = pluginIpcError(options.logger, 'market', error, 'Failed to load the plugin market')
    return { ...failed, entries: [], fetchedAt: null, stale: false }
  }
}

export type ListOnethingPluginCommandsForIpcResult =
  | { success: true; commands: OnethingRendererPluginCommandInfo[] }
  | { success: false; error: string }

/**
 * 网关侧的"列命令":插件系统还没装配起来时,网关要的答案是"这台机器没有插件
 * 命令",不是一条错误 —— 这条降级判定同样属于 IPC 操作层,不留在宿主里
 * (boundary:`packages/onething-runtime owns plugin IPC operations`)。
 */
export async function listOnethingPluginCommandsForIpcAllowingUninitialized<
  TPlugin extends OnethingPluginListItemLike,
  TCommandInfo extends OnethingPluginCommandLike,
  TCommand extends CorePluginCommandDefinition<CorePluginCommandContext>,
>(
  options: OnethingPluginIpcOperationOptions<TPlugin, TCommandInfo, TCommand>,
): Promise<ListOnethingPluginCommandsForIpcResult> {
  if (!options.manager) return { success: true, commands: [] }
  return listOnethingPluginCommandsForIpc(options)
}

export interface GetOnethingPluginLifecycleInfoForIpcResult {
  success: true
  npmAvailable: boolean
}

/**
 * 裁决 8:v1 的插件生命周期依赖本机 npm —— 能力面先行,设置页据此置灰并说明。
 * 探针由宿主注入(它才知道自己那台机器怎么找 npm),载荷形状归运行时。
 */
export async function getOnethingPluginLifecycleInfoForIpc(
  options: { probeNpmAvailability(): Promise<boolean> | boolean },
): Promise<GetOnethingPluginLifecycleInfoForIpcResult> {
  return { success: true, npmAvailable: await options.probeNpmAvailability() }
}

export async function listOnethingPluginCommandsForIpc<
  TPlugin extends OnethingPluginListItemLike,
  TCommandInfo extends OnethingPluginCommandLike,
  TCommand extends CorePluginCommandDefinition<CorePluginCommandContext>,
>(
  options: OnethingPluginIpcOperationOptions<TPlugin, TCommandInfo, TCommand>,
): Promise<ListOnethingPluginCommandsForIpcResult> {
  try {
    const manager = requireOnethingPluginManager(options.manager)
    return {
      success: true,
      commands: projectOnethingPluginCommandsForRenderer(manager.getPluginCommands().values()),
    }
  } catch (error) {
    return pluginIpcError(options.logger, 'commands', error, 'Failed to list plugin commands')
  }
}

export interface ExecuteOnethingPluginCommandForIpcOptions<
  TCommand extends CorePluginCommandDefinition<CorePluginCommandContext> =
    CorePluginCommandDefinition<CorePluginCommandContext>,
  TSession extends OnethingPluginCommandSessionLike = OnethingPluginCommandSessionLike,
> extends Omit<ExecuteOnethingPluginCommandOptions<TCommand, TSession>, 'getCommandHandler'> {
  manager?: Pick<OnethingPluginIpcManagerLike<OnethingPluginListItemLike, OnethingPluginCommandLike, TCommand>, 'getCommandHandler'> | null
  logger?: OnethingPluginIpcLogger
}

export async function executeOnethingPluginCommandForIpc<
  TCommand extends CorePluginCommandDefinition<CorePluginCommandContext>,
  TSession extends OnethingPluginCommandSessionLike,
>(
  options: ExecuteOnethingPluginCommandForIpcOptions<TCommand, TSession>,
): Promise<ExecuteOnethingPluginCommandResult> {
  const { manager, logger, ...commandOptions } = options
  try {
    const requiredManager = requireOnethingPluginManager(manager)
    return await executeOnethingPluginCommand({
      ...commandOptions,
      getCommandHandler: commandName => requiredManager.getCommandHandler(commandName),
    })
  } catch (error) {
    return pluginIpcError(logger, 'execute command', error, 'Failed to execute plugin command')
  }
}

/**
 * 统一请求通道的宿主转发面(设计文档 §5 R2)。
 *
 * 这里刻意**不**做任何分发/序列化判断 —— 那些都在 core 的 manager.handleRequest
 * 里,四个宿主共用同一份语义;@main / http 只负责把参数递进来、把结果递出去。
 */
export type OnethingPluginRequestForIpcResult = CorePluginRequestResult

export interface OnethingPluginRequestForIpcOptions<
  TPlugin extends OnethingPluginListItemLike = OnethingPluginListItemLike,
  TCommandInfo extends OnethingPluginCommandLike = OnethingPluginCommandLike,
  TCommand extends CorePluginCommandDefinition<CorePluginCommandContext> =
    CorePluginCommandDefinition<CorePluginCommandContext>,
> extends OnethingPluginIpcOperationOptions<TPlugin, TCommandInfo, TCommand> {
  pluginId: string
  action: string
  payload?: unknown
  requestId?: string
  /** R7:绕过降级闸放行一次(仅用户显式重试)。 */
  bypassDegraded?: boolean
  onProgress?: CorePluginRequestInput['onProgress']
}

export async function handleOnethingPluginRequestForIpc<
  TPlugin extends OnethingPluginListItemLike,
  TCommandInfo extends OnethingPluginCommandLike,
  TCommand extends CorePluginCommandDefinition<CorePluginCommandContext>,
>(
  options: OnethingPluginRequestForIpcOptions<TPlugin, TCommandInfo, TCommand>,
): Promise<OnethingPluginRequestForIpcResult> {
  // **不在这里预生成 requestId。** 之前用 `${pluginId}#${Date.now()}`(毫秒精度、
  // 无序列号)把 core 那个带单调序列号的 nextRequestId 旁路成了死码,同毫秒并发
  // 两个请求会串号:先到的 AbortController 失联,先 settle 的一方把另一方的
  // 登记也删掉。缺省交给 core 生成,真正生效的 id 随结果回传。
  try {
    const manager = requireOnethingPluginManager(options.manager)
    if (!manager.handleRequest) {
      return {
        success: false,
        requestId: options.requestId || '',
        error: 'Plugin request channel is unavailable on this host',
      }
    }
    return await manager.handleRequest({
      pluginId: options.pluginId,
      action: options.action,
      payload: options.payload,
      requestId: options.requestId,
      // R7:用户在降级态上明确点了"再试一次"才透传。
      bypassDegraded: options.bypassDegraded,
      onProgress: options.onProgress,
    })
  } catch (error) {
    const projected = pluginIpcError(
      options.logger,
      `request ${options.pluginId}/${options.action}`,
      error,
      'Plugin request failed',
    )
    return { success: false, requestId: options.requestId || '', error: projected.error }
  }
}

export function abortOnethingPluginRequestForIpc<
  TPlugin extends OnethingPluginListItemLike,
  TCommandInfo extends OnethingPluginCommandLike,
  TCommand extends CorePluginCommandDefinition<CorePluginCommandContext>,
>(
  options: OnethingPluginIpcOperationOptions<TPlugin, TCommandInfo, TCommand> & { requestId: string },
): { success: boolean; aborted: boolean; error?: string } {
  try {
    const manager = requireOnethingPluginManager(options.manager)
    return { success: true, aborted: manager.abortRequest?.(options.requestId) ?? false }
  } catch (error) {
    const projected = pluginIpcError(options.logger, 'abort request', error, 'Failed to abort plugin request')
    return { success: false, aborted: false, error: projected.error }
  }
}

/**
 * 插件自有配置的宿主转发面(R3)。
 *
 * 与请求通道不同,这两条**不经过插件代码**:schema 在 manifest、存储与校验在
 * 宿主,所以未启用甚至从未加载过的插件也能配 —— 这正是"声明先于代码"的红利。
 */
export interface OnethingPluginConfigAccess {
  describe(pluginId: string): {
    declared: boolean
    supported: boolean
    title?: string
    fields: PluginConfigField[]
    unsupportedReasons: string[]
  }
  read(pluginId: string): Record<string, unknown>
  write(pluginId: string, config: unknown): {
    success: boolean
    config?: Record<string, unknown>
    errors?: PluginConfigError[]
  }
}

export type GetOnethingPluginConfigForIpcResult = {
  success: boolean
  fields?: PluginConfigField[]
  config?: Record<string, unknown>
  title?: string
  declared?: boolean
  unsupportedReasons?: string[]
  editable?: boolean
  readOnlyReason?: string
  error?: string
}

export function getOnethingPluginConfigForIpc(options: {
  access?: OnethingPluginConfigAccess | null
  pluginId: string
  logger?: OnethingPluginIpcLogger
}): GetOnethingPluginConfigForIpcResult {
  try {
    if (!options.access) return { success: false, error: ONETHING_PLUGIN_SYSTEM_NOT_INITIALIZED }
    const described = options.access.describe(options.pluginId)
    return {
      success: true,
      declared: described.declared,
      title: described.title,
      fields: described.supported ? described.fields : [],
      unsupportedReasons: described.unsupportedReasons,
      config: described.declared ? options.access.read(options.pluginId) : {},
      editable: true,
    }
  } catch (error) {
    return pluginIpcError(options.logger, `config get ${options.pluginId}`, error, 'Failed to read plugin config')
  }
}

export function setOnethingPluginConfigForIpc(options: {
  access?: OnethingPluginConfigAccess | null
  pluginId: string
  config: unknown
  logger?: OnethingPluginIpcLogger
}): { success: boolean; config?: Record<string, unknown>; errors?: PluginConfigError[]; error?: string } {
  try {
    if (!options.access) return { success: false, error: ONETHING_PLUGIN_SYSTEM_NOT_INITIALIZED }
    return options.access.write(options.pluginId, options.config)
  } catch (error) {
    return pluginIpcError(options.logger, `config set ${options.pluginId}`, error, 'Failed to save plugin config')
  }
}

export function getOnethingPluginFootprintForIpc(options: {
  readFootprint?: (pluginId: string) => {
    pluginId: string
    dataDir: string
    dataDirExists: boolean
    entries: string[]
    legacyKvExists: boolean
    settingsKeys: string[]
  }
  pluginId: string
  logger?: OnethingPluginIpcLogger
}): { success: boolean; footprint?: ReturnType<NonNullable<typeof options.readFootprint>>; error?: string } {
  try {
    if (!options.readFootprint) return { success: false, error: 'Plugin footprint is unavailable on this host' }
    return { success: true, footprint: options.readFootprint(options.pluginId) }
  } catch (error) {
    return pluginIpcError(options.logger, `footprint ${options.pluginId}`, error, 'Failed to read plugin footprint')
  }
}

function requireOnethingPluginManager<TManager>(
  manager: TManager | null | undefined,
): TManager {
  if (!manager) throw new Error(ONETHING_PLUGIN_SYSTEM_NOT_INITIALIZED)
  return manager
}

function pluginIpcError(
  logger: OnethingPluginIpcLogger | undefined,
  label: string,
  error: unknown,
  fallback: string,
): { success: false; error: string } {
  logger?.error?.(`[PluginIPC] ${label} error:`, error)
  return {
    success: false,
    error: error instanceof Error && error.message ? error.message : fallback,
  }
}
