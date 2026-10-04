/**
 * HTTP 服务器那一侧的会话工作集与会话门面(会话第二入口的一个方面,决策 D26)。
 *
 * server runtime 里「这条会话归谁、现在长什么样」都在这里答:
 *
 *  - **工作集**:回声后端的会话按需驻留(`sessions`),真引擎的会话一律从 app 仓库现取;
 *    活跃流账本(`activeStreamSessions`)、按 owner 记的当前会话;
 *  - **按请求上下文取会话**:`getSessionForContext` / `listSessionsForContext` / `ensureSession`,
 *    归属判定与受众对象读同一个谓词;
 *  - **受众工厂**:缺省按会话归属判(`createTenantAudienceFactory`),宿主可以换;
 *  - **`ServerRuntimeStore` 那条总线订阅**:活跃流账本 → 调用方递进来的旁听(今天是待答权限账)
 *    → 回声后端的事件投影,一条订阅、这个顺序;
 *  - **门面的两格**:`sessions`(list / create / update)与 `messages`(page)。
 *
 * 2026-10-04 从 `http-server/http-server-runtime.ts` 的装配闭包原样搬来(决策 D219):闭包里的
 * 局部变量变成这只工厂的局部变量,名字与代码一行没改;订阅里原来写在中间的待答权限那一段,
 * 改成调用方递进来的旁听函数,位置不变。
 */
import { mkdirSync } from "node:fs";
import {
	updateSessionWorkingDirectory as updateAppSessionWorkingDirectory,
	updateSessionWorkingDirectoryRoots as updateAppSessionWorkingDirectoryRoots,
} from "./session-store.js";
import { sessionCommandEvents } from "./session-command-events.js";
import { onSessionIndexChanged } from "./session-store.js";
import type { GenericEventBus } from "@onething/backend/event";
import type { AgentEngineSessionEvent } from "@onething/backend/agent";
import { getLogger } from '@onething/backend/logging'
import {
	createTenantAudienceFactory,
	type SessionAudienceFactory,
	type SessionIndexPort,
} from "@onething/backend/http-server/http-server-audience.js";
import { defaultRequestContext, isDefaultServerRequestContext, ownerKey } from "@onething/backend/http-server/http-server-tenant-paths.js";
import { workspaceSandboxRoot } from "@onething/backend/http-server/http-server-sandbox.js";
import type {
	RuntimeMessagesAdapter,
	RuntimeRequestContext,
	RuntimeSessionsAdapter,
	RuntimeUnsubscribe,
} from "@onething/backend/http-server/http-server-runtime-facade.js";
import type {
	GetSessionMessagesPageRequest,
	GetSessionMessagesPageResponse,
	SessionMeta,
} from "@shared/ipc/chat.js";
import { SESSION_EVENT_TYPES } from "@shared/events/index.js";
import {
	normalizeStoredServerSession,
	type ServerChatSession,
	type ServerSessionIndexMeta,
	type ServerSessionStore,
} from './session-client-api-server-store.js'
import {
	applySessionEvent,
	applySessionPatch,
	getMessagePage,
	ownsSession,
	ownsSessionMeta,
	sessionMetaFieldsOf,
	stripSessionOwnerFields,
	toChatSession,
	toSessionDetails,
} from './session-client-api-server-projection.js'

// 日志命名空间沿用搬家前的 `server.runtime`。
const log = getLogger('server.runtime')

export interface ServerSessionWorkingSetPorts {
	/** 只读 `persistsMessages` 一格,每次现读(与搬家前读 `backend.persistsMessages` 同一时刻)。 */
	backend: { readonly persistsMessages: boolean };
	sessionStore: ServerSessionStore;
	eventBus: GenericEventBus<AgentEngineSessionEvent>;
	workspaceRoot: string;
	/** 宿主换受众的那一格(`OnethingServerRuntimeOptions.audienceFactory`);缺席 = 按会话归属判。 */
	audienceFactory?: SessionAudienceFactory;
}

/** `ServerRuntimeStore` 订阅里、活跃流账本之后与回声投影之前的那一位旁听者。 */
export type ServerRuntimeStoreTap = (envelope: { sessionId: string; event: AgentEngineSessionEvent }) => void;

export type ServerSessionWorkingSet = ReturnType<typeof createServerSessionWorkingSet>;

export function createServerSessionWorkingSet(ports: ServerSessionWorkingSetPorts) {
	const { backend, sessionStore, eventBus, workspaceRoot } = ports;
	// 触碰即驻留的工作集,不再启动全量镜像:同一 sessionId 在本进程内保持
	// 单一对象身份(事件回放与 API 变更共用),冷会话按需从存储加载。
	const sessions = new Map<string, ServerChatSession>();
	// Live-stream ledger derived from engine events (stream:start adds, any
	// terminal stream event removes). Works identically for the real engine
	// and echo test backends — its predecessor was an AbortController map that
	// nothing ever populated, so /api/streams/abort no-oped while the engine
	// kept streaming (architecture-review-2026-07-26.md A1).
	const activeStreamSessions = new Set<string>();
	const currentSessionIds = new Map<string, string>();
	const isDefaultContext = (context = defaultRequestContext()) =>
		isDefaultServerRequestContext(context);

	const findSessionIndexMeta = (
		sessionId: string,
	): ServerSessionIndexMeta | undefined =>
		sessionStore.findSessionMeta
			? (sessionStore.findSessionMeta(sessionId) as
					| ServerSessionIndexMeta
					| undefined)
			: (sessionStore.getSessionsList() as ServerSessionIndexMeta[]).find(
					(meta) => meta.id === sessionId,
				);

	/**
	 * 受众的真相源(批 A §3.1)。`findMeta` 走上面那口;`onChanged` 是 app 仓库
	 * 索引写门的通知口。
	 *
	 * **为什么一个通知口就够**:备忘记的是「这条会话归不归我」,而归属只在会话
	 * **创建**那一刻盖一次章(`stampOwner`),之后没有改归属的写路。新会话对备忘
	 * 恒是一次未命中(没记过就现判),所以通知口今天的作用是**防御性**的 ——
	 * 将来真出现「共享会话」这类新归属规则时,失效口已经在正确的位置上。
	 */
	const sessionIndexPort: SessionIndexPort = {
		// 索引里没有这条时**回落到会话对象**:批 A 之前那把尺子问的是
		// `getSessionForContext`(会话对象上的归属),而索引条目理论上可以还没写
		// (存量盘、echo 后端的工作集)。回落只在**备忘未命中且索引查无此条**时跑,
		// 热路上一步都不多 —— 换来的是与批 A 之前逐字同判,不是「大概一样」。
		findMeta: (sessionId) => findSessionIndexMeta(sessionId) ?? resolveSession(sessionId),
		onChanged: (listener) => onSessionIndexChanged(listener),
	};
	const audienceFactory: SessionAudienceFactory =
		ports.audienceFactory ?? createTenantAudienceFactory(sessionIndexPort);

	const loadSessionIntoWorkingSet = (
		sessionId: string,
	): ServerChatSession | undefined => {
		const session = sessionStore.getSession(sessionId);
		if (!session) return undefined;
		normalizeStoredServerSession(session, sessionStore.getMessages(sessionId));
		sessions.set(sessionId, session);
		return session;
	};

	// 取会话:活跃流会话以内存态为准;冷会话按 index 元数据的 updatedAt 判断
	// 是否被其他进程(桌面端共用同一存储)改写,过期才重读单个会话文件。
	const resolveSession = (sessionId: string): ServerChatSession | undefined => {
		if (backend.persistsMessages) {
			// sessionStore is app-backed: the same repository the in-process
			// engine writes through, so its in-memory session is the freshest
			// truth (async writes may still be queued). Never route real-engine
			// sessions through the `sessions` working set — a stale copy there
			// would shadow engine state.
			return sessionStore.getSession(sessionId);
		}
		const cached = sessions.get(sessionId);
		if (cached && activeStreamSessions.has(sessionId)) return cached;
		if (cached) {
			const meta = findSessionIndexMeta(sessionId);
			if (!meta || meta.updatedAt === cached.updatedAt) return cached;
		}
		return loadSessionIntoWorkingSet(sessionId) ?? cached;
	};

	const getServerCurrentSessionId = (
		context = defaultRequestContext(),
	): string =>
		isDefaultContext(context)
			? sessionStore.getCurrentSessionId()
			: getCurrentSessionId(currentSessionIds, context);

	const setServerCurrentSessionId = (
		context: RuntimeRequestContext,
		sessionId: string,
	): void => {
		if (isDefaultContext(context)) {
			sessionStore.setCurrentSessionId(sessionId);
		} else {
			setCurrentSessionId(currentSessionIds, context, sessionId);
		}
	};

	const persistSession = (session: ServerChatSession): void => {
		if (!backend.persistsMessages) {
			// Echo path only: stamp echo-provider defaults and keep the session
			// resident in the working set. Real-engine sessions live in the app
			// repository — stamping 'local-echo' here would persist into the
			// store shared with the desktop.
			normalizeStoredServerSession(
				session,
				sessionStore.getMessages(session.id),
			);
			sessions.set(session.id, session);
		}
		sessionStore.saveSession(session);
	};

	const getSessionForContext = (
		sessionId: string,
		context = defaultRequestContext(),
	): ServerChatSession | undefined => {
		const session = resolveSession(sessionId);
		if (!session || !ownsSession(session, context)) return undefined;
		return session;
	};

	// 会话列表只读 index 元数据(所有权字段由 store 回填/盖章),不加载消息体。
	const listOwnedSessionMetas = (
		context = defaultRequestContext(),
	): ServerSessionIndexMeta[] =>
		(sessionStore.getSessionsList() as ServerSessionIndexMeta[]).filter(
			(meta) => ownsSessionMeta(meta, context),
		);

	const listSessionsForContext = (
		context = defaultRequestContext(),
	): SessionMeta[] =>
		listOwnedSessionMetas(context).map(stripSessionOwnerFields);

	const ensureSession = (
		context: RuntimeRequestContext,
		sessionId = createSessionId(),
	): ServerChatSession => {
		const existing = resolveSession(sessionId);
		if (existing) {
			if (!ownsSession(existing, context)) throw new Error('Session not found')
			return existing;
		}

		const root = workspaceSandboxRoot(workspaceRoot, context);
		// Synchronous: callers (file watch, tools) may stat this root right
		// after session creation, and a fire-and-forget mkdir loses that race.
		try {
			mkdirSync(root, { recursive: true });
		} catch (error) {
			log.error("create workspace root failed", { root }, error);
		}
		let session: ServerChatSession;
		if (backend.persistsMessages) {
			// Single-writer: the app-backed store creates through the same
			// repository the engine reads from, so the session is visible to an
			// immediately-following command:send-message (draft-id flows send
			// right after create) without waiting for any async flush.
			session = sessionStore.createSession(sessionId, "New Chat", context);
			updateAppSessionWorkingDirectory(sessionId, root);
			updateAppSessionWorkingDirectoryRoots(sessionId, [root]);
		} else {
			session = sessionStore.createSession(sessionId, "New Chat", context);
			if (!session.workingDirectory) session.workingDirectory = root;
			if (!session.workingDirectoryRoots?.length)
				session.workingDirectoryRoots = [root];
			persistSession(session);
		}
		if (!getServerCurrentSessionId(context)) {
			setServerCurrentSessionId(context, session.id);
		}
		return session;
	};

	/**
	 * 那条 `ServerRuntimeStore` 总线订阅。一条订阅,三段按这个顺序跑:活跃流账本、
	 * `tap`(调用方递进来的旁听,今天是待答权限账)、回声后端的事件投影。
	 */
	const subscribeRuntimeStore = (tap: ServerRuntimeStoreTap): RuntimeUnsubscribe =>
		eventBus.onAnySessionAny((envelope) => {
			const eventType = (envelope.event as { type?: string }).type;
			if (eventType === SESSION_EVENT_TYPES.STREAM_START) {
				activeStreamSessions.add(envelope.sessionId);
			} else if (
				eventType === SESSION_EVENT_TYPES.STREAM_COMPLETE ||
				eventType === SESSION_EVENT_TYPES.STREAM_ERROR ||
				eventType === SESSION_EVENT_TYPES.STREAM_ABORTED
			) {
				activeStreamSessions.delete(envelope.sessionId);
			}
			tap(envelope);
			if (!backend.persistsMessages) {
				// Test/echo backends do not persist; project their events into the
				// server store. The real StreamEngine writes through the shared app
				// repository itself — projecting again would double-write, and
				// there is no second cache left to invalidate.
				const session = sessions.get(envelope.sessionId);
				if (!session) return;
				applySessionEvent(sessionStore, session, envelope.event);
				persistSession(session);
			}
		}, "ServerRuntimeStore");

	const sessionsPort: RuntimeSessionsAdapter<unknown, unknown, string, Record<string, unknown>> = {
		async list(context = defaultRequestContext()) {
			return {
				success: true,
				sessions: listSessionsForContext(context),
			};
		},
		async create(
			name: string,
			context = defaultRequestContext(),
			requestedSessionId?: string,
		) {
			// Client-supplied ids keep the renderer's draft identity stable
			// (the draft id becomes the session id). Only plain v4 UUIDs are
			// accepted — the id is a storage path segment — and an id that
			// already exists is refused rather than silently adopted.
			if (requestedSessionId !== undefined) {
				if (!SESSION_ID_V4_RE.test(requestedSessionId)) {
					return { success: false as const, error: "Invalid session id" };
				}
				if (getSessionForContext(requestedSessionId, context)) {
					return {
						success: false as const,
						error: "Session id already exists",
					};
				}
			}
			const session = ensureSession(
				context,
				requestedSessionId ?? createSessionId(),
			);
			session.name = name || "New Chat";
			session.updatedAt = Date.now();
			persistSession(session);
			setServerCurrentSessionId(context, session.id);
			return { success: true, session: toChatSession(session) };
		},
		// P4c 第五批:会话的读/改/删(get / activate / delete / rename /
		// createBranch)整批迁到 `sessions` RPC 域 —— server 从此与桌面吃同一份
		// 实现,这里那套 per-owner 的第二份没有了。`list` / `create` 留着是因为
		// `apps/mobile` 仍然直接打那两条 REST(拍板 #32);`update` 留着是因为
		// `POST /api/sessions/:id/max-tokens` 从来不在那 26 条里。
		async update(
			sessionId: string,
			patch: Record<string, unknown>,
			context = defaultRequestContext(),
		) {
			const session = getSessionForContext(sessionId, context);
			if (!session) return { success: false, error: "Session not found" };
			// §13.10 M7:快照必须**在 applySessionPatch 之前**取。
			//
			// `applySessionPatch` 就地改这只对象,而真后端上它正是 app store
			// 里那一份 —— 等 `persistSession` → `sessionCommands.patchSession`
			// 再去问"改之前是什么",问到的已经是改之后的值,三格
			// (agent / model / workdir)于是一条事件都写不出来。
			// `POST /api/sessions/:id/agent` 从此在账本上是无声的。
			const beforeMeta = sessionMetaFieldsOf(session);
			const patchResult = applySessionPatch(session, patch, workspaceRoot);
			if (!patchResult.success) return patchResult;
			persistSession(session);
			// 翻译排在写成功之后(翻译器的纪律 1)。三格里没变的那些由翻译器
			// 自己按 before 逐格比对丢掉,这里不预筛。
			if (backend.persistsMessages) sessionCommandEvents.patchSession(
				sessionId,
				sessionMetaFieldsOf(session),
				beforeMeta,
			);
			return { success: true, session: toSessionDetails(session) };
		},
	};
	const messagesPort: RuntimeMessagesAdapter<GetSessionMessagesPageRequest, GetSessionMessagesPageResponse, unknown> = {
		async page(
			request: GetSessionMessagesPageRequest,
			context = defaultRequestContext(),
		) {
			const session = getSessionForContext(request.sessionId, context);
			if (!session) {
				return { success: false, error: "Session not found" };
			}
			// Real backends: the app-store session in memory is the truth
			// (async writes may still be queued) — page from it directly.
			return backend.persistsMessages || activeStreamSessions.has(request.sessionId)
				? getMessagePage(sessionStore.getMessages(request.sessionId), request)
				: sessionStore.getMessagesPage(request);
		},
	};

	return {
		sessionStore,
		audienceFactory,
		findSessionIndexMeta,
		resolveSession,
		getSessionForContext,
		listSessionsForContext,
		getServerCurrentSessionId,
		persistSession,
		subscribeRuntimeStore,
		sessionsPort,
		messagesPort,
	};
}

function getCurrentSessionId(
	currentSessionIds: Map<string, string>,
	context = defaultRequestContext(),
): string {
	return currentSessionIds.get(ownerKey(context)) ?? "";
}

function setCurrentSessionId(
	currentSessionIds: Map<string, string>,
	context: RuntimeRequestContext,
	sessionId: string,
): void {
	const key = ownerKey(context);
	if (sessionId) {
		currentSessionIds.set(key, sessionId);
	} else {
		currentSessionIds.delete(key);
	}
}

function createSessionId(): string {
	return `web-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

// Renderer-supplied session ids (draft ids that materialize in place) must be
// plain v4 UUIDs — they end up in storage paths.
const SESSION_ID_V4_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
