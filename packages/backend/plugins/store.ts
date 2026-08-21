import {
  CorePluginStore,
  createCorePluginFiles,
  createCorePluginMessageStateStore,
  createCorePluginStorage,
  type CorePluginFiles,
  type CorePluginFilesUsage,
  type CorePluginMessageStateStore,
  type CorePluginStorage,
} from '@onething/core/plugins'
import { getPluginsDir } from './loader.js'

/**
 * 家目录根(P1):所有插件(npm 形态与内置)的数据都住 `plugins/<id>/`。
 *
 * 判别曾经有第二条分支 —— legacy 代码目录不给家目录、数据留 plugin-data ——
 * 随 legacy 目录插件清零(2026-08-09)一并撤掉:今天只有一个根。
 */
export class PluginStore extends CorePluginStore {
  constructor(pluginId: string, options: { isDisposing?(): boolean } = {}) {
    super(pluginId, {
      homeRoot: getPluginsDir(),
      isDisposing: options.isDisposing,
    })
  }
}

/** api.storage 的宿主实现 —— 与 KV 同一个根(家目录)。 */
export function createPluginStorage(
  pluginId: string,
  options: { isDisposed?: () => boolean } = {},
): CorePluginStorage {
  return createCorePluginStorage({
    pluginId,
    homeRoot: getPluginsDir(),
    isDisposed: options.isDisposed,
  })
}

/**
 * api.storage.message() 的宿主实现(plugin-message-state-2026-08)。
 *
 * 闸门只剩一层:`persistent` 由调用方按 manifest 的 lifetime 声明投影(任一
 * slot 声明 'persistent' 才给)。第二层"legacy 代码目录没有家目录 → 强制
 * ephemeral"随 legacy 清零(2026-08-09)撤掉 —— 今天每个插件都有家目录。
 */
export function createPluginMessageState(
  pluginId: string,
  options: { persistent: boolean; isDisposed?: () => boolean },
): CorePluginMessageStateStore {
  return createCorePluginMessageStateStore({
    pluginId,
    homeRoot: getPluginsDir(),
    persistent: options.persistent,
    isDisposed: options.isDisposed,
  })
}

/**
 * F1 `api.storage.files` 的宿主实现 —— 与 KV / 消息态同一个家目录根。
 *
 * 宿主在这一层只接三根线,判据一条都不在这里:配额档位、外部根的解析、
 * 预警回调。剩下的(路径判据、原子写、O_APPEND、记账)全在 core。
 */
export function createPluginFiles(
  pluginId: string,
  options: {
    quotaBytes?: number
    externalRootDeclared?: boolean
    resolveExternalRoot?: () => string | undefined
    isDisposed?: () => boolean
    onQuotaWarning?: (usage: CorePluginFilesUsage) => void
  } = {},
): CorePluginFiles {
  return createCorePluginFiles({
    pluginId,
    homeRoot: getPluginsDir(),
    quotaBytes: options.quotaBytes,
    externalRootDeclared: options.externalRootDeclared,
    resolveExternalRoot: options.resolveExternalRoot,
    isDisposed: options.isDisposed,
    onQuotaWarning: options.onQuotaWarning,
  })
}
