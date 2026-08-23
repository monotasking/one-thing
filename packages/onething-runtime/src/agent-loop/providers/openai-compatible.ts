/**
 * OpenAI 兼容端点的**构造门面**。
 *
 * 线协议本身在 `wires/openai-chat-wire.ts`(`OpenAIChatWire`),各家的差异是
 * `dialects/` 里的配方。这里只剩一件事:把老的 options 形状翻成一份方言配方
 * (设计稿 §9 P0a:「工厂函数名保留为构造门面」)。
 *
 * `reasoningStyle` 那个 `switch` 已经不存在了 —— 线型是注册表里的对象,
 * `thinkingWires.require(style)` 一句取到(§2.7:线型按账本的
 * `OnethingReasoningWire` 值建表,方言不持有线型)。
 */
import type { AgentProvider } from "@onething/core/agent-loop";
import { ResolveAuth, thinkingWires } from "./base/index.js";
import {
	createOpenAIChatProvider,
	openAIChatDialect,
	openAIChatTransportCapabilities,
	type FetchFn,
} from "./dialects/index.js";
import { OpenAIChatPartCodec } from "./wires/index.js";
import "./thinking/index.js";
import type { AgentProviderRequestDumper } from "./request-dump.js";

export interface OpenAICompatibleAgentProviderOptions {
	providerId: string;
	apiKey?: string;
	baseUrl?: string;
	defaultBaseUrl: string;
	fetchImpl?: FetchFn;
	headers?: Record<string, string>;
	resolveAuth?: () => Promise<{
		apiKey?: string;
		headers?: Record<string, string>;
	}>;
	supportsVision?: boolean;
	supportsReasoning?: boolean;
	supportsTools?: boolean;
	maxTokensField?: "max_tokens" | "max_completion_tokens";
	includeAssistantReasoning?: boolean;
	/**
	 * Wire format for the request's thinking/reasoningEffort intent. 取值就是
	 * `thinking/` 里那几条线型的 id —— 每一条的行为写在它自己那个文件的抬头:
	 * - 'thinking-type'         `thinking: {type}` + `reasoning_effort` 透传
	 * - 'openai-effort'         `reasoning_effort`,xhigh/max 夹到 high
	 * - 'zhipu-thinking'        只有 `thinking: {type}`
	 * - 'qwen-thinking'         `enable_thinking` 布尔,effort 只给收它的族
	 * - 'grok-effort'           `reasoning_effort`,xhigh 只给 4.20 族
	 * - 'openrouter-reasoning'  统一的 `reasoning: {}` 对象
	 * - 'none'(默认)          请求体里一个思考参数都不发
	 */
	reasoningStyle?:
		| "thinking-type"
		| "openai-effort"
		| "zhipu-thinking"
		| "qwen-thinking"
		| "grok-effort"
		| "openrouter-reasoning"
		| "none";
	requestDumper?: AgentProviderRequestDumper;
}

export function createOpenAICompatibleAgentProvider(
	options: OpenAICompatibleAgentProviderOptions,
): AgentProvider {
	const dialect = openAIChatDialect({
		id: options.providerId,
		defaultBaseUrl: options.defaultBaseUrl,
		...(options.maxTokensField ? { maxTokensField: options.maxTokensField } : {}),
		reasoning: thinkingWires.require(options.reasoningStyle ?? "none"),
		parts: new OpenAIChatPartCodec({
			includeAssistantReasoning: Boolean(options.includeAssistantReasoning),
		}),
		transport: openAIChatTransportCapabilities({
			...(options.supportsTools === undefined ? {} : { tools: options.supportsTools }),
			...(options.supportsVision === undefined ? {} : { vision: options.supportsVision }),
			...(options.supportsReasoning === undefined
				? {}
				: { reasoning: options.supportsReasoning }),
		}),
	});

	return createOpenAIChatProvider(dialect, {
		providerId: options.providerId,
		...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
		// 头的叠加顺序逐字保留:Content-Type → Authorization → options.headers
		// → resolveAuth() 交回来的头(后者可以盖前者)。
		auth: new ResolveAuth(
			options.resolveAuth ? () => options.resolveAuth!() : async () => undefined,
			{
				...(options.apiKey ? { apiKey: options.apiKey } : {}),
				...(options.headers ? { headers: options.headers } : {}),
			},
		),
		...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
		...(options.requestDumper ? { requestDumper: options.requestDumper } : {}),
	});
}
