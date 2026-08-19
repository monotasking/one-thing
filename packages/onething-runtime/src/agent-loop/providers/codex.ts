import { collectAgentTurnFromStream } from "@onething/core/agent-loop";
import { agentToolMessageContentToStructuredPayload } from "@onething/core/agent-loop";
import { undeliverableAttachmentText } from "@onething/core/agent-loop";
import { withProviderRetryAfter } from "../provider-error-classification.js";
import type {
	AgentContentPart,
	AgentFinishReason,
	AgentJsonObject,
	AgentJsonValue,
	AgentMessage,
	AgentMessageContent,
	AgentModelCapabilities,
	AgentProvider,
	AgentProviderData,
	AgentTool,
	AgentToolResultContentPart,
	AgentTurn,
	AgentTurnRequest,
	AgentTurnStreamEvent,
	AgentUsage,
} from "@onething/core/agent-loop";
import type {
	AgentProviderRequestDump,
	AgentProviderRequestDumper,
} from "./request-dump.js";

import { getLogger } from '../../logging/index.js'

const log = getLogger('providers.codex')

type FetchFn = typeof globalThis.fetch;
type CodexRawRecord = Record<string, AgentJsonValue | undefined>;

export const CODEX_PROVIDER_ID = "codex";
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CODEX_CLIENT_VERSION = process.env.npm_package_version || "1.1.0";
export const CODEX_FALLBACK_INSTRUCTIONS =
	"You are Codex, a helpful AI coding assistant.";

export interface OAuthToken {
	accessToken: string;
	expiresAt?: number;
	tokenType?: string;
	accountId?: string;
	isFedrampAccount?: boolean;
}

export interface ProviderAuthContext {
	kind: string;
	token?: OAuthToken;
}

/** @deprecated Use `AgentProviderRequestDump` from ./request-dump.js. */
export type CodexAgentProviderRequestDump = AgentProviderRequestDump & {
	mode: "codex-http";
};

function previewText(value: string, maxLength = 160): string {
	return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export interface CodexAgentProviderOptions {
	apiKey?: string;
	baseUrl?: string;
	oauthToken?: OAuthToken;
	authContext?: ProviderAuthContext;
	fetchImpl?: FetchFn;
	refreshOAuthToken?: (
		forceRefresh: boolean,
	) => Promise<OAuthToken | undefined>;
	requestDumper?: AgentProviderRequestDumper;
}

interface CodexPromptPayload {
	input: CodexInputItem[];
	instructions?: string;
}

type CodexInputContentPart =
	| { type: "input_text"; text: string }
	| { type: "input_image"; image_url: string; detail: "auto" }
	| { type: "input_file"; filename?: string; file_data: string }
	| { type: "output_text"; text: string };

type CodexInputItem =
	| {
			type: "message";
			role: "user" | "assistant" | "developer";
			content: CodexInputContentPart[];
	  }
	| { type: "function_call"; name: string; arguments: string; call_id: string }
	| {
			type: "function_call_output";
			call_id: string;
			output: string | CodexInputContentPart[];
	  }
	| { type: "reasoning"; summary: AgentJsonValue[]; encrypted_content: string };

type CodexTool =
	| {
			type: "function";
			name: string;
			description?: string;
			strict: false;
			parameters: AgentJsonObject;
	  }
	| { type: "image_generation"; output_format: "png" };

interface CodexReasoningOptions {
	effort: "minimal" | "low" | "medium" | "high" | "xhigh";
	summary: "auto";
}

interface CodexRequestBody {
	model: string;
	instructions: string;
	input: CodexInputItem[];
	tools: CodexTool[];
	tool_choice: AgentJsonValue;
	parallel_tool_calls: false;
	store: false;
	stream: true;
	include: string[];
	reasoning?: CodexReasoningOptions;
}

interface CodexSseEvent {
	type?: string;
	delta?: string;
	text?: string;
	input?: string;
	arguments_delta?: string;
	argumentsDelta?: string;
	item_id?: string;
	itemId?: string;
	call_id?: string;
	callId?: string;
	summary?: AgentJsonValue;
	summary_text?: AgentJsonValue;
	summaryText?: AgentJsonValue;
	item?: CodexRawRecord;
	response?: {
		id?: string;
		model?: string;
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			total_tokens?: number;
			output_tokens_details?: { reasoning_tokens?: number };
			input_tokens_details?: { cached_tokens?: number };
		};
		incomplete_details?: { reason?: string };
		error?: { message?: string };
	};
	error?: { message?: string };
}

const CODEX_AGENT_CAPABILITIES: AgentModelCapabilities = {
	capabilities: [
		"text-input",
		"vision-input",
		"file-input",
		"text-output",
		"image-output",
		"streaming",
		"tool-calls",
		"structured-tool-results",
		"reasoning",
	],
	inputModalities: ["text", "image", "file"],
	outputModalities: ["text", "image"],
	toolResultModalities: ["text", "image"],
	supportsTools: true,
	supportsStructuredToolResults: true,
	supportsReasoning: true,
	supportsStreaming: true,
	// Responses API tool_choice: "required"
	supportsForcedToolUse: true,
};

function resolveCodexToken(
	options: CodexAgentProviderOptions,
): OAuthToken | undefined {
	if (options.authContext?.kind === "oauth") return options.authContext.token;
	if (options.oauthToken) return options.oauthToken;
	if (options.apiKey) {
		return {
			accessToken: options.apiKey,
			expiresAt: Date.now() + 60 * 60 * 1000,
			tokenType: "Bearer",
		};
	}
	return undefined;
}

async function resolveCodexTokenForRequest(
	options: CodexAgentProviderOptions,
	forceRefresh = false,
): Promise<OAuthToken | undefined> {
	const hasOAuthCredentials =
		options.authContext?.kind === "oauth" || Boolean(options.oauthToken);
	if (hasOAuthCredentials && options.refreshOAuthToken) {
		try {
			return await options.refreshOAuthToken(forceRefresh);
		} catch (error) {
			if (forceRefresh) throw error;
			log.warn(
				"oauth token refresh failed, using token snapshot",
				undefined,
				error,
			);
		}
	}
	return resolveCodexToken(options);
}

function canRefreshCodexOAuth(options: CodexAgentProviderOptions): boolean {
	return (
		Boolean(options.refreshOAuthToken) &&
		(options.authContext?.kind === "oauth" || Boolean(options.oauthToken))
	);
}

function textFromContent(content: AgentMessageContent): string {
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

function dataToUrl(
	value: string | undefined,
	mediaType?: string,
): string | undefined {
	if (!value) return undefined;
	if (
		value.startsWith("data:") ||
		value.startsWith("http://") ||
		value.startsWith("https://")
	) {
		return value;
	}
	// Bare payloads without a media type cannot become a valid URL; returning
	// them verbatim gets the whole request rejected with a 400 by the API.
	return mediaType ? `data:${mediaType};base64,${value}` : undefined;
}

function toCodexMessageContent(
	content: AgentMessageContent,
	role: "user" | "assistant",
): CodexInputContentPart[] {
	if (typeof content === "string") {
		if (!content) return [];
		return [
			{
				type: role === "assistant" ? "output_text" : "input_text",
				text: content,
			},
		];
	}
	if (!Array.isArray(content)) return [];

	const parts: CodexInputContentPart[] = [];
	for (const part of content) {
		switch (part.type) {
			case "text":
				if (part.text) {
					parts.push({
						type: role === "assistant" ? "output_text" : "input_text",
						text: part.text,
					});
				}
				break;
			case "image":
				if (role === "user") {
					const imageUrl = dataToUrl(part.image, part.mediaType ?? "image/png");
					if (imageUrl)
						parts.push({
							type: "input_image",
							image_url: imageUrl,
							detail: "auto",
						});
				}
				break;
			case "file":
				if (role === "user") {
					// The Responses API's input_file is a PDF channel and requires a
					// filename alongside file_data (400 without one). Text files never
					// reach here — the engine inlines them as text parts — so anything
					// non-PDF gets a visible placeholder instead of an invalid request.
					const fileData = isPdfMediaType(part.mediaType)
						? dataToUrl(part.data, part.mediaType)
						: undefined;
					if (fileData) {
						parts.push({
							type: "input_file",
							file_data: fileData,
							filename: part.filename ?? "attachment.pdf",
						});
					} else {
						parts.push({
							type: "input_text",
							text: undeliverableAttachmentText(part),
						});
					}
				}
				break;
			case "audio":
				// Codex does not support audio input natively; fall back to a
				// descriptive text placeholder so the API request stays valid.
				if (role === "user") {
					parts.push({
						type: "input_text",
						text: `[Audio: ${part.mediaType ?? "unknown"}]`,
					});
				}
				break;
			case "video":
				if (role === "user") {
					parts.push({
						type: "input_text",
						text: `[Video: ${part.mediaType ?? "unknown"}]`,
					});
				}
				break;
			default:
				break;
		}
	}
	return parts;
}

function parseToolArguments(args: string): AgentJsonValue {
	const trimmed = args.trim();
	if (!trimmed) return {};
	try {
		return JSON.parse(trimmed) as AgentJsonValue;
	} catch {
		return args;
	}
}

function stringifyCodexToolInput(input: AgentJsonValue | undefined): string {
	if (typeof input === "string") return input;
	try {
		return JSON.stringify(input ?? {});
	} catch {
		return "{}";
	}
}

function codexEncryptedReasoning(message: AgentMessage): string[] {
	return (message.providerData ?? [])
		.filter(
			(data): data is AgentProviderData & { encryptedContent: string } =>
				data.provider === "codex" &&
				data.type === "encrypted-reasoning" &&
				typeof data.encryptedContent === "string" &&
				data.encryptedContent.length > 0,
		)
		.map((data) => data.encryptedContent);
}

function buildCodexPrompt(messages: AgentMessage[]): CodexPromptPayload {
	const instructions: string[] = [];
	const input: CodexInputItem[] = [];

	for (const message of messages) {
		if (message.role === "system") {
			const text = textFromContent(message.content).trim();
			if (text) instructions.push(text);
			continue;
		}

		if (message.role === "user") {
			const content = toCodexMessageContent(message.content, "user");
			if (content.length > 0)
				input.push({ type: "message", role: "user", content });
			continue;
		}

		if (message.role === "assistant") {
			for (const encryptedContent of codexEncryptedReasoning(message)) {
				input.push({
					type: "reasoning",
					summary: [],
					encrypted_content: encryptedContent,
				});
			}
			const content = toCodexMessageContent(message.content, "assistant");
			if (content.length > 0)
				input.push({ type: "message", role: "assistant", content });
			for (const toolCall of message.toolCalls ?? []) {
				if (!toolCall.id || !toolCall.name) continue;
				input.push({
					type: "function_call",
					name: toolCall.name,
					arguments: stringifyCodexToolInput(
						parseToolArguments(toolCall.arguments),
					),
					call_id: toolCall.id,
				});
			}
			continue;
		}

		if (message.role === "tool" && message.toolCallId) {
			input.push({
				type: "function_call_output",
				call_id: message.toolCallId,
				output: toolResultToCodexOutput(
					agentToolMessageContentToStructuredPayload(message.content),
				),
			});
		}
	}

	return {
		input,
		instructions: instructions.filter(Boolean).join("\n\n") || undefined,
	};
}

function toolResultToCodexOutput(
	payload: ReturnType<typeof agentToolMessageContentToStructuredPayload>,
): string | CodexInputContentPart[] {
	if (typeof payload === "string") return payload;
	const rawContent = Array.isArray(payload)
		? payload
		: payload && typeof payload === "object"
			? (payload as { content?: unknown }).content
			: undefined;
	if (!isAgentToolResultContentPartArray(rawContent))
		return JSON.stringify(payload ?? "");

	const parts: CodexInputContentPart[] = [];
	for (const part of rawContent) {
		// Tool result parts carry the media type as either `mimeType` (raw tool
		// output) or `mediaType` (the structured payload normalization).
		const mediaType =
			part.mimeType ?? (part as { mediaType?: string }).mediaType;
		if (part.type === "text" && typeof part.text === "string") {
			parts.push({ type: "input_text", text: part.text });
		} else if (part.type === "image") {
			const imageUrl = dataToUrl(part.data, mediaType ?? "image/png");
			if (imageUrl)
				parts.push({
					type: "input_image",
					image_url: imageUrl,
					detail: "auto",
				});
		} else if (part.type === "file") {
			const imageUrl = mediaType?.startsWith("image/")
				? dataToUrl(part.data, mediaType)
				: undefined;
			const fileData = isPdfMediaType(mediaType)
				? dataToUrl(part.data, mediaType)
				: undefined;
			if (imageUrl) {
				parts.push({
					type: "input_image",
					image_url: imageUrl,
					detail: "auto",
				});
			} else if (fileData) {
				parts.push({
					type: "input_file",
					file_data: fileData,
					filename:
						(part as { path?: string; filename?: string }).filename ??
						part.path ??
						"attachment.pdf",
				});
			} else {
				parts.push({
					type: "input_text",
					text: undeliverableAttachmentText(
						part as { filename?: string; mimeType?: string },
					),
				});
			}
		}
	}
	return parts.length > 0 ? parts : "";
}

function isPdfMediaType(mediaType: string | undefined): boolean {
	if (!mediaType) return false;
	return (
		(mediaType.split(";")[0] ?? "").trim().toLowerCase() === "application/pdf"
	);
}

function isAgentToolResultContentPartArray(
	value: unknown,
): value is AgentToolResultContentPart[] {
	return (
		Array.isArray(value) &&
		value.every((part) => {
			if (!part || typeof part !== "object") return false;
			const type = (part as { type?: unknown }).type;
			return type === "text" || type === "image" || type === "file";
		})
	);
}

function toCodexTools(
	tools: AgentTool[] | undefined,
	nativeImageGeneration: boolean,
): CodexTool[] {
	const seen = new Set<string>();
	const codexTools: CodexTool[] = [];
	for (const tool of tools ?? []) {
		if (!tool.name || seen.has(tool.name)) continue;
		seen.add(tool.name);
		codexTools.push({
			type: "function",
			name: tool.name,
			description: tool.description,
			strict: false,
			parameters: tool.parameters,
		});
	}
	if (nativeImageGeneration) {
		codexTools.push({ type: "image_generation", output_format: "png" });
	}
	return codexTools;
}

function isCodexReasoningModel(model: string): boolean {
	const lower = model.toLowerCase();
	if (lower.includes("gpt-5.2-chat") || lower.includes("gpt-5.2-instant"))
		return false;
	return (
		lower.startsWith("gpt-5") ||
		lower.includes("codex") ||
		/\bo[13](?:-|$)/.test(lower) ||
		lower.includes("reasoning")
	);
}

function normalizeCodexReasoningEffort(
	effort: unknown,
): CodexReasoningOptions["effort"] {
	if (effort === "max") return "high";
	if (
		effort === "minimal" ||
		effort === "low" ||
		effort === "medium" ||
		effort === "high"
	)
		return effort;
	return "medium";
}

/**
 * Responses API dialect for `tool_choice` (W22).
 *
 * The string forms ("auto" / "none" / "required") are shared with Chat
 * Completions, but a NAMED tool is spelled flat here — `{type:'function',
 * name}` — where Chat Completions nests it under a `function` object. Passing
 * the nested shape through unchanged is a 400, so the one shape that differs is
 * translated and everything else rides on as before.
 */
export function toCodexToolChoice(
	choice: AgentTurnRequest["toolChoice"],
): AgentJsonValue {
	if (!choice) return "auto";
	if (typeof choice === "string") return choice;
	return { type: "function", name: choice.function.name };
}

function buildCodexRequestBody(request: AgentTurnRequest): CodexRequestBody {
	const { input, instructions } = buildCodexPrompt(request.messages);
	const reasoning =
		request.thinking === "disabled"
			? undefined
			: isCodexReasoningModel(request.model) || request.reasoningEffort
				? {
						effort: normalizeCodexReasoningEffort(request.reasoningEffort),
						summary: "auto" as const,
					}
				: undefined;
	return {
		model: request.model,
		instructions: instructions || CODEX_FALLBACK_INSTRUCTIONS,
		input,
		tools: toCodexTools(
			request.tools,
			Boolean(request.requestedOutputModalities?.includes("image")),
		),
		tool_choice: toCodexToolChoice(request.toolChoice),
		parallel_tool_calls: false,
		store: false,
		stream: true,
		include: reasoning ? ["reasoning.encrypted_content"] : [],
		...(reasoning ? { reasoning } : {}),
	};
}

function buildCodexAgentHeaders(token: OAuthToken): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "text/event-stream",
		"Content-Type": "application/json",
		Authorization: `Bearer ${token.accessToken}`,
		originator: "codex_cli_rs",
		version: CODEX_CLIENT_VERSION,
		"User-Agent": `codex_cli_rs/${CODEX_CLIENT_VERSION}`,
	};
	if (token.accountId) headers["ChatGPT-Account-ID"] = token.accountId;
	if (token.isFedrampAccount) headers["X-OpenAI-Fedramp"] = "true";
	return headers;
}

function resolveCodexResponsesUrl(baseUrl?: string): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function summarizeCodexErrorBody(body: string): string {
	if (!body) return "";
	try {
		const parsed = JSON.parse(body);
		const message =
			parsed?.detail ||
			parsed?.error?.message ||
			parsed?.message ||
			parsed?.error;
		if (typeof message === "string") return message.slice(0, 300);
	} catch {
		// Fall back to HTML/text cleanup below.
	}
	const compact = body.replace(/\s+/g, " ").trim();
	const title = compact.match(/<title>(.*?)<\/title>/i)?.[1]?.trim();
	const paragraph = compact
		.match(/<p>(?:<b>\d+\.<\/b>\s*)?(.*?)(?:<p>|$)/i)?.[1]
		?.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return (
		[title, paragraph].filter(Boolean).join(": ").slice(0, 300) ||
		compact.slice(0, 300)
	);
}

function createCodexAgentApiError(
	status: number,
	responseBody: string,
	headers: Headers,
): Error {
	const detail = summarizeCodexErrorBody(responseBody);
	const requestId = headers.get("x-oai-request-id");
	// 批 B8-2:headers 本来就传进来了(只用来取 request-id),顺手把
	// `retry-after` / `x-ratelimit-reset-*` 解析成绝对时间戳挂上去。
	return withProviderRetryAfter(
		Object.assign(
			new Error(
				`Codex request failed (${status})${detail ? `: ${detail}` : ""}${requestId ? ` [request-id: ${requestId}]` : ""}`,
			),
			{
				statusCode: status,
				responseBody,
				isRetryable: status >= 500 || status === 429,
			},
		),
		{ headers, body: responseBody },
	);
}

function codexRecord(value: AgentJsonValue | undefined): CodexRawRecord {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as CodexRawRecord)
		: {};
}

function optionalString(value: AgentJsonValue | undefined): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function collectReasoningSummaryText(
	value: AgentJsonValue | undefined,
): string[] {
	if (typeof value === "string") return value ? [value] : [];
	if (!value || typeof value !== "object") return [];
	if (Array.isArray(value)) return value.flatMap(collectReasoningSummaryText);
	const record = codexRecord(value);
	return [
		record.text,
		record.summary_text,
		record.summaryText,
		record.value,
		record.summary,
		record.parts,
		record.items,
	].flatMap(collectReasoningSummaryText);
}

function collectManyReasoningSummaryText(
	values: Array<AgentJsonValue | undefined>,
): string[] {
	return values.flatMap((value) => collectReasoningSummaryText(value));
}

function extractOutputText(item: AgentJsonValue | undefined): string {
	const itemRecord = codexRecord(item);
	if (!Array.isArray(itemRecord.content)) return "";
	return itemRecord.content
		.map((content) => {
			const record = codexRecord(content);
			return (
				optionalString(record.text) ?? optionalString(record.content) ?? ""
			);
		})
		.join("");
}

function extractReasoningSummaryText(item: AgentJsonValue | undefined): string {
	const record = codexRecord(item);
	return collectManyReasoningSummaryText([
		record.summary,
		record.text,
		record.summary_text,
		record.summaryText,
		record.reasoning_summary,
		record.reasoningSummary,
	]).join("");
}

function isCodexFunctionCallItem(item: AgentJsonValue | undefined): boolean {
	const record = codexRecord(item);
	return record.type === "function_call" || record.type === "custom_tool_call";
}

function usageFromResponse(
	response: CodexSseEvent["response"],
): AgentUsage | undefined {
	const usage = response?.usage;
	if (!usage) return undefined;
	const inputTokens = usage.input_tokens;
	const outputTokens = usage.output_tokens;
	const totalTokens =
		usage.total_tokens ??
		(inputTokens !== undefined || outputTokens !== undefined
			? (inputTokens ?? 0) + (outputTokens ?? 0)
			: undefined);
	if (
		inputTokens === undefined &&
		outputTokens === undefined &&
		totalTokens === undefined
	)
		return undefined;
	const cacheReadTokens = usage.input_tokens_details?.cached_tokens;
	const reasoningTokens = usage.output_tokens_details?.reasoning_tokens;
	return {
		inputTokens: inputTokens ?? 0,
		outputTokens: outputTokens ?? 0,
		totalTokens: totalTokens ?? 0,
		...(cacheReadTokens ? { cacheReadTokens } : {}),
		...(reasoningTokens ? { reasoningTokens } : {}),
	};
}

async function* parseCodexResponsesSse(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<CodexSseEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let eventName: string | null = null;
	let dataLines: string[] = [];

	function decode(): CodexSseEvent | undefined {
		const data = dataLines.join("\n").trim();
		const name = eventName;
		eventName = null;
		dataLines = [];
		if (!data || data === "[DONE]") return undefined;
		const parsed = JSON.parse(data) as CodexSseEvent;
		if (name && !parsed.type) parsed.type = name;
		return parsed;
	}

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (line === "") {
					const event = decode();
					if (event) yield event;
					continue;
				}
				if (line.startsWith("event:")) {
					eventName = line.slice(6).trim();
				} else if (line.startsWith("data:")) {
					dataLines.push(line.slice(5).trimStart());
				}
			}
		}
		if (buffer.trim()) {
			dataLines.push(
				buffer.startsWith("data:")
					? buffer.slice(5).trimStart()
					: buffer.trim(),
			);
		}
		const event = decode();
		if (event) yield event;
	} finally {
		reader.releaseLock();
	}
}

function summarizeCodexRequestBody(
	body: CodexRequestBody,
): Record<string, unknown> {
	const messages = body.input.filter((item) => item.type === "message");
	const lastUser = [...messages].reverse().find((item) => item.role === "user");
	const lastUserText =
		lastUser?.type === "message"
			? lastUser.content
					.map((part) => ("text" in part ? part.text : ""))
					.filter(Boolean)
					.join("\n")
			: "";
	return {
		model: body.model,
		inputCount: body.input.length,
		messageCount: messages.length,
		toolCount: body.tools.length,
		stream: body.stream,
		lastUserPreview: previewText(lastUserText),
	};
}

function mapCodexFinishReason(reason: string | undefined): AgentFinishReason {
	switch (reason) {
		case "stop":
		case "length":
		case "error":
			return reason;
		case "max_output_tokens":
		case "max_tokens":
			return "length";
		case "tool-calls":
		case "tool_calls":
			return "tool_calls";
		case "content-filter":
		case "content_filter":
			return "content_filter";
		default:
			return "unknown";
	}
}

export function createCodexAgentProvider(
	options: CodexAgentProviderOptions,
): AgentProvider {
	const initialToken = resolveCodexToken(options);
	if (!initialToken?.accessToken) {
		throw new Error("Not logged in to Codex. Please login first.");
	}

	const requestUrl = resolveCodexResponsesUrl(options.baseUrl);
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;

	async function* streamTurn(
		request: AgentTurnRequest,
	): AsyncGenerator<AgentTurnStreamEvent, void, void> {
		const body = buildCodexRequestBody(request);
		const lastUser = [...request.messages]
			.reverse()
			.find((message) => message.role === "user");
		const requestDumpPath = await options.requestDumper?.({
			providerId: CODEX_PROVIDER_ID,
			model: request.model,
			mode: "codex-http",
			metadata: {
				url: requestUrl,
				method: "POST",
				requestSource: "agent-loop",
			},
			requestBody: body,
		});
		log.debug("stream turn request", {
			turn: request.turn,
			messageCount: request.messages.length,
			requestDumpPath,
			...summarizeCodexRequestBody(body),
			lastUserPreview: previewText(textFromContent(lastUser?.content ?? "")),
		});

		const sendRequest = async (token: OAuthToken): Promise<Response> =>
			fetchImpl(requestUrl, {
				method: "POST",
				headers: buildCodexAgentHeaders(token),
				body: JSON.stringify(body),
				signal: request.abortSignal,
			});

		const token = await resolveCodexTokenForRequest(options);
		if (!token?.accessToken) {
			throw new Error("Not logged in to Codex. Please login first.");
		}

		let response = await sendRequest(token);
		if (response.status === 401 && canRefreshCodexOAuth(options)) {
			const firstBody = await response.text().catch(() => "");
			try {
				const refreshedToken = await resolveCodexTokenForRequest(options, true);
				if (
					refreshedToken?.accessToken &&
					refreshedToken.accessToken !== token.accessToken
				) {
					log.warn("request returned 401, refreshed oauth token and retrying once");
					response = await sendRequest(refreshedToken);
				} else {
					throw createCodexAgentApiError(
						response.status,
						firstBody,
						response.headers,
					);
				}
			} catch (error) {
				if (error instanceof Error && "statusCode" in error) throw error;
				throw createCodexAgentApiError(
					401,
					firstBody || (error instanceof Error ? error.message : String(error)),
					response.headers,
				);
			}
		}

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw createCodexAgentApiError(response.status, text, response.headers);
		}
		if (!response.body) {
			throw new Error("Codex request failed: response body is empty");
		}

		const debugStream = log.isLevelEnabled("trace");
		let finishReason: AgentFinishReason = "unknown";
		let usage: AgentUsage | undefined;
		let completedToolCallCount = 0;
		let emittedTextFromDelta = false;
		let activeReasoningItemId: string | undefined;
		const reasoningSummaryByItem = new Map<string, string>();

		interface ActiveFunctionCallInput {
			itemId: string;
			callId: string;
			toolName: string;
			streamedArgs: string;
			started: boolean;
		}
		const toolInputByItemId = new Map<string, ActiveFunctionCallInput>();
		const toolInputByCallId = new Map<string, ActiveFunctionCallInput>();
		const pendingToolInputDeltas = new Map<string, string>();

		const emitReasoning = function* (
			delta: string,
			itemId = "reasoning-0",
		): Generator<AgentTurnStreamEvent> {
			if (!delta) return;
			reasoningSummaryByItem.set(
				itemId,
				`${reasoningSummaryByItem.get(itemId) ?? ""}${delta}`,
			);
			if (debugStream) {
				log.trace("reasoning delta", {
					turn: request.turn,
					chars: delta.length,
					text: previewText(delta, 240),
				});
			}
			yield { type: "reasoning-delta", turn: request.turn, delta };
		};

		const emitText = function* (
			delta: string,
		): Generator<AgentTurnStreamEvent> {
			if (!delta) return;
			emittedTextFromDelta = true;
			if (debugStream) {
				log.trace("text delta", {
					turn: request.turn,
					chars: delta.length,
					text: previewText(delta, 240),
				});
			}
			yield { type: "text-delta", turn: request.turn, delta };
		};

		const getFunctionCallItemId = (
			item: CodexRawRecord,
			event?: CodexSseEvent,
			fallback?: string,
		): string | undefined => {
			const id =
				item.id ?? item.item_id ?? item.itemId ?? event?.item_id ?? fallback;
			return optionalString(id);
		};
		const getFunctionCallCallId = (
			item: CodexRawRecord,
			event?: CodexSseEvent,
		): string | undefined => {
			return (
				optionalString(item.call_id) ??
				optionalString(item.callId) ??
				optionalString(event?.call_id) ??
				optionalString(item.id)
			);
		};
		const getFunctionCallToolName = (
			item: CodexRawRecord,
		): string | undefined => {
			return (
				optionalString(item.name) ??
				optionalString(item.tool_name) ??
				optionalString(item.toolName)
			);
		};
		const getFunctionCallArgs = (item: CodexRawRecord): string => {
			if (typeof item.arguments === "string") return item.arguments;
			if (typeof item.input === "string") return item.input;
			return stringifyCodexToolInput(item.arguments ?? item.input);
		};
		const getReasoningItemId = (
			item: CodexRawRecord | undefined,
			event: CodexSseEvent,
			fallback: string,
		): string => {
			return (
				optionalString(item?.id) ??
				optionalString(item?.item_id) ??
				optionalString(item?.itemId) ??
				optionalString(event.item_id) ??
				optionalString(event.itemId) ??
				fallback
			);
		};
		const getImageGenerationCallId = (
			item: CodexRawRecord,
			event?: CodexSseEvent,
		): string | undefined => {
			return (
				optionalString(item.id) ??
				optionalString(item.call_id) ??
				optionalString(item.callId) ??
				optionalString(event?.item_id) ??
				optionalString(event?.itemId)
			);
		};

		const registerFunctionCallInput = (
			item: CodexRawRecord,
			event?: CodexSseEvent,
		): ActiveFunctionCallInput | undefined => {
			const callId = getFunctionCallCallId(item, event);
			const toolName = getFunctionCallToolName(item);
			if (!callId || !toolName) return undefined;
			const itemId = getFunctionCallItemId(item, event, callId) ?? callId;
			const existing =
				toolInputByItemId.get(itemId) ?? toolInputByCallId.get(callId);
			if (existing) {
				existing.callId = callId;
				existing.toolName = toolName;
				toolInputByItemId.set(itemId, existing);
				toolInputByCallId.set(callId, existing);
				return existing;
			}
			const state = {
				itemId,
				callId,
				toolName,
				streamedArgs: "",
				started: false,
			};
			toolInputByItemId.set(itemId, state);
			toolInputByCallId.set(callId, state);
			return state;
		};

		const startFunctionCallInput = function* (
			state: ActiveFunctionCallInput,
		): Generator<AgentTurnStreamEvent> {
			if (state.started) return;
			state.started = true;
			yield {
				type: "tool-call-start",
				turn: request.turn,
				toolCallId: state.callId,
				toolName: state.toolName,
			};
		};

		const flushPendingFunctionCallDeltas = function* (
			state: ActiveFunctionCallInput,
		): Generator<AgentTurnStreamEvent> {
			for (const key of Array.from(new Set([state.itemId, state.callId]))) {
				const delta = pendingToolInputDeltas.get(key);
				if (!delta) continue;
				pendingToolInputDeltas.delete(key);
				yield* startFunctionCallInput(state);
				state.streamedArgs += delta;
				yield {
					type: "tool-call-delta",
					turn: request.turn,
					toolCallId: state.callId,
					toolName: state.toolName,
					argumentsDelta: delta,
				};
			}
		};

		const registerAndStartFunctionCallInput = function* (
			item: CodexRawRecord,
			event?: CodexSseEvent,
		): Generator<AgentTurnStreamEvent> {
			const state = registerFunctionCallInput(item, event);
			if (!state) return;
			yield* startFunctionCallInput(state);
			yield* flushPendingFunctionCallDeltas(state);
		};

		const emitFunctionCallInputDelta = function* (
			event: CodexSseEvent,
		): Generator<AgentTurnStreamEvent> {
			const delta =
				event.delta ??
				event.input ??
				event.arguments_delta ??
				event.argumentsDelta ??
				"";
			if (!delta) return;
			const itemId =
				optionalString(event.item_id) ?? optionalString(event.itemId);
			const callId =
				optionalString(event.call_id) ?? optionalString(event.callId);
			const state =
				(itemId ? toolInputByItemId.get(itemId) : undefined) ??
				(callId ? toolInputByCallId.get(callId) : undefined);
			if (!state) {
				const key = itemId ?? callId;
				if (key)
					pendingToolInputDeltas.set(
						key,
						`${pendingToolInputDeltas.get(key) ?? ""}${delta}`,
					);
				return;
			}
			yield* startFunctionCallInput(state);
			state.streamedArgs += delta;
			yield {
				type: "tool-call-delta",
				turn: request.turn,
				toolCallId: state.callId,
				toolName: state.toolName,
				argumentsDelta: delta,
			};
		};

		const emitFunctionCall = function* (
			item: CodexRawRecord,
			event?: CodexSseEvent,
		): Generator<AgentTurnStreamEvent> {
			const callId = getFunctionCallCallId(item, event);
			const toolName = getFunctionCallToolName(item);
			if (!callId || !toolName) return;
			const state = registerFunctionCallInput(item, event);
			const args = getFunctionCallArgs(item);
			if (state) {
				yield* startFunctionCallInput(state);
				yield* flushPendingFunctionCallDeltas(state);
				if (args && !state.streamedArgs) {
					state.streamedArgs = args;
					yield {
						type: "tool-call-delta",
						turn: request.turn,
						toolCallId: callId,
						toolName,
						argumentsDelta: args,
					};
				} else if (
					args &&
					args.startsWith(state.streamedArgs) &&
					args.length > state.streamedArgs.length
				) {
					const suffix = args.slice(state.streamedArgs.length);
					state.streamedArgs = args;
					yield {
						type: "tool-call-delta",
						turn: request.turn,
						toolCallId: callId,
						toolName,
						argumentsDelta: suffix,
					};
				}
				toolInputByItemId.delete(state.itemId);
				toolInputByCallId.delete(state.callId);
			} else {
				yield {
					type: "tool-call-start",
					turn: request.turn,
					toolCallId: callId,
					toolName,
				};
				if (args)
					yield {
						type: "tool-call-delta",
						turn: request.turn,
						toolCallId: callId,
						toolName,
						argumentsDelta: args,
					};
			}
			completedToolCallCount += 1;
			yield {
				type: "tool-call-done",
				turn: request.turn,
				toolCall: { id: callId, name: toolName, arguments: args },
			};
		};

		for await (const event of parseCodexResponsesSse(response.body)) {
			if (debugStream) {
				log.trace("sse event", {
					type: event.type,
					deltaChars: typeof event.delta === "string" ? event.delta.length : 0,
					deltaPreview:
						typeof event.delta === "string"
							? previewText(event.delta, 240)
							: "",
					itemType: event.item?.type,
					hasUsage: Boolean(event.response?.usage),
				});
			}
			if (event.error)
				throw new Error(
					`Codex stream error: ${event.error.message ?? "unknown error"}`,
				);

			switch (event.type) {
				case "response.output_text.delta":
					yield* emitText(event.delta ?? "");
					break;
				case "response.reasoning_summary_text.delta": {
					const itemId = getReasoningItemId(
						undefined,
						event,
						activeReasoningItemId ?? "reasoning-0",
					);
					yield* emitReasoning(event.delta ?? event.text ?? "", itemId);
					break;
				}
				case "response.reasoning_summary_part.added": {
					const itemId = getReasoningItemId(
						undefined,
						event,
						activeReasoningItemId ?? "reasoning-0",
					);
					if (reasoningSummaryByItem.get(itemId)?.trim())
						yield* emitReasoning("\n\n", itemId);
					break;
				}
				case "response.reasoning_summary_text.done": {
					const itemId = getReasoningItemId(
						undefined,
						event,
						activeReasoningItemId ?? "reasoning-0",
					);
					const summary = collectManyReasoningSummaryText([
						event.text,
						event.summary,
						event.summary_text,
						event.summaryText,
					]).join("");
					if (summary && !reasoningSummaryByItem.get(itemId)?.trim())
						yield* emitReasoning(summary, itemId);
					break;
				}
				case "response.function_call_arguments.delta":
				case "response.custom_tool_call_input.delta":
					yield* emitFunctionCallInputDelta(event);
					break;
				case "response.output_item.added": {
					const item = event.item ?? {};
					if (item.type === "reasoning") {
						activeReasoningItemId = getReasoningItemId(
							item,
							event,
							"reasoning-0",
						);
						const summary = extractReasoningSummaryText(item);
						if (
							summary &&
							!reasoningSummaryByItem.get(activeReasoningItemId)?.trim()
						)
							yield* emitReasoning(summary, activeReasoningItemId);
						break;
					}
					if (isCodexFunctionCallItem(item)) {
						yield* registerAndStartFunctionCallInput(item, event);
						break;
					}
					if (
						item.type === "image_generation" ||
						item.type === "image_generation_call"
					) {
						const callId = getImageGenerationCallId(item, event);
						if (callId) {
							yield {
								type: "provider-data",
								turn: request.turn,
								providerData: {
									provider: "codex",
									type: "image-generation-start",
									callId,
									status: optionalString(item.status),
								},
							};
						}
					}
					break;
				}
				case "response.output_item.done": {
					const item = event.item ?? {};
					if (isCodexFunctionCallItem(item)) {
						yield* emitFunctionCall(item, event);
						finishReason = "tool_calls";
						break;
					}
					if (
						item.type === "image_generation" ||
						item.type === "image_generation_call"
					) {
						const callId = getImageGenerationCallId(item, event);
						const result = optionalString(item.result);
						if (callId && result) {
							yield {
								type: "provider-data",
								turn: request.turn,
								providerData: {
									provider: "codex",
									type: "image-generation-result",
									callId,
									status: optionalString(item.status) ?? "completed",
									revisedPrompt:
										optionalString(item.revised_prompt) ??
										optionalString(item.revisedPrompt),
									result,
								},
							};
						}
						break;
					}
					if (item.type === "reasoning") {
						const itemId = getReasoningItemId(
							item,
							event,
							activeReasoningItemId ?? "reasoning-0",
						);
						const summary = extractReasoningSummaryText(item);
						if (summary && !reasoningSummaryByItem.get(itemId)?.trim())
							yield* emitReasoning(summary, itemId);
						const encryptedContent = optionalString(item.encrypted_content);
						if (encryptedContent) {
							yield {
								type: "provider-data",
								turn: request.turn,
								providerData: {
									provider: "codex",
									type: "encrypted-reasoning",
									encryptedContent,
								},
							};
						}
						if (activeReasoningItemId === itemId)
							activeReasoningItemId = undefined;
						break;
					}
					if (item.type === "message" && !emittedTextFromDelta) {
						yield* emitText(extractOutputText(item));
					}
					break;
				}
				case "response.completed":
					usage = usageFromResponse(event.response) ?? usage;
					if (finishReason !== "tool_calls") finishReason = "stop";
					break;
				case "response.incomplete":
					usage = usageFromResponse(event.response) ?? usage;
					finishReason = mapCodexFinishReason(
						event.response?.incomplete_details?.reason,
					);
					break;
				case "response.failed":
					throw new Error(
						`Codex stream error: ${event.response?.error?.message || "Codex stream failed"}`,
					);
					break;
				default:
					usage = usageFromResponse(event.response) ?? usage;
					break;
			}
		}

		// Flush tool calls whose accumulator never saw output_item.done (stream
		// interrupted / server closed early) so the loop can still execute them
		// instead of silently ending the turn.
		const flushedStates = new Set<ActiveFunctionCallInput>();
		for (const state of [
			...toolInputByItemId.values(),
			...toolInputByCallId.values(),
		]) {
			if (flushedStates.has(state)) continue;
			flushedStates.add(state);
			yield* flushPendingFunctionCallDeltas(state);
			if (!state.started) continue;
			completedToolCallCount += 1;
			yield {
				type: "tool-call-done",
				turn: request.turn,
				toolCall: {
					id: state.callId,
					name: state.toolName,
					arguments: state.streamedArgs,
				},
			};
		}
		if (completedToolCallCount === 0 && finishReason === "tool_calls") {
			finishReason = "stop";
		}
		yield {
			type: "finish",
			turn: request.turn,
			finishReason: completedToolCallCount > 0 ? "tool_calls" : finishReason,
			usage,
		};
	}

	return {
		id: "codex",
		capabilities: CODEX_AGENT_CAPABILITIES,
		getModelCapabilities: () => CODEX_AGENT_CAPABILITIES,
		streamTurn,
		async runTurn(request: AgentTurnRequest): Promise<AgentTurn> {
			return collectAgentTurnFromStream(streamTurn(request), request.onEvent);
		},
	};
}
