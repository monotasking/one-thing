/**
 * usage 三桶的**固定样本**门(设计稿 §7 的那张表,一家一行)。
 *
 * 每个用例给一段该家**真实形状**的 usage JSON,断言三桶的每个字段与
 * `toAgentUsage()` 投影的每个字段。表改一行、样本改一行 —— 谁先漂谁红。
 *
 * 取的是**注册在案的配方**上那只 normalizer(`dialect.usage`),配方没给
 * 就是线级默认表 —— 与 `HttpAgentProvider.usage` 那个 getter 同一条回落链,
 * 所以这份门守的是「线上真的会用哪张表」,不是「文件里写了哪张表」。
 */
import { describe, expect, it } from "vitest";
import {
	PathUsageNormalizer,
	getDialect,
	type UsageBuckets,
	type UsageNormalizer,
} from "../../base/index.js";
import "../../dialects/index.js";
import { anthropicUsage } from "../anthropic-usage.js";
import { geminiUsage } from "../gemini-wire.js";
import { OPENAI_CHAT_USAGE_TABLE } from "../openai-chat-wire.js";
import { codexResponsesUsage } from "../openai-responses-wire.js";

/** 线级默认表 —— `HttpAgentProvider.usage` 回落到的那只(`defaultUsage`)。 */
const OPENAI_CHAT_DEFAULT: UsageNormalizer = new PathUsageNormalizer(OPENAI_CHAT_USAGE_TABLE);

function normalizerFor(providerId: string, wireDefault: UsageNormalizer): UsageNormalizer {
	const dialect = getDialect(providerId);
	if (!dialect) throw new Error(`dialect ${providerId} is not registered`);
	return dialect.usage ?? wireDefault;
}

function bucketsFor(
	providerId: string,
	usage: unknown,
	wireDefault: UsageNormalizer = OPENAI_CHAT_DEFAULT,
): UsageBuckets {
	const buckets = normalizerFor(providerId, wireDefault).toBuckets(usage);
	if (!buckets) throw new Error(`${providerId} produced no buckets for the sample`);
	return buckets;
}

/** 三桶 + 投影,一次全断言 —— 「每个字段」是这份门的字面要求。 */
function expectBuckets(
	buckets: UsageBuckets,
	expected: {
		uncachedInput: number;
		cacheRead: number;
		cacheWrite: number;
		output: number;
		reasoning?: number;
		providerCostUSD?: number;
		reportedTotal?: number;
	},
): void {
	expect({
		uncachedInput: buckets.uncachedInput,
		cacheRead: buckets.cacheRead,
		cacheWrite: buckets.cacheWrite,
		output: buckets.output,
		reasoning: buckets.reasoning,
		providerCostUSD: buckets.providerCostUSD,
		reportedTotal: buckets.reportedTotal,
	}).toEqual({
		uncachedInput: expected.uncachedInput,
		cacheRead: expected.cacheRead,
		cacheWrite: expected.cacheWrite,
		output: expected.output,
		reasoning: expected.reasoning,
		providerCostUSD: expected.providerCostUSD,
		reportedTotal: expected.reportedTotal,
	});
}

// ---------------------------------------------------------------------------
// openai-chat 默认表:openai / zhipu / github-copilot / custom-openai
// ---------------------------------------------------------------------------

describe("openai-chat 默认表(prompt ⊃ cached ⊎ cache_write)", () => {
	/** GPT-5.6+ 才有 `cache_write_tokens`;读 0.1× / 写 1.25× / 未缓存 1×。 */
	const SAMPLE = {
		prompt_tokens: 1200,
		completion_tokens: 300,
		total_tokens: 1500,
		prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 },
		completion_tokens_details: { reasoning_tokens: 120 },
	};

	for (const providerId of ["openai", "zhipu", "github-copilot", "custom-openai"]) {
		it(`${providerId} —— 三桶与投影`, () => {
			const buckets = bucketsFor(providerId, SAMPLE);
			expectBuckets(buckets, {
				uncachedInput: 300,
				cacheRead: 800,
				cacheWrite: 100,
				output: 300,
				reasoning: 120,
				reportedTotal: 1500,
			});
			expect(buckets.toAgentUsage()).toEqual({
				inputTokens: 1100,
				outputTokens: 300,
				totalTokens: 1500,
				cacheReadTokens: 800,
				cacheWriteTokens: 100,
				reasoningTokens: 120,
			});
		});
	}

	it("老模型没有 cache_write_tokens —— 那一桶是 0,不是 undefined", () => {
		const buckets = bucketsFor("openai", {
			prompt_tokens: 1200,
			completion_tokens: 300,
			total_tokens: 1500,
			prompt_tokens_details: { cached_tokens: 800 },
		});
		expectBuckets(buckets, {
			uncachedInput: 400,
			cacheRead: 800,
			cacheWrite: 0,
			output: 300,
			reasoning: undefined,
			reportedTotal: 1500,
		});
		expect(buckets.toAgentUsage()).toEqual({
			inputTokens: 1200,
			outputTokens: 300,
			totalTokens: 1500,
			cacheReadTokens: 800,
		});
	});
});

// ---------------------------------------------------------------------------
// DeepSeek —— 少数直接报「未命中」的家
// ---------------------------------------------------------------------------

describe("deepseek(prompt_cache_hit / miss)", () => {
	it("厂商报了 miss 就用厂商的", () => {
		const buckets = bucketsFor("deepseek", {
			prompt_tokens: 1200,
			completion_tokens: 300,
			total_tokens: 1500,
			prompt_cache_hit_tokens: 900,
			prompt_cache_miss_tokens: 300,
			completion_tokens_details: { reasoning_tokens: 150 },
		});
		expectBuckets(buckets, {
			uncachedInput: 300,
			cacheRead: 900,
			cacheWrite: 0,
			output: 300,
			reasoning: 150,
			reportedTotal: 1500,
		});
		expect(buckets.toAgentUsage()).toEqual({
			inputTokens: 1200,
			outputTokens: 300,
			totalTokens: 1500,
			cacheReadTokens: 900,
			reasoningTokens: 150,
		});
	});

	it("没有 miss 字段就 prompt − hit", () => {
		expectBuckets(
			bucketsFor("deepseek", {
				prompt_tokens: 1200,
				completion_tokens: 300,
				total_tokens: 1500,
				prompt_cache_hit_tokens: 900,
			}),
			{
				uncachedInput: 300,
				cacheRead: 900,
				cacheWrite: 0,
				output: 300,
				reasoning: undefined,
				reportedTotal: 1500,
			},
		);
	});
});

// ---------------------------------------------------------------------------
// Kimi —— 顶层 cached_tokens
// ---------------------------------------------------------------------------

describe("kimi / kimi-code(顶层 cached_tokens)", () => {
	/**
	 * ⚠️ 研究里对「顶层 `cached_tokens` 是不是 `prompt_tokens` 的子集」**标了疑**
	 * (设计稿 §13 未采纳/另议)。这里按 **⊂ 处理**:`uncached = prompt − cached`,
	 * 于是 `input === prompt_tokens`(1200),缓存命中只是其中折扣的那部分。
	 * 若真机样本证伪(顶层 cached 是 prompt 之外的额外量),改的是
	 * `dialects/kimi.ts` 的那一行与这个用例,投影与账本都不动。
	 */
	const SAMPLE = {
		prompt_tokens: 1200,
		completion_tokens: 300,
		total_tokens: 1500,
		cached_tokens: 900,
	};

	for (const providerId of ["kimi", "kimi-code"]) {
		it(`${providerId} —— 三桶与投影`, () => {
			const buckets = bucketsFor(providerId, SAMPLE);
			expectBuckets(buckets, {
				uncachedInput: 300,
				cacheRead: 900,
				cacheWrite: 0,
				output: 300,
				reasoning: undefined,
				reportedTotal: 1500,
			});
			expect(buckets.input).toBe(1200);
			expect(buckets.toAgentUsage()).toEqual({
				inputTokens: 1200,
				outputTokens: 300,
				totalTokens: 1500,
				cacheReadTokens: 900,
			});
		});
	}

	it("退回 prompt_tokens_details.cached_tokens(顶层缺失时)", () => {
		expectBuckets(
			bucketsFor("kimi", {
				prompt_tokens: 1200,
				completion_tokens: 300,
				total_tokens: 1500,
				prompt_tokens_details: { cached_tokens: 400 },
			}),
			{
				uncachedInput: 800,
				cacheRead: 400,
				cacheWrite: 0,
				output: 300,
				reasoning: undefined,
				reportedTotal: 1500,
			},
		);
	});
});

// ---------------------------------------------------------------------------
// OpenRouter / Grok —— 厂商报价
// ---------------------------------------------------------------------------

describe("openrouter(cost)", () => {
	it("cost 进 providerCostUSD,并投影进 AgentUsage(与本地价目并存)", () => {
		const buckets = bucketsFor("openrouter", {
			prompt_tokens: 1200,
			completion_tokens: 300,
			total_tokens: 1500,
			cost: 0.00123,
			prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 },
			completion_tokens_details: { reasoning_tokens: 120 },
		});
		expectBuckets(buckets, {
			uncachedInput: 300,
			cacheRead: 800,
			cacheWrite: 100,
			output: 300,
			reasoning: 120,
			providerCostUSD: 0.00123,
			reportedTotal: 1500,
		});
		expect(buckets.toAgentUsage()).toEqual({
			inputTokens: 1100,
			outputTokens: 300,
			totalTokens: 1500,
			cacheReadTokens: 800,
			cacheWriteTokens: 100,
			reasoningTokens: 120,
			providerCostUSD: 0.00123,
		});
	});
});

/**
 * xAI 换线之后(P4-4)usage 是 **Responses 的字段名**,不再是 chat 的
 * `prompt_tokens` 那一套。官方 `POST /v1/responses` → Response Body → usage:
 * `input_tokens` / `input_tokens_details.cached_tokens` / `output_tokens` /
 * `output_tokens_details.reasoning_tokens` / `total_tokens` /
 * `cost_in_usd_ticks`(1e10 ticks = $1)。
 *
 * **没有 `cache_write_tokens`** —— xAI 的定价页只有 input / cached input /
 * output 三档,不报写缓存,那一桶恒 0。
 */
describe("grok / grok-oauth(Responses usage + cost_in_usd_ticks)", () => {
	const SAMPLE = {
		input_tokens: 1200,
		input_tokens_details: { cached_tokens: 800 },
		output_tokens: 300,
		output_tokens_details: { reasoning_tokens: 120 },
		total_tokens: 1500,
		num_sources_used: 2,
		num_server_side_tools_used: 0,
		cost_in_usd_ticks: 12_300_000,
	};

	for (const providerId of ["grok", "grok-oauth"]) {
		it(`${providerId} —— ticks / 1e10 进 providerCostUSD`, () => {
			const buckets = bucketsFor(providerId, SAMPLE, codexResponsesUsage);
			expectBuckets(buckets, {
				uncachedInput: 400,
				cacheRead: 800,
				cacheWrite: 0,
				output: 300,
				reasoning: 120,
				providerCostUSD: 0.00123,
				reportedTotal: 1500,
			});
			expect(buckets.toAgentUsage().providerCostUSD).toBe(0.00123);
		});
	}

	it("没有 ticks 就没有报价(不造零)", () => {
		const buckets = bucketsFor(
			"grok",
			{ input_tokens: 1200, output_tokens: 300, total_tokens: 1500 },
			codexResponsesUsage,
		);
		expect(buckets.providerCostUSD).toBeUndefined();
		// 没报价的家一个字节都不变:投影里连这个键都不该出现。
		expect(buckets.toAgentUsage()).not.toHaveProperty("providerCostUSD");
	});

	it("codex 同在这条线上,但不认 cost_in_usd_ticks(报价是方言的一行)", () => {
		const buckets = bucketsFor("codex", SAMPLE, codexResponsesUsage);
		expect(buckets.providerCostUSD).toBeUndefined();
	});

	it("报价是 0(免费模型)也带出去 —— 0 与「没报」是两件事", () => {
		const buckets = bucketsFor("openrouter", {
			prompt_tokens: 100,
			completion_tokens: 10,
			cost: 0,
		});
		expect(buckets.providerCostUSD).toBe(0);
		expect(buckets.toAgentUsage().providerCostUSD).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Qwen —— cache_creation 是 prompt 之外的额外量
// ---------------------------------------------------------------------------

describe("qwen(cache_creation_input_tokens 不从 prompt 里减)", () => {
	it("三桶与投影", () => {
		const buckets = bucketsFor("qwen", {
			prompt_tokens: 1200,
			completion_tokens: 300,
			total_tokens: 1500,
			prompt_tokens_details: { cached_tokens: 800 },
			cache_creation_input_tokens: 256,
			completion_tokens_details: { reasoning_tokens: 120 },
		});
		expectBuckets(buckets, {
			uncachedInput: 400,
			cacheRead: 800,
			cacheWrite: 256,
			output: 300,
			reasoning: 120,
			reportedTotal: 1500,
		});
		// input 仍是 prompt_tokens —— 写入量在它之外单独计费。
		expect(buckets.input).toBe(1200);
		expect(buckets.toAgentUsage()).toEqual({
			inputTokens: 1200,
			outputTokens: 300,
			totalTokens: 1500,
			cacheReadTokens: 800,
			cacheWriteTokens: 256,
			reasoningTokens: 120,
		});
	});
});

// ---------------------------------------------------------------------------
// reportedTotal —— 厂商报了就用厂商的
// ---------------------------------------------------------------------------

describe("reportedTotal", () => {
	it("厂商的 total 与派生值不一致时,以厂商为准", () => {
		const buckets = bucketsFor("openai", {
			prompt_tokens: 1200,
			completion_tokens: 300,
			// 厂商把 reasoning 也算进了 total —— 派生值会是 1500。
			total_tokens: 1620,
			prompt_tokens_details: { cached_tokens: 800 },
			completion_tokens_details: { reasoning_tokens: 120 },
		});
		expect(buckets.input + buckets.output).toBe(1500);
		expect(buckets.total).toBe(1620);
		expect(buckets.toAgentUsage().totalTokens).toBe(1620);
	});

	it("厂商没报就派生 input + output", () => {
		const buckets = bucketsFor("openai", {
			prompt_tokens: 1200,
			completion_tokens: 300,
		});
		expect(buckets.reportedTotal).toBeUndefined();
		expect(buckets.toAgentUsage().totalTokens).toBe(1500);
	});
});

// ---------------------------------------------------------------------------
// Anthropic —— input_tokens / cache_creation / cache_read 三者**互斥**
// ---------------------------------------------------------------------------

describe("anthropic(总输入 = input + cache_creation + cache_read)", () => {
	/**
	 * 数字取自设计稿 §12 的那种真实形状:**`cache_read` 远大于 `input_tokens`**
	 * —— 长对话第二轮起,几乎整段前缀都命中缓存,现算的只剩最后那几十个 token。
	 * 旧实现把 `input_tokens` 直接当总输入,于是这一回合的输入被钳在 42;三桶
	 * 直译之后 `input = 42 + 31_500 = 31_542`。
	 */
	const SAMPLE = {
		input_tokens: 42,
		cache_read_input_tokens: 31_500,
		cache_creation_input_tokens: 1_024,
		output_tokens: 860,
		output_tokens_details: { thinking_tokens: 512 },
	};

	for (const providerId of ["claude", "claude-code", "custom-anthropic"]) {
		it(`${providerId} —— 三桶与投影`, () => {
			const buckets = bucketsFor(providerId, SAMPLE, anthropicUsage);
			expectBuckets(buckets, {
				uncachedInput: 42,
				cacheRead: 31_500,
				cacheWrite: 1_024,
				output: 860,
				reasoning: 512,
				// Anthropic 不报 total —— 派生 input + output。
				reportedTotal: undefined,
			});
			expect(buckets.input).toBe(31_542);
			expect(buckets.toAgentUsage()).toEqual({
				inputTokens: 31_542,
				outputTokens: 860,
				totalTokens: 32_402,
				cacheReadTokens: 31_500,
				cacheWriteTokens: 1_024,
				reasoningTokens: 512,
			});
		});
	}

	it("缓存命中不再被钳成 input_tokens(这条就是修正本身)", () => {
		const buckets = bucketsFor("claude", SAMPLE, anthropicUsage);
		expect(buckets.toAgentUsage().inputTokens).not.toBe(SAMPLE.input_tokens);
	});

	it("没有 thinking_tokens 就没有 reasoning(不造零)", () => {
		const buckets = bucketsFor(
			"claude",
			{ input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 80 },
			anthropicUsage,
		);
		expect(buckets.reasoning).toBeUndefined();
		expect(buckets.toAgentUsage()).toEqual({
			inputTokens: 180,
			outputTokens: 40,
			totalTokens: 220,
			cacheReadTokens: 80,
		});
	});
});

// ---------------------------------------------------------------------------
// Gemini —— thoughts 不在 candidates 内,但按输出计费
// ---------------------------------------------------------------------------

describe("gemini(output = candidates + thoughts)", () => {
	/** 官方口径:`totalTokenCount = prompt + thoughts + candidates`。 */
	const SAMPLE = {
		promptTokenCount: 1_200,
		cachedContentTokenCount: 800,
		candidatesTokenCount: 248,
		thoughtsTokenCount: 96,
		totalTokenCount: 1_544,
	};

	it("三桶与投影", () => {
		const buckets = bucketsFor("gemini", SAMPLE, geminiUsage);
		expectBuckets(buckets, {
			uncachedInput: 400,
			cacheRead: 800,
			cacheWrite: 0,
			output: 344,
			reasoning: 96,
			reportedTotal: 1_544,
		});
		// promptTokenCount 含 cached —— 投影还原回 1200,不重复计。
		expect(buckets.input).toBe(1_200);
		expect(buckets.toAgentUsage()).toEqual({
			inputTokens: 1_200,
			outputTokens: 344,
			totalTokens: 1_544,
			cacheReadTokens: 800,
			reasoningTokens: 96,
		});
	});

	it("厂商 total 与三桶派生一致时也走 reportedTotal", () => {
		const buckets = bucketsFor("gemini", SAMPLE, geminiUsage);
		expect(buckets.input + buckets.output).toBe(1_544);
		expect(buckets.total).toBe(1_544);
	});

	it("没有 thoughts 时 output 就是 candidates", () => {
		expectBuckets(
			bucketsFor(
				"gemini",
				{ promptTokenCount: 500, candidatesTokenCount: 120, totalTokenCount: 620 },
				geminiUsage,
			),
			{
				uncachedInput: 500,
				cacheRead: 0,
				cacheWrite: 0,
				output: 120,
				reasoning: undefined,
				reportedTotal: 620,
			},
		);
	});
});

// ---------------------------------------------------------------------------
// codex / Responses —— input 含 cached 与 cache_write
// ---------------------------------------------------------------------------

describe("codex(input − cached − cache_write)", () => {
	const SAMPLE = {
		input_tokens: 1_200,
		output_tokens: 300,
		total_tokens: 1_500,
		input_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 },
		output_tokens_details: { reasoning_tokens: 120 },
	};

	it("三桶与投影", () => {
		const buckets = bucketsFor("codex", SAMPLE, codexResponsesUsage);
		expectBuckets(buckets, {
			uncachedInput: 300,
			cacheRead: 800,
			cacheWrite: 100,
			output: 300,
			reasoning: 120,
			reportedTotal: 1_500,
		});
		expect(buckets.toAgentUsage()).toEqual({
			inputTokens: 1_100,
			outputTokens: 300,
			totalTokens: 1_500,
			cacheReadTokens: 800,
			cacheWriteTokens: 100,
			reasoningTokens: 120,
		});
	});

	it("老模型没有 cache_write_tokens —— input 原样还原(与快照一致)", () => {
		const buckets = bucketsFor(
			"codex",
			{
				input_tokens: 1_200,
				output_tokens: 248,
				total_tokens: 1_448,
				input_tokens_details: { cached_tokens: 800 },
				output_tokens_details: { reasoning_tokens: 96 },
			},
			codexResponsesUsage,
		);
		expectBuckets(buckets, {
			uncachedInput: 400,
			cacheRead: 800,
			cacheWrite: 0,
			output: 248,
			reasoning: 96,
			reportedTotal: 1_448,
		});
		expect(buckets.toAgentUsage()).toEqual({
			inputTokens: 1_200,
			outputTokens: 248,
			totalTokens: 1_448,
			cacheReadTokens: 800,
			reasoningTokens: 96,
		});
	});

	it("整块没有 usage 就是 undefined(不造零)", () => {
		expect(codexResponsesUsage.toBuckets({})).toBeUndefined();
	});
});
