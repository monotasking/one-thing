/**
 * gemini 方言配方的公共构件(设计稿 §3:**Dialect = 类型化的组合配方**),
 * 与 openai-chat 的 `recipe.ts` / anthropic 的 `anthropic-recipe.ts` 同一形状。
 *
 * 曾经这条线上有一处别家没有的事:**端点也带凭据** —— API key 同时写进 URL 的
 * `?key=` 与 `x-goog-api-key` 头。P2-b 按官方示例只留头,`geminiEndpoint` 因此
 * 与别家一样不再需要凭据,拼出来的 URL 只有 `?alt=sse`。
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
	type DialectEndpoint,
	type ModelProfileResolver,
	type PartCodec,
	type ProviderContext,
	type TurnContext,
} from "../base/index.js";
import type { AgentProviderRequestDumper } from "../request-dump.js";
import { GEMINI_THINKING_WIRES } from "../thinking/index.js";
import {
	GeminiWire,
	geminiLogger,
	type GeminiDialect,
	type GeminiWireValue,
} from "../wires/index.js";

export type FetchFn = typeof globalThis.fetch;

export const GEMINI_DEFAULT_BASE_URL =
	"https://generativelanguage.googleapis.com/v1beta";

/**
 * provider 的**传输**声明 —— `gemini.ts` 的 `GEMINI_CAPABILITIES` 逐字复刻
 * (数组顺序也一样)。这条线是全仓唯一声明 audio / video 输入的:
 * `inlineData` / `fileData` 收得下它们。
 */
export const GEMINI_TRANSPORT_CAPABILITIES: AgentModelCapabilities = {
	capabilities: [
		"text-input",
		"vision-input",
		"file-input",
		"audio-input",
		"video-input",
		"text-output",
		"streaming",
		"tool-calls",
		"reasoning",
	],
	inputModalities: ["text", "image", "file", "audio", "video"],
	outputModalities: ["text"],
	supportsTools: true,
	supportsReasoning: true,
	supportsStreaming: true,
	// functionCallingConfig.mode = 'ANY'
	supportsForcedToolUse: true,
};

/**
 * 端点 —— `${baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent`
 * 挂 `alt=sse`,没有别的。
 *
 * `path` 是空串:真正的路径与模型有关,只能在 `decorateUrl` 里长出来。
 *
 * **没有 `redactForDump`**:URL 上不带凭据,落盘那份原样就是安全的。P2-b 之前
 * 这里还会挂一把 `?key=<apiKey>`,dump 时换成 `key=[redacted]` —— 官方示例一律
 * 走 `x-goog-api-key` 头,query 那条是旧写法,连同它的脱敏一起删了。
 */
export function geminiEndpoint(
	defaultBaseUrl: string = GEMINI_DEFAULT_BASE_URL,
): DialectEndpoint {
	return {
		defaultBaseUrl,
		path: "",
		decorateUrl(url: string, turn: TurnContext): string {
			const target = new URL(
				`${url}/models/${encodeURIComponent(turn.model)}:streamGenerateContent`,
			);
			target.searchParams.set("alt", "sse");
			return target.toString();
		},
	};
}

/**
 * 配方里**登记**时的占位认证:没有凭据 = 不发 `x-goog-api-key`。
 * 真正的凭据在 `createGeminiProvider()` 里晚绑定(设计稿 §2.10)。
 */
const UNCONFIGURED_AUTH: AuthStrategy = new HeaderApiKeyAuth(
	"x-goog-api-key",
	undefined,
);

export interface GeminiAuthOptions {
	apiKey?: string;
	/** 静态附加头。 */
	headers?: Record<string, string>;
}

/**
 * 头的叠加顺序逐字沿用 `gemini.ts`:`Content-Type` → `x-goog-api-key`。
 *
 * P2-b 起这是钥匙**唯一**的落点(URL 上那把 `?key=` 已删)。
 */
export function geminiAuth(options: GeminiAuthOptions = {}): AuthStrategy {
	return new HeaderApiKeyAuth("x-goog-api-key", options.apiKey, {
		...(options.headers ? { headers: options.headers } : {}),
	});
}

export interface GeminiDialectSpec {
	id: string;
	defaultBaseUrl?: string;
	transport?: AgentModelCapabilities;
}

export function geminiDialect(spec: GeminiDialectSpec): GeminiDialect {
	const defaultBaseUrl = spec.defaultBaseUrl ?? GEMINI_DEFAULT_BASE_URL;
	return {
		id: spec.id,
		wire: "gemini-generateContent",
		endpoint: geminiEndpoint(defaultBaseUrl),
		auth: UNCONFIGURED_AUTH,
		request: {
			// Gemini 的上限字段叫 `generationConfig.maxOutputTokens`,不在这个
			// 二选一的枚举里 —— wire 自己写,这里给的值没有读者。
			maxTokensField: "max_tokens",
			// `?alt=sse` 的流恒带 `usageMetadata`,没有 `stream_options` 这个概念。
			streamUsage: "always",
			mergeAdjacent: true,
		},
		reasoning: GEMINI_THINKING_WIRES,
		transport: spec.transport ?? GEMINI_TRANSPORT_CAPABILITIES,
	};
}

/** 建表 + 登记一步到位 —— 每份配方文件的最后一句。 */
export function defineGeminiDialect(spec: GeminiDialectSpec): GeminiDialect {
	const dialect = geminiDialect(spec);
	registerDialect(dialect);
	return dialect;
}

export interface GeminiProviderInit {
	/** 不给 = 用配方的 id。 */
	providerId?: string;
	baseUrl?: string;
	auth: AuthStrategy;
	fetchImpl?: FetchFn;
	requestDumper?: AgentProviderRequestDumper;
	/** 覆盖传输声明。 */
	transport?: AgentModelCapabilities;
	parts?: PartCodec<GeminiWireValue>;
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
export function createGeminiProvider(
	dialect: GeminiDialect,
	init: GeminiProviderInit,
): AgentProvider {
	const providerId = init.providerId || dialect.id || "";
	const baseUrl = (init.baseUrl || dialect.endpoint.defaultBaseUrl).replace(
		/\/$/,
		"",
	);
	const ctx: ProviderContext = {
		providerId,
		baseUrl,
		fetchImpl: init.fetchImpl ?? globalThis.fetch,
		...(init.requestDumper ? { dumper: init.requestDumper } : {}),
		logger: geminiLogger(providerId),
		profiles: init.profiles ?? new LedgerModelProfileResolver(),
	};
	return new GeminiWire(ctx, {
		...dialect,
		auth: init.auth,
		...(init.transport ? { transport: init.transport } : {}),
		...(init.parts ? { parts: init.parts } : {}),
	});
}
