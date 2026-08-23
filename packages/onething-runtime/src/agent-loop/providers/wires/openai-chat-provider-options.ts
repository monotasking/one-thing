/**
 * openai-chat 线上的**请求级 providerOptions 袋**(P3-3,设计稿 §2.8)。
 *
 * 袋是双向命名空间的:`AgentTurnRequest.providerOptions[providerId]` 里装的是
 * 宿主 / 设置注入的实验性或家专属请求参数,**provider 只读自己那一格**。这里是
 * openai-chat 这一条线的白名单 —— 认得的键翻成请求体上的字段,认不得的键
 * **丢弃并留痕**(`setting-dropped`),没有第三种。
 *
 * 白名单今天有三条:
 *  - `verbosity`(`low|medium|high`)—— OpenAI 的输出长度旋钮,顶层字段;
 *  - `imageDetail`(值域按家:openai/grok/openrouter 是 `auto|low|high`,
 *    deepseek 多一个 `original`)—— 由 codec 写进**每一个** `image_url.detail`;
 *  - `searchParameters`(P3-5a,只有 xAI 的 grok / grok-oauth 认)—— 一个**对象**,
 *    它自己的键再过一层白名单,通过的原样写成顶层 `search_parameters`。
 *
 * 嵌套那一层是**逐键**裁的:一个认不出的子键只丢它自己,合法的兄弟照发
 * (留痕的 `key` 写全路径 `searchParameters.<子键>`);整个值不是对象才整条丢。
 *
 * ## 为什么留痕只在一处
 *
 * 袋要被读两次:codec 在 `buildBody` 里要 `imageDetail`,`extraBody` 在之后要
 * `verbosity`。取值是**纯函数**(`pickOpenAIChatProviderOptions`),两处都能调;
 * 但 `onDropped` 只有 `extraBody` 那一次传 —— 它拿着这一家**完整**的支持面
 * (codec 只知道 detail 那半边),所以只有它的裁定是完整的。codec 那次不留痕,
 * 于是同一个被丢的键不会出现两条 warning。
 */
import type { TurnContext } from "../base/index.js";

/** OpenAI 的输出长度旋钮。 */
export const OPENAI_CHAT_VERBOSITY_VALUES = ["low", "medium", "high"] as const;

export type OpenAIChatVerbosity = (typeof OPENAI_CHAT_VERBOSITY_VALUES)[number];

/** `image_url.detail` 的标准值域(openai / grok / grok-oauth / openrouter)。 */
export const OPENAI_CHAT_IMAGE_DETAIL_VALUES = ["auto", "low", "high"] as const;

/**
 * DeepSeek 的 vision-exp 端点多一个 `original`(原图不缩放),其余三值同标准。
 * 值域是**这一家的事实**,不是白名单的宽窄 —— 所以按家给表,不取并集。
 */
export const DEEPSEEK_IMAGE_DETAIL_VALUES = [
	"auto",
	"low",
	"high",
	"original",
] as const;

/** xAI Live Search 的检索模式(`search_parameters.mode`)。 */
export const GROK_SEARCH_MODE_VALUES = ["off", "on", "auto"] as const;

export type GrokSearchMode = (typeof GROK_SEARCH_MODE_VALUES)[number];

const SEARCH_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `search_parameters` 里认得的子键 —— **一键一条校验,值原样透传**。
 *
 * 这里只判「这个值发出去合不合法」,不改写、不补默认:`sources` 的项形状是
 * xAI 自己的事(web / x / news / rss 各有各的字段),我们不替它拍板,只保证
 * 它是个数组;日期只认 `YYYY-MM-DD`(xAI 文档里的形状),`max_search_results`
 * 只认正整数。表在这里,于是「什么算白名单」仍然只有一处。
 */
const GROK_SEARCH_PARAMETER_VALIDATORS: Record<
	string,
	(value: unknown) => boolean
> = {
	mode: (value) =>
		typeof value === "string" &&
		(GROK_SEARCH_MODE_VALUES as readonly string[]).includes(value),
	sources: (value) => Array.isArray(value),
	from_date: (value) => typeof value === "string" && SEARCH_DATE_PATTERN.test(value),
	to_date: (value) => typeof value === "string" && SEARCH_DATE_PATTERN.test(value),
	max_search_results: (value) =>
		typeof value === "number" && Number.isInteger(value) && value > 0,
	return_citations: (value) => typeof value === "boolean",
};

/**
 * 这一家认哪些请求级键。
 *
 * 一家一份,写在配方里(`OpenAIChatDialectSpec.providerOptions`),codec 与
 * `extraBody` 都从那一份派生 —— 两处对「什么算白名单」永远同解。
 */
export interface OpenAIChatProviderOptionSupport {
	/** 收不收顶层 `verbosity`。 */
	verbosity?: boolean;
	/**
	 * 收不收 `image_url.detail`。`true` = 收,值域用标准三值;给数组 = 收,
	 * 且值域是这一份(deepseek);不给 / `false` = 不收(kimi / zhipu / qwen)。
	 */
	imageDetail?: boolean | readonly string[];
	/**
	 * 收不收 `searchParameters`(xAI Live Search,P3-5a)。只有 grok / grok-oauth
	 * 打开;别家收到这个键照旧当认不出的键丢弃并留痕。
	 */
	searchParameters?: boolean;
}

/** 白名单过滤后剩下的东西。 */
export interface OpenAIChatProviderOptions {
	verbosity?: OpenAIChatVerbosity;
	imageDetail?: string;
	/** 过完嵌套白名单的 `search_parameters`(键值原样,见验证表)。 */
	searchParameters?: Record<string, unknown>;
}

/** 一个键为什么没发出去。 */
export type OpenAIChatProviderOptionDropReason = "unknown-key" | "illegal-value";

export type OpenAIChatProviderOptionDropped = (
	key: string,
	value: unknown,
	reason: OpenAIChatProviderOptionDropReason,
) => void;

function imageDetailValues(
	support: OpenAIChatProviderOptionSupport,
): readonly string[] | undefined {
	const declared = support.imageDetail;
	if (declared === undefined || declared === false) return undefined;
	return declared === true ? OPENAI_CHAT_IMAGE_DETAIL_VALUES : declared;
}

/**
 * `searchParameters` 那一层 —— 逐子键过验证表。
 *
 * 返回 `undefined` = 这一条整体不发:值不是对象(整条非法,留一条痕),
 * 或者一个合法子键都没剩下(空的 `search_parameters` 是纯噪音,不发)。
 * 子键的痕写全路径,于是排障时看得出是袋里哪一层的哪个键被丢的。
 */
function pickGrokSearchParameters(
	value: unknown,
	onDropped?: OpenAIChatProviderOptionDropped,
): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		onDropped?.("searchParameters", value, "illegal-value");
		return undefined;
	}

	const picked: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (entry === undefined) continue;
		const validate = GROK_SEARCH_PARAMETER_VALIDATORS[key];
		if (!validate) {
			onDropped?.(`searchParameters.${key}`, entry, "unknown-key");
			continue;
		}
		if (!validate(entry)) {
			onDropped?.(`searchParameters.${key}`, entry, "illegal-value");
			continue;
		}
		picked[key] = entry;
	}

	return Object.keys(picked).length > 0 ? picked : undefined;
}

/** 这一格袋 —— 只取自己 providerId 的那一格,别家的一个字都不看。 */
export function readOpenAIChatProviderOptionBag(
	turn: TurnContext,
): Record<string, unknown> {
	return turn.request.providerOptions?.[turn.profile.providerId] ?? {};
}

/**
 * 袋 → 白名单值。**纯函数**:传了 `onDropped` 才留痕(见文件头)。
 */
export function pickOpenAIChatProviderOptions(
	turn: TurnContext,
	support: OpenAIChatProviderOptionSupport,
	onDropped?: OpenAIChatProviderOptionDropped,
): OpenAIChatProviderOptions {
	const bag = readOpenAIChatProviderOptionBag(turn);
	const picked: OpenAIChatProviderOptions = {};
	const details = imageDetailValues(support);

	for (const [key, value] of Object.entries(bag)) {
		if (value === undefined) continue;
		if (key === "verbosity" && support.verbosity) {
			if (
				typeof value === "string" &&
				(OPENAI_CHAT_VERBOSITY_VALUES as readonly string[]).includes(value)
			) {
				picked.verbosity = value as OpenAIChatVerbosity;
				continue;
			}
			onDropped?.(key, value, "illegal-value");
			continue;
		}
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

/** `image_url.detail` 的值 —— codec 调这一支(不留痕,见文件头)。 */
export function openAIChatImageDetail(
	turn: TurnContext | undefined,
	support: OpenAIChatProviderOptionSupport,
): string | undefined {
	if (!turn) return undefined;
	return pickOpenAIChatProviderOptions(turn, support).imageDetail;
}

/**
 * 请求体那一半:`verbosity` 与 `search_parameters` 上顶层。`imageDetail`
 * **不在这里** —— 它是内容块
 * 上的字段,由 codec 写(请求体只在 builder / `extraBody` 长出来这条规矩管的是
 * 顶层字段,内容块本来就是 codec 的产出)。
 *
 * 这一支是每家配方都会挂上的:哪怕这家一个键都不认,认不出的键也要留痕,
 * 不能因为「这家没有旋钮」就静默吞掉用户写进 settings.json 的东西。
 */
export function openAIChatProviderOptionsExtraBody(
	support: OpenAIChatProviderOptionSupport,
): (turn: TurnContext) => Record<string, unknown> {
	return (turn) => {
		const picked = pickOpenAIChatProviderOptions(turn, support, (key, value, reason) => {
			turn.warn(
				"setting-dropped",
				reason === "unknown-key"
					? `providerOptions.${key} is not a recognized request option on this endpoint`
					: `providerOptions.${key} carries a value this endpoint does not accept`,
				{ key, value, reason },
			);
		});
		return {
			...(picked.verbosity === undefined ? {} : { verbosity: picked.verbosity }),
			...(picked.searchParameters === undefined
				? {}
				: { search_parameters: picked.searchParameters }),
		};
	};
}
