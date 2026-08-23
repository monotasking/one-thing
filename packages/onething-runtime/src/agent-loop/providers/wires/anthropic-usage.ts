/**
 * Anthropic Messages 的 usage **直译**(设计稿 §7 的 Anthropic 行)。
 *
 * 官方口径(§12 研究摘要,Anthropic 一行):
 * **总输入 = `input_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens`,
 * 三者互斥** —— `input_tokens` 只是「这次真的现算的那部分」,把它当总输入会在
 * 缓存命中的回合少算(设计稿 §1 的病症表)。三桶直译之后由 `UsageBuckets` 的
 * 唯一投影还原:`input = uncachedInput + cacheRead`,`cacheWrite` 在 input 之外
 * 单独计费。
 *
 * Anthropic **不报 total**,所以 `reportedTotal` 留空 —— 投影派生 `input + output`。
 *
 * 这个函数是两处的**共同**入口:`AnthropicMessagesWire`(继承树内)与
 * `external-agents/claude-code-connector`(继承树外,但读的是同一份 Anthropic
 * usage —— 设计稿 §7 表末那一行「不在继承树,但必须同表修」)。
 */
import { UsageBuckets, type UsageNormalizer } from "../base/usage.js";

export interface AnthropicUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
	/** 有则读:思考 token 是 `output_tokens` 的子集,不额外加。 */
	output_tokens_details?: { thinking_tokens?: number };
}

/** 一段 Anthropic usage 原文 → 三桶。认不出(不是对象)就 undefined,不造零。 */
export function anthropicUsageBuckets(raw: unknown): UsageBuckets | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const usage = raw as AnthropicUsage;
	return new UsageBuckets(
		usage.input_tokens ?? 0,
		usage.cache_read_input_tokens ?? 0,
		usage.cache_creation_input_tokens ?? 0,
		usage.output_tokens ?? 0,
		usage.output_tokens_details?.thinking_tokens,
		undefined,
		undefined,
		// Anthropic 不报 total —— 派生 `input + output`。
		undefined,
		raw,
	);
}

export class AnthropicUsageNormalizer implements UsageNormalizer {
	toBuckets(raw: unknown): UsageBuckets | undefined {
		return anthropicUsageBuckets(raw);
	}
}

export const anthropicUsage: UsageNormalizer = new AnthropicUsageNormalizer();
