/**
 * 独立 `server:start` 自己装配的那只产品后端(无头宿主的那张宿主能力表)。
 *
 * 桌面把自己那只 backend 借给 HTTP 面时不走这里(`http-server-embed.ts`);只有
 * `createDevelopmentOnethingServerRuntime` 在没有递 `createBackend` 时调它。装配完再挂 ACP 的
 * 审批 / 文件 / 终端桥,并在后台起 ACP 子系统。
 *
 * 2026-10-04 从 `http-server-runtime.ts` 原样搬来(决策 D219),代码一行没改。
 */
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { createOnethingBackend, type OnethingBackend } from "@onething/backend/backend.js";
import type { ConfigureLoggingOptions } from "@onething/backend/logging/logging-configure";
import { createEventBusTerminalBroadcaster } from "@onething/backend/terminal";
import { registerACPPermissionBridge } from "@onething/backend/acp";
import { getLogger } from '@onething/backend/logging'

// 日志命名空间沿用搬家前的 `server.runtime`:`degraded tool set` 那一行一个字不变。
const log = getLogger('server.runtime')

export async function createRealServerBackend(storePath: string, logging?: ConfigureLoggingOptions): Promise<OnethingBackend> {
	// The engine drops commands silently when no sender is bound (the guard
	// exists for the desktop's window lifecycle); the server observes the
	// EventBus/StreamChannel directly, so bind a no-op sender like the CLI
	// daemon does.
	class ServerNoopSender extends EventEmitter {
		isDestroyed(): boolean {
			return false;
		}
		send(): void {
			/* SSE subscribers observe the bus and stream channel directly. */
		}
	}
	// User decision (2026-07-25): web/server tools ship with desktop parity by
	// default; ONETHING_SERVER_TOOLS=readonly degrades to zero-side-effect
	// tools (no bash/write/edit) for exposed deployments.
	const serverToolRegistry =
		process.env.ONETHING_SERVER_TOOLS === "readonly" ? "readonly" : "full";
	if (serverToolRegistry === "readonly") {
		log.info("degraded tool set (read/time/web only)", {
			reason: "ONETHING_SERVER_TOOLS=readonly",
		});
	}
	// No `owner`: 2026-08-24 ruling — the standalone backend process (`backend-standalone-main.ts`) takes no store lock. It defers
	// through `<store>/run/http.json` (see packages/backend/backend-standalone-main.ts) instead.
	const backend = await createOnethingBackend({
		storePath,
		logging,
		/*
		 * A1:宿主能力一次交清。这个进程是个无头 server —— 除了下载目录之外
		 * 一件宿主能力都没有,于是十四个 `null` 就是这里的事实清单(从前那是
		 * 「一个 `sandboxHost` 之外什么都没写」,看不出是没有还是漏了)。
		 *
		 * `storePath: {}` = 打包资源目录无话可说,与从前从不调
		 * `configureStorePathHost` 时的缺省逐字相同(`isPackaged` 为假、
		 * `resourcesPath` 退到 `process.resourcesPath`)。
		 *
		 * MCP 那一格仍是 `null`:server 自己的客户端工厂由
		 * `createServerRuntimeOverServerBackend` 在**后面**按 `processPorts`
		 * 决定装不装(它要 stdio 闸门与借来/自有的判定),不归这张表。
		 */
		host: {
			storePath: {},
			sandbox: {
				getPath(name) {
					if (name === "downloads") return join(homedir(), "Downloads");
					return homedir();
				},
			},
			auth: null,
			// 旧 safeStorage 密文解不开:遇到就答「已锁定 · 旧密文待迁移」,等桌面来迁(第④步批 0)。
			legacySafeStorageForMigration: null,
			logging: null,
			voice: null,
			/*
			 * 终端缺省没有(`terminal` 域结构化拒,不 load node-pty)。
			 * `ONETHING_SERVER_TERMINAL=1` 是运维显式打开的那一格:接上与 React 壳同一只
			 * 总线广播器,PTY 输出骑 `GET /api/events` 出网 —— 这正是 `terminal/terminal-client-api.ts`
			 * 头注里「将来放开 = 给 server 接广播器」那一步,只是今天只开给显式要它的人
			 * (`gate:acp` ⑭ 靠它证 ACP 终端进 TerminalService)。拿到 Bearer 的人因此能在这台机器上
			 * 开 shell —— 所以缺省关,只认 `'1'`。
			 */
			terminal: process.env.ONETHING_SERVER_TERMINAL === "1"
				? { broadcaster: createEventBusTerminalBroadcaster() }
				: null,
			skillsEnvironment: null,
			todoPlan: null,
			scratchpad: null,
			plugins: null,
			gateway: null,
			evals: null,
			mcp: null,
			/**
			 * 本机可信在这里必须是 `null`(B3):独立 server 到底可不可信取决于它
			 * **绑到哪个地址**,而装配的时候还没 listen。声明点在
			 * `packages/backend/backend-standalone-main.ts` —— 回环才声明 `loopback-server`,非回环
			 * 一个字不说。桌面把自己那只 backend 交给这段代码时(`embed.ts`)走的
			 * 是另一张表,那张表里 `localTrust` 是 `desktop-embedded`。
			 */
			localTrust: null,
			speechOutput: null,
		},
		toolRegistry: serverToolRegistry,
		sessionSkills: true,
		// 宠物宿主(`docs/design/pet-system-2026-09.md` §9.1):与 React 壳同一格,
		// 浏览器壳连 server 时栖位照样有 `pet:` 可读。CLI 守护进程不传。
		pets: true,
		sender: new ServerNoopSender() as never,
	});
	/*
	 * ACP 的审批 / 文件 / 终端桥(A3-b 裁定「桥在三个宿主上都注册」)。从前 server 不挂桥,
	 * agent 的请求根本到不了许可系统,由客户端按 `unattended` 直接答。挂上之后卡照常上屏
	 * (连着这台 server 的浏览器壳看得见、答得了);没人答就由许可系统的无人应答兜底按拒绝
	 * 收场(`unanswered: 'reject'`,`UNATTENDED_ASK_TIMEOUT_MS`)—— 与「无桥缺省拒」同一个结论。
	 */
	backend.own(registerACPPermissionBridge({ unanswered: "reject" }), "acpPermissionBridge");
	/*
	 * A5(方案 §11.6;A1-a 留账):独立 server 也在装配后起 ACP 子系统,与 React 壳
	 * (`electron/main.ts` 的 `void b.acp.start()`)、daemon(`mcpAcp: true`)同口径。
	 * `start()` 只读种子 / 缓存进名册、把生效配置喂给管家,不起任何 agent 进程(适配器在
	 * 第一次要用时才 spawn);注册表联网在后台跑,开关关着就不联网。从前 server 不调它,
	 * 名册靠第一次 RPC 惰性装进管家 —— 崩溃重连 / 认领这类不经名册读面的动作会读到空表。
	 * 收尾在装配时已经 `own()` 了(`AcpSubsystem` 构造即登记)。
	 */
	void backend.acp.start().catch((error: unknown) => {
		log.error("subsystem startup failed", { subsystem: "acp", blocking: false }, error);
	});
	return backend;
}
