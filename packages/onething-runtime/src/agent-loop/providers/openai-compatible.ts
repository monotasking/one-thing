import { collectAgentTurnFromStream } from "@onething/core/agent-loop";
import { agentToolMessageContentToText } from "@onething/core/agent-loop";
import { undeliverableAttachmentText } from "@onething/core/agent-loop";
import { mergeAdjacentSameRoleMessages } from "./message-merge.js";
import { readJsonSseData } from "./sse.js";
import { withProviderRetryAfter } from "../provider-error-classification.js";
import type {
	AgentContentPart,
	AgentFinishReason,
	AgentJsonObject,
	AgentMessage,
	AgentMessageContent,
	AgentModelCapabilities,
	AgentProvider,
	AgentTool,
	AgentToolChoice,
	AgentTurn,
	AgentTurnRequest,
	AgentTurnStreamEvent,
	AgentUsage,
} from "@onething/core/agent-loop";
import type { AgentProviderRequestDumper } from "./request-dump.js";

type FetchFn = typeof globalThis.fetch;

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
	 * Wire format for the request's thinking/reasoningEffort intent:
	 * - 'thinking-type': `thinking: {type}` + `reasoning_effort` passthrough
	 *   (Kimi and other DeepSeek-style endpoints)
	 * - 'openai-effort': `reasoning_effort` minimal|low|medium|high (OpenAI
	 *   o-series / gpt-5; xhigh and max clamp to high; reasoning cannot be
	 *   disabled, so 'disabled' emits nothing)
	 * - 'zhipu-thinking': `thinking: {type}` only (GLM-4.5+; no effort knob)
	 * - 'qwen-thinking': `enable_thinking` boolean (千问 AI 平台 / QwenCloud).
	 *   `reasoning_effort` rides along only for the families that accept it —
	 *   low|medium|xhigh on qwen3.8-max, high|max on the resold GLM/DeepSeek —
	 *   because every other model there is thinking_budget-driven and rejects
	 *   the pair.
	 * - 'grok-effort': `reasoning_effort` low|medium|high(+xhigh on 4.20);
	 *   reasoning cannot be disabled, so 'disabled' emits nothing
	 * - 'openrouter-reasoning': unified `reasoning: {effort}` object,
	 *   `reasoning: {enabled: false}` on disable
	 * - 'none' (default): never emit thinking parameters
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

type OpenAICompatibleMessage =
	| {
			role: "system";
			content: string;
	  }
	| {
			role: "user";
			content: string | OpenAICompatibleUserContentPart[];
	  }
	| {
			role: "assistant";
			content: string | null;
			reasoning_content?: string;
			tool_calls?: Array<{
				id: string;
				type: "function";
				function: {
					name: string;
					arguments: string;
				};
			}>;
	  }
	| {
			role: "tool";
			tool_call_id: string;
			content: string;
	  };

interface OpenAICompatibleTool {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters?: AgentJsonObject;
	};
}

type OpenAICompatibleUserContentPart =
	| { type: "text"; text: string }
	| { type: "image_url"; image_url: { url: string } };

interface OpenAICompatibleRequestBody {
	model: string;
	messages: OpenAICompatibleMessage[];
	stream: true;
	stream_options: { include_usage: true };
	tools?: OpenAICompatibleTool[];
	tool_choice?: AgentToolChoice;
	max_tokens?: number;
	max_completion_tokens?: number;
	temperature?: number;
	thinking?: { type: "enabled" | "disabled" };
	reasoning_effort?: string;
	reasoning?: { effort?: string; enabled?: boolean };
	enable_thinking?: boolean;
}

interface OpenAICompatibleStreamChunk {
	choices?: Array<{
		index: number;
		delta?: {
			content?: string | null;
			reasoning_content?: string | null;
			reasoning?: string | null;
			tool_calls?: Array<{
				index: number;
				id?: string;
				type?: "function";
				function?: {
					name?: string;
					arguments?: string;
				};
			}>;
		};
		finish_reason?: string | null;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number };
		completion_tokens_details?: { reasoning_tokens?: number };
	};
	error?: {
		message?: string;
		type?: string;
		code?: string;
	};
}

interface ToolCallAccumulator {
	id: string;
	name: string;
	arguments: string;
	started: boolean;
	done: boolean;
}

function dataContentToImageUrl(data: string, mediaType?: string): string {
	if (
		data.startsWith("data:") ||
		data.startsWith("http://") ||
		data.startsWith("https://")
	) {
		return data;
	}
	return `data:${mediaType || "image/png"};base64,${data}`;
}

function contentToText(content: AgentMessageContent): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is Extract<AgentContentPart, { type: "text" }> =>
				part.type === "text",
		)
		.map((part) => part.text)
		.filter(Boolean)
		.join("\n");
}

function toUserContent(
	content: AgentMessageContent,
): OpenAICompatibleMessage & { role: "user" } {
	if (typeof content === "string") return { role: "user", content };
	if (!Array.isArray(content)) return { role: "user", content: "" };

	const parts: OpenAICompatibleUserContentPart[] = [];
	for (const part of content) {
		if (part.type === "text") {
			parts.push({ type: "text", text: part.text });
			continue;
		}
		if (part.type === "image") {
			const imageUrl = dataContentToImageUrl(part.image, part.mediaType);
			parts.push({ type: "image_url", image_url: { url: imageUrl } });
			continue;
		}
		if (part.type === "file") {
			if (part.mediaType.startsWith("image/")) {
				const imageUrl = dataContentToImageUrl(part.data, part.mediaType);
				parts.push({ type: "image_url", image_url: { url: imageUrl } });
				continue;
			}
			// Chat-completions endpoints have no portable file part; text files
			// are inlined upstream, so surface the leftover binary explicitly
			// instead of silently dropping it.
			parts.push({ type: "text", text: undeliverableAttachmentText(part) });
		}
	}

	return {
		role: "user",
		content: parts.length > 0 ? parts : "",
	};
}

function toOpenAICompatibleMessages(
	messages: AgentMessage[],
	includeAssistantReasoning: boolean,
): OpenAICompatibleMessage[] {
	return messages.map((message): OpenAICompatibleMessage => {
		if (message.role === "tool") {
			return {
				role: "tool",
				tool_call_id: message.toolCallId ?? "",
				content: agentToolMessageContentToText(message.content),
			};
		}

		if (message.role === "assistant") {
			const content = contentToText(message.content);
			return {
				role: "assistant",
				content: content || null,
				...(includeAssistantReasoning && message.reasoningContent
					? { reasoning_content: message.reasoningContent }
					: {}),
				...(message.toolCalls?.length
					? {
							tool_calls: message.toolCalls.map((toolCall) => ({
								id: toolCall.id,
								type: "function" as const,
								function: {
									name: toolCall.name,
									arguments: toolCall.arguments,
								},
							})),
						}
					: {}),
			};
		}

		if (message.role === "user") {
			return toUserContent(message.content);
		}

		return {
			role: "system",
			content: contentToText(message.content),
		};
	});
}

function toOpenAICompatibleTools(
	tools: AgentTool[] | undefined,
): OpenAICompatibleTool[] | undefined {
	if (!tools?.length) return undefined;
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	}));
}

function normalizeToolChoice(
	choice: AgentToolChoice | undefined,
): AgentToolChoice | undefined {
	if (!choice || choice === "auto" || choice === "none") return choice;
	return choice;
}

function mapFinishReason(reason: string | null | undefined): AgentFinishReason {
	switch (reason) {
		case "stop":
		case "length":
			return reason;
		case "tool_calls":
		case "function_call":
			return "tool_calls";
		case "content_filter":
			return "content_filter";
		default:
			return reason ? "unknown" : "unknown";
	}
}

function usageFromChunk(
	chunk: OpenAICompatibleStreamChunk,
): AgentUsage | undefined {
	if (!chunk.usage) return undefined;
	const inputTokens = chunk.usage.prompt_tokens ?? 0;
	const outputTokens = chunk.usage.completion_tokens ?? 0;
	const totalTokens = chunk.usage.total_tokens ?? inputTokens + outputTokens;
	const cacheReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens;
	const reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens;
	return {
		inputTokens,
		outputTokens,
		totalTokens,
		...(cacheReadTokens ? { cacheReadTokens } : {}),
		...(reasoningTokens ? { reasoningTokens } : {}),
	};
}

function createOpenAICompatibleApiError(
	providerId: string,
	status: number,
	responseBody: string,
	headers?: Headers,
): Error & {
	responseBody: string;
	data: { providerId: string; statusCode: number; responseBody: string };
	retryAfterAt?: number;
} {
	// 批 B8-2:OpenAI 系用 `retry-after` + `x-ratelimit-reset-requests/-tokens`
	// (Go duration,`6m0s` / `2m59.56s`)。`retryAfterAt` 挂**顶层**,与
	// `statusCode` 藏在 data 里的老习惯不同 —— 那是既有形状,不去动它。
	return withProviderRetryAfter(
		Object.assign(
			new Error(`${providerId} agent loop API error: ${status} ${responseBody}`),
			{
				responseBody,
				data: {
					providerId,
					statusCode: status,
					responseBody,
				},
			},
		),
		{ headers, body: responseBody },
	);
}

function toolCallDoneEvent(
	turn: number,
	entry: ToolCallAccumulator,
): Extract<AgentTurnStreamEvent, { type: "tool-call-done" }> {
	return {
		type: "tool-call-done",
		turn,
		toolCall: {
			id: entry.id,
			name: entry.name,
			arguments: entry.arguments,
		},
	};
}

async function* streamOpenAICompatibleResponse(
	response: Response,
	turn: number,
	providerId: string,
): AsyncGenerator<AgentTurnStreamEvent, void, void> {
	const toolCalls = new Map<number, ToolCallAccumulator>();
	let usage: AgentUsage | undefined;
	let finishReason: AgentFinishReason = "unknown";

	for await (const chunk of readJsonSseData<OpenAICompatibleStreamChunk>(
		response,
		{
			sourceName: `${providerId} agent loop`,
			invalidMessage: "invalid stream chunk",
		},
	)) {
		if (chunk.error) {
			throw new Error(
				`${providerId} agent loop error: ${chunk.error.message ?? "unknown error"}`,
			);
		}

		usage = usageFromChunk(chunk) ?? usage;
		const choice = chunk.choices?.[0];
		const delta = choice?.delta;

		const reasoning = delta?.reasoning_content ?? delta?.reasoning;
		if (reasoning) {
			yield { type: "reasoning-delta", turn, delta: reasoning };
		}

		if (delta?.content) {
			yield { type: "text-delta", turn, delta: delta.content };
		}

		if (delta?.tool_calls) {
			for (const toolCallDelta of delta.tool_calls) {
				const index = toolCallDelta.index;
				let entry = toolCalls.get(index);
				if (!entry) {
					entry = {
						id: toolCallDelta.id ?? `tool-${turn}-${index}`,
						name: "",
						arguments: "",
						started: false,
						done: false,
					};
					toolCalls.set(index, entry);
				}

				if (toolCallDelta.id) entry.id = toolCallDelta.id;
				if (toolCallDelta.function?.name)
					entry.name += toolCallDelta.function.name;
				const argumentsDelta = toolCallDelta.function?.arguments ?? "";
				if (argumentsDelta) entry.arguments += argumentsDelta;

				if (!entry.started && entry.name) {
					entry.started = true;
					yield {
						type: "tool-call-start",
						turn,
						toolCallId: entry.id,
						toolName: entry.name,
					};
				}

				if (argumentsDelta && entry.name) {
					yield {
						type: "tool-call-delta",
						turn,
						toolCallId: entry.id,
						toolName: entry.name,
						argumentsDelta,
					};
				}

				// No early-done on first parseable prefix: gateways may send `{}`
				// before the real arguments. Done is emitted once at stream end.
			}
		}

		if (choice?.finish_reason) {
			finishReason = mapFinishReason(choice.finish_reason);
		}
	}

	for (const [, entry] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
		if (!entry.done) {
			yield toolCallDoneEvent(turn, entry);
		}
	}

	yield { type: "finish", turn, finishReason, usage };
}

function buildCapabilities(
	options: OpenAICompatibleAgentProviderOptions,
): AgentModelCapabilities {
	const capabilities: AgentModelCapabilities["capabilities"] = [
		"text-input",
		"text-output",
		"streaming",
	];
	const inputModalities: AgentModelCapabilities["inputModalities"] = ["text"];
	const outputModalities: AgentModelCapabilities["outputModalities"] = ["text"];

	if (options.supportsVision) {
		capabilities.push("vision-input", "file-input");
		inputModalities.push("image", "file");
	}
	if (options.supportsTools !== false) {
		capabilities.push("tool-calls");
	}
	if (options.supportsReasoning) {
		capabilities.push("reasoning");
	}

	return {
		capabilities,
		inputModalities,
		outputModalities,
		supportsTools: options.supportsTools !== false,
		supportsReasoning: Boolean(options.supportsReasoning),
		supportsStreaming: true,
		// tool_choice: "required" is part of the OpenAI chat-completions
		// contract every endpoint on this adapter claims to speak.
		supportsForcedToolUse: options.supportsTools !== false,
	};
}

function clampOpenAIReasoningEffort(
	effort: string | undefined,
): "minimal" | "low" | "medium" | "high" {
	if (effort === "minimal" || effort === "low" || effort === "medium") return effort;
	return "high";
}

function clampGrokReasoningEffort(
	effort: string | undefined,
	model: string,
): "low" | "medium" | "high" | "xhigh" {
	if (effort === "minimal" || effort === "low") return "low";
	if (effort === "medium") return "medium";
	// xhigh is only accepted by the grok-4.20 multi-agent family; everything
	// else tops out at high.
	if ((effort === "xhigh" || effort === "max") && model.toLowerCase().includes("4.20")) {
		return "xhigh";
	}
	return "high";
}

/**
 * 千问 only accepts reasoning_effort on the families that document it, and
 * qwen3.8-max errors when effort and thinking_budget arrive together — so
 * anything else returns undefined and rides the server-side default budget.
 */
function clampQwenReasoningEffort(
	effort: string | undefined,
	model: string,
): string | undefined {
	if (!effort) return undefined;
	const lower = model.toLowerCase();
	if (lower.includes("qwen3.8-max")) {
		if (effort === "minimal" || effort === "low") return "low";
		if (effort === "medium") return "medium";
		return "xhigh";
	}
	if (/^glm-|^deepseek-v[34]/.test(lower)) {
		return effort === "max" || effort === "xhigh" ? "max" : "high";
	}
	return undefined;
}

function applyReasoningParams(
	body: OpenAICompatibleRequestBody,
	style: NonNullable<OpenAICompatibleAgentProviderOptions["reasoningStyle"]>,
	request: AgentTurnRequest,
): void {
	switch (style) {
		case "thinking-type":
			if (request.thinking) body.thinking = { type: request.thinking };
			if (request.reasoningEffort) body.reasoning_effort = request.reasoningEffort;
			break;
		case "openai-effort":
			if (request.thinking === "enabled") {
				body.reasoning_effort = clampOpenAIReasoningEffort(request.reasoningEffort);
			}
			break;
		case "zhipu-thinking":
			if (request.thinking) body.thinking = { type: request.thinking };
			break;
		case "qwen-thinking":
			if (request.thinking === "enabled") {
				body.enable_thinking = true;
				const qwenEffort = clampQwenReasoningEffort(
					request.reasoningEffort,
					body.model,
				);
				if (qwenEffort) body.reasoning_effort = qwenEffort;
			} else if (request.thinking === "disabled") {
				body.enable_thinking = false;
			}
			break;
		case "grok-effort":
			if (request.thinking === "enabled") {
				body.reasoning_effort = clampGrokReasoningEffort(
					request.reasoningEffort,
					body.model,
				);
			}
			break;
		case "openrouter-reasoning":
			if (request.thinking === "enabled") {
				body.reasoning = { effort: request.reasoningEffort ?? "high" };
			} else if (request.thinking === "disabled") {
				body.reasoning = { enabled: false };
			}
			break;
		case "none":
			break;
	}
}

export function createOpenAICompatibleAgentProvider(
	options: OpenAICompatibleAgentProviderOptions,
): AgentProvider {
	const baseUrl = (options.baseUrl || options.defaultBaseUrl).replace(
		/\/$/,
		"",
	);
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const capabilities = buildCapabilities(options);

	async function* streamTurn(
		request: AgentTurnRequest,
	): AsyncGenerator<AgentTurnStreamEvent, void, void> {
		const tools = toOpenAICompatibleTools(request.tools);
		const body: OpenAICompatibleRequestBody = {
			model: request.model,
			// 这条适配层同时服务一批 OpenAI 方言端点,其中包含要求 user/assistant
			// 严格交替的(DeepSeek 兼容端点走的就是这里)。相邻同角色先合成一条 ——
			// 对宽松的端点是无害的等价改写,对严格的端点是能不能发出去的分界。
			messages: toOpenAICompatibleMessages(
				mergeAdjacentSameRoleMessages(request.messages),
				Boolean(options.includeAssistantReasoning),
			),
			stream: true,
			stream_options: { include_usage: true },
		};

		if (tools?.length) {
			body.tools = tools;
			body.tool_choice = normalizeToolChoice(request.toolChoice) ?? "auto";
		}
		if (request.maxTokens !== undefined) {
			body[options.maxTokensField ?? "max_tokens"] = request.maxTokens;
		}
		applyReasoningParams(body, options.reasoningStyle ?? "none", request);
		// Thinking-enabled requests omit temperature (same rule as the
		// DeepSeek provider; Kimi thinking models reject custom temperature).
		if (request.temperature !== undefined && request.thinking !== "enabled") {
			body.temperature = request.temperature;
		}

		const resolvedAuth = options.resolveAuth
			? await options.resolveAuth()
			: undefined;
		const apiKey = resolvedAuth?.apiKey ?? options.apiKey ?? "";
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			...options.headers,
			...resolvedAuth?.headers,
		};

		await options.requestDumper?.({
			providerId: options.providerId,
			model: request.model,
			mode: "stream",
			metadata: {
				url: `${baseUrl}/chat/completions`,
				method: "POST",
				turn: request.turn,
			},
			requestBody: body,
		});

		const response = await fetchImpl(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: request.abortSignal,
		});

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw createOpenAICompatibleApiError(
				options.providerId,
				response.status,
				text,
				response.headers,
			);
		}

		yield* streamOpenAICompatibleResponse(
			response,
			request.turn,
			options.providerId,
		);
	}

	return {
		id: options.providerId,
		capabilities,
		getModelCapabilities: () => capabilities,
		streamTurn,
		async runTurn(request: AgentTurnRequest): Promise<AgentTurn> {
			return collectAgentTurnFromStream(streamTurn(request), request.onEvent);
		},
	};
}
