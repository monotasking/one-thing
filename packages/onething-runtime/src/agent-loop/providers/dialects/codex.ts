/**
 * `codex` —— ChatGPT 后端的 Responses 端点。与 `factory.ts` 那条注册逐项
 * 对照:`defaultBaseUrl: 'https://chatgpt.com/backend-api/codex'`、凭据走
 * OAuth(三级解析 + 401 强制刷新一次)、传输声明是 `CODEX_AGENT_CAPABILITIES`
 * 原样、一条 system 都没有时的 `instructions` 兜底是
 * `CODEX_FALLBACK_INSTRUCTIONS`。
 *
 * P4-4 起这条线上还挂着 `grok` / `grok-oauth`,所以**codex 的每一样怪癖都得在
 * 配方上写明**(在此之前它们是 `responses-recipe.ts` 里的默认值)。这些字段
 * 集中在 `responses-recipe.ts` 的 `CODEX_DIALECT_SPEC` 常量里 —— 门面
 * `providers/codex.ts` 也用同一份,否则两个构造点会分叉:
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
 */
import {
	CODEX_DIALECT_SPEC,
	defineResponsesDialect,
} from "./responses-recipe.js";

export const CODEX_DIALECT = defineResponsesDialect({
	id: "codex",
	...CODEX_DIALECT_SPEC,
});
