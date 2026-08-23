/**
 * `AuthStrategy` —— 认证头怎么来,401 怎么办(设计稿 §3 / §2.10)。
 *
 * 两条纪律:
 *  - **晚绑定**:`headers()` 每回合调一次,凭据轮换在 runner 层换 key,
 *    provider 实例可以跨回合跨凭据复用;
 *  - **401 刷新重试是它自己的事**,wire 不知道 OAuth 的存在。
 *
 * `Content-Type` 也在这里拼 —— 不是因为它属于认证,而是因为今天
 * `openai-compatible.ts` 就是把它和 Authorization 拼在同一个对象里的,
 * 键序(以及「`headers` 能覆盖 Content-Type」这件事)是既有行为,不去动。
 */
import type { TurnContext } from "./turn-context.js";

export interface AuthStrategy {
	headers(turn: TurnContext): Promise<Record<string, string>>;
	/**
	 * 收到 401 时给一套新头 = 重试一次;返回 undefined = 不重试,按错误处理。
	 * 基类只重试**一次**。
	 */
	onUnauthorized?(
		response: Response,
		turn: TurnContext,
	): Promise<Record<string, string> | undefined>;
}

export interface AuthStrategyOptions {
	/** 静态附加头(`options.headers`)。 */
	headers?: Record<string, string>;
	/** 不给 = `application/json`;显式 `null` = 不发。 */
	contentType?: string | null;
}

function withContentType(
	options: AuthStrategyOptions | undefined,
): Record<string, string> {
	const contentType =
		options?.contentType === null ? undefined : (options?.contentType ?? "application/json");
	return contentType ? { "Content-Type": contentType } : {};
}

/** `Authorization: Bearer <key>` —— OpenAI 系的默认。 */
export class BearerApiKeyAuth implements AuthStrategy {
	constructor(
		private readonly apiKey: string | undefined | (() => string | undefined),
		private readonly options: AuthStrategyOptions = {},
	) {}

	async headers(): Promise<Record<string, string>> {
		const key = typeof this.apiKey === "function" ? this.apiKey() : this.apiKey;
		return {
			...withContentType(this.options),
			...(key ? { Authorization: `Bearer ${key}` } : {}),
			...this.options.headers,
		};
	}
}

/** 自定义头位的 key(Anthropic `x-api-key`、Gemini `x-goog-api-key`)。 */
export class HeaderApiKeyAuth implements AuthStrategy {
	constructor(
		private readonly headerName: string,
		private readonly apiKey: string | undefined | (() => string | undefined),
		private readonly options: AuthStrategyOptions = {},
	) {}

	async headers(): Promise<Record<string, string>> {
		const key = typeof this.apiKey === "function" ? this.apiKey() : this.apiKey;
		return {
			...withContentType(this.options),
			...(key ? { [this.headerName]: key } : {}),
			...this.options.headers,
		};
	}
}

export interface ResolvedAuthMaterial {
	apiKey?: string;
	headers?: Record<string, string>;
}

/**
 * `openai-compatible.ts` 的 `resolveAuth` 语义,逐字复刻:
 * `apiKey = resolved.apiKey ?? options.apiKey ?? ''`,头的叠加顺序是
 * `Content-Type` → `Authorization` → `options.headers` → `resolved.headers`。
 */
export class ResolveAuth implements AuthStrategy {
	constructor(
		private readonly resolve: (
			turn: TurnContext,
		) => Promise<ResolvedAuthMaterial | undefined>,
		private readonly options: AuthStrategyOptions & { apiKey?: string } = {},
		private readonly refresh?: (
			response: Response,
			turn: TurnContext,
		) => Promise<ResolvedAuthMaterial | undefined>,
	) {}

	async headers(turn: TurnContext): Promise<Record<string, string>> {
		return this.compose(await this.resolve(turn));
	}

	async onUnauthorized(
		response: Response,
		turn: TurnContext,
	): Promise<Record<string, string> | undefined> {
		if (!this.refresh) return undefined;
		const refreshed = await this.refresh(response, turn);
		return refreshed ? this.compose(refreshed) : undefined;
	}

	private compose(resolved: ResolvedAuthMaterial | undefined): Record<string, string> {
		const apiKey = resolved?.apiKey ?? this.options.apiKey ?? "";
		return {
			...withContentType(this.options),
			...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			...this.options.headers,
			...resolved?.headers,
		};
	}
}
