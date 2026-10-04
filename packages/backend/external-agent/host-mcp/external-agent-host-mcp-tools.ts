/**
 * 协作工具 → MCP handler(§2 `tools.ts`)。
 *
 * 这个文件**不写业务**。它做两件事:
 *
 *  1. **决定注入哪几个** —— 走 `resolveAgentToolSurface` 与候选登记时带来的 `visibleIn`
 *     (工具自己的那句判据)这两个既有单点,不是平行实现(见下;越层清零 A5② 之前第二道门直接
 *     调协作的场子表 `isCollabToolAllowedInVenue`);
 *  2. **把既有的工具对象包成 MCP 工具** —— handler 里那一行就是 `tool.execute(...)`,
 *     也就是本地回合调的**同一个函数对象**。持牌校验、防冒名、幂等窗、句柄出栈、
 *     打字灯、场子门、`permissionGuard` 全部原封不动地在那条路上,因为那条路根本
 *     没有被复制一份。
 *
 * ## 「不重写业务」为什么是硬纪律
 *
 * `speakThroughCollabLease` 那一段是十几轮真机事故堆出来的:5 秒幂等窗(同一回合
 * 里群里出现两条一字不差的消息)、mention 白名单(防冒名)、句柄出栈必须在指纹
 * **之前**(否则窗形同虚设)、引用快照要查被引的那条还在不在。任何一条在这里被
 * 「照着重写一遍」,都会以静默的方式漂掉 —— 而这个仓库已经为同形状的人肉对齐
 * 付过好几次代价(工具面单点 C2、场子门 C3-6)。
 *
 * ## 工具集由 venue 门决定 —— 两道,不是一道
 *
 * `resolveAgentToolSurface` 答的是「这一回合**能用**哪些工具」(白名单 + 地板并集),
 * `isCollabToolAllowedInVenue` 答的是「这个工具**至多**在哪些场子里成立」。两者
 * 不是互逆(`tool-surface.ts` 里有实证:工作台面地板没有 `history`,而工作台**是**
 * 可以查历史的),所以两道都要过:
 *
 *  - 只过前者:普通 `chat` 会话里 agent 没配白名单 ⇒ 返回 `null`(不限制)⇒ 四个
 *    协作工具全注进去。而 `chat` 场子里它们一个都不成立 —— 那正是 `history` 泄露
 *    用户私聊的那条路径的形状。
 *  - 只过后者:agent 自己收窄过的白名单被无视。
 *
 * 两道门都是**同一个函数**,不是这里重写的判据 —— 这就是「venue 门第一次对外部
 * agent 真正生效」的具体落点。
 */
import { z } from 'zod'
import { resolveCollabVenue, type CollabVenue } from '@onething/backend/session'
import { resolveAgentToolSurface } from '../../agent/agent-profile.js'

/**
 * 递给宿主工具的那一格上下文。
 *
 * R4b:它原本是旧 `tools/tool.ts` 的 `ToolContext`;旧树删掉之后就地写成这张
 * 结构表 —— 这个文件本来就只填这五格(装配层那一侧的 `toolkitHostTool` 也只读
 * 这五格),而它现在对两棵树都不认识。
 */
export interface HostMcpToolContext {
  sessionId: string
  messageId: string
  executionContext?: unknown
  workingDirectory?: string
  abortSignal?: AbortSignal
  metadata(update: { title?: string; metadata?: Record<string, unknown> }): void
}
import { resolveHostToolContext } from './external-agent-host-mcp-context.js'
import type { HostToolTurnContext } from './external-agent-host-mcp-types.js'

/**
 * 可以注入的宿主工具全集 —— **由工具的主人登记**,不是这里手抄一份(越层清零 A5②,2026-10-04)。
 *
 * 从前这一格是 `Object.keys(COLLAB_TOOL_VENUES)`,第二道门是 `isCollabToolAllowedInVenue`:外部 agent
 * 的宿主工具面直接 import 协作的场子表,低层按能力枚举。现在协作在 `registerCollabTools` 里登记
 * 「这几只可以注进外部 agent、按这个顺序、各自在哪些场子露面」:顺序是场子表的键序
 * `send_message, board, history, notebook`(与从前逐字相同,也是外部 agent 在 MCP `tools/list` 里
 * 看见的顺序);`visibleIn` 就是那只工具自己的 `visibleIn(scene)` 用的同一句判据。
 *
 * 为什么候选自带 `visibleIn`,而不是现取目录里那只工具对象去问:门要在「目录里取不到工具对象」时
 * 照样答话 —— 那种情形(readonly 档、内建工具还没装)从前是「过了门、取不到工具、记一行 warn 再不注」,
 * 现取对象的话门先关,那一行诊断就再也不会出现。
 *
 * 同一个 id 再登记一次不重复(幂等);没有任何登记 = 一只都不注(普通对话就该是这个答案)。
 */
export interface HostInjectableTool {
  readonly id: string
  /** 这只工具在这个场子露不露面 —— 与它自己的 `Tool.visibleIn(scene)` 同一句判据。 */
  visibleIn(scene: { venue: CollabVenue }): boolean
}

const hostInjectable: { tools: HostInjectableTool[] } = { tools: [] }

export function registerHostInjectableTools(tools: readonly HostInjectableTool[]): void {
  for (const tool of tools) {
    if (!hostInjectable.tools.some(known => known.id === tool.id)) hostInjectable.tools.push(tool)
  }
}

/** 当下登记着的候选 id,按登记顺序。 */
export function hostMcpToolCandidates(): readonly string[] {
  return hostInjectable.tools.map(tool => tool.id)
}

export interface HostToolSurfaceInput {
  /** 执行会话的 kind。缺席 = 普通对话(归一化见 `resolveCollabVenue`)。 */
  sessionKind?: string
  /** 这一轮答的是单成员 dm 房吗(D7)。 */
  sessionDm?: boolean
  /** agent 自己的白名单。`null`/缺席 = 不限制。 */
  ownTools?: readonly string[] | null
  /** agent 显式登记的 capability grant。 */
  grants?: readonly string[] | null
}

/**
 * 两道门的**交集**。`allowlist` 为 `null` = 不限制(agent 没配白名单)。
 *
 * 装配层走这一个口:它手上的 `allowlist` 来自
 * `resolveAgentProfileForSession(...)`——同一个 `resolveAgentToolSurface`,但是由
 * **装配层唯一那份 dm 推导**喂进去的(`app/agents/profile.ts` 的 `isDmRoomTurn`)。
 * 让这个文件自己再从 store 推一次 dm,就是那份注释里写过的第二份推导:漏喂一个
 * `dm` 会把私聊那一格静静地算成群房那一格。
 */
export function filterHostToolSurface(input: {
  allowlist: readonly string[] | null
  venue: CollabVenue
}): string[] {
  // 第二道门问候选自己登记的 `visibleIn`(越层清零 A5②;判据与工具对象的 `visibleIn` 逐格同一张表)。
  const scene = { venue: input.venue }
  return hostInjectable.tools
    .filter(tool => tool.visibleIn(scene) && (input.allowlist === null || input.allowlist.includes(tool.id)))
    .map(tool => tool.id)
}

/**
 * 这一轮该注入哪几个宿主工具。空数组 = 一个都不注(普通对话就该是这个答案)。
 *
 * 给**手上只有原始字段**的调用方(测试、未来的其它 connector):它替你调那两个
 * 单点。已经解析过 profile 的调用方走 `filterHostToolSurface`,别解析第二遍。
 */
export function resolveHostToolSurface(input: HostToolSurfaceInput): string[] {
  return filterHostToolSurface({
    venue: resolveCollabVenue(input.sessionKind),
    allowlist: resolveAgentToolSurface({
      ownTools: input.ownTools ?? null,
      grants: input.grants ?? null,
      ...(input.sessionKind ? { sessionKind: input.sessionKind } : {}),
      ...(input.sessionDm === undefined ? {} : { sessionDm: input.sessionDm }),
    }),
  })
}

/**
 * 一只**可注入的宿主工具**。
 *
 * R3b 把这里的入参从旧 `ToolInfo` 放宽成这张结构表;装配层递的是目录里那只工具的
 * 一层薄包装(schema 从契约表反查回 zod,执行走 `runToolkitToolDirectly`)。这个
 * 文件因此**不 import 任何一棵注册表**。
 *
 * `parameters` 刻意是 `unknown`:这里只会去取它的 `.shape`(见 `rawShapeOf`),
 * 取不到就给一张空表 —— 那条兜底本来就在。
 */
export interface HostMcpHostTool {
  id: string
  description: string
  parameters: unknown
  /**
   * 入参的 **JSON Schema**(A4-a)。进程内 SDK 那条路只吃 zod raw shape(`parameters`),
   * 用不到它;跨进程那两条出口(stdio 桥 / `/api/mcp`)的 `tools/list` 要把模式**序列化**
   * 给 agent,zod 过不了线,所以由装配层把目录里现成的那份(`ToolSpec.input`)一起递过来。
   * 缺席 = 空对象模式,与 `rawShapeOf` 取不到时同一条兜底。
   */
  inputSchema?: unknown
  execute(args: Record<string, unknown>, ctx: HostMcpToolContext): Promise<{ output: string }>
}

/** MCP 的工具结果形状(`CallToolResult` 的我们用得到的那一小块)。 */
export interface HostMcpCallResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

/** SDK 的 `SdkMcpToolDefinition` 的结构子集 —— 保持结构化,SDK 因此仍是软依赖。 */
export interface HostMcpToolDefinition {
  name: string
  description: string
  /** zod **raw shape**(不是 ZodObject)—— SDK 的 `tool()` 就收这个形状。 */
  inputSchema: z.ZodRawShape
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<HostMcpCallResult>
}

function textResult(text: string, isError?: boolean): HostMcpCallResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
}

/**
 * 参数模式取 raw shape。
 *
 * 我们的工具契约用 `z.object({...})` 写(那是本地工具循环要的形状),SDK 的
 * `tool()` 要的是它里面那张 shape 表。取不到就给一张**空表**而不是抛 —— 一个
 * 参数模式取不出来的工具仍然可以被调用(SDK 侧不校验,校验在 `execute` 前的
 * zod 那道),而抛出去会让整个工具面因为一个工具的形状而全军覆没。
 */
function rawShapeOf(parameters: unknown): z.ZodRawShape {
  const shape = (parameters as { shape?: unknown } | null)?.shape
  return shape && typeof shape === 'object' ? (shape as z.ZodRawShape) : {}
}

/**
 * 回合已经不在了那句话。
 *
 * 会走到这里的是**迟到调用**:SDK 进程在我们的回合收尾之后才把最后一个工具调用
 * 吐出来。说清「这一轮已经结束」而不是含糊的失败 —— 模型据此知道重试没有意义。
 */
export const HOST_MCP_TURN_GONE =
  '这一轮已经结束了,消息发不出去了。下一次被叫到的时候再说。'

/**
 * 把一个既有工具包成 MCP 工具。
 *
 * `execSessionId` **闭包进来**(不是从参数收):它是这台服务器所属的那一轮的常量。
 * 模型传不了它,所以模型也没有一条路能把话说进别人的会话 —— 与 `notebook` 的
 * 「身份从会话推,不从参数收」是同一条纪律。
 */
export function toHostMcpToolDefinition(
  tool: HostMcpHostTool,
  execSessionId: string,
): HostMcpToolDefinition {
  // A server belongs to one binding, not whichever turn later reuses its session ID.
  const boundContext = resolveHostToolContext(execSessionId)
  return hostMcpToolDefinitionWith(tool, () => {
    const context = resolveHostToolContext(execSessionId)
    return boundContext && context === boundContext ? context : undefined
  })
}

/**
 * 同一只包装,语境由调用方给(A4-a)。
 *
 * 进程内 SDK 那条路的语境按**执行会话**绑(上面那只);跨进程的桥按**桥凭据**找语境
 * (`backend/acp/acp-host-mcp-bridge.ts`)。两条路找语境的办法不同,但「语境不在就答
 * `HOST_MCP_TURN_GONE`」「执行器抛了才是 `isError`」「门拒不翻成错误」这三条必须是
 * **同一段代码** —— 抄一份,两条通路上同一件事就会长成两个样子(原则 1)。所以把
 * handler 的身体抽到这里,两边各递一个 `resolveContext`。
 *
 * `resolveContext` 每次调用现问:答 `undefined` = 这把钥匙已经作废 / 这一轮已经收了。
 */
export function hostMcpToolDefinitionWith(
  tool: HostMcpHostTool,
  resolveContext: () => HostToolTurnContext | undefined,
): HostMcpToolDefinition {
  return {
    name: tool.id,
    description: tool.description,
    inputSchema: rawShapeOf(tool.parameters),

    async handler(args) {
      const context = resolveContext()
      // 绑定不在 = 这一轮的宿主工具面已经收了。不落库、不报红,给模型一句它能
      // 据以行动的话。
      if (!context) return textResult(HOST_MCP_TURN_GONE, true)

      try {
        const result = await tool.execute(args, hostToolContext(context))
        /**
         * **不设 `isError`**,哪怕执行器回的是「未送达」。
         *
         * 本地回合里,一次被门拒掉的 `send_message` 是一条**正常的工具结果**,
         * 正文就是那句可操作的拒绝语(「这间房被暂停了」「预算用完了」)。把它
         * 在外部通路上翻译成 MCP 错误,模型看到的就是另一种东西 —— 同一件事在
         * 两条通路上长成两个样子,正是原则 1 要消掉的那种差异。
         */
        return textResult(result.output)
      } catch (error) {
        // 执行器抛了才是真错(不该发生;抛出来就要让模型看见,而不是静默成空)。
        const message = error instanceof Error ? error.message : String(error)
        return textResult(`${tool.id} failed: ${message}`, true)
      }
    },
  }
}

/**
 * 合成一份 `HostMcpToolContext`。
 *
 * `sessionId` 是**执行会话**——协作执行器认的就是它(`resolveSayContext`、
 * `resolveSelfAgentId`、notebook 的身份推断全从这条会话出发),v3 的验票表也是
 * 按它索引的。这一个字段接对,整条持牌路径就自动接上了。
 *
 * `metadata()` 是空操作:它在本地回合里把标题/元数据推给渲染层,而外部回合的
 * 渲染走的是 connector 翻译出来的那条事件流 —— 这里再推一份会是第二个真相源。
 */
function hostToolContext(context: HostToolTurnContext): HostMcpToolContext {
  return {
    sessionId: context.execSessionId,
    messageId: context.messageId ?? '',
    ...(context.executionContext === undefined ? {} : { executionContext: context.executionContext }),
    ...(context.workingDirectory ? { workingDirectory: context.workingDirectory } : {}),
    ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
    metadata: () => {},
  }
}
