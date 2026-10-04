/**
 * 内置服务商的**行为**名册:每家一行(`docs/design/architecture-direction-2026-10.md` §3)。
 *
 * 数据那一半(manifest)的名册是 `manifests.ts`(纯,壳也 import);这一半带方言与运行时
 * 工厂,只在后端进程里加载。
 *
 *  - import 本文件 = 各家方言登记进 `registerDialect`(方言模块定义即登记),各家思考参数
 *    登记进 `thinkingWires`(下面那个循环);
 *  - 运行时工厂由 `providers/factory.ts` 按名册接进工厂表 —— 那边持有表,
 *    这里只交名册,免得两边互相 import;
 *  - 配额源(余额 / 用量)由 `providers/quota/registry.ts` 第一次被问到时**惰性**读名册
 *    (它若在加载时就读,会经本文件把整个 agent-loop 拉进来、与 manifest 注册表成环);
 *  - OAuth 登录定义由 `auth/auth-registry.ts` 同样**惰性**读名册(P2 第 4 批);
 *  - 列表口(manifest `models.kind === 'endpoint'` 的那几家)与目录兜底行由宿主按名册建表
 *    (`backend/provider/provider-client-api-models.ts`、`backend/settings/settings-model-registry-service.ts`),宿主把
 *    自己才有的东西(auth 服务、app fetch、设置、落盘)经一份**不点名**的 `VendorModelsFetcherDeps` 交进来。
 */
import type { AgentProvider } from "@onething/backend/agent-loop";
import { thinkingWires, type ModelProfileResolver, type ThinkingWire } from "../base/provider-base.js";
import type {
	AgentProviderRuntimeConfig,
	CreateAgentProviderFromRuntimeOptions,
} from "../provider-factory.js";
import type { OnethingAuthProviderDefinition, OnethingOAuthToken } from "../../auth/auth.js";
import type { OnethingHttpPolicyName } from "@onething/backend/network";
import type {
	OnethingAccessTokenLike,
	OnethingConfiguredModelSelection,
	OnethingEndpointModelsFetcher,
	OnethingModelRegistryRefreshLogger,
	OnethingOpenRouterModel,
} from "../provider-model-registry.js";
import type { QuotaSource } from "../quota/provider-quota-source.js";
import { CLAUDE_RUNTIME } from "./claude/claude-runtime.js";
import { CLAUDE_CODE_RUNTIME } from "./claude-code/claude-code-runtime.js";
import { CODEX_RUNTIME } from "./codex/codex-runtime.js";
import { DEEPSEEK_RUNTIME } from "./deepseek/deepseek-runtime.js";
import { GEMINI_RUNTIME } from "./gemini/gemini-runtime.js";
import { GITHUB_COPILOT_RUNTIME } from "./github-copilot/github-copilot-runtime.js";
import { GROK_RUNTIME } from "./grok/grok-runtime.js";
import { GROK_OAUTH_RUNTIME } from "./grok-oauth/grok-oauth-runtime.js";
import { KIMI_RUNTIME } from "./kimi/kimi-runtime.js";
import { KIMI_CODE_RUNTIME } from "./kimi-code/kimi-code-runtime.js";
import { OPENAI_RUNTIME } from "./openai/openai-runtime.js";
import { OPENROUTER_RUNTIME } from "./openrouter/openrouter-runtime.js";
import { QWEN_RUNTIME } from "./qwen/qwen-runtime.js";
import { ZHIPU_RUNTIME } from "./zhipu/zhipu-runtime.js";

/** 工厂交给各家的几件公共工具(各家不必 import 工厂)。 */
export interface VendorRuntimeKit {
	/** 这份配置下的账本型号解析器(每家 provider 都要)。 */
	profiles(config: AgentProviderRuntimeConfig): ModelProfileResolver;
	/**
	 * 这份配置的访问令牌:OAuth 那一路取 `authContext` 里的 token,否则回落到 `oauthToken` /
	 * `apiKey`(订阅型的家 `config.apiKey` 恒为空串,必须走这里)。没有 = 空串。
	 */
	accessToken(config: AgentProviderRuntimeConfig): string;
}

/**
 * 宿主交给各家列表口的通用依赖 —— 一格都不点哪一家:这家的缓存目录、落盘、用户在设置里的选型、
 * auth 服务的两个取 token 口、宿主的 app fetch(按 policy 名取)、日志。
 */
export interface VendorModelsFetcherDeps {
	/** 设置里缓存的这家目录。 */
	getModelsForProvider(providerId: string): Promise<OnethingOpenRouterModel[]>;
	/** 现取到的目录落盘。 */
	saveProviderModels(providerId: string, models: OnethingOpenRouterModel[]): Promise<void> | void;
	/** 用户在设置里为这家选了哪些型号(`model` / `selectedModels`)。 */
	configuredSelection(providerId: string): OnethingConfiguredModelSelection | undefined;
	/** 当前存着的 OAuth token(不刷新)。 */
	getToken(
		providerId: string,
	): Promise<OnethingAccessTokenLike | null | undefined> | OnethingAccessTokenLike | null | undefined;
	/** 必要时先刷新的 OAuth token。 */
	refreshTokenIfNeeded(providerId: string): Promise<OnethingOAuthToken>;
	/** 宿主的 app fetch(代理 / 超时 / 重试按 policy)。 */
	fetch(policy: OnethingHttpPolicyName): typeof globalThis.fetch;
	logger?: OnethingModelRegistryRefreshLogger;
}

/**
 * 问一家「这一轮要不要挂你自己的原生工具」时交给它的东西(`VendorRuntime.nativeTools`)。
 * 目录条目按需才取:这家先看开关、工具能力与登录方式,判定要看型号时才去问目录。
 */
export interface VendorNativeToolsContext {
	/** 这一轮的生效配置(只读这几格:型号、登录方式、OAuth 令牌)。 */
	providerConfig: {
		model?: string;
		authContext?: { kind?: string };
		oauthToken?: { accessToken?: string };
	};
	/** 用户的工具总开关。 */
	toolSettings?: { enableToolCalls?: boolean };
	/** 这一型支不支持工具调用。 */
	supportsTools: boolean;
	/** 这一型的目录条目;调用才去取。 */
	modelInfo(): Promise<
		| { providerMetadata?: unknown; architecture?: { input_modalities?: string[] } }
		| undefined
	>;
}

/** 目录里没有时的兜底:`model` 答单个型号,`all` 答「这家的目录整个是空的」时列什么。 */
export interface VendorFallbackModels {
	model(modelId: string): OnethingOpenRouterModel | undefined;
	all(): OnethingOpenRouterModel[];
}

export interface VendorRuntime {
	id: string;
	/** 这家自己的思考参数线型(`thinkingWires` 里按 id 取)。 */
	thinkingWires?: readonly ThinkingWire[];
	/** 这家的配额源(`providers/quota/registry.ts` 惰性读;manifest 的 `quotaSource` 指向其 id)。 */
	quotaSources?: readonly QuotaSource[];
	/** 这家的 OAuth 登录定义(`auth/auth-registry.ts` 惰性读;manifest `auth.kind === 'oauth'` 的家才有)。 */
	oauth?: OnethingAuthProviderDefinition;
	/**
	 * 这家自己的列表口(manifest `models.kind === 'endpoint'`,且通用直连拿不到它要的东西 ——
	 * 比如要 OAuth token)。缺席 = 走通用路。
	 */
	createModelsFetcher?(deps: VendorModelsFetcherDeps): OnethingEndpointModelsFetcher;
	/** 目录里没有这一型 / 整本目录是空的时的兜底行。缺席 = 没有兜底。 */
	fallbackModels?: VendorFallbackModels;
	/**
	 * 这一轮这家要挂的原生工具名(例如订阅登录下的原生出图 `image_generation`)。缺席 = 这家没有原生工具。
	 * 引擎经 `resolveProviderNativeTools` 按名册问,不认识任何一家。
	 */
	nativeTools?(context: VendorNativeToolsContext): Promise<readonly string[]>;
	/** 缺席 = 这家没有专属工厂,按 manifest 的方言走通用那条路。 */
	createProvider?(
		config: AgentProviderRuntimeConfig,
		options: CreateAgentProviderFromRuntimeOptions,
		kit: VendorRuntimeKit,
	): AgentProvider | undefined;
}

export const VENDOR_RUNTIMES: readonly VendorRuntime[] = [
	CLAUDE_RUNTIME,
	CLAUDE_CODE_RUNTIME,
	CODEX_RUNTIME,
	DEEPSEEK_RUNTIME,
	GEMINI_RUNTIME,
	GITHUB_COPILOT_RUNTIME,
	GROK_RUNTIME,
	GROK_OAUTH_RUNTIME,
	KIMI_RUNTIME,
	KIMI_CODE_RUNTIME,
	OPENAI_RUNTIME,
	OPENROUTER_RUNTIME,
	QWEN_RUNTIME,
	ZHIPU_RUNTIME,
];

for (const vendor of VENDOR_RUNTIMES) {
	for (const wire of vendor.thinkingWires ?? []) thinkingWires.register(wire);
}
