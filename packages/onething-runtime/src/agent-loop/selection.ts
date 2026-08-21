import {
  resolveAgentLoopStreamRoute as resolveCoreAgentLoopStreamRoute,
  shouldUseAgentLoopStream as shouldUseCoreAgentLoopStream,
  type AgentLoopStreamEnabledBy,
  type AgentLoopStreamRoute,
  type AgentLoopStreamSelectionContext as CoreAgentLoopStreamSelectionContext,
} from '@onething/core/engine'
import {
  getSupportedAgentProviderRuntimeIds,
  isAgentProviderRuntimeSupported,
} from './providers/index.js'

export const ONETHING_AGENT_LOOP_STREAM_ENV = 'ONETHING_AGENT_LOOP_STREAM'

export type { AgentLoopStreamEnabledBy, AgentLoopStreamRoute }

/**
 * 判据只读 `settings.chat.agentLoopStream` 一格,所以设置面在这里只要求那一格
 * ——**不要求索引签名**:装配层传进来的是 `AppSettings`(一个 interface,
 * 没有隐式索引签名),硬要索引签名就得在装配层再写一个换名薄适配把它宽掉,
 * 那正是 P3'e-A2b 删掉的那 28 行。泛型化的写法与 `triggers/skill-review-state.ts`
 * 同一判例。
 */
export interface OnethingAgentLoopStreamSelectionSettings {
  chat?: {
    agentLoopStream?: boolean
  }
}

export interface OnethingAgentLoopStreamSelectionContext<
  TSettings extends OnethingAgentLoopStreamSelectionSettings = OnethingAgentLoopStreamSelectionSettings,
> extends Omit<CoreAgentLoopStreamSelectionContext, 'settings'> {
  providerId: string
  settings?: TSettings
}

export function resolveOnethingAgentLoopStreamRoute<
  TSettings extends OnethingAgentLoopStreamSelectionSettings,
>(
  ctx: OnethingAgentLoopStreamSelectionContext<TSettings>,
): AgentLoopStreamRoute {
  return resolveCoreAgentLoopStreamRoute({
    ...ctx,
    settings: ctx.settings as CoreAgentLoopStreamSelectionContext['settings'],
    envFlagName: ctx.envFlagName ?? ONETHING_AGENT_LOOP_STREAM_ENV,
    supportedProviderIds: ctx.supportedProviderIds ?? getSupportedAgentProviderRuntimeIds(),
    isProviderSupported: ctx.isProviderSupported ?? isAgentProviderRuntimeSupported,
  })
}

export function shouldUseOnethingAgentLoopStream<
  TSettings extends OnethingAgentLoopStreamSelectionSettings,
>(
  ctx: OnethingAgentLoopStreamSelectionContext<TSettings>,
): boolean {
  return shouldUseCoreAgentLoopStream({
    ...ctx,
    settings: ctx.settings as CoreAgentLoopStreamSelectionContext['settings'],
    envFlagName: ctx.envFlagName ?? ONETHING_AGENT_LOOP_STREAM_ENV,
    supportedProviderIds: ctx.supportedProviderIds ?? getSupportedAgentProviderRuntimeIds(),
    isProviderSupported: ctx.isProviderSupported ?? isAgentProviderRuntimeSupported,
  })
}
