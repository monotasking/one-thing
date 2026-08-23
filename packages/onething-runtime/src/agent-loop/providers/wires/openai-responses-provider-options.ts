/**
 * openai-responses 线上的**请求级 providerOptions 袋**(P4-4,设计稿 §2.8)。
 *
 * 与 `openai-chat-provider-options.ts` 同一条规矩、同一个双向命名空间袋
 * (`AgentTurnRequest.providerOptions[providerId]`,provider 只读自己那一格),
 * 白名单是**这一条线协议**的:
 *
 *  - `imageDetail`(`auto|low|high`)—— 官方 `/v1/responses` 的 `input_image`
 *    内容块收 `detail`(docs.x.ai `/developers/model-capabilities/images/
 *    understanding` 的 Responses 例子里就是
 *    `{"type":"input_image","image_url":…,"detail":"high"}`);三个值的语义在
 *    `/developers/model-capabilities/legacy/chat-completions` 的
 *    「Image detail levels」一节:`auto`(默认)/ `low` / `high`。由 codec 写进
 *    **每一个** `input_image.detail`。
 *  - `searchParameters` —— xAI Live Search,官方在 `POST /v1/responses` 的
 *    Request Body 上原样列着 `search_parameters`(见
 *    `xai-search-parameters.ts` 的抬头),通过嵌套白名单的键原样写成顶层
 *    `search_parameters`。
 *
 *  - `verbosity`(`low|medium|high`,**P4-5 新增**)—— OpenAI 官方的输出长度
 *    旋钮。这条线上它**不是顶层字段**,而是 `text.verbosity`:官方
 *    `/docs/guides/latest-model` →「Set a default with `text.verbosity`」:
 *    「Choose `low`, `medium`, or `high` as the default level of detail for a
 *     request.」chat-completions 上同一个旋钮拼在顶层 `verbosity`
 *    (见 `openai-chat-provider-options.ts`)—— 同一个用户设置,两条线两种拼法,
 *    白名单各写各的。
 *
 *    **只有 openai 一家开**:xAI 的 Responses 文档里没有这个字段,grok /
 *    grok-oauth 的支持面不含它(收到就当认不出的键丢弃 + 留痕,不猜)。
 *
 * ## 为什么留痕只在一处
 *
 * 与 openai-chat 那份同理:取值是**纯函数**
 * (`pickOpenAIResponsesProviderOptions`),codec 在 `buildBody` 里要
 * `imageDetail`、`extraBody` 在之后要 `searchParameters`,两处都能调;但
 * `onDropped` 只有 `extraBody` 那一次传 —— 它拿着这一家**完整**的支持面,
 * 所以只有它的裁定是完整的。同一个被丢的键不会出现两条 warning。
 */
import type { TurnContext } from "../base/index.js";
import { pickGrokSearchParameters } from "./xai-search-parameters.js";

/**
 * `input_image.detail` 的标准值域(auto / low / high)。xAI 的两条通路用这一份
 * (docs.x.ai 的「Image detail levels」只列这三个)。
 */
export const OPENAI_RESPONSES_IMAGE_DETAIL_VALUES = [
	"auto",
	"low",
	"high",
] as const;

/**
 * OpenAI 官方端点在 **gpt-5.4 及以后**多一个 `original`(拍板 #14)。官方
 * `/docs/guides/images-vision`:「Available on `gpt-5.4` and future models」,
 * 且「On `gpt-5.5` and GPT-5.6 models, `auto` and the omitted/default behavior
 * are equivalent to `original`」。
 *
 * 值域因此是**按模型**开的 —— 这一家的支持面给的是一支函数(见
 * `OpenAIResponsesProviderOptionSupport.imageDetail`),模型判据在账本
 * (`onethingOpenAIAcceptsOriginalImageDetail`),wire 自己不认模型名。
 */
export const OPENAI_RESPONSES_IMAGE_DETAIL_VALUES_WITH_ORIGINAL = [
	...OPENAI_RESPONSES_IMAGE_DETAIL_VALUES,
	"original",
] as const;

/**
 * `text.verbosity` 的值域。与 chat 通路上的
 * `OPENAI_CHAT_VERBOSITY_VALUES` 同值(官方:`low` / `medium` / `high`)。
 */
export const OPENAI_RESPONSES_VERBOSITY_VALUES = [
	"low",
	"medium",
	"high",
] as const;

export type OpenAIResponsesVerbosity =
	(typeof OPENAI_RESPONSES_VERBOSITY_VALUES)[number];

/** `text.verbosity` 在请求体里的点分路径(`RequestBodyBuilder` 认它)。 */
export const OPENAI_RESPONSES_VERBOSITY_PATH = "text.verbosity";

/** 这一家认哪些请求级键 —— 一家一份,写在配方里(`ResponsesDialectSpec`)。 */
export interface OpenAIResponsesProviderOptionSupport {
	/**
	 * 收不收 `input_image.detail`。`true` = 收,值域用标准三值;给数组 = 收,
	 * 且值域是这一份;**给函数 = 收,值域按这一回合的模型算**(openai 的
	 * `original` 只有 gpt-5.4+ 有);不给 / `false` = 不收(codex 就不收 ——
	 * 它的 codec 恒发 `detail:'auto'`,那是 fixture 钉住的现状)。
	 */
	imageDetail?:
		| boolean
		| readonly string[]
		| ((turn: TurnContext) => readonly string[]);
	/** 收不收 `searchParameters`(xAI Live Search)。只有 grok / grok-oauth 打开。 */
	searchParameters?: boolean;
	/** 收不收 `text.verbosity`(OpenAI 的输出长度旋钮)。只有 openai 打开。 */
	verbosity?: boolean;
}

/** 白名单过滤后剩下的东西。 */
export interface OpenAIResponsesProviderOptions {
	imageDetail?: string;
	searchParameters?: Record<string, unknown>;
	verbosity?: OpenAIResponsesVerbosity;
}

export type OpenAIResponsesProviderOptionDropReason =
	| "unknown-key"
	| "illegal-value";

export type OpenAIResponsesProviderOptionDropped = (
	key: string,
	value: unknown,
	reason: OpenAIResponsesProviderOptionDropReason,
) => void;

function imageDetailValues(
	support: OpenAIResponsesProviderOptionSupport,
	turn: TurnContext,
): readonly string[] | undefined {
	const declared = support.imageDetail;
	if (declared === undefined || declared === false) return undefined;
	if (declared === true) return OPENAI_RESPONSES_IMAGE_DETAIL_VALUES;
	return typeof declared === "function" ? declared(turn) : declared;
}

/** 这一格袋 —— 只取自己 providerId 的那一格,别家的一个字都不看。 */
export function readOpenAIResponsesProviderOptionBag(
	turn: TurnContext,
): Record<string, unknown> {
	return turn.request.providerOptions?.[turn.profile.providerId] ?? {};
}

/** 袋 → 白名单值。**纯函数**:传了 `onDropped` 才留痕(见文件头)。 */
export function pickOpenAIResponsesProviderOptions(
	turn: TurnContext,
	support: OpenAIResponsesProviderOptionSupport,
	onDropped?: OpenAIResponsesProviderOptionDropped,
): OpenAIResponsesProviderOptions {
	const bag = readOpenAIResponsesProviderOptionBag(turn);
	const picked: OpenAIResponsesProviderOptions = {};
	const details = imageDetailValues(support, turn);

	for (const [key, value] of Object.entries(bag)) {
		if (value === undefined) continue;
		if (key === "imageDetail" && details) {
			if (typeof value === "string" && details.includes(value)) {
				picked.imageDetail = value;
				continue;
			}
			onDropped?.(key, value, "illegal-value");
			continue;
		}
		if (key === "searchParameters" && support.searchParameters) {
			const search = pickGrokSearchParameters(value, onDropped);
			if (search) picked.searchParameters = search;
			continue;
		}
		if (key === "verbosity" && support.verbosity) {
			if (
				typeof value === "string" &&
				(OPENAI_RESPONSES_VERBOSITY_VALUES as readonly string[]).includes(value)
			) {
				picked.verbosity = value as OpenAIResponsesVerbosity;
				continue;
			}
			onDropped?.(key, value, "illegal-value");
			continue;
		}
		onDropped?.(key, value, "unknown-key");
	}

	return picked;
}

/** `input_image.detail` 的值 —— codec 调这一支(不留痕,见文件头)。 */
export function openAIResponsesImageDetail(
	turn: TurnContext | undefined,
	support: OpenAIResponsesProviderOptionSupport,
): string | undefined {
	if (!turn) return undefined;
	return pickOpenAIResponsesProviderOptions(turn, support).imageDetail;
}

/**
 * 请求体那一半:`search_parameters` 上顶层、`verbosity` 进 `text.verbosity`
 * (点分路径由 `RequestBodyBuilder.set` 按需补出中间对象)。`imageDetail`
 * **不在这里** —— 它是内容块上的字段,由 codec 写。
 *
 * 这一支是每家配方都会挂上的:哪怕这家一个键都不认,认不出的键也要留痕,
 * 不能因为「这家没有旋钮」就静默吞掉用户写进 settings.json 的东西。
 */
export function openAIResponsesProviderOptionsExtraBody(
	support: OpenAIResponsesProviderOptionSupport,
): (turn: TurnContext) => Record<string, unknown> {
	return (turn) => {
		const picked = pickOpenAIResponsesProviderOptions(
			turn,
			support,
			(key, value, reason) => {
				turn.warn(
					"setting-dropped",
					reason === "unknown-key"
						? `providerOptions.${key} is not a recognized request option on this endpoint`
						: `providerOptions.${key} carries a value this endpoint does not accept`,
					{ key, value, reason },
				);
			},
		);
		return {
			...(picked.searchParameters === undefined
				? {}
				: { search_parameters: picked.searchParameters }),
			...(picked.verbosity === undefined
				? {}
				: { [OPENAI_RESPONSES_VERBOSITY_PATH]: picked.verbosity }),
		};
	};
}
