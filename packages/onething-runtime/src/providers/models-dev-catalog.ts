/**
 * models.dev 目录键 —— 「这个 provider 在这份配置下读哪本目录」。
 *
 * 独立成文件是因为渲染层也要问同一个问题(settings store 在一次保存后比较
 * 前后目录键,变了就重拉那个 provider 的模型清单):这里只有纯查表,不带
 * model-registry.ts 那一整套抓取/落盘。规则本身与 model-registry 同一份,
 * 那边只是 re-export。
 */
import {
	ONETHING_KIMI_CODE_MODELS_DEV_ID,
	ONETHING_KIMI_PROVIDER_ID,
	resolveOnethingKimiModelsDevProviderId,
	type OnethingKimiEndpointConfig,
} from "./kimi.js";
import {
	ONETHING_QWEN_PROVIDER_ID,
	resolveOnethingQwenModelsDevProviderId,
	type OnethingQwenEndpointConfig,
} from "./qwen.js";

export const ONETHING_PROVIDER_MAPPING: Record<string, string> = {
	openai: "openai",
	anthropic: "claude",
	google: "gemini",
	deepseek: "deepseek",
	mistral: "mistral",
	meta: "llama",
	cohere: "cohere",
	// 千问: the registry key depends on region + plan (see qwen.ts). This entry
	// is only the fallback for a config-less lookup — 国内版 pay-as-you-go.
	"alibaba-cn": "qwen",
	zhipuai: "zhipu",
	moonshotai: "kimi",
	xai: "grok",
};

export function getOnethingModelsDevProviderId(
	providerId: string,
	config?: OnethingQwenEndpointConfig & OnethingKimiEndpointConfig,
): string {
	// grok-oauth shares the same xAI models as grok
	if (providerId === "grok-oauth") return "xai";
	// claude-code-agent drives the same Claude models the CLI ships with
	if (providerId === "claude-code-agent") return "anthropic";
	// kimi-code(订阅)读**套餐自己那本**目录:型号名与按量那本一个都不重名
	// (`k3` / `k3-256k` vs `kimi-k3` / `kimi-k2.7-code-*`),接错了症状就是
	// "拉过来的模型里没有 k3-256k"。
	if (providerId === "kimi-code") return ONETHING_KIMI_CODE_MODELS_DEV_ID;
	// kimi(按量/套餐 x 国内/海外)同样按地址选目录 —— 三个地址三本。
	if (providerId === ONETHING_KIMI_PROVIDER_ID) {
		return resolveOnethingKimiModelsDevProviderId(config);
	}
	// 千问 splits its catalog four ways (国内/海外 x 按量/Token Plan).
	if (providerId === ONETHING_QWEN_PROVIDER_ID) {
		return resolveOnethingQwenModelsDevProviderId(config);
	}
	return (
		Object.entries(ONETHING_PROVIDER_MAPPING).find(
			([, mappedId]) => mappedId === providerId,
		)?.[0] || providerId
	);
}
