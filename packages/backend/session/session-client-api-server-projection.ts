/**
 * HTTP 服务器那一侧的会话投影与会话级规则(会话第二入口的一个方面,决策 D26)。
 *
 * 四类纯函数,全部只作用在 `ServerChatSession` / 索引元数据上:
 *
 *  1. **回声后端的事件投影**(`applySessionEvent` 一族):真引擎自己写库,这条路只在
 *     `persistsMessages === false` 时跑。
 *  2. **会话级派生与补丁**:`refreshSessionMeta`(预览 / 计数 / 自动标题)、
 *     `sessionMetaFieldsOf`(进账本的三格)、`applySessionPatch`(`sessions.update` 的白名单)。
 *  3. **出门的投影**:`toSessionMeta` / `toChatSession` / `toSessionDetails` / `stripSessionOwnerFields`
 *     摘掉服务端内部的归属格,`getMessagePage` 按游标切页。
 *  4. **归属与沙箱路径**:`ownsSession` / `ownsSessionMeta`(与受众对象同一个谓词)、
 *     `workspaceSandboxRootForSession` / `resolveWorkspacePath`。
 *
 * 2026-10-04 从 `http-server/http-server-runtime.ts` 原样搬来(决策 D219),代码一行没改。
 */
import { isAbsolute, join, relative, resolve } from "node:path";
import { sessionPreviewText } from "./session-reads.js";
import { deriveSessionLastMessagePreview, findLastPreviewableMessage } from "./session-meta.js";
import type { AgentEngineSessionEvent } from "@onething/backend/agent";
import type { ContextVariable } from "@onething/backend/variable";
import { ownsSessionRecord, sessionOwnerOf as sessionOwner } from "@onething/backend/http-server/http-server-audience.js";
import { tenantDirectory, defaultRequestContext } from "@onething/backend/http-server/http-server-tenant-paths.js";
import type {
	ChatMessage,
	ChatSession,
	GetSessionMessagesPageRequest,
	GetSessionMessagesPageResponse,
	SessionDetails,
	SessionMeta,
} from "@shared/ipc/chat.js";
import { SESSION_EVENT_TYPES } from "@shared/events/index.js";
import type { ServerChatSession, ServerSessionIndexMeta, ServerSessionStore } from './session-client-api-server-store.js'

/**
 * echo/test 后端的事件投影(真引擎自己写库,这条路只在 `persistsMessages === false`
 * 时跑)。P0.3:消息写全部走命令面 —— 但走的是**这只 store 自己的**命令面
 * (`store.messages`),不是 app store 那个单例:两只仓库是真的两只。
 */
export function applySessionEvent(
	store: ServerSessionStore,
	session: ServerChatSession,
	event: AgentEngineSessionEvent,
): void {
	const settle = () =>
		refreshSessionMeta(session, store.getMessages(session.id));
	const variablesEvent = readSessionVariablesUpdatedEvent(event);
	if (variablesEvent) {
		if (variablesEvent.workingDirectory)
			session.workingDirectory = variablesEvent.workingDirectory;
		if (variablesEvent.workingDirectoryRoots)
			session.workingDirectoryRoots = variablesEvent.workingDirectoryRoots;
		session.variables = variablesEvent.variables;
		settle();
		return;
	}

	if ((event as { type?: string }).type === SESSION_EVENT_TYPES.MESSAGES_REPLACED) {
		const replaced = event as unknown as { messages: ChatMessage[] };
		// `reason:'replaced'` 是同步的(只有 'clear' 会 await 刷盘/留档),
		// 所以这里 void 掉 promise 不改变执行顺序。
		void store.messages.replaceAll(session.id, {
			messages: replaced.messages.map((message) => ({ ...message })),
			reason: "replaced",
		});
		settle();
		return;
	}

	switch (event.type) {
		case SESSION_EVENT_TYPES.MESSAGE_USER_CREATED:
		case SESSION_EVENT_TYPES.MESSAGE_ASSISTANT_CREATED:
			upsertServerMessage(store, session.id, toChatMessage(session.id, event.message));
			break;
		case SESSION_EVENT_TYPES.MESSAGE_UPDATED:
			updateServerMessage(
				store,
				session.id,
				event.messageId,
				event.updates as Partial<ChatMessage>,
			);
			break;
		case SESSION_EVENT_TYPES.STREAM_START:
			updateServerMessage(
				store,
				session.id,
				event.messageId || event.assistantMessageId,
				{
					isStreaming: true,
					model: event.model,
					provider: "local",
				},
			);
			break;
		case SESSION_EVENT_TYPES.STREAM_COMPLETE:
			markStreamingComplete(store, session.id);
			applyServerSessionUsage(session, event.data.usage);
			break;
		case SESSION_EVENT_TYPES.STREAM_ERROR:
			markStreamingComplete(store, session.id);
			store.messages.appendMessage(session.id, {
				message: {
					id: `error-${Date.now()}`,
					role: "error",
					content: event.data.error,
					errorDetails: event.data.errorDetails,
					timestamp: Date.now(),
				} as ChatMessage,
			});
			break;
	}
	settle();
}


function applyServerSessionUsage(
	session: ServerChatSession,
	usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number },
): void {
	if (!usage) return;
	const inputTokens = finiteTokenCount(usage.inputTokens);
	const outputTokens = finiteTokenCount(usage.outputTokens);
	const totalTokens =
		finiteTokenCount(usage.totalTokens) || inputTokens + outputTokens;

	session.totalInputTokens = (session.totalInputTokens ?? 0) + inputTokens;
	session.totalOutputTokens = (session.totalOutputTokens ?? 0) + outputTokens;
	session.totalTokens = (session.totalTokens ?? 0) + totalTokens;
	session.lastInputTokens = inputTokens;
	session.contextSize = inputTokens;
}

function finiteTokenCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: 0;
}

function toChatMessage(
	sessionId: string,
	message: { id: string; role: string; content: string },
): ChatMessage {
	return {
		id: message.id,
		sessionId,
		role: message.role === "assistant" ? "assistant" : "user",
		content: message.content,
		timestamp: Date.now(),
		// §17.7.1 批 3:这只**假引擎**不写 `run/start`,所以流中占位在账本上没有
		// 任何一格(命令面对 `isStreaming` 的 assistant 一条事件都不写,§9.3)。
		// 真引擎那条路由 `openAssistantRun` 补产地;假引擎没有那一步,于是它的
		// 助手消息一律以**落定**形态入账(`system/message`),正文随后由 upsert 的
		// `fullBody` 档补上。`isStreaming` 本来就不是存储字段 —— 投影按 run 开合现算。
		contentParts: message.content
			? [{ type: "text", content: message.content }]
			: [],
	};
}

/**
 * SV7:命令面的 `upsertMessage` 是**整条替换**,而 server 这条投影一直是**合并**
 * (事件只带 id/role/content,合并才不会把 isStreaming/model 抹掉)。合并在这里
 * 做完再交给命令,行为一字不改。
 */
function upsertServerMessage(
	store: ServerSessionStore,
	sessionId: string,
	message: ChatMessage,
): void {
	const existing = store
		.getMessages(sessionId)
		.find((item) => item.id === message.id);
	store.messages.upsertMessage(sessionId, {
		message: existing ? { ...existing, ...message } : message,
	});
}

/**
 * SV8:`Object.assign(message, updates)` + content→contentParts 的派生规则。
 * 派生保留 —— 只是从"改完再补一刀"变成把它算进同一份 patch 里。
 */
function updateServerMessage(
	store: ServerSessionStore,
	sessionId: string,
	messageId: string,
	updates: Partial<ChatMessage>,
): void {
	const patch: Partial<ChatMessage> =
		typeof updates.content === "string"
			? {
					...updates,
					contentParts: [{ type: "text", content: updates.content }],
				}
			: updates;
	// §17.7.1 批 3:走 **upsert(整条替换)** 而不是 `patchMessage`。
	//
	// 这只 echo/test 后端是**假引擎**:它不像真引擎那样写 `run/start` + 
	// `assistant/chunks`,助手消息的正文只从这一口进来。而 `message/patched` 的
	// 正文三件套永远被丢弃(`BODY_KEYS`:正文只有 chunks 一个来源)—— 从前它靠
	// 老 reducer 把补丁写进内存数组才看得见,reducer 一删就整条不见了。
	// upsert 的 `fullBody` 档正是为"这条消息现在整条长这样"准备的,假引擎要的
	// 就是它;真引擎那条路一格未动。
	const existing = store.getMessages(sessionId).find((item) => item.id === messageId);
	if (!existing) return;
	store.messages.upsertMessage(sessionId, {
		message: { ...existing, ...patch, isStreaming: false } as ChatMessage,
	});
}

/**
 * SV9:`stream:complete` / `stream:error` 事件**不带 messageId**
 * (`StreamCompleteEvent` / `StreamErrorEvent` 只有 `data`),所以"最后一条
 * assistant"的定位保留,只是取数改走 store 的读口。
 */
function markStreamingComplete(
	store: ServerSessionStore,
	sessionId: string,
): void {
	const messages = store.getMessages(sessionId);
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].role !== "assistant") continue;
		store.messages.patchMessage(sessionId, {
			messageId: messages[index].id,
			patch: { isStreaming: false },
		});
		return;
	}
}

/**
 * 会话级派生字段(updatedAt / messageCount / previewText / 自动标题)。
 *
 * P0.3:消息不再从 `session.messages` 取,由调用方从读门面递进来
 * (`sessionStore.getMessages`)—— 命令面之外没有人持有那份数组。
 * P0.4(用户 2026-08-19 拍板):预览文本从 server 自己的 `slice(0,160)` 换成读门面
 * 的唯一口径 `sessionPreviewText`(trim / 120 字 / 补 `…` / 空串给 undefined)。
 * 这是会话列表上肉眼可见的行为变化,已获批准。
 */
export function refreshSessionMeta(
	session: ServerChatSession,
	messages: readonly ChatMessage[],
	options: { preserveUpdatedAt?: boolean } = {},
): void {
	if (!options.preserveUpdatedAt) session.updatedAt = Date.now();
	session.messageCount = messages.length;
	session.previewText = sessionPreviewText(messages);
	// E 批:与 `previewText`(第一句)并列的"最近说到哪儿",同一刻算,同一个纯函数。
	session.lastMessagePreview = deriveSessionLastMessagePreview(
		findLastPreviewableMessage(messages),
	);
	if (session.name === "New Chat" && session.previewText) {
		session.name = session.previewText.slice(0, 40);
	}
}

/**
 * §13.10 M7:进事件账本的那三格会话级字段(agent / model+provider / workdir)。
 *
 * 它们就是翻译器 `patchSession` 认识的那一张表 —— 其余会话级字段是 UI 偏好,
 * 留在 `meta.json`(§2)。取快照与取新值用**同一个函数**,前后两份因此永远同形。
 */
export function sessionMetaFieldsOf(session: ServerChatSession): {
	agentId?: string;
	lastModel?: string;
	lastProvider?: string;
	workingDirectory?: string;
} {
	return {
		...(session.agentId !== undefined ? { agentId: session.agentId } : {}),
		...(session.lastModel !== undefined ? { lastModel: session.lastModel } : {}),
		...(session.lastProvider !== undefined
			? { lastProvider: session.lastProvider }
			: {}),
		...(session.workingDirectory !== undefined
			? { workingDirectory: session.workingDirectory }
			: {}),
	};
}

export function applySessionPatch(
	session: ServerChatSession,
	patch: Record<string, unknown>,
	workspaceRoot: string,
): { success: boolean; error?: string } {
	if (typeof patch.isArchived === "boolean") {
		session.isArchived = patch.isArchived;
		if (patch.isArchived && typeof patch.archivedAt === "number") {
			session.archivedAt = patch.archivedAt;
		} else if (!patch.isArchived || patch.archivedAt === null) {
			delete session.archivedAt;
		}
	}

	if ("workingDirectory" in patch) {
		if (
			typeof patch.workingDirectory === "string" &&
			patch.workingDirectory.length > 0
		) {
			const nextWorkingDirectory = resolveWorkspacePath(
				workspaceRoot,
				session,
				patch.workingDirectory,
			);
			if (!nextWorkingDirectory) {
				return {
					success: false,
					error:
						"Working directory must stay inside the workspace sandbox root.",
				};
			}
			session.workingDirectory = nextWorkingDirectory;
			session.workingDirectoryRoots = [
				workspaceSandboxRootForSession(workspaceRoot, session),
			];
		} else {
			const root = workspaceSandboxRootForSession(workspaceRoot, session);
			session.workingDirectory = root;
			session.workingDirectoryRoots = [root];
		}
	}

	if (typeof patch.agentId === "string" && patch.agentId.length > 0) {
		session.agentId = patch.agentId;
	}

	if ("permissionMode" in patch) {
		if (
			typeof patch.permissionMode === "string" &&
			patch.permissionMode.length > 0
		) {
			session.permissionMode =
				patch.permissionMode as ServerChatSession["permissionMode"];
		} else {
			delete session.permissionMode;
		}
	}

	if (typeof patch.lastProvider === "string" && patch.lastProvider.length > 0) {
		session.lastProvider = patch.lastProvider;
	}

	if (typeof patch.lastModel === "string" && patch.lastModel.length > 0) {
		session.lastModel = patch.lastModel;
	}

	// The pin says "a human chose this pair", which is what stops an agent's
	// model binding from outranking it. It is set by the model-picker route,
	// never by the per-turn provider/model stamp.
	if ("modelPinned" in patch) {
		if (patch.modelPinned === true) session.modelPinned = true;
		else delete session.modelPinned;
	}

	if ("maxTokens" in patch) {
		if (
			typeof patch.maxTokens !== "number" ||
			!Number.isFinite(patch.maxTokens) ||
			patch.maxTokens <= 0
		) {
			return {
				success: false,
				error: "Max tokens must be a positive number.",
			};
		}
		session.maxTokens = Math.trunc(patch.maxTokens);
	}

	session.updatedAt = Date.now();
	return { success: true };
}

export function toSessionMeta(session: ServerChatSession): SessionMeta {
	const {
		messages: _messages,
		userId: _userId,
		ownerUserId: _ownerUserId,
		ownerWorkspaceId: _ownerWorkspaceId,
		workspaceId: _workspaceId,
		// 摘出来单独条件展开 —— 留在 `...meta` 里的话,「键在、值是 undefined」
		// 那一档照样会被铺进投影,条件展开就白写了。
		previewText: _previewText,
		...meta
	} = session;
	return {
		...meta,
		// P0.3:messageCount 由 normalize* / refreshSessionMeta 盖在会话上,
		// 这里不再自己数一遍 `session.messages`(两只仓库各有各的取数口)。
		messageCount: session.messageCount ?? 0,
		// 条件展开而不是直给:这份投影被 `Object.assign(meta, ...)` 灌进索引元数据,
		// 直给 undefined 会把命令面刚维护好的那一格洗掉。
		//
		// 批 A 起 `previewText` 也走这一条(从前它是直给):`normalizeAppSession`
		// 不再兜底重算之后,一条「索引里有 previewText、meta.json 里没有」的存量
		// 会话再存一次就会被洗成 undefined。真机上这类条目 6/460 —— 数目小,但
		// 洗掉是**可感知**的(会话卡上的预览那一行会空掉),所以按同款写法防住。
		...(session.previewText !== undefined
			? { previewText: session.previewText }
			: {}),
		...(session.lastMessagePreview !== undefined
			? { lastMessagePreview: session.lastMessagePreview }
			: {}),
	};
}

export function toChatSession(session: ServerChatSession): ChatSession {
	const {
		userId: _userId,
		ownerUserId: _ownerUserId,
		ownerWorkspaceId: _ownerWorkspaceId,
		workspaceId: _workspaceId,
		...chatSession
	} = session;
	return chatSession;
}

export function toSessionDetails(session: ServerChatSession): SessionDetails {
	return {
		...toSessionMeta(session),
		workingDirectoryRoots: session.workingDirectoryRoots ?? [],
		variables: session.variables ?? [],
	};
}

export function getMessagePage(
	messages: readonly ChatMessage[],
	request: GetSessionMessagesPageRequest,
): GetSessionMessagesPageResponse {
	const totalCount = messages.length;
	if (totalCount === 0) {
		return {
			success: true,
			messages: [],
			nextCursor: null,
			backwardsCursor: null,
			hasMoreBefore: false,
			hasMoreAfter: false,
			totalCount,
		};
	}

	const limit = Math.max(1, request.limit ?? 16);
	let end = totalCount;
	const anchor = request.anchor;
	if (request.cursor && request.direction === "older") {
		end = Math.max(0, Number.parseInt(request.cursor, 10) - 1);
	} else if (anchor && anchor !== "tail" && anchor.messageId) {
		const anchorIndex = messages.findIndex(
			(message) => message.id === anchor.messageId,
		);
		end =
			anchorIndex >= 0
				? Math.min(totalCount, anchorIndex + 1 + (anchor.after ?? limit))
				: totalCount;
	}
	const start = Math.max(0, end - limit);
	const page = messages.slice(start, end).map((message, index) => ({
		...message,
		seq: start + index + 1,
	}));

	return {
		success: true,
		messages: page,
		nextCursor: start > 0 ? String(start + 1) : null,
		backwardsCursor: end < totalCount ? String(end) : null,
		hasMoreBefore: start > 0,
		hasMoreAfter: end < totalCount,
		totalCount,
	};
}

export function ownsSession(
	session: ServerChatSession,
	context = defaultRequestContext(),
): boolean {
	return ownsSessionRecord(session, context);
}

/** 会话工作区推导所需的最小字段集,ServerChatSession 与 index 元数据均满足。 */
interface SessionWorkspaceRef {
	id: string;
	userId?: string;
	ownerUserId?: string;
	ownerWorkspaceId?: string;
	workspaceId?: string;
	workingDirectory?: string;
}

export function ownsSessionMeta(
	meta: ServerSessionIndexMeta,
	context = defaultRequestContext(),
): boolean {
	return ownsSessionRecord(meta, context);
}

/**
 * 交给客户端之前摘掉**服务端内部**的归属格。
 *
 * `workspaceId`(产品空间)照旧一并摘 —— 它今天就没出过这道门,现在把它留下等于
 * 让 web 端的左栏突然开始按空间过滤会话(可感知的行为变化)。**本批只修 bug、不改
 * 这件事**;要不要把空间交给 web,单独拍(留账见 §17.5)。
 */
export function stripSessionOwnerFields(meta: ServerSessionIndexMeta): SessionMeta {
	const {
		userId: _userId,
		ownerUserId: _ownerUserId,
		ownerWorkspaceId: _ownerWorkspaceId,
		workspaceId: _workspaceId,
		ownerVersion: _ownerVersion,
		...rest
	} = meta;
	return rest;
}


function readSessionVariablesUpdatedEvent(event: unknown): {
	workingDirectory?: string;
	workingDirectoryRoots?: string[];
	variables: ContextVariable[];
} | null {
	if (!event || typeof event !== "object") return null;
	const candidate = event as Record<string, unknown>;
	if (candidate.type !== SESSION_EVENT_TYPES.SESSION_VARIABLES_UPDATED) return null;
	return {
		...(typeof candidate.workingDirectory === "string"
			? { workingDirectory: candidate.workingDirectory }
			: {}),
		...(Array.isArray(candidate.workingDirectoryRoots)
			? {
					workingDirectoryRoots: candidate.workingDirectoryRoots.filter(
						(root): root is string => typeof root === "string",
					),
				}
			: {}),
		variables: Array.isArray(candidate.variables)
			? candidate.variables.filter(isContextVariable)
			: [],
	};
}

function isContextVariable(value: unknown): value is ContextVariable {
	if (!value || typeof value !== "object") return false;
	const variable = value as Partial<ContextVariable>;
	return (
		typeof variable.name === "string" && typeof variable.value === "string"
	);
}

/**
 * 会话文件落在哪 —— **本批一个字节都不许挪**。
 *
 * 这条路径历来由 `(userId, workspaceId)` 推出来,而第二格上盘的其实是**产品空间**:
 * 在非 default 空间里建的会话,它的文件今天就住在 `owners/<uid>/<space>/` 下面。
 * 拆字段之后如果改读租户格,那些文件会当场"消失"(路径变了)。所以这里按
 * **租户优先、回落到盘上原值**的顺序取,存量与新建两种情况都与今天逐字相同。
 *
 * 「空间到底该不该决定沙箱路径」是另一个问题(workspace-spaces 的 per-space 目录
 * 方案里它是有意的),**留给单独一次拍板**,见 §17.5 留账。
 */
export function workspaceSandboxRootForSession(
	workspaceRoot: string,
	session: SessionWorkspaceRef,
): string {
	const owner = sessionOwner(session);
	return tenantDirectory(
		workspaceRoot,
		owner.userId ?? defaultRequestContext().userId,
		owner.workspaceId ?? defaultRequestContext().workspaceId,
	);
}

function resolveWorkspacePath(
	workspaceRoot: string,
	session: ServerChatSession,
	requestedPath: string,
): string | null {
	const sandboxRoot = workspaceSandboxRootForSession(workspaceRoot, session);
	const candidate = resolve(
		isAbsolute(requestedPath)
			? requestedPath
			: join(sandboxRoot, requestedPath),
	);
	return isPathInside(candidate, sandboxRoot) ? candidate : null;
}

function isPathInside(candidate: string, root: string): boolean {
	const pathFromRoot = relative(root, candidate);
	return (
		pathFromRoot === "" ||
		(!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
	);
}
