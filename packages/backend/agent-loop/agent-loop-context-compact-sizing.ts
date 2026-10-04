// 上下文压缩的第二步:按模型窗口定块大小与摘要请求的输出上限(字/token 比的校准、块字符数、max_tokens)。
// 「选哪段去压」在 `agent-loop-context-compact.ts`,分块摘要在 `agent-loop-context-compact-summary.ts`。
import { estimateTextTokens } from "./agent-loop-context-usage.js";

/**
 * 窗口未知时的回退块大小。真正的块大小由 `resolveCompactChunkChars` 按模型
 * 窗口算(2026-08-21):窗口够大时多数会话退回单块,这个 80k 只在注册表查不
 * 到窗口(或算出的可用预算为负)时兜底。
 */
export const MAX_CHUNK_CHARS = 80000;

/** 摘要请求里除转录之外的开销:指令正文 + 标签 + 余量。 */
export const COMPACT_PROMPT_OVERHEAD_TOKENS = 4_000;

/** 估算器误差的安全系数 —— 宁可块小一点,也不要一整块请求撞窗口。 */
export const COMPACT_CHUNK_FILL_RATIO = 0.8;

/** 块再小也没有意义:低于这个值不如多切几块。 */
export const MIN_CHUNK_CHARS = 20_000;

/** 注册表查不到输出上限时,切块用的保守预留量。 */
export const COMPACT_FALLBACK_RESERVED_OUTPUT_TOKENS = 8_192;

/**
 * provider 刚为这段文本报回来的真 token 数(`chars` 是同一段文本的字符数)。
 * 有它就不用估算器 —— 估算器只认「中文 1.8 字/token、其余 4 字/token」,
 * 对真实转录(JSON 工具参数、代码、路径)会低估,2026-09-08 实测低估 1.33×。
 */
export interface CompactCalibration {
	chars: number;
	tokens: number;
}

export type CompactCalibrationSource = "provider" | "estimator";

export interface CompactCharsPerToken {
	charsPerToken: number;
	source: CompactCalibrationSource;
}

/**
 * chars/token 比:有 provider 真数就用真数,否则退回实测自转录的估算器
 * (`transcript.length / estimateTextTokens(transcript)`)。写死 4 会让纯中文
 * 的块超窗口一倍,所以两条路都不写死。
 */
export function resolveCompactCharsPerToken(input: {
	transcript: string;
	calibration?: CompactCalibration;
}): CompactCharsPerToken {
	const calibration = input.calibration;
	if (
		calibration &&
		Number.isFinite(calibration.chars) &&
		Number.isFinite(calibration.tokens) &&
		calibration.chars > 0 &&
		calibration.tokens > 0
	) {
		return {
			charsPerToken: calibration.chars / calibration.tokens,
			source: "provider",
		};
	}

	const estimatedTokens = estimateTextTokens(input.transcript);
	return {
		charsPerToken:
			input.transcript.length > 0 && estimatedTokens > 0
				? input.transcript.length / estimatedTokens
				: 4,
		source: "estimator",
	};
}

/**
 * 块大小随模型窗口走(2026-08-21)。chars/token 比见
 * `resolveCompactCharsPerToken`:2026-09-08 起可以拿 provider 真数校准。
 *
 * 不设上限:用户明确要把块做大(块越少,滚动/合并造成的信息损耗越少),
 * 单块超时设置是那一头的护栏。
 */
export function resolveCompactChunkChars(input: {
	transcript: string;
	modelContextLength?: number;
	reservedOutputTokens: number;
	calibration?: CompactCalibration;
}): number {
	const contextLength = input.modelContextLength;
	if (
		typeof contextLength !== "number" ||
		!Number.isFinite(contextLength) ||
		contextLength <= 0
	) {
		return MAX_CHUNK_CHARS;
	}

	const usableTokens =
		contextLength -
		Math.max(0, input.reservedOutputTokens) -
		COMPACT_PROMPT_OVERHEAD_TOKENS;
	if (usableTokens <= 0) return MAX_CHUNK_CHARS;

	const { charsPerToken } = resolveCompactCharsPerToken(input);

	const chars = Math.floor(
		usableTokens * charsPerToken * COMPACT_CHUNK_FILL_RATIO,
	);
	return Math.max(MIN_CHUNK_CHARS, chars);
}

/**
 * 一次请求能要多少输出 token(2026-09-08 事故:deepseek-v4-pro 的摘要请求把
 * `max_tokens` 填成模型的物理输出上限 384000,加上 701297 的输入越过 1048576
 * 的窗口,provider 400 拒单)。
 *
 * 判据只有三条:
 *  - 注册表查不到输出上限 → `undefined`,不传,让 provider 自报错
 *    (2026-08-15 裁定,不要改成编一个数)。
 *  - 窗口未知 → 注册上限原样(没有窗口就没什么可夹的)。
 *  - 否则 `min(注册上限, 窗口 − 输入 − 开销)`;算出来 ≤ 0 表示这一份输入
 *    本身就塞不下窗口,返回 `undefined`,由调用方决定怎么办(缩块 / 报错)。
 */
export function resolveCompactOutputTokens(input: {
	modelContextLength?: number;
	registeredMaxOutputTokens?: number;
	inputTokens: number;
	overheadTokens?: number;
}): number | undefined {
	const registered = input.registeredMaxOutputTokens;
	if (
		typeof registered !== "number" ||
		!Number.isFinite(registered) ||
		registered <= 0
	) {
		return undefined;
	}

	const contextLength = input.modelContextLength;
	if (
		typeof contextLength !== "number" ||
		!Number.isFinite(contextLength) ||
		contextLength <= 0
	) {
		return registered;
	}

	const overhead = input.overheadTokens ?? COMPACT_PROMPT_OVERHEAD_TOKENS;
	const room = Math.floor(
		contextLength - Math.max(0, input.inputTokens) - overhead,
	);
	if (room <= 0) return undefined;

	return Math.min(registered, room);
}

/** 一次请求的 `max_tokens` 与它的来历(错误文案/日志要说得清)。 */
export interface CompactOutputAllowance {
	maxTokens?: number;
	/** 这个数是怎么来的,原样进错误文案。 */
	provenance: string;
	/** true = 窗口装不下这一份输入,已经没有输出余量。 */
	overflow: boolean;
}

/**
 * 一次压缩的四个数(窗口 / 注册上限 / 校准比值 / 填充系数)收在这里,调用方
 * 只问不算 —— 从前它们散在 `summarizeInChunks` 的局部变量里,`max_tokens` 与
 * 切块各算各的,谁也不知道对方用的是哪个比值。
 */
export class CompactTokenBudget {
	readonly modelContextLength?: number;
	readonly registeredMaxOutputTokens?: number;
	readonly charsPerToken: number;
	readonly calibrationSource: CompactCalibrationSource;
	readonly overheadTokens: number;
	readonly maxChunkChars: number;

	constructor(input: {
		transcript: string;
		modelContextLength?: number;
		registeredMaxOutputTokens?: number;
		calibration?: CompactCalibration;
	}) {
		this.modelContextLength = positiveOrUndefined(input.modelContextLength);
		this.registeredMaxOutputTokens = positiveOrUndefined(
			input.registeredMaxOutputTokens,
		);
		const calibrated = resolveCompactCharsPerToken(input);
		this.charsPerToken = calibrated.charsPerToken;
		this.calibrationSource = calibrated.source;
		this.overheadTokens = COMPACT_PROMPT_OVERHEAD_TOKENS;
		this.maxChunkChars = resolveCompactChunkChars({
			transcript: input.transcript,
			modelContextLength: input.modelContextLength,
			reservedOutputTokens:
				this.registeredMaxOutputTokens ??
				COMPACT_FALLBACK_RESERVED_OUTPUT_TOKENS,
			calibration: input.calibration,
		});
	}

	/** 一段文本按校准比值折成多少 token。 */
	inputTokensForChars(chars: number): number {
		return Math.ceil(Math.max(0, chars) / this.charsPerToken);
	}

	/** 这一份输入能要多少输出 token,以及这个数的来历。 */
	outputAllowanceForChars(chars: number): CompactOutputAllowance {
		const registered = this.registeredMaxOutputTokens;
		if (registered === undefined) {
			return {
				maxTokens: undefined,
				provenance:
					"the provider's default max_tokens (no model max output is registered for this model)",
				overflow: false,
			};
		}

		const inputTokens = this.inputTokensForChars(chars);
		const clamped = resolveCompactOutputTokens({
			modelContextLength: this.modelContextLength,
			registeredMaxOutputTokens: registered,
			inputTokens,
			overheadTokens: this.overheadTokens,
		});

		if (clamped === undefined) {
			// 窗口装不下这一块的输入。本笔不做缩块重试(下一笔 A3):照传注册
			// 上限,让 provider 说真话,并把 overflow 交给调用方去 warn。
			return {
				maxTokens: registered,
				provenance: `the model's registered max output (window ${this.modelContextLength} leaves no room for input ${inputTokens} + overhead ${this.overheadTokens})`,
				overflow: true,
			};
		}

		return {
			maxTokens: clamped,
			provenance:
				clamped < registered
					? `clamped to window ${this.modelContextLength} − input ${inputTokens} − overhead ${this.overheadTokens}`
					: "the model's registered max output",
			overflow: false,
		};
	}
}

function positiveOrUndefined(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: undefined;
}
