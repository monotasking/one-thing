// 回复后钩子:一次助手回复落定之后,给触发器与插件的 `afterAssistantResponse` 准备上下文并依次跑它们
// (从 `agent-loop-executor.ts` 拆出,拆分批 1,D226)。它与执行器其余部分不共用任何声明。
import type { CorePromptCapture } from "./agent-loop-triggers.js";
import {
	getTextFromContent,
	type CoreAIMessageContent,
} from "./agent-loop-message-content.js";

export interface CorePreparedToolNames {
	toolNames: string[];
	mcpToolNames: string[];
}

export interface CoreAgentLoopPostResponseSession<TMessage = unknown> {
	messages: TMessage[];
	/**
	 * F4 身份面:会话绑定的 agent。只被 afterAssistantResponse 的 ctx 读一次
	 * (纯透传,零新状态)。触发器那条 ctx 不加这个字段 —— 它的既有消费者都用
	 * `session` 本体,再摊平一份只会多一条要保持同步的事实。
	 */
	agentId?: string;
}

export interface CoreAgentLoopPostResponseTriggerContext<
	TSession,
	TMessage,
	TProviderConfig,
	TSettings,
> {
	sessionId: string;
	session: TSession;
	messages: TMessage[];
	lastUserMessage: string;
	lastAssistantMessage: string;
	providerId: string;
	providerConfig: TProviderConfig;
	settings: TSettings;
	toolIterations: number;
	skillManageCalled: boolean;
	enabledToolNames: string[];
	/** Captured prompt at turn time (available on negative-signal turns). */
	promptCapture?: CorePromptCapture;
}

export interface CoreAgentLoopAfterAssistantResponseContext<
	TSession,
	TMessage,
	TProviderConfig,
	TSettings,
> extends CoreAgentLoopPostResponseTriggerContext<
		TSession,
		TMessage,
		TProviderConfig,
		TSettings
	> {
	assistantMessageId: string;
	/** F4:回合归属的 agent(源头 `session.agentId`;缺省 = 没绑 agent)。 */
	agentId?: string;
}

export interface CoreAgentLoopPostResponseContexts<
	TSession,
	TMessage,
	TProviderConfig,
	TSettings,
> {
	triggerContext: CoreAgentLoopPostResponseTriggerContext<
		TSession,
		TMessage,
		TProviderConfig,
		TSettings
	>;
	afterAssistantResponseContext: CoreAgentLoopAfterAssistantResponseContext<
		TSession,
		TMessage,
		TProviderConfig,
		TSettings
	>;
}

export interface RunAgentLoopPostResponseHooksWithAdaptersOptions<
	TSession extends CoreAgentLoopPostResponseSession<TMessage>,
	TMessage,
	TProviderConfig,
	TSettings,
> {
	sessionId: string;
	assistantMessageId: string;
	lastAssistantMessage: string | undefined;
	historyMessages: CoreHistoryMessageWithContent[];
	providerId: string;
	providerConfig: TProviderConfig;
	settings: TSettings;
	toolIterations: number;
	skillManageCalled: boolean;
	prepared: CorePreparedToolNames;
	promptCapture?: CorePromptCapture;
	getSession: (sessionId: string) => TSession | undefined;
	runTriggerContext: (
		context: CoreAgentLoopPostResponseTriggerContext<
			TSession,
			TMessage,
			TProviderConfig,
			TSettings
		>,
	) => void | Promise<void>;
	runAfterAssistantResponse: (
		context: CoreAgentLoopAfterAssistantResponseContext<
			TSession,
			TMessage,
			TProviderConfig,
			TSettings
		>,
	) => void | Promise<void>;
	onError?: (
		source: "trigger" | "afterAssistantResponse",
		error: unknown,
	) => void;
}

export interface CoreHistoryMessageWithContent {
	role: string;
	content: unknown;
}

export function enabledToolNames(prepared: CorePreparedToolNames): string[] {
	return [...prepared.toolNames, ...prepared.mcpToolNames];
}

export function lastUserMessageText(
	historyMessages: CoreHistoryMessageWithContent[],
): string {
	for (let index = historyMessages.length - 1; index >= 0; index--) {
		const message = historyMessages[index];
		if (message.role !== "user") continue;
		if (typeof message.content === "string" || Array.isArray(message.content)) {
			return getTextFromContent(message.content as CoreAIMessageContent);
		}
		return "";
	}
	return "";
}

function lastAssistantMessageText(
	historyMessages: CoreHistoryMessageWithContent[],
): string {
	for (let index = historyMessages.length - 1; index >= 0; index--) {
		const message = historyMessages[index];
		if (message.role !== "assistant") continue;
		if (typeof message.content === "string" || Array.isArray(message.content)) {
			const text = getTextFromContent(message.content as CoreAIMessageContent);
			if (text) return text;
		}
	}
	return "";
}

export function buildAgentLoopPostResponseContexts<
	TSession extends CoreAgentLoopPostResponseSession<TMessage>,
	TMessage,
	TProviderConfig,
	TSettings,
>(input: {
	session: TSession | undefined;
	sessionId: string;
	assistantMessageId: string;
	lastAssistantMessage: string | undefined;
	historyMessages: CoreHistoryMessageWithContent[];
	providerId: string;
	providerConfig: TProviderConfig;
	settings: TSettings;
	toolIterations: number;
	skillManageCalled: boolean;
	prepared: CorePreparedToolNames;
	promptCapture?: CorePromptCapture;
}): CoreAgentLoopPostResponseContexts<
	TSession,
	TMessage,
	TProviderConfig,
	TSettings
> | null {
	if (!input.session) return null;

	// A run cut off (max_turns, stream loss) can end with no trailing assistant
	// text. Post-response hooks (goal cross-run continuation, triggers) must
	// still fire, so fall back to the last assistant text in history, then to a
	// synthetic placeholder.
	const lastAssistantMessage = input.lastAssistantMessage?.trim()
		? input.lastAssistantMessage
		: lastAssistantMessageText(input.historyMessages) ||
			"(assistant turn ended without trailing text)";

	const triggerContext: CoreAgentLoopPostResponseTriggerContext<
		TSession,
		TMessage,
		TProviderConfig,
		TSettings
	> = {
		sessionId: input.sessionId,
		session: input.session,
		messages: input.session.messages,
		lastUserMessage: lastUserMessageText(input.historyMessages),
		lastAssistantMessage,
		providerId: input.providerId,
		providerConfig: input.providerConfig,
		settings: input.settings,
		toolIterations: input.toolIterations,
		skillManageCalled: input.skillManageCalled,
		enabledToolNames: enabledToolNames(input.prepared),
		promptCapture: input.promptCapture,
	};

	return {
		triggerContext,
		afterAssistantResponseContext: {
			...triggerContext,
			assistantMessageId: input.assistantMessageId,
			// F4:身份透传。会话本体已经带着它,这里只是把它摊到 ctx 的一等字段上,
			// 免得每个插件各写一遍 `(ctx.session as any).agentId`。
			...(input.session.agentId ? { agentId: input.session.agentId } : {}),
		},
	};
}

export function runAgentLoopPostResponseHooksWithAdapters<
	TSession extends CoreAgentLoopPostResponseSession<TMessage>,
	TMessage,
	TProviderConfig,
	TSettings,
>(
	options: RunAgentLoopPostResponseHooksWithAdaptersOptions<
		TSession,
		TMessage,
		TProviderConfig,
		TSettings
	>,
): CoreAgentLoopPostResponseContexts<
	TSession,
	TMessage,
	TProviderConfig,
	TSettings
> | null {
	const contexts = buildAgentLoopPostResponseContexts<
		TSession,
		TMessage,
		TProviderConfig,
		TSettings
	>({
		session: options.getSession(options.sessionId),
		sessionId: options.sessionId,
		assistantMessageId: options.assistantMessageId,
		lastAssistantMessage: options.lastAssistantMessage,
		historyMessages: options.historyMessages,
		providerId: options.providerId,
		providerConfig: options.providerConfig,
		settings: options.settings,
		toolIterations: options.toolIterations,
		skillManageCalled: options.skillManageCalled,
		prepared: options.prepared,
		promptCapture: options.promptCapture,
	});
	if (!contexts) return null;

	const run = (
		source: "trigger" | "afterAssistantResponse",
		callback: () => void | Promise<void>,
	): void => {
		try {
			Promise.resolve(callback()).catch((error) =>
				options.onError?.(source, error),
			);
		} catch (error) {
			options.onError?.(source, error);
		}
	};

	run("trigger", () => options.runTriggerContext(contexts.triggerContext));
	run("afterAssistantResponse", () =>
		options.runAfterAssistantResponse(contexts.afterAssistantResponseContext),
	);

	return contexts;
}
