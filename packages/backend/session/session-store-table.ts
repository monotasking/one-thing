/**
 * 会话表持有器:会话门面(`session-store.ts`)与消息热写端口(`session-store-messages.ts`)共用的那一份仓储与日志,
 * 第一次有人要时才建,之后一直用同一份。
 *
 * 它从 `session-store.ts` 原样搬来(大文件拆分批 2,2026-10-04):消息热写端口要问「这条消息在不在」,读的是这份仓储;
 * 持有器留在门面里的话,端口文件就得回头引门面、门面又要转交端口,成了一对兄弟环。持有器是 `const`,搬家不改变
 * 「整个进程共一份、首次用到时才建」这件事。
 */
import type {
	ChatMessage,
	ChatSession,
	SessionMeta,
	SessionDetails,
	UserMessageMarker,
} from "@shared/ipc.js";
import { getCurrentBackend } from '@onething/backend/backend-current.js'
import {
	getOnethingSessionsDir,
	getOnethingSessionPath,
	readJsonFile,
	writeJsonFile,
	writeJsonFileAsync,
	deleteJsonFile,
} from '@onething/backend/storage';
import { getCurrentSessionId, setCurrentSessionId } from "./session-current.js";
import { hydrateSessionMessagesFromProjection } from "./session-hydrate.js";
import { materializeSessionMessages } from "./session-materialized-messages.js";
import { getSettings } from "@onething/backend/settings";
import { expandOnethingToolSandboxPath as expandPath } from '@onething/backend/tool';
import { createHybridSessionStorageDriver } from './session-storage-driver.js'
import { createOnethingSessionRepository } from './session-repository.js'
import { CORE_DEFAULT_AGENT_ID as DEFAULT_AGENT_ID } from './session-meta.js'
import { consolePort, getLogger } from '@onething/backend/logging'
import type { HybridSessionStorageDriverOptions } from './session-storage-driver.js'
import type {
  OnethingSessionRepository,
  OnethingSessionRepositoryOptions,
  OnethingSessionRepositoryLogger,
} from './session-repository.js'
import type { ConsoleLikePort, Logger } from '@onething/backend/logging'

// ============ 异步节流落盘 ============
// Streaming updates (每个 token) 会频繁触发 updateMessageContent 等写入,
// 同步 writeFileSync 会阻塞事件循环并拖慢流式节奏。
// 策略:更新内存缓存后,用 300ms 节流把脏 session 异步写盘。
// 同一 session 的多次写入在 promise 链上串行化,避免旧异步写盖新数据。
// 关键生命周期(finalize / delete / 应用退出)会强制 flush。
// 会话体是大文件且只被程序读取,紧凑序列化;index.json 等仍走 pretty 的 writeJsonFile。
const writeSessionJsonFileAsync = (filePath: string, data: unknown) =>
	writeJsonFileAsync(filePath, data, { pretty: false });

/*
 * ── 会话表在**首次用到时**才建(包根归位 B,2026-10-03) ─────────────────────────────
 *
 * 这只模块从前在加载时就把日志、存储驱动与仓储建好,并把存储、应用状态与设置那几只模块的导出读进模块级的
 * 选项对象;于是任何 import 它的模块(今天包括会话入口 `index.ts`)在加载时都要带上那几只模块,且它们必须
 * 交出这些名字 —— 只 mock 了其中一部分的测试一 import 就失败。现在三样东西都放进 `sessionTable` 这只持有器,
 * 第一次有人要时才建,之后一直用同一份。这样做与从前**逐项等价**:
 *
 *  1. 选项对象里放的都是 import 进来的函数本身(`getOnethingSessionsDir`、`readJsonFile`、`getCurrentSessionId` ……)
 *     与一个常量(`DEFAULT_AGENT_ID`)。ES 模块的 import 绑定在各自模块里从不被重新赋值,所以第一次用时读到的
 *     与加载时读到的是同一个函数对象。
 *  2. 读设置的两处(`newSessionFormat`、`getDefaultWorkingDirectory`)本来就包在箭头函数里、每次调用时现取,
 *     从来不是加载时的快照;这里原样搬进来,语义不变。
 *  3. `createHybridSessionStorageDriver` 与 `createOnethingSessionRepository` 的构造只建内存里的 Map / LRU /
 *     节流写队列(队列的计时器在第一次排写时才起),不读盘、不读设置;早建晚建,建出来的状态相同。
 *  4. `getLogger('sessions')` 按命名空间记忆化(`LoggerRoot.logger`),晚取拿到的是同一个 logger 对象。
 *
 * 不挪进 `createOnethingBackend` 的装配步骤:这些函数被几十处当自由函数直接调用(装配中途的
 * `initializeStores()`、RPC 域、server 门面),挂到装配产物上会把「装配前也能用」变成「装配前抛错」。
 * 持有器是 `const`(装配硬闸只禁模块级 `let`),它装的是缓存而不是装配期状态。
 */
type SessionTableRepository = OnethingSessionRepository<ChatSession, ChatMessage, SessionMeta, SessionDetails, UserMessageMarker>
const sessionTable: { log?: Logger; repository?: SessionTableRepository } = {}

export function log(): Logger {
	return (sessionTable.log ??= getLogger('sessions'))
}

export function sessionRepository(): SessionTableRepository {
	return (sessionTable.repository ??= createSessionTableRepository())
}

function createSessionTableRepository(): SessionTableRepository {
	/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
	const consoleLog: ConsoleLikePort & OnethingSessionRepositoryLogger = consolePort(log())
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
	return createOnethingSessionRepository<
		ChatSession,
		ChatMessage,
		SessionMeta,
		SessionDetails,
		UserMessageMarker
	>(sessionRepositoryOptions);
}
