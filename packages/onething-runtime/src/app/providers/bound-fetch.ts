import type { ProxySettings } from '@shared/ipc.js'
import {
  clearOnethingAppDispatcherCache,
  createOnethingAppHttpClient,
  createOnethingAppFetch,
  createOnethingBoundFetch,
  createRequiredOnethingAppFetch,
  getOnethingAppDispatcher,
  shouldBypassOnethingAppProxy,
  validateOnethingAppProxyUrl,
  type OnethingHttpClient,
  type OnethingHttpPolicyName,
  type OnethingHttpRequestOptions,
  type OnethingFetchFn,
} from '@onething/runtime/providers'
import { getSettings } from '../stores/settings.js'
import { consolePort, getLogger } from '../logging/index.js'

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
export const shouldBypassProxy = shouldBypassOnethingAppProxy

export function getAppDispatcher(proxy?: ProxySettings) {
  return getOnethingAppDispatcher(proxy)
}

export function clearAppDispatcherCache(): void {
  clearOnethingAppDispatcherCache()
}

export function createAppHttpClient(options: AppFetchOptions = {}): OnethingHttpClient {
  return createOnethingAppHttpClient(options, mainProcessNetworkAdapters)
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

export function createBoundFetch(options: OnethingHttpRequestOptions = {}): OnethingFetchFn {
  if (Object.keys(options).length > 0) {
    return createOnethingAppFetch(options, mainProcessNetworkAdapters)
  }
  return createOnethingBoundFetch(mainProcessNetworkAdapters)
}
