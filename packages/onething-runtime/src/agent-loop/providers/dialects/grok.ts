/**
 * `grok` —— xAI 的 API-key 通路,**openai-responses 线协议**(P4-4)。
 *
 * ## 为什么换线
 *
 * 官方把 chat-completions 标成 legacy:
 * 「Chat Completions is offered as a legacy endpoint. New features will come to
 *  the [Responses API] first.」(docs.x.ai
 *  `/developers/model-capabilities/legacy/chat-completions`)。
 * 加密思维链回放、`input_file`(PDF)、结构化引文 annotations 这三样在
 * chat-completions 上压根没有出口,而它们都是我们已经在 codex 那条线上跑着的
 * 东西 —— 换线之后 xAI 直接继承,零新代码。
 *
 * 顺带证明了另一件事:`OpenAIResponsesWire` 脱得开 codex 的订阅制后台怪癖,
 * 同一条管线服务一个纯 API-key 用户(设计稿 §9 P1 门 ①)。
 *
 * ## 配方逐项对照官方(docs.x.ai,2026-08-23 核)
 *
 * | 字段 | 值 | 官方出处 |
 * |---|---|---|
 * | endpoint | `https://api.x.ai/v1` + `/responses` | `POST /v1/responses` |
 * | auth | `Authorization: Bearer <XAI_API_KEY>` | `/developers/debugging` 401 行 |
 * | store | `false` | Request Body `store`(默认 true、留存 30 天;我们无状态) |
 * | reasoning | `reasoning: {effort}` 四档 | `/developers/model-capabilities/text/reasoning` |
 * | include | 恒发 `['reasoning.encrypted_content']` | 同页「Encrypted Reasoning Content」 |
 * | usage | 三桶 + `cost_in_usd_ticks / 1e10` | Response Body → usage |
 * | providerOptions | `imageDetail` / `searchParameters` | `input_image.detail` / Request Body `search_parameters` |
 * | 引文 | `output_text.annotations[].url_citation` | `/developers/tools/citations` |
 *
 * | 原生工具 | 带工具的回合挂 `{type:'web_search'}` | `/developers/tools/search-tools`(见 `grokNativeTools`) |
 *
 * **没接的,写明白**:
 *  - 其余服务端工具(`x_search` / `code_interpreter`)不挂。
 *  - `previous_response_id` / 服务端会话续接 —— 我们的历史是本地那份账本,
 *    `store:false` 与它互斥,不接。
 */
import type {
	AgentModelCapabilities,
	AgentTurnStreamEvent,
} from "@onething/core/agent-loop";
import type {
	RequestBodyBuilder,
	ToolChoicePolicy,
	TurnContext,
} from "../base/index.js";
import { GROK_RESPONSES_THINKING_WIRES } from "../thinking/grok-responses-reasoning.js";
import {
	CodexResponsesUsageNormalizer,
	OPENAI_RESPONSES_IMAGE_DETAIL_VALUES,
	toCodexToolChoice,
	type CodexResponsesUsage,
	type CodexTool,
} from "../wires/index.js";
import { promptCacheKeyExtraBody } from "./recipe.js";
import {
	defineResponsesDialect,
	type ResponsesDialectSpec,
} from "./responses-recipe.js";

/** 两条 xAI 通路共用的地址 —— `POST https://api.x.ai/v1/responses`。 */
export const GROK_BASE_URL = "https://api.x.ai/v1";

/**
 * 两条 xAI 通路共用的 provider-data 标签(**不是 providerId**)。
 *
 * 错误消息 / dump / 账本按 providerId 归档,但消息上的 provider-data 按家族:
 * 同一段历史在 `grok` 与 `grok-oauth` 之间切换时,加密思维链与引文的回放不断。
 * 与 P3-5a 的 `decodeGrokCitations` 逐字同规。
 */
export const GROK_PROVIDER_DATA_TAG = "grok";

/**
 * xAI 报价的单位是 1e-10 美元。官方 `POST /v1/responses` → Response Body →
 * usage → `cost_in_usd_ticks`:「Accurate cost of this request in USD ticks,
 * where "tick" is defined as follows: TICKS_IN_USD_CENT: i64 = 100_000_000
 * which means there is 10'000'000'000 ticks in one *dollar*.」
 */
const USD_TICKS_PER_DOLLAR = 1e10;

/**
 * 三桶与这条线的默认直译同形状,只多一个厂商报价。与 OpenRouter 同理:
 * `providerCostUSD` 不投影进 `AgentUsage` 的估算,账本另存一格
 * (设计稿 §10 决策 3 待拍板)。
 *
 * 三桶本身官方逐字对得上:`input_tokens` /
 * `input_tokens_details.cached_tokens` / `output_tokens` /
 * `output_tokens_details.reasoning_tokens` / `total_tokens`。
 * **没有 `cache_write_tokens`** —— xAI 不报写缓存(定价页只有 input /
 * cached input / output 三档),那一桶恒 0,投影里连键都不出现。
 */
export const GROK_RESPONSES_USAGE = new CodexResponsesUsageNormalizer(
	(usage: CodexResponsesUsage) =>
		usage.cost_in_usd_ticks === undefined
			? undefined
			: usage.cost_in_usd_ticks / USD_TICKS_PER_DOLLAR,
);

/**
 * 两条 xAI 通路共用的请求级袋支持面。
 *
 * `imageDetail`:`input_image` 收 `detail`(`auto|low|high`)。
 * `searchParameters`:Live Search,官方在 `POST /v1/responses` 的 Request Body
 * 上原样列着 `search_parameters` —— 与 chat-completions **同一个对象**,所以
 * P3-5a 那张嵌套白名单一个字都不用改(它已经搬进
 * `wires/xai-search-parameters.ts`)。
 */
export const GROK_PROVIDER_OPTIONS = {
	imageDetail: OPENAI_RESPONSES_IMAGE_DETAIL_VALUES,
	searchParameters: true,
} as const;

interface UrlCitationAnnotation {
	type?: unknown;
	url?: unknown;
}

/**
 * Responses 上的引文 → 一条 `provider-data`,形状与 P3-5a 的 chat 通路**逐字
 * 相同**(`{provider:'grok', type:'citations', citations:[url, …]}`)。
 *
 * 官方(`/developers/tools/citations`):每个 `output_text` 内容块带一个
 * `annotations` 数组,项是
 * `{type:'url_citation', url, start_index, end_index, title}`。
 * 「Inline citations are enabled by default for the Responses API」,所以不用
 * 请求侧开关;`include:['no_inline_citations']` 是**关**的开关,我们不发。
 *
 * 这里**只取 `url`**:位置索引(`start_index`/`end_index`)描述的是正文里
 * `[[N]](url)` 那段 markdown 的字符区间,而我们的正文是逐 delta 拼出来的,
 * 索引对不齐;而且 P3-5a 那一格的消费者(将来的渲染层)要的就是 URL 列表。
 * 不猜、不改形状 —— 要位置就等 UI 真需要时再单独设计一格。
 *
 * 非字符串 / 空串一律不要;一条都不剩就不产事件。
 */
export function decodeGrokResponsesCitations(
	item: Record<string, unknown>,
	turn: TurnContext,
): AgentTurnStreamEvent[] {
	if (item.type !== "message") return [];
	const content = item.content;
	if (!Array.isArray(content)) return [];

	const citations: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const annotations = (block as { annotations?: unknown }).annotations;
		if (!Array.isArray(annotations)) continue;
		for (const raw of annotations as UrlCitationAnnotation[]) {
			if (!raw || typeof raw !== "object") continue;
			if (raw.type !== "url_citation") continue;
			const url = raw.url;
			if (typeof url !== "string" || url.length === 0) continue;
			if (citations.includes(url)) continue;
			citations.push(url);
		}
	}
	if (citations.length === 0) return [];
	return [
		{
			type: "provider-data",
			turn: turn.turn,
			providerData: {
				provider: GROK_PROVIDER_DATA_TAG,
				type: "citations",
				citations,
			},
		},
	];
}

/**
 * 传输声明。`file-input`(PDF)是换线之后**新拿到**的能力:chat-completions
 * 上 xAI 收不下 PDF(那条线只有 `image_url`),Responses 的 `input_file` 收。
 * 没有 `image-output` —— xAI 的生图是另一套模型与端点(grok-imagine),不是
 * 这条线上的原生工具。
 */
export const GROK_TRANSPORT_CAPABILITIES: AgentModelCapabilities = {
	capabilities: [
		"text-input",
		"vision-input",
		"file-input",
		"text-output",
		"streaming",
		"tool-calls",
		"structured-tool-results",
		"reasoning",
	],
	inputModalities: ["text", "image", "file"],
	outputModalities: ["text"],
	toolResultModalities: ["text", "image"],
	supportsTools: true,
	supportsStructuredToolResults: true,
	supportsReasoning: true,
	supportsStreaming: true,
	// Responses API tool_choice: "required"
	supportsForcedToolUse: true,
};

/**
 * xAI 版 `tool_choice` 拼法 —— 与这条线的默认「恒发」分道:**有工具才发**。
 *
 * xAI 的 Open Responses 端点不容忍「请求里没有工具却带 `tool_choice`」,直接
 * 400 "A tool_choice was set on the request but no tools were specified"。
 * compact 摘要 / 标题生成这类无工具旁线请求(`generateChatResponse`)以前
 * 每次都撞它。OpenAI 官方端点对同一组合宽容,codex 照旧走 wire 默认策略
 * (`baseline.request.json` 钉着恒发)。
 *
 * 判空看 builder 里的实际工具表(`buildBody` 先写 `tools`,策略后跑)——
 * 原生工具也算数,与 `OpenAIToolChoicePolicy` 同一条判据;拼法沿用
 * `toCodexToolChoice`(指名工具是扁平的 `{type:'function', name}`)。
 */
class GrokResponsesToolChoicePolicy implements ToolChoicePolicy {
	apply(turn: TurnContext, builder: RequestBodyBuilder): void {
		const tools = builder.get<unknown[]>("tools");
		if (!Array.isArray(tools) || tools.length === 0) return;
		builder.set("tool_choice", toCodexToolChoice(turn.request.toolChoice));
	}
}

export const grokResponsesToolChoicePolicy: ToolChoicePolicy =
	new GrokResponsesToolChoicePolicy();

/**
 * xAI 服务端 `web_search` —— **带工具的回合**就挂上(用户 2026-09-18 拍板开)。
 *
 * 为什么要开:grok-4.6 不管请求里有没有这项,都会自己发起原生搜索
 * (`web_search_call`)。没挂的时候服务端不执行它,只发 `in_progress` /
 * `searching` 两个事件就把整个回复以 `completed` 收尾 —— 没有正文、没有函数
 * 调用,引擎当成正常结束,会话表现为「说一句接着查,然后就停了」
 * (09-18 实测:当天 33 个 grok 回合里 3 个这样收尾,3 个全带 `web_search_call`,
 * 其余 30 个一个都没有)。挂上之后搜索由 xAI 执行、结果在同一个回复里续上。
 *
 * 官方开关只有这一种:`tools` 里列 `{type:'web_search'}`;不列就是没开,
 * 没有「显式关掉」的参数(`/developers/tools/search-tools`)。
 *
 * **无工具的旁线请求不挂**(compact 摘要 / 标题生成):它们不该去上网计费,
 * 而且挂了原生工具,`tool_choice` 就会跟着发出去(判据是 builder 里的实际工具表)。
 * `toolChoice: 'none'` 同理不挂。
 *
 * 挂上之后,我们自己那个同名的 `web_search` 函数工具在这一路**让位**
 * (`toCodexTools` 按原生工具的 `type` 占名;xAI 对重名直接 400)。唯一例外:
 * 这一回合**指名**要我们的 `web_search` 函数 —— 那就不挂原生,指名得算数。
 */
export function grokNativeTools(turn: TurnContext): CodexTool[] {
	const { tools, toolChoice } = turn.request;
	if (!tools || tools.length === 0) return [];
	if (toolChoice === "none") return [];
	if (typeof toolChoice === "object" && toolChoice.function.name === "web_search") return [];
	return [{ type: "web_search" }];
}

/** 两条通路共用的配方主体 —— 只有 id 不同(见 `grok-oauth.ts` 的抬头)。 */
export const GROK_DIALECT_SPEC = {
	defaultBaseUrl: GROK_BASE_URL,
	reasoning: GROK_RESPONSES_THINKING_WIRES,
	store: false,
	// 一条 system 都没有时的兜底。Responses 的 `instructions` 必填,而
	// 我们的系统提示词永远在,所以这一句实际只在测试里出现。
	fallbackInstructions: "You are Grok, a helpful AI assistant built by xAI.",
	usage: GROK_RESPONSES_USAGE,
	providerDataTag: GROK_PROVIDER_DATA_TAG,
	errorLabel: "Grok",
	providerOptions: GROK_PROVIDER_OPTIONS,
	// `prompt_cache_key`:官方 `POST /v1/responses` 收它 ——
	// 「Plumbed to x-grok-conv-id for Open Responses compatibility, used for
	//  routing.」 与 chat 通路上逐字同一个字段名(P0b-B 泳道甲 #4)。
	extraBody: promptCacheKeyExtraBody,
	// 无工具不发 tool_choice(xAI 端点对「有 tool_choice 无 tools」直接 400)。
	toolChoice: grokResponsesToolChoicePolicy,
	nativeTools: grokNativeTools,
	decodeOutputItem: decodeGrokResponsesCitations,
	transport: GROK_TRANSPORT_CAPABILITIES,
} satisfies Omit<ResponsesDialectSpec, "id">;

const responsesDialectSpec: ResponsesDialectSpec = {
	id: "grok",
	...GROK_DIALECT_SPEC,
};
export const GROK_DIALECT = defineResponsesDialect(responsesDialectSpec);
