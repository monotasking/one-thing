// agent 运行期适配器长什么样、怎么造(从 `engine-agent-loop-stream-runtime.ts` 拆出,拆分批 1,D226):
// `OnethingAgentLoopRuntimeAdapters`(运行期向外要的那一组端口)、`OnethingAgentLoopRuntimeHostAdapters`(宿主递进来的那一组)
// 与把后者装成前者的 `createOnethingAgentLoopRuntimeAdapters`。十二槽按什么顺序装,仍在 `engine-agent-loop-stream-runtime.ts`
// 的 `buildOnethingAgentLoopStreamRuntime` 里 —— 那是顺序即规格的装配函数,不拆(D220)。
import type { AgentProvider, AgentSourceToolDefinition } from '@onething/backend/agent-loop'
import { agentLoopInitSkills, type CoreAgentLoopCompactResultLike, type CoreAgentLoopCompactSessionLike, type CoreAgentLoopDirectToolMetadataUpdate, type CoreAgentLoopDirectToolResultLike, type CoreAgentLoopInitSkillSnapshot, type CoreAgentLoopProviderHostContext, type CoreAgentLoopProviderRuntimeConfigLike, type CoreAgentLoopRuntimeSessionLike, type CoreAgentLoopRuntimeSettingsLike, type CoreAgentLoopRuntimeToolSettingsLike, type CoreAgentLoopSkillLike, type CoreBuildPromptOptions, type CoreBuildPromptResult, type CorePendingAgentLoopChatMessage, type CorePromptRequestMessage } from '@onething/backend/agent-loop'
import type { JsonObject } from "@shared/json";
import type { AgentProviderRuntimeConfig } from '../provider/provider.js'
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

export interface OnethingAgentLoopRuntimeSettings<
	TToolSettings extends CoreAgentLoopRuntimeToolSettingsLike | undefined =
		| CoreAgentLoopRuntimeToolSettingsLike
		| undefined,
> extends CoreAgentLoopRuntimeSettingsLike<TToolSettings> {
	chat?: OnethingAgentLoopChatSettings;
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
	/**
	 * 压缩重建**读 store 之前**要跑的那一步(顺序约束,不是数据口)。
	 *
	 * 宿主的换锚点分成同步的"定身份"与异步的"收尾"两半,而 afterTurn 发的
	 * response-boundary 之后,下一轮的 `beforeTurn`(压缩重建就在这里)排在收尾
	 * 那一半**之前**:上一条 assistant 还挂着 `isStreaming`,`buildHistoryMessages`
	 * 见了整条跳过,重建出来的历史真的少一整轮。宿主在这个口里把收尾补上。
	 * 不接 = 直接读,行为与从前逐字相同。
	 */
	beforeRebuildMessages?(): Promise<void> | void;
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
			executionContext?: unknown;
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
		providerConfig?: unknown;
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
	/** 见 `OnethingAgentLoopRuntimeAdapters.beforeRebuildMessages`(§15.15)。 */
	beforeRebuildMessages?(): Promise<void> | void;
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
			executionContext?: unknown;
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
		providerConfig?: unknown;
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
		beforeRebuildMessages: host.beforeRebuildMessages,
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
