/**
 * 执行器表与 provider 执行事实(claude-code-integration-v2 §3 / E0;2026-10-04 两张表并成一张)。
 *
 * 从前这里是一个写死的 `Set(['acp','claude-code-agent'])`,被三处消费:压缩
 * 门(agent-loop-runtime / core-stream-engine)与鉴权豁免(provider-config)。三处问的其实是
 * 两个**不同**的问题 ——「这个 provider 的上下文窗口归谁管」和「它是不是外部执行体
 * (所以没有 API key)」—— 却共用一份 id 名单,于是每加一个外部执行体都要回来改这里。
 *
 * 后来改成按事实登记,但答案分在两张表里:`agent/executor/agent-executor-capabilities.ts`
 * 持完整的执行器描述(local / acp 两行 + 未知外部执行器的保守缺省),这里持一张初始为空的
 * 事实登记表,靠 `agent-executor-registry.ts` 在**模块加载时**把前一张抄进来。provider(L1)
 * 要问「是不是外部执行体」只好去引 agent(L2),而 `acp: external / theirs` 这一行能不能被
 * 压缩门看见,取决于那个模块有没有被谁先加载过。
 *
 * 2026-10-04(越层清零 C2)两张表并成这一张:执行器描述作为**内置行**住在这里,
 * `registerCoreProviderExecution` 补登的是**登记行**(只有两格事实,测试与将来的装配用);
 * 加载期的同步删掉了 —— 表就在这里,没有东西要抄。agent 的执行器注册表从这里读描述,
 * provider 也从这里问,谁都不必先加载谁。
 *
 * 填值纪律(从执行器能力表搬来):**不确定的一律填保守值**(支持写 false、上下文写 theirs),
 * 并在该行注释里写清「保守在哪、什么时候能翻」。声明比真实能力乐观,代价是
 * 我们以为停住了其实没停;声明比真实能力保守,代价只是少用一条快路。
 */


/**
 * 执行器 id。与 providerId 同名不是巧合——今天外部 agent 就是靠 providerId
 * 被认出来的,E0 保持这个映射不变以维持向后兼容;真正的选择权在 E4 之后
 * 交给 agent 配置里的 `executor` 字段。
 */
export type AgentExecutorId = 'local' | 'acp' | (string & {})

/** 思考在哪里发生。这是 local/external 唯一的本质差别。 */
export type AgentExecutorKind = 'local' | 'external'

/**
 * 声明式能力面。每一条都对应一个真实的分流点,不是装饰:
 * 加一条能力之前先问「谁会 if 它」,没有消费者就不加。
 */
export interface AgentExecutorCapabilities {
  /**
   * 能不能接宿主工具面(以 MCP 形式注入协作工具:send_message/board/…)。
   * 消费者:E3 宿主工具面。声明 true 不等于 E0 就接上了——E0 阶段这一位是
   * 「架构上可注入」的声明,真注入在 E3。
   */
  hostTools: boolean
  /** 能不能中途注入用户输入(steer)。消费者:steering 链路。 */
  steer: boolean
  /**
   * 有没有比 abort 更强的中断(能让对面进程真正停下,而不只是我们不再读)。
   * 消费者:E5 停止三级的人级撤牌。
   */
  interrupt: boolean
  /**
   * 上下文窗口归谁管。`theirs` = 执行体自己管,我们的压缩/阻断一律不介入。
   * 消费者:agent-loop 的压缩门(`coreProviderOwnsItsContextWindow`,读的就是这张表)。
   */
  contextWindow: 'ours' | 'theirs'
  /**
   * persona 怎么进:`system` = 作为 system prompt 原文送进去(不可包装,
   * 协作 P0 的既有纪律);`prepend` = 只能拼在用户消息前面。
   * 消费者:E4 的 persona 装配。
   */
  persona: 'system' | 'prepend'
}


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

/**
 * A6-b(2026-09-26):`claude-code-agent`(Claude SDK 连接器)那一行随连接器退役;
 * Claude Code 今天是 ACP 名册里的一台(`resources/acp-agents/claude-code.json`)。
 */
const EXTERNAL_DESCRIPTORS: AgentExecutorDescriptor[] = [
  {
    id: 'acp',
    kind: 'external',
    capabilities: {
      /**
       * A4-b 翻真。E3 的宿主工具面是一台**活的进程内实例**,ACP 的 `mcpServers` 只认可序列化的
       * 配置 —— A4-a 给它加了两条出口(stdio 桥 `acp-mcp-bridge.cjs` / `/api/mcp` Streamable HTTP,
       * 按 (agent, 会话) 签的桥凭据归因),A4-b 由连接器在 `session/new` 前把 `onething` 那一条
       * 递进去(`acp/acp-host-mcp-port.ts`)。连接器仍会再问一次这一格:装上端口不等于开着。
       * 进程没有 HTTP 面(CLI daemon)时那一条组不出来,agent 照旧没有宿主工具 —— 那是宿主的
       * 事实,不是能力表的谎话。
       */
      hostTools: true,
      // 连接器还没有 steer();握手自述的 `_meta.steering` 只填进连接器能力表,
      // 真接上投递之前这里维持 false,宿主就不会把追话交给它。
      steer: false,
      // A0-3 起连接器的 interrupt 直连 ACPManager.cancelSession(`session/cancel`),
      // 不再依赖可选回调,所以翻真。
      interrupt: true,
      // ACP agent 自己维护会话上下文,我们压缩只会把两边的账搞乱。
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
 * 今天外部 agent 靠 providerId 被认出来(model.providerId = 'acp'),
 * E0 保持这条映射以维持向后兼容。
 */
export function isExternalAgentExecutorId(id: string): boolean {
  return findAgentExecutorDescriptor(id)?.kind === 'external'
}

/** 全部内置的执行器描述(含 local)。从前给加载期的事实同步用,今天只剩测试与诊断读。 */
export function listAgentExecutorDescriptors(): AgentExecutorDescriptor[] {
  return [LOCAL_DESCRIPTOR, ...EXTERNAL_DESCRIPTORS]
}

/** 上下文窗口归谁管:`ours` = 我们压缩;`theirs` = 执行体自己管,别插手。 */
export type CoreProviderContextWindowOwner = 'ours' | 'theirs'

/** 思考在哪里发生:`local` = 本引擎;`external` = 外部执行体进程。 */
export type CoreProviderExecutionKind = 'local' | 'external'

export interface CoreProviderExecutionFacts {
  kind: CoreProviderExecutionKind
  contextWindow: CoreProviderContextWindowOwner
}

const DEFAULT_EXECUTION_FACTS: CoreProviderExecutionFacts = {
  kind: 'local',
  contextWindow: 'ours',
}

/**
 * 登记行:装配或测试补登 / 覆盖的执行事实。内置行在上面的执行器表里,登记行优先于内置行;
 * 两者都没有的 provider 一律按本地引擎 + 我们管上下文。
 */
const PROVIDER_EXECUTION_FACTS = new Map<string, CoreProviderExecutionFacts>()

/** 补登/覆盖一条 provider 执行事实。幂等,同 id 后写覆盖前写。 */
export function registerCoreProviderExecution(
  providerId: string,
  facts: CoreProviderExecutionFacts,
): void {
  if (!providerId) return
  PROVIDER_EXECUTION_FACTS.set(providerId, facts)
}

/** 登记行优先,其次执行器表的内置行;两者都没有的一律按本地引擎 + 我们管上下文处理。 */
export function getCoreProviderExecution(providerId: string): CoreProviderExecutionFacts {
  const registered = PROVIDER_EXECUTION_FACTS.get(providerId)
  if (registered) return registered
  const descriptor = findAgentExecutorDescriptor(providerId)
  if (descriptor) return { kind: descriptor.kind, contextWindow: descriptor.capabilities.contextWindow }
  return DEFAULT_EXECUTION_FACTS
}

/**
 * 压缩门的判据:上下文窗口不归我们管时,任何压缩/阻断都不该发生。
 * (从前写作 `isCoreExternalAgentProvider`——那是拿身份当能力用。)
 */
export function coreProviderOwnsItsContextWindow(providerId: string): boolean {
  return getCoreProviderExecution(providerId).contextWindow === 'theirs'
}

/**
 * 外部执行体的判据(读执行事实,登记行优先)。鉴权豁免今天问的是上面不受登记行影响的
 * `isExternalAgentExecutorId`(执行器表的内置行);这一只保留给 agent-loop 内部与既有调用方用。
 */
export function isCoreExternalAgentProvider(providerId: string): boolean {
  return getCoreProviderExecution(providerId).kind === 'external'
}
