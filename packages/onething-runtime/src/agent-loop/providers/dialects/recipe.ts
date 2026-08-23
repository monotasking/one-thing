/**
 * openai-chat 方言配方的公共构件(设计稿 §3:**Dialect = 类型化的组合配方**)。
 *
 * 每份配方是一个 `OpenAIChatDialect` 对象,字段全是策略对象;这里只提供
 * 「怎么把一份配方 + 一套凭据变成一个可用的 provider」这一步。凭据是**每次
 * 构造**才有的东西(apiKey / OAuth access token / copilot 换来的 completion
 * token),所以注册表里登记的是**不带凭据**的配方,构造时再补上 `auth`。
 */
import type { AgentCapability, AgentModelCapabilities, AgentProvider } from "@onething/core/agent-loop";
import {
	BearerApiKeyAuth,
	LedgerModelProfileResolver,
	registerDialect,
	type AuthStrategy,
	type ModelProfileResolver,
	type PartCodec,
	type ProviderContext,
	type SamplingPolicy,
	type ThinkingWire,
	type UsageNormalizer,
} from "../base/index.js";
import type { AgentProviderRequestDumper } from "../request-dump.js";
import {
	OpenAIChatPartCodec,
	OpenAIChatWire,
	openAIChatLogger,
	type OpenAIChatDialect,
	type OpenAIChatWireValue,
} from "../wires/index.js";

export type FetchFn = typeof globalThis.fetch;

/**
 * 配方里**登记**时的占位认证:没有凭据 = 不发 `Authorization`。
 * 真正的凭据在 `createOpenAIChatProvider()` 里晚绑定(设计稿 §2.10)。
 */
const UNCONFIGURED_AUTH: AuthStrategy = new BearerApiKeyAuth(undefined);

export interface OpenAIChatTransportFlags {
	tools?: boolean;
	vision?: boolean;
	reasoning?: boolean;
}

/**
 * provider 的**传输**声明 —— `openai-compatible.ts` 的 `buildCapabilities()`
 * 逐字复刻(数组顺序也一样:三条基础 → vision → tools → reasoning)。
 * per-model 的布尔不在这里翻,那是账本(`ModelProfile`)的事。
 */
export function openAIChatTransportCapabilities(
	flags: OpenAIChatTransportFlags,
): AgentModelCapabilities {
	const capabilities: AgentCapability[] = ["text-input", "text-output", "streaming"];
	const inputModalities: AgentModelCapabilities["inputModalities"] = ["text"];
	const outputModalities: AgentModelCapabilities["outputModalities"] = ["text"];

	if (flags.vision) {
		capabilities.push("vision-input", "file-input");
		inputModalities.push("image", "file");
	}
	if (flags.tools !== false) capabilities.push("tool-calls");
	if (flags.reasoning) capabilities.push("reasoning");

	return {
		capabilities,
		inputModalities,
		outputModalities,
		supportsTools: flags.tools !== false,
		supportsReasoning: Boolean(flags.reasoning),
		supportsStreaming: true,
		// tool_choice: "required" is part of the OpenAI chat-completions
		// contract every endpoint on this adapter claims to speak.
		supportsForcedToolUse: flags.tools !== false,
	};
}

export interface OpenAIChatDialectSpec {
	id: string;
	/** 用户可见文案里的名字。不给 = 用**运行时的 providerId**。 */
	displayName?: string;
	defaultBaseUrl: string;
	maxTokensField?: "max_tokens" | "max_completion_tokens";
	/** 这家走哪条思考线型(一家一条,由 `ModelProfile.reasoningWire` 选中或兜底)。 */
	reasoning: ThinkingWire;
	/** 多轮是否回传 `reasoning_content`(默认 codec 的唯一旋钮)。 */
	includeAssistantReasoning?: boolean;
	/** 换掉整只 codec(DeepSeek 的纯文本 user 内容)。 */
	parts?: PartCodec<OpenAIChatWireValue>;
	/** 换掉 usage 直译表(DeepSeek 的 `prompt_cache_hit_tokens`)。 */
	usage?: UsageNormalizer;
	/** 换掉采样策略(DeepSeek 的 thinking 是**推断**出来的)。 */
	sampling?: SamplingPolicy;
	transport: AgentModelCapabilities;
}

export function openAIChatDialect(spec: OpenAIChatDialectSpec): OpenAIChatDialect {
	return {
		id: spec.id,
		...(spec.displayName ? { displayName: spec.displayName } : {}),
		wire: "openai-chat",
		endpoint: { defaultBaseUrl: spec.defaultBaseUrl, path: "/chat/completions" },
		auth: UNCONFIGURED_AUTH,
		request: {
			maxTokensField: spec.maxTokensField ?? "max_tokens",
			streamUsage: "include_usage",
			mergeAdjacent: true,
		},
		parts:
			spec.parts ??
			new OpenAIChatPartCodec({
				includeAssistantReasoning: Boolean(spec.includeAssistantReasoning),
			}),
		...(spec.usage ? { usage: spec.usage } : {}),
		...(spec.sampling ? { sampling: spec.sampling } : {}),
		reasoning: [spec.reasoning],
		transport: spec.transport,
	};
}

/** 建表 + 登记一步到位 —— 每份配方文件的最后一句。 */
export function defineOpenAIChatDialect(
	spec: OpenAIChatDialectSpec,
): OpenAIChatDialect {
	const dialect = openAIChatDialect(spec);
	registerDialect(dialect);
	return dialect;
}

export interface OpenAIChatProviderInit {
	/** 不给 = 用配方的 id(`custom-*` 必须给:一份配方服务任意多个自定义 id)。 */
	providerId?: string;
	baseUrl?: string;
	auth: AuthStrategy;
	fetchImpl?: FetchFn;
	requestDumper?: AgentProviderRequestDumper;
	/** 覆盖传输声明(deepseek 的 `options.capabilities`、custom-* 的旋钮)。 */
	transport?: AgentModelCapabilities;
	/** 覆盖 codec(custom-* 的 `includeAssistantReasoning` 随配置变)。 */
	parts?: PartCodec<OpenAIChatWireValue>;
	profiles?: ModelProfileResolver;
}

/**
 * 配方 + 凭据 → provider。
 *
 * `profiles` 故意是**空**的 `LedgerModelProfileResolver`(不带 `model`):
 * 静态 `capabilities` 因此仍是纯传输声明(与今天 `buildCapabilities(options)`
 * 一致),而 per-model 的账本覆盖仍由 `factory.ts` 的 `withPerModelCapabilities`
 * 在外面盖一层 —— 两次投影是幂等的(`base/__tests__/architecture.test.ts` 逐用例
 * 守着两份等价)。
 */
export function createOpenAIChatProvider(
	dialect: OpenAIChatDialect,
	init: OpenAIChatProviderInit,
): AgentProvider {
	// `ProviderContext.providerId` 是必填的:配方 id 是缺省,`custom-*` 在构造处
	// 指名。两处都没有 = 调用方给了个不完整的 options(仓里的测试有这么用的),
	// 退成空串让账本判 `'unknown'`,而不是在解析模型能力时炸。
	const providerId = init.providerId || dialect.id || "";
	const baseUrl = (init.baseUrl || dialect.endpoint.defaultBaseUrl).replace(/\/$/, "");
	const ctx: ProviderContext = {
		providerId,
		baseUrl,
		fetchImpl: init.fetchImpl ?? globalThis.fetch,
		...(init.requestDumper ? { dumper: init.requestDumper } : {}),
		logger: openAIChatLogger(providerId),
		profiles: init.profiles ?? new LedgerModelProfileResolver(),
	};
	return new OpenAIChatWire(ctx, {
		...dialect,
		auth: init.auth,
		...(init.transport ? { transport: init.transport } : {}),
		...(init.parts ? { parts: init.parts } : {}),
	});
}
