/**
 * `openai` —— OpenAI 官方通路,**openai-responses 线协议**(P4-5)。
 *
 * ## 为什么换线
 *
 * 官方把 Responses 定成新的基元:`/docs/guides/migrate-to-responses` 抬头
 * 「The Responses API is our new API primitive, an evolution of Chat
 *  Completions.」;chat-completions 上拿不到、而我们已经在 codex / xAI 那条线
 * 上跑着的三样东西 —— **加密思维链回放**、**`input_file`(PDF 原生通道,带
 * `detail`)**、**原生 `image_generation` 工具** —— 换线之后 OpenAI 直接继承,
 * 零新代码。
 *
 * 这也让「一条 wire 三种后台」变成四种:ChatGPT 订阅后台(codex)、xAI 的
 * API-key 端点(grok / grok-oauth)、OpenAI 官方端点(openai)。
 *
 * ## 配方逐项对照官方(platform.openai.com,2026-08-23 核)
 *
 * | 字段 | 值 | 官方出处 |
 * |---|---|---|
 * | endpoint | `https://api.openai.com/v1` + `/responses` | `POST /v1/responses` |
 * | auth | `Authorization: Bearer <OPENAI_API_KEY>` | 各 guide 的 curl 例子 |
 * | store | `false` | `/docs/guides/reasoning`「Stateless mode applies when `store` is `false`」 |
 * | reasoning | `reasoning:{effort, summary:'auto'}` | `/docs/guides/reasoning`(取值表见 `openai-responses-reasoning.ts`) |
 * | include | 恒发 `['reasoning.encrypted_content']` | 同页:`store:false` 下**默认**就返回 `encrypted_content`,`include` 那条「still accepted… but doesn't require it」 |
 * | 原生工具 | `{type:'image_generation'}` | `/docs/guides/tools-image-generation`(Supported models 见下) |
 * | usage | 三桶 + `cache_write_tokens` | `/docs/guides/prompt-caching` 的 usage 例子逐字含 `input_tokens_details.{cached_tokens, cache_write_tokens}` |
 * | providerOptions | `verbosity` / `imageDetail` | `text.verbosity`(`/docs/guides/latest-model`)/ `input_image.detail`(`/docs/guides/images-vision`) |
 * | extraBody | `prompt_cache_key` | `/docs/guides/prompt-caching`「Set `prompt_cache_key` on requests that share long, common prompt prefixes.」 |
 * | 文件 | `input_file{filename, file_data}` | `/docs/guides/file-inputs`,PDF 要 vision 模型(`gpt-4o` 及以后) |
 *
 * ## 加密思维链走的是**同一条**回放路
 *
 * `providerDataTag: 'openai'` —— 消息上的 `{provider:'openai',
 * type:'encrypted-reasoning'}` 由 `ResponsesPartCodec` 摊成独立的
 * `{type:'reasoning', summary:[], encrypted_content}` input 项,与 codex / xAI
 * 逐字同规(那只 codec 的标签是**方言给的**,不是硬编码)。
 *
 * ## 生图:钩子挂上了,但今天不会响
 *
 * `nativeTools` 与 codex 逐字同规 —— `requestedOutputModalities` 含 `'image'`
 * 就往工具表里加一项。官方 `/docs/guides/tools-image-generation` 的
 * 「Supported models」列着 `gpt-5.5` / `gpt-5.4-mini` / `gpt-5.4-nano` /
 * `gpt-5.2` / `gpt-5` / `gpt-5-nano` / `o3` / `gpt-4.1` / `gpt-4.1-mini` /
 * `gpt-4.1-nano`,各模型页的「Supported tools」也逐个列着 `image_generation`。
 *
 * **两道闸 P4-9(拍板 #13)已经开了,方言一个字没改**:
 *  - 账本把「这个模型有原生出图工具」当独立事实(`OPENAI_IMAGE_TOOL_MODELS`,
 *    排在目录之前 —— 官方模型页的「Output modalities: text」说的是*模型*的
 *    输出模态,图是**工具**产出的),于是 `imageOutputServedBy: 'in-loop'`;
 *  - `backend/wiring/engine/stream/stream-executor.ts` 的
 *    `resolveRequestedOutputModalities` 对 codex 之外的家改问账本的
 *    `servedBy === 'in-loop'`,于是这一家的 `requestedOutputModalities` 真的会
 *    是 `['image']`。
 *
 * `gpt-image-*` 仍走专用生图流(`/v1/images/*`),那条通路不在回合里。
 */
import type { AgentModelCapabilities } from "@onething/core/agent-loop";
import type { TurnContext } from "../base/index.js";
import { OPENAI_RESPONSES_THINKING_WIRES } from "../thinking/index.js";
import { onethingOpenAIAcceptsOriginalImageDetail } from "../../../providers/model-capability.js";
import {
	OPENAI_RESPONSES_IMAGE_DETAIL_VALUES,
	OPENAI_RESPONSES_IMAGE_DETAIL_VALUES_WITH_ORIGINAL,
	type CodexTool,
} from "../wires/index.js";
import { promptCacheKeyExtraBody } from "./recipe.js";
import {
	defineResponsesDialect,
	type ResponsesDialectSpec,
} from "./responses-recipe.js";

/** 官方 REST 根地址 —— `POST https://api.openai.com/v1/responses`。 */
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * 消息上的 provider-data 标签(与 providerId 同值,但**语义不同**:一个说
 * 「这条历史是谁产的」,一个说「这次请求发给谁」)。写明白是为了与
 * `GROK_PROVIDER_DATA_TAG` 那条「家族 ≠ 通路」的判例对得上。
 */
export const OPENAI_PROVIDER_DATA_TAG = "openai";

/**
 * 请求级袋这一家认哪些键。
 *
 * `verbosity` → `text.verbosity`(**只有这一家开**;chat 通路上它拼在顶层,
 * 见 `openai-chat-provider-options.ts`)。
 * `imageDetail` → 每个 `input_image.detail`。Responses 上 `detail` 是内容块
 * 上的常规字段,codec 不给袋时恒发 `'auto'` —— 官方
 * `/docs/guides/images-vision`:「`auto`:Automatic detail selection.」
 */
/**
 * `input_image.detail` 的值域**按模型算**(拍板 #14):`original` 官方只在
 * `gpt-5.4` 及以后可用(`/docs/guides/images-vision`:「Available on `gpt-5.4`
 * and future models」)。判据在账本(`onethingOpenAIAcceptsOriginalImageDetail`)
 * —— 方言不认模型名,只问账本;别家(codex / grok)一个字不变。
 */
function openAIImageDetailValues(turn: TurnContext): readonly string[] {
	return onethingOpenAIAcceptsOriginalImageDetail(turn.model)
		? OPENAI_RESPONSES_IMAGE_DETAIL_VALUES_WITH_ORIGINAL
		: OPENAI_RESPONSES_IMAGE_DETAIL_VALUES;
}

export const OPENAI_PROVIDER_OPTIONS = {
	verbosity: true,
	imageDetail: openAIImageDetailValues,
} as const;

/**
 * 传输声明。与 codex 同形(同一条线协议、同一只 codec),差别只在这是**线路**
 * 能力不是模型能力:`image-output` 说的是「这条线收得下 `image_generation`
 * 工具、也解析得了它吐回来的图」,具体某个模型到底出不出图由账本裁定
 * (`ModelProfile.toAgentModelCapabilities`:账本对 `imageOutput` 一旦有话说
 * 就以它为准,把这一位摘掉)。`file-input` 同理 —— 目录 ∧ 线路(P4-1 拍板 #12)。
 */
export const OPENAI_TRANSPORT_CAPABILITIES: AgentModelCapabilities = {
	capabilities: [
		"text-input",
		"vision-input",
		"file-input",
		"text-output",
		"image-output",
		"streaming",
		"tool-calls",
		"structured-tool-results",
		"reasoning",
	],
	inputModalities: ["text", "image", "file"],
	outputModalities: ["text", "image"],
	toolResultModalities: ["text", "image"],
	supportsTools: true,
	supportsStructuredToolResults: true,
	supportsReasoning: true,
	supportsStreaming: true,
	// Responses API tool_choice: "required"
	supportsForcedToolUse: true,
};

/**
 * 生图不是一个开关,而是**工具表里多一项**。与 `CODEX_DIALECT_SPEC` 的那支
 * 逐字同规(含 `output_format:'png'` —— 官方
 * `/docs/guides/tools-image-generation`:「Use `png` (the default) or `webp`」,
 * 显式写出默认值,免得哪天默认变了两条线一起漂)。
 */
function openAINativeTools(turn: TurnContext): CodexTool[] {
	return turn.request.requestedOutputModalities?.includes("image")
		? [{ type: "image_generation", output_format: "png" }]
		: [];
}

export const OPENAI_DIALECT_SPEC = {
	defaultBaseUrl: OPENAI_BASE_URL,
	reasoning: OPENAI_RESPONSES_THINKING_WIRES,
	// 无状态:我们的历史是本地那份账本,服务端 30 天留存对我们只有坏处。
	// 顺带换来加密思维链默认回传(见 `openai-responses-reasoning.ts` 的官方引文)。
	store: false,
	// 一条 system 都没有时的兜底。Responses 的 `instructions` 必填,而我们的
	// 系统提示词永远在,所以这一句实际只在测试里出现。
	fallbackInstructions: "You are a helpful AI assistant.",
	nativeTools: openAINativeTools,
	providerDataTag: OPENAI_PROVIDER_DATA_TAG,
	errorLabel: "OpenAI",
	providerOptions: OPENAI_PROVIDER_OPTIONS,
	extraBody: promptCacheKeyExtraBody,
	transport: OPENAI_TRANSPORT_CAPABILITIES,
} satisfies Omit<ResponsesDialectSpec, "id">;

export const OPENAI_DIALECT = defineResponsesDialect({
	id: "openai",
	...OPENAI_DIALECT_SPEC,
});
