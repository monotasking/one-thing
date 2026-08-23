/**
 * `deepseek` —— 唯一一份**不是**从 `openai-compatible.ts` 那批注册旋钮读出来的
 * 配方:它来自整整一份 `deepseek.ts`。
 *
 *  1. **user 内容走线级 codec**(P0b-A):vision-exp 类模型收 `image_url`
 *     内容块,其余附件留成可见文本 —— 曾经的 `DeepSeekPartCodec` 把 user 压成
 *     纯文本,图和 PDF **静默**消失,那份 codec 已随本期删除;
 *  2. **assistant `reasoning_content` 无条件回传**(带 tools 的多轮不回传会 400)
 *     —— 线级 codec 的 `includeAssistantReasoning` 恒开;
 *  3. **usage 读 `prompt_cache_hit/miss_tokens`**(DeepSeek 是少数直接报「未命中」
 *     的家),reasoning 读 `completion_tokens_details.reasoning_tokens`;
 *  4. **思考是推断出来的**:调用方不说话时 reasoner 类模型自己打开
 *     —— 于是「思考开着就不发 temperature」这条也必须按**推断后**的值判,
 *     所以采样策略是自己一份(`DeepSeekSamplingPolicy`);
 *  5. **错误文案与别家同规**:`deepseek agent loop API error: …` —— 曾经写作
 *     `DeepSeek` 的那个家名随 `displayName` 字段一起退役(设计稿 §10 第 1 条,
 *     P0b-B 拍板)。
 */
import type { AgentModelCapabilities } from "@onething/core/agent-loop";
import {
	PathUsageNormalizer,
	type RequestBodyBuilder,
	type SamplingPolicy,
	type TurnContext,
	type UsagePathTable,
} from "../base/index.js";
import { deepSeekInferredThinkingWire, resolveDeepSeekThinking } from "../thinking/index.js";
import { DEEPSEEK_IMAGE_DETAIL_VALUES } from "../wires/index.js";
import { defineOpenAIChatDialect } from "./recipe.js";

/**
 * DeepSeek 的 usage(设计稿 §7 第二行):`prompt_tokens` 含缓存命中,
 * `prompt_cache_hit_tokens` 是其中折扣的那部分。DeepSeek 还**直接报未命中**
 * (`prompt_cache_miss_tokens`)—— 有就用厂商的,没有才 `prompt − hit`。
 * 这条线上没有 cacheWrite(缓存全自动,不单独计费)。
 */
export const DEEPSEEK_USAGE_TABLE: UsagePathTable = {
	uncachedInput: (_raw, read) =>
		read("prompt_cache_miss_tokens") ??
		(read("prompt_tokens") ?? 0) - (read("prompt_cache_hit_tokens") ?? 0),
	cacheRead: "prompt_cache_hit_tokens",
	output: (_raw, read) => read("completion_tokens") ?? 0,
	reasoning: ["completion_tokens_details", "reasoning_tokens"],
	reportedTotal: "total_tokens",
};

/**
 * 「思考开着就不发 temperature」——按**推断后**的思考状态判。
 * 一条按 `request.thinking` 判的规则会在 `deepseek-reasoner` 上放行 temperature,
 * 那正是 `deepseek-provider.test` 锁住的那个回归。
 */
export class DeepSeekSamplingPolicy implements SamplingPolicy {
	apply(turn: TurnContext, builder: RequestBodyBuilder): void {
		const { temperature, thinking } = turn.request;
		if (temperature === undefined) return;
		if (resolveDeepSeekThinking(turn.model, thinking) === "enabled") {
			turn.warn(
				"setting-dropped",
				"temperature is not sent while thinking is enabled",
				{ temperature },
			);
			return;
		}
		builder.set("temperature", temperature);
	}
}

/** `deepseek.ts` 里那份写死的默认能力声明。 */
export const DEEPSEEK_TRANSPORT_CAPABILITIES: AgentModelCapabilities = {
	capabilities: ["text-input", "text-output", "streaming", "tool-calls", "reasoning"],
	inputModalities: ["text"],
	outputModalities: ["text"],
	supportsTools: true,
	supportsReasoning: true,
	supportsStreaming: true,
	// OpenAI-compatible tool_choice: "required"
	supportsForcedToolUse: true,
};

export const DEEPSEEK_DIALECT = defineOpenAIChatDialect({
	id: "deepseek",
	defaultBaseUrl: "https://api.deepseek.com",
	reasoning: deepSeekInferredThinkingWire,
	// 线级 codec(`OpenAIChatPartCodec`),`includeAssistantReasoning` 恒开。
	includeAssistantReasoning: true,
	usage: new PathUsageNormalizer(DEEPSEEK_USAGE_TABLE),
	sampling: new DeepSeekSamplingPolicy(),
	// vision-exp 端点的 `image_url.detail` 比标准多一个 `original`(原图不缩放)
	// —— 值域是这一家的事实,所以按家给表而不是取并集(P3-3)。
	providerOptions: { imageDetail: DEEPSEEK_IMAGE_DETAIL_VALUES },
	transport: DEEPSEEK_TRANSPORT_CAPABILITIES,
});
