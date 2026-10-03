/**
 * ACP agent 发来的**请求**(审批 / 读写文件 / 起终端)进许可系统的那一步,三只桥共用
 * (方案 `docs/design/acp-integration-2026-09.md` §3.5 / §11.3 A3-a、A3-b)。
 *
 * 为什么抽出来:三只桥问的是同一个许可系统、同一张卡,差别只在「效果是什么」。调用坐标
 * (会话、消息锚、目录)与授权者(桌面等人答 / server 与 daemon 没人答就拒)若各写一份,
 * 早晚在某一格上分岔 —— 同一台 agent 的读文件与跑命令在同一台宿主上就会长成两种等法。
 */
import { AbortScope, Intent } from '@onething/backend/runtime/toolkit/tool-protocol'
import type { Authorizer, Decision, Invocation, Preview } from '@onething/backend/runtime/toolkit/tool-protocol'
import type { Effect } from '@shared/toolkit/effects'
import { resolvePermissionMessageAnchor } from '@onething/backend/runtime/permissions/message-anchor'
import { createPermissionAuthorizer } from '@onething/backend/runtime/toolkit/authorizer'
import { enforcePermissionPolicyRejectingUnanswered } from '@onething/backend/runtime/tools/access-control/permission-policy'

/**
 * 卡没人答时怎么办。`'wait'` = 一直等(有人守着卡的宿主:桌面壳,今天的行为);
 * `'reject'` = 许可系统的无人应答兜底,超时按拒绝收场(server / CLI daemon,A3-b 裁定)。
 */
export type AcpUnansweredPolicy = 'wait' | 'reject'

/** 按宿主的无人应答策略造授权者。每次现造:授权者读的是当下的设置(per-tool 表)。 */
export function acpAuthorizerFor(unanswered: AcpUnansweredPolicy): () => Authorizer {
  return unanswered === 'reject'
    ? () => createPermissionAuthorizer({ enforce: enforcePermissionPolicyRejectingUnanswered })
    : () => createPermissionAuthorizer()
}

export interface AcpAskInput {
  localSessionId: string
  messageId?: string
  cwd?: string
  /** 卡片的 callId;没有 agent 给的 toolCallId 时由调用方铸一个(无人应答兜底按它找卡)。 */
  callId: string
  /** 权限核里的「工具名」(卡片 metadata 与 per-tool 设置表按它认)。 */
  toolId: string
  input?: unknown
  effects: Effect[]
  preview: Preview
}

/**
 * 摆好 `Intent` + `Invocation`,交给授权者。
 *
 * `principal` 与审批桥(A3-a)同口径地留空:主体维度下的 grant / 能力覆盖是给 onething 自己的
 * agent 用的,外部 agent 的请求今天按会话记 grant,换一个主体就会让「始终允许」对不上。
 */
export async function authorizeAcpRequest(authorizer: Authorizer, input: AcpAskInput): Promise<Decision> {
  // 锚:卡片挂在这一轮的助手消息上;那条消息渲染侧拿不到时由锚的唯一所有者兜底。
  const messageId = resolvePermissionMessageAnchor(input.localSessionId, input.messageId)
  const intent = Intent.of({ payload: undefined, effects: input.effects, preview: input.preview })
  const invocation: Invocation = {
    callId: input.callId,
    toolId: input.toolId,
    input: input.input,
    sessionId: input.localSessionId,
    ...(messageId ? { messageId } : {}),
    principal: undefined as never,
    ...(input.cwd ? { cwd: input.cwd, workspaceRoot: input.cwd } : {}),
  }
  return authorizer.decide(intent, invocation, new AbortScope())
}
