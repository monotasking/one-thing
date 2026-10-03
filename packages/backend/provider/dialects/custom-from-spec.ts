/**
 * `CustomAdapterSpec` → `Dialect` —— **只做编译**(批 4 §7.2,
 * `docs/design/provider-settings-rework-2026-09.md`)。
 *
 * openai-chat 线是「读策略」的:usage 走路径表、思考增量走 `ThinkingWire.decode`、
 * 额外块走 `PartCodec.decodeExtras`、工具调用走 `ToolCallCodec`、收尾原因与结束标记走
 * `Dialect.finish`。所以一张适配表只需要被编译成这几个策略对象加一份配方 `request` 表,
 * 线的源码不读这张表:
 *
 *  - `response.usage`             → `PathUsageNormalizer`(默认表 `openAIChatUsageTable` + 偏差);
 *  - `response.reasoningDeltaPath` + `request.reasoning`
 *                                 → 一个 `ThinkingWire`(`encode` = 与 per-model 覆盖同一份
 *                                   声明式映射 `encodeCustomReasoning`;`decode` = 读路径,读不到
 *                                   退回线级的 `reasoning_content ?? reasoning`);
 *  - `response.textDeltaPath`(非默认)→ `decodeExtras` 按路径补 `text-delta`;
 *  - `response.toolCallsStyle` / `toolCallsPath` → 一个 `ToolCallCodec`(style 优先;默认路径 = 不换,
 *                                   线用自己的默认 codec;`choices[0].delta.function_call` 或
 *                                   style `function_call` = 老格式 codec;别的路径 = 按路径读的通用 codec);
 *  - `response.finishReasonPath` / `finishReasonMap` / `doneMarker`
 *                                 → `Dialect.finish`(映射表的值从适配表的连字符词翻成契约词);
 *  - `request.maxTokensField` / `streamUsage` / `extraBody` → 配方的 `request` 表与 `extraBody`。
 *
 * **落不进策略格的**,`unsupportedAdapterSpecFields` 如实列出,编译照常 —— 它们在运行期不生效,
 * 调用方负责说出来。openai-chat 这一条今天已经没有(§7.5 演练 09-26 补齐四格);剩下的是下面那句。
 *
 * 另外三条线(responses / anthropic / gemini)批 4 只接受 `wire` 与 `request` 两格:
 * 编译结果是那条线的通用配方换一个 id(§11 留账:那三条线的偏差没见过真实案例)。
 */
import type { AgentTurnStreamEvent } from "@onething/backend/agent-loop/loop-primitives";
import {
	CUSTOM_ADAPTER_DEFAULT_PATHS,
	type CustomAdapterFinishReason,
	type CustomAdapterSpec,
} from "@shared/contracts/adapter-spec";
import type { AgentFinishReason } from "@onething/backend/agent-loop/loop-primitives";
import {
	getPath,
	LEGACY_FUNCTION_CALL_CODEC,
	pathToolCallsCodec,
	type Dialect,
	type DialectFinishShape,
	type ToolCallCodec,
	type ThinkingWire,
	type TurnContext,
	type UsageField,
	type UsageNormalizer,
	type UsagePathTable,
} from "../base/index.js";
import { referenceDialectFor } from "../base/dialect.js";
import { encodeCustomReasoning } from "../thinking/custom-reasoning.js";
import { openAIEffortWire } from "../thinking/index.js";
import { openAIChatUsage } from "../wires/index.js";
import { CUSTOM_ANTHROPIC_DIALECT } from "./custom-anthropic.js";
import { openAIChatDialect, openAIChatTransportCapabilities } from "./recipe.js";
import { customAdapterDialectId } from "../manifest.js";

/** 适配表编译出来的方言 id —— 约定住在 manifest(那一侧也要认它),这里转一手。 */
export { customAdapterDialectId, isCustomAdapterDialectOf } from "../manifest.js";

/**
 * 这条线编译时以哪份配方为底(也是「应用」时写进表单的「接口类型」)。openai-chat 与 anthropic-messages 有协议层的
 * 通用配方;另外两条线以名册里声明自己是这条线参考配方的那一份为底(`Dialect.referenceFor`,今天答出来仍是
 * 官方 openai / gemini 两家的方言 id,与从前那张四格表逐格同值)。
 */
export function customAdapterBaseDialectId(wire: CustomAdapterSpec["wire"]): string {
	switch (wire) {
		case "openai-chat":
			return "custom-openai";
		case "anthropic-messages":
			return CUSTOM_ANTHROPIC_DIALECT.id;
		case "openai-responses":
		case "gemini-generateContent":
			return referenceDialectOf(wire).id;
	}
}

function nonDefault(value: string | undefined, fallback: string): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed !== fallback ? trimmed : undefined;
}

/** 编译照常、但运行期不生效的格(见文件头)。空数组 = 整张表都落进了策略格。 */
export function unsupportedAdapterSpecFields(spec: CustomAdapterSpec): string[] {
	if (!spec.response) return [];
	// 另外三条线批 4 只接 `wire` 与 `request`(§11 留账:那三条线的偏差没见过真实案例)。
	return spec.wire === "openai-chat" ? [] : ["response"];
}

function numberAt(raw: unknown, path: string): number | undefined {
	const value = getPath(raw, path);
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** usage 那一格 → 默认表 + 偏差。没写的格沿用默认表(`prompt_tokens` 那一套)。 */
function usageOf(usage: NonNullable<CustomAdapterSpec["response"]>["usage"]): UsageNormalizer | undefined {
	if (!usage || !Object.values(usage).some((path) => path?.trim())) return undefined;
	const overrides: Partial<UsagePathTable> = {};
	const path = (value: string | undefined) => value?.trim() || undefined;
	const input = path(usage.input);
	const output = path(usage.output);
	const cacheRead = path(usage.cacheRead);
	const reasoning = path(usage.reasoning);
	if (cacheRead) overrides.cacheRead = ((raw: unknown) => numberAt(raw, cacheRead)) satisfies UsageField;
	if (input) {
		// 三桶互不交叠:`input` 是含缓存的总输入,未命中那一桶 = input − cacheRead。
		overrides.uncachedInput = (raw: unknown, read) =>
			(numberAt(raw, input) ?? 0) -
			(cacheRead ? numberAt(raw, cacheRead) ?? 0 : read(["prompt_tokens_details", "cached_tokens"]) ?? 0);
	}
	if (output) overrides.output = (raw: unknown) => numberAt(raw, output) ?? 0;
	if (reasoning) overrides.reasoning = (raw: unknown) => numberAt(raw, reasoning);
	return openAIChatUsage(overrides);
}

function thinkingOf(spec: CustomAdapterSpec): ThinkingWire {
	const native = openAIEffortWire;
	const mapping = spec.request?.reasoning;
	const path = nonDefault(spec.response?.reasoningDeltaPath, CUSTOM_ADAPTER_DEFAULT_PATHS.reasoningDeltaPath);
	return {
		// id 跟线级那条走:模型账本点名 `openai-effort` 时,选中的还是这一条。
		id: native.id,
		encode: mapping
			? (turn, builder) => encodeCustomReasoning(turn, builder, mapping)
			: (turn, builder) => native.encode(turn, builder),
		decode: path
			? (chunk) => {
					const value = getPath(chunk, path);
					if (typeof value === "string" && value) return { reasoningDelta: value };
					return native.decode(chunk);
				}
			: (chunk) => native.decode(chunk),
	};
}

function textExtrasOf(spec: CustomAdapterSpec): ((chunk: unknown, turn: TurnContext) => AgentTurnStreamEvent[]) | undefined {
	const path = nonDefault(spec.response?.textDeltaPath, CUSTOM_ADAPTER_DEFAULT_PATHS.textDeltaPath);
	if (!path) return undefined;
	return (chunk, turn) => {
		const value = getPath(chunk, path);
		return typeof value === "string" && value ? [{ type: "text-delta", turn: turn.turn, delta: value }] : [];
	};
}

/** 老格式的那条默认位置 —— 路径写成它,等于 style 写 `function_call`。 */
const LEGACY_FUNCTION_CALL_PATH = "choices[0].delta.function_call";

/** 工具调用那一格 → codec。`undefined` = 不换,线用自己的默认 codec(今天的读法)。 */
export function toolCallsCodecOf(response: CustomAdapterSpec["response"]): ToolCallCodec | undefined {
	switch (response?.toolCallsStyle) {
		case "function_call":
			return LEGACY_FUNCTION_CALL_CODEC;
		case "tool_calls":
			return undefined;
		default:
			break;
	}
	const path = nonDefault(response?.toolCallsPath, CUSTOM_ADAPTER_DEFAULT_PATHS.toolCallsPath);
	if (!path) return undefined;
	if (path === LEGACY_FUNCTION_CALL_PATH) return LEGACY_FUNCTION_CALL_CODEC;
	return pathToolCallsCodec(path);
}

/** 适配表的连字符词 → 契约词。 */
const FINISH_REASON_WORDS: Record<CustomAdapterFinishReason, AgentFinishReason> = {
	stop: "stop",
	length: "length",
	"tool-calls": "tool_calls",
	"content-filter": "content_filter",
};

/** 收尾那三格 → `Dialect.finish`。三格都是默认 = `undefined`(线的默认读法)。 */
export function finishShapeOf(response: CustomAdapterSpec["response"]): DialectFinishShape | undefined {
	if (!response) return undefined;
	const shape: DialectFinishShape = {};
	const reasonPath = nonDefault(response.finishReasonPath, CUSTOM_ADAPTER_DEFAULT_PATHS.finishReasonPath);
	if (reasonPath) shape.reasonPath = reasonPath;
	const map: Record<string, AgentFinishReason> = {};
	for (const [raw, word] of Object.entries(response.finishReasonMap ?? {})) {
		const mapped = FINISH_REASON_WORDS[word];
		if (mapped) map[raw] = mapped;
	}
	if (Object.keys(map).length > 0) shape.reasonMap = map;
	if (response.doneMarker === null) shape.doneMarker = null;
	else if (typeof response.doneMarker === "string" && response.doneMarker !== CUSTOM_ADAPTER_DEFAULT_PATHS.doneMarker) {
		shape.doneMarker = response.doneMarker;
	}
	return Object.keys(shape).length > 0 ? shape : undefined;
}

function staticExtraBody(spec: CustomAdapterSpec): Dialect["extraBody"] | undefined {
	const extra = spec.request?.extraBody;
	if (!extra || Object.keys(extra).length === 0) return undefined;
	return () => structuredClone(extra) as Record<string, unknown>;
}

/** 另外三条线:通用配方换 id,`request` 那两格与 `extraBody` 叠上去。 */
function rebased(base: Dialect, id: string, spec: CustomAdapterSpec): Dialect {
	const { label: _label, referenceFor: _referenceFor, ...rest } = base;
	const extra = staticExtraBody(spec);
	const baseExtra = base.extraBody;
	return {
		...rest,
		id,
		request: {
			...base.request,
			...(spec.request?.maxTokensField ? { maxTokensField: spec.request.maxTokensField } : {}),
			...(spec.request?.streamUsage ? { streamUsage: spec.request.streamUsage } : {}),
		},
		...(extra
			? { extraBody: (turn: TurnContext) => ({ ...(baseExtra?.(turn) ?? {}), ...extra(turn) }) }
			: {}),
	};
}

function referenceDialectOf(wire: "openai-responses" | "gemini-generateContent"): Dialect {
	const base = referenceDialectFor(wire);
	if (!base) throw new Error(`no dialect declares itself the reference recipe for wire "${wire}"`);
	return base;
}

export function dialectFromSpec(providerId: string, spec: CustomAdapterSpec): Dialect {
	const id = customAdapterDialectId(providerId);
	switch (spec.wire) {
		case "anthropic-messages":
			return rebased(CUSTOM_ANTHROPIC_DIALECT, id, spec);
		// 这两条线没有协议层的通用配方:以名册里声明自己是这条线参考配方的那一份为底
		// (`Dialect.referenceFor`;今天是官方 openai / gemini 两家各自声明),这里不点名任何一家。
		case "openai-responses":
		case "gemini-generateContent":
			return rebased(referenceDialectOf(spec.wire), id, spec);
		case "openai-chat":
			break;
	}
	const usage = usageOf(spec.response?.usage);
	const decodeExtras = textExtrasOf(spec);
	const toolCalls = toolCallsCodecOf(spec.response);
	const finish = finishShapeOf(spec.response);
	const extraBody = staticExtraBody(spec);
	const dialect = openAIChatDialect({
		id,
		defaultBaseUrl: "https://api.openai.com/v1",
		...(spec.request?.maxTokensField ? { maxTokensField: spec.request.maxTokensField } : {}),
		reasoning: thinkingOf(spec),
		includeAssistantReasoning: true,
		...(decodeExtras ? { decodeExtras } : {}),
		...(usage ? { usage } : {}),
		...(toolCalls ? { toolCalls } : {}),
		...(finish ? { finish } : {}),
		...(extraBody ? { extraBody } : {}),
		// 与 `custom-openai` 同一份缺省;工厂按这一家的能力旋钮在构造处覆盖。
		transport: openAIChatTransportCapabilities({ tools: true, vision: true, reasoning: true }),
	});
	return spec.request?.streamUsage
		? { ...dialect, request: { ...dialect.request, streamUsage: spec.request.streamUsage } }
		: dialect;
}
