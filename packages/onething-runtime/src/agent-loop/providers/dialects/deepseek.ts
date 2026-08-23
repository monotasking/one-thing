/**
 * `deepseek` —— 唯一一份**不是**从 `openai-compatible.ts` 那批注册旋钮读出来的
 * 配方:它来自整整一份 `deepseek.ts`。今天的全部怪癖原样保留(P0a 是搬运,
 * 每一条的修法都写在设计稿 §9 的 P0b 行里):
 *
 *  1. **user 内容压成纯文本**(`DeepSeekPartCodec`)—— 图和 PDF 静默消失;
 *  2. **assistant `reasoning_content` 无条件回传**(带 tools 的多轮不回传会 400);
 *  3. **usage 读 `prompt_cache_hit_tokens`**,而且**不读** reasoning
 *     (`completion_tokens_details.reasoning_tokens` 今天没人看);
 *  4. **思考是推断出来的**:调用方不说话时 reasoner 类模型自己打开
 *     —— 于是「思考开着就不发 temperature」这条也必须按**推断后**的值判,
 *     所以采样策略是自己一份(`DeepSeekSamplingPolicy`);
 *  5. **错误文案首字母大写**:`DeepSeek agent loop API error: …`
 *     (统一成小写是设计稿 §10 第 1 条,P1 拍板)。
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
import { DeepSeekPartCodec } from "../wires/index.js";
import { defineOpenAIChatDialect } from "./recipe.js";

/**
 * DeepSeek 的 usage:`prompt_tokens` 含缓存命中,`prompt_cache_hit_tokens` 是
 * 其中折扣的那部分 —— 直译成三桶就是 `uncached = prompt − hit`、`cacheRead = hit`。
 * **没有 reasoning 行**:今天的 `usageFromChunk` 不读它,P0a 不补。
 */
export const DEEPSEEK_USAGE_TABLE: UsagePathTable = {
	uncachedInput: (_raw, read) =>
		(read("prompt_tokens") ?? 0) - (read("prompt_cache_hit_tokens") ?? 0),
	cacheRead: "prompt_cache_hit_tokens",
	output: (_raw, read) => read("completion_tokens") ?? 0,
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
	displayName: "DeepSeek",
	defaultBaseUrl: "https://api.deepseek.com",
	reasoning: deepSeekInferredThinkingWire,
	parts: new DeepSeekPartCodec(),
	usage: new PathUsageNormalizer(DEEPSEEK_USAGE_TABLE),
	sampling: new DeepSeekSamplingPolicy(),
	transport: DEEPSEEK_TRANSPORT_CAPABILITIES,
});
