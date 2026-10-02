import type {
	AgentContentPart,
	AgentInputModality,
	AgentJsonObject,
	AgentJsonValue,
	AgentMessage,
	AgentMessageContent,
	AgentModelCapabilities,
	AgentProviderData,
	AgentRole,
	AgentToolCall,
} from "./types.js";
import {
	agentToolMessageContentFromHistoryResult,
	agentToolResultIsErrorFromHistoryResult,
} from "./tool-results.js";
import { agentSupportsInputModality } from "./capabilities.js";
// wire 形态的两把尺搬去了 `wire-format.ts` —— 影子断言的判等器要用**同一份**
// (F10a):判等器对键排序,而这两个函数的输出对键序敏感。
import { stringifyToolResult, toolCallArguments } from "./wire-format.js";

export type AgentHistoryContent =
	| string
	| null
	| undefined
	| Array<{
			type: string;
			text?: string;
			image?: string;
			audio?: string;
			video?: string;
			data?: string;
			url?: string;
			mediaType?: string;
			mimeType?: string;
			filename?: string;
			name?: string;
			path?: string;
	  }>;

export type AgentHistoryMessage =
	| { role: "system" | "developer" | "user"; content?: AgentHistoryContent }
	| {
			role: "assistant";
			content?: AgentHistoryContent;
			reasoningContent?: string;
			providerData?: AgentProviderData[];
			toolCalls?: Array<{
				id?: string;
				name?: string;
				arguments?: string;
				toolCallId?: string;
				toolName?: string;
				args?: AgentJsonObject;
			}>;
	  }
	| {
			role: "tool";
			toolCallId?: string;
			content?:
				| string
				| Array<{
						type?: string;
						toolCallId?: string;
						toolName?: string;
						result?: AgentJsonValue;
				  }>;
	  };

function agentRoleFromHistory(
	role: "system" | "developer" | "user",
): AgentRole {
	return role === "developer" ? "system" : role;
}

export function agentContentFromHistoryContent(
	content: AgentHistoryContent,
): AgentMessageContent {
	if (content == null) return "";
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return String(content);

	const parts: AgentContentPart[] = [];
	for (const part of content) {
		if (part.type === "text" && typeof part.text === "string") {
			parts.push({ type: "text", text: part.text });
			continue;
		}

		if (part.type === "image") {
			const image = part.image ?? part.url ?? part.data;
			if (typeof image === "string") {
				parts.push({
					type: "image",
					image,
					mediaType: part.mediaType ?? part.mimeType,
				});
			}
			continue;
		}

		if (part.type === "file") {
			const data = part.data ?? part.url;
			const mediaType = part.mediaType ?? part.mimeType;
			if (typeof data === "string" && typeof mediaType === "string") {
				parts.push({
					type: "file",
					data,
					mediaType,
					filename: part.filename ?? part.name,
					...(typeof part.path === "string" && part.path
						? { path: part.path }
						: {}),
				});
			}
			continue;
		}

		if (part.type === "audio") {
			const audio = part.audio ?? part.data ?? part.url;
			if (typeof audio === "string") {
				parts.push({
					type: "audio",
					audio,
					mediaType: part.mediaType ?? part.mimeType,
				});
			}
			continue;
		}

		if (part.type === "video") {
			const video = part.video ?? part.data ?? part.url;
			if (typeof video === "string") {
				parts.push({
					type: "video",
					video,
					mediaType: part.mediaType ?? part.mimeType,
				});
			}
		}
	}

	return parts.length > 0 ? parts : "";
}

export function agentToolCallsFromHistory(
	toolCalls: Extract<
		AgentHistoryMessage,
		{ role: "assistant" }
	>["toolCalls"] = [],
): AgentToolCall[] {
	return toolCalls
		.map((call) => ({
			id: call.id ?? call.toolCallId ?? "",
			name: call.name ?? call.toolName ?? "",
			arguments: toolCallArguments(call),
		}))
		.filter((call) => call.id && call.name);
}

/**
 * When a provider does not support a media modality, degrade a
 * media content part into a `[Type]` text placeholder so the
 * capability check passes and the model receives a textual hint
 * instead of failing with a hard error.
 */
function degradeUnsupportedAgentContentParts(
	content: AgentMessageContent,
	capabilities: AgentModelCapabilities,
): AgentMessageContent {
	if (typeof content === "string" || !Array.isArray(content)) return content;

	const modalityLabel: Record<string, string> = {
		image: "[Image]",
		file: "[File]",
		audio: "[Audio]",
		video: "[Video]",
	};

	const degraded: AgentContentPart[] = [];
	for (const part of content) {
		if (part.type === "text") {
			degraded.push(part);
			continue;
		}

		// Map content-part type to the input modality used in capability checks.
		const modality = part.type as AgentInputModality;
		if (agentSupportsInputModality(capabilities, modality)) {
			degraded.push(part);
			continue;
		}

		// Build a descriptive placeholder instead of erroring out.
		let label = modalityLabel[part.type] ?? `[${part.type}]`;
		if (part.type === "file" && "filename" in part && part.filename) {
			label = `[File: ${part.filename}]`;
		} else if (part.type === "image" && "mediaType" in part && part.mediaType) {
			label = `[Image: ${part.mediaType}]`;
		}
		degraded.push({ type: "text", text: label });
	}

	return degraded;
}

/**
 * Textual stand-in for an attachment a provider cannot deliver natively.
 * Providers use this instead of silently dropping the part, so the model
 * knows an attachment existed and won't hallucinate its contents.
 */
export function undeliverableAttachmentText(part: {
	filename?: string;
	mediaType?: string;
	mimeType?: string;
	path?: string;
}): string {
	const name = part.filename || "attachment";
	const kind = part.mediaType || part.mimeType || "unknown type";
	const base = `[Attachment "${name}" (${kind}) could not be delivered: this model does not accept this file type.`;
	return part.path
		? `${base} The file is on disk at "${part.path}" — use your file tools to read it.]`
		: `${base}]`;
}

/**
 * Convert rebuilt history messages into runner messages. When `capabilities`
 * is provided, tool results and user/assistant media content go through
 * capability-aware conversion: unsupported media parts are degraded to text
 * placeholders so the stream can continue instead of failing.
 */
export function agentMessagesFromHistory(
	messages: AgentHistoryMessage[],
	capabilities?: AgentModelCapabilities,
): AgentMessage[] {
	const result: AgentMessage[] = [];

	for (const message of messages) {
		if (message.role === "tool") {
			if (Array.isArray(message.content)) {
				for (const item of message.content) {
					result.push({
						role: "tool",
						toolCallId: item.toolCallId ?? message.toolCallId ?? "",
						content: capabilities
							? agentToolMessageContentFromHistoryResult(
									item.result,
									capabilities,
								)
							: stringifyToolResult(item.result),
						...(agentToolResultIsErrorFromHistoryResult(item.result) && {
							isError: true,
						}),
					});
				}
			} else {
				result.push({
					role: "tool",
					toolCallId: message.toolCallId ?? "",
					content: message.content ?? "",
				});
			}
			continue;
		}

		const rawContent = agentContentFromHistoryContent(message.content);
		const content = capabilities
			? degradeUnsupportedAgentContentParts(rawContent, capabilities)
			: rawContent;

		if (message.role === "assistant") {
			const toolCalls = agentToolCallsFromHistory(message.toolCalls);
			const providerData = message.providerData ?? [];
			result.push({
				role: "assistant",
				content,
				...(message.reasoningContent
					? { reasoningContent: message.reasoningContent }
					: {}),
				...(providerData.length > 0 ? { providerData } : {}),
				...(toolCalls.length > 0 ? { toolCalls } : {}),
			});
			continue;
		}

		result.push({
			role: agentRoleFromHistory(message.role),
			content,
		});
	}

	return result;
}
