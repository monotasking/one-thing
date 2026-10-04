/**
 * models.dev 目录键 —— 「这个 provider 在这份配置下读哪本目录」。
 *
 * 独立成文件是因为渲染层也要问同一个问题(settings store 在一次保存后比较
 * 前后目录键,变了就重拉那个 provider 的模型清单):这里只有纯查表,不带
 * model-registry.ts 那一整套抓取/落盘。规则本身与 model-registry 同一份,
 * 那边只是 re-export。
 */
import type { CoreProviderConfigLike, ProviderConfigWithDials } from "./provider-config.js";
import { BUILTIN_PROVIDER_MANIFESTS } from "./builtin-manifests.js";
import { getProviderManifest } from "./provider-manifest.js";

/**
 * **不是内置服务商**的几本 models.dev 目录(Mistral / Meta 的 Llama / Cohere):它们的型号经别家
 * 转售出现,目录键要映射到一个稳定的 id 上供目录与认亲用,但我们没有这几家的服务商。这是型号厂牌
 * 的数据,不是在点哪一家服务商的名 —— 内置服务商自己声明哪些目录键归它(`manifest.catalogAliases`,
 * 服务商自述试点 P2 第 4 批起一家不剩)。
 */
const NON_VENDOR_CATALOG_MAPPING: Record<string, string> = {
	mistral: "mistral",
	meta: "llama",
	cohere: "cohere",
};

/** models.dev 目录键 → 我们的 provider id:各家内置服务商的 `catalogAliases` + 上面那几本非服务商目录。 */
export const ONETHING_PROVIDER_MAPPING: Record<string, string> = {
	...NON_VENDOR_CATALOG_MAPPING,
	...Object.fromEntries(
		BUILTIN_PROVIDER_MANIFESTS.flatMap((manifest) =>
			(manifest.catalogAliases ?? []).map((alias) => [alias, manifest.id] as const),
		),
	),
};

/**
 * 目录键由各家 manifest 的 `models` 自己说(批 M):`models.dev` 读 `keyOf(config)` 或
 * `key`(千问 / Kimi 按地区与档位选目录,那一半在各自的 `keyOf` 里);`endpoint` 读
 * `catalogKey`(能力事实仍从哪本目录补)。没有 manifest 的 id 走反查表,再不中就是它自己。
 *
 * `config` 是通用的 provider 配置:档位 / 地区格由各家 manifest 声明、各家 `keyOf` 按键读,
 * 这里不点名(带档位格的字面量用 `ProviderConfigWithDials` 那一半收)。
 */
export function getOnethingModelsDevProviderId(
	providerId: string,
	config?: CoreProviderConfigLike | ProviderConfigWithDials,
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
