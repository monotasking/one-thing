import type {
	AppSettings,
	ChatMessage,
	ChatSession,
	ProviderConfig,
} from "@shared/ipc.js";
import type { ProviderAuthContext } from "@onething/runtime/auth/types.wiring";
import {
	createOnethingProductStreamRuntimeFromHostAdapters,
	type OnethingProductStreamRuntime,
} from "@onething/runtime/product-stream-runtime";
import { Permission } from "../permission/index.js";
import { Interaction } from '@onething/core/interaction';
import * as store from "../../store.js";
import { sessionReads } from "../../session/reads.js";
import { getSkillsForSession } from "../skills/session-skills.js";
import { mediaLibraryService } from "@onething/runtime/media/library-service-bound";
import {
	generateChatTitle,
	isProviderSupported,
	requiresOAuth,
} from "../providers/index.js";
import { resolveProviderApiKey } from "@onething/runtime/providers/env.wiring";
import {
	applySessionSpaceCredentials,
	resolveSessionSpaceOAuthAuth,
} from "../providers/space-credentials.js";
import { resolveSessionSpaceDefaultSelection } from "../providers/space-defaults.js";
import { getSessionSettings } from "../providers/space-ai-settings.js";
import * as modelRegistry from "../providers/model-registry.js";
import { resolvePromptReferences } from "@onething/runtime/prompts/resolver.wiring";
import { buildHistoryMessages } from "./stream/message-helpers.js";
import { buildResumeHistoryAfterToolConfirmation } from "./stream/resume-history.js";
import { executeMessageStream } from "./stream/stream-executor.js";
import { executeAgentLoopStreamGeneration } from "./stream/agent-loop-executor.js";
import { billTitleUsage } from "../usage/bill-side-line.js";
import {
	compactSessionContext,
	getContextCompactReason,
	shouldSkipAutoCompactForProviderUsageMismatch,
} from "./context-compact.js";
import type { OnethingStreamProviderAdapterOptions } from '@onething/runtime/providers/stream-provider-adapter'
import type { StreamEngineStoreAdapter, StreamEngineModelRegistryAdapter } from '@onething/core/engine'

export type MainStreamEngineRuntime = OnethingProductStreamRuntime<
	AppSettings,
	ChatMessage,
	ChatSession,
	ProviderConfig,
	ProviderAuthContext,
	ReturnType<typeof getSkillsForSession>[number],
	NonNullable<ChatMessage["contentParts"]>[number],
	NonNullable<ChatMessage["attachments"]>[number],
	ReturnType<typeof buildHistoryMessages>[number],
	Awaited<ReturnType<typeof executeAgentLoopStreamGeneration>>,
	Awaited<ReturnType<typeof compactSessionContext>>
>;

export function createMainStreamEngineRuntime(): MainStreamEngineRuntime {
	const storePort: StreamEngineStoreAdapter<AppSettings, ChatSession, ChatMessage> = {
		getSettings: () => store.getSettings(),
		// 换源(C2):provider 设置整套 per-space 之后,不经过 getEffectiveConfig
		// 的解析点(标题模型)也必须看这条会话所在空间的那一份。
		getSettingsForSession: (sessionId: string) => getSessionSettings(sessionId),
		getSession: (sessionId) => store.getSession(sessionId),
		// C1(P0.2 area ①):core 引擎的会话消息读全部走读门面
		// (docs/design/session-commands-p0-2026-08.md §3)。
		listMessages: (sessionId) => sessionReads.listMessages(sessionId).messages,
		getMessage: (sessionId, messageId) =>
			sessionReads.getMessage(sessionId, messageId) as ChatMessage | undefined,
		addMessage: (sessionId, message) => store.addMessage(sessionId, message),
		renameSession: (sessionId, name) => store.renameSession(sessionId, name),
		updateMessageAndTruncate: (sessionId, messageId, newContent, options) =>
			store.updateMessageAndTruncate(
				sessionId,
				messageId,
				newContent,
				options as Parameters<typeof store.updateMessageAndTruncate>[3],
			),
		deleteMessageAndTruncate: (sessionId, messageId) =>
			store.deleteMessageAndTruncate(sessionId, messageId),
		deleteMessage: (sessionId, messageId) =>
			store.deleteMessage(sessionId, messageId),
	};
	const providerPort: OnethingStreamProviderAdapterOptions<ProviderConfig, AppSettings, ProviderAuthContext, ChatSession> = {
		getSession: (sessionId) => store.getSession(sessionId),
		// per-space 凭证(批 B3):非 default 空间用它自己的凭证池,没配就是
		// 「未配置」——起流前置拦截,绝不悄悄用默认空间的 key。
		applySpaceCredentials: applySessionSpaceCredentials,
		// per-space 默认 provider/model(批 B9)。与上一行同源:两条解析链各自
		// 构造一次适配器,少挂的那一条就是会话悄悄用回全局默认的那一条。
		resolveSpaceDefaultSelection: resolveSessionSpaceDefaultSelection,
		isProviderSupported,
		isOAuthProvider: requiresOAuth,
		resolveApiKey: (providerId, providerConfig) =>
			resolveProviderApiKey(providerId, providerConfig),
		// per-space OAuth(批 B6):token 去 `spaceCredential` 指的那条 entry 取,
		// 缺席才回 settings。刷新被拒会顺手给那条 entry 写 auth-invalid 冷却。
		resolveOAuthAuth: (providerId, apiKey, credential) =>
			resolveSessionSpaceOAuthAuth(providerId, apiKey, credential),
		createApiKeyAuth: (apiKey) => ({ kind: "api-key", apiKey }),
		generateTitle: (providerId, providerConfig, content, options) => {
			const titleOptions = options as Parameters<typeof generateChatTitle>[3];
			return generateChatTitle(
				providerId,
				providerConfig as unknown as Parameters<typeof generateChatTitle>[1],
				content,
				{
					...titleOptions,
					// debugSessionId carries the session here (see
					// core-stream-engine's generateSessionTitle), which is the
					// only handle this adapter has on which session to bill.
					onUsage: billTitleUsage(
						providerId,
						String(providerConfig?.model || ""),
						titleOptions?.debugSessionId,
					),
				},
			);
		},
	};
	const modelsPort: StreamEngineModelRegistryAdapter = {
		getModelContextLength: (model, providerId) =>
			modelRegistry.getModelContextLength(model, providerId),
		getModelMaxOutputTokens: (model, providerId) =>
			modelRegistry.getModelMaxOutputTokens(model, providerId),
	};
	return createOnethingProductStreamRuntimeFromHostAdapters<
		AppSettings,
		ChatMessage,
		ChatSession,
		ProviderConfig,
		ProviderAuthContext,
		ReturnType<typeof getSkillsForSession>[number],
		NonNullable<ChatMessage["contentParts"]>[number],
		NonNullable<ChatMessage["attachments"]>[number],
		ReturnType<typeof buildHistoryMessages>[number],
		Awaited<ReturnType<typeof executeAgentLoopStreamGeneration>>,
		Awaited<ReturnType<typeof compactSessionContext>>
	>({
		store: storePort,
		clearPermissionSession: (sessionId) => {
			Permission.clearSession(sessionId);
			// 提问链与审批链在会话清理上必须同进同退:少结算一条 pending interaction,
			// 等它的那个回合就永远醒不过来,而且它的 deadline 表还挂着
			// (claude-code-integration-v2 §4)。
			Interaction.clearSession(sessionId);
		},
		getSkillsForSession,
		resolvePromptReferences,
		ingestMessageAttachments: (sessionId, messageId, role, attachments) =>
			mediaLibraryService.ingestMessageAttachments(
				sessionId,
				messageId,
				role as ChatMessage["role"],
				attachments,
			),
		provider: providerPort,
		models: modelsPort,
		buildHistoryMessages,
		buildResumeHistoryAfterToolConfirmation,
		executeMessageStream:
			executeMessageStream as unknown as MainStreamEngineRuntime["streams"]["executeMessageStream"],
		executeAgentLoopStreamGeneration,
		compactSessionContext: (options) =>
			compactSessionContext(
				options as Parameters<typeof compactSessionContext>[0],
			),
		getContextCompactReason: (options) =>
			getContextCompactReason(
				options as Parameters<typeof getContextCompactReason>[0],
			),
		shouldSkipAutoCompactForProviderUsageMismatch: (options) =>
			shouldSkipAutoCompactForProviderUsageMismatch(
				options as Parameters<
					typeof shouldSkipAutoCompactForProviderUsageMismatch
				>[0],
			),
	}) as unknown as MainStreamEngineRuntime;
}
