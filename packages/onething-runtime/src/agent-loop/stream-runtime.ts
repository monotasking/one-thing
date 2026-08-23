import {
	agentMessagesFromHistory,
	agentProviderCanRunTurn,
	agentSupportsTools,
	buildAgentLoopRuntime,
	resolveAgentModelCapabilities,
	streamAgentLoopProviderChunks,
	type AgentHistoryMessage,
	type AgentLoopOptions,
	type AgentLoopResult,
	type AgentMessage,
	type AgentModelCapabilities,
	type AgentOutputModality,
	type AgentProvider,
	type AgentProviderStreamChunk,
	type AgentSkillContext,
	type AgentSourceToolDefinition,
	type AgentToolChoice,
} from "@onething/core/agent-loop";
import type { Principal } from "@onething/core/permission";
import {
	agentLoopInitSkills,
	agentLoopSkillContexts,
	buildAgentLoopDirectToolsWithAdapters,
	createCoreId,
	getAgentLoopTransientTail,
	maybeCompactAgentLoopContextWithAdapters,
	planAgentLoopPromptBuildOptions,
	planAgentLoopRuntimePreparation,
	planAgentLoopTools,
	resolveAgentLoopContextBudgetWithRegistry,
	injectPendingAgentLoopMessagesWithAdapters,
	runAgentLoopAfterTurnWithAdapters,
	runAgentLoopBeforeTurnWithAdapters,
	type CoreAgentLoopCompactResultLike,
	type CoreAgentLoopCompactSessionLike,
	type CoreAgentLoopContextBudget,
	type CoreAgentLoopDirectToolMetadataUpdate,
	type CoreAgentLoopDirectToolResultLike,
	type CoreAgentLoopInitSkillSnapshot,
	type CoreAgentLoopPendingMessageAdapters,
	type CoreAgentLoopProviderHostContext,
	type CoreAgentLoopProviderRuntimeConfigLike,
	type CoreAgentLoopRuntimeSessionLike,
	type CoreAgentLoopRuntimeSettingsLike,
	type CoreAgentLoopRuntimeToolSettingsLike,
	type CoreAgentLoopSkillLike,
	type CoreBuildPromptOptions,
	type CoreBuildPromptResult,
	type CorePendingAgentLoopChatMessage,
	type PromptSection,
	type CorePendingAgentLoopInputMessage,
	type CorePromptRequestMessage,
} from "@onething/core/engine";
import type { JsonObject } from "@onething/core";
import {
	createAgentProviderFromRuntime,
	getOnethingAgentLoopThinkingOptions,
	isAgentProviderRuntimeSupported,
	type AgentProviderRuntimeConfig,
	type CreateAgentProviderFromRuntimeOptions,
} from "./providers/index.js";
import { readOnethingRequestProviderOptions } from "../providers/provider-options.js";
import { createTurnTraceRecorder } from "../evals/trace-store.js";
import {
	DEFAULT_AGENT_MAX_TURNS,
	type EffectiveAgentProfile,
} from "../agents/profile.js";
// 缝 1。目录由装配层通过 `configureToolkitCatalog` 递进来 —— 产品层不许
// import `@onething/backend`。
import {
	resolveToolkitSurface,
	toolkitAgentSourceTools,
} from "../toolkit/host.js";
import type { SceneSessionLike as ToolkitSceneSessionLike } from "../toolkit/scene.js";

import { SESSION_EVENT_TYPES } from "@shared/events/index.js";

export interface OnethingAgentLoopChatSettings {
	maxTokens?: number;
	/**
	 * Model round-trips allowed per run before the loop stops with
	 * finishReason 'max_turns'. The core runner's own default (8) is far too
	 * small for real tool-heavy work — every chat run, not just goal-driven
	 * ones, was silently truncated mid-task with no user-facing signal.
	 */
	maxTurns?: number;
	contextCompactThreshold?: number;
	contextCompactEnabled?: boolean;
	contextCompactKeepRecentTurns?: number;
}

/** Applied when neither the agent profile nor settings.chat.maxTurns says. */
export const DEFAULT_CHAT_MAX_TURNS = DEFAULT_AGENT_MAX_TURNS;

export interface OnethingAgentLoopRuntimeSettings<
	TToolSettings extends CoreAgentLoopRuntimeToolSettingsLike | undefined =
		| CoreAgentLoopRuntimeToolSettingsLike
		| undefined,
> extends CoreAgentLoopRuntimeSettingsLike<TToolSettings> {
	chat?: OnethingAgentLoopChatSettings;
}

export interface OnethingAgentLoopRuntimeContext<
	TSettings extends OnethingAgentLoopRuntimeSettings<TToolSettings>,
	TProviderConfig extends CoreAgentLoopProviderRuntimeConfigLike,
	TToolSettings extends CoreAgentLoopRuntimeToolSettingsLike | undefined =
		| CoreAgentLoopRuntimeToolSettingsLike
		| undefined,
> {
	sessionId: string;
	assistantMessageId: string;
	providerId: string;
	providerConfig: TProviderConfig;
	settings: TSettings;
	toolSettings?: TToolSettings;
	requestedOutputModalities?: AgentOutputModality[];
	abortSignal?: AbortSignal;
	steeringQueue?: OnethingAgentLoopPendingMessageQueue;
	followUpQueue?: OnethingAgentLoopPendingMessageQueue;
	voiceConversation?: boolean;
	speakMode?: boolean;
	/**
	 * Forced tool choice for this run's FIRST model call only (W18b). Rides in
	 * from the send-message command; the core runner applies it to iteration 1
	 * and drops it when the model does not advertise forced tool use.
	 */
	initialToolChoice?: AgentToolChoice;
	/** Actor behind this turn; minted at the engine boundary, carried to tools. */
	principal?: Principal;
	/**
	 * The turn's capability profile, resolved ONCE by the assembly layer before
	 * the run starts (product code cannot read the agent store — that would
	 * point the dependency backwards). Absent means "host without agents": the
	 * adapter/settings fallbacks below still apply.
	 */
	agentProfile?: EffectiveAgentProfile;
}

export interface OnethingAgentLoopPendingMessageQueue {
	drain(): CorePendingAgentLoopInputMessage[];
	enqueue?(message: CorePendingAgentLoopInputMessage): void;
}

export interface OnethingAgentLoopProjectPromptVars {
	active?: CoreBuildPromptOptions["activeProject"];
	known?: CoreBuildPromptOptions["knownProjects"];
}

export interface OnethingAgentLoopLogger {
	log?: (...args: unknown[]) => void;
	info?: (...args: unknown[]) => void;
	warn?: (...args: unknown[]) => void;
	error?: (...args: unknown[]) => void;
}

export interface OnethingAgentLoopPromptResult<
	TPromptMessage extends CorePromptRequestMessage = CorePromptRequestMessage,
> extends Omit<CoreBuildPromptResult, "messages"> {
	messages: TPromptMessage[];
}

/**
 * Session-goal hooks (see docs/design/goal-system.md). Hosts without a goal
 * subsystem omit this. All state lives behind the host's GoalManager; the
 * loop only asks "which prompt should I inject" at two points:
 * - recordUsage: per model round; returns the budget wrap-up steering prompt
 *   exactly once when the goal flips to budget_limited
 * - beginContinuation: when the run would end normally; registers one
 *   continuation and returns its prompt, or undefined to let the run end
 */
export interface OnethingAgentLoopGoalHooks {
	recordUsage(
		sessionId: string,
		usage: { totalTokens?: number },
	): string | undefined;
	beginContinuation(sessionId: string): string | undefined;
}

/**
 * 草稿纸(scratchpad · AI 静默感知)。宿主没接 = 一个字节都不变。
 *
 * 这里只问一句"本 turn 的尾块是什么" —— 纸住在哪、怎么读、超长怎么截,全在
 * 装配层。产品层读不到 `@onething/backend`(依赖单向:产品 ← 装配),所以它必须
 * 以回调的形式**注入进来**,而不是被 import 进来。
 */
export interface OnethingAgentLoopScratchpadHooks {
	/** 返回 undefined = 纸是空的 / 这张纸不存在,这一轮不挂任何东西。 */
	buildTail(
		sessionId: string,
		turn: number,
	): Promise<{ text: string; version: number } | undefined>;
}

export interface OnethingAgentLoopRuntimeAdapters<
	TSettings extends OnethingAgentLoopRuntimeSettings<TToolSettings>,
	TProviderConfig extends CoreAgentLoopProviderRuntimeConfigLike,
	TToolSettings extends CoreAgentLoopRuntimeToolSettingsLike | undefined,
	TSession extends CoreAgentLoopRuntimeSessionLike &
		CoreAgentLoopCompactSessionLike,
	TChatMessage,
	THistoryMessage extends CorePromptRequestMessage,
	TPromptMessage extends CorePromptRequestMessage,
	TSkill extends CoreAgentLoopSkillLike,
	TTool extends AgentSourceToolDefinition,
	TContentParts,
	TCompactResult extends CoreAgentLoopCompactResultLike,
	TToolResult extends CoreAgentLoopDirectToolResultLike,
	TPartialToolResult,
> {
	getSession(sessionId: string): TSession | null | undefined;
	getSkillsForSession(workingDirectory?: string, agentId?: string): TSkill[];
	initializeTools?(skills: TSkill[]): Promise<void> | void;
	isProviderSupported?(providerId: string): boolean;
	createProvider?(
		providerId: string,
		config: AgentProviderRuntimeConfig,
		hostContext: CoreAgentLoopProviderHostContext,
	): AgentProvider | undefined;
	resolveModelContextLength?(
		model: string,
		providerId: string,
	): number | undefined | Promise<number | undefined>;
	resolveModelMaxOutputTokens?(
		model: string,
		providerId: string,
	): number | undefined | Promise<number | undefined>;
	getMCPRouterToolDefinition?(): TTool | null;
	/** 决策点 #1 hybrid: mode-resolved MCP tool defs (flat array or router). */
	getMCPToolDefinitionsForModel?(): TTool[];
	/**
	 * Per-agent tool allowlist (tool ids). Return null/undefined for no
	 * restriction. Hosts without agent-scoped tools can omit this. The session
	 * is passed so hosts can narrow further by session kind (e.g. collab room
	 * turns, docs/design/multi-agent-collab.md D5); return [] to disable tools.
	 */
	getAgentToolAllowlist?(
		agentId: string | undefined,
		session?: unknown,
	): Promise<string[] | null | undefined> | string[] | null | undefined;
	/**
	 * `sessionId` 是**空间归属的唯一入口**(批 B4):项目名册 per-space,宿主要靠
	 * 它把会话解析成 space。宿主可以忽略它(单空间宿主行为不变)。
	 */
	buildProjectPromptVars(
		workingDirectory?: string,
		options?: { sessionId?: string },
	): OnethingAgentLoopProjectPromptVars;
	buildPrompt(
		options: CoreBuildPromptOptions,
	): Promise<OnethingAgentLoopPromptResult<TPromptMessage>>;
	buildHistoryMessages(
		messages: TChatMessage[],
		session: TSession,
	): THistoryMessage[];
	/**
	 * 这条会话当前的消息。产品层不许自己从 session 上取 `.messages`
	 * (docs/design/session-commands-p0-2026-08.md §3),所以回合中重建历史时
	 * 由宿主从读门面现取一份交过来 —— 宿主侧接的是 `sessionReads.listMessages`。
	 */
	listSessionMessages(sessionId: string): TChatMessage[];
	resolvePromptReferences(
		content: string,
		input: {
			session: TSession | null | undefined;
			settings: TSettings;
		},
	): {
		modelContent: string;
		contentParts?: TContentParts;
	};
	persistInjectedChatMessage(
		sessionId: string,
		message: CorePendingAgentLoopChatMessage<TContentParts>,
	): Promise<void> | void;
	emitInjectedUserMessage?(
		sessionId: string,
		message: CorePendingAgentLoopChatMessage<TContentParts>,
	): Promise<void> | void;
	executeToolDirectly(
		toolName: string,
		args: JsonObject,
		context: {
			sessionId: string;
			messageId: string;
			toolCallId: string;
			workingDirectory?: string;
			workingDirectoryRoots?: string[];
			abortSignal?: AbortSignal;
			onMetadata?: (update: CoreAgentLoopDirectToolMetadataUpdate) => void;
			onPartialResult?: (update: TPartialToolResult) => void;
		},
	): Promise<TToolResult>;
	compactSessionContext(input: {
		sessionId: string;
		providerId: string;
		configWithApiKey: TProviderConfig & { apiKey: string };
		settings: TSettings;
		keepRecentTurns: number;
		onMessageCreated: (message: unknown) => Promise<void>;
		onMessageUpdated: (messageId: string, updates: unknown) => Promise<void>;
	}): Promise<TCompactResult>;
	emitEvent(sessionId: string, event: unknown): Promise<void>;
	shouldSkipProviderUsageMismatch?(input: {
		providerId: string;
		session: TSession;
		modelContextLength: number;
	}): boolean;
	goal?: OnethingAgentLoopGoalHooks;
	scratchpad?: OnethingAgentLoopScratchpadHooks;
	logger?: OnethingAgentLoopLogger;
	createId?(): string;
}

export interface OnethingAgentLoopRuntimeHostAdapters<
	TSettings extends OnethingAgentLoopRuntimeSettings<TToolSettings>,
	TProviderConfig extends CoreAgentLoopProviderRuntimeConfigLike,
	TToolSettings extends CoreAgentLoopRuntimeToolSettingsLike | undefined,
	TSession extends CoreAgentLoopRuntimeSessionLike &
		CoreAgentLoopCompactSessionLike,
	TChatMessage,
	THistoryMessage extends CorePromptRequestMessage,
	TPromptMessage extends CorePromptRequestMessage,
	TSkill extends CoreAgentLoopSkillLike,
	TTool extends AgentSourceToolDefinition,
	TContentParts,
	TCompactResult extends CoreAgentLoopCompactResultLike,
	TToolResult extends CoreAgentLoopDirectToolResultLike,
	TPartialToolResult,
> {
	getSession(sessionId: string): TSession | null | undefined;
	getSkillsForSession(workingDirectory?: string, agentId?: string): TSkill[];
	initializeTools?(
		skills: CoreAgentLoopInitSkillSnapshot[],
	): Promise<void> | void;
	isProviderSupported?(providerId: string): boolean;
	createProvider?(
		providerId: string,
		config: AgentProviderRuntimeConfig,
		hostContext: CoreAgentLoopProviderHostContext,
	): AgentProvider | undefined;
	resolveModelContextLength?(
		model: string,
		providerId: string,
	): number | undefined | Promise<number | undefined>;
	resolveModelMaxOutputTokens?(
		model: string,
		providerId: string,
	): number | undefined | Promise<number | undefined>;
	getMCPRouterToolDefinition?(): TTool | null;
	/** 决策点 #1 hybrid: mode-resolved MCP tool defs (flat array or router). */
	getMCPToolDefinitionsForModel?(): TTool[];
	/**
	 * Per-agent tool allowlist (tool ids). Return null/undefined for no
	 * restriction. Hosts without agent-scoped tools can omit this. The session
	 * is passed so hosts can narrow further by session kind (e.g. collab room
	 * turns, docs/design/multi-agent-collab.md D5); return [] to disable tools.
	 */
	getAgentToolAllowlist?(
		agentId: string | undefined,
		session?: unknown,
	): Promise<string[] | null | undefined> | string[] | null | undefined;
	/**
	 * `sessionId` 是**空间归属的唯一入口**(批 B4):项目名册 per-space,宿主要靠
	 * 它把会话解析成 space。宿主可以忽略它(单空间宿主行为不变)。
	 */
	buildProjectPromptVars(
		workingDirectory?: string,
		options?: { sessionId?: string },
	): OnethingAgentLoopProjectPromptVars;
	buildPrompt(
		options: CoreBuildPromptOptions,
	): Promise<OnethingAgentLoopPromptResult<TPromptMessage>>;
	buildHistoryMessages(
		messages: TChatMessage[],
		session: TSession,
	): THistoryMessage[];
	/**
	 * 这条会话当前的消息。产品层不许自己从 session 上取 `.messages`
	 * (docs/design/session-commands-p0-2026-08.md §3),所以回合中重建历史时
	 * 由宿主从读门面现取一份交过来 —— 宿主侧接的是 `sessionReads.listMessages`。
	 */
	listSessionMessages(sessionId: string): TChatMessage[];
	resolvePromptReferences(
		content: string,
		input: {
			session: TSession | null | undefined;
			settings: TSettings;
			skills: TSkill[];
		},
	): {
		modelContent: string;
		contentParts?: TContentParts;
	};
	persistInjectedChatMessage(
		sessionId: string,
		message: CorePendingAgentLoopChatMessage<TContentParts>,
	): Promise<void> | void;
	executeToolDirectly(
		toolName: string,
		args: JsonObject,
		context: {
			sessionId: string;
			messageId: string;
			toolCallId: string;
			workingDirectory?: string;
			workingDirectoryRoots?: string[];
			abortSignal?: AbortSignal;
			onMetadata?: (update: CoreAgentLoopDirectToolMetadataUpdate) => void;
			onPartialResult?: (update: TPartialToolResult) => void;
		},
	): Promise<TToolResult>;
	compactSessionContext(input: {
		sessionId: string;
		providerId: string;
		configWithApiKey: TProviderConfig & { apiKey: string };
		settings: TSettings;
		keepRecentTurns: number;
		onMessageCreated: (message: unknown) => Promise<void>;
		onMessageUpdated: (messageId: string, updates: unknown) => Promise<void>;
	}): Promise<TCompactResult>;
	emitEvent(sessionId: string, event: unknown): Promise<void>;
	shouldSkipProviderUsageMismatch?(input: {
		providerId: string;
		session: TSession;
		modelContextLength: number;
	}): boolean;
	goal?: OnethingAgentLoopGoalHooks;
	scratchpad?: OnethingAgentLoopScratchpadHooks;
	logger?: OnethingAgentLoopLogger;
	createId?(): string;
}

export function createOnethingAgentLoopRuntimeAdapters<
	TSettings extends OnethingAgentLoopRuntimeSettings<TToolSettings>,
	TProviderConfig extends CoreAgentLoopProviderRuntimeConfigLike,
	TToolSettings extends CoreAgentLoopRuntimeToolSettingsLike | undefined,
	TSession extends CoreAgentLoopRuntimeSessionLike &
		CoreAgentLoopCompactSessionLike,
	TChatMessage,
	THistoryMessage extends CorePromptRequestMessage,
	TPromptMessage extends CorePromptRequestMessage,
	TSkill extends CoreAgentLoopSkillLike,
	TTool extends AgentSourceToolDefinition,
	TContentParts,
	TCompactResult extends CoreAgentLoopCompactResultLike,
	TToolResult extends CoreAgentLoopDirectToolResultLike,
	TPartialToolResult = unknown,
>(
	host: OnethingAgentLoopRuntimeHostAdapters<
		TSettings,
		TProviderConfig,
		TToolSettings,
		TSession,
		TChatMessage,
		THistoryMessage,
		TPromptMessage,
		TSkill,
		TTool,
		TContentParts,
		TCompactResult,
		TToolResult,
		TPartialToolResult
	>,
): OnethingAgentLoopRuntimeAdapters<
	TSettings,
	TProviderConfig,
	TToolSettings,
	TSession,
	TChatMessage,
	THistoryMessage,
	TPromptMessage,
	TSkill,
	TTool,
	TContentParts,
	TCompactResult,
	TToolResult,
	TPartialToolResult
> {
	return {
		getSession: host.getSession,
		getSkillsForSession: host.getSkillsForSession,
		initializeTools: host.initializeTools
			? (skills) => host.initializeTools?.(agentLoopInitSkills(skills))
			: undefined,
		isProviderSupported: host.isProviderSupported,
		createProvider: host.createProvider,
		resolveModelContextLength: host.resolveModelContextLength,
		resolveModelMaxOutputTokens: host.resolveModelMaxOutputTokens,
		getMCPRouterToolDefinition: host.getMCPRouterToolDefinition,
		getMCPToolDefinitionsForModel: host.getMCPToolDefinitionsForModel,
		getAgentToolAllowlist: host.getAgentToolAllowlist,
		buildProjectPromptVars: host.buildProjectPromptVars,
		buildPrompt: host.buildPrompt,
		buildHistoryMessages: host.buildHistoryMessages,
		listSessionMessages: host.listSessionMessages,
		resolvePromptReferences(content, input) {
			const settingsWithSkills = input.settings as {
				skills?: { enableSkills?: boolean };
			};
			const skillsEnabled = settingsWithSkills.skills?.enableSkills !== false;
			const skills = skillsEnabled
				? host.getSkillsForSession(
					input.session?.workingDirectory,
					input.session?.agentId,
				)
				: [];
			return host.resolvePromptReferences(content, {
				session: input.session,
				settings: input.settings,
				skills,
			});
		},
		persistInjectedChatMessage: host.persistInjectedChatMessage,
		async emitInjectedUserMessage(sessionId, message) {
			try {
				await host.emitEvent(sessionId, {
					type: SESSION_EVENT_TYPES.MESSAGE_USER_CREATED,
					message,
				});
			} catch (error) {
				host.logger?.error?.(
					"[AgentLoopRuntime] injected message:user-created emit error:",
					error,
				);
			}
		},
		executeToolDirectly: host.executeToolDirectly,
		compactSessionContext: host.compactSessionContext,
		emitEvent: host.emitEvent,
		shouldSkipProviderUsageMismatch: host.shouldSkipProviderUsageMismatch,
		goal: host.goal,
		logger: host.logger,
		createId: host.createId,
	};
}

export type BuildOnethingAgentLoopStreamRuntimeResult<
	TSkill extends CoreAgentLoopSkillLike = CoreAgentLoopSkillLike,
> =
	| {
			supported: false;
			reason: string;
	  }
	| {
			supported: true;
			runtime: AgentLoopOptions;
			/**
			 * 用另一份凭证重建同一个 provider(批 D)。装配层拿它去实现
			 * `AgentLoopOptions.rotateCredential` —— provider 怎么造只有这里知道,
			 * 所以只开一个「改凭证」的窄口子而不是把造法导出去。
			 */
			reprovision?: (override: {
				apiKey?: string;
				baseUrl?: string;
				/** OAuth 型凭证的换手(批 B6):换的是 token,不是 key。 */
				oauthToken?: AgentProviderRuntimeConfig["oauthToken"];
				/** 换过之后的归属标记 —— 后续的中途刷新要写回新的那条 entry。 */
				spaceCredential?: AgentProviderRuntimeConfig["spaceCredential"];
			}) => AgentProvider | undefined;
			systemPrompt: string;
			/** Named prompt sections built for this turn (for hash-based versioning and snapshots). */
			sections: PromptSection[];
			enabledSkills: TSkill[];
			toolNames: string[];
			mcpToolNames: string[];
			hasTools: boolean;
			supportsTools: boolean;
			modelContextLength: number;
			reservedOutputTokens: number;
	  };

export async function maybeCompactOnethingAgentLoopContext<
	TSettings,
	TProviderConfig extends object,
	TSession extends CoreAgentLoopCompactSessionLike,
	TMessage extends AgentMessage,
	TCompactResult extends
		CoreAgentLoopCompactResultLike = CoreAgentLoopCompactResultLike,
>(options: {
	ctx: {
		sessionId: string;
		providerId: string;
		providerConfig: TProviderConfig;
		settings: TSettings;
	};
	turn: number;
	messages: TMessage[];
	budget: CoreAgentLoopContextBudget;
	compactEnabled: boolean;
	keepRecentTurns: number;
	rebuildMessages: () => Promise<TMessage[]>;
	adapters: {
		getSession(sessionId: string): TSession | null | undefined;
		compactSessionContext(input: {
			sessionId: string;
			providerId: string;
			configWithApiKey: TProviderConfig & { apiKey: string };
			settings: TSettings;
			keepRecentTurns: number;
			onMessageCreated: (message: unknown) => Promise<void>;
			onMessageUpdated: (messageId: string, updates: unknown) => Promise<void>;
		}): Promise<TCompactResult>;
		emitEvent(sessionId: string, event: unknown): Promise<void>;
		shouldSkipProviderUsageMismatch?: (input: {
			providerId: string;
			session: TSession;
			modelContextLength: number;
			inputTokens?: number;
		}) => boolean;
		logger?: OnethingAgentLoopLogger;
	};
}): Promise<TMessage[] | undefined> {
	return maybeCompactAgentLoopContextWithAdapters({
		ctx: options.ctx,
		turn: options.turn,
		messages: options.messages,
		budget: options.budget,
		compactEnabled: options.compactEnabled,
		keepRecentTurns: options.keepRecentTurns,
		adapters: {
			getSession: options.adapters.getSession,
			compactSessionContext: options.adapters.compactSessionContext,
			emitEvent: (sessionId, event) =>
				options.adapters.emitEvent(sessionId, event),
			shouldSkipProviderUsageMismatch:
				options.adapters.shouldSkipProviderUsageMismatch,
			logger: options.adapters.logger,
			rebuildMessages: options.rebuildMessages,
		},
	});
}

export async function buildOnethingAgentLoopStreamRuntime<
	TSettings extends OnethingAgentLoopRuntimeSettings<TToolSettings>,
	TProviderConfig extends CoreAgentLoopProviderRuntimeConfigLike,
	TToolSettings extends CoreAgentLoopRuntimeToolSettingsLike | undefined,
	TSession extends CoreAgentLoopRuntimeSessionLike &
		CoreAgentLoopCompactSessionLike & { messages: TChatMessage[] },
	TChatMessage,
	THistoryMessage extends CorePromptRequestMessage,
	TPromptMessage extends CorePromptRequestMessage,
	TSkill extends CoreAgentLoopSkillLike,
	TTool extends AgentSourceToolDefinition,
	TContentParts,
	TCompactResult extends CoreAgentLoopCompactResultLike,
	TToolResult extends CoreAgentLoopDirectToolResultLike,
	TPartialToolResult = unknown,
>(
	ctx: OnethingAgentLoopRuntimeContext<
		TSettings,
		TProviderConfig,
		TToolSettings
	>,
	historyMessages: THistoryMessage[],
	adapters: OnethingAgentLoopRuntimeAdapters<
		TSettings,
		TProviderConfig,
		TToolSettings,
		TSession,
		TChatMessage,
		THistoryMessage,
		TPromptMessage,
		TSkill,
		TTool,
		TContentParts,
		TCompactResult,
		TToolResult,
		TPartialToolResult
	>,
): Promise<BuildOnethingAgentLoopStreamRuntimeResult<TSkill>> {
	const isSupported =
		adapters.isProviderSupported ?? isAgentProviderRuntimeSupported;
	if (!isSupported(ctx.providerId)) {
		return {
			supported: false,
			reason: `Provider ${ctx.providerId} does not expose an AgentProvider runtime yet`,
		};
	}

	const session = adapters.getSession(ctx.sessionId);
	const preparation = planAgentLoopRuntimePreparation({
		ctx,
		session,
	});
	const sessionWorkingDir = preparation.sessionWorkingDir;
	const sessionWorkingDirRoots = preparation.sessionWorkingDirRoots;
	const enabledSkills = preparation.skillsEnabled
		? adapters.getSkillsForSession(sessionWorkingDir, preparation.agentId)
		: [];
	const effectiveToolSettings = preparation.effectiveToolSettings;

	if (preparation.toolCallsEnabled) {
		await adapters.initializeTools?.(enabledSkills);
	}

	const createProvider =
		adapters.createProvider ??
		((providerId, config, hostContext) =>
			createAgentProviderFromRuntime(
				providerId,
				config,
				hostContext as CreateAgentProviderFromRuntimeOptions,
			));
	const provider = createProvider(
		ctx.providerId,
		preparation.providerRuntimeConfig as AgentProviderRuntimeConfig,
		preparation.providerHostContext,
	);

	/**
	 * 用另一份凭证重建同一个 provider(批 D 的凭证轮换)。
	 *
	 * 为什么这个函数必须住在这里:`createProvider` 的另外两个参数
	 * (`providerRuntimeConfig` / `providerHostContext`)只在这一段作用域里存在,
	 * 把它们导出去让调用方自己拼,等于把"provider 怎么造"复制成第二份。
	 * 这里只开一个**改凭证**的窄口子,其余一律沿用首次解析的那份。
	 */
	const reprovision = (
		override: {
			apiKey?: string;
			baseUrl?: string;
			oauthToken?: AgentProviderRuntimeConfig["oauthToken"];
			spaceCredential?: AgentProviderRuntimeConfig["spaceCredential"];
		},
	): AgentProvider | undefined =>
		createProvider(
			ctx.providerId,
			{
				...(preparation.providerRuntimeConfig as AgentProviderRuntimeConfig),
				...(override.apiKey ? { apiKey: override.apiKey } : {}),
				...(override.baseUrl ? { baseUrl: override.baseUrl } : {}),
				// OAuth 换手要把 authContext 一并顶掉:它是首次解析烤进去的那一个,
				// 留着会让 provider 继续拿旧账号的 token 拼请求头。
				...(override.oauthToken
					? {
							oauthToken: override.oauthToken,
							authContext: { kind: "oauth", token: override.oauthToken },
						}
					: {}),
				...(override.spaceCredential
					? { spaceCredential: override.spaceCredential }
					: {}),
			} as AgentProviderRuntimeConfig,
			preparation.providerHostContext,
		);

	if (!provider) {
		return {
			supported: false,
			reason: `Provider ${ctx.providerId} did not create an AgentProvider runtime`,
		};
	}
	if (!agentProviderCanRunTurn(provider)) {
		return {
			supported: false,
			reason: `Provider ${ctx.providerId} AgentProvider runtime does not implement streamTurn or runTurn`,
		};
	}

	const providerCapabilities = await resolveAgentModelCapabilities(
		provider,
		ctx.providerConfig.model,
	);
	const supportsTools = agentSupportsTools(providerCapabilities);
	const toolLoadingEnabled = Boolean(
		preparation.toolCallsEnabled && supportsTools,
	);
	const mcpToolDefinitions = toolLoadingEnabled
		? (adapters.getMCPToolDefinitionsForModel?.()
			?? (adapters.getMCPRouterToolDefinition?.() ? [adapters.getMCPRouterToolDefinition()!] : []))
		: [];
	// The profile snapshot is authoritative when the host resolved one: it was
	// computed from the same agent the prompt was built from, so a mid-turn
	// agent edit cannot hand this run a new prompt with an old allowlist.
	const agentToolAllowlist = !toolLoadingEnabled
		? null
		: ctx.agentProfile
			? ctx.agentProfile.tools
			: await adapters.getAgentToolAllowlist?.(preparation.agentId, session);
	/**
	 * 缝 1 —— 工具面(docs/design/tool-system-oop-2026-08.md §12.5)。
	 *
	 * 「这一回合模型看得见哪些内置工具」由 `Surface.resolve` 一次算出(目录 ×
	 * 场景 × agent 白名单 × 设置)。R4b 之前这里还并排跑着旧的三处口径拼装
	 * (`resolveSceneHiddenToolIds` 的集中式减法表、`getEnabledTools` 的 enabled
	 * 过滤、`planAgentLoopTools` 的 allowlist),现在**只剩这一处** —— 场景判定的
	 * 唯一事实是 `resolveScene` + 每只工具自己的 `visibleIn`。空白名单的两种读法在
	 * `normalizeLegacyAllowlist` 那道归一门里对齐(R2a 决定⑤)。
	 *
	 * **MCP 与 provider 原生名不走这条**:它们仍旧按老路递给
	 * `planAgentLoopTools`(flat/router 的互斥、enabled 过滤都在那里),只作为
	 * `extraNames` 进 `Surface.names()` —— 那一格答的是"这个名字这一回合合法吗",
	 * 不是"谁来跑它"。
	 *
	 * 目录没配上(宿主没走 backend、装配还没到)时 `toolkitSourceTools` 为空 ——
	 * 这一回合就没有内置工具,而不是悄悄换一条链。
	 */
	const toolkitSurface = toolLoadingEnabled
		? resolveToolkitSurface({
			session: session as ToolkitSceneSessionLike | null | undefined,
			enabledSkillNames: enabledSkills.map(skill => skill.name),
			allowlist: agentToolAllowlist,
			toolSettings: effectiveToolSettings?.tools as
				Readonly<Record<string, { enabled?: boolean; autoExecute?: boolean }>> | undefined,
			extraNames: mcpToolDefinitions.map(tool => tool.id),
		})
		: undefined;
	const toolkitSourceTools = toolkitSurface
		? toolkitAgentSourceTools(toolkitSurface)
		: null;
	const toolPlan = planAgentLoopTools({
		toolLoadingEnabled,
		allEnabledTools: (toolkitSourceTools ?? []) as TTool[],
		mcpTools: mcpToolDefinitions,
		toolSettings: effectiveToolSettings,
		allowedToolIds: agentToolAllowlist,
	});
	const projectVars = adapters.buildProjectPromptVars(sessionWorkingDir, {
		sessionId: ctx.sessionId,
	});
	const budget = await resolveOnethingAgentLoopContextBudget(
		ctx,
		providerCapabilities,
		adapters,
	);
	const buildPromptForHistory = async (
		nextHistoryMessages: THistoryMessage[],
	) =>
		adapters.buildPrompt(
			planAgentLoopPromptBuildOptions({
				ctx: {
					sessionId: ctx.sessionId,
					providerId: ctx.providerId,
					providerConfig:
						ctx.providerConfig as unknown as CoreBuildPromptOptions["providerConfig"],
					settings: ctx.settings,
					voiceConversation: ctx.voiceConversation,
					speakMode: ctx.speakMode,
				},
				agentId: preparation.agentId,
				hasTools: toolPlan.hasTools,
				skills: enabledSkills,
				workingDirectory: sessionWorkingDir,
				workingDirectoryRoots: sessionWorkingDirRoots,
				activeProject: projectVars.active,
				knownProjects: projectVars.known,
				toolNames: toolPlan.toolNames,
				mcpToolNames: toolPlan.mcpToolNames,
				historyMessages: nextHistoryMessages,
			}),
		);
	const requestMessages = await buildPromptForHistory(historyMessages);

	const rebuildAgentMessagesFromSession = async (
		messages: AgentMessage[],
	): Promise<AgentMessage[]> => {
		const latestSession = adapters.getSession(ctx.sessionId);
		if (!latestSession) return messages;

		const rebuiltHistory = adapters.buildHistoryMessages(
			adapters.listSessionMessages(ctx.sessionId),
			latestSession,
		);
		const rebuiltPrompt = await buildPromptForHistory(rebuiltHistory);
		return [
			...agentMessagesFromHistory(
				rebuiltPrompt.messages as AgentHistoryMessage[],
				providerCapabilities,
			),
			...getAgentLoopTransientTail(messages),
		];
	};

	const pendingMessageAdapters = createPendingAgentLoopMessageAdapters(
		ctx,
		adapters,
	);
	const turnQueueAdapters = {
		drainSteeringMessages: (): CorePendingAgentLoopInputMessage[] => {
			const drained = ctx.steeringQueue?.drain() ?? [];
			// Consumed messages are no longer retractable — tell the UI so it
			// drops the withdraw affordance on those persisted user messages.
			const messageIds = drained
				.map((message) => message.id)
				.filter((id): id is string => Boolean(id));
			if (messageIds.length > 0) {
				void adapters.emitEvent(ctx.sessionId, {
					type: SESSION_EVENT_TYPES.STEERING_CONSUMED,
					messageIds,
				});
			}
			return drained;
		},
		drainFollowUpMessages: (): CorePendingAgentLoopInputMessage[] =>
			ctx.followUpQueue?.drain() ?? [],
	};
	// 草稿纸的瞬态尾块。宿主没接 scratchpad hook = `buildEphemeralTail` 缺席 =
	// core 里那一段整个跳过,行为逐字不变。
	const scratchpadHooks = adapters.scratchpad;
	const ephemeralTailAdapters = {
		...(scratchpadHooks
			? {
					buildEphemeralTail: (turn: number) =>
						scratchpadHooks.buildTail(ctx.sessionId, turn),
				}
			: {}),
		onEphemeralTailInjected: ({
			turn,
			version,
		}: {
			turn: number;
			version: number;
		}) => {
			// 已读水位靠这条事件回推 —— 界面画的是"引擎真的读到了哪",不是猜的。
			void adapters.emitEvent(ctx.sessionId, {
				type: SESSION_EVENT_TYPES.SCRATCHPAD_CONSUMED,
				version,
				turn,
			});
		},
	};
	const turnCompactionAdapters = {
		getSession: adapters.getSession,
		compactSessionContext: adapters.compactSessionContext,
		emitEvent: (sessionId: string, event: unknown) =>
			adapters.emitEvent(sessionId, event),
		shouldSkipProviderUsageMismatch: adapters.shouldSkipProviderUsageMismatch,
		logger: adapters.logger,
	};

	const thinkingOptions = getOnethingAgentLoopThinkingOptions(ctx);
	const executeToolDirectlyWithFreshSession = (
		toolName: string,
		args: JsonObject,
		toolContext: {
			sessionId: string;
			messageId: string;
			toolCallId: string;
			workingDirectory?: string;
			workingDirectoryRoots?: string[];
			abortSignal?: AbortSignal;
			onMetadata?: (update: CoreAgentLoopDirectToolMetadataUpdate) => void;
			onPartialResult?: (update: TPartialToolResult) => void;
		},
	) => {
		const latestSession = adapters.getSession(ctx.sessionId);
		return adapters.executeToolDirectly(toolName, args, {
			...toolContext,
			workingDirectory:
				latestSession?.workingDirectory ?? toolContext.workingDirectory,
			workingDirectoryRoots:
				latestSession?.workingDirectoryRoots ??
				toolContext.workingDirectoryRoots,
		});
	};

	const turnTraceRecorder = createTurnTraceRecorder({
		sessionId: ctx.sessionId,
		turnId: ctx.assistantMessageId,
	});

	const runtime = await buildAgentLoopRuntime({
		provider,
		model: ctx.providerConfig.model,
		messages: agentMessagesFromHistory(
			requestMessages.messages as AgentHistoryMessage[],
			providerCapabilities,
		),
		requestedOutputModalities: ctx.requestedOutputModalities,
		sessionId: ctx.sessionId,
		messageId: ctx.assistantMessageId,
		workingDirectory: sessionWorkingDir,
		abortSignal: ctx.abortSignal,
		maxTurns:
			ctx.agentProfile?.maxTurns ??
			ctx.settings.chat?.maxTurns ??
			DEFAULT_CHAT_MAX_TURNS,
		maxTokens: budget.reservedOutputTokens,
		thinking: thinkingOptions.thinking,
		reasoningEffort: thinkingOptions.reasoningEffort,
		// 服务端 prompt 缓存的路由键(OpenAI/xAI/Kimi/OpenRouter 的
		// `prompt_cache_key`)。会话 id 是**不透明标识符**,不含任何会话内容,
		// 但它确实会离开本机 —— 所以这一句写在宿主的调用点上,而不是让 core
		// 从 `sessionId` 里自己推出来。哪家真的发,由各家配方的 `extraBody`
		// 决定;没有这个旋钮的家收到了也当没看见。
		cacheKey: ctx.sessionId,
		// 请求级 providerOptions 袋(P3-3)。设置里存的是**构造级 + 请求级**两半
		// 一只袋(`providerOptions`),这里只取 `request` 那一半 —— 构造级的旋钮
		// (kimi 的 apiMode / region 之类)早在工厂里就用掉了,不该再随每个回合
		// 出门。按 providerId 命名空间装,provider 只读自己那一格并按白名单透传;
		// 认不出的键被丢弃并留一条 `setting-dropped`,不静默。
		//
		// 故意没有设置 UI:这一格装的是实验性 / 家专属的请求参数
		// (OpenAI 的 `verbosity`、`image_url.detail`),用户手改 settings.json
		// 就能开,形状见 `providers/provider-options.ts`。
		providerOptions: {
			[ctx.providerId]: readOnethingRequestProviderOptions(
				ctx.providerConfig.providerOptions as
					| Record<string, unknown>
					| undefined,
			),
		},
		// First model call only — see AgentLoopOptions.initialToolChoice. A
		// standing 'required' would make every round owe another tool call and
		// the run could never end on its own.
		initialToolChoice: ctx.initialToolChoice,
		tools: {
			tools: buildAgentLoopDirectToolsWithAdapters({
				definitions: toolPlan.modelToolDefinitions,
				context: {
					sessionId: ctx.sessionId,
					messageId: ctx.assistantMessageId,
					workingDirectory: sessionWorkingDir,
					workingDirectoryRoots: sessionWorkingDirRoots,
					abortSignal: ctx.abortSignal,
					principal: ctx.principal,
					// F4:身份透传。取的是回合入口解析好的那一个 —— 与喂给
					// buildPrompt 的 `agentId: preparation.agentId` 是同一个值,
					// 所以提示词、插件 promptContext、插件工具 ctx 三处恒同解。
					agentId: preparation.agentId,
				},
				executeToolDirectly: executeToolDirectlyWithFreshSession,
			}),
			policy: { enabled: toolPlan.hasTools },
		},
		skills: agentLoopSkillContexts(enabledSkills) as AgentSkillContext[],
		prompt: {
			injectSkills: false,
		},
		beforeTurn: async ({ turn, messages }) => {
			const replacement = await runAgentLoopBeforeTurnWithAdapters({
				ctx: compactContext(ctx),
				turn,
				messages,
				budget,
				compactEnabled: ctx.settings.chat?.contextCompactEnabled !== false,
				keepRecentTurns: ctx.settings.chat?.contextCompactKeepRecentTurns ?? 6,
				rebuildMessages: (nextMessages) =>
					rebuildAgentMessagesFromSession(nextMessages as AgentMessage[]),
				adapters: {
					...pendingMessageAdapters,
					...turnQueueAdapters,
					...ephemeralTailAdapters,
					...turnCompactionAdapters,
				},
			});
			if (!replacement) return undefined;
			return {
				messages: replacement.messages as AgentMessage[],
				startNewResponse: replacement.startNewResponse,
			};
		},
		afterTurn: async ({ messages }) => {
			const replacementMessages = await runAgentLoopAfterTurnWithAdapters({
				messages,
				adapters: {
					...pendingMessageAdapters,
					...turnQueueAdapters,
				},
			});
			if (replacementMessages) {
				return replacementMessages as AgentMessage[] | undefined;
			}
			// Goal continuation: only when nothing else (steering / queued user
			// messages) wants the turn — user input always wins over the goal.
			const continuationPrompt = adapters.goal?.beginContinuation(
				ctx.sessionId,
			);
			if (!continuationPrompt) return undefined;
			const withContinuation = await injectPendingAgentLoopMessagesWithAdapters({
				messages,
				pendingMessages: [
					{
						content: continuationPrompt,
						source: "goal",
						timestamp: Date.now(),
						origin: goalInjectionOrigin(),
					},
				],
				adapters: pendingMessageAdapters,
			});
			return withContinuation as AgentMessage[] | undefined;
		},
		// L1 tracing: record every round's exact (request, response) pair —
		// ground truth for "why did the model do this". Serialization is
		// synchronous (the live array mutates right after), writes are queued
		// off the request path.
		onTurnTrace: (event) => {
			turnTraceRecorder.record({
				turn: event.turn,
				request: event.request,
				response: {
					message: event.response.message,
					finishReason: event.response.finishReason,
					usage: event.response.usage,
				},
				toolResultMessages: event.toolResultMessages,
			});
			// Goal accounting rides the same per-round observation point. When
			// the budget flips, the wrap-up notice goes through the steering
			// queue so the next round sees it (injected exactly once).
			const budgetLimitPrompt = adapters.goal?.recordUsage(ctx.sessionId, {
				totalTokens: event.response.usage?.totalTokens,
			});
			if (budgetLimitPrompt) {
				ctx.steeringQueue?.enqueue?.({
					content: budgetLimitPrompt,
					source: "goal",
					timestamp: Date.now(),
					origin: goalInjectionOrigin(),
				});
			}
		},
	});

	return {
		supported: true,
		runtime,
		reprovision,
		systemPrompt: requestMessages.systemPrompt,
		sections: requestMessages.sections ?? [],
		enabledSkills,
		toolNames: toolPlan.toolNames,
		mcpToolNames: toolPlan.mcpToolNames,
		hasTools: toolPlan.hasTools,
		supportsTools,
		modelContextLength: budget.modelContextLength,
		reservedOutputTokens: budget.reservedOutputTokens,
	};
}

export async function* streamOnethingAgentLoopChunks<
	TSettings extends OnethingAgentLoopRuntimeSettings<TToolSettings>,
	TProviderConfig extends CoreAgentLoopProviderRuntimeConfigLike,
	TToolSettings extends CoreAgentLoopRuntimeToolSettingsLike | undefined,
	TSession extends CoreAgentLoopRuntimeSessionLike &
		CoreAgentLoopCompactSessionLike & { messages: TChatMessage[] },
	TChatMessage,
	THistoryMessage extends CorePromptRequestMessage,
	TPromptMessage extends CorePromptRequestMessage,
	TSkill extends CoreAgentLoopSkillLike,
	TTool extends AgentSourceToolDefinition,
	TContentParts,
	TCompactResult extends CoreAgentLoopCompactResultLike,
	TToolResult extends CoreAgentLoopDirectToolResultLike,
	TPartialToolResult = unknown,
>(
	ctx: OnethingAgentLoopRuntimeContext<
		TSettings,
		TProviderConfig,
		TToolSettings
	>,
	historyMessages: THistoryMessage[],
	adapters: OnethingAgentLoopRuntimeAdapters<
		TSettings,
		TProviderConfig,
		TToolSettings,
		TSession,
		TChatMessage,
		THistoryMessage,
		TPromptMessage,
		TSkill,
		TTool,
		TContentParts,
		TCompactResult,
		TToolResult,
		TPartialToolResult
	>,
): AsyncGenerator<AgentProviderStreamChunk, AgentLoopResult, void> {
	const prepared = await buildOnethingAgentLoopStreamRuntime(
		ctx,
		historyMessages,
		adapters,
	);
	if (!prepared.supported) {
		throw new Error(prepared.reason);
	}

	return yield* streamAgentLoopProviderChunks(prepared.runtime);
}

async function resolveOnethingAgentLoopContextBudget<
	TSettings extends OnethingAgentLoopRuntimeSettings<TToolSettings>,
	TProviderConfig extends CoreAgentLoopProviderRuntimeConfigLike,
	TToolSettings extends CoreAgentLoopRuntimeToolSettingsLike | undefined,
	TSession extends CoreAgentLoopRuntimeSessionLike &
		CoreAgentLoopCompactSessionLike,
	TChatMessage,
	THistoryMessage extends CorePromptRequestMessage,
	TPromptMessage extends CorePromptRequestMessage,
	TSkill extends CoreAgentLoopSkillLike,
	TTool extends AgentSourceToolDefinition,
	TContentParts,
	TCompactResult extends CoreAgentLoopCompactResultLike,
	TToolResult extends CoreAgentLoopDirectToolResultLike,
	TPartialToolResult,
>(
	ctx: OnethingAgentLoopRuntimeContext<
		TSettings,
		TProviderConfig,
		TToolSettings
	>,
	capabilities: AgentModelCapabilities | undefined,
	adapters: OnethingAgentLoopRuntimeAdapters<
		TSettings,
		TProviderConfig,
		TToolSettings,
		TSession,
		TChatMessage,
		THistoryMessage,
		TPromptMessage,
		TSkill,
		TTool,
		TContentParts,
		TCompactResult,
		TToolResult,
		TPartialToolResult
	>,
): Promise<CoreAgentLoopContextBudget> {
	const result = await resolveAgentLoopContextBudgetWithRegistry({
		capabilities,
		providerId: ctx.providerId,
		providerConfig: ctx.providerConfig,
		chatMaxTokens: ctx.settings.chat?.maxTokens,
		contextCompactThreshold: ctx.settings.chat?.contextCompactThreshold,
		resolveModelContextLength: adapters.resolveModelContextLength,
		resolveModelMaxOutputTokens: adapters.resolveModelMaxOutputTokens,
	});

	if (result.error) {
		adapters.logger?.warn?.(
			"[AgentLoopRuntime] Failed to resolve model context budget:",
			result.error,
		);
	}
	return result.budget;
}

/**
 * Origin stamped on goal-injected messages. They persist as regular user
 * messages (history rebuilds must replay them byte-identically), and the
 * renderer folds them into a compact "goal continuation" line by matching
 * origin.source === 'goal'.
 */
function goalInjectionOrigin(): {
	transport: "api";
	source: "goal";
	receivedAt: number;
} {
	return { transport: "api", source: "goal", receivedAt: Date.now() };
}

function createPendingAgentLoopMessageAdapters<
	TSettings extends OnethingAgentLoopRuntimeSettings<TToolSettings>,
	TProviderConfig extends CoreAgentLoopProviderRuntimeConfigLike,
	TToolSettings extends CoreAgentLoopRuntimeToolSettingsLike | undefined,
	TSession extends CoreAgentLoopRuntimeSessionLike &
		CoreAgentLoopCompactSessionLike,
	TChatMessage,
	THistoryMessage extends CorePromptRequestMessage,
	TPromptMessage extends CorePromptRequestMessage,
	TSkill extends CoreAgentLoopSkillLike,
	TTool extends AgentSourceToolDefinition,
	TContentParts,
	TCompactResult extends CoreAgentLoopCompactResultLike,
	TToolResult extends CoreAgentLoopDirectToolResultLike,
	TPartialToolResult,
>(
	ctx: OnethingAgentLoopRuntimeContext<
		TSettings,
		TProviderConfig,
		TToolSettings
	>,
	adapters: OnethingAgentLoopRuntimeAdapters<
		TSettings,
		TProviderConfig,
		TToolSettings,
		TSession,
		TChatMessage,
		THistoryMessage,
		TPromptMessage,
		TSkill,
		TTool,
		TContentParts,
		TCompactResult,
		TToolResult,
		TPartialToolResult
	>,
): CoreAgentLoopPendingMessageAdapters<TContentParts> {
	return {
		createPendingMessageId: adapters.createId ?? createCoreId,
		resolvePromptReferences: (content) => {
			const session = adapters.getSession(ctx.sessionId);
			return adapters.resolvePromptReferences(content, {
				session,
				settings: ctx.settings,
			});
		},
		persistInjectedChatMessage: async (injectedMessage) => {
			await adapters.persistInjectedChatMessage(ctx.sessionId, injectedMessage);
			await adapters.emitInjectedUserMessage?.(ctx.sessionId, injectedMessage);
		},
	};
}

function compactContext<
	TSettings extends OnethingAgentLoopRuntimeSettings<TToolSettings>,
	TProviderConfig extends CoreAgentLoopProviderRuntimeConfigLike,
	TToolSettings extends CoreAgentLoopRuntimeToolSettingsLike | undefined,
>(
	ctx: OnethingAgentLoopRuntimeContext<
		TSettings,
		TProviderConfig,
		TToolSettings
	>,
) {
	return {
		sessionId: ctx.sessionId,
		providerId: ctx.providerId,
		providerConfig: ctx.providerConfig,
		settings: ctx.settings,
	};
}

export { agentLoopInitSkills };
export type { CoreAgentLoopContextBudget as OnethingAgentLoopContextBudget };
