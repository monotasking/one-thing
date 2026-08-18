import type {
	AgentCapability,
	AgentModelCapabilities,
	AgentProvider,
} from "@onething/core/agent-loop";
import { createClaudeAgentProvider } from "./claude.js";
import {
	createCodexAgentProvider,
	type CodexAgentProviderOptions,
} from "./codex.js";
import { createDeepSeekAgentProvider } from "./deepseek.js";
import { createGeminiAgentProvider } from "./gemini.js";
import { createOpenAICompatibleAgentProvider } from "./openai-compatible.js";
import type { AgentProviderRequestDumper } from "./request-dump.js";
import {
	createACPAgentProvider,
	type CoreACPAgentProviderOptions,
} from "./acp.js";
import { createExternalAgentProvider } from "../../external-agents/provider.js";
import type {
	ExternalAgentConnector,
	ExternalAgentSessionLink,
} from "../../external-agents/types.js";
import {
	ONETHING_KIMI_CODING_PLAN_BASE_URL,
	ONETHING_KIMI_DEFAULT_BASE_URL,
	resolveOnethingKimiBaseUrl,
} from "../../providers/kimi.js";
import { resolveOnethingZhipuBaseUrl } from "../../providers/zhipu.js";
import {
	ONETHING_QWEN_DEFAULT_BASE_URL,
	resolveOnethingQwenBaseUrl,
} from "../../providers/qwen.js";
import {
	readOnethingKimiOptions,
	readOnethingQwenOptions,
	readOnethingZhipuOptions,
	type OnethingProviderOptions,
} from "../../providers/provider-options.js";
import { resolveOnethingModelCapabilities } from "../../providers/model-capability.js";

export interface AgentProviderRuntimeOAuthToken {
	accessToken: string;
}

export interface AgentProviderRuntimeAuthContext {
	kind: string;
	token?: AgentProviderRuntimeOAuthToken;
}

export interface AgentProviderRuntimeConfig {
	apiKey?: string;
	baseUrl?: string;
	/**
	 * Provider-private knobs (zhipu api mode, qwen region, …), opaque to every
	 * layer between the settings store and the owning provider's factory. Only
	 * that factory unpacks it — adding a provider with its own dial must not
	 * touch this interface. See providers/provider-options.ts.
	 */
	providerOptions?: OnethingProviderOptions;
	model?: string;
	apiType?: "openai" | "anthropic";
	oauthToken?: AgentProviderRuntimeOAuthToken;
	authContext?: AgentProviderRuntimeAuthContext;
	/**
	 * per-space 凭证标记(批 B6),原样透传、这一层不解释。宿主的
	 * `refreshOAuthToken` 靠它知道「回合中途刷新出来的 token 该写回哪个空间的
	 * 哪条 entry」—— 刷新发生在 provider 内部,那里早就没有 sessionId 了。
	 */
	spaceCredential?: { spaceId?: string; entryId?: string; authType?: string };
	modelCapabilitiesByModel?: Record<
		string,
		{
			tools?: boolean;
			vision?: boolean;
			reasoning?: boolean;
		}
	>;
	models?: Record<
		string,
		{
			supportsTools?: boolean;
			supportsVision?: boolean;
			supportsReasoning?: boolean;
			contextLength?: number;
			maxOutputTokens?: number;
		}
	>;
}

export interface CreateAgentProviderFromRuntimeOptions {
	workingDirectory?: string;
	localSessionId?: string;
	fetchImpl?: typeof globalThis.fetch;
	acpStreamPrompt?: CoreACPAgentProviderOptions["streamPrompt"];
	acpCwd?: CoreACPAgentProviderOptions["cwd"];
	/**
	 * Refreshes an OAuth-backed provider's access token. Keyed by provider id
	 * rather than one field per provider: codex is simply the only builtin that
	 * needs it today, and the next OAuth provider must not have to widen this
	 * interface to get one.
	 */
	refreshOAuthToken?: (
		providerId: string,
		forceRefresh: boolean,
	) => Promise<AgentProviderRuntimeOAuthToken | undefined>;
	/**
	 * Writes each outgoing request body to disk for diagnostics. Applied to
	 * every HTTP-speaking provider; ACP/external-agent providers have no request
	 * body of their own and are not covered.
	 */
	requestDumper?: AgentProviderRequestDumper;
	/** Host-provided external agent connectors keyed by provider id. */
	externalAgentConnectors?: Record<string, ExternalAgentConnector | undefined>;
	resolveExternalAgentSessionLink?: (
		providerId: string,
		localSessionId: string,
	) => ExternalAgentSessionLink | undefined;
	onExternalAgentSessionLink?: (link: ExternalAgentSessionLink) => void;
}

export type AgentProviderRuntimeFactory = (
	config: AgentProviderRuntimeConfig,
	options: CreateAgentProviderFromRuntimeOptions,
) => AgentProvider | undefined;

function resolveRequestDumper(
	options: CreateAgentProviderFromRuntimeOptions,
): AgentProviderRequestDumper | undefined {
	return options.requestDumper;
}

export interface RegisterAgentProviderRuntimeOptions {
	replace?: boolean;
}

const agentProviderRuntimeFactories = new Map<
	string,
	AgentProviderRuntimeFactory
>();

interface CopilotCompletionToken {
	token: string;
	expiresAt: number;
}

interface CopilotTokenResponse {
	token?: string;
	expires_in?: number;
}

const copilotTokenCache = new Map<string, CopilotCompletionToken>();
const CLAUDE_CODE_HEADER =
	"You are Claude Code, Anthropic's official CLI for Claude.";
const CLAUDE_CODE_OAUTH_BETA_HEADERS = [
	"oauth-2025-04-20",
	"claude-code-20250219",
	"interleaved-thinking-2025-05-14",
	"fine-grained-tool-streaming-2025-05-14",
].join(",");

function accessTokenFromRuntimeConfig(
	config: AgentProviderRuntimeConfig,
): string {
	if (config.authContext?.kind === "oauth") {
		return config.authContext.token?.accessToken ?? "";
	}
	return config.oauthToken?.accessToken || config.apiKey || "";
}

async function getCopilotCompletionToken(
	githubAccessToken: string,
	fetchImpl: typeof globalThis.fetch,
): Promise<string> {
	const cached = copilotTokenCache.get(githubAccessToken);
	if (cached && cached.expiresAt > Date.now() + 60000) {
		return cached.token;
	}

	const response = await fetchImpl(
		"https://api.github.com/copilot_internal/v2/token",
		{
			method: "GET",
			headers: {
				Authorization: `Bearer ${githubAccessToken}`,
				Accept: "application/json",
				"User-Agent": "onething/1.0",
				"Editor-Version": "vscode/1.85.1",
				"Editor-Plugin-Version": "copilot-chat/0.29.1",
			},
		},
	);

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Failed to get Copilot token: ${response.status} ${text}`);
	}

	const data = (await response.json()) as CopilotTokenResponse;
	if (!data.token) {
		throw new Error(
			"Failed to get Copilot token: response did not include a token",
		);
	}

	copilotTokenCache.set(githubAccessToken, {
		token: data.token,
		expiresAt: Date.now() + (data.expires_in ?? 1800) * 1000,
	});
	return data.token;
}

export function registerAgentProviderRuntime(
	providerId: string,
	factory: AgentProviderRuntimeFactory,
	options: RegisterAgentProviderRuntimeOptions = {},
): () => void {
	if (!options.replace && agentProviderRuntimeFactories.has(providerId)) {
		throw new Error(`Agent provider runtime already registered: ${providerId}`);
	}

	agentProviderRuntimeFactories.set(providerId, factory);
	return () => {
		if (agentProviderRuntimeFactories.get(providerId) === factory) {
			agentProviderRuntimeFactories.delete(providerId);
		}
	};
}

export function getSupportedAgentProviderRuntimeIds(): string[] {
	return [...agentProviderRuntimeFactories.keys()];
}

export function isAgentProviderRuntimeSupported(providerId: string): boolean {
	return (
		agentProviderRuntimeFactories.has(providerId) ||
		isCustomAgentProviderRuntime(providerId)
	);
}

export function createAgentProviderFromRuntime(
	providerId: string,
	config: AgentProviderRuntimeConfig,
	options: CreateAgentProviderFromRuntimeOptions = {},
): AgentProvider | undefined {
	const provider =
		agentProviderRuntimeFactories.get(providerId)?.(config, options) ??
		createCustomAgentProviderFromRuntime(providerId, config, options);
	if (!provider) return undefined;
	// Capabilities that the provider declares as its own bypass the ledger
	// overlay entirely. Asking the provider beats keeping a list of provider ids
	// here: connecting another external agent used to mean editing this line.
	if (provider.capabilitiesAreSelfDeclared) return provider;
	return withPerModelCapabilities(provider, providerId, config);
}

/**
 * Per-model capability resolution: the provider's own capabilities describe
 * its transport (modalities, structured tool results); the capability ledger
 * answers the per-model booleans (reasoning/vision/tools/image output) so a
 * multi-model provider (copilot, openrouter) stops inheriting whatever the
 * session's initial model could do. The base capabilities stay as the shape
 * template; ledger verdicts flip the flags and their capability tags.
 */
function withPerModelCapabilities(
	provider: AgentProvider,
	providerId: string,
	config: AgentProviderRuntimeConfig,
): AgentProvider {
	const resolveBase = async (model: string): Promise<AgentModelCapabilities> =>
		(await provider.getModelCapabilities?.(model)) ??
		provider.capabilities ?? {
			capabilities: ["text-input", "text-output"],
			inputModalities: ["text"],
			outputModalities: ["text"],
		};

	return {
		...provider,
		getModelCapabilities: async (model: string) => {
			const base = await resolveBase(model);
			const resolved = resolveOnethingModelCapabilities({
				providerId,
				modelId: model,
				customApiType: config.apiType,
				override: config.modelCapabilitiesByModel?.[model],
				registryEntry: config.models?.[model],
			});
			const limits = config.models?.[model];

			const capabilities = new Set<AgentCapability>(base.capabilities);
			const inputModalities = new Set(base.inputModalities);
			const outputModalities = new Set(base.outputModalities);

			// A 'default' verdict means the ledger has no knowledge — the
			// provider's own declaration stands untouched. Anything stronger
			// (override, registry, pattern) wins over the snapshot.
			const ledgerKnows = (capability: keyof typeof resolved.source): boolean =>
				resolved.source[capability] !== "default";
			const setTags = (enabled: boolean, tags: AgentCapability[]): void => {
				for (const tag of tags) {
					if (enabled) capabilities.add(tag);
					else capabilities.delete(tag);
				}
			};

			const reasoning = ledgerKnows("reasoning")
				? resolved.reasoning
				: base.supportsReasoning === true || base.capabilities.includes("reasoning");
			const tools = ledgerKnows("tools")
				? resolved.tools
				: base.supportsTools !== false;
			if (ledgerKnows("reasoning")) setTags(reasoning, ["reasoning"]);
			if (ledgerKnows("tools")) setTags(tools, ["tool-calls", "structured-tool-results"]);
			if (ledgerKnows("vision")) {
				setTags(resolved.vision, ["vision-input", "file-input"]);
				if (resolved.vision) {
					inputModalities.add("image");
					inputModalities.add("file");
				} else {
					inputModalities.delete("image");
					inputModalities.delete("file");
				}
			}
			if (ledgerKnows("imageOutput")) {
				setTags(resolved.imageOutput, ["image-output"]);
				if (resolved.imageOutput) outputModalities.add("image");
				else outputModalities.delete("image");
			}

			return {
				...base,
				capabilities: [...capabilities],
				inputModalities: [...inputModalities],
				outputModalities: [...outputModalities],
				supportsTools: tools,
				supportsStructuredToolResults: tools
					? base.supportsStructuredToolResults !== false
					: false,
				supportsForcedToolUse: tools
					? base.supportsForcedToolUse === true
					: false,
				supportsReasoning: reasoning,
				maxInputTokens: positiveInteger(limits?.contextLength) ?? base.maxInputTokens,
				maxOutputTokens: positiveInteger(limits?.maxOutputTokens) ?? base.maxOutputTokens,
			};
		},
	};
}

function isCustomAgentProviderRuntime(providerId: string): boolean {
	return providerId.startsWith("custom-");
}

function runtimeCapabilityFlags(
	config: AgentProviderRuntimeConfig,
	defaults: {
		tools: boolean;
		vision: boolean;
		reasoning: boolean;
	},
) {
	const model = config.model;
	const override = model ? config.modelCapabilitiesByModel?.[model] : undefined;
	const metadata = model ? config.models?.[model] : undefined;

	return {
		tools: override?.tools ?? metadata?.supportsTools ?? defaults.tools,
		vision: override?.vision ?? metadata?.supportsVision ?? defaults.vision,
		reasoning:
			override?.reasoning ?? metadata?.supportsReasoning ?? defaults.reasoning,
	};
}

function capabilitiesFromFlags(flags: {
	tools: boolean;
	vision: boolean;
	reasoning: boolean;
}): AgentModelCapabilities {
	const capabilities: AgentCapability[] = [
		"text-input",
		"text-output",
		"streaming",
	];
	if (flags.tools) capabilities.push("tool-calls", "structured-tool-results");
	if (flags.vision) capabilities.push("vision-input", "file-input");
	if (flags.reasoning) capabilities.push("reasoning");

	return {
		capabilities,
		inputModalities: flags.vision ? ["text", "image", "file"] : ["text"],
		outputModalities: ["text"],
		toolResultModalities:
			flags.tools && flags.vision ? ["text", "image", "file"] : ["text"],
		supportsTools: flags.tools,
		supportsStructuredToolResults: flags.tools,
		supportsReasoning: flags.reasoning,
		supportsStreaming: true,
		// Every wire format behind this factory (OpenAI chat-completions,
		// Responses, Anthropic, Gemini) has a "must call a tool" mode, so a
		// model that has tools at all can be forced into one.
		supportsForcedToolUse: flags.tools,
	};
}

function positiveInteger(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: undefined;
}

function capabilityLimitsFromRuntimeConfig(
	config: AgentProviderRuntimeConfig,
): Pick<AgentModelCapabilities, "maxInputTokens" | "maxOutputTokens"> {
	const metadata = config.model ? config.models?.[config.model] : undefined;
	return {
		maxInputTokens: positiveInteger(metadata?.contextLength),
		maxOutputTokens: positiveInteger(metadata?.maxOutputTokens),
	};
}

function createCustomAgentProviderFromRuntime(
	providerId: string,
	config: AgentProviderRuntimeConfig,
	options: CreateAgentProviderFromRuntimeOptions,
): AgentProvider | undefined {
	if (!isCustomAgentProviderRuntime(providerId)) return undefined;

	if (config.apiType === "anthropic") {
		const capabilities = runtimeCapabilityFlags(config, {
			tools: true,
			vision: true,
			reasoning: true,
		});
		return createClaudeAgentProvider({
			providerId,
			apiKey: config.apiKey,
			baseUrl: config.baseUrl,
			fetchImpl: options.fetchImpl,
			requestDumper: resolveRequestDumper(options),
			capabilities: capabilitiesFromFlags(capabilities),
		});
	}

	const capabilities = runtimeCapabilityFlags(config, {
		tools: true,
		vision: true,
		reasoning: true,
	});

	return createOpenAICompatibleAgentProvider({
		providerId,
		apiKey: config.apiKey,
		baseUrl: config.baseUrl,
		defaultBaseUrl: "https://api.openai.com/v1",
		fetchImpl: options.fetchImpl,
		requestDumper: resolveRequestDumper(options),
		supportsVision: capabilities.vision,
		supportsReasoning: capabilities.reasoning,
		supportsTools: capabilities.tools,
		includeAssistantReasoning: capabilities.reasoning,
		reasoningStyle: "openai-effort",
	});
}

registerAgentProviderRuntime(
	"deepseek",
	(config, options) =>
		createDeepSeekAgentProvider({
			apiKey: config.apiKey ?? "",
			baseUrl: config.baseUrl,
			fetchImpl: options.fetchImpl,
			requestDumper: resolveRequestDumper(options),
			capabilities: {
				...capabilitiesFromFlags(
					runtimeCapabilityFlags(config, {
						tools: true,
						vision: false,
						reasoning: true,
					}),
				),
				...capabilityLimitsFromRuntimeConfig(config),
			},
		}),
	{ replace: true },
);

registerAgentProviderRuntime(
	"acp",
	(_config, options) => {
		if (!options.acpStreamPrompt) return undefined;

		return createACPAgentProvider({
			workingDirectory: options.workingDirectory,
			localSessionId: options.localSessionId,
			cwd: options.acpCwd,
			streamPrompt: options.acpStreamPrompt,
		});
	},
	{ replace: true },
);

registerAgentProviderRuntime(
	"claude-code-agent",
	(_config, options) => {
		const connector = options.externalAgentConnectors?.["claude-code-agent"];
		if (!connector) return undefined;

		return createExternalAgentProvider({
			providerId: "claude-code-agent",
			connector,
			localSessionId: options.localSessionId,
			workingDirectory: options.workingDirectory,
			resolveSessionLink: (localSessionId) =>
				options.resolveExternalAgentSessionLink?.(
					"claude-code-agent",
					localSessionId,
				),
			onSessionLink: options.onExternalAgentSessionLink,
		});
	},
	{ replace: true },
);

registerAgentProviderRuntime(
	"codex",
	(config, options) =>
		createCodexAgentProvider({
			apiKey: config.apiKey,
			baseUrl: config.baseUrl,
			oauthToken: config.oauthToken,
			authContext: config.authContext,
			fetchImpl: options.fetchImpl,
			requestDumper: resolveRequestDumper(options),
			refreshOAuthToken: options.refreshOAuthToken
				? forceRefresh => options.refreshOAuthToken!("codex", forceRefresh)
				: undefined,
		}),
	{ replace: true },
);

registerAgentProviderRuntime(
	"openai",
	(config, options) =>
		createOpenAICompatibleAgentProvider({
			providerId: "openai",
			apiKey: config.apiKey,
			baseUrl: config.baseUrl,
			defaultBaseUrl: "https://api.openai.com/v1",
			fetchImpl: options.fetchImpl,
			requestDumper: resolveRequestDumper(options),
			supportsVision: true,
			supportsReasoning: true,
			maxTokensField: "max_completion_tokens",
			reasoningStyle: "openai-effort",
		}),
	{ replace: true },
);

registerAgentProviderRuntime(
	"openrouter",
	(config, options) =>
		createOpenAICompatibleAgentProvider({
			providerId: "openrouter",
			apiKey: config.apiKey,
			baseUrl: config.baseUrl,
			defaultBaseUrl: "https://openrouter.ai/api/v1",
			fetchImpl: options.fetchImpl,
			requestDumper: resolveRequestDumper(options),
			supportsVision: true,
			supportsReasoning: true,
			reasoningStyle: "openrouter-reasoning",
		}),
	{ replace: true },
);

registerAgentProviderRuntime(
	"kimi",
	(config, options) =>
		createOpenAICompatibleAgentProvider({
			providerId: "kimi",
			apiKey: config.apiKey,
			// 开放平台(按量,国内/海外)与 Kimi Code(编程套餐)是三个地址、两种
			// 计费。选错不是报错而是**多扣钱**:订阅用户留着通用地址会照按量再计一次。
			baseUrl: resolveOnethingKimiBaseUrl({
				baseUrl: config.baseUrl,
				...readOnethingKimiOptions(config.providerOptions),
			}),
			defaultBaseUrl: ONETHING_KIMI_DEFAULT_BASE_URL,
			fetchImpl: options.fetchImpl,
			requestDumper: resolveRequestDumper(options),
			supportsReasoning: true,
			includeAssistantReasoning: true,
			reasoningStyle: "thinking-type",
		}),
	{ replace: true },
);

/**
 * Kimi Code(订阅)。与 `kimi` 同一套 OpenAI 兼容线材,差别只有两处:
 * 地址钉死在套餐 host(不吃地区/档位),凭证是 OAuth access_token
 * (klip-14:「OAuth 模型和 API 兼容性与当前 Bearer key 完全一致」)。
 * OAuth 凭证在 authContext 里,config.apiKey 对 OAuth provider 恒为空串 ——
 * 必须走 accessTokenFromRuntimeConfig,与 claude-code / grok-oauth 同一条路。
 */
registerAgentProviderRuntime(
	"kimi-code",
	(config, options) => {
		const accessToken = accessTokenFromRuntimeConfig(config);
		if (!accessToken) {
			throw new Error("Not logged in to Kimi Code. Please login first.");
		}
		return createOpenAICompatibleAgentProvider({
			providerId: "kimi-code",
			baseUrl: ONETHING_KIMI_CODING_PLAN_BASE_URL,
			defaultBaseUrl: ONETHING_KIMI_CODING_PLAN_BASE_URL,
			fetchImpl: options.fetchImpl,
			requestDumper: resolveRequestDumper(options),
			supportsReasoning: true,
			includeAssistantReasoning: true,
			reasoningStyle: "thinking-type",
			resolveAuth: async () => ({ apiKey: accessToken }),
		});
	},
	{ replace: true },
);

registerAgentProviderRuntime(
	"zhipu",
	(config, options) =>
		createOpenAICompatibleAgentProvider({
			providerId: "zhipu",
			apiKey: config.apiKey,
			baseUrl: resolveOnethingZhipuBaseUrl({
				baseUrl: config.baseUrl,
				...readOnethingZhipuOptions(config.providerOptions),
			}),
			defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
			fetchImpl: options.fetchImpl,
			requestDumper: resolveRequestDumper(options),
			supportsReasoning: true,
			includeAssistantReasoning: true,
			reasoningStyle: "zhipu-thinking",
		}),
	{ replace: true },
);

registerAgentProviderRuntime(
	"qwen",
	(config, options) =>
		createOpenAICompatibleAgentProvider({
			providerId: "qwen",
			apiKey: config.apiKey,
			baseUrl: resolveOnethingQwenBaseUrl({
				baseUrl: config.baseUrl,
				...readOnethingQwenOptions(config.providerOptions),
			}),
			defaultBaseUrl: ONETHING_QWEN_DEFAULT_BASE_URL,
			fetchImpl: options.fetchImpl,
			requestDumper: resolveRequestDumper(options),
			supportsVision: true,
			supportsReasoning: true,
			// qwen3.8-max runs preserve_thinking by default and rejects history
			// whose reasoning_content was dropped — echo it back verbatim.
			includeAssistantReasoning: true,
			reasoningStyle: "qwen-thinking",
		}),
	{ replace: true },
);

registerAgentProviderRuntime(
	"grok",
	(config, options) =>
		createOpenAICompatibleAgentProvider({
			providerId: "grok",
			apiKey: config.apiKey,
			baseUrl: config.baseUrl,
			defaultBaseUrl: "https://api.x.ai/v1",
			fetchImpl: options.fetchImpl,
			requestDumper: resolveRequestDumper(options),
			supportsVision: true,
			supportsReasoning: true,
			includeAssistantReasoning: true,
			reasoningStyle: "grok-effort",
		}),
	{ replace: true },
);

registerAgentProviderRuntime(
	"grok-oauth",
	(config, options) => {
		const accessToken = accessTokenFromRuntimeConfig(config);
		if (!accessToken) {
			throw new Error("Not logged in to Grok. Please login first.");
		}
		return createOpenAICompatibleAgentProvider({
			providerId: "grok-oauth",
			baseUrl: config.baseUrl,
			defaultBaseUrl: "https://api.x.ai/v1",
			fetchImpl: options.fetchImpl,
			requestDumper: resolveRequestDumper(options),
			supportsVision: true,
			supportsReasoning: true,
			includeAssistantReasoning: true,
			reasoningStyle: "grok-effort",
			resolveAuth: async () => ({ apiKey: accessToken }),
		});
	},
	{ replace: true },
);

registerAgentProviderRuntime(
	"github-copilot",
	(config, options) => {
		const githubAccessToken = accessTokenFromRuntimeConfig(config);
		if (!githubAccessToken) {
			throw new Error("Not logged in to GitHub Copilot. Please login first.");
		}
		const fetchImpl = options.fetchImpl ?? globalThis.fetch;
		return createOpenAICompatibleAgentProvider({
			providerId: "github-copilot",
			baseUrl: config.baseUrl,
			defaultBaseUrl: "https://api.individual.githubcopilot.com",
			fetchImpl,
			requestDumper: resolveRequestDumper(options),
			headers: {
				"Editor-Version": "vscode/1.85.1",
				"Editor-Plugin-Version": "copilot-chat/0.29.1",
				"Copilot-Integration-Id": "vscode-chat",
				"User-Agent": "onething/1.0",
				"OpenAI-Intent": "conversation-panel",
			},
			resolveAuth: async () => ({
				apiKey: await getCopilotCompletionToken(githubAccessToken, fetchImpl),
			}),
			supportsVision: true,
			supportsReasoning: true,
			supportsTools: true,
		});
	},
	{ replace: true },
);

registerAgentProviderRuntime(
	"claude",
	(config, options) =>
		createClaudeAgentProvider({
			apiKey: config.apiKey,
			baseUrl: config.baseUrl,
			fetchImpl: options.fetchImpl,
			requestDumper: resolveRequestDumper(options),
			promptCaching: true,
		}),
	{ replace: true },
);

registerAgentProviderRuntime(
	"claude-code",
	(config, options) => {
		const accessToken = accessTokenFromRuntimeConfig(config);
		if (!accessToken) {
			throw new Error("Not logged in to Claude Code. Please login first.");
		}
		return createClaudeAgentProvider({
			providerId: "claude-code",
			baseUrl: config.baseUrl,
			fetchImpl: options.fetchImpl,
			requestDumper: resolveRequestDumper(options),
			omitApiKeyHeader: true,
			systemHeader: CLAUDE_CODE_HEADER,
			promptCaching: true,
			headers: {
				authorization: `Bearer ${accessToken}`,
				"anthropic-beta": CLAUDE_CODE_OAUTH_BETA_HEADERS,
			},
		});
	},
	{ replace: true },
);

registerAgentProviderRuntime(
	"gemini",
	(config, options) =>
		createGeminiAgentProvider({
			apiKey: config.apiKey,
			baseUrl: config.baseUrl,
			fetchImpl: options.fetchImpl,
			requestDumper: resolveRequestDumper(options),
		}),
	{ replace: true },
);
