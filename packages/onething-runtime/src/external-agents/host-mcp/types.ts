/**
 * 宿主工具面的**词汇表**(docs/design/claude-code-integration-v2.md §2)。
 *
 * 纯类型 + 两个常量,零运行时依赖 —— connector、装配层、测试三方都要说这几个词,
 * 而它们之间不该为了一个名字互相 import 半棵树。
 *
 * ## 为什么需要「宿主工具面」这个概念
 *
 * SDK 管自己的工具(Read/Write/Bash 跑在它的沙箱里)是对的,我们不该插手。但
 * **协作工具不是它的**:`send_message` 是房间租约的兑现动作,`board` 是我们的
 * 看板,`history` 会读到用户的私聊。这三件事必须由宿主提供、宿主执行、宿主审批
 * ——否则发言权就外包出去了,而外包出去的发言权只能靠收养兜底搬运正文冒充
 * (§0 诊断:那是降级,不是通路)。
 *
 * 落地形态是**进程内 MCP 服务器**:SDK 原生支持 `mcpServers` 选项,注入进去之后
 * SDK 侧看到的就是几个标准 MCP 工具,而工具体仍在我们进程里、仍是本地回合调的
 * 那一个函数对象。
 */

/** SDK 侧看到的服务器名。MCP 工具全名 = `mcp__<server>__<tool>`。 */
export const HOST_MCP_SERVER_NAME = 'onething'

/** 全名前缀。两类工具的分界线就是这一串。 */
export const HOST_MCP_TOOL_PREFIX = `mcp__${HOST_MCP_SERVER_NAME}__`

/** 注册名 → MCP 全名(模型看到的那个)。 */
export function hostMcpToolName(toolId: string): string {
  return `${HOST_MCP_TOOL_PREFIX}${toolId}`
}

/**
 * 这是不是一个宿主工具的调用名。
 *
 * **两类工具的唯一判据**:带前缀 = 我们的工具(跑在我们的执行器里,审批/门/持牌
 * 校验都在那条路上);不带 = SDK 自己的工具(Read/Write/Bash/AskUserQuestion,
 * 跑在 CLI 进程里,仍走 `canUseTool` 那座桥)。
 */
export function isHostMcpToolName(toolName: string | undefined | null): boolean {
  return typeof toolName === 'string' && toolName.startsWith(HOST_MCP_TOOL_PREFIX)
}

/**
 * MCP 全名 → 注册名。不带前缀的原样返回。
 *
 * 归一化用在**事件流出口**:一个宿主工具就是我们的工具,`mcp__` 前缀只是它这次
 * 是怎么进到 SDK 里的,不是它是什么。下游(打字灯 `isCollabSendCall`、步骤渲染、
 * 调度日志)因此不必为「同一个工具的两种拼法」各留一条分支 —— 原则 1「同事平权」
 * 在事件面上的具体形态。
 */
export function stripHostMcpToolPrefix(toolName: string): string {
  return toolName.startsWith(HOST_MCP_TOOL_PREFIX)
    ? toolName.slice(HOST_MCP_TOOL_PREFIX.length)
    : toolName
}

/**
 * 一轮外部回合的语境。MCP handler 是**无状态**的,这几个字段由绑定注入。
 *
 * 为什么不是模块级的「当前回合」变量:两间房可以同时各跑一轮外部回合(v3 的房间
 * 回合本来就是并行的),一个全局变量会让后起的那轮把前一轮的语境覆盖掉 —— 症状
 * 是一句话落进了错的房,而且不报错。
 */
export interface HostToolTurnContext {
  agentId: string
  /** Trusted invocation identity from the executing host. */
  executionContext?: unknown
  /** 这一轮在答的那间房。 */
  roomSessionId: string
  /** 回合真正跑在哪条会话上。**绑定表的键**。 */
  execSessionId: string
  /** 手里那张牌。房间验的就是它;没有 = 不是 v3 持牌回合(回落 v2 落库路径)。 */
  leaseId?: string
  /** 这一轮流进哪条 assistant 消息 —— 审批卡按它归位。 */
  messageId?: string
  /** 工具的工作目录。与 SDK 侧的 cwd 同一个。 */
  workingDirectory?: string
  /**
   * 这一轮的中断信号。停止按钮按下去时,一个正在扫二十间房的 `history` 应该跟着
   * 停 —— 没有它,回合已经死了而工具还在读盘。
   */
  abortSignal?: AbortSignal
}

/**
 * 注入给 connector 的那一份东西。
 *
 * `mcpServers` 直接进 SDK 的 `query()` 选项;`toolNames` 是已注入工具的**全名**
 * 清单,connector 用它做两件事:进 `allowedTools`(免得宿主工具被 SDK 的审批链
 * 二次拦一道)、以及在日志里说清这一轮到底给了它哪几个。
 */
export interface HostMcpInjection {
  mcpServers: Record<string, unknown>
  toolNames: string[]
  /** 回合收尾时解绑语境。connector 在 `finally` 里调,必须幂等。 */
  release?: () => void
}

/**
 * connector 每轮问一次:「这一轮给不给宿主工具,给哪几个?」
 *
 * 装配层实现它(它认识 store / 工具注册表 / v3 回合登记簿);connector 只负责
 * 在 `capabilities.hostTools` 为真时问、把答案塞进 `queryOptions`、收尾时解绑。
 * 返回 `undefined` = 这一轮不注入(普通对话、装配层没装、能力表说不支持)。
 */
export type HostMcpSurfaceResolver = (request: {
  localSessionId: string
  executionContext?: unknown
  messageId?: string
  cwd: string
}) => Promise<HostMcpInjection | undefined> | HostMcpInjection | undefined
