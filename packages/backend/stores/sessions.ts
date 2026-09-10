import type {
	ChatMessage,
	ChatSession,
	ToolCall,
	Step,
	ContentPart,
	SessionMeta,
	SessionDetails,
	ContextVariable,
	SessionGoal,
	GetSessionMessagesPageRequest,
	GetSessionMessagesPageResponse,
	PromptContextState,
	UserMessageMarker,
} from "@shared/ipc.js";
import { join } from "node:path";
import { getCurrentBackend } from '../current.js'
import { existsSync, readFileSync, statSync } from "node:fs";
import {
	getOnethingSessionsDir,
	getOnethingSessionPath,
	readJsonFile,
	writeJsonFile,
	writeJsonFileAsync,
	deleteJsonFile,
} from '@onething/runtime/storage';
import { getCurrentSessionId, setCurrentSessionId } from "./app-state.js";
import { sessionLifecycleEvents } from "../session/lifecycle-events.js";
import { sessionCommandEvents } from "../session/command-events.js";
import { assertSessionEventLogIdle, resetSessionEventLogCache } from "../session/event-log.js";
import { sessionDeletion } from '../session/deletion.js'
import { withSessionRemovalOwner } from '../session/removal-event.js'
import type { SessionOwnershipRecord } from '../session/access.js'
import { resetSessionSurfaceCache } from "../session/event-surface.js";
import { resetSessionRuns } from "../session/runs.js";
import { hydrateSessionMessagesFromProjection } from "../session/hydrate.js";
import { materializeSessionMessages } from "../session/materialized-messages.js";
import { eventsHasMessage } from "../session/events-reads.js";
import { hasLiveSessionProjection } from "../session/projection-cache.js";
import { getSettings } from "./settings.js";
import { expandOnethingToolSandboxPath as expandPath } from '@onething/runtime/tools/sandbox-runtime';
import {
	createHybridSessionStorageDriver,
	createOnethingSessionRepository,
} from "@onething/runtime/sessions";
import { COLLAB_MESSAGE_SOURCE, COLLAB_TURN_SOURCE } from "@onething/runtime/collab";
import {
	DEFAULT_SPACE_ID as DEFAULT_WORKSPACE_ID,
	isValidSpaceId,
} from "@onething/runtime/spaces/types";
import {
	guardFrozenMessages,
	guardFrozenSessionMessages,
} from "../session/freeze.js";
import { SESSION_EVENT_TYPES } from "@onething/core/events";
import { getEventBus, isEventSystemInitialized } from "../events/index.js";
import {
	CORE_DEFAULT_AGENT_ID as DEFAULT_AGENT_ID,
	collectSessionCascadeDeleteIds,
	deriveRetainedContextSize,
	getSessionTokenUsageSnapshot,
	repairSessionTimelineMetadata,
	sanitizeSessionOnStartup,
} from "@onething/core/session";
import { assertContentPartIsCarriable } from '../session/content-part-guard.js'
import { assertPortFactIsFolded } from '../session/port-fact-assert.js'
import { consolePort, getLogger } from '../wiring/logging/index.js'
import type { HybridSessionStorageDriverOptions } from '@onething/runtime/sessions/storage-driver'
import type { OnethingSessionRepositoryOptions, OnethingSessionRepositoryLogger, SessionCreateOptions, SessionInitialOwner } from '@onething/runtime/sessions/session-repository'
import type { ConsoleLikePort } from '@onething/runtime/logging'

const log = getLogger('sessions')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog: ConsoleLikePort & OnethingSessionRepositoryLogger = consolePort(log)


export {
	deriveRetainedContextSize,
	repairSessionTimelineMetadata,
	sanitizeSessionOnStartup,
};

// ============ 异步节流落盘 ============
// Streaming updates (每个 token) 会频繁触发 updateMessageContent 等写入,
// 同步 writeFileSync 会阻塞事件循环并拖慢流式节奏。
// 策略:更新内存缓存后,用 300ms 节流把脏 session 异步写盘。
// 同一 session 的多次写入在 promise 链上串行化,避免旧异步写盖新数据。
// 关键生命周期(finalize / delete / 应用退出)会强制 flush。
// 会话体是大文件且只被程序读取,紧凑序列化;index.json 等仍走 pretty 的 writeJsonFile。
const writeSessionJsonFileAsync = (filePath: string, data: unknown) =>
	writeJsonFileAsync(filePath, data, { pretty: false });

const hybridSessionStorageDriverOptions: HybridSessionStorageDriverOptions = {
	getSessionsDir: getOnethingSessionsDir,
	getLegacySessionPath: getOnethingSessionPath,
	// flag 只决定"新建会话"的格式(也是惰性迁移的开关);已有会话跟随盘上格式,
	// settings.storage.sessionFormat 设为 legacy-json 即回滚
	newSessionFormat: () => getSettings().storage?.sessionFormat ?? "jsonl",
	readJsonFile,
	writeJsonFileAsync: writeSessionJsonFileAsync,
	deleteJsonFile,
	logger: consoleLog,
};
const sessionStorageDriver = createHybridSessionStorageDriver<ChatSession>(hybridSessionStorageDriverOptions);

const sessionRepositoryOptions: OnethingSessionRepositoryOptions<ChatSession, ChatMessage, SessionMeta, SessionDetails, UserMessageMarker> = {
	defaultAgentId: DEFAULT_AGENT_ID,
	getSessionsDir: getOnethingSessionsDir,
	getSessionPath: getOnethingSessionPath,
	readJsonFile,
	writeJsonFile,
	writeJsonFileAsync: writeSessionJsonFileAsync,
	deleteJsonFile,
	storageDriver: sessionStorageDriver,
	deleteSessionsDurably: async ids => {
		const recovery = getCurrentBackend('sessionDeletionRecovery').sessionDeletionRecovery
		const intent = recovery.prepare(ids)
		await recovery.commit(intent)
	},
	isSessionDeleted: (id, generation) =>
		getCurrentBackend('sessionDeletionRecovery').sessionDeletionRecovery.isDeleted(id, generation),
	// S3w-1:冷加载补水源。F4-a 起**无条件**走投影(档位 `ONETHING_SESSION_HYDRATE`
	// 已退役);返回 undefined = 这条会话的事件里折不出历史,仓库照旧自己加载。
	hydrateMessagesFromProjection: hydrateSessionMessagesFromProjection,
	// F4-c c4-d(§16.27):**物化视图** —— 每次交出会话时,消息那一格从折叠产物取。
	// 这一口装上之后,内存 store 的消息数组只有一个维护者(折叠产物),18 个热写
	// 端口整批空转;返回 undefined = 这条会话没有可用的折叠产物,保留仓库那一份。
	materializeMessagesFromProjection: materializeSessionMessages,
	getCurrentSessionId,
	setCurrentSessionId,
	getDefaultWorkingDirectory: () =>
		getSettings().tools?.bash?.defaultWorkingDirectory,
	expandPath,
	logger: consoleLog,
};
const sessionRepository = createOnethingSessionRepository<
	ChatSession,
	ChatMessage,
	SessionMeta,
	SessionDetails,
	UserMessageMarker
>(sessionRepositoryOptions);

/* ── 会话索引:写点通知 + 按 id 的视图(批 A) ───────────────────────────────
 *
 * 索引是**归属判定的真相源**(`docs/design/event-subscription-audience-2026-09.md`
 * §3.1):创建 / 删除 / 改归属三件事都要写索引,所以订阅侧的受众备忘只要在这一口
 * 上失效就够了 —— 不必去事件总线上找一组它根本没有的事件类型。
 */
type SessionIndexChangedListener = (sessionId: string | undefined) => void;

const sessionIndexChangedListeners = new Set<SessionIndexChangedListener>();

/**
 * 索引写点的通知口。回的是退订函数。
 *
 * **契约**:参数是被改的那一条 id;**`undefined` = 整份索引被换掉了**
 * (`saveSessionsIndex`),听者要把自己按 id 记的东西**整本作废**,而不是删一格。
 * 不用空串当哨兵 —— 空串是一个合法但不存在的 id,删它等于没失效。
 *
 * 与 `onSessionsDeleted` 并列而不是合并:那一口报的是「这批会话没了」(带级联
 * id 表),这一口报的是「这条会话的索引元数据动过了」—— 删除会话两口都发。
 */
export function onSessionIndexChanged(
	listener: SessionIndexChangedListener,
): () => void {
	sessionIndexChangedListeners.add(listener);
	return () => {
		sessionIndexChangedListeners.delete(listener);
	};
}

function notifySessionIndexChanged(sessionId: string | undefined): void {
	sessionIndexById.clear();
	for (const listener of sessionIndexChangedListeners) {
		try {
			listener(sessionId);
		} catch (error) {
			log.error("session index listener failed", { sessionId }, error);
		}
	}
}

/**
 * 索引的**按 id 视图** —— 从前按 id 找一条元数据是对数组线性 `find`,且每次都要
 * 把整份 `index.json` 读回来再 `JSON.parse`。
 *
 * 新鲜度靠两口,**答案与「每次现读」逐字相同**:
 *  1. 进程内每一次索引写点(`notifySessionIndexChanged`)整表作废;
 *  2. 别的进程写盘时进程内没有通知,所以查之前 `stat` 一次 `index.json`,拿
 *     `mtimeMs:size` 当指纹 —— 一次 `statSync` 比整份读盘 + 解析便宜两个数量级。
 *
 * 表本身是 `const`(装配硬闸只禁模块级 `let`);指纹住在一只 `const` 记号对象里,
 * 它是**缓存**而不是装配期状态,不进 `OnethingBackend` 的 own 名单。
 */
const sessionIndexById = new Map<string, SessionMeta>();
const sessionIndexFingerprint = { value: "" };

function sessionsIndexFingerprint(): string {
	try {
		const stat = statSync(join(getOnethingSessionsDir(), "index.json"));
		return `${stat.mtimeMs}:${stat.size}`;
	} catch {
		// 索引还不在(全新 store)—— 空指纹,下一次它出现时指纹就变了。
		return "";
	}
}

/** 按 id 取一条索引元数据。O(1)(指纹没变时),查无此条 = `undefined`。 */
export function findSessionIndexMeta(
	sessionId: string,
): SessionMeta | undefined {
	const fingerprint = sessionsIndexFingerprint();
	if (fingerprint !== sessionIndexFingerprint.value || sessionIndexById.size === 0) {
		sessionIndexById.clear();
		for (const meta of sessionRepository.getSessionsList()) {
			sessionIndexById.set(meta.id, meta);
		}
		sessionIndexFingerprint.value = fingerprint;
	}
	return sessionIndexById.get(sessionId);
}

function updateSessionsIndexMeta(
	sessionId: string,
	update: (meta: SessionMeta) => void,
): boolean {
	const applied = sessionRepository.updateSessionsIndexMeta(sessionId, update);
	notifySessionIndexChanged(sessionId);
	return applied;
}

/**
 * 强制刷盘单个 session,等待所有挂起的写入完成。
 * 用于 stream 结束、session 删除前等关键点。
 */
export async function flushSessionSave(sessionId: string): Promise<void> {
	await sessionRepository.flushSessionSave(sessionId);
}

/**
 * 应用退出前调用,刷完所有挂起的异步写入。
 */
export async function flushAllPendingSaves(): Promise<void> {
	await sessionRepository.flushAllPendingSaves();
}

/**
 * 统一的保存函数 - 更新缓存并安排异步落盘
 * 默认节流异步,finalize/delete 等关键路径可调 flushSessionSave 强刷
 */
function saveSessionToFile(sessionId: string, session: ChatSession): void {
	sessionRepository.saveSessionToFile(sessionId, session);
}

/**
 * 会话级字段补丁(P0.4 命令面 `sessionCommands.patchSession` 的接线口)。
 *
 * 取代 `saveSessionSnapshot` 后门:老路把整会话交回来、按 `structural` 写计划
 * 落盘 —— 而 jsonl 布局里会话级字段全在 `meta.json`,改个名字重写整份消息日志
 * 是纯浪费(SV12 病根的会话级余量)。这里一律 `{kind:'meta'}`,消息一行不动。
 */
export function patchSessionFields(
	sessionId: string,
	patch: Partial<ChatSession>,
	mutateIndexMeta?: (meta: SessionMeta, session: ChatSession) => void,
): boolean {
	const applied = sessionRepository.patchSession(sessionId, patch, mutateIndexMeta);
	// 归属盖章(server 的 `stampOwner` → `save`)走的就是这一口,所以它也是索引写点。
	notifySessionIndexChanged(sessionId);
	return applied;
}

/**
 * 失效单个 session 缓存
 */
export function invalidateSessionCache(sessionId: string): void {
	sessionRepository.invalidateSessionCache(sessionId);
}

/**
 * 清空所有缓存（应用重启时可能需要）
 */
export function clearAllSessionCache(): void {
	sessionRepository.clearAllSessionCache();
}

/**
 * 获取 LRU 缓存统计信息（调试用）
 */
export function getSessionCacheStats(): {
	size: number;
	maxSize: number;
	cachedSessionIds: string[];
} {
	return sessionRepository.getSessionCacheStats();
}

// Load sessions index (metadata only)
function loadSessionsIndex(): SessionMeta[] {
	return sessionRepository.loadSessionsIndex();
}

// Save sessions index
function saveSessionsIndex(index: SessionMeta[]): void {
	sessionRepository.saveSessionsIndex(index);
	// 整份换掉 = 每一条都可能动过归属,按会话报不出来 —— 发 `undefined`(契约见
	// `onSessionIndexChanged`),听者整本作废。
	notifySessionIndexChanged(undefined);
}

// Get all sessions with full data (legacy, for backward compatibility)
export function getSessions(): ChatSession[] {
	return sessionRepository.getSessions();
}

// ============================================================================
// Optimized Session Loading (Metadata Separation)
// ============================================================================

/**
 * workingDirectory is persisted per-session (meta.json / SessionDetails) but is
 * NOT kept in the fast sessions index that `getSessionsList` returns. The
 * sidebar groups sessions by project, so we surface it in the list: read each
 * session's persisted cwd once into this cache (meta.json holds no messages, so
 * the scan is cheap), then keep it fresh on explicit writes. The active
 * session's live changes are separately mirrored into the renderer store via
 * `session:variables-updated`, so this cache only has to cover cold start.
 */
const sessionWorkdirCache = new Map<string, string>();
let sessionWorkdirBackfilled = false;

function readPersistedWorkdir(sessionId: string): string {
	const meta = readJsonFile<{ workingDirectory?: string }>(
		join(getOnethingSessionsDir(), sessionId, "meta.json"),
		{},
	);
	return typeof meta.workingDirectory === "string" ? meta.workingDirectory : "";
}

function ensureWorkdirBackfill(metas: SessionMeta[]): void {
	if (sessionWorkdirBackfilled) return;
	for (const meta of metas) {
		if (sessionWorkdirCache.has(meta.id)) continue;
		const indexWd = meta.workingDirectory;
		sessionWorkdirCache.set(
			meta.id,
			typeof indexWd === "string" && indexWd
				? indexWd
				: readPersistedWorkdir(meta.id),
		);
	}
	sessionWorkdirBackfilled = true;
}

/**
 * Get sessions list with metadata only (no messages)
 * This is the optimized version for fast startup
 */
export function getSessionsList(): SessionMeta[] {
	const metas = sessionRepository.getSessionsList();
	ensureWorkdirBackfill(metas);
	return metas.map((meta) => {
		const workingDirectory = sessionWorkdirCache.get(meta.id);
		return workingDirectory ? { ...meta, workingDirectory } : meta;
	});
}

export function initializeSessionRepositoryIndex(): void {
	sessionRepository.initializeSessionRepositoryIndex();
}

/**
 * Get session details without messages
 * Used for session activation before loading messages
 */
export function getSessionDetails(
	sessionId: string,
): SessionDetails | undefined {
	return sessionRepository.getSessionDetails(sessionId);
}

/**
 * Get session messages only
 * Called separately after activating a session
 */
export function getSessionMessages(
	sessionId: string,
): ChatMessage[] | undefined {
	return guardFrozenMessages(sessionRepository.getSessionMessages(sessionId));
}

/**
 * Get a cursor-addressed page of session messages.
 *
 * This JSON-backed implementation intentionally preserves the existing storage
 * path while establishing the page contract that SQLite will implement
 * directly. It still reads the full legacy session file internally.
 */
export function getSessionMessagesPage(
	request: GetSessionMessagesPageRequest,
): GetSessionMessagesPageResponse {
	return sessionRepository.getSessionMessagesPage(
		request,
	) as GetSessionMessagesPageResponse;
}

export function getSessionUserMessageMarkers(
	sessionId: string,
): UserMessageMarker[] | undefined {
	return sessionRepository.getSessionUserMessageMarkers(sessionId);
}

/**
 * Read a session from disk without inserting into the LRU cache.
 * Use for bulk read-only operations like search that scan many sessions.
 */
export function getSessionRaw(sessionId: string): ChatSession | undefined {
	return sessionRepository.getSessionRaw(sessionId);
}

// Get a single session by ID
export function getSession(sessionId: string): ChatSession | undefined {
	// 开发期深冻结(docs/design/session-commands-p0-2026-08.md §1):交出去的消息
	// 对象冻住,漏网的就地改当场抛 TypeError。实现在 `app/session/freeze.ts`。
	return guardFrozenSessionMessages(sessionRepository.getSession(sessionId));
}

// Create a new session
export function createSession(
	sessionId: string,
	name: string,
	options: SessionCreateOptions = {},
): ChatSession {
	sessionDeletion.reopen(sessionId)
	return recordSessionCreated(
		sessionRepository.createSession(sessionId, name, options),
	);
}

/**
 * S1a(§10.3 ①):`session/created` 是这份事件日志的**第一条**,而且会话目录
 * 由事件层建起来 —— 鸡生蛋(B4)因此消失:仓库那边的 `saveSession` 是节流的,
 * 新会话在那 300ms 窗口里发出的事件从前全丢。
 *
 * 三个创建入口(有焦点 / 无焦点 / 分支)各走一次,而不是塞进仓库层:
 * `session-repository.ts` 是产品层,事件落盘住在装配层,方向不能反过来。
 */
function recordSessionCreated(session: ChatSession): ChatSession {
	sessionLifecycleEvents.sessionCreated(session);
	return session;
}

/**
 * 会话归属的 space id —— **会话 → 空间**这条映射的唯一读法(批 B2 起)。
 *
 * 住在这里而不是接入目录模块里(批 B3 挪的):它是会话表的一条投影,与「接入目录」
 * 无关。凭证解析、账本归因、目录解析都要问同一句话,让凭证去 import 接入目录模块
 * 只会长出一条谁也解释不清的依赖。
 *
 * 会话不存在 / 缺 `workspaceId` / id 非法 → default。与 `countSessionsInWorkspace`、
 * 渲染层 `sessionBelongsToSpace` 同一句缺省,零迁移。
 */
export function resolveSessionSpaceId(sessionId: string | undefined | null): string {
	if (!sessionId) return DEFAULT_WORKSPACE_ID;
	const workspaceId = getSession(sessionId)?.workspaceId;
	return workspaceId && isValidSpaceId(workspaceId) ? workspaceId : DEFAULT_WORKSPACE_ID;
}

/**
 * 某个 space 里还有多少条会话(含归档)。删空间的「只删空的」判定唯一的依据。
 * 缺 workspaceId 的旧会话一律算在 default 名下 —— 与所有读取端同一句缺省。
 */
export function countSessionsInWorkspace(workspaceId: string): number {
	const target = workspaceId || DEFAULT_WORKSPACE_ID;
	let count = 0;
	for (const meta of sessionRepository.getSessionsList()) {
		if ((meta.workspaceId || DEFAULT_WORKSPACE_ID) === target) count++;
	}
	return count;
}

/**
 * 建会话但**不动** current-session 指针。
 *
 * `createSession` 会顺手把全局 current-session 指针挪到新会话上 —— 用户在界面上
 * 新建一条会话时这是对的,但幕后建的会话(agent 常驻执行会话、任务工作台、私聊房、
 * 程序化建群)一律不该抢走用户正在看的东西。在这条纪律被收进来之前,四处调用点
 * 各自手写了一遍「先记下指针 → createSession → 再写回去」的舞蹈,连注释都是互相
 * 抄的;其中一处还漏了 `previous !== sessionId` 这个条件。
 *
 * 指针的读写都在这一层,所以"还原"是逐字还原:先前是空字符串就还原成空字符串,
 * 而不是留着新会话的 id。
 */
export function createSessionWithoutFocus(
	sessionId: string,
	name: string,
	options: SessionCreateOptions = {},
): ChatSession {
	sessionDeletion.reopen(sessionId)
	const previousSessionId = getCurrentSessionId();
	const session = recordSessionCreated(
		sessionRepository.createSession(sessionId, name, options),
	);
	if (previousSessionId !== sessionId) setCurrentSessionId(previousSessionId);
	return session;
}

/**
 * Collab (multi-agent room) session fields — docs/design/multi-agent-collab.md.
 * `undefined` leaves a field untouched, `null` deletes it.
 */
export function updateSessionCollab(
	sessionId: string,
	fields: {
		kind?: ChatSession["kind"] | null;
		room?: ChatSession["room"] | null;
		collab?: ChatSession["collab"] | null;
	},
): boolean {
	return sessionRepository.updateSessionCollab(sessionId, fields);
}

/**
 * 派工戳(`docs/audit/self-hosting-gap-audit-2026-08-11.md` P0-3)。
 * `null` 删除;写完会话与元数据两处(仓库层保证)。
 */
export function updateSessionTask(
	sessionId: string,
	task: ChatSession["task"] | null,
): boolean {
	return sessionRepository.updateSessionTask(sessionId, task);
}

// Create a branch session
export function createBranchSession(
	sessionId: string,
	name: string,
	parentSessionId: string,
	branchFromMessageId: string,
	inheritedMessages: ChatMessage[],
	options: { initialOwner?: SessionInitialOwner } = {},
): ChatSession {
	sessionDeletion.reopen(sessionId)
	return sessionRepository.createBranchSession(
		sessionId,
		name,
		parentSessionId,
		branchFromMessageId,
		inheritedMessages,
		options,
	);
}

// Delete session result type
export interface DeleteSessionResult {
	deletedIds: string[];
	parentSessionId?: string;
}

/**
 * Subsystems that own per-session state OUTSIDE the session file, notified
 * after a delete lands (P2-10).
 *
 * An observer seam rather than a direct call, because the dependency may only
 * point one way: this module is a store, and a store that imported the room
 * coordinator to clean up after it would invert the layering. Subsystems
 * register themselves at startup and are handed the ids that went away.
 */
type SessionsDeletedListener = (deletedSessionIds: readonly string[]) => void

const sessionsDeletedListeners = new Set<SessionsDeletedListener>()

export function onSessionsDeleted(listener: SessionsDeletedListener): () => void {
	sessionsDeletedListeners.add(listener);
	return () => {
		sessionsDeletedListeners.delete(listener);
	};
}

/** Removal is published after file deletion, using trusted pre-delete ownership. */
function announceSessionsDeleted(cascadedSessionIds: string[], owners: Map<string, SessionMeta>): void {
	if (!isEventSystemInitialized()) return;
	try {
		for (const deletedId of cascadedSessionIds) {
			const event = withSessionRemovalOwner({
				type: SESSION_EVENT_TYPES.SESSION_REMOVED,
				sessionId: deletedId,
				cascadedSessionIds,
			}, owners.get(deletedId) as SessionOwnershipRecord ?? {})
			void getEventBus().emit(deletedId, event as never).catch(error => {
				log.warn('session deleted event delivery failed', { sessionId: deletedId }, error)
			})
		}
	} catch (error) {
		log.warn("session deleted event not emitted", { cascadedSessionIds }, error);
	}
}

// Called only after the session layer seals all authorized writers.
export async function deleteSession(sessionId: string, expectedIds: readonly string[]): Promise<DeleteSessionResult> {
	const index = sessionRepository.getSessionsList()
	const ids = collectSessionCascadeDeleteIds(index, sessionId)
	if (ids.length !== expectedIds.length || ids.some(id => !expectedIds.includes(id))) {
		throw new Error('Session deletion targets changed')
	}
	sessionDeletion.assertSealed(ids)
	assertSessionEventLogIdle(ids)
	const owners = new Map(index.filter(meta => ids.includes(meta.id)).map(meta => [meta.id, { ...meta }]))
	const result = await sessionRepository.deleteSession(sessionId);
	// 会话目录整棵被 `rmSync(recursive)` 掉(events.jsonl 与 blobs/ 都在里面),
	// 所以这里只需要把进程内那三张表跟着摘掉 —— 留着的话,同 id 的新会话会接着
	// 旧的 seq 数下去,而盘上那份已经没了。
	for (const deletedId of result.deletedIds) {
		// 删除也是索引写点(条目整条没了)—— 受众的备忘要跟着摘掉那一格。
		notifySessionIndexChanged(deletedId);
		resetSessionEventLogCache(deletedId);
		resetSessionSurfaceCache(deletedId);
		resetSessionRuns(deletedId);
		// 目录外的轨迹已由同一持久删除意图处理，重启恢复也遵守相同代际边界。
	}
	for (const listener of sessionsDeletedListeners) {
		try {
			listener(result.deletedIds);
		} catch (error) {
			log.error("session delete listener failed", { deletedIds: result.deletedIds }, error);
		}
	}
	announceSessionsDeleted(result.deletedIds, owners)
	return result;
}

// Rename a session (does not update updatedAt to avoid reordering)
//
// **回的是仓层那句「改到了没有」**(09-02:显式改名要发 `session:renamed`,发之前
// 得先知道这一改到底落没落盘)。仓里那条布尔只有一个含义 —— `applied: false`
// ⟺ 查无此会话(`core/session/store-helpers.ts` 的
// `applySessionMetadataMutationWithAdapters`:拿不到 session 就直接回 false,
// 别的分支一条都不产生 false),所以它不是「成功/失败」而是「这条会话在不在」。
// 从前这里把它吞了,于是改一条不存在的会话也一路回 success —— 再往总线上推一条
// 改名,别的客户端就会显示一个不存在的名字。
//
// 现存调用方没有一个读返回值(collab 三处建房/改房、engine 的 store 端口、
// headless backend、CLI daemon 都是语句调用),所以这一改对它们零影响。
export function renameSession(sessionId: string, newName: string): boolean {
	return sessionRepository.renameSession(sessionId, newName);
}

// Update session pin status (does not affect sort order)
export function updateSessionPin(sessionId: string, isPinned: boolean): void {
	sessionRepository.updateSessionPin(sessionId, isPinned);
}

// Update session archived status (does not affect sort order)
export function updateSessionArchived(
	sessionId: string,
	isArchived: boolean,
	archivedAt?: number | null,
): void {
	sessionRepository.updateSessionArchived(sessionId, isArchived, archivedAt);
}

// Update session working directory (does not affect sort order)
export function updateSessionPermissionMode(
	sessionId: string,
	permissionMode: ChatSession["permissionMode"],
): boolean {
	return sessionRepository.updateSessionPermissionMode(
		sessionId,
		permissionMode,
	);
}

export function updateSessionWorkingDirectory(
	sessionId: string,
	workingDirectory: string | null,
): void {
	sessionRepository.updateSessionWorkingDirectory(sessionId, workingDirectory);
	sessionWorkdirCache.set(sessionId, workingDirectory ?? "");
}

export function updateSessionWorkingDirectoryRoots(
	sessionId: string,
	roots: string[],
): void {
	sessionRepository.updateSessionWorkingDirectoryRoots(sessionId, roots);
}

export function updateSessionVariables(
	sessionId: string,
	variables: ContextVariable[],
): void {
	sessionRepository.updateSessionVariables(sessionId, variables);
}

// Update session goal (does not affect sort order); null clears it
export function updateSessionGoal(sessionId: string, goal: SessionGoal | null): void {
	sessionRepository.updateSessionGoal(sessionId, goal);
}

// Write the goal history plus its derived current goal (see goal-system-v3)
export function updateSessionGoals(
	sessionId: string,
	goals: SessionGoal[],
	current: SessionGoal | null,
): void {
	sessionRepository.updateSessionGoals(sessionId, goals, current);
}

// Inherit working directory from workspace (does not update updatedAt)
export function inheritSessionWorkingDirectory(
	sessionId: string,
	workingDirectory: string,
): void {
	sessionRepository.inheritSessionWorkingDirectory(sessionId, workingDirectory);
	sessionWorkdirCache.set(sessionId, workingDirectory);
}

/**
 * 用量快照(§17.7.1 批 3)。
 *
 * 从前它是 `OnethingSessionMessageRuntime.getSessionTokenUsage` —— 那个类最后
 * 只剩这一个与命令无关的方法,9 个命令口随批 3 删干净之后整层退役,这一口就地
 * 落在仓库上(算法照旧是 core 的 `getSessionTokenUsageSnapshot`,一字未改)。
 */
function sessionTokenUsageSnapshot(sessionId: string): {
	totalInputTokens: number;
	totalOutputTokens: number;
	totalTokens: number;
	lastInputTokens: number;
	contextSize: number;
} | null {
	// 工单 6 ②a:五格住在会话壳上,**问壳不问消息**。走 `getSession()` 的那个版本
	// 为了这五个数把整份账本读两遍、折一遍、把 400 条消息物化一遍(真店夹具
	// 53MB 上 835ms),而 core 是单线程的 —— 首屏那一页就排在它后面。
	const usage = sessionRepository.getSessionUsageFields(sessionId);
	return usage ? getSessionTokenUsageSnapshot(usage) : null;
}

// Update session token usage (does not affect sort order)
export function updateSessionTokenUsage(
	sessionId: string,
	usage: { inputTokens: number; outputTokens: number; totalTokens: number },
	lastTurnUsage?: { inputTokens: number; outputTokens: number },
): void {
	const before = sessionTokenUsageSnapshot(sessionId);
	sessionRepository.updateSessionTokenUsage(sessionId, usage, lastTurnUsage);
	const after = sessionTokenUsageSnapshot(sessionId);
	log.debug("session token usage updated", {
		sessionId,
		source: "stream-final-usage",
		usageInputTokens: usage.inputTokens,
		usageOutputTokens: usage.outputTokens,
		usageTotalTokens: usage.totalTokens,
		lastTurnInputTokens: lastTurnUsage?.inputTokens,
		lastTurnOutputTokens: lastTurnUsage?.outputTokens,
		beforeContextSize: before?.contextSize,
		beforeLastInputTokens: before?.lastInputTokens,
		afterContextSize: after?.contextSize,
		afterLastInputTokens: after?.lastInputTokens,
		afterTotalInputTokens: after?.totalInputTokens,
		afterTotalTokens: after?.totalTokens,
	});
}

/**
 * **按账落格**(§17.7 #15 裁定 1)。产地是会话账折叠,这里只是搬运到容器。
 */
export function landSessionAccountUsage(
  sessionId: string,
  snapshot: {
    totalInputTokens: number
    totalOutputTokens: number
    totalTokens: number
    contextSize?: number
    lastInputTokens?: number
  },
): boolean {
  return sessionRepository.landSessionAccountUsage(sessionId, snapshot);
}

export function updateSessionContextSize(
	sessionId: string,
	contextSize: number,
	source = "direct",
): boolean {
	const before = sessionTokenUsageSnapshot(sessionId);
	const updated = sessionRepository.updateSessionContextSize(
		sessionId,
		contextSize,
	);
	const after = sessionTokenUsageSnapshot(sessionId);
	log.debug("session context size updated", {
		sessionId,
		source,
		contextSize,
		updated,
		beforeContextSize: before?.contextSize,
		beforeLastInputTokens: before?.lastInputTokens,
		afterContextSize: after?.contextSize,
		afterLastInputTokens: after?.lastInputTokens,
	});
	return updated;
}

export function updateSessionPromptContext(
	sessionId: string,
	promptContext: PromptContextState | null,
): boolean {
	return sessionRepository.updateSessionPromptContext(sessionId, promptContext);
}

// Get session token usage
export function getSessionTokenUsage(sessionId: string): {
	totalInputTokens: number;
	totalOutputTokens: number;
	totalTokens: number;
	lastInputTokens: number;
	contextSize: number;
} | null {
	return sessionTokenUsageSnapshot(sessionId);
}

/**
 * Collab persona attribution (docs/design/multi-agent-collab.md D3): assistant
 * messages in room/work sessions get the speaking agent stamped at this single
 * choke point — every engine creation site (send / edit / retry / mid-turn
 * follow-up writer) persists through here, so no core change is needed.
 */
function stampCollabAgentId(sessionId: string, message: ChatMessage): ChatMessage {
	if (message.role !== "assistant" || message.agentId) return message;
	const session = sessionRepository.getSession(sessionId);
	if (
		!session ||
		(session.kind !== "room" &&
			session.kind !== "work" &&
			session.kind !== "agent")
	)
		return message;
	// P0.1:盖章改为**返回新对象**(COW),不再就地改调用方手里的那条 ——
	// 命令面的口径是"消息对象一旦交出去就不许再改"。
	// P0.4:新对象也一次性建成(不再先建后逐字段改)—— 命令面之外任何对
	// `ChatMessage` 的字段赋值都是 `session:check` 规则 B 的红。

	/**
	 * W14b 思考与发言分离: in a ROOM the turn's own assistant message is the
	 * agent's THINKING record, never its speech — speech is a `say` call, which
	 * writes its own message with an agentId already on it and therefore never
	 * reaches this branch.
	 *
	 * Stamped at CREATION rather than at the coordinator's turn finale (which is
	 * where the工单 put it) for two reasons the finale cannot give:
	 *   1. no flash — the marker exists before the message can ever render, so
	 *      the room never paints a full bubble that collapses to a hairline a
	 *      tick later;
	 *   2. crash-safe — a process that dies mid-turn leaves a record that still
	 *      reads as thinking instead of impersonating an utterance nobody made.
	 * Everything downstream keys off the marker (projection / chain / render),
	 * so the epoch judgement is identical either way.
	 *
	 * The marker rides the message's own `source`, not `origin.source`: an
	 * assistant message has no MessageOrigin to speak of (that type is the
	 * inbound-channel envelope, transport + receivedAt required) and the sibling
	 * markers on this exact axis — COLLAB_HARVEST_SOURCE, COLLAB_SAY_SOURCE —
	 * already live there. Every predicate reads both fields, so a message
	 * stamped either way judges the same.
	 *
	 * The origin guard tolerates COLLAB_MESSAGE_SOURCE ('collab'): the engine
	 * copies the DRIVE's channel envelope onto the reply it creates, so every
	 * production room turn arrives as origin.source='collab' — that is inbound
	 * routing, not an utterance epoch, and treating it as one left the whole
	 * turn rendering as legacy speech (真机实锤 2026-07-28: src=None 满屏).
	 * Only real epoch markers (say/harvest) block the stamp.
	 *
	 * W18 moved the turn into the agent's own execution session, and the marker
	 * moved with it: the whole session is an execution record, and the harvest
	 * reads this marker to tell a thinking record from legacy speech. Rooms
	 * keep the branch for pre-W18 transcripts (and for any path that still
	 * creates an assistant message there).
	 */
	const stampTurnSource =
		(session.kind === "room" || session.kind === "agent") &&
		!message.source &&
		(!message.origin?.source || message.origin.source === COLLAB_MESSAGE_SOURCE);

	return {
		...message,
		...(session.agentId ? { agentId: session.agentId } : {}),
		...(stampTurnSource ? { source: COLLAB_TURN_SOURCE } : {}),
	};
}

/*
 * `getSessionMessageCommandRuntime` —— **已删除**(§17.7.1 批 3)。
 *
 * 它是命令面的执行体接线口(`OnethingSessionMessageRuntime`)。那一层从 P0.1 起
 * 做的三件事 —— 跑归约器、按它的返回值落盘、盖索引元数据 —— 批 3 各归各家:
 * 会话账归事件折叠,落盘档与索引元数据归写门,消息数组早在 c4-d 归了折叠产物。
 * 命令面今天要的只有 `getSession` / `saveSessionForCommands` /
 * `updateSessionsIndexMetaForCommands` / `flushSessionSave` 四口。
 */

/**
 * 索引元数据的写门。命令面是它的第一个调用者,E2 的列表投影回填
 * (`session/list-projection-backfill.ts`)是第二个 —— 两者写的是同一批格,
 * 走同一扇门,所以"谁最后写的算数"这件事只有一处判据。
 */
export function updateSessionsIndexMetaForCommands(
	sessionId: string,
	update: (meta: { [key: string]: unknown }) => void,
): boolean {
	const applied = sessionRepository.updateSessionsIndexMeta(sessionId, (meta) =>
		update(meta as unknown as { [key: string]: unknown }),
	);
	notifySessionIndexChanged(sessionId);
	return applied;
}

/**
 * 命令面的落盘口(§17.7.1 批 3)。
 *
 * 归约器退役之前,"什么时候写、走哪一档"是 `applySessionCommand` 的返回值
 * (`result.lazy` / `result.writePlan`),由 `OnethingSessionMessageRuntime.run`
 * 转手交给仓库。归约器一死,那张表搬进了**写门**(`session/commands.ts`),
 * 这里只剩一条转发。
 *
 * **只转 `lazy`**:写计划自 S3w-3 批 6b 起在存储驱动里就没有读者了
 * (`storage-driver.ts` 的 `void plan`),仓库的缺省(structural)与从前逐字等效。
 */
export function saveSessionForCommands(
	sessionId: string,
	session: ChatSession,
	options?: { lazy?: boolean },
): void {
	sessionRepository.saveSessionToFile(sessionId, session, options);
}

/**
 * 读一条会话的原始 jsonl 抄本(逐行文本)。collab 的两处绕过驱动直接 `readFileSync`
 * 的读法(history-tool / actors/migrate)在 P0.2 迁到这里 —— 路径拼接只有一处。
 * legacy 整份 JSON 的会话没有这个文件,返回 undefined 让调用方退回。
 */
export function readSessionTranscriptFile(sessionId: string): string | undefined {
	try {
		const file = join(getOnethingSessionsDir(), sessionId, "messages.jsonl");
		if (!existsSync(file)) return undefined;
		return readFileSync(file, "utf-8");
	} catch {
		return undefined;
	}
}

export { stampCollabAgentId };

/**
 * ## F4-c c4-d(§16.27):**15 个热写端口整批空转**
 *
 * 从这一批起,内存 store 的消息数组由**折叠产物**维护(仓库的
 * `refreshMessagesFromProjection` 是全仓唯一的换装点)。于是这些端口往数组里写的
 * 那一笔**没有读者**:下一次 `getSession` 就把它换掉了。留着写不是"保险",是
 * 第二个维护者 —— 而两个维护者正是 c3/c4 一路查下来所有分岔的病根。
 *
 * 每一口的事实在账本上都有产地(§16.23 的 18 端口分类表,A/B/D 三类):
 * 正文与推理是逻辑 delta(c3-a 盖章即折)、工具三口是 `tool/call|result|annotate`、
 * 用量是 `request/response.usage`、技能是 `skill/activated`、错误是 `run/end.error`、
 * 回合上下文是 `context/turn-update`、`isStreaming` 由 `run/start`/`run/end` 开闭推导。
 *
 * **端口本身不删**:它们的签名是 core 引擎注入的 store 端口(P0 §6 冻结),
 * 删签名是一次跨包的接口改动,与本批无关。空转之后它们只回答一个问题 ——
 * **"这条消息在不在"**(RPC 面靠这个布尔回 `success`;`image-stream` 那两处靠它
 * 判"写进去了没有")。
 *
 * `updateMessageStreaming` 一并空转:§16.23 第五节判它"今天翻不得",理由是
 * **恒等门会当场红**(store 摘掉这一格而折叠侧的 run 还没闭)。恒等门 c4 已经
 * 退役(§16.24),而"读改物化"正是那一节写的解除条件 —— 本批两件同批落地。
 */
function portTargetExists(sessionId: string, messageId: string): boolean {
	// 有活投影就问它(O(1),不物化);没有就退回内存 store 那一份 —— 与
	// `materializeSessionMessages` 的边界同源:没有活投影时消息数组仍归仓库。
	// **不主动建活投影**:建表要同步读整份文件,这一口挂在逐 token 的热路径上。
	if (hasLiveSessionProjection(sessionId)) {
		return eventsHasMessage(sessionId, messageId);
	}
	return (
		sessionRepository
			.getSessionMessages(sessionId)
			?.some((message) => message.id === messageId) ?? false
	);
}

// Update message content (for streaming, does not affect sort order)
export function updateMessageContent(
	sessionId: string,
	messageId: string,
	_newContent: string,
): boolean {
	// **c4-d 起空转**(见 `portTargetExists` 上面那段)。产地 = `assistant/chunks`
	// 的逻辑 delta(c3-a 盖章即折);生图 / 压缩那三条非 provider 正文各有自己的
	// 产地(`assistant/part-end{contentOnly}` / `session/compacted`)。
	return portTargetExists(sessionId, messageId);
}

// Update message reasoning (for streaming, does not affect sort order)
export function updateMessageReasoning(
	sessionId: string,
	messageId: string,
	_reasoning: string,
): boolean {
	// **c4-d 起空转**。产地同 `updateMessageContent`(reasoning kind 的逻辑 delta)。
	return portTargetExists(sessionId, messageId);
}

// Update message streaming status (does not affect sort order)
export function updateMessageStreaming(
	sessionId: string,
	messageId: string,
	_isStreaming: boolean,
): boolean {
	// **c4-d 起空转**。`isStreaming` 由 run 开闭推导(`chat-messages.ts` 的
	// `...(node.ended ? {} : { isStreaming: true })`),不是一格独立事实 ——
	// c4-b 的钥匙② 已经把最后一个把它当寻址索引的消费者(停止按钮)换掉了。
	return portTargetExists(sessionId, messageId);
}

/**
 * Update message usage (does not affect sort order).
 *
 * **A 类端口**(§16.23 分类表 #15):这一格的事实早就在流上 ——
 * `request/response.usage` 逐轮落账,投影 reducer 求和折进 `node.usage`
 * (`reducer.ts:529`)。这里写的是**同一个事实的第二个落点**(活 run 写手视图
 * 上那一条),F4-c c4 给它挂上逐格断言:两侧此刻不等 = 事实与写路分岔,
 * 当场记一行(口径与边界全文见 `port-fact-assert.ts`)。
 */
export function updateMessageUsage(
	sessionId: string,
	messageId: string,
	usage: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		reasoningTokens?: number;
	},
): boolean {
	assertPortFactIsFolded(sessionId, messageId, 'usage', usage);
	// **c4-d 起空转**(断言留任:它比的是"端口手里的事实 ≡ 折叠值")。
	return portTargetExists(sessionId, messageId);
}

// Update message tool calls (does not affect sort order)
export function updateMessageToolCalls(
	sessionId: string,
	messageId: string,
	_toolCalls: ToolCall[],
): boolean {
	// **c4-d 起空转**。产地 = `tool/call` / `tool/result` / `tool/annotate`;
	// 参数流是 `tool-input` kind 的 delta 段。
	return portTargetExists(sessionId, messageId);
}

// Update message content parts (does not affect sort order)
export function updateMessageContentParts(
	sessionId: string,
	messageId: string,
	_contentParts: ChatMessage["contentParts"],
): boolean {
	// **c4-d 起空转**。产地 = `assistant/part-end` + parts 物化。
	return portTargetExists(sessionId, messageId);
}

// Add a single content part to message (does not affect sort order)
export function addMessageContentPart(
	sessionId: string,
	messageId: string,
	part: ContentPart,
): boolean {
	// §13.6 第 9 条:这一格在事件账本上有落点吗?开发/测试期当场抛,生产期 warn。
	// 引擎的 `persistTurnContentParts` 走的是这条路(不是命令面),所以守卫必须
	// 也站在这里 —— 两个调用点,一个判定函数。
	assertContentPartIsCarriable(sessionId, part)
	// **c4-d 起空转**(守卫留任:它问的是"这一格在账本上有没有落点")。
	return portTargetExists(sessionId, messageId);
}

/**
 * Update message thinking time —— **F4-c c4 起空转**(§16.24,用户裁定
 * "thinkingTime 取投影值")。
 *
 * 这一格从来不是引擎的事实,是**渲染层的回写**:`MessageList.vue` 算完那段
 * "思考了几秒"再经 `chat` 域写回来(全仓唯一的生产写者)。而账本上它早就有
 * 产地 —— 投影的 `deriveThinkingTime` 从 `assistant/chunks` 的时刻算出同一个数
 * (`chat-messages.ts`),判据侧 `canonicalChatMessage` 更是把它列进
 * `ALWAYS_DROPPED_KEYS`:两条推导谁也没在对账,写回来的那一份只是覆盖了一个
 * 本来就折得出来的值。
 *
 * 于是这一口的实现只剩"这条消息在不在"—— RPC 面靠这个布尔回 `success`,渲染层
 * 一行没改。**不再写 store,也不再产生 `message/patched`**:一格由 fold 推导的
 * 派生态,多一个产地就是多一次分岔的机会(§16.23 第五节钉的同族判例)。
 *
 * 端口本身留着而不是删掉:`chatRouter.updateMessageThinkingTime` 是 `@shared/ipc`
 * 上的契约,删它是一次传输面改动,与本批无关。
 */
export function updateMessageThinkingTime(
	sessionId: string,
	messageId: string,
	_thinkingTime: number,
): boolean {
	return (
		sessionRepository
			.getSessionMessages(sessionId)
			?.some((message) => message.id === messageId) ?? false
	);
}

/**
 * Update message skill used (does not affect sort order).
 *
 * **A 类端口**(§16.23 分类表 #9):产地是 `skill/activated`,折叠落点
 * `run.skillUsed`(`reducer.ts:694`)。挂逐格断言,理由同 `updateMessageUsage`。
 */
export function updateMessageSkill(
	sessionId: string,
	messageId: string,
	skillUsed: string,
): boolean {
	assertPortFactIsFolded(sessionId, messageId, 'skillUsed', skillUsed);
	// **c4-d 起空转**(断言留任)。
	return portTargetExists(sessionId, messageId);
}

/**
 * Update message error details (for API errors during streaming).
 *
 * **A 类端口**(§16.23 分类表 #10):产地是 `run/end.error`,折叠落点
 * `run.errorDetails`(`reducer.ts:513`)。挂逐格断言,理由同 `updateMessageUsage`。
 */
export function updateMessageError(
	sessionId: string,
	messageId: string,
	errorDetails: string,
): boolean {
	assertPortFactIsFolded(sessionId, messageId, 'errorDetails', errorDetails);
	// **c4-d 起空转**(断言留任)。
	return portTargetExists(sessionId, messageId);
}

/*
 * `updateMessageReactions` / `updateMessageReplyTo` / `updateMessageMentions`
 * —— **已删除**(F4-c c4,§16.24)。
 *
 * 三条 IM 元数据写路(W8 表情 / W13.2 引用快照 / W14a @身份)早在 P0.2 就整体迁到
 * 命令面的 `patchMessage` 上了(`wiring/collab/` 那三处协调器);c3-a 的 18 端口
 * 全量分类(§16.23 第二节)量明它们**生产上一次都不调**,只剩三只测试的 mock 还
 * 认得这三个名字——而那三只测试的注释白纸黑字写着"迁移前这条写走
 * `store.updateMessageXxx`;命令面上它是一次普通 patch"。
 *
 * 删除是纯减法:不需要任何新产地(命令面的 `message/patched` 就是它们的产地),
 * 也不改变任何一条 IM 写路的行为。
 */

/**
 * Persist the turn-context delta on a user message (prompt-channels
 * 2026-08-18). Written once per turn by `SessionTurnContext`; does not affect
 * sort order.
 *
 * **A 类端口**(§16.23 分类表 #14):产地是 `context/turn-update`,折叠落点
 * `node.turnContext`(`reducer.ts:684`)。挂逐格断言,理由同 `updateMessageUsage`。
 */
export function updateMessageTurnContext(
	sessionId: string,
	messageId: string,
	turnContext: NonNullable<ChatMessage["turnContext"]>,
): boolean {
	assertPortFactIsFolded(sessionId, messageId, 'turnContext', turnContext);
	// **c4-d 起空转**(断言留任)。
	return portTargetExists(sessionId, messageId);
}

// Add a step to a message (does not affect sort order)
export function addMessageStep(
	sessionId: string,
	messageId: string,
	_step: Step,
): boolean {
	// **c4-d 起空转**。产地 = `tool/call` → `materializeSteps`。
	return portTargetExists(sessionId, messageId);
}

// Update a step in a message (does not affect sort order)
// Searches recursively in childSteps
export function updateMessageStep(
	sessionId: string,
	messageId: string,
	_stepId: string,
	_updates: Partial<Step>,
): boolean {
	// **c4-d 起空转**。产地 = `tool/call` / `tool/result` / `tool/annotate`。
	return portTargetExists(sessionId, messageId);
}

export function updateMessageSteps(
	sessionId: string,
	messageId: string,
	_steps: Step[] | undefined,
): boolean {
	// **c4-d 起空转**。产地同 `updateMessageStep`。
	return portTargetExists(sessionId, messageId);
}

// Update usage for all steps in a specific turn (does not affect sort order)
export function updateStepsUsageByTurn(
	sessionId: string,
	messageId: string,
	_turnIndex: number,
	_usage: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		reasoningTokens?: number;
	},
): string[] {
	// **c4-d 起空转**。产地 = `request/response.usageTurnIndex` → `run.usageByTurn`
	// → `steps[].usage`(§13.9)。返回值(改到了哪几个 step)全仓零消费者。
	void sessionId;
	void messageId;
	return [];
}

// Update session summary (for context compacting)
export function updateSessionSummary(
	sessionId: string,
	summary: string,
	summaryUpToMessageId: string,
): boolean {
	return sessionRepository.updateSessionSummary(
		sessionId,
		summary,
		summaryUpToMessageId,
	);
}

/**
 * 换模型(模型选择器 / agent 绑定)。
 *
 * **§17.7.1 批 2:这条路也绕开命令面,而且从前一条事件都不写** —— 与
 * `updateSessionAgent` 同一个病(§13.10 M7 当年只补了 agent 那一格)。会话账
 * 上的 `lastProvider` / `lastModel` 因此有两个写者:归约器(追加助手消息时盖)
 * 与这里(用户挑模型),而只有前者在账本上有产地。批 2 的影子对拍当场把它照
 * 出来了:一条"只挑了模型还没开跑"的会话上,容器有这两格、折叠没有(真机
 * battery 16/40 条失配)。
 *
 * 修的是**产地**不是门(纪律 11):补一条 `session/model-changed`,用的就是
 * `updateSessionAgent` 那条路数与**同一份**事件构造(`sessionCommandEvents.
 * patchSession` 认的正是 agent / model+provider / workdir 这同一张表)。写成功
 * 之后再记、`to` 取落库之后那一格,理由与 agent 那一处逐字相同。用户可感知的
 * 行为一格未变:只多了一行账。
 */
export function updateSessionModel(
	sessionId: string,
	provider: string,
	model: string,
	options: { pinned?: boolean } = {},
): boolean {
	const before = getSession(sessionId);
	const beforeModel = before?.lastModel;
	const beforeProvider = before?.lastProvider;
	const changed = sessionRepository.updateSessionModel(sessionId, provider, model, options);
	if (!changed) return changed;
	const after = getSession(sessionId);
	if (after?.lastModel !== undefined && after.lastModel !== beforeModel) {
		sessionCommandEvents.patchSession(
			sessionId,
			{
				lastModel: after.lastModel,
				...(after.lastProvider !== undefined ? { lastProvider: after.lastProvider } : {}),
			},
			{
				...(beforeModel !== undefined ? { lastModel: beforeModel } : {}),
				...(beforeProvider !== undefined ? { lastProvider: beforeProvider } : {}),
			},
		);
	}
	return changed;
}

/**
 * 换 agent。
 *
 * §13.10 M7:这条路**绕开了命令面**(它走的是仓库的 `applyMetadataMutation`,
 * 因为 agent 那一格还带着"空值回落默认 agent"的规范化),于是从前账本上一条
 * `session/agent-changed` 都没有 —— `run/start.agentId` 只记得每次执行**当时**
 * 挂在谁名下,投影既归因不了过去的 run,也说不出切换发生过。
 *
 * 翻译照旧排在写成功之后(翻译器的纪律 1),而 `to` 取的是**落库之后**那一格:
 * 规范化(空 → 默认 agent)发生在仓库里,记入参就会记下一个没存进去的值。
 */
export function updateSessionAgent(
	sessionId: string,
	agentId: string,
): boolean {
	const before = getSession(sessionId)?.agentId;
	const changed = sessionRepository.updateSessionAgent(sessionId, agentId);
	if (!changed) return false;
	const after = getSession(sessionId)?.agentId;
	if (after !== undefined && after !== before) {
		sessionCommandEvents.patchSession(
			sessionId,
			{ agentId: after },
			before !== undefined ? { agentId: before } : undefined,
		);
	}
	return changed;
}
