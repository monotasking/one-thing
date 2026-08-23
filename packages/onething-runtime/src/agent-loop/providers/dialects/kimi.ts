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
import { thinkingTypeWire } from "../thinking/index.js";
import { defineOpenAIChatDialect, openAIChatTransportCapabilities } from "./recipe.js";

export const KIMI_DIALECT = defineOpenAIChatDialect({
	id: "kimi",
	defaultBaseUrl: ONETHING_KIMI_DEFAULT_BASE_URL,
	reasoning: thinkingTypeWire,
	includeAssistantReasoning: true,
	transport: openAIChatTransportCapabilities({ reasoning: true }),
});
