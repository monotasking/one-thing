/**
 * `Dialect` —— **类型化的组合配方,不是被解释的字符串表**(设计稿 §3 / §3.1)。
 *
 * 每个字段要么是策略对象,要么是端点/请求形状这类纯数据;基类只调用接口,
 * **从不解释字符串枚举**(架构测试:`base/` 下不得出现 `switch (dialect.` /
 * `dialect.* === '`)。需要代码的 provider 允许薄子类,但不许为了「每家一个
 * 类」而造空子类。
 */
import type { AuthStrategy } from "./auth-strategy.js";
import type { CachePolicy } from "./cache-policy.js";
import type { ErrorMapper } from "./errors.js";
import type { PartCodec } from "./part-codec.js";
import type { SamplingPolicy } from "./sampling-policy.js";
import type { ThinkingWire } from "./thinking-wire.js";
import type { ToolChoicePolicy } from "./tool-choice-policy.js";
import type { TurnContext } from "./turn-context.js";
import type { UsageNormalizer } from "./usage.js";

/** 线协议四条 —— 一条一个类,管线写死在模板方法里。 */
export type WireId =
	| "openai-chat"
	| "openai-responses"
	| "anthropic-messages"
	| "gemini-generateContent";

export interface DialectEndpoint {
	defaultBaseUrl: string;
	/** 挂在 baseUrl 之后的路径,带前导斜杠(`/chat/completions`)。 */
	path: string;
	/** 需要往 URL 上挂东西的(Gemini 的 `?key=`、`:streamGenerateContent`)。 */
	decorateUrl?(url: string, turn: TurnContext): string;
	/** 落盘前的脱敏(Gemini 的 `key=`)。不给 = 原样。 */
	redactForDump?(url: string): string;
}

export interface DialectRequestShape {
	maxTokensField: "max_tokens" | "max_completion_tokens";
	/**
	 * usage 怎么要:`include_usage` = 发 `stream_options.include_usage`;
	 * `always` = 端点恒返回不用要(OpenRouter);`none` = 这条线没有这个概念。
	 */
	streamUsage: "include_usage" | "always" | "none";
	/** 相邻同角色消息先合并(严格交替的端点必须开)。 */
	mergeAdjacent: boolean;
}

/**
 * 用户意图那一侧的输入 —— 设置里的两张 per-model 表。形状与
 * `thinking-options.ts` 的 `OnethingAgentLoopThinkingProviderConfig` 结构等价
 * (那边的类型是公开契约,这边不 import 它:`base/` 不该反向依赖上一层)。
 */
export interface DialectThinkingConfig {
	model: string;
	thinkingByModel?: Record<string, boolean | undefined>;
	thinkingEffortByModel?: Record<string, unknown>;
}

/** 归一化后的意图。线型编码器再把它翻成各家的请求体字段。 */
export interface DialectThinkingIntent {
	thinking?: "enabled" | "disabled";
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface Dialect<W = unknown> {
	id: string;
	wire: WireId;
	endpoint: DialectEndpoint;
	auth: AuthStrategy;
	request: DialectRequestShape;
	/** 不给 = 用 wire 的默认 codec。 */
	parts?: PartCodec<W>;
	usage?: UsageNormalizer;
	/** 这家可能出现的思考线型;走哪条由 `ModelProfile.reasoningWire` 选。 */
	reasoning: ThinkingWire[];
	errors?: ErrorMapper;
	toolChoice?: ToolChoicePolicy;
	sampling?: SamplingPolicy;
	cache?: CachePolicy;
	/** 逃生舱:方言自己的额外字段,也接受宿主/设置注入的 providerOptions。 */
	extraBody?: (turn: TurnContext) => Record<string, unknown>;
	/**
	 * 用户意图 → 归一化的 thinking/effort,**这一家自己说了算**。
	 *
	 * 不给 = 走通用规则(`thinkingByModel` 决定开关,`thinkingEffortByModel`
	 * 决定档位)。给了就是这家的家规:Kimi 的三族模型(k3 只认
	 * `reasoning_effort:'max'`、k2.7-code/k2-thinking 一个参数都不能发、
	 * k2.5/k2.6 走 `thinking.type`)以前是 `thinking-options.ts` 里一句
	 * `providerId === 'kimi'` 的分支。
	 */
	thinkingIntent?(
		config: DialectThinkingConfig,
		model: string,
	): DialectThinkingIntent;
}

const dialects = new Map<string, Dialect>();

/** 返回一个注销函数 —— 测试里注册完就能收干净。 */
export function registerDialect<W>(dialect: Dialect<W>): () => void {
	const stored = dialect as Dialect;
	dialects.set(dialect.id, stored);
	return () => {
		if (dialects.get(dialect.id) === stored) dialects.delete(dialect.id);
	};
}

export function getDialect(id: string): Dialect | undefined {
	return dialects.get(id);
}

export function listDialects(): Dialect[] {
	return [...dialects.values()];
}
