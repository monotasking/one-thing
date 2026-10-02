/**
 * `codex` —— ChatGPT 后端的 Responses 端点。与 `runtime.ts` 的工厂逐项
 * 对照:`defaultBaseUrl: 'https://chatgpt.com/backend-api/codex'`、凭据走
 * OAuth(三级解析 + 401 强制刷新一次)、传输声明是 `CODEX_AGENT_CAPABILITIES`
 * 原样、一条 system 都没有时的 `instructions` 兜底是
 * `CODEX_FALLBACK_INSTRUCTIONS`。
 *
 * P4-4 起这条线上还挂着 `grok` / `grok-oauth`,所以**codex 的每一样怪癖都得在
 * 配方上写明**(在此之前它们是 `responses-recipe.ts` 里的默认值)。这些字段
 * 集中在本文件的 `CODEX_DIALECT_SPEC` 常量里 —— 门面 `agent-provider.ts` 也用
 * 同一份,否则两个构造点会分叉:
 *
 *  - `endpoint`:`responsesEndpoint()` 的三态归一化(baseUrl 可能已经是
 *    `…/codex/responses`、可能只到 `…/codex`、也可能什么都没带);
 *  - `store: false`:ChatGPT 后台默认存,我们不存;
 *  - `nativeTools`:`requestedOutputModalities` 含 `'image'` 时挂
 *    `{type:'image_generation', output_format:'png'}` —— 生图不是一个开关,
 *    是工具表里多一项(设计稿 §5 的生图路由);
 *  - `reasoning`(默认那条 `RESPONSES_THINKING_WIRES`):`include` 与
 *    `reasoning` 同生共死、effort 的 `max` 钳成 `high`、
 *    `isCodexReasoningModel` 认出推理模型时自动补 `medium`;
 *  - `errorLabel` / `providerDataTag` / `fallbackInstructions` / `providerOptions`:
 *    默认值就是 codex 的那一份,所以这里不写(写了也一个字节都不变)。
 *
 * 这些字段一个都不是分支 —— `OpenAIResponsesWire` 里没有一处
 * `if (providerId === 'codex')`。
 *
 * 服务商自述试点 P2 第 4 批从 `agent-loop/providers/dialects/codex.ts` 搬回家;只服务这一家的
 * 那几样(`CODEX_DIALECT_SPEC`、三态端点归一化、默认地址)一起从 `responses-recipe.ts` 搬来。
 * 配方的几项**缺省值**(占位认证、传输声明、兜底 instructions、错误标签、思考线型)仍是
 * codex 的那一份、仍住在 `responses-recipe.ts`:自定义服务商的 Responses 适配表也吃那几项缺省,
 * 它们是这条线协议的历史缺省,不是这一家的私货。
 */
import type { DialectEndpoint } from "../../../agent-loop/providers/base/index.js";
import { registerProviderDataTagPolicy } from "../../../agent-loop/providers/provider-data-policy.js";
import {
	defineResponsesDialect,
	type ResponsesDialectSpec,
} from "../../../agent-loop/providers/dialects/responses-recipe.js";
import { codexQuotaFromHeaders } from "./quota.js";

export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

/** `resolveCodexResponsesUrl` 逐字:三态归一化到同一个 `…/codex/responses`。 */
export function resolveCodexResponsesUrl(baseUrl?: string): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

/**
 * **codex 专属**的端点:`path` 是空串,真正的路径是 baseUrl **本身**的三态
 * 归一化结果,只能在 `decorateUrl` 里长出来(basePath 拼接会把
 * `…/codex/responses` 拼成 `…/codex/responses/responses`)。URL 上不带凭据,
 * 所以不需要 `redactForDump`。
 */
export function responsesEndpoint(
	defaultBaseUrl: string = CODEX_BASE_URL,
): DialectEndpoint {
	return {
		defaultBaseUrl,
		path: "",
		decorateUrl(url: string): string {
			return resolveCodexResponsesUrl(url);
		},
	};
}

/**
 * **codex 那一份配方主体**(除了 id)—— 两个构造点共用一份,于是本文件的具名方言
 * 与 `agent-provider.ts` 那个即用即弃的门面永远同解。
 *
 * P4-4 之前这几样是 `responsesDialect()` 的默认值,门面因此「不写就对」;
 * 现在配方通用了,谁要 codex 的行为谁就得**明说**,所以它成了一个常量而不是
 * 一句默认。`codex-provider.test.ts` 的 image_generation 断言就是这条的门。
 */
export const CODEX_DIALECT_SPEC: Omit<ResponsesDialectSpec, "id"> = {
	defaultBaseUrl: CODEX_BASE_URL,
	endpoint: responsesEndpoint(CODEX_BASE_URL),
	store: false,
	nativeTools: (turn) =>
		turn.request.requestedOutputModalities?.includes("image")
			? [{ type: "image_generation", output_format: "png" }]
			: [],
};

const responsesDialectSpec: ResponsesDialectSpec = {
	id: "codex",
	...CODEX_DIALECT_SPEC,
	// 每条响应头上都带着两窗的用量(批 5 被动源)—— 发一条消息就顺手刷新配额缓存。
	// 只挂在 codex 这一份上:grok 两条通路走它们自己的配方,头上没有这一族。
	quotaFromHeaders: (headers) => codexQuotaFromHeaders(headers),
};
export const CODEX_DIALECT = defineResponsesDialect(responsesDialectSpec);

// 这家的 provider-data 生图之外只留加密思维链;老消息上散装的 `encryptedReasoning`
// 也按这个标签还原(批 M:从前是 `provider-data.ts` 里三处点名)。
registerProviderDataTagPolicy(CODEX_DIALECT.providerDataTag, {
	persistOnlyEncryptedReasoning: true,
	legacyEncryptedReasoningField: true,
});
