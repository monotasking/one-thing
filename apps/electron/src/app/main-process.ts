import {
	activateMainWindow,
	createWindow,
	isTodoPlanBrowserWindow,
	recoverMainWindowAfterSystemResume,
	shouldSuppressMainWindowActivation,
	warmTodoPlanWindowForStartup,
} from "@onething/electron-host/window";
import {
	initializeIPC,
	initializeMCP,
	shutdownMCP,
	initializeACP,
	shutdownACP,
} from "@main/ipc/handlers.js";
// 结构债 P4c 第二批:skills 整域迁 router 之后,启动闩住在装配层的 skills 接线里
// (从前它挂在 `@main/ipc/skills.ts` 的适配上,而那个适配已经没有了)。
import { initializeSkills } from "@onething/backend/wiring/skills/session-skills.js";
import { getSettings } from "@onething/backend/stores/settings.js";
import {
	startTodoPlanWatcher,
	stopTodoPlanWatcher,
} from "@onething/backend/wiring/todo-plan/store.js";
import {
	startScratchpadWatcher,
	stopScratchpadWatcher,
} from "@onething/runtime/scratchpad/service-bound";
import { configureSandboxHost } from "@onething/backend/wiring/tools/core/sandbox.js";
import { configurePluginAppVersion } from "@onething/runtime/plugins/app-version";
import { getPluginManager } from "@onething/backend/wiring/plugins/manager.js";
import {
	resolvePluginStorageRoot,
	resolvePluginWebviewStaticRoot,
} from "@onething/backend/wiring/plugins/webview.js";
import {
	getConversationRuntime,
	getStreamEngine,
	getStreamEngineSafe,
} from "@onething/backend/wiring/engine/index.js";
import {
    createOnethingBackend,
    type OnethingBackend,
} from "@onething/backend/backend.js";
import type { OnethingHostPorts, StorePathHost, SandboxHost } from "@onething/backend/host-ports.js";
import { electronTodoPlanHostPorts } from "@main/ipc/todo-plan.js";
import { electronScratchpadHostPorts } from "@main/ipc/scratchpad.js";
import { electronPluginsHostPorts } from "@main/ipc/plugins.js";
import { electronTerminalHostPorts } from "@main/ipc/terminal.js";
import {
    startEmbeddedOnethingHttpServer,
    stopEmbeddedOnethingHttpServer,
} from "@onething/backend/server/embed.js";
import { removeHttpDiscovery } from "@onething/backend/server/discovery.js";
import {
  getOnethingMediaFilesDir,
  getOnethingMediaImagesDir,
} from '@onething/runtime/storage'
import {
  configureStorePathHost,
} from '@onething/backend/stores/docs-paths.js'
import { getEventBus } from "@onething/backend/events/index.js";
import {
	initializeIPCBridge,
	shutdownIPCBridge,
} from "@main/bridges/ipc-bridge-lifecycle.js";
import { disposeMusicService } from "@onething/backend/wiring/music/service.js";
import { disposeRadioConductor } from "@onething/backend/wiring/music/radio.js";
import { killAllTerminals } from "@onething/runtime/terminal/service.wiring";
import {
	configureBrowserWindowProvider,
	killAllBrowserTabs,
} from "@onething/electron-host/browser/service";
import { applyEmbeddedBrowserChromiumFlags } from "@onething/electron-host/browser/chromium-flags";
import {
	configureDeepLinkService,
	handleIncomingDeepLink,
} from "@onething/electron-host/deeplink/service";
import { watchTerminalConsumer } from "@main/ipc/terminal.js";
import { warmSearchWindow } from "@onething/electron-host/search/window";
import { applyNetworkProxySettings } from "@main/ipc/network-proxy.js";
import {
	configureGlobalWindowShortcuts,
	registerGlobalWindowShortcuts,
	unregisterGlobalWindowShortcuts,
} from "@onething/electron-host/shortcuts/global-shortcuts";
import { getVoiceService, getVoiceServiceSafe } from "@onething/backend/wiring/voice/service.js";
import {
	attachVoiceTrayMainWindow,
	configureVoiceTray,
	markVoiceQuitRequested,
	updateVoiceTray,
} from "@onething/electron-host/voice/tray";
import {
	destroyVoiceRuntimeWindow,
	ensureVoiceRuntimeWindow,
	flushVoiceRuntimeCommands,
	getVoiceRuntimeWindow,
	isVoiceRuntimeReady,
	markVoiceRuntimeReady,
	sendVoiceRuntimeCommand,
} from "@onething/electron-host/voice/runtime-window";
import {
	configureAppLoggingHost,
	configureLogging,
	getLogger,
	shutdownAppLogging,
} from "@onething/backend/wiring/logging/index.js";
import {
	createElectronRendererConsoleCapture,
	setElectronAppLogsPath,
} from "@onething/electron-host/logging/console-capture";
import {
	getElectronAppIsPackaged,
	getElectronAppVersion,
	getElectronResourcesPath,
} from "@onething/electron-host/skills/environment";
import { getElectronShouldUseDarkColors } from "@onething/electron-host/settings/ipc-host";
import {
	openElectronExternal,
	openElectronPath,
	revealElectronPath,
} from "@onething/electron-host/shell/operations";
import type { VoiceRuntimeWindowPorts } from "@onething/runtime/voice/host-ports.wiring";
import { broadcastElectronVoiceMessage } from "@onething/electron-host/voice/events";
import { createElectronAuthFetch } from "@onething/electron-host/auth/auth-fetch";
import { getElectronSafeStorage } from "@onething/electron-host/auth/electron-auth";
import { createRequiredAppFetch } from "@onething/backend/provider-binding/bound-fetch.js";
import { hydrateProcessEnvFromLoginShell } from "@onething/electron-host/app/login-shell-env";
import {
	StoreLock,
	LockConflictError,
	formatDesktopLockConflict,
} from "@onething/runtime/storage";
import {
	formatStartupSummary,
	markStartup,
	markStartupProcessStart,
} from "@onething/runtime/perf";
import {
	addWechatGatewayAccount,
	applyGatewaySettings,
	configureGatewayLifecycle,
	getGatewayStatus,
	initializeGateway,
	logoutWechatGateway,
	removeWechatGatewayAccount,
	renameWechatGatewayAccount,
	shutdownGateway,
	startGateway,
	stopGateway,
	stopWechatGatewayAccount,
} from "@onething/electron-host/gateway/lifecycle";
import { createGatewayPluginCommandProvider } from "@main/ipc/plugins.js";
import {
	registerElectronAppBootstrap,
	type ElectronActivateOptions,
} from "@onething/electron-host/app/bootstrap";

const log = getLogger("app.boot");

/**
 * Refresh model metadata from models.dev on first startup.
 * Only runs if no model data exists yet for any configured provider.
 */
async function refreshModelsOnFirstStartup(): Promise<void> {
	const { getSettings } = await import("@onething/backend/stores/settings.js");
	const settings = getSettings();
	const providers = settings?.ai?.providers;
	if (!providers) return;

	// Check if any provider already has models
	let hasModels = false;
	for (const pid of Object.keys(providers)) {
		const cfg = providers[pid] as any;
		if (cfg?.models && Object.keys(cfg.models).length > 0) {
			hasModels = true;
			break;
		}
	}

	if (hasModels) {
		log.debug("first-startup model refresh skipped", { reason: "models already present" });
		return;
	}

	log.info("first-startup model refresh starting");
	const { refreshAllProviders } = await import(
		"@onething/backend/wiring/providers/model-registry.js"
	);
	await refreshAllProviders();
	log.info("first-startup model refresh complete");
}

type MainBrowserWindow = ReturnType<typeof createWindow>;

let mainWindow: MainBrowserWindow | null = null;
let desktopStoreLock: StoreLock | null = null;
let electronMainStarted = false;
/**
 * 桌面自己那只 backend。A 期(docs/design/one-core-2026-08.md)之后它不再只喂
 * renderer 的 IPC 面 —— 内嵌的 HTTP/SSE 面挂的是**同一只**,于是 Web 端订阅到的
 * 就是桌面这条事件流,而不是另一个进程的。
 */
let desktopBackend: OnethingBackend | null = null;

/*
 * A1:这两件的**值**由 bootstrap / ready 那两张表算出来(它们直接 import
 * electron,而本文件不许 —— "apps/electron owns Electron ready handler" 那条
 * 规矩,连字面量都不许出现在这里)。所以这里不重算,而是在它们注入的**同一刻**
 * 顺手记一份,交给下面那张 `OnethingHostPorts`。两次注入是同一个对象,后一次
 * 是空操作。
 *
 * 时序是对的:store 路径那张表在 ready 之前落位,沙箱那张在 ready 处理器里紧
 * 挨着 `onReady()` 之前落位,而下面这张表在 `onReady` 里才被读。
 */
let electronStorePathHost: StorePathHost = {};
let electronSandboxHost: SandboxHost = {};

/**
 * 桌面宿主交给装配层的**全表**(A1,`packages/backend/host-ports.ts`)。
 *
 * 从前这十几件散在 `startOnethingElectronMain()` 与各域的 IPC 注册函数里,靠
 * "记得调"保证;现在是一张必填的表,漏一项是 `tsc` 错误。这个宿主是四个里唯一
 * 一个几乎不写 `null` 的 —— 那正是它与 React 壳的能力差,现在可以逐行比。
 *
 * 注意 `logging` 这一格:它的注入**另有一次**、且必须更早(见
 * `startOnethingElectronMain` 里 `configureLogging` 前的那一行 —— renderer 兜底
 * 采集是在 `configureLogging` 里 attach 的,顺序反了就采不到)。这里再列一次是
 * 为了让表说实话:桌面**有**这件能力。同一个对象赋两次是空操作。
 */
const electronAppLoggingHostPorts = {
	setAppLogsPath: setElectronAppLogsPath,
	createRendererConsoleCapture: createElectronRendererConsoleCapture,
};

function createElectronDesktopHostPorts(): OnethingHostPorts {
	const voiceRuntimeWindow: VoiceRuntimeWindowPorts = {
		ensure: () => void ensureVoiceRuntimeWindow(),
		destroy: destroyVoiceRuntimeWindow,
		sendCommand: sendVoiceRuntimeCommand,
		markReady: markVoiceRuntimeReady,
		isReady: isVoiceRuntimeReady,
		flushCommands: flushVoiceRuntimeCommands,
		// P4c 第十一批:`voice.runtimeReady` 的回声抑制从前靠 `event.sender`;
		// 信封里没有那一格,于是改由宿主指认那扇窗(它是唯一会调那条的窗口)。
		getWebContents: () => getVoiceRuntimeWindow()?.webContents,
	};
	return {
		storePath: electronStorePathHost,
		sandbox: electronSandboxHost,
		auth: {
			authFetch: createElectronAuthFetch({
				fallbackFetch: createRequiredAppFetch({ policy: "auth" }),
			}),
			tokenCryptoAdapter: getElectronSafeStorage,
		},
		logging: electronAppLoggingHostPorts,
		// 「用系统的方式打开一个东西」的宿主能力(结构债 P4c 第二批)。产品层只声明要,
		// 能力由这里给 —— 桌面有文件管理器和默认浏览器,server / CLI 没有,于是那两个
		// 宿主拿到的是结构化降级而不是一份写死的「不支持」文案。
		shell: {
			openPath: (targetPath) => openElectronPath(targetPath),
			openExternal: (url) => openElectronExternal(url),
			revealPath: (targetPath) => revealElectronPath(targetPath),
		},
		voice: {
			broadcastMessage: broadcastElectronVoiceMessage,
			runtimeWindow: voiceRuntimeWindow,
			updateTray: updateVoiceTray,
		},
		// 终端的输出广播器(B1)。这一格从前在 `initializeIPC()` 里注入,现在与其它
		// 宿主能力一起在装配第一步接上 —— `terminal` 域的闸从「是不是 http」改成
		// 「这台宿主有没有输出通道」之后,它必须在第一次派发之前就位。
		terminal: electronTerminalHostPorts,
		skillsEnvironment: {
			isPackaged: getElectronAppIsPackaged,
			getResourcesPath: getElectronResourcesPath,
		},
		todoPlan: electronTodoPlanHostPorts,
		scratchpad: electronScratchpadHostPorts,
		plugins: electronPluginsHostPorts,
		// IM 网关生命周期的宿主能力(结构债 P4c 第八批)。八条数据面走 `gatewayRouter`,
		// 而八件事全都要主进程本体(拉起来的子进程 + 一张二维码),所以由这里注入 ——
		// server / CLI 不注入,于是拿到结构化降级而不是旧 server adapter 那句写死的
		// 「server runtime 上网关已禁用」。
		gateway: {
			getStatus: () => getGatewayStatus(),
			start: (request) => startGateway(request),
			stop: () => stopGateway(),
			wechatLogout: (request) => logoutWechatGateway(request),
			wechatAddAccount: (request) => addWechatGatewayAccount(request),
			wechatStopAccount: (request) => stopWechatGatewayAccount(request),
			wechatRemoveAccount: (request) => removeWechatGatewayAccount(request),
			wechatRenameAccount: (request) => renameWechatGatewayAccount(request),
			// P4c 第十一批:设置存盘后的网关套用。它从前住在 `@main/ipc/settings.ts` 的
			// 保存链里,随四条数据面迁 `settingsRouter` 一起改走这张端口表。
			applySettings: async (settings) => {
				await applyGatewaySettings(settings);
			},
		},
		// P4c 第十一批:设置面的三件宿主能力。三件都可缺 —— server / CLI 不注入,
		// 域处理者那条保存链自然退化成「存盘 + 刷 provider 缓存 + 更新 MCP/ACP」。
		settings: {
			shouldUseDarkColors: getElectronShouldUseDarkColors,
			applyNetworkProxySettings: (proxy) => applyNetworkProxySettings(proxy),
			registerGlobalWindowShortcuts,
		},
		// 评估面的宿主注入(结构债 P4c 第十批)。「evals 仓在哪」的判定在装配层
		// (`resolveEvalsRepoDir`);宿主只回答它独有的那一位事实 —— 开发态 app 是从
		// 仓库 checkout 里跑起来的(cwd 就是仓根),打包态没有任何有意义的 cwd,
		// 必须由用户在设置里显式配。
		evals: {
			isPackaged: getElectronAppIsPackaged,
		},
		// MCP clientInfo 的晚绑线:产品名固定在 identity 默认值里,版本只有宿主知道。
		// 客户端工厂用缺省的内置 `MCPClient`(桌面不关 stdio)。
		mcp: {
			clientFactory: null,
			identity: { version: getElectronAppVersion() },
		},
	};
}

async function initializeElectronReadyServices(): Promise<void> {
	markStartup("ready-begin");

	// The assembly recipe lives in createOnethingBackend; this host only
	// contributes its Electron-specific steps through the hooks.
	desktopBackend = await createOnethingBackend({
		host: createElectronDesktopHostPorts(),
		toolRegistry: "full",
		promptVersion: true,
		collab: true,
		hooks: {
			afterSettings: async () => {
				markStartup("settings-ready");
				configureGlobalWindowShortcuts({
					getShortcuts: () => getSettings().general?.shortcuts,
				});
				await applyNetworkProxySettings();
			},
			/*
			 * A3:钩子现在**收到那只正在装配的实例**(`OnethingBackendHooks` 的
			 * 三个签名一起改)。理由就在下面两行 `own()` 上:钩子跑的时候
			 * `createOnethingBackend(...)` 还没返回,`desktopBackend` 还是 null
			 * —— 两个 watcher 从前因此**没有任何收尾**(`stopTodoPlanWatcher`
			 * 自诞生起零调用者),而它们各自握着一个 fs.watch 句柄。
			 */
			afterTools: async (backend) => {
				// Initialize IPC handlers, then watch the todo store: the AI
				// edits its todo with the plain write/edit tools, so nothing
				// else would tell the UI those edits landed.
				initializeIPC();
				await startTodoPlanWatcher();
				backend.own(() => stopTodoPlanWatcher(), "todoPlanWatcher");
				// Same deal for the scratchpad: the AI edits the paper with the
				// plain write/edit tools, so the watcher is the UI's only signal.
				await startScratchpadWatcher();
				backend.own(() => stopScratchpadWatcher(), "scratchpadWatcher");
			},
		},
	});

	markStartup("services-ready");
}

async function acquireDesktopStoreLock(): Promise<void> {
	desktopStoreLock = new StoreLock();
	await desktopStoreLock.acquire("desktop");
}

function formatElectronDesktopStoreLockError(error: unknown): string {
	if (error instanceof LockConflictError) {
		return formatDesktopLockConflict(error.holder);
	}
	return error instanceof Error ? error.message : String(error);
}

/**
 * 内嵌 core 服务的 HTTP/SSE 面(A 期)。
 *
 * 放在窗口之后、非阻塞:它对桌面自己是**锦上添花**(桌面走 IPC),挂不上不该
 * 让桌面起不来 —— 所以失败只记一条日志。挂上之后 `<store>/run/http.json` 就是
 * 这个 store 的 core 服务地址,web dev 代理、CLI、`server:start` 的让位判定
 * 都读它。
 */
function startEmbeddedCoreHttpSurface(): void {
	const backend = desktopBackend;
	if (!backend) {
		log.error("embedded HTTP surface not mounted", { reason: "backend is not ready" });
		return;
	}
	const mounting = startEmbeddedOnethingHttpServer(backend).catch((error) => {
		log.error(
			"embedded HTTP surface mount failed",
			{ subsystem: "core-http", blocking: false },
			error,
		);
	});
	/*
	 * A3:收尾**登记在起的这一行旁边**(方案 §2.4)。登记是同步的,而 disposer
	 * 里第一件事是等挂面那条 promise —— 挂面非阻塞,一次早退(启动两秒内 Cmd+Q)
	 * 会让 stop 跑在 listen 之前,那时 `stopEmbeddedOnethingHttpServer` 看到的
	 * `current` 还是 null,一句 no-op 返回,而随后 listen 成功的那台面就留下了。
	 *
	 * before-quit 表上那一格**留着**,与 `shutdownPlugins` 同一条理由(见
	 * before-quit.ts 的字段注释):发现文件必须先于第一个 await 从盘上消失。
	 * 那一格是同步的删文件 + fire-and-forget 关端口,这里这一格是"关干净"。
	 * 两次都跑得到:`stopEmbeddedOnethingHttpServer` 关过之后是 no-op。
	 */
	backend.own(async () => {
		await mounting;
		await stopEmbeddedOnethingHttpServer().catch((error: unknown) => {
			log.error("embedded HTTP surface shutdown failed", { subsystem: "core-http" }, error);
		});
		removeHttpDiscovery();
	}, "embeddedHttpSurface");
}

function startPostWindowServices(): void {
	startEmbeddedCoreHttpSurface();

	const pluginsReady = (async () => {
		const { bootstrapPluginSystem } = await import("@onething/backend/wiring/plugins/index.js");
		// P3:市场索引 URL(共享层死常量,裁决"纯硬编码")——装配期注入,
		// 更新通道与市场区同这一条供给线;测试经 configurePluginMarketIndex 覆盖。
		const { configurePluginMarketIndex } = await import("@onething/backend/wiring/plugins/install.js");
		const { PLUGIN_MARKET_INDEX_URL } = await import("@shared/ipc/plugins.js");
		configurePluginMarketIndex(PLUGIN_MARKET_INDEX_URL);
		await bootstrapPluginSystem(getEventBus(), getStreamEngine());
	})().catch((err) => {
		log.error("subsystem startup failed", { subsystem: "plugins", blocking: false }, err);
	});

	import("@onething/backend/wiring/scheduler/user-tasks.js")
		.then(({ initializeUserSchedulerTasks }) => {
			// A3 新增的对称 stop:从前用户定时任务那条 setTimeout 链没有任何人
			// 关得掉(`initializeUserSchedulerTasks` 是关机清单上唯一按设计就
			// 没有 stop 口的一件)。
			desktopBackend?.own(initializeUserSchedulerTasks(), "userSchedulerTasks");
		})
		.catch((err) => {
			log.error("subsystem startup failed", { subsystem: "scheduler", blocking: false }, err);
		});

	// Initialize MCP system asynchronously (don't block startup)
	initializeMCP()
		.then(() => {
			// A3:桌面是 `mcpAcp: false` 装配的(MCP 在窗口之后才起),所以
			// backend 自己那格 `mcpAcp` disposer 直接 return —— 收尾归起它的人。
			desktopBackend?.own(() => shutdownMCP(), "mcpManager");
		})
		.catch((err) => {
			log.error("subsystem startup failed", { subsystem: "mcp", blocking: false }, err);
		});

	try {
		initializeACP();
		// `shutdownACP` 连着外部执行体连接器一起收(acp.ts)。backend 那格
		// `externalAgents` 是无条件登记的兜底,dispose 幂等,两次都调得起。
		desktopBackend?.own(() => shutdownACP(), "acpManager");
	} catch (err) {
		log.error("subsystem startup failed", { subsystem: "acp", blocking: false }, err);
	}

	// Refresh model registry on first startup (non-blocking)
	refreshModelsOnFirstStartup().catch((err) => {
		log.error("subsystem startup failed", { subsystem: "model-registry", blocking: false }, err);
	});


	// Gateway is an Electron-hosted service. Enable from Settings > Channels
	// or with legacy gateway env vars so IM messages enter the real onething runtime.
	initializeGateway()
		.then(() => {
			// A3:网关也归 `own()`。它从 before-quit 那张表上搬过来了 —— 一件
			// 东西只有一个收尾产地,而它是 backend 起来之后才起的。
			desktopBackend?.own(() => shutdownGateway(), "gateway");
		})
		.catch((err) => {
			log.error("subsystem startup failed", { subsystem: "gateway", blocking: false }, err);
		});

	// Plugin roots can contribute skills, so load skills after plugin bootstrap
	// has had a chance to register its roots.
	pluginsReady.finally(() => {
		initializeSkills().catch((err) => {
			log.error("subsystem startup failed", { subsystem: "skills", blocking: false }, err);
		});
	});
}

function createElectronMainWindowOptions(): ElectronActivateOptions {
	return {
		getMainWindow: () => mainWindow,
		setMainWindow: (window) => {
			mainWindow = window;
		},
		shouldSuppressMainWindowActivation,
		createWindow,
		attachVoiceTrayMainWindow,
		registerGlobalWindowShortcuts,
		initializeIPCBridge: (sender) => {
			initializeIPCBridge(sender);
			// Flow-control detach edge: reload/crash/close must drop terminals to
			// detached or their output freezes at the high-water mark (7.3 rule ⑤).
			watchTerminalConsumer(sender);
		},
		bindStreamEngine: (webContents) => getStreamEngine().bind(webContents),
		shutdownIPCBridge,
		abortActiveStreams: () => getStreamEngineSafe()?.abortAll(),
		attachVoiceMainWindow: (window) =>
			getVoiceService().attachMainWindow(window),
		warmSearchWindow,
		warmTodoPlanWindow: warmTodoPlanWindowForStartup,
		activateMainWindow,
	};
}

export function startOnethingElectronMain(): void {
	if (electronMainStarted) return;
	electronMainStarted = true;

	// Chromium flags the embedded browser needs (disabling FedCM so Google login
	// works — replicates Flow Browser). Applied via the host module so this file
	// stays electron-free (boundary). Must run before the app becomes ready.
	applyEmbeddedBrowserChromiumFlags();

	// 深链确认门要的两样宿主能力:主窗句柄 + 把它拉到前面来。卡片必须落在用户
	// 眼前的那扇窗上 —— 一张画在别的桌面上的确认卡等于没弹。
	configureDeepLinkService({
		getMainWindow: () => mainWindow,
		activateMainWindow: (window) =>
			activateMainWindow(window as Parameters<typeof activateMainWindow>[0]),
	});

	// Dev restarts kill the process group with SIGTERM→SIGKILL and before-quit
	// never fires — reap user terminal shells so they don't orphan. The PTY
	// master fd closing on exit HUPs foreground jobs; this also collects
	// SIGHUP-ignoring children via the service's group signal.
	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		process.on(signal, () => {
			// 发现文件是"这个 store 由我在服务"的宣告 —— dev 重启走的正是这条路,
			// 留下它下一次 `server:start` 就得靠探活才敢无视。
			removeHttpDiscovery();
			killAllTerminals();
			killAllBrowserTabs();
			process.exit(signal === "SIGINT" ? 130 : 143);
		});
	}

	markStartupProcessStart(process.uptime());
	markStartup("main-start");

	configureGatewayLifecycle({
		getConversationRuntime,
		getSettings: () => getSettings(),
		commandProvider: createGatewayPluginCommandProvider(),
		// L2:网关的记录走主进程这一本账(`gateway.*`),不再自己往终端打。
		gatewayLogger: getLogger,
	});
	configureVoiceTray({
		getVoiceState: () => getSettings().voice,
		shutdownVoiceService: () => getVoiceServiceSafe()?.shutdown(),
	});

	// Embedded browser: views attach to the main window's contentView. Provider
	// is lazy — consulted per createTab, when the window already exists.
	configureBrowserWindowProvider(() => mainWindow);

	/*
	 * A1(`docs/design/backend-composition-root-2026-09.md`):这里从前是十来次
	 * 零散的 `configure*Host`。它们现在住在 `createElectronDesktopHostPorts()`
	 * 那张必填的表里,由装配的第一步 `applyHostPorts` 统一接线。
	 *
	 * 只有 `configureAppLoggingHost` 留在这里,理由是时序:renderer 的 console
	 * 兜底采集是在 `configureLogging` 里 attach 的,而 `configureLogging` 必须
	 * 在装配之前跑(它决定这个进程从哪一行起有账本)。所以这一件必须比装配更早
	 * ——它在那张表里也列了一份(同一个对象),那是为了让表说实话。
	 */
	configureAppLoggingHost(electronAppLoggingHostPorts);
	// 日志系统的接线点(L1):`app.jsonl` + console 兜底 + 进程钩子 + log/ 目录治理。
	// hostPorts 已在上面给过(顺序不能反 —— renderer 兜底采集是在 configure 里 attach 的)。
	configureLogging({ src: "main" });
	// 宿主版本是 minAppVersion 判定的唯一输入 —— 只有宿主自己知道它
	// (打包后 package.json 不在可预测的相对位置)。没配 = 判定跳过。
	// 不进聚合:插件版本判定不是装配层的端口表里的一格。
	configurePluginAppVersion(getElectronAppVersion());

	// Suppress security warnings in development mode. Vite HMR needs unsafe-eval;
	// production builds use strict CSP and do not show these warnings.
	if (process.env.NODE_ENV === "development") {
		process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
	}

	registerElectronAppBootstrap({
		// 注入照旧(时序不变),顺手记一份给上面那张 `OnethingHostPorts` —— 本文件
		// 不许直接 import electron,那两位事实只有 apps/electron 的这两张表拿得到。
		storePathHost: {
			configureStorePathHost: (host) => {
				electronStorePathHost = host;
				configureStorePathHost(host);
			},
		},
		ready: {
			configureSandboxHost: (host) => {
				electronSandboxHost = host;
				configureSandboxHost(host);
			},
			hydratePackagedEnvironment: async () => {
				await hydrateProcessEnvFromLoginShell({ logger: console });
				markStartup("login-shell-env-hydrated");
			},
			acquireDesktopStoreLock,
			formatDesktopStoreLockError: formatElectronDesktopStoreLockError,
		},
		// files/ 与 images/ 并列供给:非图片资产(拖放进来的 PDF/音视频)也要能被
		// `media://` 取到,否则面板里只有图片有预览。
		mediaProtocol: {
			getMediaImagesDir: getOnethingMediaImagesDir,
			getMediaFilesDir: getOnethingMediaFilesDir,
		},
		// 插件 webview 静态协议(C 期):供给线是装配层的静态根解析器 ——
		// 协议 handler 自己不认识插件系统,未装/停用/没声明 webview 一律 404。
		// 第二条供给线(B 期,用户壁纸)是**数据区**根:`__storage__/…` 的请求
		// 只查它,与包根并列而不互通。
		pluginProtocol: {
			resolveStaticRoot: resolvePluginWebviewStaticRoot,
			resolveStorageRoot: resolvePluginStorageRoot,
		},
		// 深链(H4)。协议口只把 URL 递给确认门 —— 它自己不知道 `ask` 是什么。
		deepLinkProtocol: { deliver: handleIncomingDeepLink },
		powerResume: {
			getMainWindow: () => mainWindow,
			recoverMainWindow: recoverMainWindowAfterSystemResume,
		},
		windowAllClosed: {
			isVoiceKeepAliveEnabled: () => getVoiceService().getState().enabled,
		},
		didBecomeActive: {
			getMainWindow: () => mainWindow,
			isTodoPlanWindow: isTodoPlanBrowserWindow,
			activateMainWindow,
		},
		beforeQuit: {
			markVoiceQuitRequested,
			shutdownVoiceService: () => getVoiceService().shutdown(),
			shutdownMusicService: () => {
				disposeRadioConductor();
				disposeMusicService();
			},
			unregisterGlobalWindowShortcuts,
			// A3:网关 / MCP / ACP 三行搬进了 `startPostWindowServices` 的
			// `backend.own(...)` —— 它们是 backend 起来之后才起的,收尾跟着
			// `dispose()` 走(方案 §2.4「谁起的,谁 own()」)。
			killAllBrowserTabs,
			// 插件系统:桌面宿主是**唯一真的跑插件的宿主**,它的退出路径就是这张表。
			//
			// 两条日志都是有意的:`shutdown()` 自己一行不打,于是真机走查时
			// "app.log 里没有 [PluginManager]"既可能是没跑到、也可能是跑了但沉默 ——
			// 那次诊断为此多花了一整轮。现在退出路径在日志里是可判定的。
			shutdownPlugins: () => {
				const manager = getPluginManager();
				if (!manager) {
					log.info("plugin shutdown skipped", { reason: "never bootstrapped" });
					return;
				}
				manager.shutdown();
				log.info("plugin system shut down");
			},
			// 同步段:先摘掉发现文件,关端口 fire-and-forget(before-quit 不被 await)。
			stopEmbeddedHttpServer: () => {
				removeHttpDiscovery();
				void stopEmbeddedOnethingHttpServer().catch((error) => {
					log.error("embedded HTTP surface shutdown failed", { subsystem: "core-http" }, error);
				});
			},
			// A2:backend 那一整段收尾收敛成一行。清单住在 `assemble` 途中的
			// `own()` 登记里,顺序与从前这张表里那九行逐字相同 —— 而且顺带把
			// 桌面从来没抄进来过的几件(RPC 域、协作运行时、外部执行体、
			// Interaction、账本广播、两个启动期定时器)也关上了。
			disposeBackend: () => desktopBackend?.dispose(),
			shutdownAppLogging,
			releaseDesktopStoreLock: () => {
				desktopStoreLock?.release();
				desktopStoreLock = null;
			},
		},
		createMainWindowOptions: createElectronMainWindowOptions,
		onReady: initializeElectronReadyServices,
		afterMainWindowCreated: () => {
			markStartup("window-created");
			log.info("startup summary", { summary: formatStartupSummary() });
			getVoiceService().applySettings();
		},
		startPostWindowServices,
	});
}

export { mainWindow };
