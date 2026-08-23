/**
 * openai-responses 方言配方的公共构件(设计稿 §3:**Dialect = 类型化的组合
 * 配方**),与 openai-chat 的 `recipe.ts` / anthropic 的 `anthropic-recipe.ts` /
 * gemini 的 `gemini-recipe.ts` 同一形状。
 *
 * 这条线上有两处别家没有的事:
 *
 *  1. **端点是三态归一化的**:`baseUrl` 可能已经是 `…/codex/responses`、可能
 *     只到 `…/codex`、也可能什么都没带 —— 三种都要落到同一个地址
 *     (`resolveCodexResponsesUrl`,`codex-provider.test.ts` 钉着这三条)。
 *  2. **认证是一台带刷新的小状态机**:token 三级解析(`authContext.kind ===
 *     'oauth'` → `oauthToken` → 拿 `apiKey` 伪造一个)、每回合现拿(可选地
 *     过一次 `refreshOAuthToken(false)`)、六个 codex 头、以及 401 时**强制**
 *     刷新一次再重试。设计稿 §3 把「401 刷新重试是 `AuthStrategy` 自己的事」
 *     写进了契约,wire 因此不知道 OAuth 的存在。
 */
import type {
	AgentModelCapabilities,
	AgentProvider,
} from "@onething/core/agent-loop";
import { getLogger } from "../../../logging/index.js";
import {
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
import { RESPONSES_THINKING_WIRES } from "../thinking/index.js";
import {
	OpenAIResponsesWire,
	codexResponsesErrorMapper,
	createCodexAgentApiError,
	responsesLogger,
	type ResponsesDialect,
	type ResponsesWireValue,
} from "../wires/index.js";

export type FetchFn = typeof globalThis.fetch;

export const CODEX_PROVIDER_ID = "codex";
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CODEX_CLIENT_VERSION = process.env.npm_package_version || "1.1.0";
export const CODEX_FALLBACK_INSTRUCTIONS =
	"You are Codex, a helpful AI coding assistant.";

/** 没配 provider 时也得有个 logger —— 与门面同一条命名规则。 */
const log = getLogger(`providers.${CODEX_PROVIDER_ID}`);

// ---------------------------------------------------------------------------
// 凭据
// ---------------------------------------------------------------------------

export interface OAuthToken {
	accessToken: string;
	expiresAt?: number;
	tokenType?: string;
	accountId?: string;
	isFedrampAccount?: boolean;
}

export interface ProviderAuthContext {
	kind: string;
	token?: OAuthToken;
}

export interface CodexAuthOptions {
	apiKey?: string;
	oauthToken?: OAuthToken;
	authContext?: ProviderAuthContext;
	refreshOAuthToken?: (forceRefresh: boolean) => Promise<OAuthToken | undefined>;
}

/** `resolveCodexToken` 逐字:oauth 的 authContext 优先,再 oauthToken,最后拿 apiKey 伪造。 */
export function resolveCodexToken(
	options: CodexAuthOptions,
): OAuthToken | undefined {
	if (options.authContext?.kind === "oauth") return options.authContext.token;
	if (options.oauthToken) return options.oauthToken;
	if (options.apiKey) {
		return {
			accessToken: options.apiKey,
			expiresAt: Date.now() + 60 * 60 * 1000,
			tokenType: "Bearer",
		};
	}
	return undefined;
}

/** `resolveCodexTokenForRequest` 逐字:有 OAuth 凭据且给了刷新器就每回合现拿。 */
export async function resolveCodexTokenForRequest(
	options: CodexAuthOptions,
	forceRefresh = false,
): Promise<OAuthToken | undefined> {
	const hasOAuthCredentials =
		options.authContext?.kind === "oauth" || Boolean(options.oauthToken);
	if (hasOAuthCredentials && options.refreshOAuthToken) {
		try {
			return await options.refreshOAuthToken(forceRefresh);
		} catch (error) {
			if (forceRefresh) throw error;
			log.warn("oauth token refresh failed, using token snapshot", undefined, error);
		}
	}
	return resolveCodexToken(options);
}

function canRefreshCodexOAuth(options: CodexAuthOptions): boolean {
	return (
		Boolean(options.refreshOAuthToken) &&
		(options.authContext?.kind === "oauth" || Boolean(options.oauthToken))
	);
}

/** `buildCodexAgentHeaders` 逐字 —— 六个固定头 + 两个条件头,键序不动。 */
export function buildCodexAgentHeaders(
	token: OAuthToken,
): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "text/event-stream",
		"Content-Type": "application/json",
		Authorization: `Bearer ${token.accessToken}`,
		originator: "codex_cli_rs",
		version: CODEX_CLIENT_VERSION,
		"User-Agent": `codex_cli_rs/${CODEX_CLIENT_VERSION}`,
	};
	if (token.accountId) headers["ChatGPT-Account-ID"] = token.accountId;
	if (token.isFedrampAccount) headers["X-OpenAI-Fedramp"] = "true";
	return headers;
}

export const CODEX_NOT_LOGGED_IN = "Not logged in to Codex. Please login first.";

/**
 * codex 的认证策略。
 *
 * 401 那一段是 `codex.ts` 919–944 的**逐字**复刻,连「不重试就在这里抛」都
 * 一样:基类的 `send()` 拿到 `undefined` 会把原响应交回模板,模板再
 * `await response.text()` —— 但体已经被这里读过了,再读只会拿到空串,错误
 * 消息就少了 `detail`。所以三条不重试的路径都在这里**自己抛**今天那个对象。
 *
 * 回合级的「这一跳用的是哪个 token」记在 `WeakMap` 上而不是实例字段:一个
 * provider 实例要能跨回合、跨凭据复用(§3.1「实例无状态」)。
 */
export class CodexOAuthAuth implements AuthStrategy {
	private readonly tokenByTurn = new WeakMap<TurnContext, string>();

	constructor(private readonly options: CodexAuthOptions) {}

	async headers(turn: TurnContext): Promise<Record<string, string>> {
		const token = await resolveCodexTokenForRequest(this.options);
		if (!token?.accessToken) throw new Error(CODEX_NOT_LOGGED_IN);
		this.tokenByTurn.set(turn, token.accessToken);
		return buildCodexAgentHeaders(token);
	}

	async onUnauthorized(
		response: Response,
		turn: TurnContext,
	): Promise<Record<string, string> | undefined> {
		// 不能刷新 = 按普通错误走(模板会读体、造错误),与今天一致。
		if (!canRefreshCodexOAuth(this.options)) return undefined;

		const previous = this.tokenByTurn.get(turn);
		const firstBody = await response.text().catch(() => "");
		try {
			const refreshedToken = await resolveCodexTokenForRequest(this.options, true);
			if (refreshedToken?.accessToken && refreshedToken.accessToken !== previous) {
				log.warn("request returned 401, refreshed oauth token and retrying once");
				this.tokenByTurn.set(turn, refreshedToken.accessToken);
				return buildCodexAgentHeaders(refreshedToken);
			}
			throw createCodexAgentApiError(
				response.status,
				firstBody,
				response.headers,
			);
		} catch (error) {
			if (error instanceof Error && "statusCode" in error) throw error;
			throw createCodexAgentApiError(
				401,
				firstBody || (error instanceof Error ? error.message : String(error)),
				response.headers,
			);
		}
	}
}

/** 配方里**登记**时的占位认证:没有凭据 = 每回合都会抛「没登录」。 */
const UNCONFIGURED_AUTH: AuthStrategy = new CodexOAuthAuth({});

export function codexAuth(options: CodexAuthOptions = {}): AuthStrategy {
	return new CodexOAuthAuth(options);
}

// ---------------------------------------------------------------------------
// 端点
// ---------------------------------------------------------------------------

/** `resolveCodexResponsesUrl` 逐字:三态归一化到同一个 `…/codex/responses`。 */
export function resolveCodexResponsesUrl(baseUrl?: string): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

/**
 * `path` 是空串:真正的路径是 baseUrl **本身**的三态归一化结果,只能在
 * `decorateUrl` 里长出来(basePath 拼接会把 `…/codex/responses` 拼成
 * `…/codex/responses/responses`)。URL 上不带凭据,所以不需要 `redactForDump`。
 */
export function responsesEndpoint(
	defaultBaseUrl: string = CODEX_BASE_URL,
): DialectEndpoint {
	return {
		defaultBaseUrl,
		path: "",
		decorateUrl(url: string): string {
			return resolveCodexResponsesUrl(url);
		},
	};
}

// ---------------------------------------------------------------------------
// 传输声明
// ---------------------------------------------------------------------------

/**
 * provider 的**传输**声明 —— `codex.ts` 的 `CODEX_AGENT_CAPABILITIES` 逐字
 * 复刻(数组顺序也一样)。这条线是 openai 系里唯一声明 `image-output` 的:
 * `image_generation` 是它的原生工具。
 */
export const CODEX_TRANSPORT_CAPABILITIES: AgentModelCapabilities = {
	capabilities: [
		"text-input",
		"vision-input",
		"file-input",
		"text-output",
		"image-output",
		"streaming",
		"tool-calls",
		"structured-tool-results",
		"reasoning",
	],
	inputModalities: ["text", "image", "file"],
	outputModalities: ["text", "image"],
	toolResultModalities: ["text", "image"],
	supportsTools: true,
	supportsStructuredToolResults: true,
	supportsReasoning: true,
	supportsStreaming: true,
	// Responses API tool_choice: "required"
	supportsForcedToolUse: true,
};

// ---------------------------------------------------------------------------
// 配方
// ---------------------------------------------------------------------------

export interface ResponsesDialectSpec {
	id: string;
	defaultBaseUrl?: string;
	transport?: AgentModelCapabilities;
	fallbackInstructions?: string;
}

export function responsesDialect(spec: ResponsesDialectSpec): ResponsesDialect {
	return {
		id: spec.id,
		wire: "openai-responses",
		endpoint: responsesEndpoint(spec.defaultBaseUrl ?? CODEX_BASE_URL),
		auth: UNCONFIGURED_AUTH,
		request: {
			// Responses 的上限字段叫 `max_output_tokens`,不在这个二选一的枚举里
			// —— 而且今天压根不发,所以这个值没有读者。
			maxTokensField: "max_tokens",
			// 流恒带 `response.completed.usage`,没有 `stream_options` 这个概念。
			streamUsage: "always",
			// `input` 是项数组,不要求 user/assistant 严格交替。
			mergeAdjacent: false,
		},
		reasoning: RESPONSES_THINKING_WIRES,
		errors: codexResponsesErrorMapper,
		transport: spec.transport ?? CODEX_TRANSPORT_CAPABILITIES,
		fallbackInstructions:
			spec.fallbackInstructions ?? CODEX_FALLBACK_INSTRUCTIONS,
	};
}

/** 建表 + 登记一步到位 —— 每份配方文件的最后一句。 */
export function defineResponsesDialect(
	spec: ResponsesDialectSpec,
): ResponsesDialect {
	const dialect = responsesDialect(spec);
	registerDialect(dialect);
	return dialect;
}

export interface ResponsesProviderInit {
	/** 不给 = 用配方的 id。 */
	providerId?: string;
	baseUrl?: string;
	auth: AuthStrategy;
	fetchImpl?: FetchFn;
	requestDumper?: AgentProviderRequestDumper;
	/** 覆盖传输声明。 */
	transport?: AgentModelCapabilities;
	parts?: PartCodec<ResponsesWireValue>;
	profiles?: ModelProfileResolver;
}

/**
 * 配方 + 凭据 → provider。
 *
 * `profiles` 故意是**空**的 `LedgerModelProfileResolver`(不带 `model`):
 * 静态 `capabilities` 因此仍是纯传输声明(与今天 `CODEX_AGENT_CAPABILITIES`
 * 一致),而 per-model 的账本覆盖仍由 `factory.ts` 的 `withPerModelCapabilities`
 * 在外面盖一层。
 */
export function createResponsesProvider(
	dialect: ResponsesDialect,
	init: ResponsesProviderInit,
): AgentProvider {
	const providerId = init.providerId || dialect.id || "";
	// 空串 / 全空白的 baseUrl 都退回默认地址(`resolveCodexResponsesUrl` 的
	// 第一句),否则 `"  "` 会被拼成 `"  /codex/responses"`。
	const baseUrl =
		init.baseUrl && init.baseUrl.trim().length > 0
			? init.baseUrl
			: dialect.endpoint.defaultBaseUrl;
	const ctx: ProviderContext = {
		providerId,
		baseUrl,
		fetchImpl: init.fetchImpl ?? globalThis.fetch,
		...(init.requestDumper ? { dumper: init.requestDumper } : {}),
		logger: responsesLogger(providerId),
		profiles: init.profiles ?? new LedgerModelProfileResolver(),
	};
	return new OpenAIResponsesWire(ctx, {
		...dialect,
		auth: init.auth,
		...(init.transport ? { transport: init.transport } : {}),
		...(init.parts ? { parts: init.parts } : {}),
	});
}
