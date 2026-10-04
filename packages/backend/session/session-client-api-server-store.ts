/**
 * HTTP 服务器那一侧的会话仓(会话开给界面的第二入口的一个方面,决策 D26)。
 *
 * 这只文件回答一件事:server runtime 读写会话的时候,背后是哪一只仓库。两种答案:
 *
 *  - **app 背书**(`createAppBackedServerSessionStore`):真引擎在同一个进程里,读写的就是
 *    引擎自己那只会话仓库 —— 再开第二只会把内存真相分叉。
 *  - **回声**(`createEchoServerSessionStore`,旧名 `createLocalServerSessionStore`):测试与回声
 *    后端用的那只独立仓库,同一批文件、自己的缓存与写队列。
 *
 * 两只仓库共用这里的接口 `ServerSessionStore` 与服务端视角的会话形状 `ServerChatSession`。
 * 2026-10-04 从 `http-server/http-server-runtime.ts` 原样搬来(决策 D219),代码一行没改;
 * 只有 HTTP 服务器引它(`client-api:gate`)。
 */
import { resolve } from "node:path";
import { sessionDeletion } from '@onething/backend/session'
import { sessionAccess } from '@onething/backend/session'
import { collectSessionCascadeDeleteIds } from '@onething/backend/session'
import { mergeWithDefaults } from "@onething/backend/settings";
import { DEFAULT_ONETHING_AGENT_ID } from "@onething/backend/agent";
import { createBranchSession as createAppStoreBranchSession, createSession as createAppStoreSession, flushAllPendingSaves as flushAllAppStorePendingSaves, flushSessionSave as flushAppStoreSessionSave, getCurrentSessionId as getAppStoreCurrentSessionId, getSession as getAppStoreSession, getSessionUserMessageMarkers as getAppStoreSessionUserMessageMarkers, getSessions as getAppStoreSessions, getSessionsList as getAppStoreSessionsList, setCurrentSessionId as setAppStoreCurrentSessionId } from "@onething/backend/session";
import {
	createSessionCommands,
	sessionCommands as appSessionCommands,
	type SessionCommands,
} from "@onething/backend/session";
import { createEchoMessageEvents } from './session-echo-message-events.js';
import {
	sessionReads as appSessionReads,
	sessionPreviewText,
} from "@onething/backend/session";
import { updateSessionsIndexMetaForCommands as updateAppStoreSessionsIndexMeta } from "@onething/backend/session";
import { findSessionIndexMeta as findAppStoreSessionIndexMeta } from "@onething/backend/session";
import { createOnethingSessionRepository, type OnethingSessionRepositoryOptions, type OnethingSessionRepositoryLogger } from "@onething/backend/session";
import {
	deriveSessionLastMessagePreview,
	findLastPreviewableMessage,
} from "@onething/backend/session";
import { expandOnethingToolSandboxPath } from "@onething/backend/tool";
import {
	getOnethingAppStatePath,
	getOnethingCurrentSessionId,
	getOnethingSessionPath,
	getOnethingSessionsDir,
	getOnethingSettingsPath,
	getOnethingStorePath,
	saveOnethingUiState,
	setOnethingCurrentSessionId,
	deleteJsonFile,
	readJsonFile as readCoreJsonFile,
	writeJsonFile as writeCoreJsonFile,
	writeJsonFileAsync as writeCoreJsonFileAsync,
} from "@onething/backend/storage";
import { consolePort, getLogger } from '@onething/backend/logging'
import type { ConsoleLikePort } from '@onething/backend/logging'
import { sessionOwnerOf as sessionOwner } from "@onething/backend/http-server/http-server-audience.js";
import { defaultRequestContext, isDefaultServerRequestContext } from "@onething/backend/http-server/http-server-tenant-paths.js";
import type { RuntimeRequestContext } from "@onething/backend/http-server/http-server-runtime-facade.js";
import type {
	ChatMessage,
	ChatSession,
	GetSessionMessagesPageRequest,
	GetSessionMessagesPageResponse,
	SessionDetails,
	SessionMeta,
	UserMessageMarker,
} from "@shared/ipc/chat.js";
import type { AppSettings } from "@shared/ipc/settings.js";
import { refreshSessionMeta, toSessionMeta } from './session-client-api-server-projection.js'

// 日志命名空间沿用搬家前的 `server.runtime`:`server.jsonl` 里这几行的样子一个字不变。
const log = getLogger('server.runtime')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog: ConsoleLikePort & OnethingSessionRepositoryLogger = consolePort(log)

/**
 * 服务端视角的会话。
 *
 * **`workspaceId` 不在这里** —— 它是 `ChatSession` 自己的字段,语义是**产品空间**
 * (`docs/design/workspace-spaces-2026-08.md` 批 B:「归属的 space,缺席 = default」),
 * 侧栏分组 / `resolveSessionSpaceId` / `countSessionsInWorkspace` 读的都是它。
 * 服务端的**租户归属**从此住在自己的 `owner*` 两格里,不再借用产品那一格:借用的
 * 后果是 UI 建的会话被盖了半个章(有空间、没 userId),归属判据把它的事件从 SSE
 * 广播里整只滤掉(诊断:`docs/audit/web-lane-sse-diagnosis-2026-08-28.md` 第五节)。
 *
 * `userId` 保留为**存量租户字段**:它历来只由服务端盖(见 `stampOwner`),所以老会话
 * 上的它仍按租户读(`sessionOwner`),但新代码一律写 `ownerUserId`。
 */
export type ServerChatSession = ChatSession & {
	/** @deprecated 存量租户 userId(只读兼容,新写走 `ownerUserId`)。 */
	userId?: string;
	/** 服务端租户:主体。缺席 = 这一格不参与判定(见 `ownsSession`)。 */
	ownerUserId?: string;
	/** 服务端租户:作用域。**不是**产品空间 —— 那是 `workspaceId`。 */
	ownerWorkspaceId?: string;
	messageCount?: number;
	previewText?: string;
	/** E 批:最后一条 user/assistant 消息的预览(经 `toSessionMeta` 落到索引元数据)。 */
	lastMessagePreview?: string;
};

export interface ServerSessionStore {
	/**
	 * 按 id 取一条索引元数据(O(1) 的那口)。缺席时调用方退回对 `getSessionsList()`
	 * 的线性 `find` —— 所以这是一格**加速**,不是新语义。
	 */
	findSessionMeta?(sessionId: string): SessionMeta | undefined;
	getCurrentSessionId(): string;
	setCurrentSessionId(sessionId: string): void;
	saveUIState(uiState: unknown): {
		success: boolean;
		state?: unknown;
		error?: string;
	};
	getSessions(): ServerChatSession[];
	getSessionsList(): SessionMeta[];
	getSession(sessionId: string): ServerChatSession | undefined;
	/** Drop any cached body so the next read re-hits disk (engine writes in-process). */
	invalidateSession?(sessionId: string): void;
	createSession(
		sessionId: string,
		name: string,
		context: RuntimeRequestContext,
	): ServerChatSession;
	createBranchSession(
		sessionId: string,
		name: string,
		parentSessionId: string,
		branchFromMessageId: string,
		inheritedMessages: ChatMessage[],
		context: RuntimeRequestContext,
	): ServerChatSession;
	saveSession(session: ServerChatSession): void;
	/**
	 * 只盖 index 元数据,不重写会话体(P0.3)。消息命令已经按写计划落过盘,
	 * 再走一次 `saveSession` 等于把整份 messages.jsonl 重写一遍。
	 */
	saveSessionMeta(session: ServerChatSession): void;
	/**
	 * 会话消息的读口(P0.3 / docs/design/session-commands-p0-2026-08.md §3):
	 * server 不再持有 `session.messages`。app 后端走 `sessionReads`,echo/test
	 * 后端走自己那只仓库 —— 两只仓库是真的两只,不能合并成一个门面。
	 */
	getMessages(sessionId: string): readonly ChatMessage[];
	/**
	 * 会话消息的写口(§2 的 12 命令)。写计划 / COW / lazy 档只有命令面算一次。
	 */
	messages: SessionCommands;
	deleteSession(sessionId: string, context?: RuntimeRequestContext): Promise<{
		deletedIds: string[];
		parentSessionId?: string;
	}>;
	flushSession(sessionId: string): Promise<void>;
	flushAll(): Promise<void>;
	getMessagesPage(
		request: GetSessionMessagesPageRequest,
	): GetSessionMessagesPageResponse;
	getUserMessageMarkers(sessionId: string): UserMessageMarker[] | undefined;
}

/**
 * index.json 里的会话元数据(服务端视角):在共享的 SessionMeta 之上,
 * 由 saveSessionImmediately 盖章所有权字段,使会话列表可以只读 index、
 * 不加载消息体就完成 owner 过滤。ownerVersion 缺失表示存量条目尚未回填。
 */
export type ServerSessionIndexMeta = SessionMeta & {
	/** @deprecated 存量租户 userId(只读兼容)。 */
	userId?: string;
	/** 服务端租户(`workspaceId` 是产品空间,继承自 `SessionMeta`,不是归属)。 */
	ownerUserId?: string;
	ownerWorkspaceId?: string;
	ownerVersion?: number;
	workingDirectory?: string;
};

/**
 * 2:租户归属从 `userId`/`workspaceId` 换到 `owner*` 两格。版本一升,存量 index 条目
 * 全部重新回填 —— 那些被错误抄成「空间 = 租户」的旧值就此清掉。
 */
export const SESSION_INDEX_OWNER_VERSION = 2;

/**
 * ServerSessionStore backed by the @onething/backend session repository — the same
 * repository the in-process StreamEngine reads and writes. Used when the
 * backend persists messages itself (real engine): a second local repository
 * over the same files would fork the in-memory truth (stale index/LRU reads
 * showing up as intermittent 404/empty history) and race its write queue
 * against the engine's (tmp-rename ENOENT on jsonl suffix writes).
 *
 * Requires ONETHING_STORE_PATH to already point at the served store —
 * createRealServerBackend pins it before booting the backend.
 */
export function createAppBackedServerSessionStore(
	storePath = getOnethingStorePath(),
): ServerSessionStore {
	const appStatePath = getOnethingAppStatePath({
		storePath: resolve(storePath),
	});
	// 不复刻 echo 侧的 lastProvider/lastModel 兜底:这里的会话对象就是引擎的
	// 活对象,凭空盖 'local-echo' 会被持久化进共享存储,污染桌面端数据。
	// P0.3:原来这里还有一句 `session.messages = Array.isArray(...) ? ... : []`。
	// 那是死代码 —— 走到这里的会话都经过 `getSession` → `sanitizeSessionOnStartup`
	// → `computeSessionRepairOnLoad(session, session.messages)`,messages 不是数组
	// 早就在那里 `.map` 崩了;createSession/createBranchSession 也恒建数组。
	// 派生字段改从读门面取,server 不再持有 `session.messages`。
	/**
	 * 批 A §3.4:**只剩 `agentId` 缺省那一行**。
	 *
	 * 从前这里无条件 `listMessages(session.id)` 把整条会话物化一遍,只为填
	 * `messageCount` 与 `previewText` 两个标量 —— 大会话上一次 69ms,而它挂在
	 * `getSession` 上,于是每一条流式分片的归属判定都要付这笔钱。
	 *
	 * 那两格本来就有写侧在维护:`messageCount` 由命令面的列表投影
	 * (`applySessionListProjectionToMeta`,E 批)每次落账时算,`previewText` 由
	 * server 自己的 `refreshSessionMeta` 在保存时算。读侧再算一遍就是「两边各算
	 * 一份」,正是这一批要消掉的东西。
	 */
	const normalizeAppSession = (
		session: ServerChatSession,
	): ServerChatSession => {
		if (!session.agentId) session.agentId = DEFAULT_ONETHING_AGENT_ID;
		return session;
	};
	// P0.4:`saveSessionSnapshot` 后门退役 —— 会话级字段改走命令面的
	// `patchSession`。差别不只是门牌:老后门按 `structural` 写计划落盘,等于每次
	// 改个名字/置顶/归档都把整份 `messages.jsonl` 重写一遍;jsonl 布局里会话级
	// 字段全住 `meta.json`,`patchSession` 一律 `meta` 计划,消息一行不动。
	const save = (session: ServerChatSession): void => {
		const normalized = normalizeAppSession(session);
		const { messages: _messages, ...fields } = normalized;
		appSessionCommands.patchSession(normalized.id, {
			patch: fields,
			mutateIndexMeta: (meta) =>
				Object.assign(meta, toSessionMeta(normalized), {
					// 租户两格(产品空间不是归属,不进这里 —— 它随 `toSessionMeta`
					// 已经在会话元数据里了)。
					ownerUserId: sessionOwner(normalized).userId,
					ownerWorkspaceId: sessionOwner(normalized).workspaceId,
					ownerVersion: SESSION_INDEX_OWNER_VERSION,
				}),
		});
	};
	const stampOwner = (
		session: ServerChatSession,
		context: RuntimeRequestContext,
	): ServerChatSession => {
		if (!isDefaultServerRequestContext(context)) {
			// 盖的是**租户**章。产品空间(`session.workspaceId`)一个字不碰 ——
			// 从前这里把它覆盖成 `context.workspaceId`,等于用租户默认值抹掉用户
			// 选的空间。
			session.ownerUserId = context.userId;
			session.ownerWorkspaceId = context.workspaceId;
			save(session);
		}
		return normalizeAppSession(session);
	};
	return {
		getCurrentSessionId: () => getAppStoreCurrentSessionId(),
		setCurrentSessionId: (sessionId) => {
			setAppStoreCurrentSessionId(sessionId);
		},
		saveUIState(uiState) {
			return saveOnethingUiStateForServer(appStatePath, uiState);
		},
		getSessions: () =>
			(getAppStoreSessions() as ServerChatSession[]).map(normalizeAppSession),
		getSessionsList: () => getAppStoreSessionsList(),
		findSessionMeta: (sessionId) => findAppStoreSessionIndexMeta(sessionId),
		// invalidateSession intentionally absent: single repository — the
		// engine's cache IS the fresh copy; dropping it would only cost reloads.
		getSession: (sessionId) => {
			const session = getAppStoreSession(sessionId) as
				| ServerChatSession
				| undefined;
			return session ? normalizeAppSession(session) : undefined;
		},
		createSession: (sessionId, name, context) =>
			stampOwner(
				createAppStoreSession(sessionId, name) as ServerChatSession,
				context,
			),
		createBranchSession: (
			sessionId,
			name,
			parentSessionId,
			branchFromMessageId,
			inheritedMessages,
			context,
		) =>
			stampOwner(
				createAppStoreBranchSession(
					sessionId,
					name,
					parentSessionId,
					branchFromMessageId,
					inheritedMessages,
				) as ServerChatSession,
				context,
			),
		saveSession: save,
		saveSessionMeta: (session) => {
			const normalized = normalizeAppSession(session);
			updateAppStoreSessionsIndexMeta(normalized.id, (meta) =>
				Object.assign(meta, toSessionMeta(normalized), {
					ownerUserId: sessionOwner(normalized).userId,
					ownerWorkspaceId: sessionOwner(normalized).workspaceId,
					ownerVersion: SESSION_INDEX_OWNER_VERSION,
				}),
			);
		},
		getMessages: (sessionId) =>
			appSessionReads.listMessages(sessionId).messages,
		messages: appSessionCommands,
		deleteSession: (sessionId, context = defaultRequestContext()) => {
			const ids = sessionAccess.resolveAll(context,
				collectSessionCascadeDeleteIds(getAppStoreSessionsList(), sessionId), 'delete')
			return sessionDeletion.delete(sessionId, ids, targets => {
				sessionAccess.resolveAll(context, targets, 'delete')
			})
		},
		flushSession: (sessionId) => flushAppStoreSessionSave(sessionId),
		flushAll: () => flushAllAppStorePendingSaves(),
		// S2b:app-store 背书的这只读门面两条读法都收口到 `appSessionReads`,
		// `ONETHING_SESSION_READ=events` 因此对分页也生效;messages 模式下
		// `pageMessages` 逐字走同一个 `getSessionMessagesPage`(store.js 再导出的
		// 就是 session/session-store.ts 那份),页信封一格不动。
		getMessagesPage: (request) =>
			appSessionReads.pageMessages(request) as GetSessionMessagesPageResponse,
		getUserMessageMarkers: (sessionId) =>
			getAppStoreSessionUserMessageMarkers(sessionId),
	};
}

export function createEchoServerSessionStore(
	storePath = getOnethingStorePath(),
): ServerSessionStore {
	const resolvedStorePath = resolve(storePath);
	const appStatePath = getOnethingAppStatePath({
		storePath: resolvedStorePath,
	});
	const getSessionFilePath = (sessionId: string) =>
		getOnethingSessionPath(sessionId, { storePath: resolvedStorePath });
	// 会话体紧凑序列化,与 Electron 宿主保持一致;index.json 仍走 pretty。
	const writeSessionJsonFileAsync = (filePath: string, data: unknown) =>
		writeCoreJsonFileAsync(filePath, data, { pretty: false });
	const sessionRepositoryOptions: OnethingSessionRepositoryOptions<ServerChatSession, ChatMessage, SessionMeta, SessionDetails, UserMessageMarker> = {
		defaultAgentId: DEFAULT_ONETHING_AGENT_ID,
		getSessionsDir: () =>
			getOnethingSessionsDir({ storePath: resolvedStorePath }),
		getSessionPath: getSessionFilePath,
		readJsonFile: readCoreJsonFile,
		writeJsonFile: writeCoreJsonFile,
		writeJsonFileAsync: writeSessionJsonFileAsync,
		deleteJsonFile,
		// The explicit echo host stores complete JSON transcripts. It never
		// reads, migrates or writes through the production session ledger.
		getCurrentSessionId: () => getOnethingCurrentSessionId(appStatePath),
		setCurrentSessionId: (sessionId) => {
			setOnethingCurrentSessionId(appStatePath, sessionId);
		},
		getDefaultWorkingDirectory: () =>
			readLocalDefaultWorkingDirectory(resolvedStorePath),
		expandPath: expandOnethingToolSandboxPath,
		logger: consoleLog,
	};
	const repository = createOnethingSessionRepository<
		ServerChatSession,
		ChatMessage,
		SessionMeta,
		SessionDetails,
		UserMessageMarker
	>(sessionRepositoryOptions);

	repository.initializeSessionRepositoryIndex();

	// P0.3:echo/test 后端这只仓库与 `@onething/backend` 的那只是**两只**(同一批文件、
	// 各有各的缓存与写队列),所以命令面也得为它单独装一份 —— `sessionCommands`
	// 那个单例绑死在 app store 上,借过来用会写到另一份内存真相里去。
	// 装的是同一个工厂,判据 / 会话账 / 落盘档的算法只有那一份(§17.7.1 批 3 起
	// 归约器退役,那层执行体也没有了)。
	const messageCommands = createSessionCommands({
		reads: {
			countMessages: sessionId => repository.getSessionMessages(sessionId)?.length ?? 0,
			getMessage: (sessionId, messageId) => repository.getSessionMessages(sessionId)?.find(message => message.id === messageId),
			findMessage: (sessionId, predicate, options) => {
				const messages = repository.getSessionMessages(sessionId) ?? [];
				if (options?.from === 'end') {
					for (let index = messages.length - 1; index >= 0; index--) {
						if (predicate(messages[index]!, index)) return messages[index];
					}
					return undefined;
				}
				return messages.find(predicate);
			},
			listMessages: sessionId => ({ messages: repository.getSessionMessages(sessionId) ?? [], changed: false }),
		},
		hasMessage: (sessionId, messageId) => repository.getSessionMessages(sessionId)?.some(message => message.id === messageId) ?? false,
		getSession: (sessionId) => repository.getSession(sessionId),
		// §17.7.1 批 3:落盘调度归写门(归约器退役,`result.lazy` 没有了产地)。
		saveSession: (sessionId, session, options) =>
			repository.saveSessionToFile(sessionId, session as ServerChatSession, options),
		updateSessionsIndexMeta: (sessionId, update) =>
			repository.updateSessionsIndexMeta(sessionId, (meta) =>
				update(meta as unknown as { [key: string]: unknown }),
			),
		flushSessionSave: (sessionId) => repository.flushSessionSave(sessionId),
		patchSession: (sessionId, patch, mutateIndexMeta) =>
			repository.patchSession(sessionId, patch, mutateIndexMeta),
		// 协作署名是桌面/引擎侧的事,server 不盖章(与迁移前 `session.messages.push`
		// 的行为一致)。
	}, { events: createEchoMessageEvents(id => repository.getSession(id)), account: () => undefined });

	const readMessages = (sessionId: string): readonly ChatMessage[] =>
		repository.getSessionMessages(sessionId) ?? [];

	// 存量 index 条目补齐所有权字段(一次性,ownerVersion 盖章后不再重跑):
	// 会话列表因此可以只读 index 完成 owner 过滤,不必加载消息体。
	const backfillSessionIndexOwnership = (): void => {
		// 整个读-改-写放进跨进程 index 锁,锁内重新读盘,避免与桌面端并发写丢条目。
		repository.runWithSessionsIndexLock(() => {
			const index = repository.loadSessionsIndex() as ServerSessionIndexMeta[];
			const missing = index.filter(
				(meta) => meta.ownerVersion !== SESSION_INDEX_OWNER_VERSION,
			);
			if (missing.length === 0) return;
			const start = Date.now();
			for (const meta of missing) {
				// 只读加载(不 sanitize、不入队写会话体):避免 headless server 在启动 backfill 时
				// 重写 Electron 拥有的会话体,与其 suffix 写竞态损坏 messages.jsonl。
				const session = repository.getSessionRaw(meta.id);
				const owner = sessionOwner((session ?? {}) as ServerChatSession);
				meta.ownerUserId = owner.userId;
				meta.ownerWorkspaceId = owner.workspaceId;
				meta.ownerVersion = SESSION_INDEX_OWNER_VERSION;
			}
			repository.saveSessionsIndex(index);
			log.info("session index ownership backfilled", {
				sessions: missing.length,
				ms: Date.now() - start,
			});
		});
	};
	backfillSessionIndexOwnership();

	const saveSessionImmediately = (session: ServerChatSession): void => {
		const normalized = normalizeStoredServerSession(
			session,
			readMessages(session.id),
		);
		repository.saveSessionToFile(normalized.id, normalized);
		// Echo owns a complete transcript; queued command writes still drain
		// through flushSession/flushAll before this store is released.
		{
			writeCoreJsonFile(getSessionFilePath(normalized.id), normalized, {
				pretty: false,
			});
			repository.cancelPendingSave(normalized.id);
		}
		repository.updateSessionsIndexMeta(normalized.id, (meta) =>
			Object.assign(meta, toSessionMeta(normalized), {
				ownerUserId: sessionOwner(normalized).userId,
				ownerWorkspaceId: sessionOwner(normalized).workspaceId,
				ownerVersion: SESSION_INDEX_OWNER_VERSION,
			}),
		);
		repository.syncSessionToSqliteIfReady(normalized);
	};

	return {
		getCurrentSessionId: () => getOnethingCurrentSessionId(appStatePath),
		setCurrentSessionId: (sessionId) => {
			setOnethingCurrentSessionId(appStatePath, sessionId);
		},
		saveUIState(uiState) {
			return saveOnethingUiStateForServer(appStatePath, uiState);
		},
		getSessions: () =>
			repository
				.getSessions()
				.map((session) =>
					normalizeStoredServerSession(session, readMessages(session.id)),
				),
		getSessionsList: () => repository.getSessionsList(),
		invalidateSession: (sessionId) => {
			repository.invalidateSessionCache(sessionId);
		},
		getSession: (sessionId) => {
			const session = repository.getSession(sessionId);
			return session
				? normalizeStoredServerSession(session, readMessages(sessionId))
				: undefined;
		},
		createSession(sessionId, name, context) {
			const created = repository.createSession(sessionId, name);
			const session = normalizeStoredServerSession(
				created,
				readMessages(sessionId),
			);
			// 租户章;产品空间由建会话的入参决定,这里不覆盖。
			session.ownerUserId = context.userId;
			session.ownerWorkspaceId = context.workspaceId;
			refreshSessionMeta(session, readMessages(sessionId), {
				preserveUpdatedAt: true,
			});
			saveSessionImmediately(session);
			return session;
		},
		createBranchSession(
			sessionId,
			name,
			parentSessionId,
			branchFromMessageId,
			inheritedMessages,
			context,
		) {
			const created = repository.createBranchSession(
				sessionId,
				name,
				parentSessionId,
				branchFromMessageId,
				inheritedMessages,
			);
			const session = normalizeStoredServerSession(
				created,
				readMessages(sessionId),
			);
			// 租户章;产品空间由建会话的入参决定,这里不覆盖。
			session.ownerUserId = context.userId;
			session.ownerWorkspaceId = context.workspaceId;
			refreshSessionMeta(session, readMessages(sessionId), {
				preserveUpdatedAt: true,
			});
			saveSessionImmediately(session);
			return session;
		},
		saveSession(session) {
			saveSessionImmediately(session);
		},
		saveSessionMeta(session) {
			const normalized = normalizeStoredServerSession(
				session,
				readMessages(session.id),
			);
			repository.updateSessionsIndexMeta(normalized.id, (meta) =>
				Object.assign(meta, toSessionMeta(normalized), {
					ownerUserId: sessionOwner(normalized).userId,
					ownerWorkspaceId: sessionOwner(normalized).workspaceId,
					ownerVersion: SESSION_INDEX_OWNER_VERSION,
				}),
			);
		},
		getMessages: readMessages,
		messages: messageCommands,
		deleteSession: (sessionId) => repository.deleteSession(sessionId),
		flushSession: (sessionId) => repository.flushSessionSave(sessionId),
		flushAll: () => repository.flushAllPendingSaves(),
		getMessagesPage: (request) =>
			repository.getSessionMessagesPage(
				request,
			) as GetSessionMessagesPageResponse,
		getUserMessageMarkers: (sessionId) =>
			repository.getSessionUserMessageMarkers(sessionId),
	};
}

/** Compatibility name for the explicitly selected echo-host store. */
export const createLocalServerSessionStore = createEchoServerSessionStore;

/**
 * P0.3:`session.messages = Array.isArray(...) ? ... : []` 这句删了 —— 它是死代码
 * (仓库的 `getSession` 里 `sanitizeSessionOnStartup` 先 `.map` 过一遍,不是数组
 * 早就崩了),而派生字段改由调用方把消息递进来。
 */
export function normalizeStoredServerSession(
	session: ServerChatSession,
	messages: readonly ChatMessage[],
): ServerChatSession {
	if (!session.agentId) session.agentId = DEFAULT_ONETHING_AGENT_ID;
	if (!session.lastProvider) session.lastProvider = "local";
	if (!session.lastModel) session.lastModel = "local-echo";
	session.messageCount = messages.length;
	session.previewText = session.previewText ?? sessionPreviewText(messages);
	session.lastMessagePreview =
		session.lastMessagePreview ??
		deriveSessionLastMessagePreview(findLastPreviewableMessage(messages));
	return session;
}

function readLocalDefaultWorkingDirectory(
	storePath: string,
): string | undefined {
	const settings = mergeWithDefaults(
		readCoreJsonFile<Partial<AppSettings>>(
			getOnethingSettingsPath({ storePath }),
			{},
		),
	);
	return settings.tools?.bash?.defaultWorkingDirectory;
}

function saveOnethingUiStateForServer(
	appStatePath: string,
	uiState: unknown,
): { success: boolean; state?: unknown; error?: string } {
	try {
		return {
			success: true,
			state: saveOnethingUiState(
				appStatePath,
				isRecord(uiState) ? uiState : {},
			),
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error && error.message
					? error.message
					: "Failed to save UI state",
		};
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
