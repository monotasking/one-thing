/**
 * usage 三桶 —— **规范化中间表示**(设计稿 §2.6 / §7)。
 *
 * `uncachedInput / cacheRead / cacheWrite` 三个桶互不交叠,每条 wire **直译**
 * 到桶(Anthropic 零加减法;OpenAI `prompt − read − write`),再由**一个**
 * 投影函数产出现行 `AgentUsage`。外部契约与落盘账本因此零改动。
 */
import type { AgentUsage } from "@onething/core/agent-loop";
import { computeOnethingUsageCostUSD } from "../../../usage/pricing.js";
import type { OnethingUsageUnitPrice } from "../../../usage/types.js";

function assertNonNegative(name: string, value: number | undefined): void {
	if (value === undefined) return;
	if (!Number.isFinite(value) || value < 0) {
		throw new RangeError(`UsageBuckets.${name} must be a non-negative finite number`);
	}
}

export class UsageBuckets {
	constructor(
		readonly uncachedInput: number,
		readonly cacheRead: number,
		readonly cacheWrite: number,
		readonly output: number,
		readonly reasoning?: number,
		readonly audio?: number,
		readonly providerCostUSD?: number,
		/**
		 * 厂商自己报的 `total_tokens`。**厂商报了就用厂商的**(保守:三桶是
		 * 规范化中间表示,而各家对「total 里算不算 cacheWrite / reasoning」的
		 * 口径不一 —— 派生值会与账本历史打架)。没报才派生 `input + output`。
		 */
		readonly reportedTotal?: number,
		readonly raw?: unknown,
	) {
		assertNonNegative("uncachedInput", uncachedInput);
		assertNonNegative("cacheRead", cacheRead);
		assertNonNegative("cacheWrite", cacheWrite);
		assertNonNegative("output", output);
		assertNonNegative("reasoning", reasoning);
		assertNonNegative("audio", audio);
		assertNonNegative("providerCostUSD", providerCostUSD);
		assertNonNegative("reportedTotal", reportedTotal);
	}

	/** cacheRead 是 input 的折扣子集,不是额外的量。 */
	get input(): number {
		return this.uncachedInput + this.cacheRead;
	}

	get total(): number {
		return this.reportedTotal ?? this.input + this.output;
	}

	/** 唯一的投影。`cacheWrite` 原样带出(它在 input 之外单独计费)。 */
	toAgentUsage(): AgentUsage {
		return {
			inputTokens: this.input,
			outputTokens: this.output,
			totalTokens: this.total,
			...(this.cacheRead ? { cacheReadTokens: this.cacheRead } : {}),
			...(this.cacheWrite ? { cacheWriteTokens: this.cacheWrite } : {}),
			...(this.reasoning ? { reasoningTokens: this.reasoning } : {}),
		};
	}

	/** 与账本同一条公式 —— 直接调 `computeOnethingUsageCostUSD`,不抄。 */
	billable(prices: OnethingUsageUnitPrice): number {
		return (
			computeOnethingUsageCostUSD(
				{
					input: this.input,
					output: this.output,
					cacheRead: this.cacheRead,
					cacheWrite: this.cacheWrite,
					reasoning: this.reasoning ?? 0,
					total: this.total,
				},
				prices,
			) ?? 0
		);
	}

	cacheHitRatio(): number {
		return this.input === 0 ? 0 : this.cacheRead / this.input;
	}
}

export interface UsageNormalizer {
	/** 认不出这块 usage(或者压根没有)就返回 undefined —— 不要造零。 */
	toBuckets(raw: unknown): UsageBuckets | undefined;
}

// ---------------------------------------------------------------------------
// 路径表实现
// ---------------------------------------------------------------------------

/** `'completion_tokens'` 或 `['prompt_tokens_details','cached_tokens']`。 */
export type UsagePath = string | readonly string[];

/** `prompt − read − write` 这类派生;结果夹在 0 以下。 */
export interface UsageDerivation {
	from: UsagePath;
	minus: readonly UsagePath[];
}

export type UsageFieldReader = (path: UsagePath) => number | undefined;

/** 路径 / 派生 / 自定义函数三选一 —— 一家一行,不进 switch。 */
export type UsageField =
	| UsagePath
	| UsageDerivation
	| ((raw: unknown, read: UsageFieldReader) => number | undefined);

export interface UsagePathTable {
	uncachedInput: UsageField;
	cacheRead?: UsageField;
	cacheWrite?: UsageField;
	output: UsageField;
	reasoning?: UsageField;
	audio?: UsageField;
	providerCostUSD?: UsageField;
	/** 厂商报的 total(`total_tokens`)。读不到就派生 `input + output`。 */
	reportedTotal?: UsageField;
	/**
	 * 「这块响应里到底有没有 usage」的判据。给了就按它判,读不到就返回
	 * undefined(OpenAI 只认 `[DONE]` 前那块);不给则以 `output` 是否读得到为准。
	 */
	presence?: UsagePath;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPath(raw: unknown, path: UsagePath): number | undefined {
	const segments = typeof path === "string" ? path.split(".") : path;
	let cursor: unknown = raw;
	for (const segment of segments) {
		if (!isPlainObject(cursor)) return undefined;
		cursor = cursor[segment];
	}
	return typeof cursor === "number" && Number.isFinite(cursor) ? cursor : undefined;
}

function isDerivation(field: UsageField): field is UsageDerivation {
	return isPlainObject(field) && "from" in field && "minus" in field;
}

export class PathUsageNormalizer implements UsageNormalizer {
	constructor(private readonly table: UsagePathTable) {}

	toBuckets(raw: unknown): UsageBuckets | undefined {
		if (!isPlainObject(raw)) return undefined;
		const read: UsageFieldReader = (path) => readPath(raw, path);
		const field = (spec: UsageField | undefined): number | undefined => {
			if (spec === undefined) return undefined;
			if (typeof spec === "function") return spec(raw, read);
			if (isDerivation(spec)) {
				const from = read(spec.from);
				if (from === undefined) return undefined;
				const subtracted = spec.minus.reduce(
					(acc, path) => acc - (read(path) ?? 0),
					from,
				);
				return Math.max(subtracted, 0);
			}
			return read(spec);
		};

		if (this.table.presence !== undefined && read(this.table.presence) === undefined) {
			return undefined;
		}

		const output = field(this.table.output);
		const uncachedInput = field(this.table.uncachedInput);
		if (this.table.presence === undefined && output === undefined && uncachedInput === undefined) {
			return undefined;
		}

		return new UsageBuckets(
			Math.max(uncachedInput ?? 0, 0),
			Math.max(field(this.table.cacheRead) ?? 0, 0),
			Math.max(field(this.table.cacheWrite) ?? 0, 0),
			Math.max(output ?? 0, 0),
			field(this.table.reasoning),
			field(this.table.audio),
			field(this.table.providerCostUSD),
			field(this.table.reportedTotal),
			raw,
		);
	}
}
