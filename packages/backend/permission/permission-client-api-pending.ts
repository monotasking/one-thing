/**
 * HTTP 服务器那一侧的待答权限账与应答面(权限第二入口的一个方面,决策 D26)。
 *
 * 三件事:
 *
 *  - **授权账页存储**:server 自己当 core 进程时(`processPorts: 'own'`),把授权账页放到
 *    `<dataRoot>/permissions`(`configureServerPermissionGrantStorage`)。嵌在宿主里时不碰 ——
 *    桌面已经按它自己的口径配过了。
 *  - **待答账**:从总线上的 `permission:request` / `timeout` / `settled` 记下还没人答的询问
 *    (`track`,挂在会话工作集那条 `ServerRuntimeStore` 订阅上)。
 *  - **应答**:`POST /api/permissions/:id/respond` 背后的那一格(`port.respond`):校验归属与
 *    应答形状,采用询问时记下的目标通道,把 `command:permission-respond` 发回总线。
 *
 * 2026-10-04 从 `http-server/http-server-runtime.ts` 原样搬来(决策 D219),代码一行没改。
 */
import {
	addGrant,
	configureOnethingPermissionGrantStorage,
} from "@onething/backend/permission";
import type { OnethingPermissionGrantStorageAdapters } from "@onething/backend/permission";
import type { AgentEngineSessionEvent } from "@onething/backend/agent";
import { type JsonObject } from "@shared/json";
import { sessionOwnerOf as sessionOwner } from "@onething/backend/http-server/http-server-audience.js";
import { defaultRequestContext } from "@onething/backend/http-server/http-server-tenant-paths.js";
import type { RuntimePermissionsAdapter, RuntimeRequestContext } from "@onething/backend/http-server/http-server-runtime-facade.js";
import type {
	PermissionInfo,
	PermissionResponse,
} from "@shared/ipc/permissions.js";
import { SESSION_EVENT_TYPES, SESSION_COMMAND_TYPES } from "@shared/events/index.js";
import { join } from "node:path";

/** 待答账要从一条会话上读的那几格:工作目录与租户归属(`sessionOwnerOf` 读的那几格)。 */
type PermissionSessionRef = Parameters<typeof sessionOwner>[0] & { workingDirectory?: string };

type PendingPermissionRecord = { sessionId: string; info: PermissionInfo };

/** 搬家前 server runtime 自己那对 JSON 读写(缺文件 = 缺省值;写 = pretty + 换行)。 */
export interface ServerPermissionJsonFiles {
	readJsonFile<T>(filePath: string, defaultValue: T): T;
	writeJsonFile<T>(filePath: string, data: T): void;
}

/**
 * 嵌在宿主里时不碰这个端口:桌面已经按它自己的口径配过了,再配一次等于把
 * 桌面的授权账页搬到另一个目录(dataRoot 与 store 不一定同一处)。调用方只在
 * `processPorts: 'own'` 时调它。
 */
export function configureServerPermissionGrantStorage(
	dataRoot: string,
	files: ServerPermissionJsonFiles,
): void {
	const permissionGrantStorageAdapters: OnethingPermissionGrantStorageAdapters = {
		getPermissionsDir: () => join(dataRoot, "permissions"),
		readJsonFile: files.readJsonFile,
		writeJsonFile: files.writeJsonFile,
	}
	configureOnethingPermissionGrantStorage(permissionGrantStorageAdapters);
}

export interface ServerPendingPermissionsPorts {
	/** 只读 `persistsMessages` 一格,每次现读。 */
	backend: { readonly persistsMessages: boolean };
	eventBus: { emit(sessionId: string, event: AgentEngineSessionEvent): Promise<unknown> };
	/** 不判归属地取会话(总线事件来时用;真引擎的会话从不进回声工作集)。 */
	resolveSession(sessionId: string): PermissionSessionRef | undefined;
	/** 按请求上下文取会话(应答时判归属)。 */
	getSessionForContext(sessionId: string, context?: RuntimeRequestContext): PermissionSessionRef | undefined;
}

export function createServerPendingPermissions(ports: ServerPendingPermissionsPorts) {
	const { backend, eventBus, resolveSession, getSessionForContext } = ports;
	const pendingPermissions = new Map<string, PendingPermissionRecord>();

	/** 挂在 `ServerRuntimeStore` 订阅上:记下 / 划掉待答的询问。 */
	const track = (envelope: { sessionId: string; event: unknown }): void => {
		const permissionEvent = readPermissionTrackingEvent(envelope.event);
		if (permissionEvent?.type === SESSION_EVENT_TYPES.PERMISSION_REQUEST) {
			// Resolve through the store (not the echo working set): real-engine
			// sessions never enter the `sessions` map.
			const session = resolveSession(envelope.sessionId);
			const info = session
				? toPendingPermissionInfo(envelope.event, envelope.sessionId, session)
				: undefined;
			if (info)
				pendingPermissions.set(permissionEvent.requestId, {
					sessionId: envelope.sessionId,
					info,
				});
		} else if (
			permissionEvent?.type === SESSION_EVENT_TYPES.PERMISSION_TIMEOUT ||
			permissionEvent?.type === SESSION_EVENT_TYPES.PERMISSION_SETTLED
		) {
			pendingPermissions.delete(permissionEvent.requestId);
		}
	};

	const respondToPermission = async (
		requestId: string,
		response: unknown,
		context = defaultRequestContext(),
		expectedSessionId?: string,
	): Promise<{ success: boolean; error?: string }> => {
		const pending = pendingPermissions.get(requestId);
		if (!pending)
			return { success: false, error: "Permission request not found" };
		const sessionId = pending.sessionId;
		if (expectedSessionId && sessionId !== expectedSessionId) {
			return { success: false, error: "Permission request not found" };
		}

		const session = getSessionForContext(sessionId, context);
		if (!session) {
			return { success: false, error: "Permission request not found" };
		}

		const permissionResponse = normalizePermissionResponse(response);
		if (!permissionResponse)
			return { success: false, error: "Invalid permission response" };

		if (!backend.persistsMessages) {
			// Echo path only: with the real engine, core Permission.respond()
			// persists session/workspace grants itself — persisting here too
			// would double-write the grant store.
			persistPermissionGrantFromDecision(
				pending.info,
				permissionResponse.decision,
			);
		}
		pendingPermissions.delete(requestId);
		const command: Record<string, unknown> = {
			type: SESSION_COMMAND_TYPES.PERMISSION_RESPOND,
			// Adopt the ask's target channel (owner already authenticated at
			// the HTTP boundary); the normalized body channel is the fallback.
			channel: pending.info.targetChannel || permissionResponse.channel,
			requestId,
			decision: permissionResponse.decision,
		};
		if (permissionResponse.rejectReason)
			command.rejectReason = permissionResponse.rejectReason;
		await eventBus.emit(
			sessionId,
			command as unknown as AgentEngineSessionEvent,
		);
		return { success: true };
	};

	const permissionsPort: RuntimePermissionsAdapter<unknown> = {
		async respond(requestId, response, context = defaultRequestContext()) {
			return respondToPermission(requestId, response, context);
		},
	};

	return { track, port: permissionsPort };
}

/**
 * 第四份手抄的联合已经退役 —— 这里直接用契约那一份(它自己与核逐字相同,由
 * `backend/permission/__tests__/permission-response-mirrors.test.ts` 编译期钉住)。
 */
type PermissionDecision = PermissionResponse;

interface NormalizedPermissionResponse {
	decision: PermissionDecision;
	channel: string;
	rejectReason?: string;
}

/**
 * 收得下哪几种应答。写成 `satisfies Record<PermissionDecision, true>` 而不是一个
 * 字面量数组:联合里多一支而这里忘了跟上,是**编译期**红,不是一条只在真机上
 * 才现形的「Invalid permission response」。
 */
const PERMISSION_DECISIONS = {
	once: true,
	session: true,
	workdir: true,
	/**
	 * 应用级许可(2026-09-10)。真引擎上由 core `Permission.respond` 落账 ——
	 * 只有当那次 ask 带着 `alwaysScope` 时它才是合法应答,否则内核结构化忽略。
	 * 下面那条回声路(假后端)不认识应用级许可,照旧只补 session / workdir 两档。
	 */
	always: true,
	reject: true,
	/**
	 * 「始终拒绝」(A3-a):只有 ask 带着 `choices` 且其中有这一格时内核才收(ACP agent 的
	 * reject_always),否则结构化忽略。回声路不认识它,当普通拒绝处理。
	 */
	"reject-always": true,
} satisfies Record<PermissionDecision, true>;

const permissionDecisions = new Set<PermissionDecision>(
	Object.keys(PERMISSION_DECISIONS) as PermissionDecision[],
);

function toPendingPermissionInfo(
	event: unknown,
	sessionId: string,
	session: PermissionSessionRef,
): PermissionInfo | null {
	if (!isRecord(event)) return null;
	if (typeof event.requestId !== "string") return null;
	if (typeof event.permissionType !== "string") return null;
	if (typeof event.messageId !== "string") return null;
	if (typeof event.title !== "string") return null;

	return {
		id: event.requestId,
		type: event.permissionType,
		pattern:
			typeof event.pattern === "string" || Array.isArray(event.pattern)
				? (event.pattern as string | string[])
				: undefined,
		sessionId,
		messageId: event.messageId,
		callId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
		title: event.title,
		metadata: isRecord(event.metadata) ? (event.metadata as JsonObject) : {},
		createdAt: Date.now(),
		targetChannel:
			typeof event.targetChannel === "string" ? event.targetChannel : "api",
		workingDirectory: session.workingDirectory,
		// 授权记录的归属被 `permission-grants` 域按**租户**过滤
		// (`permission/permission-client-api-grants.ts:72-73`),所以这里给的是租户两格,
		// 不是产品空间。
		userId: sessionOwner(session).userId,
		workspaceId: sessionOwner(session).workspaceId,
	};
}

function persistPermissionGrantFromDecision(
	info: PermissionInfo,
	decision: PermissionDecision,
): void {
	if (decision === "session") {
		addGrant({
			scope: "session",
			type: info.type,
			pattern: info.pattern ?? info.type,
			sessionId: info.sessionId,
			userId: info.userId,
			workspaceId: info.workspaceId,
			createdFrom: {
				messageId: info.messageId,
				toolCallId: info.callId,
				title: info.title,
			},
			metadata: info.metadata,
		});
	}

	if (decision === "workdir" && info.workingDirectory) {
		addGrant({
			scope: "workspace",
			type: info.type,
			pattern: info.pattern ?? info.type,
			workspaceRoot: info.workingDirectory,
			userId: info.userId,
			workspaceId: info.workspaceId,
			createdFrom: {
				messageId: info.messageId,
				toolCallId: info.callId,
				title: info.title,
			},
			metadata: info.metadata,
		});
	}
}

function readPermissionTrackingEvent(event: unknown): {
	type:
		| typeof SESSION_EVENT_TYPES.PERMISSION_REQUEST
		| typeof SESSION_EVENT_TYPES.PERMISSION_TIMEOUT
		| typeof SESSION_EVENT_TYPES.PERMISSION_SETTLED;
	requestId: string;
} | null {
	if (!event || typeof event !== "object") return null;
	const candidate = event as Record<string, unknown>;
	const type = candidate.type;
	if (
		type !== SESSION_EVENT_TYPES.PERMISSION_REQUEST &&
		type !== SESSION_EVENT_TYPES.PERMISSION_TIMEOUT &&
		type !== SESSION_EVENT_TYPES.PERMISSION_SETTLED
	)
		return null;
	return typeof candidate.requestId === "string"
		? { type, requestId: candidate.requestId }
		: null;
}

function normalizePermissionResponse(
	response: unknown,
): NormalizedPermissionResponse | null {
	const input =
		response && typeof response === "object"
			? (response as Record<string, unknown>)
			: { decision: response };
	const decision = input.decision;
	if (
		typeof decision !== "string" ||
		!permissionDecisions.has(decision as PermissionDecision)
	) {
		return null;
	}

	const channel =
		typeof input.channel === "string" && input.channel.trim()
			? input.channel.trim()
			: "api";
	const rejectReason =
		typeof input.rejectReason === "string" ? input.rejectReason : undefined;
	return {
		decision: decision as PermissionDecision,
		channel,
		rejectReason,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
