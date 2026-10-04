/**
 * OpenAI 兼容端点的**构造门面**。
 *
 * 线协议本身在 `wires/provider-openai-chat-wire.ts`(`OpenAIChatWire`),各家的差异是
 * `dialects/` 里的配方。这里只剩一件事:把老的 options 形状翻成一份方言配方
 * (设计稿 §9 P0a:「工厂函数名保留为构造门面」)。
 *
 * `reasoningStyle` 那个 `switch` 已经不存在了 —— 线型是注册表里的对象,
 * `thinkingWires.require(style)` 一句取到(§2.7:线型按账本的
 * `OnethingReasoningWire` 值建表,方言不持有线型)。
 */
import type { AgentProvider } from "@onething/backend/agent-loop";
import { ResolveAuth, thinkingWires } from "./base/provider-base.js";
import {
	createOpenAIChatProvider,
	openAIChatDialect,
	openAIChatTransportCapabilities,
	type FetchFn,
} from "./dialects/provider-dialects.js";
import { OpenAIChatPartCodec } from "./wires/provider-wires.js";
import "./thinking/provider-thinking.js";
// 搬回家的服务商的思考参数线型由名册登记(`providers/vendors/runtimes.ts`)。
import "./vendors/provider-vendor-runtimes.js";
import type { AgentProviderRequestDumper } from "./provider-request-dumper.js";

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
	 * Wire format for the request's thinking/reasoningEffort intent:已登记思考线型的 id
	 * (`thinkingWires.require` 按 id 取;协议的线型在 `thinking/`,某一家专属的在那家的
	 * `vendors/<id>/thinking.ts`,由名册登记)。每一条的行为写在它自己那个文件的抬头。
	 * 缺席 = `'none'`:请求体里一个思考参数都不发。未登记的 id 在构造时就抛。
	 */
	reasoningStyle?: string;
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
