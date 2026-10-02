/**
 * 宿主工具面的**装配**(E3,docs/design/claude-code-integration-v2.md §2)。
 *
 * 产品层的 `external-agents/host-mcp/` 只认识「工具对象」与「场子」两个概念;
 * 这里把它接到活的东西上:会话仓库、agent 仓库、工具目录、v3 回合登记簿。
 *
 * ## 一轮外部回合在这里发生什么
 *
 * A6-b(2026-09-26)起只有 ACP 一条出口:Claude SDK 那台进程内 MCP 服务器
 * (`resolveClaudeCodeHostToolSurface` + `host-mcp/server.ts`)随 SDK 连接器退役。
 *
 * ```
 * AcpConnector.streamTurn(localSessionId=执行会话)
 *   → runtime/acp/host-mcp-bridge.ts → resolveHostToolSurface({ localSessionId })
 *       ① 会话 / agent / profile  → 这一轮能用哪些工具(venue 门,单点)
 *       ② 目录里取工具             → 本地回合调的**同一批**,不是副本
 *   → 桥按桥凭据绑语境,stdio / http 交给 agent(agent 侧看到 mcp__onething__send_message …)
 *   → 模型调 send_message
 *       → MCP handler → SayTool.execute(args, { sessionId: 执行会话 })
 *       → speakIntoCollabRoom → resolveCollabV3SpeakRoute 命中 → speakThroughCollabLease
 *   → finally: release()
 * ```
 *
 * 工具调用之后那条链**一个字都没重写**:发言经的是租约、验的是同一张牌、幂等窗
 * 是同一个 Map、句柄出栈与引用快照是同一段代码。这就是「发言权归房间」在外部
 * 通路上的兑现——收养兜底从此退回它该在的位置(真·兜底)。
 *
 * ## 为什么工具从目录取
 *
 * 直接 import 四个协作工具对象也能work,但那是**第二份名单**:哪几个工具算协作
 * 工具,目录里有一份、这里有一份,而两份名单漂了不会报错。按名字问目录,答案只有
 * 一处 —— 而且拿到的就是本地回合调的那只工具。
 */
import { filterHostToolSurface } from '@onething/backend/runtime/external-agents'
import type { JsonObject } from '@shared/json.js'
import type { HostMcpHostTool } from '@onething/backend/runtime/external-agents'
import { getSession } from '@onething/backend/stores/sessions.js'
import { sessionAccess } from '@onething/backend/session/access.js'
import { fixedExecutionContext } from '@onething/backend/runtime/engine/execution-context'
import { resolveAgentProfileForSession } from '../agents/profile-for-session.js'
import { collabVenueOf } from '@onething/backend/runtime/collab/venue'
import { findCollabV3Turn } from '@onething/backend/runtime/collab/actors/turn-context.wiring'
// 宿主工具面由目录 + runner 回答(设计文档 §10.2-④)。
import { contractForSchema, getToolkitCatalog } from '@onething/backend/runtime/toolkit'
import { getLogger } from '@onething/backend/runtime/logging/configure-logging'

const log = getLogger('external-agents')


/**
 * 目录里的一只工具 → 一只可注入的宿主工具。
 *
 * 两格是它全部的内容:
 *  - `parameters` 从**契约表**反查回 zod(`contractForSchema(spec.input)`),因为
 *    SDK 的 `tool()` 要的是 zod raw shape 而 `ToolSpec.input` 是 JSON Schema。
 *    反查不到(插件 / MCP —— 它们的契约不由本地生产)就交空,与
 *    `rawShapeOf` 原有的兜底同一句话;
 *  - `execute` 走 `runToolkitToolDirectly`,于是外部这一轮与本地回合**跑的是同
 *    一条路**:两阶段、权限、统一取消、统一截断、审计一格不少。执行失败照旧
 *    抛出去 —— `toHostMcpToolDefinition` 的 catch 把它翻成 `isError` 的那一条,
 *    与旧路(执行器抛错)逐字同款。
 */
function toolkitHostTool(toolId: string): HostMcpHostTool | undefined {
  const catalog = getToolkitCatalog()
  const tool = catalog?.get(toolId)
  if (!tool) return undefined
  return {
    id: tool.spec.id,
    description: tool.spec.description,
    parameters: contractForSchema(tool.spec.input)?.zod,
    // 跨进程出口序列化给 agent 的那一份(A4-a);就是目录里的 JSON Schema,不另生成。
    inputSchema: tool.spec.input,
    async execute(args, ctx) {
      // 动态 import:装配层那棵树不进这个文件的静态图(注入这一轮才需要它)。
      const { runToolkitToolDirectly } = await import('@onething/backend/runtime/toolkit/wiring')
      const result = await runToolkitToolDirectly(tool.spec.id, args as unknown as JsonObject, {
        sessionId: ctx.sessionId,
        messageId: ctx.messageId,
        executionContext: ctx.executionContext,
        ...(ctx.workingDirectory ? { workingDirectory: ctx.workingDirectory } : {}),
        ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
      })
      if (!result) throw new Error(`${tool.spec.id} is not in the toolkit catalog`)
      if (!result.success) throw new Error(result.error ?? 'tool execution failed')
      return { output: (result.data as { output?: string } | undefined)?.output ?? '' }
    },
  }
}

/**
 * 一条会话此刻的**宿主工具面**:工具对象 + 它们该在哪条语境里跑。与传输无关 ——
 * 跨进程的桥(ACP 路,`runtime/acp/host-mcp-bridge.ts`)吃的就是这一份。
 */
export interface HostToolSurface {
  /** 会话上的 agent 身份(profile 用的那一个)。 */
  agentId: string
  execSessionId: string
  /** 这一轮在答的那间房(v3 登记簿 → 会话上记的房 → 自己)。 */
  roomSessionId: string
  /** 手里那张牌;不是 v3 持牌回合就缺席。 */
  leaseId?: string
  executionContext: ReturnType<typeof fixedExecutionContext>
  tools: HostMcpHostTool[]
}

/**
 * 一次解析(A4-a 从 `resolveClaudeCodeHostToolSurface` 里抽出来的那一半,名字去掉了
 * 「ClaudeCode」—— 它本来就不认 Claude)。返回 `undefined` = 这条会话没有宿主工具面。
 *
 * 三种 `undefined`,含义不同但结局相同(退回 E3 之前的形状:只有 agent 自带工具、
 * 发言靠收养兜底):
 *  - 会话查不到 / 没有 agent 身份 —— 这不是一条协作会话;
 *  - 场子门全关(普通对话)—— 协作工具在那里一个都不成立;
 *  - 目录里一个都取不到 —— 内建工具还没装(装配顺序问题,日志会说)。
 *
 * 它**不绑语境、不起服务器**:绑在哪(按桥凭据)、以什么形态交出去(stdio / http)
 * 是调用方的事。牌与房每次现问 —— 同一条会话下一轮的牌不是这一张。
 */
export async function resolveHostToolSurface(request: {
  localSessionId: string
  executionContext?: unknown
}): Promise<HostToolSurface | undefined> {
  const execSessionId = request.localSessionId
  const executionContext = fixedExecutionContext(request.executionContext)
  sessionAccess.resolveOptional(executionContext, execSessionId, 'read')
  const session = getSession(execSessionId)
  if (!session) return undefined

  const agentId = session.agentId
  if (!agentId) return undefined

  /**
   * 工具面走**装配层唯一那次 profile 解析**(`app/agents/profile.ts`)。
   *
   * 它内部调的就是 `resolveAgentToolSurface` —— 与本地回合同一个函数、同一份
   * dm 推导。在这里自己从 store 再推一次 dm 是 C2 那条注释明写过的坑:漏喂
   * `dm` 会把 D7 私聊那一格静静地算成群房那一格。
   */
  const profile = resolveAgentProfileForSession(execSessionId)
  // 场子也走 app 层那份单点(`collab/venue.ts`)——它替换掉的正是四份手写的 if。
  const venue = collabVenueOf(session)
  const toolIds = filterHostToolSurface({ allowlist: profile.tools, venue })
  if (toolIds.length === 0) return undefined

  const tools: HostMcpHostTool[] = toolIds
    .map(id => toolkitHostTool(id))
    .filter((tool): tool is HostMcpHostTool => Boolean(tool))
  if (tools.length === 0) {
    log.warn('no builtin tool object for the requested ids; host tools not injected', { toolIds })
    return undefined
  }

  /**
   * 牌从 v3 的回合登记簿取 —— 那张表在 `beginCollabV3Turn` 里已经登记
   * 好了(引擎回合开跑之前,`engine-mind-port` 的注释写明「登记必须在 emit 之前」),
   * 而外部 agent 的这一轮正是那条 drive 驱动出来的。
   *
   * **取不到牌不是拒绝的理由**:非 v3 的路径(工作台会话、旧形状的房内流)照样
   * 该有宿主工具,它们走的是 `speakIntoCollabRoom` 的 v2 落库分支。牌只是这里
   * 记下来的事实,验票在房间那侧。
   */
  const turn = findCollabV3Turn(execSessionId)
  return {
    agentId,
    execSessionId,
    roomSessionId: turn?.roomSessionId ?? session.collab?.roomSessionId ?? execSessionId,
    ...(turn?.leaseId ? { leaseId: turn.leaseId } : {}),
    executionContext,
    tools,
  }
}
