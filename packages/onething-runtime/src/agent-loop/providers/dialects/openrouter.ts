/**
 * `openrouter` —— 统一网关。对照 `factory.ts`:`defaultBaseUrl` /
 * `supportsVision:true` / `supportsReasoning:true` /
 * `reasoningStyle:'openrouter-reasoning'`;`maxTokensField` 用默认的
 * `max_tokens`,`includeAssistantReasoning` 没给。
 *
 * 上游的 `reasoning_details[]` 原样回传是 P3 的事。`cost` / `cache_write_tokens`
 * 从 P0b-A 起入三桶(见下)。PDF 从 P3-1 起走 `file` 块 + `file-parser` 插件
 * (见 `openRouterExtraBody`)。
 */
import type { Dialect, UsagePathTable } from "../base/index.js";
import { openRouterReasoningWire } from "../thinking/index.js";
import {
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
	const base = promptCacheKeyExtraBody(turn);
	if (!turn.notes.has(OPENAI_CHAT_PDF_DELIVERED_NOTE)) return base;
	const existing = turn.builder.get<unknown[]>("plugins");
	const plugins = Array.isArray(existing) ? [...existing] : [];
	if (!hasFileParser(plugins)) plugins.push(FILE_PARSER_PLUGIN);
	return { ...base, plugins };
};

export const OPENROUTER_DIALECT = defineOpenAIChatDialect({
	id: "openrouter",
	defaultBaseUrl: "https://openrouter.ai/api/v1",
	reasoning: openRouterReasoningWire,
	filePdf: "openai-file",
	usage: openAIChatUsage(OPENROUTER_USAGE_TABLE),
	extraBody: openRouterExtraBody,
	transport: openAIChatTransportCapabilities({ vision: true, reasoning: true }),
});
