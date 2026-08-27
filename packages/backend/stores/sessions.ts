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
import { existsSync, readFileSync } from "node:fs";
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
import { sessionCommands } from "../session/commands.js";
import { resetSessionEventLogCache } from "../session/event-log.js";
import { resetSessionSurfaceCache } from "../session/event-surface.js";
import { resetSessionRuns } from "../session/runs.js";
import { hydrateSessionMessagesFromProjection } from "../session/hydrate.js";
import { getSettings } from "./settings.js";
import { expandPath } from "../wiring/tools/core/sandbox.js";
import {
	createHybridSessionStorageDriver,
	createOnethingSessionMessageRuntime,
	createOnethingSessionRepository,
	type OnethingSessionMessageRuntime,
} from "@onething/runtime/sessions";
import { COLLAB_MESSAGE_SOURCE, COLLAB_TURN_SOURCE } from "@onething/runtime/collab";
import { deleteSessionTraces } from "@onething/runtime/evals/trace-store";
import {
	DEFAULT_SPACE_ID as DEFAULT_WORKSPACE_ID,
	isValidSpaceId,
} from "@onething/runtime/spaces/types";
import {
	guardFrozenMessages,
	guardFrozenSessionMessages,
} from "../session/freeze.js";
import {
	CORE_DEFAULT_AGENT_ID as DEFAULT_AGENT_ID,
	deriveRetainedContextSize,
	repairSessionTimelineMetadata,
	sanitizeSessionOnStartup,
} from "@onething/core/session";
import { assertContentPartIsCarriable } from '../session/content-part-guard.js'
import { assertPortFactIsFolded } from '../session/port-fact-assert.js'
import { consolePort, getLogger } from '../wiring/logging/index.js'
import type { HybridSessionStorageDriverOptions } from '@onething/runtime/sessions/storage-driver'
import type { OnethingSessionRepositoryOptions, OnethingSessionRepositoryLogger } from '@onething/runtime/sessions/session-repository'
import type { OnethingSessionMessageRuntimeRepository } from '@onething/runtime/sessions/session-message-runtime'
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
let sessionMessageRuntime:
	| OnethingSessionMessageRuntime<
			ChatSession,
			ChatMessage,
			SessionMeta,
			Step,
			ContentPart,
			ToolCall
	  >
	| undefined;

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
	// S3w-1:冷加载补水源。F4-a 起**无条件**走投影(档位 `ONETHING_SESSION_HYDRATE`
	// 已退役);返回 undefined = 这条会话的事件里折不出历史,仓库照旧自己加载。
	hydrateMessagesFromProjection: hydrateSessionMessagesFromProjection,
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

const repositoryPort: OnethingSessionMessageRuntimeRepository<ChatSession, ChatMessage, SessionMeta> = {
	getSession: (sessionId) => sessionRepository.getSession(sessionId),
	getCachedSession: (sessionId) =>
		sessionRepository.getCachedSession(sessionId),
	getCachedSessionMessages: (sessionId) =>
		sessionRepository.getCachedSessionMessages(sessionId),
	saveSessionToFile: (sessionId, session, options) =>
		sessionRepository.saveSessionToFile(sessionId, session, options),
	syncSessionToSqliteIfReady: (session) =>
		sessionRepository.syncSessionToSqliteIfReady(session),
	updateSessionsIndexMeta: (sessionId, update) =>
		sessionRepository.updateSessionsIndexMeta(sessionId, update),
};
sessionMessageRuntime = createOnethingSessionMessageRuntime<
	ChatSession,
	ChatMessage,
	SessionMeta,
	Step,
	ContentPart,
	ToolCall
>({
	repository: repositoryPort,
	now: Date.now,
	logger: consoleLog,
});

function updateSessionsIndexMeta(
	sessionId: string,
	update: (meta: SessionMeta) => void,
): boolean {
	return sessionRepository.updateSessionsIndexMeta(sessionId, update);
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
	return sessionRepository.patchSession(sessionId, patch, mutateIndexMeta);
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
	options: { workspaceId?: string } = {},
): ChatSession {
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
	try {
		sessionLifecycleEvents.sessionCreated(session);
	} catch (error) {
		log.warn("session created event not recorded", { sessionId: session.id }, error);
	}
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
	options: { workspaceId?: string } = {},
): ChatSession {
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
): ChatSession {
	return sessionRepository.createBranchSession(
		sessionId,
		name,
		parentSessionId,
		branchFromMessageId,
		inheritedMessages,
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

// Delete a session and all its child sessions (cascade delete)
export function deleteSession(sessionId: string): DeleteSessionResult {
	const result = sessionRepository.deleteSession(sessionId);
	// 会话目录整棵被 `rmSync(recursive)` 掉(events.jsonl 与 blobs/ 都在里面),
	// 所以这里只需要把进程内那三张表跟着摘掉 —— 留着的话,同 id 的新会话会接着
	// 旧的 seq 数下去,而盘上那份已经没了。
	for (const deletedId of result.deletedIds) {
		resetSessionEventLogCache(deletedId);
		resetSessionSurfaceCache(deletedId);
		resetSessionRuns(deletedId);
		// 轮次轨迹住在会话目录**外面**(`evals/traces/<sessionId>/`),所以
		// `rmSync(sessions/<id>)` 收不掉它。环形淘汰只按年龄/体积赶人,永远不会
		// 因为「这个会话没了」而赶 —— 不在这里级联,删掉的会话会把轨迹永远留在盘上。
		deleteSessionTraces(deletedId);
	}
	for (const listener of sessionsDeletedListeners) {
		try {
			listener(result.deletedIds);
		} catch (error) {
			log.error("session delete listener failed", { deletedIds: result.deletedIds }, error);
		}
	}
	return result;
}

// Rename a session (does not update updatedAt to avoid reordering)
export function renameSession(sessionId: string, newName: string): void {
	sessionRepository.renameSession(sessionId, newName);
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

// Update session token usage (does not affect sort order)
export function updateSessionTokenUsage(
	sessionId: string,
	usage: { inputTokens: number; outputTokens: number; totalTokens: number },
	lastTurnUsage?: { inputTokens: number; outputTokens: number },
): void {
	const before = sessionMessageRuntime!.getSessionTokenUsage(sessionId);
	sessionRepository.updateSessionTokenUsage(sessionId, usage, lastTurnUsage);
	const after = sessionMessageRuntime!.getSessionTokenUsage(sessionId);
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

export function updateSessionContextSize(
	sessionId: string,
	contextSize: number,
	source = "direct",
): boolean {
	const before = sessionMessageRuntime!.getSessionTokenUsage(sessionId);
	const updated = sessionRepository.updateSessionContextSize(
		sessionId,
		contextSize,
	);
	const after = sessionMessageRuntime!.getSessionTokenUsage(sessionId);
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
	return sessionMessageRuntime!.getSessionTokenUsage(sessionId);
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

/**
 * P0.1 命令面接线口(docs/design/session-commands-p0-2026-08.md §2)。
 * `app/session/commands.ts` 用这三样把 `sessionCommands` 装起来 —— 装配方向是
 * 单向的(commands → stores),这里不反向 import,避免循环。
 */
export function getSessionMessageCommandRuntime(): OnethingSessionMessageRuntime<
	ChatSession,
	ChatMessage,
	SessionMeta,
	Step,
	ContentPart,
	ToolCall
> {
	return sessionMessageRuntime!;
}

export function updateSessionsIndexMetaForCommands(
	sessionId: string,
	update: (meta: { [key: string]: unknown }) => void,
): boolean {
	return sessionRepository.updateSessionsIndexMeta(sessionId, (meta) =>
		update(meta as unknown as { [key: string]: unknown }),
	);
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
 * Add a message to a session.
 *
 * S1a:这四条 store 端口(add / delete / truncate 两式)是 **core 引擎**写消息
 * 的入口 —— 它们与 `sessionCommands` 是同一件事的两个门牌(P0 §6 把端口形状
 * 冻住了,所以不能直接删)。事件翻译挂在 `sessionCommands` 上,于是这里改成
 * **转调命令面**:一条消息只可能从一扇门进出,账本才不会漏记引擎写的那半边
 * (真机脚本第一次跑出来的 events.jsonl 里没有 `user/message`,病根正是这条)。
 *
 * 语义逐字不变:`appendMessage{stampCollab:true}` 就是原来的
 * `stampCollabAgentId(...) → runtime.addMessage(...)`。
 *
 * **F4-a(§16.12):返回真正入库的那一条。** 盖章是 COW 的,所以调用方手里那条与
 * 入库那条是两个对象;从前"我刚写进去的是什么"只能事后回读一次(引擎入口拿它把
 * 助手占位的时刻 / origin 带进 `run/start`),而那次回读是一个可以不存在的时序
 * 窗口。core 那一侧的端口签名跟着改了一格 —— **P0 形状冻结的唯一指名豁免**
 * (§16.11 拍板 1 的注)。不盖章的会话原样返回入参,调用方不关心就当它是 void。
 */
export function addMessage(sessionId: string, message: ChatMessage): ChatMessage {
	return sessionCommands.appendMessage(sessionId, { message, stampCollab: true });
}

// Delete a message from a session
export function deleteMessage(sessionId: string, messageId: string): boolean {
	return sessionCommands.deleteMessage(sessionId, { messageId });
}

// Delete a message and all messages after it.
// Used when regenerating an earlier assistant response so later conversation is discarded.
export function deleteMessageAndTruncate(
	sessionId: string,
	messageId: string,
): boolean {
	return sessionCommands.truncateFrom(sessionId, { messageId, inclusive: true });
}

/*
 * `clearSessionMessages` —— **已删除**(F4-a,§16.12 / §16.11 拍板 5)。
 *
 * 它曾是群聊「清空聊天记录」的存储原语。P0.2 把那条路整体迁到命令面之后
 * (`sessionCommands.replaceAll{reason:'clear'}`,唯一调用点
 * `wiring/collab/room-config.ts`),这个函数就**零生产调用点**了 —— 批 6b 查明
 * 并记账,本批按拍板 5 删除。它的全部语义(整份日志换掉 → 索引计数归零 →
 * 强刷一次;`tokenUsage` 不动;不再留档)都在 `session/commands.ts` 的
 * `replaceAll` 里,那一条同时才是 `session/cleared` 的产地。
 */

// Update a message and remove all messages after it
// Returns true if successful, also subtracts token usage of deleted messages from session total
export function updateMessageAndTruncate(
	sessionId: string,
	messageId: string,
	newContent: string,
	options?: { contentParts?: ChatMessage["contentParts"] | null },
): boolean {
	return sessionCommands.truncateFrom(sessionId, {
		messageId,
		inclusive: false,
		newContent,
		...(options && Object.prototype.hasOwnProperty.call(options, "contentParts")
			? { contentParts: options.contentParts }
			: {}),
	});
}

// Update message content (for streaming, does not affect sort order)
export function updateMessageContent(
	sessionId: string,
	messageId: string,
	newContent: string,
): boolean {
	return sessionMessageRuntime!.updateMessageContent(
		sessionId,
		messageId,
		newContent,
	);
}

// Update message reasoning (for streaming, does not affect sort order)
export function updateMessageReasoning(
	sessionId: string,
	messageId: string,
	reasoning: string,
): boolean {
	return sessionMessageRuntime!.updateMessageReasoning(
		sessionId,
		messageId,
		reasoning,
	);
}

// Update message streaming status (does not affect sort order)
export function updateMessageStreaming(
	sessionId: string,
	messageId: string,
	isStreaming: boolean,
): boolean {
	return sessionMessageRuntime!.updateMessageStreaming(
		sessionId,
		messageId,
		isStreaming,
	);
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
	return sessionMessageRuntime!.updateMessageUsage(sessionId, messageId, usage);
}

// Update message tool calls (does not affect sort order)
export function updateMessageToolCalls(
	sessionId: string,
	messageId: string,
	toolCalls: ToolCall[],
): boolean {
	return sessionMessageRuntime!.updateMessageToolCalls(
		sessionId,
		messageId,
		toolCalls,
	);
}

// Update message content parts (does not affect sort order)
export function updateMessageContentParts(
	sessionId: string,
	messageId: string,
	contentParts: ChatMessage["contentParts"],
): boolean {
	return sessionMessageRuntime!.updateMessageContentParts(
		sessionId,
		messageId,
		contentParts,
	);
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
	return sessionMessageRuntime!.addMessageContentPart(
		sessionId,
		messageId,
		part,
	);
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
	return sessionMessageRuntime!.updateMessageSkill(
		sessionId,
		messageId,
		skillUsed,
	);
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
	return sessionMessageRuntime!.updateMessageError(
		sessionId,
		messageId,
		errorDetails,
	);
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
	return sessionMessageRuntime!.updateMessageTurnContext(
		sessionId,
		messageId,
		turnContext,
	);
}

// Add a step to a message (does not affect sort order)
export function addMessageStep(
	sessionId: string,
	messageId: string,
	step: Step,
): boolean {
	return sessionMessageRuntime!.addMessageStep(sessionId, messageId, step);
}

// Update a step in a message (does not affect sort order)
// Searches recursively in childSteps
export function updateMessageStep(
	sessionId: string,
	messageId: string,
	stepId: string,
	updates: Partial<Step>,
): boolean {
	return sessionMessageRuntime!.updateMessageStep(
		sessionId,
		messageId,
		stepId,
		updates,
	);
}

export function updateMessageSteps(
	sessionId: string,
	messageId: string,
	steps: Step[] | undefined,
): boolean {
	return sessionMessageRuntime!.updateMessageSteps(sessionId, messageId, steps);
}

// Update usage for all steps in a specific turn (does not affect sort order)
export function updateStepsUsageByTurn(
	sessionId: string,
	messageId: string,
	turnIndex: number,
	usage: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		reasoningTokens?: number;
	},
): string[] {
	return sessionMessageRuntime!.updateStepsUsageByTurn(
		sessionId,
		messageId,
		turnIndex,
		usage,
	);
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

export function updateSessionModel(
	sessionId: string,
	provider: string,
	model: string,
	options: { pinned?: boolean } = {},
): boolean {
	return sessionRepository.updateSessionModel(sessionId, provider, model, options);
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
