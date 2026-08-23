/**
 * `openrouter` —— 统一网关。对照 `factory.ts`:`defaultBaseUrl` /
 * `supportsVision:true` / `supportsReasoning:true` /
 * `reasoningStyle:'openrouter-reasoning'`;`maxTokensField` 用默认的
 * `max_tokens`,`includeAssistantReasoning` 没给。
 *
 * 上游的 `reasoning_details[]` 从 P3-4 起原样回传:解码在
 * `thinking/openrouter-reasoning.ts`(同一条线型的编码/解码/回传一个对象),
 * 回传在 codec 的 `replayReasoningDetails`。`cost` / `cache_write_tokens`
 * 从 P0b-A 起入三桶(见下)。PDF 从 P3-1 起走 `file` 块 + `file-parser` 插件
 * (见 `openRouterExtraBody`)。
 */
import type { AgentTurnStreamEvent } from "@onething/core/agent-loop";
import type { Dialect, TurnContext, UsagePathTable } from "../base/index.js";
import {
	decodeOpenRouterReasoningDetails,
	openRouterReasoningWire,
} from "../thinking/index.js";
import {
	OPENAI_CHAT_IMAGE_DETAIL_VALUES,
	OPENAI_CHAT_PDF_DELIVERED_NOTE,
	openAIChatUsage,
	openAIChatUsageTable,
} from "../wires/index.js";
import {
	defineOpenAIChatDialect,
	openAIChatTransportCapabilities,
	promptCacheKeyExtraBody,
} from "./recipe.js";

/**
 * OpenRouter 的 usage 恒返回,`cache_write_tokens` 与 `cached_tokens` 都在
 * `prompt_tokens_details` 里且都 ⊂ prompt(默认表已经这样减),额外多一个
 * 顶层 `cost`(美元)。
 *
 * `cost` 只进 `UsageBuckets.providerCostUSD`,**不投影进 `AgentUsage`** ——
 * 「厂商报价与本地价目并存」是设计稿 §10 决策 3,待拍板;在那之前它是三桶上
 * 的一个字段,账本一个字不动。
 */
export const OPENROUTER_USAGE_TABLE: UsagePathTable = openAIChatUsageTable({
	providerCostUSD: "cost",
});

/**
 * `file-parser` 插件 —— OpenRouter 侧的 PDF 解析器。
 *
 * `engine: 'native'` = 交给支持原生 PDF 的上游模型自己读(不额外计费)。
 * **不支持原生 PDF 的上游会直接报错,本期不做 fallback**:静默换引擎等于
 * 替用户拍板计费。后续选项是 `mistral-ocr`(按页计费)与 `cloudflare-ai`,
 * 两者都要先拍板再挂。
 */
const FILE_PARSER_PLUGIN = {
	id: "file-parser",
	pdf: { engine: "native" },
} as const;

function hasFileParser(plugins: readonly unknown[]): boolean {
	return plugins.some(
		(entry) =>
			typeof entry === "object" &&
			entry !== null &&
			(entry as { id?: unknown }).id === FILE_PARSER_PLUGIN.id,
	);
}

/**
 * `prompt_cache_key` + 「本回合投过 PDF 才挂 `plugins`」。
 *
 * 标记由 codec 在 `user()` 里记在 `turn.notes` 上(`OPENAI_CHAT_PDF_DELIVERED_NOTE`),
 * 请求体仍然只在 builder / `extraBody` 这一侧长出来 —— codec 不写请求体。
 * 已经有 `plugins` 就合并(同 id 不重复挂),不覆盖别人写的那些。
 */
export const openRouterExtraBody: NonNullable<Dialect["extraBody"]> = (turn) => {
	const base = { ...promptCacheKeyExtraBody(turn), ...imageModalitiesExtraBody(turn) };
	if (!turn.notes.has(OPENAI_CHAT_PDF_DELIVERED_NOTE)) return base;
	const existing = turn.builder.get<unknown[]>("plugins");
	const plugins = Array.isArray(existing) ? [...existing] : [];
	if (!hasFileParser(plugins)) plugins.push(FILE_PARSER_PLUGIN);
	return { ...base, plugins };
};

// ---------------------------------------------------------------------------
// 图像输出(P3-2)—— 请求侧 `modalities`,响应侧 `images[]`
// ---------------------------------------------------------------------------

/**
 * 一张图在流上的项形状。
 *
 * ⚠️ **流式的 `delta.images` 在 OpenRouter 的 OpenAPI 里没有声明**;这里按
 * **非流式** `choices[].message.images[]` 的项形状假定(`{type:'image_url',
 * image_url:{url}}`,`url` 是 data URL)。两种落点都认(`delta.images` 与
 * `message.images`),因为上游把非流式形状折进流里的做法也见过。**待真机核**。
 */
interface OpenRouterImageItem {
	image_url?: { url?: unknown };
}

/** 回合级计数器的标记前缀 —— callId 要稳定,而 provider 实例无状态。 */
const OPENROUTER_IMAGE_NOTE_PREFIX = "openrouter-image-";

function nextImageIndex(turn: TurnContext): number {
	let index = 0;
	while (turn.notes.has(`${OPENROUTER_IMAGE_NOTE_PREFIX}${index}`)) index += 1;
	turn.notes.add(`${OPENROUTER_IMAGE_NOTE_PREFIX}${index}`);
	return index;
}

const DATA_URL_PATTERN = /^data:([^;,]+)?(?:;[^,]*)*;base64,(.*)$/s;

/**
 * data URL 剥成 base64 + mediaType;http(s) URL 原样留在 `url` 字段。
 * 认不出的字符串 = 不产事件(不猜)。
 */
function imagePayload(
	url: string,
): { result: string; mediaType: string } | { url: string } | undefined {
	const dataUrl = DATA_URL_PATTERN.exec(url);
	if (dataUrl) {
		const result = dataUrl[2] ?? "";
		return result ? { result, mediaType: dataUrl[1] || "image/png" } : undefined;
	}
	if (url.startsWith("http://") || url.startsWith("https://")) return { url };
	return undefined;
}

function imageItems(value: unknown): OpenRouterImageItem[] {
	return Array.isArray(value) ? (value as OpenRouterImageItem[]) : [];
}

/**
 * OpenRouter 的图像输出 → `provider-data` 事件,形状与 codex 的那条对齐
 * (`type: 'image-generation-result'`),于是消息落点按 **type** 判就够了
 * (`provider-data.ts`),不必再认第二个 provider 名。
 */
export function decodeOpenRouterImageOutput(
	chunk: unknown,
	turn: TurnContext,
): AgentTurnStreamEvent[] {
	if (!chunk || typeof chunk !== "object") return [];
	const choice = (chunk as { choices?: unknown[] }).choices?.[0] as
		| { delta?: { images?: unknown }; message?: { images?: unknown } }
		| undefined;
	if (!choice) return [];

	const items = [
		...imageItems(choice.delta?.images),
		...imageItems(choice.message?.images),
	];
	const events: AgentTurnStreamEvent[] = [];
	for (const item of items) {
		const url = item?.image_url?.url;
		if (typeof url !== "string" || !url) continue;
		const payload = imagePayload(url);
		if (!payload) continue;
		events.push({
			type: "provider-data",
			turn: turn.turn,
			providerData: {
				provider: "openrouter",
				type: "image-generation-result",
				callId: `${turn.turn}-img-${nextImageIndex(turn)}`,
				status: "completed",
				...payload,
			},
		});
	}
	return events;
}

/**
 * `modalities: ['text','image']` —— OpenRouter 只在请求声明了 image 输出模态时
 * 才回图。判据是账本:`servedBy === 'in-loop'` = 「这个模型在回合内出图」
 * (openrouter 家 + imageOutput 为真),纯文本模型一个字节都不多发。
 */
function imageModalitiesExtraBody(turn: TurnContext): Record<string, unknown> {
	return turn.profile.imageOutput.servedBy === "in-loop"
		? { modalities: ["text", "image"] }
		: {};
}

/**
 * 这条线上 OpenRouter 多解出来的两种块(P3-4 + P3-2)。
 *
 * 顺序:**思维链在正文与图之前** —— 上游把 `reasoning_details` 与
 * `content` 放在同一块里时,思考先于产出,与 `reasoning-delta` 在
 * `parseStream` 里先于 `text-delta` 是同一条口径。
 */
export function decodeOpenRouterExtras(
	chunk: unknown,
	turn: TurnContext,
): AgentTurnStreamEvent[] {
	return [
		...decodeOpenRouterReasoningDetails(chunk, turn),
		...decodeOpenRouterImageOutput(chunk, turn),
	];
}

export const OPENROUTER_DIALECT = defineOpenAIChatDialect({
	id: "openrouter",
	defaultBaseUrl: "https://openrouter.ai/api/v1",
	reasoning: openRouterReasoningWire,
	filePdf: "openai-file",
	usage: openAIChatUsage(OPENROUTER_USAGE_TABLE),
	decodeExtras: decodeOpenRouterExtras,
	// OpenRouter 官方:多轮/工具调用必须原样回传整段连续的 `reasoning_details`。
	replayReasoningDetails: true,
	extraBody: openRouterExtraBody,
	// 网关按 OpenAI 的形状转发内容块,`image_url.detail` 原样过去(P3-3)。
	providerOptions: { imageDetail: OPENAI_CHAT_IMAGE_DETAIL_VALUES },
	// tool 结果里的图(P3-5b)。OpenRouter 文档明说 `role:'tool'` 的 `content`
	// 可以是内容块数组并在其中收 `image_url`;OpenAI 官方只允许字符串,所以这
	// 条线上**只有它**开。能力声明与序列化同时翻:`toolResultModalities` 里
	// 有 `image`,codec 才真的把图放进请求体(投递契约,设计稿 §2.3)。
	// `file` 不在声明里 —— 那一行在 tool 消息里没有对应的块。
	toolResultMultimodal: true,
	// `file: true` 与上面的 `filePdf` 是同一句话的两半(P4-1):网关认 OpenAI 的
	// `file` 块(另挂 `file-parser` 插件),codec 真投得出去,能力才声明 `file-input`。
	transport: openAIChatTransportCapabilities({
		vision: true,
		file: true,
		reasoning: true,
		toolResultModalities: ["text", "image"],
	}),
});
