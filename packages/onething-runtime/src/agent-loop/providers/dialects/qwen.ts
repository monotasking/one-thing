/**
 * `qwen` —— 千问 / DashScope 兼容模式。对照 `factory.ts`:`defaultBaseUrl` /
 * `supportsVision:true` / `supportsReasoning:true` /
 * `includeAssistantReasoning:true`(qwen3.8-max 默认 preserve_thinking,
 * 历史里 `reasoning_content` 被丢掉会被拒)/ `reasoningStyle:'qwen-thinking'`。
 */
import { ONETHING_QWEN_DEFAULT_BASE_URL } from "../../../providers/qwen.js";
import type { UsagePathTable } from "../base/index.js";
import { qwenThinkingWire } from "../thinking/index.js";
import { openAIChatUsage, openAIChatUsageTable } from "../wires/index.js";
import { defineOpenAIChatDialect, openAIChatTransportCapabilities } from "./recipe.js";

/**
 * Qwen 的显式缓存(`cache_control`)把**写入量**报在顶层
 * `cache_creation_input_tokens`,而且它是 `prompt_tokens` **之外**的额外量
 * (与 OpenAI / OpenRouter 的 `cache_write_tokens` ⊂ prompt 不同)——
 * 所以 `uncachedInput` 只减 `cached`,不减它。
 * 命中量的字段名两处都出现过,先读 details 再退顶层。
 */
export const QWEN_USAGE_TABLE: UsagePathTable = openAIChatUsageTable({
	uncachedInput: (_raw, read) =>
		(read("prompt_tokens") ?? 0) -
		(read(["prompt_tokens_details", "cached_tokens"]) ?? 0),
	cacheRead: (_raw, read) =>
		read(["prompt_tokens_details", "cached_tokens"]) ?? read("cached_tokens"),
	cacheWrite: "cache_creation_input_tokens",
});

export const QWEN_DIALECT = defineOpenAIChatDialect({
	id: "qwen",
	defaultBaseUrl: ONETHING_QWEN_DEFAULT_BASE_URL,
	reasoning: qwenThinkingWire,
	includeAssistantReasoning: true,
	usage: openAIChatUsage(QWEN_USAGE_TABLE),
	transport: openAIChatTransportCapabilities({ vision: true, reasoning: true }),
});
