/**
 * 配置读写的 IPC 适配面 —— 把 config.ts 的三件事收成一个对象给宿主转发面用。
 *
 * 单独一个文件是为了让 @main 只 import 一个工厂,而不必认识 describe/get/set
 * 三个自由函数以及它们的顺序约定(@main 只做薄接线)。
 */
import type { PluginConfigError, PluginConfigField } from '@onething/runtime/plugins'
import {
  describePluginConfig,
  getEffectivePluginConfig,
  setPluginConfig,
} from './config.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('plugins')


export interface PluginConfigAccess {
  describe(pluginId: string): {
    declared: boolean
    supported: boolean
    title?: string
    // 直接吃产品层的字段类型,不再手抄一份形状(同包内已有 3 份重复)。
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

/**
 * 配置保存后的广播出口(R5 跨窗口一致性的铺垫)。
 *
 * 复用 plugin:notification 那条已经通到 renderer 的通道 —— 设置窗与主窗都收得到,
 * 收到后各自刷新对应插件的 configValues。
 */
let broadcastConfigChanged: ((pluginId: string) => void) | null = null

export function configurePluginConfigBroadcast(next: ((pluginId: string) => void) | null): void {
  broadcastConfigChanged = next
}

export function createPluginConfigAccess(): PluginConfigAccess {
  return {
    describe(pluginId) {
      const described = describePluginConfig(pluginId)
      if (!described) {
        return { declared: false, supported: false, fields: [], unsupportedReasons: [] }
      }
      if (!described.supported) {
        return { declared: true, supported: false, fields: [], unsupportedReasons: described.reasons }
      }
      return {
        declared: true,
        supported: true,
        title: described.title,
        fields: described.fields,
        unsupportedReasons: [],
      }
    },
    read: getEffectivePluginConfig,
    write: (pluginId, config) => {
      const result = setPluginConfig(pluginId, config)
      if (result.success) {
        try {
          broadcastConfigChanged?.(pluginId)
        } catch (error) {
          log.error('broadcast plugin config change failed', { pluginId }, error)
        }
      }
      return result
    },
  }
}
