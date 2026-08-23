/**
 * xAI **Live Search** 的 `search_parameters` 白名单 —— 一份表,两条线协议共用。
 *
 * 官方(docs.x.ai `/developers/rest-api-reference/inference/chat`)把同一个
 * 对象**逐字**列在两个端点的 Request Body 上:
 *
 *  - `POST /v1/chat/completions` → `search_parameters`
 *  - `POST /v1/responses`        → `search_parameters`
 *    (那一页还补了一句:「`web_search_preview` tool, if specified, will be
 *     overridden by `search_parameters`」—— 也就是说 Live Search 在 Responses
 *     上**不是**做成 `tools:[{type:'web_search'}]` 的替代品,两者并存,
 *     `search_parameters` 优先。所以 P4-4 把 grok 从 chat 换到 responses 时,
 *     这一格袋是 **1:1 平移**,不需要翻译成工具表。)
 *
 * 六个子键的语义也逐字取自那一页:
 *  - `mode`:`off` / `on`(默认)/ `auto`
 *  - `sources`:数组;项的形状(web / x / news / rss 各自的字段)是 xAI 自己的
 *    事,我们不替它拍板,只保证它是个数组
 *  - `from_date` / `to_date`:ISO-8601 `YYYY-MM-DD`
 *  - `max_search_results`:正整数
 *  - `return_citations`:布尔
 *
 * P4-4 之前这张表住在 `openai-chat-provider-options.ts` 里(P3-5a)。grok 是
 * 唯一认它的家,而 grok 已经整家搬到 openai-responses —— 表跟着搬出来独立成
 * 模块,于是「什么算白名单」仍然只有一处,而两条线协议谁都不必知道对方。
 */

/** `search_parameters.mode` 的三个合法值。 */
export const GROK_SEARCH_MODE_VALUES = ["off", "on", "auto"] as const;

export type GrokSearchMode = (typeof GROK_SEARCH_MODE_VALUES)[number];

const SEARCH_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `search_parameters` 里认得的子键 —— **一键一条校验,值原样透传**。
 *
 * 这里只判「这个值发出去合不合法」,不改写、不补默认。
 */
export const GROK_SEARCH_PARAMETER_VALIDATORS: Record<
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

/** 一个子键为什么没发出去。 */
export type XaiSearchParameterDropReason = "unknown-key" | "illegal-value";

export type XaiSearchParameterDropped = (
	key: string,
	value: unknown,
	reason: XaiSearchParameterDropReason,
) => void;

/**
 * 袋里的 `searchParameters` → 请求体上的 `search_parameters`,**逐子键**过表。
 *
 * 返回 `undefined` = 这一条整体不发:值不是对象(整条非法,留一条痕),或者
 * 一个合法子键都没剩下(空的 `search_parameters` 是纯噪音,不发)。子键的痕写
 * 全路径 `searchParameters.<子键>`,于是排障时看得出是袋里哪一层的哪个键被丢的。
 */
export function pickGrokSearchParameters(
	value: unknown,
	onDropped?: XaiSearchParameterDropped,
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
