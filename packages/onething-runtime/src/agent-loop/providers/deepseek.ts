import type {
	AgentFinishReason,
	AgentJsonObject,
	AgentMessage,
	AgentProvider,
	AgentTool,
	AgentToolChoice,
	AgentTurn,
	AgentTurnRequest,
	AgentTurnStreamEvent,
	AgentUsage,
} from "@onething/core/agent-loop";
import {
	agentContentToText,
	collectAgentTurnFromStream,
} from "@onething/core/agent-loop";
import { agentToolMessageContentToText } from "@onething/core/agent-loop";
import { mergeAdjacentSameRoleMessages } from "./message-merge.js";
import { readJsonSseData } from "./sse.js";
import { withProviderRetryAfter } from "../provider-error-classification.js";
import type { AgentProviderRequestDumper } from "./request-dump.js";

import { getLogger } from '../../logging/index.js'

const log = getLogger('providers.deepseek')

type FetchFn = typeof globalThis.fetch;

export type {
	AgentProviderRequestDump,
	AgentProviderRequestDumper,
	AgentProviderRequestDumpValue,
} from "./request-dump.js";

function previewText(
	value: string | null | undefined,
	maxLength = 240,
): string {
	return (value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function elapsedSince(
	previous: number | undefined,
	now = Date.now(),
): number | undefined {
	return previous === undefined ? undefined : now - previous;
}

export interface DeepSeekAgentProviderOptions {
	apiKey: string;
	baseUrl?: string;
	fetchImpl?: FetchFn;
	capabilities?: AgentProvider["capabilities"];
	requestDumper?: AgentProviderRequestDumper;
}

interface DeepSeekToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

interface DeepSeekMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	reasoning_content?: string;
	tool_calls?: DeepSeekToolCall[];
	tool_call_id?: string;
}

interface DeepSeekTool {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters?: AgentJsonObject;
	};
}

interface DeepSeekRequestBody {
	model: string;
	messages: DeepSeekMessage[];
	stream: true;
	stream_options: { include_usage: true };
	tools?: DeepSeekTool[];
	tool_choice?: AgentToolChoice;
	temperature?: number;
	max_tokens?: number;
	thinking?: { type: "enabled" | "disabled" };
	reasoning_effort?: "high" | "max";
}

/**
 * DeepSeek's reasoner-class models think by default; the rest do not. A caller
 * that says nothing about thinking means "whatever this model normally does",
 * and only this file knows what that is per model.
 *
 * This lived in the old facade's deepseek-only generate route, which is exactly
 * why that route could not be deleted: dropping it would have silently turned
 * thinking off for callers that never opted in (context compaction, most
 * visibly). Owning it here makes the generic path produce the same request.
 */
export function isDeepSeekThinkingModel(modelId: string): boolean {
	const lower = modelId.toLowerCase();
	return (
		lower.includes("reasoner") ||
		lower.includes("thinking") ||
		/(^|[^a-z])v4/.test(lower)
	);
}

function resolveDeepSeekThinking(
	modelId: string,
	requested: "enabled" | "disabled" | undefined,
): "enabled" | "disabled" | undefined {
	if (requested) return requested;
	return isDeepSeekThinkingModel(modelId) ? "enabled" : undefined;
}

interface DeepSeekStreamChunk {
	choices?: Array<{
		index: number;
		delta?: {
			content?: string | null;
			reasoning_content?: string | null;
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
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
		prompt_cache_hit_tokens?: number;
		prompt_cache_miss_tokens?: number;
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

function toDeepSeekMessage(message: AgentMessage): DeepSeekMessage {
	if (message.role === "tool") {
		return {
			role: "tool",
			content: agentToolMessageContentToText(message.content),
			tool_call_id: message.toolCallId ?? "",
		};
	}

	if (message.role === "assistant") {
		const content = agentContentToText(message.content);
		return {
			role: "assistant",
			content: content || null,
			...(message.reasoningContent
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

	return {
		role: message.role,
		content: agentContentToText(message.content),
	};
}

function toDeepSeekTools(
	tools: AgentTool[] | undefined,
): DeepSeekTool[] | undefined {
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

function mapFinishReason(reason: string | null | undefined): AgentFinishReason {
	switch (reason) {
		case "stop":
		case "length":
		case "content_filter":
			return reason;
		case "tool_calls":
			return "tool_calls";
		default:
			return reason ? "unknown" : "unknown";
	}
}

function usageFromChunk(chunk: DeepSeekStreamChunk): AgentUsage | undefined {
	if (!chunk.usage) return undefined;
	const cacheReadTokens = chunk.usage.prompt_cache_hit_tokens;
	return {
		inputTokens: chunk.usage.prompt_tokens,
		outputTokens: chunk.usage.completion_tokens,
		totalTokens: chunk.usage.total_tokens,
		...(cacheReadTokens ? { cacheReadTokens } : {}),
	};
}

function toolCallDoneEvent(
	turn: number,
	entry: ToolCallAccumulator,
): Extract<AgentTurnStreamEvent, { type: "tool-call-done" }> {
	const toolCall = {
		id: entry.id,
		name: entry.name,
		arguments: entry.arguments,
	};
	return { type: "tool-call-done", turn, toolCall };
}

async function* streamDeepSeekResponse(
	response: Response,
	turn: number,
): AsyncGenerator<AgentTurnStreamEvent, void, void> {
	const toolCalls = new Map<number, ToolCallAccumulator>();
	let usage: AgentUsage | undefined;
	let finishReason: AgentFinishReason = "unknown";
	const debugStream = log.isLevelEnabled("trace");
	let lastDeltaAt: number | undefined;

	for await (const chunk of readJsonSseData<DeepSeekStreamChunk>(response, {
		sourceName: "DeepSeek agent loop",
		invalidMessage: "invalid stream chunk",
	})) {
		if (chunk.error) {
			throw new Error(
				`DeepSeek agent loop error: ${chunk.error.message ?? "unknown error"}`,
			);
		}

		usage = usageFromChunk(chunk) ?? usage;
		const choice = chunk.choices?.[0];
		const delta = choice?.delta;

		if (delta?.reasoning_content) {
			if (debugStream) {
				const now = Date.now();
				log.trace("reasoning delta", {
					gapMs: elapsedSince(lastDeltaAt, now),
					turn,
					chars: delta.reasoning_content.length,
					text: previewText(delta.reasoning_content),
				});
				lastDeltaAt = now;
			}
			yield { type: "reasoning-delta", turn, delta: delta.reasoning_content };
		}

		if (delta?.content) {
			if (debugStream) {
				const now = Date.now();
				log.trace("text delta", {
					gapMs: elapsedSince(lastDeltaAt, now),
					turn,
					chars: delta.content.length,
					text: previewText(delta.content),
				});
				lastDeltaAt = now;
			}
			yield { type: "text-delta", turn, delta: delta.content };
		}

		if (delta?.tool_calls) {
			for (const toolCallDelta of delta.tool_calls) {
				const index = toolCallDelta.index;
				let entry = toolCalls.get(index);
				if (!entry) {
					// Index switch = the previous tool call's arguments are complete.
					// OpenAI-style streams emit tool calls strictly by index, so a
					// delta for a NEW index proves every earlier index is done —
					// emit their tool-call-done now so execution can start while
					// later tool calls are still rendering. (The `{}`-prefix gateway
					// hazard only applies to "first parseable prefix" heuristics;
					// an index switch is not a heuristic.)
					for (const [priorIndex, prior] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
						if (priorIndex < index && !prior.done) {
							prior.done = true;
							yield toolCallDoneEvent(turn, prior);
						}
					}
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
				// before the real arguments. Done is emitted on index switch /
				// finish_reason (above) or, as a last resort, at stream end.
			}
		}

		if (choice?.finish_reason) {
			finishReason = mapFinishReason(choice.finish_reason);
			// The provider has declared the turn over: every accumulated tool
			// call is complete. Emit done here (not after the SSE loop) so the
			// last tool call starts executing without waiting for stream teardown.
			for (const [, entry] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
				if (!entry.done) {
					entry.done = true;
					yield toolCallDoneEvent(turn, entry);
				}
			}
		}
	}

	for (const [, entry] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
		if (!entry.done) {
			yield toolCallDoneEvent(turn, entry);
		}
	}

	yield { type: "finish", turn, finishReason, usage };
}

export function createDeepSeekAgentProvider(
	options: DeepSeekAgentProviderOptions,
): AgentProvider {
	const baseUrl = (options.baseUrl || "https://api.deepseek.com").replace(
		/\/$/,
		"",
	);
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;

	async function* streamTurn(
		request: AgentTurnRequest,
	): AsyncGenerator<AgentTurnStreamEvent, void, void> {
		const tools = toDeepSeekTools(request.tools);
		const body: DeepSeekRequestBody = {
			model: request.model,
			// DeepSeek 严格要求 user/assistant 交替(reasoner 尤甚):相邻同角色
			// 在这里合成一条(C5 —— 压缩摘要注入不再垫伪造的 assistant 握手)。
			messages: mergeAdjacentSameRoleMessages(request.messages).map(
				toDeepSeekMessage,
			),
			stream: true,
			stream_options: { include_usage: true },
		};

		if (tools?.length) {
			body.tools = tools;
			body.tool_choice = request.toolChoice ?? "auto";
		}
		if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
		const thinking = resolveDeepSeekThinking(request.model, request.thinking);
		if (thinking) body.thinking = { type: thinking };
		if (thinking === "enabled") {
			// Effort defaults to high only when the caller actually asked to think.
			// Thinking that was merely INFERRED from the model name sends no effort
			// at all, which is what the chat path has always done — defaulting there
			// too would start spending on a dial nobody turned.
			const effort =
				request.reasoningEffort ??
				(request.thinking === "enabled" ? "high" : undefined);
			// DeepSeek only accepts high/max; anything lower clamps to high.
			if (effort) body.reasoning_effort = effort === "max" ? "max" : "high";
		}
		if (request.temperature !== undefined && thinking !== "enabled") {
			body.temperature = request.temperature;
		}

		const requestDumpPath = await options.requestDumper?.({
			providerId: "deepseek",
			model: request.model,
			mode: "stream",
			metadata: {
				url: `${baseUrl}/chat/completions`,
				method: "POST",
				turn: request.turn,
			},
			requestBody: body,
		});
		log.debug("stream turn request", {
			model: request.model,
			turn: request.turn,
			messageCount: request.messages.length,
			toolCount: request.tools?.length ?? 0,
			thinking: body.thinking?.type ?? "default",
			reasoningEffort: body.reasoning_effort,
			lastUserPreview: previewText(
				agentContentToText(
					[...request.messages]
						.reverse()
						.find((message) => message.role === "user")?.content ?? "",
				),
			),
			requestDumpPath,
		});

		const response = await fetchImpl(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${options.apiKey}`,
			},
			body: JSON.stringify(body),
			signal: request.abortSignal,
		});

		if (!response.ok) {
			const text = await response.text();
			// 批 B8-2:DeepSeek 走 OpenAI 那套头(`retry-after` +
			// `x-ratelimit-reset-*`),透传成绝对时间戳。
			throw withProviderRetryAfter(
				new Error(`DeepSeek agent loop API error: ${response.status} ${text}`),
				{ headers: response.headers, body: text },
			);
		}

		yield* streamDeepSeekResponse(response, request.turn);
	}

	return {
		id: "deepseek",
		capabilities: options.capabilities ?? {
			capabilities: [
				"text-input",
				"text-output",
				"streaming",
				"tool-calls",
				"reasoning",
			],
			inputModalities: ["text"],
			outputModalities: ["text"],
			supportsTools: true,
			supportsReasoning: true,
			supportsStreaming: true,
			// OpenAI-compatible tool_choice: "required"
			supportsForcedToolUse: true,
		},
		streamTurn,

		async runTurn(request: AgentTurnRequest): Promise<AgentTurn> {
			return collectAgentTurnFromStream(streamTurn(request), request.onEvent);
		},
	};
}
