/**
 * 按用户设置里的代理去请求的受管 fetch(包根归位 3 第 1 笔,2026-10-03 从包根 `provider-binding/bound-fetch.ts` 搬来)。
 *
 * 受管 fetch 本体(选 dispatcher、超时、重试、中止转发)在 `runtime/network/`;这里只把它接到设置缓存
 * (`getSettings().network.proxy`,每次请求现取)与日志上。它住在设置里而不是网络件里,是因为网络件的入口
 * 也被索引 Worker 用,入口里一旦有一只 import 设置的文件,Worker 产物就要多装下整棵设置闭包。
 */
import type { ProxySettings } from '@shared/ipc.js'
import {
  clearOnethingAppDispatcherCache,
  createOnethingAppFetch,
  createRequiredOnethingAppFetch,
  validateOnethingAppProxyUrl,
  type OnethingHttpPolicyName,
  type OnethingHttpRequestOptions,
  type OnethingFetchFn,
} from '@onething/backend/runtime/network'
import { getSettings } from './settings-store.js'
import { consolePort, getLogger } from '@onething/backend/runtime/logging/configure-logging'

const log = getLogger('providers')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog = consolePort(log)


type AppFetchOptions = OnethingHttpRequestOptions & {
  proxy?: ProxySettings
}

const mainProcessNetworkAdapters = {
  getProxySettings: () => getSettings().network?.proxy,
  logger: consoleLog,
}

export const validateProxyUrl = validateOnethingAppProxyUrl

export function clearAppDispatcherCache(): void {
  clearOnethingAppDispatcherCache()
}

export function createAppFetch(options: AppFetchOptions = {}): OnethingFetchFn {
  return createOnethingAppFetch(options, mainProcessNetworkAdapters)
}

export function createRequiredAppFetch(options: AppFetchOptions = {}): OnethingFetchFn {
  return createRequiredOnethingAppFetch(options, mainProcessNetworkAdapters)
}

export function createPolicyFetch(policy: OnethingHttpPolicyName): OnethingFetchFn {
  return createRequiredAppFetch({ policy })
}
