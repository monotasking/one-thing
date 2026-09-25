import type {
	OnethingProviderDefinition,
	OnethingProviderInfo,
	OnethingProviderOAuthFlowType,
} from "./provider-definition.js";
import {
	ONETHING_CODEX_BASE_URL,
	ONETHING_CODEX_DEFAULT_MODEL,
	ONETHING_CODEX_PROVIDER_ID,
} from "./codex.js";
import {
	ONETHING_KIMI_CODE_DEFAULT_MODEL,
	ONETHING_KIMI_CODING_PLAN_BASE_URL,
	ONETHING_KIMI_DEFAULT_BASE_URL,
} from "./kimi.js";
import {
	ONETHING_QWEN_DEFAULT_BASE_URL,
	ONETHING_QWEN_DEFAULT_MODEL,
	ONETHING_QWEN_PROVIDER_ID,
} from "./qwen.js";

/**
 * 内置服务商的 `description` 是**字典键**(`providers.desc.<id>`),不是人话:
 * 壳按键查 zh / en 字典显示(apps/desktop-react/src/i18n)。自定义服务商的描述是
 * 用户自己写的原文,不走这条路。
 */
export type OnethingBuiltinOAuthFlowType = OnethingProviderOAuthFlowType;
export type OnethingBuiltinProviderInfo = OnethingProviderInfo;
export type OnethingBuiltinProviderDefinition =
	OnethingProviderDefinition<OnethingBuiltinProviderInfo>;

export const openaiBuiltinProvider: OnethingBuiltinProviderDefinition = {
	id: "openai",
	info: {
		id: "openai",
		name: "OpenAI",
		description: "providers.desc.openai",
		defaultBaseUrl: "https://api.openai.com/v1",
		defaultModel: "gpt-4o-mini",
		icon: "openai",
		supportsCustomBaseUrl: true,
		requiresApiKey: true,
	},
};

export const claudeBuiltinProvider: OnethingBuiltinProviderDefinition = {
	id: "claude",
	info: {
		id: "claude",
		name: "Claude",
		description: "providers.desc.claude",
		defaultBaseUrl: "https://api.anthropic.com/v1",
		defaultModel: "claude-sonnet-4-20250514",
		icon: "claude",
		supportsCustomBaseUrl: true,
		requiresApiKey: true,
	},
};

export const deepseekBuiltinProvider: OnethingBuiltinProviderDefinition = {
	id: "deepseek",
	info: {
		id: "deepseek",
		name: "DeepSeek",
		description: "providers.desc.deepseek",
		defaultBaseUrl: "https://api.deepseek.com",
		defaultModel: "deepseek-chat",
		icon: "deepseek",
		supportsCustomBaseUrl: true,
		requiresApiKey: true,
	},
};

export const kimiBuiltinProvider: OnethingBuiltinProviderDefinition = {
	id: "kimi",
	info: {
		id: "kimi",
		name: "Kimi",
		description: "providers.desc.kimi",
		defaultBaseUrl: ONETHING_KIMI_DEFAULT_BASE_URL,
		defaultModel: "moonshot-v1-128k",
		icon: "kimi",
		supportsCustomBaseUrl: true,
		requiresApiKey: true,
	},
};

export const zhipuBuiltinProvider: OnethingBuiltinProviderDefinition = {
	id: "zhipu",
	info: {
		id: "zhipu",
		name: "智谱 GLM",
		description: "providers.desc.zhipu",
		defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
		defaultModel: "glm-5.2",
		icon: "zhipu",
		supportsCustomBaseUrl: true,
		requiresApiKey: true,
	},
};

export const qwenBuiltinProvider: OnethingBuiltinProviderDefinition = {
	id: ONETHING_QWEN_PROVIDER_ID,
	info: {
		id: ONETHING_QWEN_PROVIDER_ID,
		name: "千问",
		description: "providers.desc.qwen",
		defaultBaseUrl: ONETHING_QWEN_DEFAULT_BASE_URL,
		defaultModel: ONETHING_QWEN_DEFAULT_MODEL,
		icon: "qwen",
		supportsCustomBaseUrl: true,
		requiresApiKey: true,
	},
};

export const openrouterBuiltinProvider: OnethingBuiltinProviderDefinition = {
	id: "openrouter",
	info: {
		id: "openrouter",
		name: "OpenRouter",
		description: "providers.desc.openrouter",
		defaultBaseUrl: "https://openrouter.ai/api/v1",
		defaultModel: "openai/gpt-4o",
		icon: "openrouter",
		supportsCustomBaseUrl: false,
		requiresApiKey: true,
	},
};

export const geminiBuiltinProvider: OnethingBuiltinProviderDefinition = {
	id: "gemini",
	info: {
		id: "gemini",
		name: "Google Gemini",
		description: "providers.desc.gemini",
		defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
		defaultModel: "gemini-2.0-flash-exp",
		icon: "gemini",
		supportsCustomBaseUrl: true,
		requiresApiKey: true,
	},
};

export const claudeCodeBuiltinProvider: OnethingBuiltinProviderDefinition = {
	id: "claude-code",
	info: {
		id: "claude-code",
		name: "Claude Code",
		description: "providers.desc.claude-code",
		defaultBaseUrl: "https://api.anthropic.com/v1",
		defaultModel: "claude-sonnet-4-20250514",
		icon: "claude-code",
		supportsCustomBaseUrl: false,
		requiresApiKey: false,
		requiresOAuth: true,
		oauthFlow: "authorization-code",
	},
};

export const grokBuiltinProvider: OnethingBuiltinProviderDefinition = {
	id: "grok",
	info: {
		id: "grok",
		name: "Grok",
		description: "providers.desc.grok",
		defaultBaseUrl: "https://api.x.ai/v1",
		defaultModel: "grok-3-latest",
		icon: "grok",
		supportsCustomBaseUrl: true,
		requiresApiKey: true,
	},
};

export const grokOAuthBuiltinProvider: OnethingBuiltinProviderDefinition = {
	id: "grok-oauth",
	info: {
		id: "grok-oauth",
		name: "Grok (Subscription)",
		description: "providers.desc.grok-oauth",
		defaultBaseUrl: "https://api.x.ai/v1",
		defaultModel: "grok-3-latest",
		icon: "grok",
		supportsCustomBaseUrl: false,
		requiresApiKey: false,
		requiresOAuth: true,
		oauthFlow: "device",
	},
};

/**
 * Kimi Code(编程套餐)—— 订阅走 OAuth,与按量那条 `kimi` 是两个 provider。
 *
 * 拆开不是洁癖,是三样东西真的不同:凭证(OAuth token vs API Key)、地址(套餐 host
 * 固定,不跟 `kimi` 的地区档走)、账目(订阅制 vs 按 token 计费)。与
 * grok / grok-oauth、openai / codex、claude / claude-code 同一条判例;呈现层再用
 * provider family 把两张卡并成一张。
 *
 * `supportsCustomBaseUrl: false`:套餐只认自己那一个 host,给个能改的框等于给一条
 * 401 的路。
 */
export const kimiCodeBuiltinProvider: OnethingBuiltinProviderDefinition = {
	id: "kimi-code",
	info: {
		id: "kimi-code",
		name: "Kimi Code (订阅)",
		description: "providers.desc.kimi-code",
		defaultBaseUrl: ONETHING_KIMI_CODING_PLAN_BASE_URL,
		// 套餐目录里真有的 id。写按量那本的名字(kimi-k2.7-code-highspeed)会 404:
		// 两本目录一个 id 都不重名。
		defaultModel: ONETHING_KIMI_CODE_DEFAULT_MODEL,
		icon: "kimi",
		supportsCustomBaseUrl: false,
		requiresApiKey: false,
		requiresOAuth: true,
		oauthFlow: "device",
	},
};

export const githubCopilotBuiltinProvider: OnethingBuiltinProviderDefinition = {
	id: "github-copilot",
	info: {
		id: "github-copilot",
		name: "GitHub Copilot",
		description: "providers.desc.github-copilot",
		defaultBaseUrl: "https://api.individual.githubcopilot.com",
		defaultModel: "gpt-4o",
		icon: "github",
		supportsCustomBaseUrl: false,
		requiresApiKey: false,
		requiresOAuth: true,
		oauthFlow: "device",
	},
};

export const codexBuiltinProvider: OnethingBuiltinProviderDefinition = {
	id: ONETHING_CODEX_PROVIDER_ID,
	info: {
		id: ONETHING_CODEX_PROVIDER_ID,
		name: "Codex",
		description: "providers.desc.codex",
		defaultBaseUrl: ONETHING_CODEX_BASE_URL,
		defaultModel: ONETHING_CODEX_DEFAULT_MODEL,
		icon: "codex",
		supportsCustomBaseUrl: false,
		requiresApiKey: false,
		requiresOAuth: true,
		oauthFlow: "authorization-code",
	},
};

export const ONETHING_ACP_PROVIDER_ID = "acp";

export const acpBuiltinProvider: OnethingBuiltinProviderDefinition = {
	id: ONETHING_ACP_PROVIDER_ID,
	info: {
		id: ONETHING_ACP_PROVIDER_ID,
		name: "ACP Agents",
		description: "providers.desc.acp",
		defaultBaseUrl: "",
		defaultModel: "claude-code",
		icon: "acp",
		supportsCustomBaseUrl: false,
		requiresApiKey: false,
	},
};

export const claudeCodeAgentBuiltinProvider: OnethingBuiltinProviderDefinition =
	{
		id: "claude-code-agent",
		info: {
			id: "claude-code-agent",
			name: "Claude Code Agent",
			description: "providers.desc.claude-code-agent",
			defaultBaseUrl: "",
			defaultModel: "claude-code-agent",
			icon: "claude-code",
			supportsCustomBaseUrl: false,
			requiresApiKey: false,
		},
	};

export const onethingPortableBuiltinProviders: OnethingBuiltinProviderDefinition[] =
	[
		openaiBuiltinProvider,
		claudeBuiltinProvider,
		deepseekBuiltinProvider,
		kimiBuiltinProvider,
		zhipuBuiltinProvider,
		qwenBuiltinProvider,
		openrouterBuiltinProvider,
		geminiBuiltinProvider,
		claudeCodeBuiltinProvider,
		grokBuiltinProvider,
		grokOAuthBuiltinProvider,
		kimiCodeBuiltinProvider,
		githubCopilotBuiltinProvider,
		codexBuiltinProvider,
	];

export const onethingBaseBuiltinProviders: OnethingBuiltinProviderDefinition[] =
	[
		...onethingPortableBuiltinProviders,
		acpBuiltinProvider,
		claudeCodeAgentBuiltinProvider,
	];
