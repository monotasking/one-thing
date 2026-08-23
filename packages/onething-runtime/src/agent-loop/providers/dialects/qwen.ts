/**
 * `qwen` —— 千问 / DashScope 兼容模式。对照 `factory.ts`:`defaultBaseUrl` /
 * `supportsVision:true` / `supportsReasoning:true` /
 * `includeAssistantReasoning:true`(qwen3.8-max 默认 preserve_thinking,
 * 历史里 `reasoning_content` 被丢掉会被拒)/ `reasoningStyle:'qwen-thinking'`。
 */
import { ONETHING_QWEN_DEFAULT_BASE_URL } from "../../../providers/qwen.js";
import { qwenThinkingWire } from "../thinking/index.js";
import { defineOpenAIChatDialect, openAIChatTransportCapabilities } from "./recipe.js";

export const QWEN_DIALECT = defineOpenAIChatDialect({
	id: "qwen",
	defaultBaseUrl: ONETHING_QWEN_DEFAULT_BASE_URL,
	reasoning: qwenThinkingWire,
	includeAssistantReasoning: true,
	transport: openAIChatTransportCapabilities({ vision: true, reasoning: true }),
});
