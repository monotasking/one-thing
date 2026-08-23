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
import { OPENAI_CHAT_USAGE_TABLE } from "../openai-chat-wire.js";

function normalizerFor(providerId: string): UsageNormalizer {
	const dialect = getDialect(providerId);
	if (!dialect) throw new Error(`dialect ${providerId} is not registered`);
	return dialect.usage ?? new PathUsageNormalizer(OPENAI_CHAT_USAGE_TABLE);
}

function bucketsFor(providerId: string, usage: unknown): UsageBuckets {
	const buckets = normalizerFor(providerId).toBuckets(usage);
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
	it("cost 进 providerCostUSD,**不**投影进 AgentUsage", () => {
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
		});
		expect(buckets.toAgentUsage()).not.toHaveProperty("providerCostUSD");
	});
});

describe("grok / grok-oauth(cost_in_usd_ticks)", () => {
	const SAMPLE = {
		prompt_tokens: 1200,
		completion_tokens: 300,
		total_tokens: 1500,
		prompt_tokens_details: { cached_tokens: 800 },
		completion_tokens_details: { reasoning_tokens: 120 },
		cost_in_usd_ticks: 12_300_000,
	};

	for (const providerId of ["grok", "grok-oauth"]) {
		it(`${providerId} —— ticks / 1e10 进 providerCostUSD`, () => {
			const buckets = bucketsFor(providerId, SAMPLE);
			expectBuckets(buckets, {
				uncachedInput: 400,
				cacheRead: 800,
				cacheWrite: 0,
				output: 300,
				reasoning: 120,
				providerCostUSD: 0.00123,
				reportedTotal: 1500,
			});
			expect(buckets.toAgentUsage()).not.toHaveProperty("providerCostUSD");
		});
	}

	it("没有 ticks 就没有报价(不造零)", () => {
		expect(
			bucketsFor("grok", {
				prompt_tokens: 1200,
				completion_tokens: 300,
				total_tokens: 1500,
			}).providerCostUSD,
		).toBeUndefined();
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
