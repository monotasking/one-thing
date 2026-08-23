/**
 * openai-responses 方言配方的公共构件(设计稿 §3:**Dialect = 类型化的组合
 * 配方**),与 openai-chat 的 `recipe.ts` / anthropic 的 `anthropic-recipe.ts` /
 * gemini 的 `gemini-recipe.ts` 同一形状。
 *
 * ## P4-4:配方是通用的,codex 的怪癖是**这个文件下半截的一组常量**
 *
 * 这条线原本只有 codex 一家,于是它的三样东西曾经长在配方的默认值里:
 * `…/codex/responses` 的三态 URL 归一化、`CodexOAuthAuth`(token 三级解析 +
 * 六个头 + 401 强制刷新一次)、`CODEX_FALLBACK_INSTRUCTIONS`。P4-4 把 grok /
 * grok-oauth 也搬上这条线(`https://api.x.ai/v1/responses`,Bearer API key)
 * 之后,`responsesDialect(spec)` 里**一个 codex 字样都没有**:
 *
 *  - `endpoint`:默认就是 `<baseUrl>/responses` 这条最普通的拼法;codex 传
 *    自己的 `responsesEndpoint()`(三态归一化)进来。
 *  - `auth`:配方**必须**收一条(登记期给占位)。codex 传 `CodexOAuthAuth`,
 *    xAI 传 `BearerApiKeyAuth`。
 *  - `reasoning`:codex 传 `RESPONSES_THINKING_WIRES`(`include` 与 `reasoning`
 *    同生共死 + effort 钳 high + `isCodexReasoningModel` 自动补档),
 *    xAI 传 `GROK_RESPONSES_THINKING_WIRES`(恒发 `include`、四档 effort)。
 *  - `store` / `fallbackInstructions` / `nativeTools`(codex 的
 *    `image_generation`)/ `usage`(xAI 的 `cost_in_usd_ticks`)/
 *    `providerDataTag` / `errorLabel` / `providerOptions`:一家一行。
 *
 * 认证那台状态机仍然住在这里(它是 codex 的,不是配方的):token 三级解析
 * (`authContext.kind === 'oauth'` → `oauthToken` → 拿 `apiKey` 伪造一个)、
 * 每回合现拿(可选地过一次 `refreshOAuthToken(false)`)、六个 codex 头、
 * 以及 401 时**强制**刷新一次再重试。设计稿 §3 把「401 刷新重试是
 * `AuthStrategy` 自己的事」写进了契约,wire 因此不知道 OAuth 的存在。
 */
import type {
	AgentModelCapabilities,
	AgentProvider,
} from "@onething/core/agent-loop";
import { getLogger } from "../../../logging/index.js";
import type { AgentTurnStreamEvent } from "@onething/core/agent-loop";
import {
	LedgerModelProfileResolver,
	registerDialect,
	type AuthStrategy,
	type Dialect,
	type DialectEndpoint,
	type ModelProfileResolver,
	type PartCodec,
	type ProviderContext,
	type ThinkingWire,
	type TurnContext,
	type UsageNormalizer,
} from "../base/index.js";
import type { AgentProviderRequestDumper } from "../request-dump.js";
import { RESPONSES_THINKING_WIRES } from "../thinking/index.js";
import {
	CodexResponsesErrorMapper,
	OpenAIResponsesWire,
	ResponsesPartCodec,
	createCodexAgentApiError,
	openAIResponsesProviderOptionsExtraBody,
	responsesLogger,
	type CodexTool,
	type OpenAIResponsesProviderOptionSupport,
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
 * **codex 专属**的端点:`path` 是空串,真正的路径是 baseUrl **本身**的三态
 * 归一化结果,只能在 `decorateUrl` 里长出来(basePath 拼接会把
 * `…/codex/responses` 拼成 `…/codex/responses/responses`)。URL 上不带凭据,
 * 所以不需要 `redactForDump`。
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

/**
 * 这条线协议**最普通**的端点拼法:`<baseUrl>/responses`(官方
 * `POST /v1/responses`,baseUrl 就是 `https://api.x.ai/v1`)。配方不给
 * `endpoint` 时用它 —— codex 那份三态归一化是它自己的事,不是这条线的默认。
 */
export function plainResponsesEndpoint(defaultBaseUrl: string): DialectEndpoint {
	return { defaultBaseUrl, path: "/responses" };
}

// ---------------------------------------------------------------------------
// 传输声明
// ---------------------------------------------------------------------------

/**
 * codex 的**传输**声明 —— `codex.ts` 的 `CODEX_AGENT_CAPABILITIES` 逐字
 * 复刻(数组顺序也一样)。它是这条线上唯一声明 `image-output` 的:
 * `image_generation` 是**它**的原生工具(xAI 的生图是另一个端点)。
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

/**
 * **codex 那一份配方主体**(除了 id)—— 两个构造点共用一份,于是
 * `dialects/codex.ts` 的具名方言与 `providers/codex.ts` 那个即用即弃的门面
 * 永远同解。
 *
 * P4-4 之前这几样是 `responsesDialect()` 的默认值,门面因此「不写就对」;
 * 现在配方通用了,谁要 codex 的行为谁就得**明说**,所以它成了一个常量而不是
 * 一句默认。`codex-provider.test.ts` 的 image_generation 断言就是这条的门。
 */
export const CODEX_DIALECT_SPEC: Omit<ResponsesDialectSpec, "id"> = {
	defaultBaseUrl: CODEX_BASE_URL,
	endpoint: responsesEndpoint(CODEX_BASE_URL),
	store: false,
	nativeTools: (turn) =>
		turn.request.requestedOutputModalities?.includes("image")
			? [{ type: "image_generation", output_format: "png" }]
			: [],
};

export interface ResponsesDialectSpec {
	id: string;
	/** 不给 `endpoint` 时,拼成 `<defaultBaseUrl>/responses`。 */
	defaultBaseUrl: string;
	/** 需要非常规拼法的自己给(codex 的三态归一化)。 */
	endpoint?: DialectEndpoint;
	/**
	 * 登记期的占位认证 —— 真正的凭据在 `createResponsesProvider` 里注入。
	 * 不给 = codex 那个「没登录就抛」的占位(历史默认)。
	 */
	auth?: AuthStrategy;
	/** 这家可能出现的思考线型;不给 = codex 那条。 */
	reasoning?: ThinkingWire[];
	/** 顶层 `store`;不给 = 不发这个键。两家生产配方都发 `false`。 */
	store?: boolean;
	/** 一条 system 都没有时顶上去的 `instructions`;不给 = codex 那句。 */
	fallbackInstructions?: string;
	/** 这一回合的原生工具(服务端自己跑的那种)。 */
	nativeTools?(turn: TurnContext): CodexTool[];
	/** usage 归一化;不给 = 这条线的默认三桶直译(无厂商报价)。 */
	usage?: UsageNormalizer;
	/** provider-data 标签与加密思维链回放的判据;不给 = `spec.id`。 */
	providerDataTag?: string;
	/** 错误消息里的家名;不给 = `Codex`。 */
	errorLabel?: string;
	/** 请求级 providerOptions 袋这家认哪些键(P3-3 的机制,这条线的白名单)。 */
	providerOptions?: OpenAIResponsesProviderOptionSupport;
	/** 这家自己的额外请求体字段(`prompt_cache_key` 等)。 */
	extraBody?: Dialect["extraBody"];
	/** 完成的 output item → 额外事件(xAI 的引文 annotations)。 */
	decodeOutputItem?(
		item: Record<string, unknown>,
		turn: TurnContext,
	): AgentTurnStreamEvent[];
	transport?: AgentModelCapabilities;
}

/**
 * 配方自己的 `extraBody` 先跑,袋那支后跑 —— 与 openai-chat 的
 * `composeExtraBody` 同一条规矩:哪怕这家一个袋键都不认,认不出的键也要留痕,
 * 不能因为「这家没有旋钮」就静默吞掉用户写进 settings.json 的东西。
 */
function composeExtraBody(spec: ResponsesDialectSpec): Dialect["extraBody"] {
	const bag = openAIResponsesProviderOptionsExtraBody(spec.providerOptions ?? {});
	const own = spec.extraBody;
	return (turn) => ({ ...own?.(turn), ...bag(turn) });
}

export function responsesDialect(spec: ResponsesDialectSpec): ResponsesDialect {
	const providerDataTag = spec.providerDataTag ?? spec.id;
	return {
		id: spec.id,
		wire: "openai-responses",
		endpoint: spec.endpoint ?? plainResponsesEndpoint(spec.defaultBaseUrl),
		auth: spec.auth ?? UNCONFIGURED_AUTH,
		parts: new ResponsesPartCodec({
			providerDataTag,
			...(spec.providerOptions?.imageDetail === undefined
				? {}
				: { imageDetail: spec.providerOptions.imageDetail }),
		}),
		errors: new CodexResponsesErrorMapper(spec.id, spec.errorLabel ?? "Codex"),
		extraBody: composeExtraBody(spec),
		providerDataTag,
		...(spec.store === undefined ? {} : { store: spec.store }),
		...(spec.usage ? { usage: spec.usage } : {}),
		...(spec.nativeTools ? { nativeTools: spec.nativeTools } : {}),
		...(spec.decodeOutputItem ? { decodeOutputItem: spec.decodeOutputItem } : {}),
		request: {
			// Responses 的上限字段叫 `max_output_tokens`,不在这个二选一的枚举里
			// —— 而且今天压根不发,所以这个值没有读者。
			maxTokensField: "max_tokens",
			// 流恒带 `response.completed.usage`,没有 `stream_options` 这个概念。
			streamUsage: "always",
			// `input` 是项数组,本来不要求 user/assistant 严格交替 —— 但相邻同
			// 角色合成一条对它是无害的等价改写,而与别家不一致的历史形状会让
			// 「同一段对话在两条线上长得不一样」变成排障时的假线索。P0b-B 起
			// 与另外三条线同规(设计稿 §10 第 2 条)。
			mergeAdjacent: true,
		},
		reasoning: spec.reasoning ?? RESPONSES_THINKING_WIRES,
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
 * `profiles` 由构造处注入(`factory.ts` 的 `ledgerProfiles(config)`):
 * per-model 的能力从此只有它一个来源(P2-a,`withPerModelCapabilities` 已退役)。
 * 它**故意不带 `model`**,`defaultProfile()` 因此给不出默认档 —— 静态
 * `capabilities` 仍是纯传输声明,与今天一致。不给 `profiles` 就退成一个空账本
 * 解析器(直接调这个函数的测试就是这样)。
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
