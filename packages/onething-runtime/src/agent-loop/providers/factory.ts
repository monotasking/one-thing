import type { AgentProvider } from "@onething/core/agent-loop";
import {
	BaseAgentProvider,
	BearerApiKeyAuth,
	LedgerModelProfileResolver,
	ResolveAuth,
	getDialect,
	listDialects,
	withLedgerModelCapabilities,
	type Dialect,
	type ModelProfileResolver,
} from "./base/index.js";
import {
	CLAUDE_CODE_DIALECT,
	CLAUDE_CODE_OAUTH_BETA_HEADERS,
	CLAUDE_DIALECT,
	CODEX_DIALECT,
	CUSTOM_ANTHROPIC_DIALECT,
	CUSTOM_OPENAI_DIALECT,
	DEEPSEEK_DIALECT,
	GEMINI_DIALECT,
	GITHUB_COPILOT_DIALECT,
	GROK_DIALECT,
	GROK_OAUTH_DIALECT,
	KIMI_CODE_DIALECT,
	KIMI_DIALECT,
	OPENAI_DIALECT,
	OPENROUTER_DIALECT,
	QWEN_DIALECT,
	ZHIPU_DIALECT,
	anthropicAuth,
	codexAuth,
	createAnthropicProvider,
	createGeminiProvider,
	createResponsesProvider,
	geminiAuth,
	capabilitiesFromFlags,
	capabilityLimitsFromRuntimeConfig,
	createOpenAIChatProvider,
	openAIChatTransportCapabilities,
	runtimeCapabilityFlags,
} from "./dialects/index.js";
import type { ProviderMediaReader } from "./base/index.js";
import { OpenAIChatPartCodec } from "./wires/index.js";
import type { AnthropicDialect, GeminiDialect, OpenAIChatDialect, ResponsesDialect } from "./wires/index.js";
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
	resolveOnethingKimiBaseUrl,
} from "../../providers/kimi.js";
import { resolveOnethingZhipuBaseUrl } from "../../providers/zhipu.js";
import { resolveOnethingQwenBaseUrl } from "../../providers/qwen.js";
import {
	readOnethingKimiOptions,
	readOnethingQwenOptions,
	readOnethingZhipuOptions,
	type OnethingProviderOptions,
} from "../../providers/provider-options.js";

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
	/**
	 * `custom-*` 专用:直接点名一份已登记的方言配方(`openrouter` / `zhipu` /
	 * `gemini` …),于是自建端点能拿到那一家的 usage 表、线型、`maxTokensField`
	 * 与端点形状,只把地址与凭据换成自己的。不给 = 按 `apiType` 走
	 * `custom-openai` / `custom-anthropic` 两份通用配方(今天的行为)。
	 * 认不出的 id 是**明确错误**,不静默回退。
	 */
	dialect?: string;
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
			fileInput?: boolean;
		}
	>;
	/**
	 * 运行时传进来的就是完整的 `OnethingModelCapabilityEntry`;这里只列账本
	 * (`ModelProfile` → `resolveOnethingModelCapabilities`)真正会读的字段。
	 */
	models?: Record<
		string,
		{
			supportsTools?: boolean;
			supportsVision?: boolean;
			supportsReasoning?: boolean;
			supportsImageOutput?: boolean;
			supportsTemperature?: boolean;
			/** 目录自己的输入模态表 —— `fileInput` 的证据(P4-1)。 */
			inputModalities?: string[];
			providerMetadata?: unknown;
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
	/**
	 * 只读媒体端口(P4-2)。Gemini 的多轮改图要把历史 assistant 消息里画过的图
	 * 从媒体库取回来放进请求 —— 消息上留下的只有一段 markdown,字节在库里。
	 * runtime 只声明接口(`base/provider-context.ts` 的 `ProviderMediaReader`),
	 * 实现由装配层注入;不给 = 不回放。
	 */
	media?: ProviderMediaReader;
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

/**
 * 账本解析器 —— 每个 provider 构造时都拿到它,`ModelProfile` 从此是能力的
 * **唯一**来源(设计稿 §2.2,P2-a)。
 *
 * **故意不传 `model`**:`defaultProfile()` 给不出默认档,于是静态
 * `capabilities` 字段仍是纯传输声明(今天的行为,`provider-factory.test` 的
 * `custom-*` 三条与 deepseek 的 `maxInputTokens` 都钉着它)。把静态字段也改成
 * 「默认模型的投影」是可感知的行为变化,要另拍。
 */
function ledgerProfiles(
	config: AgentProviderRuntimeConfig,
): ModelProfileResolver {
	return new LedgerModelProfileResolver({
		...(config.apiType ? { apiType: config.apiType } : {}),
		...(config.modelCapabilitiesByModel
			? { modelCapabilitiesByModel: config.modelCapabilitiesByModel }
			: {}),
		...(config.models ? { models: config.models } : {}),
	});
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
	// entirely. Asking the provider beats keeping a list of provider ids here:
	// connecting another external agent used to mean editing this line.
	if (provider.capabilitiesAreSelfDeclared) return provider;
	// 自家的 provider 都是 `BaseAgentProvider` 的子类,构造时已经拿到账本解析器
	// —— `getModelCapabilities()` 自己就问 `ModelProfile`,外面不需要再盖一层
	// (P2-a:`withPerModelCapabilities` 退役)。
	if (provider instanceof BaseAgentProvider) return provider;
	// 剩下的是**外来** provider:宿主经 `registerAgentProviderRuntime()` 登记的
	// 普通对象,没有那条路。给它补上的是**同一个**投影函数,不是第二份逻辑。
	return withLedgerModelCapabilities(provider, providerId, ledgerProfiles(config));
}

/**
 * `custom-*` 的四条线材出口 —— 一份已登记的配方 + 用户自己的地址与凭据。
 *
 * 基类不许对方言字段做字符串分支(架构门),但这里是**工厂**:把一个配方
 * 交给它那条线协议的构造函数,正是「谁认识 wire」这件事该发生的地方。
 */
function createProviderForDialect(
	dialect: Dialect,
	providerId: string,
	config: AgentProviderRuntimeConfig,
	options: CreateAgentProviderFromRuntimeOptions,
): AgentProvider {
	const shared = {
		providerId,
		baseUrl: config.baseUrl,
		fetchImpl: options.fetchImpl,
		requestDumper: resolveRequestDumper(options),
		profiles: ledgerProfiles(config),
	};
	switch (dialect.wire) {
		case "anthropic-messages":
			return createAnthropicProvider(dialect as AnthropicDialect, {
				...shared,
				auth: anthropicAuth({ apiKey: config.apiKey }),
			});
		case "gemini-generateContent":
			return createGeminiProvider(dialect as GeminiDialect, {
				...shared,
				auth: geminiAuth({ apiKey: config.apiKey }),
				// 多轮改图的只读媒体端口(P4-2)—— 只有这条线读它。
				media: options.media,
			});
		case "openai-responses":
			return createResponsesProvider(dialect as ResponsesDialect, {
				...shared,
				auth: codexAuth({ apiKey: config.apiKey }),
			});
		case "openai-chat":
			return createOpenAIChatProvider(dialect as OpenAIChatDialect, {
				...shared,
				auth: new BearerApiKeyAuth(config.apiKey),
			});
	}
}

function isCustomAgentProviderRuntime(providerId: string): boolean {
	return providerId.startsWith("custom-");
}

function createCustomAgentProviderFromRuntime(
	providerId: string,
	config: AgentProviderRuntimeConfig,
	options: CreateAgentProviderFromRuntimeOptions,
): AgentProvider | undefined {
	if (!isCustomAgentProviderRuntime(providerId)) return undefined;

	// 点名了配方就用那一家的整套线材(usage 表 / 线型 / maxTokensField /
	// 端点形状 / 传输声明),只换地址与凭据。认不出 = 明确错误:静默退回
	// custom-openai 会让请求体悄悄变成另一家的形状。
	if (config.dialect) {
		const dialect = getDialect(config.dialect);
		if (!dialect) {
			throw new Error(
				`Unknown provider dialect: ${config.dialect}. Registered: ${listDialects()
					.map((entry) => entry.id)
					.sort()
					.join(", ")}`,
			);
		}
		return createProviderForDialect(dialect, providerId, config, options);
	}

	const capabilities = runtimeCapabilityFlags(config, {
		tools: true,
		vision: true,
		reasoning: true,
	});

	if (config.apiType === "anthropic") {
		return createAnthropicProvider(CUSTOM_ANTHROPIC_DIALECT, {
			providerId,
			baseUrl: config.baseUrl,
			auth: anthropicAuth({ apiKey: config.apiKey }),
			fetchImpl: options.fetchImpl,
			requestDumper: resolveRequestDumper(options),
			// anthropic 线真发得出 `document` 块 —— 文件输入这一半由线路认领
			// (P4-1,拍板 #12);另一半(模型收不收)由账本的 `fileInput` 判。
			transport: capabilitiesFromFlags({ ...capabilities, file: true }),
			profiles: ledgerProfiles(config),
		});
	}

	return createOpenAIChatProvider(CUSTOM_OPENAI_DIALECT, {
		providerId,
		baseUrl: config.baseUrl,
		auth: new BearerApiKeyAuth(config.apiKey),
		fetchImpl: options.fetchImpl,
		requestDumper: resolveRequestDumper(options),
		transport: openAIChatTransportCapabilities(capabilities),
		parts: new OpenAIChatPartCodec({
			includeAssistantReasoning: capabilities.reasoning,
		}),
		profiles: ledgerProfiles(config),
	});
}

registerAgentProviderRuntime(
	"deepseek",
	(config, options) =>
		createOpenAIChatProvider(DEEPSEEK_DIALECT, {
			baseUrl: config.baseUrl,
			auth: new BearerApiKeyAuth(config.apiKey ?? ""),
			fetchImpl: options.fetchImpl,
			requestDumper: resolveRequestDumper(options),
			profiles: ledgerProfiles(config),
			transport: {
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
		createResponsesProvider(CODEX_DIALECT, {
			baseUrl: config.baseUrl,
			auth: codexAuth({
				apiKey: config.apiKey,
				oauthToken: config.oauthToken,
				authContext: config.authContext,
				refreshOAuthToken: options.refreshOAuthToken
					? forceRefresh => options.refreshOAuthToken!("codex", forceRefresh)
					: undefined,
			}),
			fetchImpl: options.fetchImpl,
			requestDumper: resolveRequestDumper(options),
			profiles: ledgerProfiles(config),
		}),
	{ replace: true },
);

registerAgentProviderRuntime(
	"openai",
	(config, options) =>
		createOpenAIChatProvider(OPENAI_DIALECT, {
			baseUrl: config.baseUrl,
			auth: new BearerApiKeyAuth(config.apiKey),
			fetchImpl: options.fetchImpl,
			requestDumper: resolveRequestDumper(options),
			profiles: ledgerProfiles(config),
		}),
	{ replace: true },
);

registerAgentProviderRuntime(
	"openrouter",
	(config, options) =>
		createOpenAIChatProvider(OPENROUTER_DIALECT, {
			baseUrl: config.baseUrl,
			auth: new BearerApiKeyAuth(config.apiKey),
			fetchImpl: options.fetchImpl,
			requestDumper: resolveRequestDumper(options),
			profiles: ledgerProfiles(config),
		}),
	{ replace: true },
);

registerAgentProviderRuntime(
	"kimi",
	(config, options) =>
		createOpenAIChatProvider(KIMI_DIALECT, {
			// 开放平台(按量,国内/海外)与 Kimi Code(编程套餐)是三个地址、两种
			// 计费。选错不是报错而是**多扣钱**:订阅用户留着通用地址会照按量再计一次。
			baseUrl: resolveOnethingKimiBaseUrl({
				baseUrl: config.baseUrl,
				...readOnethingKimiOptions(config.providerOptions),
			}),
			auth: new BearerApiKeyAuth(config.apiKey),
			fetchImpl: options.fetchImpl,
			requestDumper: resolveRequestDumper(options),
			profiles: ledgerProfiles(config),
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
		return createOpenAIChatProvider(KIMI_CODE_DIALECT, {
			baseUrl: ONETHING_KIMI_CODING_PLAN_BASE_URL,
			auth: new BearerApiKeyAuth(accessToken),
			fetchImpl: options.fetchImpl,
			requestDumper: resolveRequestDumper(options),
			profiles: ledgerProfiles(config),
		});
	},
	{ replace: true },
);

registerAgentProviderRuntime(
	"zhipu",
	(config, options) =>
		createOpenAIChatProvider(ZHIPU_DIALECT, {
			baseUrl: resolveOnethingZhipuBaseUrl({
				baseUrl: config.baseUrl,
				...readOnethingZhipuOptions(config.providerOptions),
			}),
			auth: new BearerApiKeyAuth(config.apiKey),
			fetchImpl: options.fetchImpl,
			requestDumper: resolveRequestDumper(options),
			profiles: ledgerProfiles(config),
		}),
	{ replace: true },
);

registerAgentProviderRuntime(
	"qwen",
	(config, options) =>
		createOpenAIChatProvider(QWEN_DIALECT, {
			baseUrl: resolveOnethingQwenBaseUrl({
				baseUrl: config.baseUrl,
				...readOnethingQwenOptions(config.providerOptions),
			}),
			auth: new BearerApiKeyAuth(config.apiKey),
			fetchImpl: options.fetchImpl,
			requestDumper: resolveRequestDumper(options),
			profiles: ledgerProfiles(config),
		}),
	{ replace: true },
);

// xAI 的两条通路 P4-4 起走 **openai-responses**(`POST /v1/responses`);
// chat-completions 被官方标成 legacy,而加密思维链回放 / `input_file` /
// 结构化引文只在 Responses 上有出口。凭据形状一个字没变。
registerAgentProviderRuntime(
	"grok",
	(config, options) =>
		createResponsesProvider(GROK_DIALECT, {
			baseUrl: config.baseUrl,
			auth: new BearerApiKeyAuth(config.apiKey),
			fetchImpl: options.fetchImpl,
			requestDumper: resolveRequestDumper(options),
			profiles: ledgerProfiles(config),
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
		return createResponsesProvider(GROK_OAUTH_DIALECT, {
			baseUrl: config.baseUrl,
			auth: new BearerApiKeyAuth(accessToken),
			fetchImpl: options.fetchImpl,
			requestDumper: resolveRequestDumper(options),
			profiles: ledgerProfiles(config),
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
		return createOpenAIChatProvider(GITHUB_COPILOT_DIALECT, {
			baseUrl: config.baseUrl,
			fetchImpl,
			requestDumper: resolveRequestDumper(options),
			profiles: ledgerProfiles(config),
			auth: new ResolveAuth(
				async () => ({
					apiKey: await getCopilotCompletionToken(githubAccessToken, fetchImpl),
				}),
				{
					headers: {
						"Editor-Version": "vscode/1.85.1",
						"Editor-Plugin-Version": "copilot-chat/0.29.1",
						"Copilot-Integration-Id": "vscode-chat",
						"User-Agent": "onething/1.0",
						"OpenAI-Intent": "conversation-panel",
					},
				},
			),
		});
	},
	{ replace: true },
);

registerAgentProviderRuntime(
	"claude",
	(config, options) =>
		createAnthropicProvider(CLAUDE_DIALECT, {
			baseUrl: config.baseUrl,
			auth: anthropicAuth({ apiKey: config.apiKey }),
			fetchImpl: options.fetchImpl,
			requestDumper: resolveRequestDumper(options),
			profiles: ledgerProfiles(config),
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
		return createAnthropicProvider(CLAUDE_CODE_DIALECT, {
			baseUrl: config.baseUrl,
			auth: anthropicAuth({
				omitApiKeyHeader: true,
				headers: {
					authorization: `Bearer ${accessToken}`,
					"anthropic-beta": CLAUDE_CODE_OAUTH_BETA_HEADERS,
				},
			}),
			fetchImpl: options.fetchImpl,
			requestDumper: resolveRequestDumper(options),
			profiles: ledgerProfiles(config),
		});
	},
	{ replace: true },
);

registerAgentProviderRuntime(
	"gemini",
	(config, options) =>
		createGeminiProvider(GEMINI_DIALECT, {
			baseUrl: config.baseUrl,
			auth: geminiAuth({ apiKey: config.apiKey }),
			fetchImpl: options.fetchImpl,
			requestDumper: resolveRequestDumper(options),
			profiles: ledgerProfiles(config),
			media: options.media,
		}),
	{ replace: true },
);
