import { toLogger, type CompatLogger, type Logger } from '../logging/index.js'

/** A named prompt section with its content (for hash-based versioning and snapshots). */
export interface CorePromptSection {
	name: string;
	content: string;
}

/** A serializable request message for context snapshots (whitelist of AgentMessage fields). */
export interface CoreRequestMessage {
	role: string;
	content: unknown;
	reasoningContent?: string;
	toolCalls?: Array<{
		toolCallId?: string;
		toolName?: string;
		args?: unknown;
	}>;
	toolCallId?: string;
}

/** Captured prompt context at turn time (actual bytes sent to the model). */
export interface CorePromptCapture {
	/** The complete system prompt sent this turn. */
	systemPrompt: string;
	/** Named sections that compose the system prompt. */
	sections: CorePromptSection[];
	/** Per-section hashes (sha256 first 8 chars). */
	sectionHashes: Record<string, string>;
	/** Serialized request messages (capability-transformed view). Optional, for .context.jsonl. */
	requestMessages?: CoreRequestMessage[];
	/** API request body for .request.json snapshot (model, messages, tools, params). */
	rawRequest?: CoreEvalRawRequest;
	/** API response body for .response.json snapshot (content, toolCalls, usage, finishReason). */
	rawResponse?: CoreEvalRawResponse;
}

/** Structured API request body for eval .request.json snapshot. */
export interface CoreEvalRawRequest {
	model: string;
	systemPrompt: string;
	messages: CoreRequestMessage[];
	tools?: Array<{
		type: "function";
		function: { name: string; description: string; parameters: unknown };
	}>;
	toolChoice?: string;
	temperature?: number;
	maxTokens?: number;
	thinking?: "enabled" | "disabled";
	reasoningEffort?: string;
}

/** Structured API response body for eval .response.json snapshot. */
export interface CoreEvalRawResponse {
	content: string;
	toolCalls?: Array<{
		id: string;
		name: string;
		args: unknown;
	}>;
	finishReason?: string;
	usage?: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
	};
}

export interface CoreTriggerContext<
	TSettings = unknown,
	TSession = unknown,
	TMessage = unknown,
	TProviderConfig = unknown,
> {
	sessionId: string;
	session: TSession;
	messages: TMessage[];
	lastUserMessage: string;
	lastAssistantMessage: string;
	providerId: string;
	providerConfig: TProviderConfig;
	settings: TSettings;
	toolIterations?: number;
	skillManageCalled?: boolean;
	enabledToolNames?: string[];
	/** Captured prompt at turn time (available on negative-signal turns). */
	promptCapture?: CorePromptCapture;
}

export interface CoreTrigger<TContext = CoreTriggerContext> {
	id: string;
	name: string;
	priority: number;
	shouldTrigger(ctx: TContext): Promise<boolean>;
	execute(ctx: TContext): Promise<void>;
}

/** @deprecated 统一为 `Logger`(§8.3 区 ①);过渡期仍收老鸭子形状。 */
export type CoreTriggerManagerLogger = CompatLogger;

export class CoreTriggerManager<TContext = CoreTriggerContext> {
	private triggers: Array<CoreTrigger<TContext>> = [];
	private enabled = true;

	private readonly logger: Logger;

	constructor(logger?: CoreTriggerManagerLogger) {
		this.logger = toLogger(logger);
	}

	register(trigger: CoreTrigger<TContext>): void {
		const existing = this.triggers.find((item) => item.id === trigger.id);
		if (existing) {
			this.logger.warn(
				`[TriggerManager] Trigger ${trigger.id} already registered, skipping`,
			);
			return;
		}

		this.triggers.push(trigger);
		this.triggers.sort((a, b) => a.priority - b.priority);
		this.logger.debug(
			`[TriggerManager] Registered trigger: ${trigger.name} (priority: ${trigger.priority})`,
		);
	}

	unregister(triggerId: string): void {
		const index = this.triggers.findIndex(
			(trigger) => trigger.id === triggerId,
		);
		if (index !== -1) {
			const trigger = this.triggers[index];
			this.triggers.splice(index, 1);
			this.logger.debug(`[TriggerManager] Unregistered trigger: ${trigger.name}`);
		}
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		this.logger.debug(
			`[TriggerManager] Triggers ${enabled ? "enabled" : "disabled"}`,
		);
	}

	getTriggers(): Array<CoreTrigger<TContext>> {
		return [...this.triggers];
	}

	async runPostResponse(ctx: TContext & { sessionId: string }): Promise<void> {
		if (!this.enabled) {
			this.logger.debug("[TriggerManager] Triggers disabled, skipping");
			return;
		}

		if (this.triggers.length === 0) {
			return;
		}

		this.logger.debug(
			`[TriggerManager] Running ${this.triggers.length} triggers for session ${ctx.sessionId}`,
		);

		for (const trigger of this.triggers) {
			try {
				const shouldRun = await trigger.shouldTrigger(ctx);
				if (shouldRun) {
					this.logger.debug(
						`[TriggerManager] Executing trigger: ${trigger.name}`,
					);
					await trigger.execute(ctx);
					this.logger.debug(
						`[TriggerManager] Completed trigger: ${trigger.name}`,
					);
				}
			} catch (error) {
				this.logger.error(
					`[TriggerManager] Trigger ${trigger.name} failed:`,
					undefined, error,
				);
			}
		}
	}
}
