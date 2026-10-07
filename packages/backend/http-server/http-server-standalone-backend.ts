/**
 * 不带界面的后端进程自己装配的那只产品后端(无头宿主的那张宿主能力表)。
 *
 * 桌面把自己那只 backend 借给 HTTP 面时不走这里(`http-server-embed.ts`);只有
 * `createDevelopmentOnethingServerRuntime` 在没有递 `createBackend` 时调它。装配完再挂 ACP 的
 * 审批 / 文件 / 终端桥,并在后台起 ACP 子系统。
 *
 * 2026-10-04 从 `http-server-runtime.ts` 原样搬来(决策 D219)。第④步批 2a 起它收一份**档案**
 * (`backend-launcher.ts` 的 `BackendLaunchProfile`):装配开关、宿主表里的 `storePath` / `speechOutput`
 * 两格、ACP 无人答卡时怎么办,都从档案里读。没递档案 = 缺省档,与批 2a 之前逐字相同。
 */
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { createOnethingBackend, type OnethingBackend } from "@onething/backend/backend.js";
import type { ConfigureLoggingOptions } from "@onething/backend/logging/logging-configure";
import { createEventBusTerminalBroadcaster } from "@onething/backend/terminal";
import { registerACPPermissionBridge } from "@onething/backend/acp";
import { getLogger } from '@onething/backend/logging'
import {
	backendLaunchProfile,
	declareLaunchAttendance,
	launchHostPorts,
	type BackendLaunchProfile,
} from "@onething/backend/backend-launcher.js";

// 日志命名空间沿用搬家前的 `server.runtime`:`degraded tool set` 那一行一个字不变。
const log = getLogger('server.runtime')

export async function createRealServerBackend(
	storePath: string,
	logging?: ConfigureLoggingOptions,
	profile: BackendLaunchProfile = backendLaunchProfile(undefined),
	beforeFirstSpawn?: Promise<void>,
): Promise<OnethingBackend> {
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
	// 工具档在档案里(缺省档:ONETHING_SERVER_TOOLS=readonly 降成零副作用的那一套;桌面档恒 'full')。
	const serverToolRegistry = profile.assembly.toolRegistry;
	const launchPorts = launchHostPorts(profile);
	if (serverToolRegistry === "readonly") {
		log.info("degraded tool set (read/time/web only)", {
			reason: "ONETHING_SERVER_TOOLS=readonly",
		});
	}
	/*
	 * CLI 档(第④步批 3,决策 D7)在装配**之前**说「这台宿主上没人守着卡」:装配途中(MCP 真的会被拉起)万一有人问
	 * 权限,那时也已经没人能答。装配失败就地收回;成功之后交给 `own()`。别的档这一行什么都不声明。
	 */
	const releaseAttendance = declareLaunchAttendance(profile);
	// No `owner`: 2026-08-24 ruling — the standalone backend process (`backend-standalone-main.ts`) takes no store lock. It defers
	// through `<store>/run/http.json` (see packages/backend/backend-standalone-main.ts) instead.
	let assembled: OnethingBackend;
	try {
		assembled = await createOnethingBackend({
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
			// 档案决定:`ONETHING_RESOURCES_PATH` 设了 = 打包资源目录;没设 = `{}`(见上面那段注释)。
			storePath: launchPorts.storePath,
			sandbox: {
				getPath(name) {
					if (name === "downloads") return join(homedir(), "Downloads");
					return homedir();
				},
			},
			auth: null,
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
			// 第④步批 4:桌面档 / CLI 档由后端自己填(插件命令的 `exec`、网关生命周期);缺省档 `null`。
			plugins: launchPorts.plugins,
			gateway: launchPorts.gateway,
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
			// 缺省档 `null`;桌面档由后端自己交一只进程出声器(起 mpv / afplay 子进程)。
			speechOutput: launchPorts.speechOutput,
		},
		// 工具档、`sessionSkills`、`pets`(缺省档两格都开:浏览器壳连 server 时栖位照样有 `pet:`),
		// 桌面档另加 `promptVersion` / `collab`(与桌面进程内装配逐格相同,决策 D14)。
		...profile.assembly,
		sender: new ServerNoopSender() as never,
	});
	} catch (error) {
		releaseAttendance();
		throw error;
	}
	const backend = assembled;
	backend.own(releaseAttendance, "hostAttendance");
	/*
	 * 桌面档的登录 shell PATH 在这里等(第④步批 2a,D291):装配与它并行跑完了,而下面 `acp.start()` 一起名册
	 * 就按 PATH 判「装没装」、在后台起 `<agent> --version`;再往后建 runtime 时 MCP stdio 也会 spawn。
	 * 缺省档不递(或递一个已落定的承诺),这一行等于没有。
	 */
	if (beforeFirstSpawn) await beforeFirstSpawn;
	/*
	 * ACP 的审批 / 文件 / 终端桥(A3-b 裁定「桥在三个宿主上都注册」)。从前 server 不挂桥,
	 * agent 的请求根本到不了许可系统,由客户端按 `unattended` 直接答。挂上之后卡照常上屏
	 * (连着这台 server 的浏览器壳看得见、答得了);没人答就由许可系统的无人应答兜底按拒绝
	 * 收场(`unanswered: 'reject'`,`UNATTENDED_ASK_TIMEOUT_MS`)—— 与「无桥缺省拒」同一个结论。
	 */
	// 桌面档有窗口答卡(`wait`,与桌面进程内那句 `registerACPPermissionBridge()` 同口径);缺省档 `reject`。
	backend.own(registerACPPermissionBridge({ unanswered: profile.acpUnanswered }), "acpPermissionBridge");
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
