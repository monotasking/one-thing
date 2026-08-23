/**
 * openai-chat 方言配方的公共构件(设计稿 §3:**Dialect = 类型化的组合配方**)。
 *
 * 每份配方是一个 `OpenAIChatDialect` 对象,字段全是策略对象;这里只提供
 * 「怎么把一份配方 + 一套凭据变成一个可用的 provider」这一步。凭据是**每次
 * 构造**才有的东西(apiKey / OAuth access token / copilot 换来的 completion
 * token),所以注册表里登记的是**不带凭据**的配方,构造时再补上 `auth`。
 */
import type {
	AgentCapability,
	AgentInputModality,
	AgentModelCapabilities,
	AgentProvider,
} from "@onething/core/agent-loop";
import {
	BearerApiKeyAuth,
	LedgerModelProfileResolver,
	registerDialect,
	type AttachmentChannel,
	type AuthStrategy,
	type Dialect,
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
	openAIChatProviderOptionsExtraBody,
	type OpenAIChatDialect,
	type OpenAIChatFilePdfMode,
	type OpenAIChatPartCodecOptions,
	type OpenAIChatProviderOptionSupport,
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
	/**
	 * user 消息里的 `file` 块(PDF)投得出去吗(P4-1,拍板 #12)。**不给 = false**。
	 *
	 * 它**故意不跟着 `vision` 走**:「看得懂图」是模型的事,「收得下 PDF 块」是
	 * 这条线序列化器的事 —— openai-chat 上只有认 `{type:'file'}` 内容块的端点
	 * (openai / openrouter,配方里 `filePdf` 开着的那两家)做得到。别家声明了
	 * `file` 就等于骗上游:core 的 `degradeUnsupportedAgentContentParts` 会把 PDF
	 * 原样递下来,codec 只能留一行 `Undeliverable` 文本。不声明,core 就在上游
	 * 降级成 `[File: x.pdf]` 占位 —— 同样留痕,但模型拿到的是一句人话。
	 */
	file?: boolean;
	/**
	 * tool 结果收得下的模态(P3-5b)。**不给 = 只有 `text`** —— 这条线的默认
	 * 是 OpenAI 官方口径(`role:'tool'` 的 `content` 只能是字符串),声明了
	 * 才谈得上「能力说行」。给了就同时把 `supportsStructuredToolResults` 声明
	 * 出来:core 的 `agentSupportsToolResultModality` 两个条件都要满足。
	 */
	toolResultModalities?: readonly AgentInputModality[];
}

/**
 * provider 的**传输**声明(数组顺序:三条基础 → vision → file → tools → reasoning)。
 * per-model 的布尔不在这里翻,那是账本(`ModelProfile`)的事。
 *
 * P4-1 起 `file` 是独立旗标:vision 只点亮 `vision-input` / `image`,`file-input`
 * / `file` 要这条线自己认领(见 `OpenAIChatTransportFlags.file`)。
 */
export function openAIChatTransportCapabilities(
	flags: OpenAIChatTransportFlags,
): AgentModelCapabilities {
	const capabilities: AgentCapability[] = ["text-input", "text-output", "streaming"];
	const inputModalities: AgentModelCapabilities["inputModalities"] = ["text"];
	const outputModalities: AgentModelCapabilities["outputModalities"] = ["text"];

	if (flags.vision) {
		capabilities.push("vision-input");
		inputModalities.push("image");
	}
	if (flags.file) {
		capabilities.push("file-input");
		inputModalities.push("file");
	}
	if (flags.tools !== false) capabilities.push("tool-calls");
	if (flags.reasoning) capabilities.push("reasoning");

	return {
		capabilities,
		inputModalities,
		outputModalities,
		...(flags.toolResultModalities
			? {
					toolResultModalities: [...flags.toolResultModalities],
					supportsStructuredToolResults: flags.tools !== false,
				}
			: {}),
		supportsTools: flags.tools !== false,
		supportsReasoning: Boolean(flags.reasoning),
		supportsStreaming: true,
		// tool_choice: "required" is part of the OpenAI chat-completions
		// contract every endpoint on this adapter claims to speak.
		supportsForcedToolUse: flags.tools !== false,
	};
}

/**
 * `prompt_cache_key` —— 服务端 prompt 缓存的路由键(设计稿 §5.1)。
 *
 * OpenAI / xAI(grok、grok-oauth)/ Kimi(开放平台与 Code Plan)/ OpenRouter
 * 认这个字段:同一个键的请求会被路由到同一台机器上,前缀命中率因此从「碰运气」
 * 变成「常态」;Kimi Code Plan 更是把它列为必填。宿主给的值是**会话 id**
 * (`AgentTurnRequest.cacheKey`)—— 不透明标识符,不含任何会话内容。
 *
 * 不认这个字段的家(deepseek / zhipu / qwen / github-copilot / custom-*)一个
 * 字节都不多发:挂不挂这一行就是「发不发」的全部开关。
 */
export const promptCacheKeyExtraBody: NonNullable<Dialect["extraBody"]> = (turn) =>
	turn.request.cacheKey ? { prompt_cache_key: turn.request.cacheKey } : {};

export interface OpenAIChatDialectSpec {
	id: string;
	defaultBaseUrl: string;
	maxTokensField?: "max_tokens" | "max_completion_tokens";
	/** 这家走哪条思考线型(一家一条,由 `ModelProfile.reasoningWire` 选中或兜底)。 */
	reasoning: ThinkingWire;
	/** 多轮是否回传 `reasoning_content`。 */
	includeAssistantReasoning?: boolean;
	/**
	 * 多轮是否回传 `reasoning_details[]`(P3-4)。**只有 OpenRouter 开** ——
	 * 那些项挂在 `provider:'openrouter'` 名下,别家开了也拼不出东西,但字段
	 * 本身是这条线上 OpenRouter 独有的,所以按家声明而不是默认全开。
	 */
	replayReasoningDetails?: boolean;
	/**
	 * PDF 文件块怎么投(P3-1)。**不给 = `'none'`**:只有确认收得下 `file` 块的
	 * 端点才开(openai / openrouter),其余家保持可见留痕。
	 */
	filePdf?: OpenAIChatFilePdfMode;
	/**
	 * tool 结果收不收多模态块(P3-5b)。**只有 OpenRouter 开** —— 它的文档
	 * 明说 `role:'tool'` 的 `content` 可以是内容块数组;OpenAI 官方只允许
	 * 字符串。要开就得同时在 `transport` 里声明 `toolResultModalities`:
	 * 「能力说行」与「线协议做得到」是同一句话的两半(设计稿 §2.3)。
	 */
	toolResultMultimodal?: boolean;
	/** 换掉整只 codec(DeepSeek 的纯文本 user 内容)。 */
	parts?: PartCodec<OpenAIChatWireValue>;
	/**
	 * 序列化之前跑的附件通道(P4-6)。今天唯一的用户是 Kimi 的「先上传再抽取」
	 * (`dialects/kimi-attachments.ts`)。
	 */
	attachments?: AttachmentChannel;
	/**
	 * 这条线靠**抽取**收文件(P4-6)。
	 *
	 * 与 `filePdf` 是两条互斥的路:`filePdf` 说的是「codec 投得出 `file` 内容块」
	 * (openai / openrouter),`fileViaExtraction` 说的是「附件在序列化之前就被
	 * 换成文本了」(kimi / kimi-code)。声明它的后果只有一个,而且只在能力那一侧:
	 * 账本的 `fileInput` 对这条线**没有否决权** —— 模型自始至终只见到文本,
	 * 「这个模型的目录里有没有 pdf」不是判据(models.dev 给 Kimi 的
	 * `modalities.input` 只有 text/image,让它说了算的话文件永远进不来)。
	 * 仍然要和 `transport` 的 `file: true` 一起给:能力说行与线路做得到是同一句
	 * 话的两半(设计稿 §2.3)。
	 */
	fileViaExtraction?: boolean;
	/**
	 * 这家在流上多解出来的事件(OpenRouter 的 `images[]`)。挂在默认 codec 的
	 * `decodeExtras` 上;`parts` 自带整只 codec 的家自己带这一条。
	 */
	decodeExtras?: OpenAIChatPartCodecOptions["decodeExtras"];
	/** 换掉 usage 直译表(DeepSeek 的 `prompt_cache_hit_tokens`)。 */
	usage?: UsageNormalizer;
	/** 换掉采样策略(DeepSeek 的 thinking 是**推断**出来的)。 */
	sampling?: SamplingPolicy;
	/** 这家自己的「用户意图 → thinking/effort」家规(Kimi)。 */
	thinkingIntent?: Dialect["thinkingIntent"];
	/** 这家的额外请求体字段(`prompt_cache_key` 等,见 `Dialect.extraBody`)。 */
	extraBody?: Dialect["extraBody"];
	/**
	 * 请求级 providerOptions 袋这家认哪些键(P3-3)。**一处声明,两处派生**:
	 * codec 的 `imageDetail` 与请求体那半边的白名单都从这一份来,于是两处对
	 * 「什么算白名单」永远同解。不给 = 一个键都不认(袋里有东西照样留痕)。
	 */
	providerOptions?: OpenAIChatProviderOptionSupport;
	transport: AgentModelCapabilities;
}

/**
 * 白名单那一支**每家都挂**:认不出的键要留痕,不能因为「这家没有旋钮」就把
 * 用户写进 settings.json 的东西静默吞掉。配方自己的 `extraBody` 先跑,袋那支
 * 的结果后并 —— 袋是逃生舱,不该压过配方自己的字段。
 */
function composeExtraBody(spec: OpenAIChatDialectSpec): Dialect["extraBody"] {
	const bag = openAIChatProviderOptionsExtraBody(spec.providerOptions ?? {});
	const own = spec.extraBody;
	if (!own) return bag;
	return (turn) => ({ ...own(turn), ...bag(turn) });
}

export function openAIChatDialect(spec: OpenAIChatDialectSpec): OpenAIChatDialect {
	return {
		id: spec.id,
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
				replayReasoningDetails: Boolean(spec.replayReasoningDetails),
				filePdf: spec.filePdf ?? "none",
				...(spec.toolResultMultimodal ? { toolResultMultimodal: true } : {}),
				...(spec.providerOptions?.imageDetail === undefined
					? {}
					: { imageDetail: spec.providerOptions.imageDetail }),
				...(spec.decodeExtras ? { decodeExtras: spec.decodeExtras } : {}),
			}),
		...(spec.usage ? { usage: spec.usage } : {}),
		...(spec.sampling ? { sampling: spec.sampling } : {}),
		...(spec.thinkingIntent ? { thinkingIntent: spec.thinkingIntent } : {}),
		...(spec.attachments ? { attachments: spec.attachments } : {}),
		extraBody: composeExtraBody(spec),
		reasoning: [spec.reasoning],
		transport: spec.transport,
		...(spec.fileViaExtraction ? { fileViaExtraction: true } : {}),
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
 * `profiles` 由构造处注入(`factory.ts` 的 `ledgerProfiles(config)`):
 * per-model 的能力从此只有它一个来源(P2-a,`withPerModelCapabilities` 已退役)。
 * 它**故意不带 `model`**,`defaultProfile()` 因此给不出默认档 —— 静态
 * `capabilities` 仍是纯传输声明,与今天一致。不给 `profiles` 就退成一个空账本
 * 解析器(直接调这个函数的测试就是这样)。
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
