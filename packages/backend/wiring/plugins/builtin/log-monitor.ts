import {
  ONETHING_LOG_MONITOR_MANIFEST,
  registerOnethingLogMonitorPlugin,
} from '@onething/runtime/plugins'
import type { PluginAPI } from '../types.js'
import {
  getOnethingLogDir,
} from '@onething/runtime/storage'
import { consolePort, getLogger } from '../../logging/index.js'
import type { RegisterOnethingLogMonitorPluginOptions } from '@onething/runtime/plugins/log-monitor'

const log = getLogger('plugins.log-monitor')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog = consolePort(log)


export const logMonitorManifest = ONETHING_LOG_MONITOR_MANIFEST

export default function logMonitorPlugin(api: PluginAPI): void {
  const registerOnethingLogMonitorPluginOptions: RegisterOnethingLogMonitorPluginOptions = {
    getLogDir: getOnethingLogDir,
    logger: consoleLog,
  };
  registerOnethingLogMonitorPlugin(api, registerOnethingLogMonitorPluginOptions)
}
