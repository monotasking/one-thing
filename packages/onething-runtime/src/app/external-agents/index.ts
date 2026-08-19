import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  createClaudeCodeConnector,
  describeExternalToolPermission,
  CLAUDE_CODE_AGENT_CONNECTOR_ID,
} from '@onething/runtime/external-agents'
import type {
  ExternalAgentConnector,
  ExternalAgentInteractionAsk,
  ExternalAgentPermissionAsk,
  ExternalAgentPermissionDecision,
  ExternalAgentSessionLink,
} from '@onething/runtime/external-agents'
import { findAgentExecutorDescriptor } from '@onething/runtime/agents'
import { Interaction } from '@onething/core/interaction'
import type { InteractionAnswer } from '@onething/core/interaction'
import {
  recordExternalAgentTool,
  recordExternalAgentTurn,
} from '../collab/external-observability.js'
import { NO_HUMAN_DECLINE_REASON, noHumanInTheRoom } from '../interaction/no-human.js'
import { getSettings } from '../store.js'
import { resolvePermissionMessageAnchor } from '../permission/message-anchor.js'
import { getStorePath } from '../stores/paths.js'
import { AbortScope, Intent } from '@onething/core/toolkit'
import type { Effect, Invocation } from '@onething/core/toolkit'
import { createPermissionAuthorizer } from '../toolkit/authorizer.js'
import { publishExternalAgentBackgroundStatus } from './background-status.js'
import { resolveClaudeCodeHostToolSurface } from './host-tools.js'
import { consolePort, getLogger } from '../logging/index.js'

const log = getLogger('external-agents')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog = consolePort(log)


export { resolveClaudeCodeHostToolSurface } from './host-tools.js'

// ---------------------------------------------------------------------------
// CLI detection
// ---------------------------------------------------------------------------

const CLAUDE_CANDIDATE_PATHS = [
  join(homedir(), '.local/bin/claude'),
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude',
]

let cachedClaudeExecutable: string | null | undefined

/** Locate the locally installed Claude Code CLI; cached for the process lifetime. */
export function findClaudeExecutable(): string | undefined {
  if (cachedClaudeExecutable !== undefined) return cachedClaudeExecutable ?? undefined
  for (const candidate of CLAUDE_CANDIDATE_PATHS) {
    if (existsSync(candidate)) {
      cachedClaudeExecutable = candidate
      return candidate
    }
  }
  try {
    const resolved = execFileSync('/usr/bin/which', ['claude'], { encoding: 'utf8' }).trim()
    cachedClaudeExecutable = resolved || null
  } catch {
    cachedClaudeExecutable = null
  }
  return cachedClaudeExecutable ?? undefined
}

// ---------------------------------------------------------------------------
// Session link persistence (module-owned; survives app restarts)
// ---------------------------------------------------------------------------

type SessionLinkStore = Record<string, ExternalAgentSessionLink>

function sessionLinksPath(): string {
  return join(getStorePath(), 'external-agents', 'session-links.json')
}

function linkKey(connectorId: string, localSessionId: string): string {
  return `${connectorId}:${localSessionId}`
}

function readSessionLinks(): SessionLinkStore {
  try {
    return JSON.parse(readFileSync(sessionLinksPath(), 'utf8')) as SessionLinkStore
  } catch {
    return {}
  }
}

function writeSessionLinks(store: SessionLinkStore): void {
  const path = sessionLinksPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(store, null, 2), 'utf8')
}

export function resolveExternalAgentSessionLink(
  connectorId: string,
  localSessionId: string,
): ExternalAgentSessionLink | undefined {
  return readSessionLinks()[linkKey(connectorId, localSessionId)]
}

export function persistExternalAgentSessionLink(link: ExternalAgentSessionLink): void {
  const store = readSessionLinks()
  store[linkKey(link.connectorId, link.localSessionId)] = link
  writeSessionLinks(store)
}

// ---------------------------------------------------------------------------
// Permission bridge
// ---------------------------------------------------------------------------

/**
 * 外部 agent 的审批桥(E4,G1+G2)。
 *
 * ## 为什么改走策略门
 *
 * 从前这里直调 `Permission.ask`,于是**绕开了 `enforcePermissionPolicy`** ——
 * 而那扇门才是超时兜底的所在地:
 *
 *  - 系统驱动的回合走 `timeoutAskBridge`:120s 无人应答**自动拒绝**,并且是从
 *    正常的 respond 路径拒绝(pending 卡被结算掉,而不是留在界面上变成孤儿);
 *  - 协作回合走 `collabReminderBridge`:不自动拒(房里有人在看),但 30 分钟后
 *    往房间里发一条「有一个权限请求已等待 30 分钟未处理」;
 *  - 无人值守会话(电台 DJ)当场拒绝,理由写给模型看。
 *
 * 直调 `Permission.ask` 拿不到这三条里的任何一条,一次没人点的审批就是一次
 * 永久挂起 —— 加上卡片压根没上屏(G1),那就是 F3 的 2 分 11 秒。
 *
 * ## 粒度:先按动作,认不出才按工具名(P0-4)
 *
 * `EnforcePermissionPolicyInput` 是照**本地工具执行**的形状长的,唯一强依赖是
 * `effects: PermissionEffect[]`。E4 时这里合成的是**恰好一个**以工具名为资源的
 * `external-agent` effect —— 因为「SDK 自带工具跑在 CLI 进程里,我们对它的副作用
 * 没有分析权」。**那句话是错的**:input 就在手上,`Bash` 的 `command`、文件工具的
 * `file_path` 一个字都不缺,缺的只是把它接到本地那套分析上
 * (`docs/audit/claude-code-sdk-audit-2026-08-11.md` P0-4)。代价是实打实的:一次
 * 「总是允许 Bash」之后,外部会话里的任何命令都免审。
 *
 * 现在先问 `describeExternalToolPermission`(它调的是本地 bash 工具那一个
 * `analyzeBashPermission`、本地文件工具那一套沙箱判据),认出来就用命令级 / 路径级
 * 的 effect —— 卡片、grant 粒度、`external` 越界位与本地会话逐字同款。
 *
 * 认不出的工具名(Glob / Grep / WebFetch / Task …)**维持现状**,回落到下面这条
 * 工具名粒度的 effect:
 *
 *  - `kind: 'external-agent'`(R4b 起是内核策略表里的一行,不再是一条谁都不认识
 *    的手搓 kind)—— 它同时是 `Permission.ask({ type })` 的类型,所以卡片类型与
 *    E4 之前逐字相同,渲染层一个字都不用改;
 *  - `resources: [toolName]` —— grant 的 pattern 是工具名;
 *  - `preview.title` 压过 `titleForEffect`,标题仍是 `Claude Code: <tool>`。
 *
 * 认出来那一支可能给出**空 effects**(白名单命令、界内的普通读),策略门于是直接
 * 放行(`core/permission/permission-policy.ts:171`)—— 这与本地 `ls` 不弹卡是同一
 * 件事,也正是不让用户被无谓的卡逼去点「总是允许 Bash」的前提。
 *
 * ## R4b:改调 `Authorizer.decide`(§15.5-7 的那一条)
 *
 * 判定链一个字没变(`PermissionAuthorizer` 就是 `enforcePermissionPolicy` 的一层
 * 薄壳:三座桥、grant 匹配、能力覆盖、`auto-accept-edits` 全在那边)。换掉的是
 * **入口**:外部这一步与本地工具从此走同一个授权者、拿同一种 `Decision`,于是
 * "外部 agent 的权限是另一条链"这句话不再成立。
 */
export async function askExternalAgentPermission(
  ask: ExternalAgentPermissionAsk,
): Promise<ExternalAgentPermissionDecision> {
  // 锚必须是渲染侧真的拿得到的那条消息,否则卡永远进缓存、永远不上屏
  // (`app/permission/message-anchor.ts` 开头写了整条判据)。后台子代理的嵌套
  // toolCallId 由渲染侧的领养兜底接住,而 messageId 这一截没有兜底,只能在源头保证。
  const messageId = resolvePermissionMessageAnchor(ask.localSessionId, ask.messageId)
  const described = describeExternalToolPermission({
    toolName: ask.toolName,
    input: ask.input,
    cwd: ask.cwd,
  })
  const effects: Effect[] = (described?.effects as Effect[] | undefined) ?? [{
    kind: 'external-agent',
    resources: [ask.toolName],
    barrier: true,
    external: true,
    metadata: {
      connectorId: ask.connectorId,
      toolName: ask.toolName,
      input: JSON.parse(JSON.stringify(ask.input ?? null)),
    },
  }]
  const intent = Intent.of({
    payload: undefined,
    effects,
    preview: {
      ...(described?.preview ?? {}),
      title: described?.preview?.title ?? `Claude Code: ${ask.toolName}`,
      metadata: {
        // 谁在跑这一步:卡片长得和本地一样之后,这一条就是唯一的出处标记。
        connectorId: ask.connectorId,
        externalAgentTool: ask.toolName,
        ...(described?.preview?.metadata ?? {}),
      },
    },
  })
  const invocation: Invocation = {
    // G1:卡片按它归位,120s 拒绝桥也按它 + messageId 找 pending。
    callId: ask.toolCallId ?? '',
    toolId: ask.toolName,
    input: ask.input,
    sessionId: ask.localSessionId,
    ...(messageId ? { messageId } : {}),
    principal: undefined as never,
    ...(ask.cwd ? { cwd: ask.cwd, workspaceRoot: ask.cwd } : {}),
  }
  try {
    const decision = await createPermissionAuthorizer()
      .decide(intent, invocation, new AbortScope())
    if (decision.kind === 'deny') {
      return { behavior: 'deny', message: decision.reason }
    }
    return { behavior: 'allow' }
  } catch (error) {
    // 拒绝理由要**可读地**回到 SDK:超时桥写的那句「无人响应,权限请求在 120 秒后
    // 自动拒绝……请改走免审批路径」正是模型下一步需要的信息。丢成一个 false,
    // 模型只知道被拒,不知道为什么、也不知道还能怎么办。
    return {
      behavior: 'deny',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

// ---------------------------------------------------------------------------
// Interaction bridge (E4 §4)
// ---------------------------------------------------------------------------

/**
 * pair 房那道门(「没有人类在场就当场 declined」)已经搬到
 * `app/interaction/no-human.ts` —— 原生 `ask_user` 是它的第二个消费者,而这条判据
 * 不允许有第二份手写:漏掉的那一侧会在一间没有人的房里空等。
 */
export async function askExternalAgentInteraction(
  ask: ExternalAgentInteractionAsk,
): Promise<InteractionAnswer> {
  if (noHumanInTheRoom(ask.localSessionId)) {
    return {
      id: '',
      answers: {},
      outcome: 'declined',
      reason: NO_HUMAN_DECLINE_REASON,
    }
  }
  // 消息锚:与审批走同一个所有者(`app/permission/message-anchor.ts`)。外部通路的
  // `toolCallId` 未必存在于渲染侧的消息上(后台子代理的嵌套调用不另起工具卡),只认
  // 它的话卡片就只剩尾泊 —— 而末尾正是新消息出现的位置,用户读成「答完冒出一条消息」。
  // 这里落一个渲染侧真的拿得到的消息 id,让归位的第二档接得住。
  const messageId = resolvePermissionMessageAnchor(ask.localSessionId, ask.messageId)
  return Interaction.ask({
    sessionId: ask.localSessionId,
    origin: 'external-agent',
    questions: ask.questions,
    ...(ask.toolCallId ? { toolCallId: ask.toolCallId } : {}),
    ...(messageId ? { messageId } : {}),
  })
}

// ---------------------------------------------------------------------------
// Spawn environment
// ---------------------------------------------------------------------------

/**
 * Environment for spawned agent CLIs. A GUI-launched app carries no shell
 * proxy variables, and a direct connection to the model APIs is
 * region-blocked (403 "Request not allowed") — so the app's own proxy
 * settings are translated into the standard env vars. Existing env values
 * win so a shell-launched dev run keeps its own proxy.
 */
export function resolveExternalAgentSpawnEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  const proxy = getSettings().network?.proxy
  if (proxy?.enabled && proxy.url) {
    env.HTTPS_PROXY = env.HTTPS_PROXY ?? proxy.url
    env.HTTP_PROXY = env.HTTP_PROXY ?? proxy.url
    env.https_proxy = env.https_proxy ?? proxy.url
    env.http_proxy = env.http_proxy ?? proxy.url
    if (proxy.bypassRules) {
      const noProxy = proxy.bypassRules.split(';').map(rule => rule.trim()).filter(Boolean).join(',')
      env.NO_PROXY = env.NO_PROXY ?? noProxy
      env.no_proxy = env.no_proxy ?? noProxy
    }
  }
  return env
}

// ---------------------------------------------------------------------------
// Connector registry
// ---------------------------------------------------------------------------

let connectors: Record<string, ExternalAgentConnector | undefined> | undefined

export function getExternalAgentConnectors(): Record<string, ExternalAgentConnector | undefined> {
  if (connectors) return connectors
  connectors = {
    [CLAUDE_CODE_AGENT_CONNECTOR_ID]: createClaudeCodeConnector({
      executablePath: findClaudeExecutable(),
      permissionHandler: askExternalAgentPermission,
      // E4 提问落点:AskUserQuestion 与 onUserDialog 都汇到 InteractionRegistry。
      interactionHandler: askExternalAgentInteraction,
      resolveSpawnEnv: resolveExternalAgentSpawnEnv,
      // E3 宿主工具面:协作工具经进程内 MCP 注入 SDK,发言权回到房间(§2)。
      // 连接器仍会再问一次 E0 能力表(`hostTools`)—— 装上不等于开着。
      hostToolSurface: resolveClaudeCodeHostToolSurface,
      // E6 观测:外部回合的起落与每一次工具决定进调度时间轴(§6)。装配层认识
      // 房间与时间轴,连接器不认识 —— 所以它是一个端口而不是一条 import。
      observer: {
        turn: input => { recordExternalAgentTurn(input) },
        toolDecision: input => { recordExternalAgentTool(input) },
        // 后台子代理的电平 → 气泡里的一行状态(可见性,2026-08-11)。与上面两条
        // 不同,它的落点不是调度时间轴而是**用户看得见的会话流** —— 因为这一条
        // 回答的问题("它还在跑吗、跑了多久")是用户在问,不是回查时才问。
        backgroundTasks: input => { publishExternalAgentBackgroundStatus(input) },
      },
      logger: consoleLog,
    }),
  }
  return connectors
}

/**
 * 中断这条执行会话上正在跑的外部回合(E4/G10)。
 *
 * `engine.abort` 只掐得断**我们这一侧**的流:请求还在飞,SDK 那边的 CLI 进程照跑
 * 不误(工具还会继续执行、账还会继续记)。`connector.interrupt` 才是把那一侧也停下。
 *
 * **能力位说了算**(E0 能力表,原则 5):acp 声明的 `interrupt: false` 是实测结论
 * (它依赖一个可选的 `cancelSession` 回调,缺席时是空操作)—— 对它调等于以为停住了
 * 其实没停,比不调更坏。表里翻一行,这里的行为就跟着变。
 *
 * 失败不冒泡:这是停止链上的一步加强,不是它的前提。
 */
/**
 * 把一条 steering **就地交给**外部连接器(2026-08-12)。
 *
 * 用户的原话是「实时性问题很大」,而不能插话是主因之一:外部会话上一条中途消息
 * 此前必然进宿主的 steering 队列,要等**整个 CLI 回合**跑完才轮到它 —— 一次
 * agentic 长跑就是几分钟。连接器手上有一条整轮开着的输入通道(b8472769 为后台
 * 子代理的审批留下的),这里只是把话交到那条通道上。
 *
 * 返回 true = **接走了**,引擎因此不入队(否则同一句话进模型两遍)。三种收场:
 *
 *  - `'steered'` / `'queued'` → true。两者都是「送到了」,差别在于插进这一轮还是
 *    等下一轮;两者都不该再入队。
 *  - `'unavailable'` → false。这条会话上没有正在跑的外部回合(或通道已收口),
 *    退回宿主队列,行为与改动前一字不差。
 *
 * **能力位说了算**(与 `interruptExternalAgentSessions` 同一条纪律,原则 5):
 * E0 表里 `steer` 翻成 false,这里就真的不再交,外部会话退回排队形状。
 *
 * **绝不抛**:一次投递失败要降级成「没接走」——退回队列是一条完好的路,而把异常
 * 冒到 `steerMessage` 里会让用户的一次插话炸掉整条 steering 通路。
 */
export function takeExternalAgentSteering(localSessionId: string, content: string): boolean {
  if (!connectors) return false
  for (const [connectorId, connector] of Object.entries(connectors)) {
    if (!connector?.steer) continue
    if (!connector.capabilities.steer) continue
    if (findAgentExecutorDescriptor(connectorId)?.capabilities.steer !== true) continue
    try {
      const outcome = connector.steer(localSessionId, content)
      if (outcome !== 'unavailable') return true
    } catch (error) {
      log.warn(
        'external agent steer failed',
        { connectorId, sessionId: localSessionId, reason: error instanceof Error ? error.message : String(error) },
      )
    }
  }
  return false
}

export async function interruptExternalAgentSessions(localSessionId: string): Promise<void> {
  if (!connectors) return
  await Promise.allSettled(
    Object.entries(connectors).flatMap(([connectorId, connector]) => {
      if (!connector) return []
      if (findAgentExecutorDescriptor(connectorId)?.capabilities.interrupt !== true) return []
      return [connector.interrupt(localSessionId)]
    }),
  )
}

export async function disposeExternalAgentConnectors(): Promise<void> {
  if (!connectors) return
  await Promise.allSettled(
    Object.values(connectors).filter(Boolean).map(connector => connector!.dispose()),
  )
  connectors = undefined
}
