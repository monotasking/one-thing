/**
 * Single-round replay (L1 workflow, scenario A: 定位原因).
 *
 * A round's decision is fully determined by that round's request —
 * replaying it needs NO loop, NO tool execution, NO environment: resend
 * the recorded request verbatim (or an edited variant) and look at the
 * model's first decision. Historical tool results are bytes inside the
 * request; nothing gets re-executed, so nothing can diverge.
 */

import type { EvalChatMessage, EvalModelCaller } from "./model-call.js";
import { stringifyToolValue } from "./mock-tools.js";
import type { HydratedTraceRound } from "./trace-store.js";

/** Structural view of a traced AgentMessage (stored as unknown). */
interface TracedMessageLike {
	role?: string;
	content?: unknown;
	reasoningContent?: string;
	toolCalls?: Array<{ id?: string; name?: string; arguments?: unknown }>;
	toolCallId?: string;
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (content == null) return "";
	if (Array.isArray(content)) {
		// AgentContentPart[]: keep text parts, mark non-text (images) —
		// multimodal fidelity is a known limitation.
		return content
			.map((part) => {
				const p = part as { type?: string; text?: string };
				if (p?.type === "text" && typeof p.text === "string") return p.text;
				return `[${p?.type ?? "non-text"} content]`;
			})
			.join("\n");
	}
	return stringifyToolValue(content);
}

/**
 * Map traced AgentMessages to model-caller messages with the full
 * tool-calling protocol preserved.
 */
export function tracedMessagesToEvalMessages(
	messages: unknown[],
): EvalChatMessage[] {
	const out: EvalChatMessage[] = [];
	let synthetic = 0;

	for (const raw of messages) {
		const m = raw as TracedMessageLike;
		if (!m?.role) continue;
		if (m.role === "system" || m.role === "developer") {
			out.push({ role: "system", content: contentToText(m.content) });
			continue;
		}
		if (m.role === "user") {
			out.push({ role: "user", content: contentToText(m.content) });
			continue;
		}
		if (m.role === "assistant") {
			const toolCalls = (m.toolCalls ?? []).map((tc) => ({
				id: tc.id || `trace-tc-${++synthetic}`,
				name: tc.name ?? "unknown",
				argsJson: stringifyToolValue(tc.arguments ?? {}) || "{}",
			}));
			out.push({
				role: "assistant",
				content: contentToText(m.content),
				...(toolCalls.length ? { toolCalls } : {}),
			});
			continue;
		}
		if (m.role === "tool") {
			out.push({
				role: "tool",
				toolCallId: m.toolCallId || `trace-tc-${synthetic}`,
				content: contentToText(m.content),
			});
		}
	}
	return out;
}

export interface RoundReplayAttempt {
	content: string;
	toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
	finishReason: string;
}

export interface RoundReplayResult {
	round: number;
	attempts: RoundReplayAttempt[];
	edited: boolean;
}

/**
 * Resend one round's request (verbatim or with edited messages) k times
 * and return the model's first decisions. One bare API call per attempt.
 */
export async function replayRound(options: {
	roundData: HydratedTraceRound;
	callModel: EvalModelCaller;
	runs?: number;
	/** Replace the request messages (edit-and-replay attribution). */
	editedMessages?: unknown[];
	signal?: AbortSignal;
}): Promise<RoundReplayResult> {
	const { roundData } = options;
	const sourceMessages = options.editedMessages ?? roundData.request.messages;
	const messages = tracedMessagesToEvalMessages(sourceMessages);

	const tools = (roundData.request.tools ?? []).map((t) => ({
		type: "function" as const,
		name: t.name,
		description: t.description ?? "",
		parameters:
			(t.parameters as Record<string, unknown>) ?? {
				type: "object",
				properties: {},
			},
	}));

	const attempts: RoundReplayAttempt[] = [];
	const runs = Math.min(options.runs ?? 1, 10);

	for (let i = 0; i < runs; i++) {
		if (options.signal?.aborted) break;
		const response = await options.callModel({
			messages,
			model: roundData.request.model,
			tools: tools.length ? tools : undefined,
			temperature: roundData.request.temperature,
			maxTokens: roundData.request.maxTokens,
			thinking: roundData.request.thinking as "enabled" | "disabled" | undefined,
			reasoningEffort: roundData.request.reasoningEffort,
			signal: options.signal,
		});
		attempts.push({
			content: response.content,
			toolCalls: response.toolCalls.map((tc) => ({
				name: tc.name,
				args: tc.args,
			})),
			finishReason: response.finishReason,
		});
	}

	return {
		round: roundData.round,
		attempts,
		edited: !!options.editedMessages,
	};
}
