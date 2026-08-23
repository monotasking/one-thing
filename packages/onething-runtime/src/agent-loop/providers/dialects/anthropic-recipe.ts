/**
 * anthropic-messages 方言配方的公共构件(设计稿 §3:**Dialect = 类型化的组合
 * 配方**),与 openai-chat 的 `recipe.ts` 同一形状。
 *
 * 每份配方是一个 `AnthropicDialect` 对象,字段全是策略对象;这里只提供
 * 「怎么把一份配方 + 一套凭据变成一个可用的 provider」这一步。凭据是**每次
 * 构造**才有的东西(apiKey / Claude Code 的 OAuth access token),所以注册表
 * 里登记的是**不带凭据**的配方,构造时再补上 `auth`。
 */
import type {
	AgentModelCapabilities,
	AgentProvider,
} from "@onething/core/agent-loop";
import {
	HeaderApiKeyAuth,
	LedgerModelProfileResolver,
	registerDialect,
	type AuthStrategy,
	type ModelProfileResolver,
	type PartCodec,
	type ProviderContext,
} from "../base/index.js";
import type { AgentProviderRequestDumper } from "../request-dump.js";
import {
	ANTHROPIC_THINKING_WIRES,
	AnthropicMessagesWire,
	anthropicCachePolicy,
	anthropicLogger,
	type AnthropicDialect,
	type AnthropicWireValue,
} from "../wires/index.js";

export type FetchFn = typeof globalThis.fetch;

export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * provider 的**传输**声明 —— `claude.ts` 的 `CLAUDE_CAPABILITIES` 逐字复刻
 * (数组顺序也一样)。per-model 的布尔不在这里翻,那是账本(`ModelProfile`)的事。
 */
export const ANTHROPIC_TRANSPORT_CAPABILITIES: AgentModelCapabilities = {
	capabilities: [
		"text-input",
		"vision-input",
		"file-input",
		"text-output",
		"streaming",
		"tool-calls",
		"structured-tool-results",
		"reasoning",
	],
	inputModalities: ["text", "image", "file"],
	outputModalities: ["text"],
	toolResultModalities: ["text", "image"],
	supportsTools: true,
	supportsStructuredToolResults: true,
	supportsReasoning: true,
	supportsStreaming: true,
	// tool_choice: { type: 'any' }
	supportsForcedToolUse: true,
};

/**
 * 配方里**登记**时的占位认证:没有凭据 = 不发 `x-api-key`。
 * 真正的凭据在 `createAnthropicProvider()` 里晚绑定(设计稿 §2.10)。
 */
const UNCONFIGURED_AUTH: AuthStrategy = new HeaderApiKeyAuth(
	"x-api-key",
	undefined,
	{ headers: { "anthropic-version": ANTHROPIC_VERSION } },
);

export interface AnthropicAuthOptions {
	apiKey?: string;
	/** claude-code 那条:凭据在 `authorization` 头里,不发 `x-api-key`。 */
	omitApiKeyHeader?: boolean;
	/** 静态附加头(OAuth 的 `authorization` / `anthropic-beta`)。 */
	headers?: Record<string, string>;
}

/**
 * 头的叠加顺序逐字沿用 `claude.ts`:`Content-Type` → `x-api-key` →
 * `anthropic-version` → `options.headers`。
 */
export function anthropicAuth(options: AnthropicAuthOptions = {}): AuthStrategy {
	return new HeaderApiKeyAuth(
		"x-api-key",
		options.omitApiKeyHeader ? undefined : options.apiKey,
		{ headers: { "anthropic-version": ANTHROPIC_VERSION, ...options.headers } },
	);
}

export interface AnthropicDialectSpec {
	id: string;
	defaultBaseUrl?: string;
	/**
	 * 打显式缓存断点(`cache_control: ephemeral`)。官方端点开;第三方
	 * anthropic 兼容端点可能拒收这个字段,所以默认关。
	 */
	promptCaching?: boolean;
	/** 固定顶在 system 最前面的那一块(claude-code)。 */
	systemHeader?: string;
	transport?: AgentModelCapabilities;
}

export function anthropicDialect(spec: AnthropicDialectSpec): AnthropicDialect {
	return {
		id: spec.id,
		wire: "anthropic-messages",
		endpoint: {
			defaultBaseUrl: spec.defaultBaseUrl ?? ANTHROPIC_DEFAULT_BASE_URL,
			path: "/messages",
		},
		auth: UNCONFIGURED_AUTH,
		request: {
			maxTokensField: "max_tokens",
			// Anthropic 的流恒带 usage(`message_start` / `message_delta`),
			// 没有 `stream_options` 这个概念。
			streamUsage: "always",
			mergeAdjacent: true,
		},
		reasoning: ANTHROPIC_THINKING_WIRES,
		...(spec.promptCaching ? { cache: anthropicCachePolicy } : {}),
		...(spec.systemHeader ? { systemHeader: spec.systemHeader } : {}),
		transport: spec.transport ?? ANTHROPIC_TRANSPORT_CAPABILITIES,
	};
}

/** 建表 + 登记一步到位 —— 每份配方文件的最后一句。 */
export function defineAnthropicDialect(
	spec: AnthropicDialectSpec,
): AnthropicDialect {
	const dialect = anthropicDialect(spec);
	registerDialect(dialect);
	return dialect;
}

export interface AnthropicProviderInit {
	/** 不给 = 用配方的 id(`custom-*` 必须给:一份配方服务任意多个自定义 id)。 */
	providerId?: string;
	baseUrl?: string;
	auth: AuthStrategy;
	fetchImpl?: FetchFn;
	requestDumper?: AgentProviderRequestDumper;
	/** 覆盖传输声明(`custom-*` 的三旋钮、`options.capabilities`)。 */
	transport?: AgentModelCapabilities;
	parts?: PartCodec<AnthropicWireValue>;
	profiles?: ModelProfileResolver;
}

/**
 * 配方 + 凭据 → provider。
 *
 * `profiles` 由构造处注入(`factory.ts` 的 `ledgerProfiles(config)`):
 * per-model 的能力从此只有它一个来源(P2-a,`withPerModelCapabilities` 已退役)。
 * 它**故意不带 `model`**,`defaultProfile()` 因此给不出默认档 —— 静态
 * `capabilities` 仍是纯传输声明,与今天一致。不给 `profiles` 就退成一个空账本
 * 解析器(直接调这个函数的测试就是这样)。
 */
export function createAnthropicProvider(
	dialect: AnthropicDialect,
	init: AnthropicProviderInit,
): AgentProvider {
	const providerId = init.providerId || dialect.id || "";
	const baseUrl = (init.baseUrl || dialect.endpoint.defaultBaseUrl).replace(/\/$/, "");
	const ctx: ProviderContext = {
		providerId,
		baseUrl,
		fetchImpl: init.fetchImpl ?? globalThis.fetch,
		...(init.requestDumper ? { dumper: init.requestDumper } : {}),
		logger: anthropicLogger(providerId),
		profiles: init.profiles ?? new LedgerModelProfileResolver(),
	};
	return new AnthropicMessagesWire(ctx, {
		...dialect,
		auth: init.auth,
		...(init.transport ? { transport: init.transport } : {}),
		...(init.parts ? { parts: init.parts } : {}),
	});
}
