import type {
	AppSettings,
	ChatMessage,
	ChatSession,
	ProviderConfig,
} from "@shared/ipc.js";
import type { ProviderAuthContext } from "../auth/types.js";
import {
	createOnethingProductStreamRuntimeFromHostAdapters,
	type OnethingProductStreamRuntime,
} from "@onething/runtime/product-stream-runtime";
import { authService } from "../auth/auth-service.js";
import { Permission } from "../permission/index.js";
import { Interaction } from "../interaction/index.js";
import * as store from "../store.js";
import { getSkillsForSession } from "../skills/session-skills.js";
import { mediaLibraryService } from "../media/media-library-service.js";
import {
	generateChatTitle,
	isProviderSupported,
	requiresOAuth,
} from "../providers/index.js";
import { resolveProviderApiKey } from "../providers/env.js";
import { applySessionSpaceCredentials } from "../providers/space-credentials.js";
import * as modelRegistry from "../providers/model-registry.js";
import { resolvePromptReferences } from "../prompts/resolver.js";
import { buildStateVariablesPromptText } from "../variables/index.js";
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
		store: {
			getSettings: () => store.getSettings(),
			getSession: (sessionId) => store.getSession(sessionId),
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
		},
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
		provider: {
			getSession: (sessionId) => store.getSession(sessionId),
			// per-space 凭证(批 B3):非 default 空间用它自己的凭证池,没配就是
			// 「未配置」——起流前置拦截,绝不悄悄用默认空间的 key。
			applySpaceCredentials: applySessionSpaceCredentials,
			isProviderSupported,
			isOAuthProvider: requiresOAuth,
			resolveApiKey: (providerId, providerConfig) =>
				resolveProviderApiKey(providerId, providerConfig),
			resolveOAuthAuth: (providerId, apiKey) =>
				authService.resolveProviderAuth(providerId, apiKey),
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
		},
		models: {
			getModelContextLength: (model, providerId) =>
				modelRegistry.getModelContextLength(model, providerId),
			getModelMaxOutputTokens: (model, providerId) =>
				modelRegistry.getModelMaxOutputTokens(model, providerId),
		},
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
		buildTurnContextText: (sessionId) => buildStateVariablesPromptText(sessionId),
	}) as unknown as MainStreamEngineRuntime;
}
