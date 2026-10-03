/**
 * Provider 执行事实登记表(claude-code-integration-v2 §3 / E0)。
 *
 * 从前这里是一个写死的 `Set(['acp','claude-code-agent'])`,被三处消费:压缩
 * 门(agent-loop-runtime / core-stream-engine)与鉴权豁免(runtime 侧的
 * provider-config)。三处问的其实是两个**不同**的问题——「这个 provider 的
 * 上下文窗口归谁管」和「它是不是外部执行体(所以没有 API key)」——却共用一份
 * id 名单,于是每加一个外部执行体(Codex / Gemini CLI)都要回来改 core。
 *
 * 现在改成按事实登记:core 只保存它自己判定需要的那两条事实,并按语义暴露
 * 查询函数。runtime 的 AgentExecutor 注册表(`agents/executor/`)是这份表的
 * 上游真源,装配时把自己的条目补登进来(`registerCoreProviderExecution`),
 * 于是「新增一个 executor」只改 runtime 一处。
 *
 * core 自己不点任何 provider 的名字(A0-3):表初始为空,未登记一律按本地引擎 +
 * 我们管上下文。runtime 的执行器注册表在**模块加载时**把条目登记进来;装配层
 * `backend.ts` 静态 import 那个模块,保证任何压缩判定之前它已经跑过。
 */

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

/** 登记表。core 不内置任何条目 —— 哪个 provider 是外部执行体,由 runtime 自述。 */
const PROVIDER_EXECUTION_FACTS = new Map<string, CoreProviderExecutionFacts>()

/** 补登/覆盖一条 provider 执行事实。幂等,同 id 后写覆盖前写。 */
export function registerCoreProviderExecution(
  providerId: string,
  facts: CoreProviderExecutionFacts,
): void {
  if (!providerId) return
  PROVIDER_EXECUTION_FACTS.set(providerId, facts)
}

/** 未登记的 provider 一律按本地引擎 + 我们管上下文处理。 */
export function getCoreProviderExecution(providerId: string): CoreProviderExecutionFacts {
  return PROVIDER_EXECUTION_FACTS.get(providerId) ?? DEFAULT_EXECUTION_FACTS
}

/**
 * 压缩门的判据:上下文窗口不归我们管时,任何压缩/阻断都不该发生。
 * (从前写作 `isCoreExternalAgentProvider`——那是拿身份当能力用。)
 */
export function coreProviderOwnsItsContextWindow(providerId: string): boolean {
  return getCoreProviderExecution(providerId).contextWindow === 'theirs'
}

/**
 * 鉴权豁免的判据:外部执行体的登录归它自己的 CLI,引擎侧凭据故意留空。
 * runtime 侧同一判断请走 `resolveAgentExecutor(...).kind`(能力查询),
 * 这里保留是给 core 内部与既有调用方用。
 */
export function isCoreExternalAgentProvider(providerId: string): boolean {
  return getCoreProviderExecution(providerId).kind === 'external'
}
