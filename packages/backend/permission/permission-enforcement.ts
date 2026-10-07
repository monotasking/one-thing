import * as PermissionGrants from './permission-grant-storage.js'
import type { PermissionBridge } from './permission-asks.js'
import { Permission } from './permission-with-grant-storage.js'
import { isHostUnattended, isSessionUnattended, unansweredAskDeadlineMs } from './permission-unattended.js'
import {
  createOnethingPermissionRuntime,
} from './permission-runtime.js'
import * as store from '@onething/backend/session'
import { sessionReads } from '@onething/backend/session'
import { isSystemInternalOrigin, latestRealOrigin } from '@onething/backend/agent-loop'
import { writeAppLog, getLogger } from '@onething/backend/logging'
import { getEventBus } from '@onething/backend/event'
import type {
  EnforcePermissionPolicyInput,
  PermissionPolicyInput,
} from './permission-asks.js'
import type { MessageOrigin } from '@shared/ipc.js'

const log = getLogger('permission')


/**
 * 权限运行时的持有器:**第一次判权限时才建**(2026-10-04,`docs/design/provider-entry-2026-10.md` §7.6)。
 * 从前在加载时建,要把 `grant-storage` 的 `matchGrant` 与 `Permission` 命名空间读进选项对象;本模块一旦落在
 * import 环上被先求值,两者读到的会是 `undefined`,而且不抛(`decide` 有 `?? matchGrant` 兜底,不带桥的 `enforce`
 * 会静默拿到一个没有桥的运行时)。等价理由:`createOnethingPermissionRuntime` 只是 `new OnethingPermissionRuntime(options)`,
 * 构造函数只把选项存进私有字段,不读设置、不碰磁盘、不起计时器;`matchGrant` 是函数声明的导出、`Permission` 是模块级
 * 命名空间对象,两者都从不被重新赋值,所以首次调用时读到的与从前加载时读到的是同一个函数、同一个对象;建一次以后
 * 同一只一直用。第一次用到在权限判定的调用里,那时装配早已完成,装配顺序不动。
 */
const permissionRuntimeHolder: { current?: ReturnType<typeof createOnethingPermissionRuntime> } = {}
function permissionRuntime(): ReturnType<typeof createOnethingPermissionRuntime> {
  return (permissionRuntimeHolder.current ??= createOnethingPermissionRuntime({
    grantMatcher: PermissionGrants.matchGrant,
    permissionBridge: Permission,
  }))
}

export function decidePermission(input: PermissionPolicyInput) {
  return permissionRuntime().decide(input)
}

/**
 * For unattended sessions (radio DJ turns) an interactive prompt is a hang,
 * not a question — nobody is there to click it. Grants still allow; anything
 * that would ask is denied on the spot with an explanation the model can act
 * on.
 */
const unattendedBridge: PermissionBridge = {
  getMode: (sessionId: string) => Permission.getMode(sessionId),
  ask: async (request: Parameters<typeof Permission.ask>[0]): Promise<never> => {
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

/**
 * 「问了没人答」等多久按拒绝收场。缺省 120s;`ONETHING_UNATTENDED_ASK_TIMEOUT_MS` 只为真机门
 * 把它压短(`gate:acp` ⑯ 用 2000),**全仓只有这一处读它**,缺省不变。
 */
const UNATTENDED_ASK_TIMEOUT_MS = readUnattendedAskTimeoutMs()

function readUnattendedAskTimeoutMs(): number {
  const raw = Number(process.env.ONETHING_UNATTENDED_ASK_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 120_000
}

/**
 * 「问了,但过了这么久还没人答,就按拒绝收场」的那一类桥。
 *
 * 收场走的是**正常的 respond 路**,不是就地抛:挂在 UI 上的那张卡因此是被答掉的
 * (settled),不是被遗弃的(stranded),而模型拿到的是一条可以据以改做法的拒绝。
 *
 * 抽成工厂是 K4-d 顺手做的:下面两位调用者的差别只有「等多久」与「怎么跟人解释」,
 * 计时 / 找卡 / 答卡那三步一个字不差。两份手抄的同一段逻辑早晚在某一格上分岔,
 * 而没有任何一道门会红。
 */
function createAutoDenyBridge(
  timeoutMs: number,
  rejectReasonOf: (request: Parameters<typeof Permission.ask>[0]) => string,
): PermissionBridge {
  return {
    getMode: (sessionId: string) => Permission.getMode(sessionId),
    ask: async (request: Parameters<typeof Permission.ask>[0]): Promise<Permission.Response | undefined> => {
      const timer = setTimeout(() => {
        const pending = Permission.getPendingPrompts(request.sessionId).find(
          prompt => prompt.callId === request.callId && prompt.messageId === request.messageId,
        )
        if (!pending) return
        Permission.respond({
          sessionId: request.sessionId,
          permissionId: pending.id,
          response: 'reject',
          rejectReason: rejectReasonOf(request),
        })
      }, timeoutMs)
      try {
        return await Permission.ask(request)
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

const timeoutAskBridge = createAutoDenyBridge(
  UNATTENDED_ASK_TIMEOUT_MS,
  request => `无人响应,权限请求在 ${UNATTENDED_ASK_TIMEOUT_MS / 1000} 秒后自动拒绝:${request.title}。请改走免审批路径(白名单命令、已授权目录),或将这一步留给用户并继续其余工作。`,
)

/**
 * 无人值守的**宿主**上,`system` 主体发起的 ask 在 60 秒后自动拒(K4-d)。
 *
 * ## 它补的是哪个洞
 *
 * (第④步批 3 之前)CLI 守护进程那条 60 秒降级**接在 `chat.ask` 的
 * 活流上** —— 有流才有那只计时器。经 `onething mcp` 桥进来的资源 `do`
 * 没有流:它不是任何一条会话的回合,`isUnattendedTurn` / `isSystemDrivenTurn` 都
 * 判不到它(那两位读的是「最后一条用户消息的 origin」,而这里根本没有那条消息),
 * 于是一张需要审批的卡在无人值守的进程里**永远** pending —— 这正是 K4-c 的留账 1。
 *
 * 判据两条,都是既有事实,不新发明身份:
 *  - `principal.kind === 'system'` —— 发起的不是这台机器前面那个人(桥经请求头
 *    `X-Onething-Acting-System` 把主体降成 `system`,见 `http-server/http-server-principal.ts`);
 *  - `isHostUnattended()` —— **宿主装配时自己声明**过这台进程上没人能答卡
 *    (今天只有 CLI 拉起的后端 —— `ONETHING_BACKEND_LAUNCHER=cli` 那一档 —— 说这句话)。桌面不说,所以它照旧弹卡给人答;
 *    为什么不拿宿主能力 / `isHostLocallyTrusted()` 反推,理由写在
 *    `permission/permission-unattended.ts` 那半的头注上。
 *
 * ## 它排在最后一位
 *
 * 前三条各自管着一类**回合**,而这一条管的是**调用方**;把它排到前面就会顺手改掉
 * 那三条今天的行为 —— 尤其群房那条(`isCollabTurn`)是明确要求「无限等」的
 * (docs/multi-agent-collab.md D8),被 60 秒抢走等于把那条判例推翻。排在最后 =
 * 只接住今天真的没人管的那一支。
 *
 * 与桥自己那 60 秒的先后:`apps/cli/src/mcp-command.ts` 的 `DO_TIMEOUT_MS` 也是
 * 60 秒,但它**只能停止等待,答不了卡**。两边同一个数,谁先跑赢由调度决定,而
 * 结局在两种次序下都是对的:桥先超时 → 它回一句「需要审批,无人应答」,这里稍后
 * 把卡答掉,daemon 里不留 pending;这里先答掉 → 桥收到的是一条正常的 `denied`
 * 结局。桥那 60 秒从此是**双保险**,不再是唯一的止损。
 */
const UNATTENDED_HOST_ASK_TIMEOUT_MS = 60_000

const unattendedHostBridge = createAutoDenyBridge(
  UNATTENDED_HOST_ASK_TIMEOUT_MS,
  request => `no one is attending this host: a permission prompt has nobody to answer it, so "${request.title}" was auto-denied after ${UNATTENDED_HOST_ASK_TIMEOUT_MS / 1000}s. Ask the person at the machine to run it, or use an action that needs no approval.`,
)

/** 这次调用是「无人值守的宿主上,一个 system 主体在敲门」。 */
function isUnattendedHostSystemCall(principal: EnforcePermissionPolicyInput['principal']): boolean {
  return principal?.kind === 'system' && isHostUnattended()
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

const collabReminderBridge: PermissionBridge = {
  getMode: (sessionId: string) => Permission.getMode(sessionId),
  ask: async (request: Parameters<typeof Permission.ask>[0]): Promise<Permission.Response | undefined> => {
    const timer = setTimeout(() => {
      try {
        // D202:只发一条全局事实,往协作房间喊话是 collab 自己装的监听器的事
        // (从前这里动态 import 协作的房间配置 —— 授权层够协作层,动态 import 只是把越层藏了起来)。
        getEventBus().emitGlobal({
          type: 'permission:ask-stale',
          sessionId: request.sessionId,
          title: request.title,
          elapsedMs: COLLAB_ASK_REMINDER_MS,
        })
      } catch (error) {
        log.error('collab permission reminder failed', { sessionId: request.sessionId }, error)
      }
    }, COLLAB_ASK_REMINDER_MS)
    try {
      return await Permission.ask(request)
    } finally {
      clearTimeout(timer)
    }
  },
}

/** 返回人答了什么(按问的先后,没问过人 = 空);拒绝照旧是抛。 */
export async function enforcePermissionPolicy(input: EnforcePermissionPolicyInput): Promise<Permission.Response[]> {
  const enriched = enrichPermissionInput(input)
  if (isUnattendedTurn(input.sessionId)) {
    return permissionRuntime().enforce({ ...enriched, permissionBridge: unattendedBridge })
  }
  if (isCollabTurn(input.sessionId)) {
    return permissionRuntime().enforce({ ...enriched, permissionBridge: collabReminderBridge })
  }
  if (isSystemDrivenTurn(input.sessionId)) {
    return permissionRuntime().enforce({ ...enriched, permissionBridge: timeoutAskBridge })
  }
  // 最后一位:不是回合的事,是调用方的事(理由写在 `unattendedHostBridge` 头上)。
  if (isUnattendedHostSystemCall(input.principal)) {
    return permissionRuntime().enforce({ ...enriched, permissionBridge: unattendedHostBridge })
  }
  // 宿主声明过「卡最多等这么久」(第④步批 3:CLI 拉起的那台后端,60 秒):到点按拒绝收场,任何主体都一样。
  const deadlineMs = unansweredAskDeadlineMs()
  if (deadlineMs !== undefined) {
    return permissionRuntime().enforce({ ...enriched, permissionBridge: hostDeadlineBridge(deadlineMs) })
  }
  return permissionRuntime().enforce(enriched)
}

/** 宿主期限那一类桥:计时 / 找卡 / 答卡与另外两位同一只工厂,只差期限与措辞。 */
function hostDeadlineBridge(timeoutMs: number): PermissionBridge {
  return createAutoDenyBridge(
    timeoutMs,
    request => `nobody answered this permission prompt within ${timeoutMs / 1000}s, so "${request.title}" was auto-denied. Run the step again and answer the prompt, or use an action that needs no approval.`,
  )
}

/**
 * 与 {@link enforcePermissionPolicy} 同一条判定链,只差最后一格:**普通回合的卡没人答,
 * {@link UNATTENDED_ASK_TIMEOUT_MS} 后按拒绝收场**(走的是 respond 路,卡被答掉而不是被遗弃)。
 *
 * 谁用它:没有人一定守着卡的宿主(server / CLI daemon)上,ACP agent 发来的审批 / 文件 / 终端
 * 请求(方案 `docs/design/acp-integration-2026-09.md` §11.3 A3-b「桥在三个宿主上都注册」)。
 * 从前这两台宿主根本不挂桥,agent 的请求到不了许可系统,由客户端按 `unattended` 直接答;
 * 挂了桥之后卡能上屏(连着 server 的浏览器壳看得见、答得了),但没人看的时候不能让 agent
 * 永远挂在那里 —— 这一格就是「无桥缺省拒」改口成「无人应答缺省拒」之后的同一个结论。
 *
 * 前三格一字不动:无人值守回合照旧当场拒,群房照旧无限等,系统驱动回合本来就是这个超时。
 * 桌面壳不用它(那里有人看卡,今天的卡怎么等,A3-b 之后还怎么等)。
 */
export async function enforcePermissionPolicyRejectingUnanswered(
  input: EnforcePermissionPolicyInput,
): Promise<Permission.Response[]> {
  const enriched = enrichPermissionInput(input)
  if (isUnattendedTurn(input.sessionId)) {
    return permissionRuntime().enforce({ ...enriched, permissionBridge: unattendedBridge })
  }
  if (isCollabTurn(input.sessionId)) {
    return permissionRuntime().enforce({ ...enriched, permissionBridge: collabReminderBridge })
  }
  return permissionRuntime().enforce({ ...enriched, permissionBridge: timeoutAskBridge })
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
} from './permission-asks.js'
