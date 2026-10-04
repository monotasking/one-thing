/**
 * 服务商的原生工具:有的服务商在自己的接口上自带工具(例如 Responses 协议的原生出图 `image_generation`),
 * 要不要在这一轮挂上、挂哪几个,由那一家在行为名册上的可选钩子 `nativeTools` 自己回答。
 * 这里只按名册找到这一家那一行、有钩子就问;通用代码(引擎、系统提示快照)经这一个函数问,不点名任何一家。
 */
import { VENDOR_RUNTIMES } from './vendors/provider-vendor-runtimes.js'
import type { VendorNativeToolsContext } from './vendors/provider-vendor-runtimes.js'

/** Responses 协议原生出图工具的名字(协议层的名字,不属于任何一家)。 */
export const PROVIDER_NATIVE_IMAGE_GENERATION_TOOL = 'image_generation'

export interface ProviderNativeToolsRequest {
  providerId: string
  providerConfig: VendorNativeToolsContext['providerConfig']
  toolSettings?: VendorNativeToolsContext['toolSettings']
  supportsTools: boolean
  /** 按型号与服务商取目录条目;只在那一家的钩子要看型号时才调。 */
  getModelInfo(modelId: string, providerId: string): ReturnType<VendorNativeToolsContext['modelInfo']>
}

/** 这一轮这一家要挂的原生工具名;名册里这一家没有钩子(或根本不是内置服务商)= 空表。 */
export async function resolveProviderNativeTools(request: ProviderNativeToolsRequest): Promise<string[]> {
  const nativeTools = VENDOR_RUNTIMES.find((vendor) => vendor.id === request.providerId)?.nativeTools
  if (!nativeTools) return []
  return [...await nativeTools({
    providerConfig: request.providerConfig,
    toolSettings: request.toolSettings,
    supportsTools: request.supportsTools,
    modelInfo: () => request.getModelInfo(request.providerConfig.model || '', request.providerId),
  })]
}
