/**
 * 执行器能力表(E0)。**唯一一处**回答「这个执行器支不支持 X」。
 *
 * 从前答案散在三个地方各写一份 id 名单(压缩、鉴权、工具装载),名单一致
 * 全靠自觉;每加一个外部执行体就要在三处补登,漏一处就是一个静默降级。
 * 这里把答案收成一张表:改一行,三处同时变。
 *
 * 填值纪律:**不确定的一律填保守值**(支持写 false、上下文写 theirs),并在
 * 该行注释里写清「保守在哪、什么时候能翻」。声明比真实能力乐观,代价是
 * 我们以为停住了其实没停;声明比真实能力保守,代价只是少用一条快路。
 */
import type { AgentExecutorCapabilities, AgentExecutorId, AgentExecutorKind } from './types.js'

export interface AgentExecutorDescriptor {
  id: AgentExecutorId
  kind: AgentExecutorKind
  capabilities: AgentExecutorCapabilities
}

/** 本地执行器 id。agent 未绑定外部连接器时的落点。 */
export const LOCAL_AGENT_EXECUTOR_ID = 'local'

/**
 * 本地执行器:引擎 + 我们自己的工具循环。
 * 宿主工具面对它来说不是「注入」——工具本来就是我们的,所以 hostTools 为真。
 */
const LOCAL_DESCRIPTOR: AgentExecutorDescriptor = {
  id: LOCAL_AGENT_EXECUTOR_ID,
  kind: 'local',
  capabilities: {
    hostTools: true,
    steer: true,
    // abort 就是本地能做到的最强中断(工具循环在我们进程里),没有更强的一档。
    interrupt: false,
    contextWindow: 'ours',
    persona: 'system',
  },
}

const EXTERNAL_DESCRIPTORS: AgentExecutorDescriptor[] = [
  {
    id: 'claude-code-agent',
    kind: 'external',
    capabilities: {
      /**
       * **E3 已真接**(2026-08-05):`external-agents/host-mcp/` 起一台进程内 MCP
       * 服务器,协作工具经 SDK 的 `mcpServers` 选项注入
       * (`McpSdkServerConfigWithInstance` = `{ type:'sdk', name, instance }`,
       * SDK 0.3.214 原生支持,不需要 stdio 子进程)。
       *
       * 这一位现在**有读者**:`claude-code-connector` 的
       * `executorAcceptsHostTools()` 每轮读它,翻成 false 就真的停掉注入(外部
       * agent 退回只有 SDK 自带工具、发言靠收养兜底的 E3 之前形状)。声明与真实
       * 能力从此不会分家 —— 原则 5 的具体兑现。
       */
      hostTools: true,
      /**
       * **已真接**(2026-08-12):`connector.steer` 往整轮开着的输入迭代器里塞一条
       * `priority:'now'` 的用户消息,当前轮就地收场、新的一轮回答追话
       * (实测见 `ClaudeCodeSdkUserMessage.priority`)。
       *
       * 读者是 `app/external-agents/index.ts` 的 `takeExternalAgentSteering`:翻成
       * false 就真的不再把 steering 交给连接器,外部会话退回「进宿主队列、等这一轮
       * 整段跑完再说」的 2026-08-12 之前形状。与 connector 的
       * `CLAUDE_CODE_CAPABILITIES.steer` 是同一个事实的两处声明。
       */
      steer: true,
      /**
       * **E4 已有读者**(2026-08-05):`app/external-agents/index.ts` 的
       * `interruptExternalAgentSessions` 每次喊停都读它,翻成 false 就真的不再对
       * 这个执行器调 `connector.interrupt` —— 外部那一侧只剩 `engine.abort`
       * (掐我们的流,不掐它的进程)。停止链的落点见 `stopCollabV3RoomFloor`。
       */
      interrupt: true,
      // 会话在 SDK 侧,上下文是它的;我们压缩只会把两边的账搞乱。
      contextWindow: 'theirs',
      /**
       * **E4 已兑现**:persona 经 `provider.ts` 收集 system 位 → connector 翻成
       * SDK 的 `systemPrompt: { type:'preset', preset:'claude_code', append }`。
       * G9(只送最后一条 user 文本、persona 整个丢掉)到此结束。
       */
      persona: 'system',
    },
  },
  {
    id: 'acp',
    kind: 'external',
    capabilities: {
      /**
       * 仍然 false —— E3 落地后**按实测保持**,不是忘了翻。
       *
       * ACP 的 MCP 注入是 config 形态(connector 声明 `mcpInjection: 'config'`):
       * 它要的是一份可序列化的服务器配置(stdio 命令行 / http 地址),而 E3 的
       * 宿主工具面是一个**活的进程内实例**——`speakThroughCollabLease` 依赖的
       * store 与 v3 回合登记簿都在这个进程里,序列化不过去。真要接,得先给
       * host-mcp 加一条 stdio/http 出口,那是独立的一件事。
       *
       * 保守的代价只是 ACP agent 暂时没有宿主工具;乐观的代价是我们以为它有
       * 发言权,而它其实一句话都发不出去。
       */
      hostTools: false,
      // 连接器还没有 steer();握手自述的 `_meta.steering` 只填进连接器能力表,
      // 真接上投递之前这里维持 false,宿主就不会把追话交给它。
      steer: false,
      // A0-3 起连接器的 interrupt 直连 ACPManager.cancelSession(`session/cancel`),
      // 不再依赖可选回调,所以翻真。
      interrupt: true,
      // ACP agent 自己维护会话上下文,与 claude-code 同理。
      contextWindow: 'theirs',
      // 保守 prepend:ACP 的 prompt 协议里没有 system 位,persona 只能拼在
      // 用户消息前面。若后续 connector 暴露 system 通道再翻。
      persona: 'prepend',
    },
  },
]

const DESCRIPTORS = new Map<string, AgentExecutorDescriptor>([
  [LOCAL_DESCRIPTOR.id, LOCAL_DESCRIPTOR],
  ...EXTERNAL_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor] as const),
])

/**
 * 未知 connectorId 的兜底:仍按外部处理(它显然不是本引擎),但能力全部
 * 保守——我们对它一无所知,声明任何一条支持都是猜。
 */
export function unknownExternalExecutorDescriptor(id: string): AgentExecutorDescriptor {
  return {
    id,
    kind: 'external',
    capabilities: {
      hostTools: false,
      steer: false,
      interrupt: false,
      contextWindow: 'theirs',
      persona: 'prepend',
    },
  }
}

export function localAgentExecutorDescriptor(): AgentExecutorDescriptor {
  return LOCAL_DESCRIPTOR
}

/** 已登记的执行器描述;未登记返回 undefined(调用方决定兜底成本地还是未知外部)。 */
export function findAgentExecutorDescriptor(id: string): AgentExecutorDescriptor | undefined {
  return DESCRIPTORS.get(id)
}

/**
 * 这个 id 是不是一个外部执行器。**这是 providerId 推导的唯一判据**——
 * 今天外部 agent 靠 providerId 被认出来(Iris 的 model.providerId =
 * 'claude-code-agent'),E0 保持这条映射以维持向后兼容。
 */
export function isExternalAgentExecutorId(id: string): boolean {
  return findAgentExecutorDescriptor(id)?.kind === 'external'
}

/** 全部已登记的描述(含 local)。core 事实下沉与测试用。 */
export function listAgentExecutorDescriptors(): AgentExecutorDescriptor[] {
  return [LOCAL_DESCRIPTOR, ...EXTERNAL_DESCRIPTORS]
}
