import type { AppSettings, ChatMessage, ChatSession, ProviderConfig } from '@shared/ipc.js'
import { pluginScope } from '@onething/core/plugins'
import {
  CorePluginLifecycleRegistry,
  type CoreAfterAssistantResponseContext,
  type CoreAfterAssistantResponseHook,
  type CoreBeforeContextCompactContext,
  type CoreBeforeContextCompactHook,
  type CoreBeforeContextCompactOutcome,
} from '@onething/core/plugins'
import {
  reportPluginRuntimeFailure,
  reportPluginRuntimeSuccess,
} from './health.js'

export interface BeforeContextCompactContext extends CoreBeforeContextCompactContext<
  AppSettings,
  ChatMessage,
  ProviderConfig & { apiKey: string }
> {}

export type BeforeContextCompactHook = CoreBeforeContextCompactHook<BeforeContextCompactContext>

export interface AfterAssistantResponseContext extends CoreAfterAssistantResponseContext<
  AppSettings,
  ChatSession,
  ChatMessage,
  ProviderConfig
> {}

export type AfterAssistantResponseHook = CoreAfterAssistantResponseHook<AfterAssistantResponseContext>

const lifecycleRegistry = new CorePluginLifecycleRegistry<
  BeforeContextCompactContext,
  AfterAssistantResponseContext
>({
  // 超时预算走 core 默认(5s):beforeContextCompact 挂在压缩路径上,
  // afterAssistantResponse 挂在每个回合结束后。
  onHookFailure({ pluginId, hookId, scope, error }) {
    reportPluginRuntimeFailure(pluginId, pluginScope.lifecycleHook(scope, hookId), error)
  },
  onHookSuccess({ pluginId, hookId, scope }) {
    reportPluginRuntimeSuccess(pluginId, pluginScope.lifecycleHook(scope, hookId))
  },
})

export function registerBeforeContextCompactHook(
  pluginId: string,
  hookId: string,
  hook: BeforeContextCompactHook,
): () => void {
  return lifecycleRegistry.registerBeforeContextCompactHook(pluginId, hookId, hook)
}

export function registerAfterAssistantResponseHook(
  pluginId: string,
  hookId: string,
  hook: AfterAssistantResponseHook,
): () => void {
  return lifecycleRegistry.registerAfterAssistantResponseHook(pluginId, hookId, hook)
}

/**
 * N7-a:返回胜出插件的替换摘要(没有插件替换时回 undefined,调用方回落宿主自压)。
 */
export async function runBeforeContextCompactHooks(
  context: BeforeContextCompactContext,
): Promise<CoreBeforeContextCompactOutcome | undefined> {
  return lifecycleRegistry.runBeforeContextCompactHooks(context)
}

export type { CoreBeforeContextCompactOutcome }

export async function runAfterAssistantResponseHooks(
  context: AfterAssistantResponseContext,
): Promise<void> {
  await lifecycleRegistry.runAfterAssistantResponseHooks(context)
}

export function clearLifecycleHooksForPlugin(pluginId: string): void {
  lifecycleRegistry.clearLifecycleHooksForPlugin(pluginId)
}

/** Registry footprint accessor — the teardown guard compares it across enable/disable. */
export function getLifecycleHookCounts(): { beforeContextCompact: number; afterAssistantResponse: number } {
  return lifecycleRegistry.getHookCounts()
}
