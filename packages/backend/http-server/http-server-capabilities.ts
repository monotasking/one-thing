/**
 * `GET /api/capabilities` 的答案:这台 HTTP 面上的客户端能做什么。
 *
 * 一位能力 = 一个判据函数,而且是对应那个域自己在读的那一个 —— 所以这只文件按设计要问五个
 * 功能的判据(本机信任、shell 宿主、终端宿主、插件管理器、collab 运行时),每次现取、不缓存。
 *
 * 2026-10-04 从 `http-server-runtime.ts` 原样搬来(决策 D219),代码一行没改。
 */
import { homedir } from "node:os";
import { type RuntimeHostCapabilities } from "@shared/contracts/runtime-capabilities";
import { isCollabV3RuntimeRunning } from "@onething/backend/collab";
import { getPluginManager } from "@onething/backend/plugin";
import { isHostLocallyTrusted } from "./http-server-host-trust.js";
import { hasShellHost } from "@onething/backend/shell";
import { hasTerminalHost } from "@onething/backend/terminal";
import type { RuntimeCapabilitiesAdapter } from "./http-server-runtime-facade.js";

/**
 * 只剩**纯客户端形态**的那几位:它们问的是"拿着这个 HTTP 面的那个客户端是不是
 * 一只 Electron 窗口",与这个进程的宿主装了什么无关,所以常量就够。
 *
 * B3 之前这里还摊着 `localFileSystem` / `shellTools` 两个 `false` —— 那是两份
 * 真相(后端护栏各自另有判据),已经删掉,见 `currentServerCapabilities()`。
 */
const webServerCapabilities: Omit<
	RuntimeHostCapabilities,
	| "localFileSystem"
	| "shellTools"
	| "terminal"
	| "pluginsManage"
	| "collabRooms"
	// 09-13:家目录同样是推导位(与 `localFileSystem` 同判据),不是常量。
	| "homeDir"
> = {
	workspaceFileSystem: true,
	nativeWindowControls: false,
	clipboardWrite: false,
	desktopWindows: false,
	globalMenuEvents: false,
};

/**
 * `/api/capabilities` 的出门快照(P4 终态批 B 拍板 #12;B3 起五位从后端事实推导)。
 *
 * **一位能力 = 一个判据函数,而且是对应那个域自己在读的那一个**
 * (方案 `docs/design/backend-transport-forks-2026-09.md` §2.3)。B3 之前除
 * `collabRooms` 外全是静态常量,于是前端看到的能力位与后端真正的护栏是两套 ——
 * 审计 `backend-architecture-review-2026-09-02.md` §2.6 说的"对不齐"就是这个。
 * 现在下面每一行右边那个函数,都是同名的域处理器判"给不给做"时调的那一个;
 * 每次现取、不缓存,因为答案是**进程状态**(宿主装了什么、信任声明了没有),
 * 不是配置。
 *
 * 同一份 `server/` 代码既被独立 `server:start` 用,也被桌面内嵌 HTTP 面挂在自己
 * 那只 backend 上 —— 所以这五位在两种宿主上如实分岔,不需要两份代码。
 *
 * 不加 `voice` 一位:渲染侧 `PlatformCapabilities` 今天没有这一位,加就是新造一个
 * wire 键,不在 B 的范围里。
 */
function currentServerCapabilities(): RuntimeHostCapabilities {
	return {
		...webServerCapabilities,
		// 与 files / tools / search / evals / mcp / sessions 六个域同判据
		// (`isHostLocallyTrusted()`):可信 = 路径不夹,也就是"这台机器的文件系统"。
		localFileSystem: isHostLocallyTrusted(),
		// 与 oauth 域同判据(`hasShellHost()`):宿主注没注入"用系统的方式打开一个东西"。
		shellTools: hasShellHost(),
		// 与 terminal 域同判据(`hasTerminalHost()`):宿主注没注入 PTY 输出广播器。
		terminal: hasTerminalHost(),
		// 与 plugins 域同判据(`getPluginManager()`):这个进程装没装插件管理器。
		pluginsManage: getPluginManager() !== null,
		// 与 sessions 域建房那道闸同判据(`isCollabV3RuntimeRunning()`)。
		collabRooms: isCollabV3RuntimeRunning(),
		// 与 `localFileSystem` **同判据**(`isHostLocallyTrusted()`):不可信的
		// 客户端连路径都不夹,更不该知道这台机器的家目录 —— 那是一行白送的用户名。
		// 客户端只拿它做显示(路径前缀画成 `~`),后端不用它判任何事。
		homeDir: isHostLocallyTrusted() ? homedir() : null,
	};
}

/** 门面的 `capabilities` 一格。 */
export function createServerCapabilitiesPort(): RuntimeCapabilitiesAdapter<RuntimeHostCapabilities> {
	const capabilitiesPort: RuntimeCapabilitiesAdapter<RuntimeHostCapabilities> = {
		async get() {
			return currentServerCapabilities();
		},
	};
	return capabilitiesPort;
}
