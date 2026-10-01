import type {
	OnethingProviderDefinition,
	OnethingProviderInfo,
	OnethingProviderOAuthFlowType,
} from "./provider-definition.js";
import { BUILTIN_PROVIDER_MANIFESTS } from "./builtin-manifests.js";
import { EXTERNAL_AGENT_DIALECT_ID, type ProviderManifest } from "./manifest.js";

/**
 * 内置服务商的 `OnethingProviderInfo` —— 批 M 起**从 manifest 派生**
 * (`builtin-manifests.ts` 是唯一产地),这里只剩投影与既有的导出面。
 *
 * `description` 是**字典键**(`providers.desc.<id>`),不是人话:壳按键查 zh / en
 * 字典显示。自定义服务商的描述是用户自己写的原文,不走这条路。
 */
export type OnethingBuiltinOAuthFlowType = OnethingProviderOAuthFlowType;
export type OnethingBuiltinProviderInfo = OnethingProviderInfo;
export type OnethingBuiltinProviderDefinition =
	OnethingProviderDefinition<OnethingBuiltinProviderInfo>;

/** manifest → 老的 info 形状。`oauthFlow` 两档:设备码 = `device`,其余 = `authorization-code`。 */
export function providerInfoOfManifest(
	manifest: ProviderManifest,
): OnethingProviderInfo {
	const oauth = manifest.auth.kind === "oauth" ? manifest.auth : undefined;
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

export const claudeCodeBuiltinProvider = definitionById("claude-code");
export const kimiCodeBuiltinProvider = definitionById("kimi-code");
export const githubCopilotBuiltinProvider = definitionById("github-copilot");
export const codexBuiltinProvider = definitionById("codex");
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
