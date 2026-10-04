import type {
	OnethingProviderDefinition,
	OnethingProviderInfo,
	OnethingProviderOAuthFlowType,
} from "./provider-definition.js";
import {
	BUILTIN_PROVIDER_MANIFESTS,
	builtinProviderFamilyInfoOf,
} from "./provider-builtin-manifests.js";
import { dialDescriptorOf } from "./provider-dials.js";
import { EXTERNAL_AGENT_DIALECT_ID, type ProviderManifest } from "./provider-manifest.js";

/**
 * 内置服务商的 `OnethingProviderInfo` —— 批 M 起**从 manifest 派生**
 * (`provider-builtin-manifests.ts` 是唯一产地),这里只剩投影与既有的导出面。
 *
 * `description` 是**字典键**(`providers.desc.<id>`),不是人话:壳按键查 zh / en
 * 字典显示。自定义服务商的描述是用户自己写的原文,不走这条路。
 */
export type OnethingBuiltinOAuthFlowType = OnethingProviderOAuthFlowType;
export type OnethingBuiltinProviderInfo = OnethingProviderInfo;
export type OnethingBuiltinProviderDefinition =
	OnethingProviderDefinition<OnethingBuiltinProviderInfo>;

/**
 * manifest → 老的 info 形状。`oauthFlow` 两档:设备码 = `device`,其余 = `authorization-code`。
 *
 * P4 起多投三格**纯数据**,壳因此不再 import runtime 的服务商代码:
 *  - `dials`:计费档位(`dialDescriptorOf`,与 spec 函数的等价证据在
 *    `__tests__/dial-descriptor.equivalence.test.ts`);
 *  - `hasQuota`:manifest 指了 `quotaSource`(与壳从前读 manifest 那一格同一个判据);
 *  - `family`:名册算出来的家族信息(`builtinProviderFamilyInfoOf`)。
 * 三格都只在「有」时出现,没有的家形状与从前逐字相同。
 */
export function providerInfoOfManifest(
	manifest: ProviderManifest,
): OnethingProviderInfo {
	const oauth = manifest.auth.kind === "oauth" ? manifest.auth : undefined;
	const family = builtinProviderFamilyInfoOf(manifest.id);
	return {
		id: manifest.id,
		name: manifest.name,
		description: manifest.description,
		defaultBaseUrl: manifest.defaultBaseUrl,
		defaultModel: manifest.defaultModel,
		icon: manifest.icon,
		supportsCustomBaseUrl: manifest.supportsCustomBaseUrl,
		requiresApiKey: manifest.auth.kind === "apiKey",
		...(oauth
			? {
					requiresOAuth: true,
					oauthFlow:
						oauth.flow === "device-code" ? "device" : "authorization-code",
				}
			: {}),
		...(manifest.dials ? { dials: dialDescriptorOf(manifest.dials) } : {}),
		...(manifest.quotaSource ? { hasQuota: true } : {}),
		...(family ? { family } : {}),
	};
}

function definitionOf(manifest: ProviderManifest): OnethingBuiltinProviderDefinition {
	return { id: manifest.id, info: providerInfoOfManifest(manifest) };
}

const definitions = BUILTIN_PROVIDER_MANIFESTS.map(definitionOf);

function definitionById(id: string): OnethingBuiltinProviderDefinition {
	const definition = definitions.find((entry) => entry.id === id);
	if (!definition) throw new Error(`No builtin provider manifest: ${id}`);
	return definition;
}

export const ONETHING_ACP_PROVIDER_ID = "acp";

export const acpBuiltinProvider = definitionById(ONETHING_ACP_PROVIDER_ID);

/**
 * 外部执行体(方言 `external-agent`)只在桌面有意义,不进「可移植」那张表。
 * 判据是 manifest 的字段,不是 id 名单。
 */
export const onethingPortableBuiltinProviders: OnethingBuiltinProviderDefinition[] =
	definitions.filter(
		(_definition, index) =>
			BUILTIN_PROVIDER_MANIFESTS[index]?.dialect !== EXTERNAL_AGENT_DIALECT_ID,
	);

export const onethingBaseBuiltinProviders: OnethingBuiltinProviderDefinition[] =
	[...definitions];
