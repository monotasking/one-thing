import type { AgentProvider } from "@onething/backend/core/agent-loop";
import type { OnethingCapabilityOverrideLike } from "../../providers/model-capability.js";
import {
	BaseAgentProvider,
	BearerApiKeyAuth,
	expandHeaderTemplates,
	LedgerModelProfileResolver,
	getDialect,
	listDialects,
	withLedgerModelCapabilities,
	type Dialect,
	type ModelProfileResolver,
} from "./base/index.js";
import {
	CUSTOM_ANTHROPIC_DIALECT,
	CUSTOM_OPENAI_DIALECT,
	anthropicAuth,
	codexAuth,
	createAnthropicProvider,
	createGeminiProvider,
	createResponsesProvider,
	geminiAuth,
	capabilitiesFromFlags,
	createOpenAIChatProvider,
	openAIChatTransportCapabilities,
	runtimeCapabilityFlags,
} from "./dialects/index.js";
import type { ProviderMediaReader } from "./base/index.js";
import { OpenAIChatPartCodec } from "./wires/index.js";
import type { AnthropicDialect, GeminiDialect, OpenAIChatDialect, ResponsesDialect } from "./wires/index.js";
import type { AgentProviderRequestDumper } from "./request-dump.js";
import { createExternalAgentProvider } from "../../external-agents/provider.js";
import { VENDOR_RUNTIMES, type VendorRuntimeKit } from "../../providers/vendors/runtimes.js";
import type {
	ExternalAgentConnector,
	ExternalAgentSessionLink,
} from "../../external-agents/types.js";
import {
	EXTERNAL_AGENT_DIALECT_ID,
	getProviderManifest,
	isCustomAdapterDialectOf,
} from "../../providers/manifest.js";
import type { OnethingProviderOptions } from "../../providers/provider-options.js";

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
	 * 自定义服务商:直接点名一份已登记的方言配方(`openrouter` / `zhipu` /
	 * `gemini` …),于是自建端点能拿到那一家的 usage 表、线型、`maxTokensField`
	 * 与端点形状,只把地址与凭据换成自己的。不给 = 读 manifest 的 `dialect`(由
	 * `apiType` 映射成 `custom-openai` / `custom-anthropic`,今天的行为)。
	 * 认不出的 id 是**明确错误**,不静默回退。批 M 起 core 的复制表抄这一格,它才真生效。
	 */
	dialect?: string;
	/**
	 * 每个请求都带的头(批 M §5.3)。值里的 `{{apiKey}}` 发送时换成当前凭证;有
	 * `Authorization` 头时不再加默认 Bearer。今天只有自定义服务商的工厂读它。
	 */
	headers?: Record<string, string>;
	/** 模型列表地址(批 M §5.3)。这一批只贯通类型,拉取由批 3 做。 */
	modelsUrl?: string;
	oauthToken?: AgentProviderRuntimeOAuthToken;
	authContext?: AgentProviderRuntimeAuthContext;
	/**
	 * per-space 凭证标记(批 B6),原样透传、这一层不解释。宿主的
	 * `refreshOAuthToken` 靠它知道「回合中途刷新出来的 token 该写回哪个空间的
	 * 哪条 entry」—— 刷新发生在 provider 内部,那里早就没有 sessionId 了。
	 */
	spaceCredential?: { spaceId?: string; entryId?: string; authType?: string };
  modelCapabilitiesByModel?: Record<string, OnethingCapabilityOverrideLike>;
	/**
	 * 运行时传进来的就是完整的 `OnethingModelCapabilityEntry`;这里只列账本
	 * (`ModelProfile` → `resolveOnethingModelCapabilities`)真正会读的字段。
	 */
	models?: Record<
		string,
		{
			/**
			 * 目录条目出处(批 2)。`'manual'` = 手填,**一格参数都没有**;读的人
			 * 一律当「目录里没有这一型」(`catalogEntryFacts`)。
			 */
			source?: string;
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
			/** 接口没报的那几项(批 3):在表里 = 不知道,账本不读那个 `false`。 */
			unreported?: readonly string[];
		}
	>;
}

export interface CreateAgentProviderFromRuntimeOptions {
  executionContext?: unknown;
	workingDirectory?: string;
	localSessionId?: string;
	fetchImpl?: typeof globalThis.fetch;
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

function accessTokenFromRuntimeConfig(
	config: AgentProviderRuntimeConfig,
): string {
	if (config.authContext?.kind === "oauth") {
		return config.authContext.token?.accessToken ?? "";
	}
	return config.oauthToken?.accessToken || config.apiKey || "";
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
		isManifestAgentProviderRuntime(providerId)
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
    ...(config.providerOptions ? { providerOptions: config.providerOptions } : {}),
	});
}

export function createAgentProviderFromRuntime(
	providerId: string,
	config: AgentProviderRuntimeConfig,
	options: CreateAgentProviderFromRuntimeOptions = {},
): AgentProvider | undefined {
	const provider =
		agentProviderRuntimeFactories.get(providerId)?.(config, options) ??
		createManifestAgentProviderFromRuntime(providerId, config, options);
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
	headers?: Record<string, string>,
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
				auth: anthropicAuth({ apiKey: config.apiKey, ...(headers ? { headers } : {}) }),
			});
		case "gemini-generateContent":
			return createGeminiProvider(dialect as GeminiDialect, {
				...shared,
				auth: geminiAuth({ apiKey: config.apiKey, ...(headers ? { headers } : {}) }),
				// 多轮改图的只读媒体端口(P4-2)—— 只有这条线读它。
				media: options.media,
			});
		case "openai-responses":
			return createResponsesProvider(dialect as ResponsesDialect, {
				...shared,
				// 带自定义头时走普通 Bearer(头能让位);不带时保持今天的凭据解析。
				auth: headers
					? new BearerApiKeyAuth(config.apiKey, { headers })
					: codexAuth({ apiKey: config.apiKey }),
			});
		case "openai-chat":
			return createOpenAIChatProvider(dialect as OpenAIChatDialect, {
				...shared,
				auth: new BearerApiKeyAuth(config.apiKey, headers ? { headers } : {}),
			});
	}
}

/**
 * 没有专属工厂、但在 manifest 注册表里自述了线协议方言的一家 —— 自定义服务商,以及
 * 「只要一份已登记方言就够」的内置家(批 M §5.6:加一家 = 一个 manifest 字面量)。
 * 不再看 id 前缀;外部执行体没有线协议,不走这里。
 */
function isManifestAgentProviderRuntime(providerId: string): boolean {
	const manifest = getProviderManifest(providerId);
	return Boolean(manifest && manifest.dialect !== EXTERNAL_AGENT_DIALECT_ID);
}

/**
 * 适配表编译出来的方言(批 4 §7.2)。openai-chat / anthropic 两条与两份通用配方同一套
 * 构造(传输声明随这一家的能力旋钮),只是配方换成编译结果;另两条走通用出口。
 */
function createAdapterProvider(
	dialect: Dialect,
	providerId: string,
	config: AgentProviderRuntimeConfig,
	options: CreateAgentProviderFromRuntimeOptions,
	headers: Record<string, string> | undefined,
): AgentProvider {
	const capabilities = runtimeCapabilityFlags(config, {
		tools: true,
		vision: true,
		reasoning: true,
	});
	switch (dialect.wire) {
		case "openai-chat": {
			const codec = dialect.parts;
			return createOpenAIChatProvider(dialect as OpenAIChatDialect, {
				providerId,
				baseUrl: config.baseUrl,
				auth: new BearerApiKeyAuth(config.apiKey, headers ? { headers } : {}),
				fetchImpl: options.fetchImpl,
				requestDumper: resolveRequestDumper(options),
				transport: openAIChatTransportCapabilities(capabilities),
				parts: new OpenAIChatPartCodec({
					includeAssistantReasoning: capabilities.reasoning,
					...(codec?.decodeExtras ? { decodeExtras: codec.decodeExtras.bind(codec) } : {}),
				}),
				profiles: ledgerProfiles(config),
			});
		}
		case "anthropic-messages":
			return createAnthropicProvider(dialect as AnthropicDialect, {
				providerId,
				baseUrl: config.baseUrl,
				auth: anthropicAuth({ apiKey: config.apiKey, ...(headers ? { headers } : {}) }),
				fetchImpl: options.fetchImpl,
				requestDumper: resolveRequestDumper(options),
				transport: capabilitiesFromFlags({ ...capabilities, file: true }),
				profiles: ledgerProfiles(config),
			});
		default:
			return createProviderForDialect(dialect, providerId, config, options, headers);
	}
}

function createManifestAgentProviderFromRuntime(
	providerId: string,
	rawConfig: AgentProviderRuntimeConfig,
	options: CreateAgentProviderFromRuntimeOptions,
): AgentProvider | undefined {
	if (!isManifestAgentProviderRuntime(providerId)) return undefined;
	// 地址:配置里的优先,其次 manifest 自述的缺省(内置家不一定把缺省地址写进设置)。
	const defaultBaseUrl = getProviderManifest(providerId)?.defaultBaseUrl;
	const config =
		rawConfig.baseUrl || !defaultBaseUrl ? rawConfig : { ...rawConfig, baseUrl: defaultBaseUrl };

	const headers = expandHeaderTemplates(config.headers, config.apiKey);

	// 批 4:这一家有一张生效的适配表(manifest 指着它编译出来的 `custom:<id>`)。它是在
	// 「接口类型」那份配方之上编译的,所以优先于 `config.dialect`;没有适配表的家走下面的老路,
	// 一个字节不变(`__tests__/golden` 钉死)。
	const manifestDialectId = getProviderManifest(providerId)?.dialect;
	const adapterDialect = isCustomAdapterDialectOf(providerId, manifestDialectId)
		? getDialect(manifestDialectId!)
		: undefined;
	if (adapterDialect) {
		return createAdapterProvider(adapterDialect, providerId, config, options, headers);
	}

	// 方言:配置点名的优先(`dialect`,或老形状的 `apiType` —— 它就是只有两档的方言),
	// 其次 manifest 自述的(设置里那条自定义服务商映射来的)。
	const dialectId =
		config.dialect ||
		(config.apiType === "anthropic"
			? CUSTOM_ANTHROPIC_DIALECT.id
			: config.apiType === "openai"
				? CUSTOM_OPENAI_DIALECT.id
				: getProviderManifest(providerId)?.dialect);

	// 点名了别家的配方就用那一家的整套线材(usage 表 / 线型 / maxTokensField /
	// 端点形状 / 传输声明),只换地址与凭据。认不出 = 明确错误:静默退回
	// custom-openai 会让请求体悄悄变成另一家的形状。两份通用配方走下面那条
	// 带自定义传输声明的老路(今天的行为)。
	if (
		dialectId &&
		dialectId !== CUSTOM_OPENAI_DIALECT.id &&
		dialectId !== CUSTOM_ANTHROPIC_DIALECT.id
	) {
		const dialect = getDialect(dialectId);
		if (!dialect) {
			throw new Error(
				`Unknown provider dialect: ${dialectId}. Registered: ${listDialects()
					.map((entry) => entry.id)
					.sort()
					.join(", ")}`,
			);
		}
		return createProviderForDialect(dialect, providerId, config, options, headers);
	}

	const capabilities = runtimeCapabilityFlags(config, {
		tools: true,
		vision: true,
		reasoning: true,
	});

	if (dialectId === CUSTOM_ANTHROPIC_DIALECT.id) {
		return createAnthropicProvider(CUSTOM_ANTHROPIC_DIALECT, {
			providerId,
			baseUrl: config.baseUrl,
			auth: anthropicAuth({ apiKey: config.apiKey, ...(headers ? { headers } : {}) }),
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
		auth: new BearerApiKeyAuth(config.apiKey, headers ? { headers } : {}),
		fetchImpl: options.fetchImpl,
		requestDumper: resolveRequestDumper(options),
		transport: openAIChatTransportCapabilities(capabilities),
		parts: new OpenAIChatPartCodec({
			includeAssistantReasoning: capabilities.reasoning,
		}),
		profiles: ledgerProfiles(config),
	});
}

/**
 * 外部 agent 的 provider 都走同一个包装器(A0-3 单路合流):未绑目录拒绝、图片送不出去
 * 说话、会话链接落盘,这些检查只写一份。连接器由宿主按 provider id 注入,没注入就没有
 * 这个 provider。
 */
function registerExternalAgentProviderRuntime(providerId: string): void {
	registerAgentProviderRuntime(
		providerId,
		(_config, options) => {
			const connector = options.externalAgentConnectors?.[providerId];
			if (!connector) return undefined;

			return createExternalAgentProvider({
				providerId,
				connector,
				localSessionId: options.localSessionId,
				executionContext: options.executionContext,
				workingDirectory: options.workingDirectory,
				resolveSessionLink: (localSessionId) =>
					options.resolveExternalAgentSessionLink?.(providerId, localSessionId),
				onSessionLink: options.onExternalAgentSessionLink,
			});
		},
		{ replace: true },
	);
}

registerExternalAgentProviderRuntime("acp");

/**
 * 搬回 `providers/vendors/<id>/` 的那几家,工厂由各家自己带(`VendorRuntime.createProvider`),
 * 这里按名册接进工厂表 —— 本文件不再点那几家的名。
 */
const vendorRuntimeKit: VendorRuntimeKit = {
	profiles: ledgerProfiles,
	accessToken: accessTokenFromRuntimeConfig,
};
for (const vendor of VENDOR_RUNTIMES) {
	const create = vendor.createProvider;
	if (!create) continue;
	registerAgentProviderRuntime(vendor.id, (config, options) => create(config, options, vendorRuntimeKit), {
		replace: true,
	});
}
