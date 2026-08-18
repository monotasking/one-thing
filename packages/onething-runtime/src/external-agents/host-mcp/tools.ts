/**
 * 协作工具 → MCP handler(§2 `tools.ts`)。
 *
 * 这个文件**不写业务**。它做两件事:
 *
 *  1. **决定注入哪几个** —— 走 `resolveAgentToolSurface` 与 `isCollabToolAllowedInVenue`
 *     这两个既有单点,不是平行实现(见下);
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
import {
  COLLAB_TOOL_VENUES,
  isCollabToolAllowedInVenue,
  resolveCollabVenue,
  type CollabVenue,
  type CollabVenueTool,
} from '../../collab/tool-surface.js'
import { resolveAgentToolSurface } from '../../agents/profile.js'
import type { ToolContext } from '../../tools/tool.js'
import { resolveHostToolContext } from './context.js'
import type { HostToolTurnContext } from './types.js'

/**
 * 可以注入的宿主工具全集。**从场子表的键推**,不是手抄一份:一览表加一行,这里
 * 自动跟上;而手抄的那一份漏了不会报错,只会让那个工具对外部 agent 静静地不存在。
 */
export const HOST_MCP_TOOL_CANDIDATES: readonly CollabVenueTool[] =
  Object.keys(COLLAB_TOOL_VENUES) as CollabVenueTool[]

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
}): CollabVenueTool[] {
  return HOST_MCP_TOOL_CANDIDATES.filter(tool =>
    isCollabToolAllowedInVenue(tool, input.venue)
    && (input.allowlist === null || input.allowlist.includes(tool)),
  )
}

/**
 * 这一轮该注入哪几个宿主工具。空数组 = 一个都不注(普通对话就该是这个答案)。
 *
 * 给**手上只有原始字段**的调用方(测试、未来的其它 connector):它替你调那两个
 * 单点。已经解析过 profile 的调用方走 `filterHostToolSurface`,别解析第二遍。
 */
export function resolveHostToolSurface(input: HostToolSurfaceInput): CollabVenueTool[] {
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
 * R3b 把这里的入参从旧 `ToolInfo` 放宽成这张结构表:装配层开关关时递的是旧注册表
 * 里那个对象(它逐字满足这张表),开关开时递的是目录里那只工具的一层薄包装
 * (schema 从契约表反查回 zod,执行走 `runToolkitToolDirectly`)。这个文件因此
 * **不再 import 任何一棵注册表**,两条路对它是同一个形状。
 *
 * `parameters` 刻意是 `unknown`:这里只会去取它的 `.shape`(见 `rawShapeOf`),
 * 取不到就给一张空表 —— 那条兜底本来就在。
 */
export interface HostMcpHostTool {
  id: string
  description: string
  parameters: unknown
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<{ output: string }>
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
  return {
    name: tool.id,
    description: tool.description,
    inputSchema: rawShapeOf(tool.parameters),

    async handler(args) {
      const context = resolveHostToolContext(execSessionId)
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
 * 合成一份 `ToolContext`。
 *
 * `sessionId` 是**执行会话**——协作执行器认的就是它(`resolveSayContext`、
 * `resolveSelfAgentId`、notebook 的身份推断全从这条会话出发),v3 的验票表也是
 * 按它索引的。这一个字段接对,整条持牌路径就自动接上了。
 *
 * `metadata()` 是空操作:它在本地回合里把标题/元数据推给渲染层,而外部回合的
 * 渲染走的是 connector 翻译出来的那条事件流 —— 这里再推一份会是第二个真相源。
 */
function hostToolContext(context: HostToolTurnContext): ToolContext {
  return {
    sessionId: context.execSessionId,
    messageId: context.messageId ?? '',
    ...(context.workingDirectory ? { workingDirectory: context.workingDirectory } : {}),
    ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
    metadata: () => {},
  }
}
