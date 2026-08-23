/**
 * openai-chat 线上的**请求级 providerOptions 袋**(P3-3,设计稿 §2.8)。
 *
 * 袋是双向命名空间的:`AgentTurnRequest.providerOptions[providerId]` 里装的是
 * 宿主 / 设置注入的实验性或家专属请求参数,**provider 只读自己那一格**。这里是
 * openai-chat 这一条线的白名单 —— 认得的键翻成请求体上的字段,认不得的键
 * **丢弃并留痕**(`setting-dropped`),没有第三种。
 *
 * 白名单只有两条:
 *  - `verbosity`(`low|medium|high`)—— OpenAI 的输出长度旋钮,顶层字段;
 *  - `imageDetail`(值域按家:openai/grok/openrouter 是 `auto|low|high`,
 *    deepseek 多一个 `original`)—— 由 codec 写进**每一个** `image_url.detail`。
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
}

/** 白名单过滤后剩下的东西。 */
export interface OpenAIChatProviderOptions {
	verbosity?: OpenAIChatVerbosity;
	imageDetail?: string;
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
 * 请求体那一半:`verbosity` 上顶层。`imageDetail` **不在这里** —— 它是内容块
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
		return picked.verbosity === undefined ? {} : { verbosity: picked.verbosity };
	};
}
