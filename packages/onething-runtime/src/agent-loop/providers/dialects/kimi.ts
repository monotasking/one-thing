/**
 * `kimi` —— 开放平台(按量,国内/海外)。对照 `factory.ts`:
 * `defaultBaseUrl: ONETHING_KIMI_DEFAULT_BASE_URL` /`supportsReasoning:true` /
 * `includeAssistantReasoning:true` / `reasoningStyle:'thinking-type'`;
 * 没有 `supportsVision`(Kimi 的图片输入今天不声明)。
 *
 * 真正的地址由 `resolveOnethingKimiBaseUrl()` 在注册处算好后传进来 ——
 * 选错不是报错而是**多扣钱**,所以那一步留在 factory,配方只给缺省。
 */
import { ONETHING_KIMI_DEFAULT_BASE_URL } from "../../../providers/kimi.js";
import type { UsageFieldReader, UsagePathTable } from "../base/index.js";
import { thinkingTypeWire } from "../thinking/index.js";
import { openAIChatUsage, openAIChatUsageTable } from "../wires/index.js";
import { defineOpenAIChatDialect, openAIChatTransportCapabilities } from "./recipe.js";

/**
 * Kimi 把缓存命中报在 usage 的**顶层** `cached_tokens`,不在
 * `prompt_tokens_details` 里(开放平台与 Code Plan 同形状)。研究里对
 * 「顶层 `cached_tokens` 是不是 `prompt_tokens` 的子集」标了疑 —— 这里按
 * **子集**处理(与所有其它家一致:`uncached = prompt − cached`),
 * `wires/__tests__/usage-tables.test.ts` 的固定样本把这条口径钉住;
 * 真机样本若证伪,改的是这一行,不是投影。
 */
function kimiCacheRead(_raw: unknown, read: UsageFieldReader): number | undefined {
	return read("cached_tokens") ?? read(["prompt_tokens_details", "cached_tokens"]);
}

export const KIMI_USAGE_TABLE: UsagePathTable = openAIChatUsageTable({
	cacheRead: kimiCacheRead,
	uncachedInput: (raw, read) =>
		(read("prompt_tokens") ?? 0) - (kimiCacheRead(raw, read) ?? 0),
});

export const KIMI_DIALECT = defineOpenAIChatDialect({
	id: "kimi",
	defaultBaseUrl: ONETHING_KIMI_DEFAULT_BASE_URL,
	reasoning: thinkingTypeWire,
	includeAssistantReasoning: true,
	usage: openAIChatUsage(KIMI_USAGE_TABLE),
	transport: openAIChatTransportCapabilities({ reasoning: true }),
});
