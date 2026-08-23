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
 * **这条线上没有 `verbosity`** —— 那是 OpenAI chat-completions 自己的旋钮,
 * xAI 的 Responses 文档里没有这个字段,所以不进白名单(收到就当认不出的键
 * 丢弃 + 留痕,不猜)。
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

/** `input_image.detail` 的标准值域(auto / low / high)。 */
export const OPENAI_RESPONSES_IMAGE_DETAIL_VALUES = [
	"auto",
	"low",
	"high",
] as const;

/** 这一家认哪些请求级键 —— 一家一份,写在配方里(`ResponsesDialectSpec`)。 */
export interface OpenAIResponsesProviderOptionSupport {
	/**
	 * 收不收 `input_image.detail`。`true` = 收,值域用标准三值;给数组 = 收,
	 * 且值域是这一份;不给 / `false` = 不收(codex 就不收 —— 它的 codec 恒发
	 * `detail:'auto'`,那是 fixture 钉住的现状)。
	 */
	imageDetail?: boolean | readonly string[];
	/** 收不收 `searchParameters`(xAI Live Search)。只有 grok / grok-oauth 打开。 */
	searchParameters?: boolean;
}

/** 白名单过滤后剩下的东西。 */
export interface OpenAIResponsesProviderOptions {
	imageDetail?: string;
	searchParameters?: Record<string, unknown>;
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
): readonly string[] | undefined {
	const declared = support.imageDetail;
	if (declared === undefined || declared === false) return undefined;
	return declared === true ? OPENAI_RESPONSES_IMAGE_DETAIL_VALUES : declared;
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
	const details = imageDetailValues(support);

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
 * 请求体那一半:`search_parameters` 上顶层。`imageDetail` **不在这里** ——
 * 它是内容块上的字段,由 codec 写。
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
		return picked.searchParameters === undefined
			? {}
			: { search_parameters: picked.searchParameters };
	};
}
