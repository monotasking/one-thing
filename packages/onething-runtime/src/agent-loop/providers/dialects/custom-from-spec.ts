/**
 * `CustomAdapterSpec` → `Dialect` —— **只做编译**(批 4 §7.2,
 * `docs/design/provider-settings-rework-2026-09.md`)。
 *
 * openai-chat 线今天已经是「读策略」的:usage 走路径表、思考增量走 `ThinkingWire.decode`、
 * 额外块走 `PartCodec.decodeExtras`。所以一张适配表只需要被编译成这三个策略对象加一份
 * 配方 `request` 表,线的源码一行不改:
 *
 *  - `response.usage`             → `PathUsageNormalizer`(默认表 `openAIChatUsageTable` + 偏差);
 *  - `response.reasoningDeltaPath` + `request.reasoning`
 *                                 → 一个 `ThinkingWire`(`encode` = 与 per-model 覆盖同一份
 *                                   声明式映射 `encodeCustomReasoning`;`decode` = 读路径,读不到
 *                                   退回线级的 `reasoning_content ?? reasoning`);
 *  - `response.textDeltaPath`(非默认)→ `decodeExtras` 按路径补 `text-delta`;
 *  - `request.maxTokensField` / `streamUsage` / `extraBody` → 配方的 `request` 表与 `extraBody`。
 *
 * **落不进现有策略格的**(线读死了的那几处),`unsupportedAdapterSpecFields` 如实列出,
 * 编译照常 —— 它们在运行期不生效,调用方负责说出来:
 *  - `toolCallsPath` 非默认(线直接读 `delta.tool_calls` 做 index 累积);
 *  - `finishReasonPath` 非默认 / `finishReasonMap`(收尾映射是线的 `finish` getter,不是方言格);
 *  - `doneMarker` 既不是 `'[DONE]'` 也不是 `null`(SSE 读取器只认 `[DONE]`,别的串会被当 JSON 解)。
 *
 * 另外三条线(responses / anthropic / gemini)批 4 只接受 `wire` 与 `request` 两格:
 * 编译结果是那条线的通用配方换一个 id(§11 留账:那三条线的偏差没见过真实案例)。
 */
import type { AgentTurnStreamEvent } from "@onething/core/agent-loop";
import {
	CUSTOM_ADAPTER_DEFAULT_PATHS,
	type CustomAdapterSpec,
} from "@shared/contracts/adapter-spec";
import {
	getPath,
	type Dialect,
	type ThinkingWire,
	type TurnContext,
	type UsageField,
	type UsageNormalizer,
	type UsagePathTable,
} from "../base/index.js";
import { encodeCustomReasoning } from "../thinking/custom-reasoning.js";
import { openAIEffortWire } from "../thinking/index.js";
import { openAIChatUsage } from "../wires/index.js";
import { CUSTOM_ANTHROPIC_DIALECT } from "./custom-anthropic.js";
import { GEMINI_DIALECT } from "./gemini.js";
import { OPENAI_DIALECT } from "./openai.js";
import { openAIChatDialect, openAIChatTransportCapabilities } from "./recipe.js";
import { customAdapterDialectId } from "../../../providers/manifest.js";

/** 适配表编译出来的方言 id —— 约定住在 manifest(那一侧也要认它),这里转一手。 */
export { customAdapterDialectId, isCustomAdapterDialectOf } from "../../../providers/manifest.js";

/** 这条线编译时以哪份配方为底(也是「应用」时写进表单的「接口类型」)。 */
export const CUSTOM_ADAPTER_BASE_DIALECT: Record<CustomAdapterSpec["wire"], string> = {
	"openai-chat": "custom-openai",
	"openai-responses": "openai",
	"anthropic-messages": "custom-anthropic",
	"gemini-generateContent": "gemini",
};

function nonDefault(value: string | undefined, fallback: string): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed !== fallback ? trimmed : undefined;
}

/** 编译照常、但运行期不生效的格(见文件头)。空数组 = 整张表都落进了策略格。 */
export function unsupportedAdapterSpecFields(spec: CustomAdapterSpec): string[] {
	const out: string[] = [];
	const response = spec.response;
	if (!response) return out;
	if (spec.wire !== "openai-chat") return ["response"];
	if (nonDefault(response.toolCallsPath, CUSTOM_ADAPTER_DEFAULT_PATHS.toolCallsPath)) out.push("response.toolCallsPath");
	if (nonDefault(response.finishReasonPath, CUSTOM_ADAPTER_DEFAULT_PATHS.finishReasonPath)) out.push("response.finishReasonPath");
	if (response.finishReasonMap && Object.keys(response.finishReasonMap).length > 0) out.push("response.finishReasonMap");
	if (response.doneMarker !== undefined && response.doneMarker !== null && response.doneMarker !== CUSTOM_ADAPTER_DEFAULT_PATHS.doneMarker) {
		out.push("response.doneMarker");
	}
	return out;
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

function staticExtraBody(spec: CustomAdapterSpec): Dialect["extraBody"] | undefined {
	const extra = spec.request?.extraBody;
	if (!extra || Object.keys(extra).length === 0) return undefined;
	return () => structuredClone(extra) as Record<string, unknown>;
}

/** 另外三条线:通用配方换 id,`request` 那两格与 `extraBody` 叠上去。 */
function rebased(base: Dialect, id: string, spec: CustomAdapterSpec): Dialect {
	const { label: _label, ...rest } = base;
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

export function dialectFromSpec(providerId: string, spec: CustomAdapterSpec): Dialect {
	const id = customAdapterDialectId(providerId);
	switch (spec.wire) {
		case "anthropic-messages":
			return rebased(CUSTOM_ANTHROPIC_DIALECT, id, spec);
		case "openai-responses":
			return rebased(OPENAI_DIALECT, id, spec);
		case "gemini-generateContent":
			return rebased(GEMINI_DIALECT, id, spec);
		case "openai-chat":
			break;
	}
	const usage = usageOf(spec.response?.usage);
	const decodeExtras = textExtrasOf(spec);
	const extraBody = staticExtraBody(spec);
	const dialect = openAIChatDialect({
		id,
		defaultBaseUrl: "https://api.openai.com/v1",
		...(spec.request?.maxTokensField ? { maxTokensField: spec.request.maxTokensField } : {}),
		reasoning: thinkingOf(spec),
		includeAssistantReasoning: true,
		...(decodeExtras ? { decodeExtras } : {}),
		...(usage ? { usage } : {}),
		...(extraBody ? { extraBody } : {}),
		// 与 `custom-openai` 同一份缺省;工厂按这一家的能力旋钮在构造处覆盖。
		transport: openAIChatTransportCapabilities({ tools: true, vision: true, reasoning: true }),
	});
	return spec.request?.streamUsage
		? { ...dialect, request: { ...dialect.request, streamUsage: spec.request.streamUsage } }
		: dialect;
}
