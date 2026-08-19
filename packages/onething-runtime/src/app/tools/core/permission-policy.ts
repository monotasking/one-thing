import * as PermissionGrants from '../../permission/permission-grants.js'
import { Permission } from '../../permission/index.js'
import { isSessionUnattended } from '../../permission/unattended.js'
import {
  createOnethingPermissionRuntime,
} from '@onething/runtime/permissions'
import * as store from '../../store.js'
import { sessionReads } from '../../session/reads.js'
import { isSystemInternalOrigin, latestRealOrigin } from '../../channel/origin.js'
import { writeAppLog } from '../../logging/index.js'
import type {
  EnforcePermissionPolicyInput,
  PermissionPolicyInput,
} from '@onething/runtime/permissions'
import type { MessageOrigin } from '@shared/ipc.js'
import { getLogger } from '../../logging/index.js'

const log = getLogger('permission')


const permissionRuntime = createOnethingPermissionRuntime({
  grantMatcher: PermissionGrants.matchGrant,
  permissionBridge: Permission,
})

export function decidePermission(input: PermissionPolicyInput) {
  return permissionRuntime.decide(input)
}

/**
 * For unattended sessions (radio DJ turns) an interactive prompt is a hang,
 * not a question — nobody is there to click it. Grants still allow; anything
 * that would ask is denied on the spot with an explanation the model can act
 * on.
 */
const unattendedBridge = {
  getMode: (sessionId: string) => Permission.getMode(sessionId),
  ask: async (request: Parameters<typeof Permission.ask>[0]): Promise<void> => {
    throw new Error(
      `此会话无人值守,权限请求被自动拒绝:${request.title}。请改用免审批的白名单命令(如裸 ncm-cli),或把结果写进已授权的目录。`,
    )
  },
}

/**
 * "Unattended" is a property of the TURN, not just the session: the radio
 * session lives in the Music workspace where the user can open it and talk to
 * the DJ directly — those user-driven turns have a human watching, and denying
 * their prompts would be nonsense. Only turns driven by a system-internal
 * message (radio wake, goal kick) in a marked session degrade ask → deny.
 */
function isUnattendedTurn(sessionId: string): boolean {
  if (!isSessionUnattended(sessionId)) return false
  const lastUser = sessionReads.lastMessageOfRole(sessionId, 'user')
  const origin = lastUser?.origin
  // No origin = an internal drive of unknown provenance — stay unattended.
  return !origin || isSystemInternalOrigin(origin)
}

/**
 * System-driven turns outside marked-unattended sessions (goal drives,
 * background continuations): the user may have the session open, so the
 * prompt is still shown — but nobody responding must not hang the run
 * forever. Messages of these turns are stamped with an explicit
 * system-internal origin; normal UI chat (no origin) is untouched.
 */
function isSystemDrivenTurn(sessionId: string): boolean {
  const lastUser = sessionReads.lastMessageOfRole(sessionId, 'user')
  const origin = lastUser?.origin
  return Boolean(origin && isSystemInternalOrigin(origin))
}

const UNATTENDED_ASK_TIMEOUT_MS = 120_000

const timeoutAskBridge = {
  getMode: (sessionId: string) => Permission.getMode(sessionId),
  ask: async (request: Parameters<typeof Permission.ask>[0]): Promise<void> => {
    // Auto-deny through the normal respond path so pending UI prompts are
    // settled (not stranded) and the model gets an actionable rejection.
    const timer = setTimeout(() => {
      const pending = Permission.getPendingPrompts(request.sessionId).find(
        prompt => prompt.callId === request.callId && prompt.messageId === request.messageId,
      )
      if (!pending) return
      Permission.respond({
        sessionId: request.sessionId,
        permissionId: pending.id,
        response: 'reject',
        rejectReason: `无人响应,权限请求在 ${UNATTENDED_ASK_TIMEOUT_MS / 1000} 秒后自动拒绝:${request.title}。请改走免审批路径(白名单命令、已授权目录),或将这一步留给用户并继续其余工作。`,
      })
    }, UNATTENDED_ASK_TIMEOUT_MS)
    try {
      await Permission.ask(request)
    } finally {
      clearTimeout(timer)
    }
  },
}

/**
 * Collab (multi-agent room/work) turns are system-driven — the coordinator's
 * drive stamps a system-internal origin — but a human IS watching: the room
 * UI shows worker permission cards. Routing them through timeoutAskBridge
 * would auto-reject every worker ask after 120s (docs/multi-agent-collab.md
 * D8 blocker), so they wait interactively — with a 30-minute soft reminder
 * posted into the ROOM so a parked ask is discoverable (D8 软提醒).
 */
function isCollabTurn(sessionId: string): boolean {
  const kind = (store.getSession(sessionId) as { kind?: string } | undefined)?.kind
  // 'agent' (W18) is where a room response turn now runs — same system-driven
  // turn, same watching human, so it must not fall into the 120s auto-deny.
  return kind === 'room' || kind === 'work' || kind === 'agent'
}

const COLLAB_ASK_REMINDER_MS = 30 * 60_000

const collabReminderBridge = {
  getMode: (sessionId: string) => Permission.getMode(sessionId),
  ask: async (request: Parameters<typeof Permission.ask>[0]): Promise<void> => {
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const session = store.getSession(request.sessionId) as
            | { id: string; kind?: string; collab?: { roomSessionId?: string } }
            | undefined
          const roomSessionId = session?.kind === 'room' ? session.id : session?.collab?.roomSessionId
          if (!roomSessionId) return
          // Dynamic import: tools/core must not statically depend on the room
          // config door (which reaches the engine through the v3 runtime).
          const { postCollabSystemLine } = await import('../../collab/room-config.js')
          postCollabSystemLine(
            roomSessionId,
            `有一个权限请求已等待 30 分钟未处理:${request.title}(从看板任务卡打开工作会话审批)`,
          )
        } catch (error) {
          log.error('collab permission reminder failed', { sessionId: request.sessionId }, error)
        }
      })()
    }, COLLAB_ASK_REMINDER_MS)
    try {
      await Permission.ask(request)
    } finally {
      clearTimeout(timer)
    }
  },
}

export async function enforcePermissionPolicy(input: EnforcePermissionPolicyInput): Promise<void> {
  const enriched = enrichPermissionInput(input)
  if (isUnattendedTurn(input.sessionId)) {
    await permissionRuntime.enforce({ ...enriched, permissionBridge: unattendedBridge })
    return
  }
  if (isCollabTurn(input.sessionId)) {
    await permissionRuntime.enforce({ ...enriched, permissionBridge: collabReminderBridge })
    return
  }
  if (isSystemDrivenTurn(input.sessionId)) {
    await permissionRuntime.enforce({ ...enriched, permissionBridge: timeoutAskBridge })
    return
  }
  await permissionRuntime.enforce(enriched)
}

function enrichPermissionInput(input: EnforcePermissionPolicyInput): EnforcePermissionPolicyInput {
  const origin = findOriginForPermission(input.sessionId, input.messageId)
  if (!origin) return input

  const userId = input.userId ?? origin.resolvedIdentity?.userId
  const workspaceId = input.workspaceId ?? origin.conversation?.workspaceId ?? origin.replyTarget?.workspaceId
  const metadata = buildPermissionOriginMetadata(origin)

  writeAppLog('info', 'channel.permission', 'Permission request identity context resolved', {
    sessionId: input.sessionId,
    messageId: input.messageId,
    toolName: input.toolName,
    userId,
    workspaceId,
  })

  return {
    ...input,
    userId,
    workspaceId,
    preview: {
      ...(input.preview ?? {}),
      metadata: {
        ...(input.preview?.metadata ?? {}),
        communicationOrigin: metadata,
      },
    },
  }
}

function findOriginForPermission(sessionId: string, messageId: string): MessageOrigin | undefined {
  const messages = sessionReads.listMessages(sessionId).messages
  if (!messages.length) return undefined

  // Goal-driven runs stamp their messages with an identity-less internal
  // origin; permission scoping must attach to the real user behind the
  // session, so skip those and fall through to the latest real origin.
  const directMessage = messages.find(message => message.id === messageId)
  if (directMessage?.origin && !isSystemInternalOrigin(directMessage.origin)) {
    return directMessage.origin
  }

  return latestRealOrigin(messages)
}

function buildPermissionOriginMetadata(origin: MessageOrigin): Record<string, unknown> {
  return {
    transport: origin.transport,
    source: origin.source,
    connector: origin.conversation?.connector ?? origin.replyTarget?.connector,
    workspaceId: origin.conversation?.workspaceId ?? origin.replyTarget?.workspaceId,
    conversationId: origin.conversation?.externalConversationId ?? origin.replyTarget?.externalConversationId,
    conversationType: origin.conversation?.type,
    threadId: origin.conversation?.threadId ?? origin.replyTarget?.threadId,
    externalMessageId: origin.externalMessageId ?? origin.replyTarget?.externalMessageId,
    identityKind: origin.resolvedIdentity?.kind,
    identityUserId: origin.resolvedIdentity?.userId,
  }
}

export type {
  EnforcePermissionPolicyInput,
  PermissionEffect,
  PermissionGrantMatcher,
  PermissionBridge,
  PermissionMetadata,
  PermissionPolicyDecision,
  PermissionPolicyInput,
  PermissionPolicyMode,
  PermissionPolicyResult,
  PermissionPreview,
} from '@onething/runtime/permissions'
