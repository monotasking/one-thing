/**
 * openai-chat 线上的思考线型表 —— **按账本的 `OnethingReasoningWire` 值建表**
 * (设计稿 §2.7:Dialect 不持有线型,方言只声明「我这家可能出现哪几条」)。
 *
 * 这个模块一加载就把七条线型登记进进程级的 `thinkingWires`;
 * `openai-compatible.ts` 的构造门面靠它把 `reasoningStyle` 换成对象 ——
 * 那个 `switch` 从此不存在了。
 */
import { thinkingWires } from "../base/index.js";
import { deepSeekInferredThinkingWire } from "./deepseek-inferred.js";
import { grokEffortWire } from "./grok-effort.js";
import { openAIChatNoThinkingWire } from "./none.js";
import { openAIEffortWire } from "./openai-effort.js";
import { openRouterReasoningWire } from "./openrouter-reasoning.js";
import { qwenThinkingWire } from "./qwen-thinking.js";
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
	.register(deepSeekInferredThinkingWire);

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
export { ThinkingTypeWire, thinkingTypeWire } from "./thinking-type.js";
export { ZhipuThinkingWire, zhipuThinkingWire } from "./zhipu-thinking.js";
export {
	OpenAIChatThinkingWire,
	openAIChatDelta,
	type OpenAIChatReasoningDelta,
} from "./openai-chat-thinking-wire.js";
