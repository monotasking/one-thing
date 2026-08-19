import { AbortScope, Intent } from '@onething/core/toolkit'
import type { Effect, Invocation } from '@onething/core/toolkit'
import { resolvePermissionMessageAnchor } from '../permission/message-anchor.js'
import { createPermissionAuthorizer } from '../toolkit/authorizer.js'
import { ACPManager } from './index.js'
import type { ACPPermissionBridge, ACPPermissionRequestContext } from '@onething/runtime/acp'
import type { JsonObject } from '@shared/json.js'

function toSafeJson(value: unknown): JsonObject | string | undefined {
  if (value === undefined || value === null) return undefined
  try {
    return JSON.parse(JSON.stringify(value)) as JsonObject
  } catch {
    return String(value)
  }
}

function permissionTitle(context: ACPPermissionRequestContext): string {
  if (context.toolCall?.title) return `${context.agentName}: ${context.toolCall.title}`
  return `${context.agentName} 请求执行${context.toolCall?.kind ? ` ${context.toolCall.kind}` : '工具'}`
}

/**
 * Routes ACP agent permission prompts into the app's Permission state
 * machine so they render as normal permission cards (and reach gateway
 * remote approval via targetChannel like every other ask).
 *
 * R4b(§15.5-7):入口从 `Permission.ask({ type: 'external-agent' })` 换成
 * `Authorizer.decide` —— 与本地工具、与 Claude Code SDK 那条通路同一个授权者。
 * 卡片类型不变:`external-agent` 这条效果的 kind 就是它,而卡片标题照旧由
 * `preview.title` 压过策略表的默认文案。
 */
export function registerACPPermissionBridge(): void {
  const bridge: ACPPermissionBridge = async context => {
    const sessionId = context.localSessionId
    if (!sessionId) {
      // Unattributable request: nobody could see or answer the card.
      return { behavior: 'reject' }
    }

    // 提示上下文今天不带 assistant 消息号,而一个渲染侧找不到的锚 = 卡永远不上屏。
    // 判据与 SDK 那条通路共用同一个所有者(`app/permission/message-anchor.ts`)。
    const messageId = resolvePermissionMessageAnchor(sessionId, context.messageId)
    const toolName = context.toolCall?.kind ?? 'tool'
    const effect: Effect = {
      kind: 'external-agent',
      resources: [`${context.agentId}:${toolName}`],
      barrier: true,
      external: true,
      metadata: {
        agentId: context.agentId,
        agentName: context.agentName,
        toolKind: context.toolCall?.kind ?? null,
        toolTitle: context.toolCall?.title ?? null,
        rawInput: toSafeJson(context.toolCall?.rawInput) ?? null,
      },
    }
    const intent = Intent.of({
      payload: undefined,
      effects: [effect],
      preview: { title: permissionTitle(context) },
    })
    const invocation: Invocation = {
      callId: context.toolCall?.toolCallId ?? '',
      toolId: toolName,
      input: context.toolCall?.rawInput,
      sessionId,
      ...(messageId ? { messageId } : {}),
      principal: undefined as never,
      ...(context.cwd ? { cwd: context.cwd, workspaceRoot: context.cwd } : {}),
    }
    try {
      const decision = await createPermissionAuthorizer()
        .decide(intent, invocation, new AbortScope())
      return decision.kind === 'deny' ? { behavior: 'reject' } : { behavior: 'allow' }
    } catch {
      return { behavior: 'reject' }
    }
  }

  ACPManager.setPermissionBridge(bridge)
}
