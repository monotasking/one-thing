/**
 * 思考线型表 —— **按账本的 `OnethingReasoningWire` 值建表**
 * (设计稿 §2.7:Dialect 不持有线型,方言只声明「我这家可能出现哪几条」)。
 *
 * 这个模块一加载就把已迁移的线型登记进进程级的 `thinkingWires`:
 * openai-chat 的八条(`openai-compatible.ts` 的构造门面靠它把 `reasoningStyle`
 * 换成对象 —— 那个 `switch` 从此不存在了),外加 anthropic-messages 的三条
 * (P1-a)与 gemini 的两条(P1-b)。
 */
import { thinkingWires } from "../base/index.js";
import { anthropicAdaptiveThinkingWire } from "./anthropic-adaptive.js";
import { anthropicAlwaysThinkingWire } from "./anthropic-always.js";
import { anthropicBudgetThinkingWire } from "./anthropic-budget.js";
import { deepSeekInferredThinkingWire } from "./deepseek-inferred.js";
import {
	geminiBudgetThinkingWire,
	geminiLevelThinkingWire,
} from "./gemini-thinking.js";
import { grokEffortWire } from "./grok-effort.js";
import { openAIChatNoThinkingWire } from "./none.js";
import { openAIEffortWire } from "./openai-effort.js";
import { openRouterReasoningWire } from "./openrouter-reasoning.js";
import { qwenThinkingWire } from "./qwen-thinking.js";
import { responsesReasoningWire } from "./responses-reasoning.js";
import { thinkingTypeWire } from "./thinking-type.js";
import { zhipuThinkingWire } from "./zhipu-thinking.js";

thinkingWires
	.register(thinkingTypeWire)
	.register(openAIEffortWire)
	.register(zhipuThinkingWire)
	.register(qwenThinkingWire)
	.register(grokEffortWire)
	.register(openRouterReasoningWire)
	.register(openAIChatNoThinkingWire)
	.register(deepSeekInferredThinkingWire)
	.register(anthropicAdaptiveThinkingWire)
	.register(anthropicBudgetThinkingWire)
	.register(anthropicAlwaysThinkingWire)
	.register(geminiLevelThinkingWire)
	.register(geminiBudgetThinkingWire)
	.register(responsesReasoningWire);

export {
	AnthropicAdaptiveThinkingWire,
	anthropicAdaptiveThinkingWire,
} from "./anthropic-adaptive.js";
export {
	ANTHROPIC_ALWAYS_THINKING_WIRE_ID,
	AnthropicAlwaysThinkingWire,
	anthropicAlwaysThinkingWire,
} from "./anthropic-always.js";
export {
	AnthropicBudgetThinkingWire,
	anthropicBudgetThinkingWire,
} from "./anthropic-budget.js";
export {
	AnthropicThinkingWire,
	clampClaudeReasoningEffort,
	type ClaudeEffort,
} from "./anthropic-effort.js";
export {
	GEMINI_THINKING_CONFIG_PATH,
	GEMINI_THINKING_WIRES,
	GeminiBudgetThinkingWire,
	GeminiLevelThinkingWire,
	geminiBudgetThinkingWire,
	geminiLevelThinkingWire,
	geminiThinkingLevel,
	isGemini25Model,
	type GeminiThinkingConfig,
	type GeminiThinkingLevel,
} from "./gemini-thinking.js";
export {
	DeepSeekInferredThinkingWire,
	deepSeekInferredThinkingWire,
	isDeepSeekThinkingModel,
	resolveDeepSeekThinking,
} from "./deepseek-inferred.js";
export { GrokEffortWire, grokEffortWire, clampGrokReasoningEffort } from "./grok-effort.js";
export { OpenAIChatNoThinkingWire, openAIChatNoThinkingWire } from "./none.js";
export {
	OpenAIEffortWire,
	openAIEffortWire,
	clampOpenAIReasoningEffort,
} from "./openai-effort.js";
export {
	OpenRouterReasoningWire,
	openRouterReasoningWire,
} from "./openrouter-reasoning.js";
export {
	QwenThinkingWire,
	qwenThinkingWire,
	clampQwenReasoningEffort,
} from "./qwen-thinking.js";
export {
	RESPONSES_ENCRYPTED_REASONING_INCLUDE,
	RESPONSES_INCLUDE_PATH,
	RESPONSES_REASONING_PATH,
	RESPONSES_THINKING_WIRES,
	ResponsesReasoningWire,
	isCodexReasoningModel,
	normalizeCodexReasoningEffort,
	responsesReasoningWire,
	type CodexReasoningEffort,
	type CodexReasoningOptions,
} from "./responses-reasoning.js";
export { ThinkingTypeWire, thinkingTypeWire } from "./thinking-type.js";
export { ZhipuThinkingWire, zhipuThinkingWire } from "./zhipu-thinking.js";
export {
	OpenAIChatThinkingWire,
	openAIChatDelta,
	type OpenAIChatReasoningDelta,
} from "./openai-chat-thinking-wire.js";
