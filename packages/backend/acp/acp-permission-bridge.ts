import type { Decision, Authorizer } from '@onething/backend/toolkit'
import type { Effect } from '@shared/toolkit/effects'
import type { Permission } from '@onething/backend/permission'
import { ACPManager } from './acp-manager.js'
import { describeAcpToolPermission } from '@onething/backend/external-agent'
import type {
  ACPPermissionBridge,
  ACPPermissionDecision,
  ACPPermissionOptionInfo,
  ACPPermissionRequestContext,
} from './acp-types.js'
import { getLogger } from '@onething/backend/logging'
import { createAcpAuthBridge, type AcpAuthBridgeDeps } from './acp-auth-bridge.js'
import { createAcpElicitationBridge, type AcpElicitationBridgeDeps } from './acp-elicitation-bridge.js'
import { createAcpFsBridge } from './acp-fs-bridge.js'
import { acpAuthorizerFor, authorizeAcpRequest, type AcpUnansweredPolicy } from './acp-request-authorize.js'
import { createAcpTerminalBridge, type AcpTerminalServicePort } from './acp-terminal-bridge.js'

const log = getLogger('acp.permission')

function permissionTitle(context: ACPPermissionRequestContext): string {
  if (context.toolCall?.title) return `${context.agentName}: ${context.toolCall.title}`
  return `${context.agentName} 请求执行${context.toolCall?.kind ? ` ${context.toolCall.kind}` : '工具'}`
}

/** ACP `PermissionOptionKind` → 卡上那一钮的 kind。认不出的 kind 不画(agent 没给的也不画)。 */
const CHOICE_KIND_OF_OPTION: Record<string, Permission.Choice['kind']> = {
  allow_once: 'once',
  allow_always: 'always',
  reject_once: 'reject',
  reject_always: 'reject-always',
}

/** agent 的 options 原样上卡:id = optionId(答回去用),label = agent 给的原话。 */
export function choicesFromAcpOptions(options: readonly ACPPermissionOptionInfo[]): Permission.Choice[] {
  const choices: Permission.Choice[] = []
  for (const option of options) {
    const kind = CHOICE_KIND_OF_OPTION[option.kind]
    if (kind) choices.push({ id: option.optionId, kind, label: option.name })
  }
  return choices
}

function optionOf(options: readonly ACPPermissionOptionInfo[], kind: string): ACPPermissionOptionInfo | undefined {
  return options.find(option => option.kind === kind)
}

function select(option: ACPPermissionOptionInfo | undefined): ACPPermissionDecision | undefined {
  return option ? { behavior: 'select', optionId: option.optionId } : undefined
}

/**
 * 我们的结论 → agent 的 optionId(方案 §3.5 / §11.3 A3-a)。
 *
 * - `always`(问到的每一条都答了 always)→ `allow_always`,没有就 `allow_once`;我们这边的
 *   grant 已由内核 `respond('always')` 落盘。
 * - `once` / `session` / `workdir` / 没问人(grant 命中、白名单)→ `allow_once`:后两种是
 *   onething 自己的记忆,下一次同效果的请求在授权者那里就放行,不再上卡;告诉 agent
 *   `allow_always` 等于替用户在 agent 那边也落一条规则,用户没这么说。
 * - `reject` → `reject_once`;`reject-always` → `reject_always`(没有就 `reject_once`)。
 * - 找不到对应那一格:放行一侧答 `cancel`(绝不拿 always 顶替 once),拒绝一侧交回
 *   客户端的缺省拒(`reject_once` 或 cancelled)。
 */
export function acpDecisionFor(
  decision: Decision,
  options: readonly ACPPermissionOptionInfo[],
): ACPPermissionDecision {
  if (decision.kind === 'deny') {
    const chosen = decision.rejectAlways
      ? select(optionOf(options, 'reject_always') ?? optionOf(options, 'reject_once'))
      : select(optionOf(options, 'reject_once'))
    return chosen ?? { behavior: 'reject' }
  }
  const answers = decision.answers ?? []
  const always = answers.length > 0 && answers.every(answer => answer === 'always')
  const chosen = always
    ? select(optionOf(options, 'allow_always') ?? optionOf(options, 'allow_once'))
    : select(optionOf(options, 'allow_once'))
  return chosen ?? { behavior: 'cancel' }
}

/** 「始终拒绝」在我们这边的会话级记忆按这把钥匙认「同一件事」:agent × 每条效果的类与资源。 */
function rejectSignature(agentId: string, effects: readonly Effect[]): string {
  return JSON.stringify([agentId, effects.map(effect => [effect.kind, [...effect.resources]])])
}

export interface ACPPermissionBridgeOptions {
  /** 测试用;缺省 = 桌面 / 服务端的成品授权者(真权限核 + 用户 per-tool 设置)。 */
  authorizer?: () => Authorizer
  /**
   * 卡没人答时怎么办(A3-b)。缺省 `'wait'` = 一直等(桌面壳:有人守着卡,行为不变);
   * server 与 CLI daemon 传 `'reject'` —— 许可系统的无人应答兜底,超时按拒绝收场。
   * 文件桥与终端桥用同一个授权者,三种请求在一台宿主上等法一样。
   */
  unanswered?: AcpUnansweredPolicy
  /** 测试用:终端桥的服务与「有没有终端输出通道」。 */
  terminal?: { service?: () => AcpTerminalServicePort; available?: () => boolean }
  /** 测试用:登录桥 / 提问桥的外部件(A3-c)。 */
  auth?: AcpAuthBridgeDeps
  elicitation?: AcpElicitationBridgeDeps
}

/**
 * Routes ACP agent permission prompts into the app's Permission state
 * machine so they render as normal permission cards (and reach gateway
 * remote approval via targetChannel like every other ask).
 *
 * A3-a(方案 §3.5 / §11.3):
 *  - 效果不再是一条 `external-agent`,而是 `describeAcpToolPermission` 按 `kind` + `rawInput`
 *    + `locations` 算出的与本地工具同形的效果(`execute` → bash 命令级,`read` → 路径 / 敏感
 *    文件,`edit` / `delete` / `move` → 文件写);认不出的才退回 `external-agent`。
 *  - agent 的 options 作为 `choices` 原样上卡;人答哪一种,由 `Decision.answers` /
 *    `rejectAlways` 带回来,再映射成 agent 的 optionId(`acpDecisionFor`)。
 *  - 「始终拒绝」在我们这边记一份会话级拒绝:同一会话里同一 agent 的同一件事,不再上卡,
 *    直接答拒。
 */
export function registerACPPermissionBridge(options: ACPPermissionBridgeOptions = {}): () => void {
  const authorizerOf = options.authorizer ?? acpAuthorizerFor(options.unanswered ?? 'wait')
  const rejectedForSession = new Map<string, Set<string>>()

  const bridge: ACPPermissionBridge = async context => {
    const sessionId = context.localSessionId
    if (!sessionId) {
      // Unattributable request: nobody could see or answer the card.
      return { behavior: 'reject' }
    }
    // 用户对这一台显式打开了「无人应答时自动放行」:前置放行,不进 ask(A3-b 裁定;
    // 客户端据 `allow` 只答 `allow_once`,永不自动选 `allow_always`)。
    if (context.unattended === 'allow') return { behavior: 'allow' }

    const toolKind = context.toolCall?.kind ?? 'tool'
    const shape = describeAcpToolPermission({
      kind: context.toolCall?.kind,
      name: context.toolCall?.title,
      rawInput: context.toolCall?.rawInput,
      locations: context.toolCall?.locations,
      cwd: context.cwd,
      agentId: context.agentId,
      agentName: context.agentName,
    })

    const signature = rejectSignature(context.agentId, shape.effects)
    if (rejectedForSession.get(sessionId)?.has(signature)) {
      return select(optionOf(context.options, 'reject_once')) ?? { behavior: 'reject' }
    }

    const choices = choicesFromAcpOptions(context.options)
    try {
      // 锚与调用坐标由三只桥共用的那一步摆(连接器把回合的 assistant 消息号经
      // `promptContexts` 递到这里;渲染侧找不到的锚由锚的唯一所有者兜底)。
      const decision = await authorizeAcpRequest(authorizerOf(), {
        localSessionId: sessionId,
        messageId: context.messageId,
        cwd: context.cwd,
        callId: context.toolCall?.toolCallId ?? '',
        toolId: toolKind,
        input: context.toolCall?.rawInput,
        effects: shape.effects,
        preview: {
          ...(shape.preview ?? {}),
          title: permissionTitle(context),
          metadata: {
            // 卡片长得和本地一样之后,这两格就是唯一的出处标记。
            agentId: context.agentId,
            agentName: context.agentName,
            toolKind: context.toolCall?.kind ?? null,
            toolTitle: context.toolCall?.title ?? null,
            ...(shape.preview?.metadata ?? {}),
          },
          ...(choices.length > 0 ? { choices } : {}),
        },
      })
      if (decision.kind === 'deny' && decision.rejectAlways) {
        let rejected = rejectedForSession.get(sessionId)
        if (!rejected) rejectedForSession.set(sessionId, rejected = new Set())
        rejected.add(signature)
      }
      return acpDecisionFor(decision, context.options)
    } catch (error) {
      log.warn('acp permission decide failed, rejecting', { agentId: context.agentId, sessionId }, error)
      return { behavior: 'reject' }
    }
  }

  /*
   * 文件桥与终端桥与审批桥同批挂(A3-b):三者是同一件事 ——「这台宿主怎么答 agent 的请求」——
   * 用同一个授权者、同一种无人应答策略。宿主调一次这里就全有,壳那一行不用改。
   */
  const fsBridge = createAcpFsBridge({ authorizer: authorizerOf })
  const terminalBridge = createAcpTerminalBridge({
    authorizer: authorizerOf,
    ...(options.terminal?.service ? { service: options.terminal.service } : {}),
    ...(options.terminal?.available ? { available: options.terminal.available } : {}),
  })
  /*
   * 登录桥与提问桥(A3-c)同批挂:它们也是「这台宿主怎么答 agent」—— 提问落交互卡(没人答由
   * 交互内核自己的 deadline 收场),登录跑在同一个终端服务里。挂上了,握手才声明
   * `auth.terminal` / `elicitation`。
   */
  const authBridge = createAcpAuthBridge({
    ...(options.terminal?.available ? { terminalAvailable: options.terminal.available } : {}),
    ...(options.auth ?? {}),
  })
  const elicitationBridge = createAcpElicitationBridge(options.elicitation)
  ACPManager.setPermissionBridge(bridge)
  ACPManager.setFsBridge(fsBridge)
  ACPManager.setTerminalBridge(terminalBridge)
  ACPManager.setAuthBridge(authBridge)
  ACPManager.setElicitationBridge(elicitationBridge)
  // 只摘自己挂上的那几只:别的宿主后来换过桥,这里不去拆它。
  return () => {
    rejectedForSession.clear()
    if (ACPManager.getPermissionBridge() === bridge) ACPManager.setPermissionBridge(undefined)
    if (ACPManager.getFsBridge() === fsBridge) ACPManager.setFsBridge(undefined)
    if (ACPManager.getTerminalBridge() === terminalBridge) ACPManager.setTerminalBridge(undefined)
    if (ACPManager.getAuthBridge() === authBridge) ACPManager.setAuthBridge(undefined)
    if (ACPManager.getElicitationBridge() === elicitationBridge) ACPManager.setElicitationBridge(undefined)
  }
}
