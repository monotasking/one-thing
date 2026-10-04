/**
 * 引擎(engine):把各功能接成一台跑对话的机器(层次 L3「编排」)。
 *
 * 它做的事:收到「发一条消息 / 重试 / 改了重发 / 确认后继续」这类命令时,解析这一轮用哪家服务商、
 * 哪个模型、什么凭证,拼出这一轮的历史与系统提示词,把请求交给 agent-loop 的内核跑完,沿途把流式
 * 片段、工具步骤、用量与收场原因写进会话账本。「拿服务商干一件小事」的门面(起标题、后台杂活回合、
 * 造 AgentProvider、鉴权解析)2026-10-04 起住在 `provider-call/`(D122),引擎经它的入口用。
 *
 * 它不做的事:一轮怎么跑(循环、工具调度、历史重建、上下文压缩的内核)在 `agent-loop/`;
 * 把引擎装起来、接好端口、登记内置触发器在包根 `assemble-engine.ts`;「现在这只引擎是哪只」读
 * 包根 `current.ts` 的槽。
 *
 * 交出五类名字(下面按类分组,只交外面真在用的):
 *  1. 引擎本体与它的类型名;
 *  2. 装配要用的拆件(引擎的 runtime、回合评估触发器、历史投影);
 *  3. 生效配置的类型与系统提示词快照;
 *  4. 引擎 runtime 的工厂(gateway 与总桶用);
 *  5. agent-loop 流运行时的几个钩子类型(目标续推、草稿纸、日志)。
 *
 * 依赖:agent-loop(内核)、provider-call、providers、credentials、sessions、settings、prompts、toolkit、tools、
 * collab、plugins、agents、usage、media、search、events、logging 等功能的入口与部分内部文件。
 */

// ── 1. 引擎本体
export {
  ProductStreamEngine,
} from './engine-stream-dispatcher.js'
export type {
  BindableStreamSender,
  StreamEngine,
  StreamSender,
  StreamSenderPayload,
} from './engine-stream-dispatcher.js'

// ── 2. 装配要用的拆件(包根 `assemble-engine.ts` / `backend.ts`)
export {
  createMainStreamEngineRuntime,
} from './engine-main-stream-runtime.js'
export type {
  MainStreamEngineRuntime,
} from './engine-main-stream-runtime.js'
export {
  createTurnEvaluationTrigger,
} from './triggers/engine-triggers-turn-evaluation.js'
export {
  buildHistoryMessages,
  historyProjectionRecipe,
} from './stream/engine-stream-message-helpers.js'

// ── 3. 生效配置的类型与提示词快照
// (D122,越层清零 1B,2026-10-04:「拿服务商干活」的九只 —— 对话门面、造实例、辅助模型、鉴权解析 ——
// 搬去了新功能 `provider-call/`,辅助模型的意图 / 结果账去了 session;这里不再转交。)
export type {
  ProviderConfigWithKey,
} from './stream/engine-stream-executor.js'
export {
  buildSystemPromptSnapshot,
} from './prompt/engine-system-prompt-snapshot.js'

// ── 4. 引擎 runtime 的工厂(gateway 的 `gateway-onething-runtime.ts` 与总桶用)
export {
  createOnethingStreamEngineRuntime,
} from './engine-stream-runtime-factory.js'
export type {
  OnethingStreamRuntime,
  OnethingStreamRuntimeOptions,
} from './engine-stream-runtime-factory.js'
export {
  createOnethingStreamProcessor,
} from './engine-stream-processor-factory.js'
export type {
  CreateOnethingStreamProcessorOptions,
} from './engine-stream-processor-factory.js'
export {
  createOnethingProductStreamRuntime,
  createOnethingProductStreamRuntimeFromHostAdapters,
} from './engine-product-stream-runtime.js'
export type {
  OnethingProductStreamRuntime,
  OnethingProductStreamRuntimeHostAdapters,
  OnethingProductStreamRuntimeOptions,
} from './engine-product-stream-runtime.js'

// ── 5. agent-loop 流运行时的钩子类型与流处理上下文
export type {
  OnethingAgentLoopGoalHooks,
  OnethingAgentLoopLogger,
  OnethingAgentLoopScratchpadHooks,
} from './engine-agent-loop-runtime-adapters.js'
export type {
  StreamContext,
} from './stream/engine-stream-processor.js'
