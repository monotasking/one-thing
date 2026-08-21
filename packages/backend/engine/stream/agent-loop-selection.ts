import type { AppSettings } from '@shared/ipc.js'
import {
  ONETHING_AGENT_LOOP_STREAM_ENV,
  resolveOnethingAgentLoopStreamRoute,
  shouldUseOnethingAgentLoopStream,
  type AgentLoopStreamEnabledBy,
  type AgentLoopStreamRoute,
  type OnethingAgentLoopStreamSelectionContext,
} from '@onething/runtime/agent-loop'

export const AGENT_LOOP_STREAM_ENV = ONETHING_AGENT_LOOP_STREAM_ENV
export type { AgentLoopStreamEnabledBy, AgentLoopStreamRoute }

export interface AgentLoopStreamSelectionContext
  extends Omit<OnethingAgentLoopStreamSelectionContext, 'settings'> {
  providerId: string
  settings?: {
    chat?: Partial<AppSettings['chat']>
  }
}

export function resolveAgentLoopStreamRoute(ctx: AgentLoopStreamSelectionContext): AgentLoopStreamRoute {
  return resolveOnethingAgentLoopStreamRoute(ctx)
}

export function shouldUseAgentLoopStream(ctx: AgentLoopStreamSelectionContext): boolean {
  return shouldUseOnethingAgentLoopStream(ctx)
}
