import { getAIToolName } from "../agent-loop/tool-names.js";
import type { AgentProviderData } from "../agent-loop/types.js";
import type { JsonObject, JsonValue } from "../json.js";
import type {
	CoreChatLogMessageShape,
	CoreChatLogValue,
} from "./chat-logger.js";

export const COMPACTED_HISTORY_RETAINED_PAYLOAD_BUDGET_CHARS = 300_000;
export const COMPACTED_HISTORY_TOOL_RESULT_BUDGET_CHARS = 24_000;
export const COMPACTED_HISTORY_TOOL_RESULTS_TOTAL_BUDGET_CHARS = 80_000;

// Non-compacted history rebuild budgets. Generous compared to the compacted
// path (legit tool outputs top out around 50KB), but a hard ceiling so a
// single rebuilt request can never dwarf the live-loop request again.
export const HISTORY_TOOL_RESULT_BUDGET_CHARS = 200_000;
export const HISTORY_TOOL_RESULTS_TOTAL_BUDGET_CHARS = 600_000;
// No legitimate tool result string exceeds this (read caps at 50KB, bash at
// 30KB); anything larger is runaway payload (base64, embedded blobs).
export const HISTORY_STRING_HARD_CAP_CHARS = 64_000;
const ATTACHMENT_INLINE_CONTENT_MAX_CHARS = 2_000;

export type CoreHistoryMessage =
	| { role: "user"; content: unknown }
	| {
			role: "assistant";
			content: unknown;
			reasoningContent?: string;
			providerData?: AgentProviderData[];
			toolCalls?: Array<{
				toolCallId: string;
				toolName: string;
				args: JsonObject;
			}>;
	  }
	| {
			role: "tool";
			content: Array<{
				type: "tool-result";
				toolCallId: string;
				toolName: string;
				result: JsonValue;
			}>;
	  };

export interface CoreResumeToolCall {
	id: string;
	toolId?: string;
	toolName: string;
	arguments: JsonObject;
	status?: string;
	result?: JsonValue;
	error?: string;
}

export interface CoreResumeAssistantMessage {
	content?: string;
	reasoning?: string;
	toolCalls?: CoreResumeToolCall[];
}

export interface CoreHistoryContentPart {
	type: string;
	provider?: string;
	encryptedReasoning?: string;
	providerData?: AgentProviderData;
	content?: string;
	/** Which completion of the tool loop produced this part (1-based). */
	turnIndex?: number;
}

export interface CoreHistoryStep {
	toolCallId?: string;
	turnIndex?: number;
}

export interface CoreHistoryToolCall {
	id: string;
	toolId?: string;
	toolName: string;
	arguments: JsonObject;
	status?: string;
	result?: JsonValue;
	error?: string;
	rejected?: boolean;
	rejectionReason?: string;
}

export interface CoreHistoryChatMessage {
	id: string;
	role: string;
	content?: string;
	reasoning?: string;
	isStreaming?: boolean;
	contentParts?: CoreHistoryContentPart[];
	toolCalls?: CoreHistoryToolCall[];
	steps?: CoreHistoryStep[];
	usage?: { inputTokens?: number };
}

export interface CoreHistorySessionSummary {
	id?: string;
	summary?: string;
	summaryUpToMessageId?: string;
}

export interface CoreCompactedHistoryLogDetails {
	sessionId?: string;
	summaryUpToMessageId: string;
	summaryIndex: number;
	totalSessionMessages: number;
	recentSessionMessages: number;
	retainedRecentMessages: number;
	degradedRecentMessages: number;
	droppedRecentMessages: number;
	retainedPayloadChars: number;
	originalRecentPayloadChars: number;
	retainedPayloadBudgetChars: number;
	summaryChars: number;
	retainedMessages: JsonObject[];
	degradedMessageIds: string[];
	droppedMessages: JsonObject[];
	resultMessages: CoreHistoryMessage[];
}

export interface CoreCompactedToolResultOptions {
	getAIToolName?: (name: string) => string;
	failureResultForAI?: (toolCall: CoreHistoryToolCall) => JsonValue;
}

export interface CoreBuildHistoryMessagesOptions<
	TContent = unknown,
	TMessage extends CoreHistoryChatMessage = CoreHistoryChatMessage,
> {
	buildMessageContent: (message: TMessage) => TContent;
	getAIToolName?: (name: string) => string;
	failureResultForAI?: (toolCall: CoreHistoryToolCall) => JsonValue;
	providerDataFromContentPart?: (
		part: CoreHistoryContentPart,
		message: TMessage,
	) => AgentProviderData | undefined;
	onCompactedHistory?: (details: CoreCompactedHistoryLogDetails) => void;
	onMissingSummaryAnchor?: (details: {
		sessionId?: string;
		summaryUpToMessageId: string;
	}) => void;
	/**
	 * G9(session-event-sourcing §10.1):强制走**压缩后**的 per-result 预算
	 * (24k/80k,而不是 200k/600k)。
	 *
	 * 今天这一位是从 `session.summary + summaryUpToMessageId` 推出来的:命中锚点
	 * 就是压缩态。事件溯源的 surface 路径上切点由 `session/compacted` 表达,
	 * `session` 被刻意置空(再按锚点切一次就是切两刀),于是那一位没了来源 ——
	 * 小载荷下两条路逐字相同,真机大结果才分叉。这个选项就是把它还回来。
	 */
	forceCompactedToolResults?: boolean;
	/**
	 * F1(session-event-sourcing §13.2):`providerData` 只取**最后一条**保留消息。
	 *
	 * 与 `forceCompactedToolResults` 同一条来路:摘要分支里那条 last-only 规则
	 * 在事件溯源的 surface 路径上没了来源(那条路走的是非摘要分支)。缺省 false
	 * = 今天非摘要分支的行为一个字不变。
	 */
	providerDataLastMessageOnly?: boolean;
}

function capLongStringForAI(value: string): string {
	if (value.length <= HISTORY_STRING_HARD_CAP_CHARS) return value;
	return `${value.slice(0, HISTORY_STRING_HARD_CAP_CHARS)}\n…[truncated ${value.length - HISTORY_STRING_HARD_CAP_CHARS} chars]`;
}

/**
 * Same wording the live loop produces for unsupported media
 * (agentToolMessageContentToText → summarizeMediaData), so a rebuilt history
 * shows the model the exact text it saw during the original turn.
 */
function attachmentDataPlaceholder(
	attachment: JsonObject,
	dataChars: number,
): string {
	const kind = attachment.type === "image" ? "Image" : "File";
	const mediaType =
		typeof attachment.mimeType === "string"
			? attachment.mimeType
			: typeof attachment.mediaType === "string"
				? attachment.mediaType
				: "binary";
	return `[${kind}: ${mediaType} data omitted: ${dataChars} chars]`;
}

function sanitizeAttachmentForAI(value: JsonValue): JsonValue {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return sanitizeToolResultForAI(value);
	}
	const record = value as JsonObject;
	const sanitized: JsonObject = {};
	for (const [key, entry] of Object.entries(record)) {
		if (
			(key === "content" || key === "data") &&
			typeof entry === "string" &&
			entry.length > ATTACHMENT_INLINE_CONTENT_MAX_CHARS
		) {
			sanitized[key] = attachmentDataPlaceholder(record, entry.length);
			continue;
		}
		sanitized[key] = sanitizeToolResultForAI(entry);
	}
	return sanitized;
}

export function sanitizeToolResultForAI(
	result: JsonValue | undefined,
): JsonValue {
	if (result === undefined) return null;
	if (typeof result === "string") return capLongStringForAI(result);
	if (!result || typeof result !== "object") return result;

	if (Array.isArray(result)) {
		return result.map(sanitizeToolResultForAI);
	}

	const sanitized: JsonObject = {};
	for (const [key, value] of Object.entries(result)) {
		if (key === "originalContent" || key === "originalContentHash") continue;
		if (key === "attachments" && Array.isArray(value)) {
			sanitized[key] = value.map(sanitizeAttachmentForAI);
			continue;
		}
		sanitized[key] = sanitizeToolResultForAI(value);
	}
	return sanitized;
}

/**
 * Sanitizer for the non-compacted rebuild path: strips binary payloads like
 * the base sanitizer, then falls back to a placeholder when a single result
 * still exceeds the per-result budget.
 */
export function sanitizeHistoryToolResultForAI(
	result: JsonValue | undefined,
): JsonValue {
	const sanitized = sanitizeToolResultForAI(result);
	return jsonLength(sanitized) > HISTORY_TOOL_RESULT_BUDGET_CHARS
		? compactedToolResultPlaceholder(sanitized)
		: sanitized;
}

export function jsonLength(value: JsonValue | undefined): number {
	try {
		return JSON.stringify(value ?? "").length;
	} catch {
		return String(value ?? "").length;
	}
}

export function historyMessagePayloadLength(
	message: CoreHistoryChatMessage,
): number {
	return jsonLength(message as unknown as JsonValue);
}

export function retainedHistoryPayloadLength(
	messages: CoreHistoryChatMessage[],
): number {
	return messages.reduce(
		(sum, message) => sum + historyMessagePayloadLength(message),
		0,
	);
}

export function compactedToolResultPlaceholder(
	result: JsonValue | undefined,
	includePreview = true,
): JsonObject {
	const originalChars = jsonLength(result);
	const placeholder: JsonObject = {
		truncated: true,
		reason:
			"Tool result omitted from compacted history to keep the provider request body within budget.",
		originalChars,
	};

	if (result && typeof result === "object" && !Array.isArray(result)) {
		const title = result.title;
		const error = result.error;
		const output = result.output;
		if (typeof title === "string" && title.length > 0)
			placeholder.title = title.slice(0, 500);
		if (includePreview && typeof error === "string" && error.length > 0)
			placeholder.error = error.slice(0, 1000);
		if (includePreview && typeof output === "string" && output.length > 0) {
			placeholder.outputPreview = output.slice(0, 2000);
		}
	}

	return placeholder;
}

export function sanitizeCompactedToolResultForAI(
	result: JsonValue | undefined,
	budgetChars = COMPACTED_HISTORY_TOOL_RESULT_BUDGET_CHARS,
): JsonValue {
	const sanitized = sanitizeToolResultForAI(result);
	return jsonLength(sanitized) > budgetChars
		? compactedToolResultPlaceholder(sanitized)
		: sanitized;
}

function defaultFailureResultForAI(toolCall: CoreHistoryToolCall): JsonValue {
	return { error: toolCall.error ?? null, status: "failed" };
}

export function compactedFailureToolResultForAI(
	toolCall: CoreHistoryToolCall,
	options: Pick<CoreCompactedToolResultOptions, "failureResultForAI"> = {},
): JsonValue {
	return sanitizeCompactedToolResultForAI(
		options.failureResultForAI?.(toolCall) ??
			defaultFailureResultForAI(toolCall),
	);
}

function buildBudgetedToolResultContent(
	toolCalls: CoreHistoryToolCall[],
	options: CoreCompactedToolResultOptions,
	budgets: { perResultChars: number; totalChars: number },
): Array<{
	type: "tool-result";
	toolCallId: string;
	toolName: string;
	result: JsonValue;
}> {
	let totalResultChars = 0;
	const toolNameForAI = options.getAIToolName ?? getAIToolName;

	return toolCalls.map((toolCall) => {
		const sanitized =
			toolCall.status === "completed"
				? sanitizeToolResultForAI(toolCall.result)
				: sanitizeToolResultForAI(
						options.failureResultForAI?.(toolCall) ??
							defaultFailureResultForAI(toolCall),
					);
		const rawResult =
			jsonLength(sanitized) > budgets.perResultChars
				? compactedToolResultPlaceholder(sanitized)
				: sanitized;
		const resultChars = jsonLength(rawResult);
		const exceedsTotalBudget =
			totalResultChars > 0 &&
			totalResultChars + resultChars > budgets.totalChars;
		const result = exceedsTotalBudget
			? compactedToolResultPlaceholder(sanitized, false)
			: rawResult;

		totalResultChars += jsonLength(result);
		return {
			type: "tool-result" as const,
			toolCallId: toolCall.id,
			toolName: toolNameForAI(toolCall.toolId || toolCall.toolName),
			result,
		};
	});
}

export function buildCompactedToolResultContent(
	toolCalls: CoreHistoryToolCall[],
	options: CoreCompactedToolResultOptions = {},
): Array<{
	type: "tool-result";
	toolCallId: string;
	toolName: string;
	result: JsonValue;
}> {
	return buildBudgetedToolResultContent(toolCalls, options, {
		perResultChars: COMPACTED_HISTORY_TOOL_RESULT_BUDGET_CHARS,
		totalChars: COMPACTED_HISTORY_TOOL_RESULTS_TOTAL_BUDGET_CHARS,
	});
}

/**
 * Tool results for the non-compacted rebuild path. Same machinery as the
 * compacted path with looser budgets: the live loop already bounds what the
 * model saw per turn, so a rebuilt request must never exceed the same order
 * of magnitude.
 */
export function buildHistoryToolResultContent(
	toolCalls: CoreHistoryToolCall[],
	options: CoreCompactedToolResultOptions = {},
): Array<{
	type: "tool-result";
	toolCallId: string;
	toolName: string;
	result: JsonValue;
}> {
	return buildBudgetedToolResultContent(toolCalls, options, {
		perResultChars: HISTORY_TOOL_RESULT_BUDGET_CHARS,
		totalChars: HISTORY_TOOL_RESULTS_TOTAL_BUDGET_CHARS,
	});
}

export function summarizeRetainedMessagesForLog(
	messages: CoreHistoryChatMessage[],
	startIndex: number,
): JsonObject[] {
	return messages.map((message, offset) => {
		const completedToolCalls =
			message.toolCalls?.filter(
				(toolCall) =>
					toolCall.status === "completed" || toolCall.status === "failed",
			) ?? [];
		return {
			index: startIndex + offset,
			id: message.id,
			role: message.role,
			contentChars: message.content?.length ?? 0,
			toolCalls: completedToolCalls.length,
			toolArgChars: completedToolCalls.reduce(
				(sum, toolCall) => sum + jsonLength(toolCall.arguments ?? {}),
				0,
			),
			toolResultChars: completedToolCalls.reduce(
				(sum, toolCall) =>
					sum +
					jsonLength(
						toolCall.status === "completed"
							? toolCall.result
							: { error: toolCall.error },
					),
				0,
			),
			usageInputTokens: message.usage?.inputTokens,
			isStreaming: message.isStreaming === true,
		};
	});
}

export function getHistoryProviderData<TMessage extends CoreHistoryChatMessage>(
	message: TMessage,
	options: Pick<
		CoreBuildHistoryMessagesOptions<unknown, TMessage>,
		"providerDataFromContentPart"
	> = {},
): AgentProviderData[] {
	const providerData: AgentProviderData[] = [];
	for (const part of message.contentParts ?? []) {
		if (part.type !== "provider-data") continue;

		const mapped = options.providerDataFromContentPart?.(part, message);
		if (mapped) {
			providerData.push(mapped);
			continue;
		}

		if (part.providerData) {
			providerData.push(part.providerData);
		}
	}
	return providerData;
}

export function getMessageReasoningContent(
	message: CoreHistoryChatMessage,
): string | undefined {
	const fragments: string[] = [];
	const seen = new Set<string>();

	const push = (text: string | undefined): void => {
		if (!text) return;
		const trimmed = text.trim();
		if (!trimmed || seen.has(trimmed)) return;
		seen.add(trimmed);
		fragments.push(text);
	};

	push(message.reasoning);
	for (const part of message.contentParts ?? []) {
		if (part.type === "reasoning") push(part.content);
	}

	return fragments.length > 0 ? fragments.join("\n\n") : undefined;
}

/** F8:投影侧要用同一条筛法算"哪些调用参与回合重放"(见 `canSplitHistoryTurnGroups`)。 */
export function completedHistoryToolCalls(
	message: CoreHistoryChatMessage,
): CoreHistoryToolCall[] {
	return (
		message.toolCalls?.filter(
			(toolCall) =>
				toolCall.status === "completed" ||
				toolCall.status === "failed" ||
				toolCall.status === "cancelled" ||
				toolCall.status === "input-streaming",
		) ?? []
	);
}

function hasHistoryMessageContent(
	message: CoreHistoryChatMessage,
	providerData: AgentProviderData[],
): boolean {
	const hasToolContext = (message.toolCalls?.length ?? 0) > 0;
	return Boolean(
		message.content ||
			providerData.length > 0 ||
			hasToolContext ||
			(message as CoreHistoryChatMessage & { attachments?: unknown[] })
				.attachments?.length,
	);
}

interface HistoryTurnGroup {
	turnIndex: number;
	texts: string[];
	reasonings: string[];
	toolCalls: CoreHistoryToolCall[];
}

/**
 * Reconstruct the per-completion structure of an assistant message from the
 * persisted turnIndex data (contentParts for text/reasoning, steps for tool
 * calls). Returns undefined — meaning "use the legacy collapsed rebuild" —
 * unless the data is complete enough to split faithfully:
 * every text/reasoning part and every replayed tool call must map to a
 * completion. Old messages persisted before turnIndex existed fall back
 * automatically, so this never guesses.
 */
/**
 * F8(§13.2):上面那条**硬条件**的唯一判定点。
 *
 * 投影侧要在**自己**那份物化消息上算同一遍(算不出分裂 = 整条消息的重建口径
 * 变了,连 reasoning 怎么呈现都跟着变),所以判据必须导出而不是抄一份 ——
 * 抄一份就是第二个判定点,而这条规则恰恰是"两侧必须一致"才有意义。
 *
 * @returns true = 这份数据完整到可以按回合忠实重放。
 */
export function canSplitHistoryTurnGroups(
	message: CoreHistoryChatMessage,
	toolCalls: CoreHistoryToolCall[],
): boolean {
	return splitAssistantMessageIntoTurnGroups(message, toolCalls) !== undefined;
}

/**
 * F1-c(§16.15):比"逐格相加 == 整条正文"时用的归一 —— 只抹空白。
 *
 * 分裂路径粘的是 `\n\n`,实时写 `content` 的是 delta 直接累加:健康的消息两者
 * 只在空白上不同。抹掉空白之后仍然不等 = 真的少了(或多了)一段正文。
 */
function stripHistoryTextWhitespace(text: string): string {
	return text.replace(/\s+/g, "");
}

/**
 * F1-c(§16.15):这条消息的 `contentParts` 把 `message.content` 装全了吗。
 *
 * **分裂重放的前置条件,也是唯一的判定点** —— 投影那边要在自己那份物化消息上
 * 问同一个问题(看得见这一类退化),抄一份就是第二个判定点。
 *
 * `content` 为空 = 没有正文可丢,不问。
 */
export function historyContentPartsCoverContent(
	message: CoreHistoryChatMessage,
): boolean {
	const content = message.content ?? "";
	if (!content) return true;
	let partsText = "";
	for (const part of message.contentParts ?? []) {
		if (part.type === "text" && part.content) partsText += part.content;
	}
	return (
		stripHistoryTextWhitespace(content) ===
		stripHistoryTextWhitespace(partsText)
	);
}

function splitAssistantMessageIntoTurnGroups(
	message: CoreHistoryChatMessage,
	toolCalls: CoreHistoryToolCall[],
): HistoryTurnGroup[] | undefined {
	const parts = message.contentParts ?? [];
	const groups = new Map<number, HistoryTurnGroup>();
	const group = (turnIndex: number): HistoryTurnGroup => {
		let entry = groups.get(turnIndex);
		if (!entry) {
			entry = { turnIndex, texts: [], reasonings: [], toolCalls: [] };
			groups.set(turnIndex, entry);
		}
		return entry;
	};

	for (const part of parts) {
		if (part.type !== "text" && part.type !== "reasoning") continue;
		if (!part.content) continue;
		if (typeof part.turnIndex !== "number") return undefined;
		if (part.type === "text") group(part.turnIndex).texts.push(part.content);
		else group(part.turnIndex).reasonings.push(part.content);
	}

	const turnByCallId = new Map<string, number>();
	for (const step of message.steps ?? []) {
		if (step.toolCallId && typeof step.turnIndex === "number") {
			turnByCallId.set(step.toolCallId, step.turnIndex);
		}
	}
	for (const toolCall of toolCalls) {
		const turnIndex = turnByCallId.get(toolCall.id);
		if (turnIndex === undefined) return undefined;
		group(turnIndex).toolCalls.push(toolCall);
	}

	// The message-level content string is the merged rendering; the per-turn
	// texts must add up to it, or the parts are not authoritative.
	//
	// F1-c(§16.15):从前这里只挡住"一格 part 文本都没有"那一端 —— 而真正会
	// **吞正文**的是"少了一格"。`contentParts` 有一道 `requestSettled` 闸
	// (被 abort / 出错重试的那一轮不落 part),`message.content` 没有:那一轮的
	// 正文实时写在 content 上、却没有对应的 part。分裂路径只按 part 重放,于是
	// 那一段真实正文在下一次请求里凭空消失,而 collapsed 路径原样带着它。
	//
	// 所以判据收紧成"逐格相加 == 整条正文"。比较**忽略空白**:分裂路径按
	// `\n\n` 重新粘,而 content 是 delta 直接累加的,两者只在空白上不同。
	// 方向是保守的 —— 对不上就不分裂(退回 collapsed),宁可少一次忠实重放,
	// 不肯丢一个字。content 为空时不问(那时没有正文可丢)。
	if (!historyContentPartsCoverContent(message)) return undefined;

	return [...groups.values()].sort((a, b) => a.turnIndex - b.turnIndex);
}

function appendHistoryMessage<
	TContent,
	TMessage extends CoreHistoryChatMessage,
>(
	result: CoreHistoryMessage[],
	message: TMessage,
	options: CoreBuildHistoryMessagesOptions<TContent, TMessage>,
	providerData: AgentProviderData[],
	useCompactedToolResults: boolean,
): void {
	const toolNameForAI = options.getAIToolName ?? getAIToolName;

	if (message.role === "user") {
		result.push({
			role: "user",
			content: options.buildMessageContent(message),
		});
		return;
	}

	// Faithful rebuild: replay a multi-completion assistant message as the
	// same sequence of assistant/tool elements the API produced live, instead
	// of one merged monologue with every tool call batched at the end.
	// providerData (encrypted reasoning etc.) is message-scoped, so messages
	// carrying it keep the legacy collapsed shape untouched.
	if (providerData.length === 0) {
		const replayedToolCalls = completedHistoryToolCalls(message);
		const turnGroups = splitAssistantMessageIntoTurnGroups(
			message,
			replayedToolCalls,
		);
		if (turnGroups && turnGroups.length > 1) {
			// Budget the results in one pass over the whole message (identical
			// byte semantics to the collapsed path), then distribute per turn.
			const budgetedResults = new Map(
				(useCompactedToolResults
					? buildCompactedToolResultContent(replayedToolCalls, {
							getAIToolName: toolNameForAI,
							failureResultForAI: options.failureResultForAI,
						})
					: buildHistoryToolResultContent(replayedToolCalls, {
							getAIToolName: toolNameForAI,
							failureResultForAI: options.failureResultForAI,
						})
				).map((entry) => [entry.toolCallId, entry]),
			);

			for (const turn of turnGroups) {
				if (turn.texts.length === 0 && turn.toolCalls.length === 0) continue;
				// F6:一次性构造,不再先建后改 —— 历史重建产出的是新对象,
				// 任何「先 push 再补字段」的写法都会诱使人对着会话里的那条改。
				const reasoning = turn.reasonings.join("\n\n").trim();
				const assistantMessage: CoreHistoryMessage & { role: "assistant" } = {
					role: "assistant",
					content: turn.texts.join("\n\n"),
					...(reasoning ? { reasoningContent: reasoning } : {}),
					...(turn.toolCalls.length > 0
						? {
								toolCalls: turn.toolCalls.map((toolCall) => ({
									toolCallId: toolCall.id,
									toolName: toolNameForAI(toolCall.toolId || toolCall.toolName),
									args: toolCall.arguments,
								})),
							}
						: {}),
				};
				result.push(assistantMessage);

				if (turn.toolCalls.length > 0) {
					const turnResults = turn.toolCalls
						.map((toolCall) => budgetedResults.get(toolCall.id))
						.filter((entry) => entry !== undefined);
					if (turnResults.length > 0) {
						result.push({ role: "tool", content: turnResults });
					}
				}
			}
			return;
		}
	}

	const reasoningContent = getMessageReasoningContent(message);
	const completedToolCalls = completedHistoryToolCalls(message);
	// F6:同上,一次性构造。
	const assistantMessage: CoreHistoryMessage & { role: "assistant" } = {
		role: "assistant",
		content: options.buildMessageContent(message),
		...(reasoningContent ? { reasoningContent } : {}),
		...(providerData.length > 0 ? { providerData } : {}),
		...(completedToolCalls.length > 0
			? {
					toolCalls: completedToolCalls.map((toolCall) => ({
						toolCallId: toolCall.id,
						toolName: toolNameForAI(toolCall.toolId || toolCall.toolName),
						args: toolCall.arguments,
					})),
				}
			: {}),
	};

	result.push(assistantMessage);

	if (completedToolCalls.length === 0) return;

	result.push({
		role: "tool",
		content: useCompactedToolResults
			? buildCompactedToolResultContent(completedToolCalls, {
					getAIToolName: toolNameForAI,
					failureResultForAI: options.failureResultForAI,
				})
			: buildHistoryToolResultContent(completedToolCalls, {
					getAIToolName: toolNameForAI,
					failureResultForAI: options.failureResultForAI,
				}),
	});
}

/**
 * 压缩摘要在模型历史里的那条 user 消息的正文。
 *
 * 抽出来是因为它现在有两个产出口:今天的 `buildHistoryMessages`(按
 * `session.summary` + 锚点切片)与 S 线的 `projectModelHistory`(按 surface 上
 * 的 `session/compacted` 节点)。两边必须逐字节相同,否则同一次压缩后
 * "从消息重建"与"从事件投影"发给模型的第一条就不一样了。
 */
export function compactedHistoryPreamble(summary: string): string {
	return `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`;
}

export function buildHistoryMessages<
	TContent = unknown,
	TMessage extends CoreHistoryChatMessage = CoreHistoryChatMessage,
>(
	messages: TMessage[],
	session: CoreHistorySessionSummary | undefined,
	options: CoreBuildHistoryMessagesOptions<TContent, TMessage>,
): CoreHistoryMessage[] {
	if (session?.summary && session.summaryUpToMessageId) {
		const summaryIndex = messages.findIndex(
			(message) => message.id === session.summaryUpToMessageId,
		);
		if (summaryIndex !== -1) {
			const recentMessages = messages.slice(summaryIndex + 1);
			const result: CoreHistoryMessage[] = [
				// C5(2026-08-14 拍板):注入**只有这一条** user 消息。从前跟着一条
				// 伪造的 assistant 握手("Understood…"),它的唯一作用是给严格
				// user/assistant 交替的 provider(DeepSeek 系)垫一条 —— 历史里为
				// 了迁就传输层而放一条模型从没说过的话,是在会话事实里掺假。
				// 交替风险改由 provider 适配层的相邻同角色合并兜底
				// (packages/onething-runtime/src/agent-loop/providers/)。
				{
					role: "user",
					content: compactedHistoryPreamble(session.summary),
				},
			];

			// Deliberately NO budget trimming here. A full→degraded→dropped
			// selection was tried and removed: degraded mode shrinks assistant
			// messages but not user messages, so a fat user message could be
			// dropped while its assistant reply survived — consecutive
			// assistant turns that providers misread. The compacted tail ships
			// whole; only per-tool-result caps apply (compacted result content).
			for (const message of recentMessages) {
				if (message.role !== "user" && message.role !== "assistant") continue;
				if (message.isStreaming) continue;
				const providerData =
					message === recentMessages[recentMessages.length - 1]
						? getHistoryProviderData(message, options)
						: [];
				if (!hasHistoryMessageContent(message, providerData)) continue;
				appendHistoryMessage(result, message, options, providerData, true);
			}

			options.onCompactedHistory?.({
				sessionId: session.id,
				summaryUpToMessageId: session.summaryUpToMessageId,
				summaryIndex,
				totalSessionMessages: messages.length,
				recentSessionMessages: recentMessages.length,
				retainedRecentMessages: recentMessages.length,
				degradedRecentMessages: 0,
				droppedRecentMessages: 0,
				retainedPayloadChars: retainedHistoryPayloadLength(recentMessages),
				originalRecentPayloadChars:
					retainedHistoryPayloadLength(recentMessages),
				retainedPayloadBudgetChars:
					COMPACTED_HISTORY_RETAINED_PAYLOAD_BUDGET_CHARS,
				summaryChars: session.summary.length,
				retainedMessages: summarizeRetainedMessagesForLog(
					recentMessages,
					summaryIndex + 1,
				),
				degradedMessageIds: [],
				droppedMessages: [],
				resultMessages: result,
			});

			return result;
		}

		options.onMissingSummaryAnchor?.({
			sessionId: session.id,
			summaryUpToMessageId: session.summaryUpToMessageId,
		});
	}

	const result: CoreHistoryMessage[] = [];
	const useCompactedToolResults = options.forceCompactedToolResults === true;
	// F1(session-event-sourcing §13.2):压缩之后 providerData 只取**最后一条**
	// 保留消息 —— 上面那条摘要分支里写死的规则
	// (`message === recentMessages[recentMessages.length - 1]`)。
	//
	// 这条分支平时逐条求值,两者一直不同而没人发现,是因为在 A1 补上采集点之前
	// 事件侧根本没有 provider-data 的生产者。投影在压缩之后走的正是这条分支
	// (摘要切点已经由 surface 表达,`session` 传 undefined),所以它必须能表达
	// 同一条规则,否则 codex/claude 的加密推理会被重复发 N 份。
	//
	// 判据与摘要分支逐字相同:比的是**数组最后一个元素**,不是"最后一条被采纳的
	// 消息" —— 末尾那条若被角色过滤或 isStreaming 挡掉,那一轮就一条都不带。
	const providerDataLastOnly = options.providerDataLastMessageOnly === true;
	const lastMessage = messages[messages.length - 1];
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		if (message.isStreaming) continue;
		const providerData =
			providerDataLastOnly && message !== lastMessage
				? []
				: getHistoryProviderData(message, options);
		if (!hasHistoryMessageContent(message, providerData)) continue;
		appendHistoryMessage(
			result,
			message,
			options,
			providerData,
			useCompactedToolResults,
		);
	}

	return result;
}

export function filterHistoryForNonToolAPI<TContent = unknown>(
	messages: CoreHistoryMessage[],
): Array<{
	role: "user" | "assistant";
	content: TContent;
	reasoningContent?: string;
}> {
	return messages
		.filter(
			(
				message,
			): message is CoreHistoryMessage & { role: "user" | "assistant" } =>
				message.role === "user" || message.role === "assistant",
		)
		.map((message) => {
			if (message.role === "user") {
				return { role: "user" as const, content: message.content as TContent };
			}
			const result: {
				role: "assistant";
				content: TContent;
				reasoningContent?: string;
			} = {
				role: "assistant",
				content: message.content as TContent,
			};
			if (message.reasoningContent) {
				result.reasoningContent = message.reasoningContent;
			}
			return result;
		});
}

export function historyMessagesForLog(
	messages: CoreHistoryMessage[],
): CoreChatLogMessageShape[] {
	return messages.map((message) => {
		if (message.role === "assistant") {
			return {
				role: message.role,
				content: message.content as CoreChatLogValue,
				toolCalls: message.toolCalls as CoreChatLogMessageShape["toolCalls"],
				reasoningContent: message.reasoningContent,
			};
		}

		return {
			role: message.role,
			content: message.content as CoreChatLogValue,
		};
	});
}

const RESUME_TERMINAL_TOOL_CALL_STATUSES = new Set([
	"completed",
	"failed",
	"cancelled",
	"input-streaming",
]);

export function buildResumeHistoryAfterToolConfirmation(
	historyWithoutCurrent: CoreHistoryMessage[],
	assistantMessage: CoreResumeAssistantMessage,
): CoreHistoryMessage[] {
	// Non-terminal siblings (pending/queued/executing) must not be reported as
	// failed `{error: null}` results — drop them from both sides so the pairing
	// stays 1:1 and the model never sees fabricated outcomes.
	const toolCalls = (assistantMessage.toolCalls ?? []).filter(
		(toolCall) =>
			toolCall.status === undefined ||
			RESUME_TERMINAL_TOOL_CALL_STATUSES.has(toolCall.status),
	);
	return [
		...historyWithoutCurrent,
		{
			role: "assistant",
			content: assistantMessage.content || "",
			toolCalls: toolCalls.map((toolCall) => ({
				toolCallId: toolCall.id,
				toolName: getAIToolName(toolCall.toolId || toolCall.toolName),
				args: toolCall.arguments,
			})),
			...(assistantMessage.reasoning && {
				reasoningContent: assistantMessage.reasoning,
			}),
		},
		{
			role: "tool",
			content: buildHistoryToolResultContent(toolCalls, {
				// Mirror defaultFailureResultForAI: the status field is what
				// downstream providers read to mark the tool_result as an error.
				failureResultForAI: (toolCall) => ({
					error: toolCall.error ?? null,
					status: "failed",
				}),
			}),
		},
	];
}
