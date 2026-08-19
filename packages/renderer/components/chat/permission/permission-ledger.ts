/**
 * 权限账页栏位的**纯逻辑** —— 去复用重构 R1(docs/design/im-workbench-layout.md §8 铁律 1)。
 *
 * 这一份是从 `ChatPanel.vue` 原地抬出来的,**一个字段都没改**:栏位读什么、
 * scope 档位怎么给、哪些工具不许给 workspace 档,全部逐字搬运。抬出来的唯一
 * 理由是「房面不再经过 ChatPanel」——旧壳与新面必须共用同一份判定,否则
 * 「审批语义零变化」就只能靠人眼比对两份拷贝。
 *
 * 纪律:这里不许出现第二种口径。要改栏位语义就改这一个文件,两处同时生效。
 */
import type { ToolCall } from '@/types'
import { buildToolActivityTarget, buildToolPermissionTitle } from '@/stores/helpers/tool-display'

export type PermissionResponse = 'once' | 'session' | 'workdir'

export interface PermissionScopeOption {
  value: PermissionResponse
  label: string
  hint: string
}

export function permissionTitle(toolCall: ToolCall): string {
  return buildToolPermissionTitle(toolCall)
}

export function permissionTool(toolCall: ToolCall): string {
  return String(toolCall.toolName || toolCall.toolId || 'tool').trim().toLowerCase()
}

// The ledger splits what the title fuses: `target` is the thing being acted
// on, so drop the leading verb the permission title prepends ("Write <path>").
export function permissionTarget(toolCall: ToolCall): string {
  const args = (toolCall.arguments || {}) as Record<string, unknown>
  const direct = args.path ?? args.file_path ?? args.command ?? toolCall.changes?.filePath
  if (direct) return String(direct).replace(/\s*\n\s*/g, ' ')
  const activityTarget = buildToolActivityTarget(toolCall.toolName || toolCall.toolId, toolCall)
  if (activityTarget) return activityTarget
  const title = buildToolPermissionTitle(toolCall)
  const [, remainder] = title.match(/^\S+\s+(.+)$/) || []
  return remainder || title
}

export function permissionDetailKey(toolCall: ToolCall): string {
  return toolCall.changes ? 'diff' : 'detail'
}

export function permissionPreview(toolCall: ToolCall): string {
  if (toolCall.changes) return `+${toolCall.changes.additions || 0} -${toolCall.changes.deletions || 0}`
  // The command already fills the `target` row for bash — don't print it twice.
  return ''
}

export function canAllowWorkspace(toolCall: ToolCall): boolean {
  const permissionType = String((toolCall as any).permissionType || toolCall.arguments?.permissionType || '')
  const name = (toolCall.toolName || toolCall.toolId || '').toLowerCase()
  // Sensitive file reads should not be granted workspace-wide in the first scope UX.
  if (permissionType === 'sensitive_file_read') return false
  // Repointing a capability is always a one-time answer — core refuses to turn
  // it into a standing grant, so never offer the button either.
  if (permissionType === 'capability_change') return false
  if (name === 'read' && /\.env|\.pem$|\.key$|\.p12$|\.pfx$/i.test(permissionTitle(toolCall))) return false
  return true
}

/**
 * Collab 会话(room/work)的授权面收窄为仅 once:workspace 级 grant 只按
 * {type, pattern, workspaceRoot} 匹配、无 agent/任务维度——在多 agent 语境下
 * 批一次 = 该目录所有 agent 的所有未来任务全免检(docs/multi-agent-collab.md
 * D8)。房间/任务维度的 grant 是 P2,做好才放开。
 */
export function buildScopeOptions(
  toolCall: ToolCall | null | undefined,
  options: { collabScopeOnly?: boolean } = {},
): PermissionScopeOption[] {
  const list: PermissionScopeOption[] = [
    { value: 'once', label: 'once', hint: 'Allow this call only' },
  ]
  if (options.collabScopeOnly) return list
  list.push({ value: 'session', label: 'session', hint: 'Allow for this session' })
  if (toolCall && canAllowWorkspace(toolCall)) {
    list.push({ value: 'workdir', label: 'workspace', hint: 'Allow in this workspace' })
  }
  return list
}

/**
 * 「有多少个调用排在这次审批后面」—— 栏位脚注那句话的唯一算法。
 *
 * 判定与 `currentPendingPermission` 同源:按消息顺序走到待审批的那一条之后,
 * 收 `status === 'queued'` 的工具调用。
 */
export function countQueuedBehind(
  messages: Array<{ toolCalls?: ToolCall[] }>,
  pending: ToolCall | null | undefined,
): number {
  if (!pending) return 0
  let queued = 0
  let seenPending = false
  for (const message of messages) {
    for (const toolCall of message.toolCalls || []) {
      if (toolCall.id === pending.id) {
        seenPending = true
        continue
      }
      if (seenPending && toolCall.status === 'queued') queued += 1
    }
  }
  return queued
}

/** 判定「这次调用现在能应答吗」只需要这两个字段。 */
export type RespondableToolCall = Pick<ToolCall, 'requiresConfirmation' | 'canRespond'>

/**
 * 这条消息里可应答的那一次调用 —— 「可应答」的唯一谓词。
 *
 * Actionability needs both truths: `requiresConfirmation` is persisted engine
 * history, `canRespond` marks a live emitted prompt in the permission manager
 * (set from permission events / the pending seed). Either alone renders a
 * card that can't be answered — stale after restart, or a queued follower.
 */
export function findRespondableToolCall<T extends RespondableToolCall>(
  message: { toolCalls?: T[] },
): T | null {
  return message.toolCalls?.find(tc => tc.requiresConfirmation && tc.canRespond) ?? null
}

/** 整段消息流里最先可应答的那一次调用。 */
export function findPendingPermission(
  messages: Array<{ toolCalls?: ToolCall[] }>,
): ToolCall | null {
  for (const message of messages) {
    const toolCall = findRespondableToolCall(message)
    if (toolCall) return toolCall
  }
  return null
}
