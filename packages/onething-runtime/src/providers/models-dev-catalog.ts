/**
 * models.dev 目录键 —— 「这个 provider 在这份配置下读哪本目录」。
 *
 * 独立成文件是因为渲染层也要问同一个问题(settings store 在一次保存后比较
 * 前后目录键,变了就重拉那个 provider 的模型清单):这里只有纯查表,不带
 * model-registry.ts 那一整套抓取/落盘。规则本身与 model-registry 同一份,
 * 那边只是 re-export。
 */
import type { OnethingKimiEndpointConfig } from "./kimi.js";
import type { OnethingQwenEndpointConfig } from "./qwen.js";
import { getProviderManifest } from "./manifest.js";

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

/**
 * 目录键由各家 manifest 的 `models` 自己说(批 M):`models.dev` 读 `keyOf(config)` 或
 * `key`(千问 / Kimi 按地区与档位选目录,那一半在各自的 `keyOf` 里);`endpoint` 读
 * `catalogKey`(能力事实仍从哪本目录补)。没有 manifest 的 id 走反查表,再不中就是它自己。
 */
export function getOnethingModelsDevProviderId(
	providerId: string,
	config?: OnethingQwenEndpointConfig & OnethingKimiEndpointConfig,
): string {
	const source = getProviderManifest(providerId)?.models;
	if (source?.kind === "models.dev") {
		return source.keyOf?.(config as Record<string, unknown> | undefined) ?? source.key;
	}
	if (source?.kind === "endpoint" && source.catalogKey) return source.catalogKey;
	return (
		Object.entries(ONETHING_PROVIDER_MAPPING).find(
			([, mappedId]) => mappedId === providerId,
		)?.[0] || providerId
	);
}
