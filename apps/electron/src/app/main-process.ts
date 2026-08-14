import {
	activateMainWindow,
	createWindow,
	isTodoPlanBrowserWindow,
	recoverMainWindowAfterSystemResume,
	shouldSuppressMainWindowActivation,
	warmTodoPlanWindow,
} from "@onething/electron-host/window";
import {
	initializeIPC,
	initializeMCP,
	shutdownMCP,
	initializeSkills,
	initializeACP,
	shutdownACP,
} from "@main/ipc/handlers.js";
import { flushAllPendingSaves } from "@onething/app/store.js";
import { getSettings } from "@onething/app/stores/settings.js";
import { startTodoPlanWatcher } from "@onething/app/todo-plan/store.js";
import { startScratchpadWatcher } from "@onething/app/scratchpad/index.js";
import { configureSandboxHost } from "@onething/app/tools/core/sandbox.js";
import { configurePluginAppVersion } from "@onething/app/plugins/app-version.js";
import { configureMCPClientIdentity } from "@onething/app/mcp/identity.js";
import { getPluginManager } from "@onething/app/plugins/manager.js";
import {
	resolvePluginStorageRoot,
	resolvePluginWebviewStaticRoot,
} from "@onething/app/plugins/webview.js";
import {
	getConversationRuntime,
	getStreamEngine,
	getStreamEngineSafe,
	shutdownStreamEngine,
} from "@onething/app/engine/index.js";
import { createOnethingBackend } from "@onething/app/backend.js";
import {
	configureStorePathHost,
	getMediaFilesDir,
	getMediaImagesDir,
} from "@onething/app/stores/paths.js";
import {
	shutdownEventSystem,
	getEventBus,
} from "@onething/app/events/index.js";
import {
	initializeIPCBridge,
	shutdownIPCBridge,
} from "@main/bridges/ipc-bridge-lifecycle.js";
import { shutdownSessionLayer } from "@onething/app/session/index.js";
import { Permission } from "@onething/app/permission/index.js";
import { disposeMusicService } from "@onething/app/music/service.js";
import { disposeRadioConductor } from "@onething/app/music/radio.js";
import { killAllTerminals } from "@onething/app/terminal/service.js";
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
import { getVoiceService, getVoiceServiceSafe } from "@onething/app/voice/service.js";
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
	isVoiceRuntimeReady,
	markVoiceRuntimeReady,
	sendVoiceRuntimeCommand,
} from "@onething/electron-host/voice/runtime-window";
import { killTrackedDetachedChildren } from "@onething/app/tools/core/bash-executor.js";
import {
	configureAppLoggingHost,
	initializeAppLogging,
	shutdownAppLogging,
} from "@onething/app/logging/index.js";
import {
	createElectronRendererConsoleCapture,
	setElectronAppLogsPath,
} from "@onething/electron-host/logging/console-capture";
import { configureSkillsEnvironmentHost } from "@onething/app/skills/loader.js";
import {
	getElectronAppIsPackaged,
	getElectronAppVersion,
	getElectronResourcesPath,
} from "@onething/electron-host/skills/environment";
import { configureAuthHost } from "@onething/app/auth/host-ports.js";
import { configureVoiceHost } from "@onething/app/voice/host-ports.js";
import { broadcastElectronVoiceMessage } from "@onething/electron-host/voice/events";
import { createElectronAuthFetch } from "@onething/electron-host/auth/auth-fetch";
import { getElectronSafeStorage } from "@onething/electron-host/auth/electron-auth";
import { createRequiredAppFetch } from "@onething/app/providers/bound-fetch.js";
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
	configureGatewayLifecycle,
	initializeGateway,
	shutdownGateway,
} from "@onething/electron-host/gateway/lifecycle";
import { createGatewayPluginCommandProvider } from "@main/ipc/plugins.js";
import {
	registerElectronAppBootstrap,
	type ElectronActivateOptions,
} from "@onething/electron-host/app/bootstrap";

/**
 * Refresh model metadata from models.dev on first startup.
 * Only runs if no model data exists yet for any configured provider.
 */
async function refreshModelsOnFirstStartup(): Promise<void> {
	const { getSettings } = await import("@onething/app/stores/settings.js");
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
		console.log(
			"[Models] Model data already exists, skipping first-startup refresh",
		);
		return;
	}

	console.log("[Models] First startup detected, refreshing model registry...");
	const { refreshAllProviders } = await import(
		"@onething/app/providers/model-registry.js"
	);
	await refreshAllProviders();
	console.log("[Models] First-startup refresh complete");
}

type MainBrowserWindow = ReturnType<typeof createWindow>;

let mainWindow: MainBrowserWindow | null = null;
let desktopStoreLock: StoreLock | null = null;
let electronMainStarted = false;

async function initializeElectronReadyServices(): Promise<void> {
	markStartup("ready-begin");

	// The assembly recipe lives in createOnethingBackend; this host only
	// contributes its Electron-specific steps through the hooks.
	await createOnethingBackend({
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
			afterTools: async () => {
				// Initialize IPC handlers, then watch the todo store: the AI
				// edits its todo with the plain write/edit tools, so nothing
				// else would tell the UI those edits landed.
				initializeIPC();
				await startTodoPlanWatcher();
				// Same deal for the scratchpad: the AI edits the paper with the
				// plain write/edit tools, so the watcher is the UI's only signal.
				await startScratchpadWatcher();
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

function startPostWindowServices(): void {
	const pluginsReady = (async () => {
		const { bootstrapPluginSystem } = await import("@onething/app/plugins/index.js");
		// P3:市场索引 URL(共享层死常量,裁决"纯硬编码")——装配期注入,
		// 更新通道与市场区同这一条供给线;测试经 configurePluginMarketIndex 覆盖。
		const { configurePluginMarketIndex } = await import("@onething/app/plugins/install.js");
		const { PLUGIN_MARKET_INDEX_URL } = await import("@shared/ipc/plugins.js");
		configurePluginMarketIndex(PLUGIN_MARKET_INDEX_URL);
		await bootstrapPluginSystem(getEventBus(), getStreamEngine());
	})().catch((err) => {
		console.error("[Plugins] Bootstrap failed (non-blocking):", err);
	});

	import("@onething/app/scheduler/user-tasks.js")
		.then(({ initializeUserSchedulerTasks }) => initializeUserSchedulerTasks())
		.catch((err) => {
			console.error(
				"[Scheduler] User task initialization failed (non-blocking):",
				err,
			);
		});

	// Initialize MCP system asynchronously (don't block startup)
	initializeMCP().catch((err) => {
		console.error("[MCP] Initialization failed (non-blocking):", err);
	});

	try {
		initializeACP();
	} catch (err) {
		console.error("[ACP] Initialization failed (non-blocking):", err);
	}

	// Refresh model registry on first startup (non-blocking)
	refreshModelsOnFirstStartup().catch((err) => {
		console.error("[Models] First-startup refresh failed (non-blocking):", err);
	});


	// Gateway is an Electron-hosted service. Enable from Settings > Channels
	// or with legacy gateway env vars so IM messages enter the real onething runtime.
	initializeGateway().catch((err) => {
		console.error("[Gateway] Initialization failed (non-blocking):", err);
	});

	// Plugin roots can contribute skills, so load skills after plugin bootstrap
	// has had a chance to register its roots.
	pluginsReady.finally(() => {
		initializeSkills().catch((err) => {
			console.error("[Skills] Initialization failed (non-blocking):", err);
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
		warmTodoPlanWindow: () =>
			warmTodoPlanWindow({
				activation: "preserve-current-app",
				preserveMainWindowVisibility: true,
			}),
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
	});
	configureVoiceTray({
		getVoiceState: () => getSettings().voice,
		shutdownVoiceService: () => getVoiceServiceSafe()?.shutdown(),
	});

	// Embedded browser: views attach to the main window's contentView. Provider
	// is lazy — consulted per createTab, when the window already exists.
	configureBrowserWindowProvider(() => mainWindow);

	configureAppLoggingHost({
		setAppLogsPath: setElectronAppLogsPath,
		createRendererConsoleCapture: createElectronRendererConsoleCapture,
	});
	configureSkillsEnvironmentHost({
		isPackaged: getElectronAppIsPackaged,
		getResourcesPath: getElectronResourcesPath,
	});
	configureAuthHost({
		authFetch: createElectronAuthFetch({
			fallbackFetch: createRequiredAppFetch({ policy: "auth" }),
		}),
		tokenCryptoAdapter: getElectronSafeStorage,
	});
	configureVoiceHost({
		broadcastMessage: broadcastElectronVoiceMessage,
		runtimeWindow: {
			ensure: () => void ensureVoiceRuntimeWindow(),
			destroy: destroyVoiceRuntimeWindow,
			sendCommand: sendVoiceRuntimeCommand,
			markReady: markVoiceRuntimeReady,
			isReady: isVoiceRuntimeReady,
			flushCommands: flushVoiceRuntimeCommands,
		},
		updateTray: updateVoiceTray,
	});
	initializeAppLogging();
	// 宿主版本是 minAppVersion 判定的唯一输入 —— 只有宿主自己知道它
	// (打包后 package.json 不在可预测的相对位置)。没配 = 判定跳过。
	configurePluginAppVersion(getElectronAppVersion());
	// MCP clientInfo 同一条晚绑线:产品名固定在 identity 默认值里,版本只有宿主知道。
	configureMCPClientIdentity({ version: getElectronAppVersion() });

	// Suppress security warnings in development mode. Vite HMR needs unsafe-eval;
	// production builds use strict CSP and do not show these warnings.
	if (process.env.NODE_ENV === "development") {
		process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
	}

	registerElectronAppBootstrap({
		storePathHost: { configureStorePathHost },
		ready: {
			configureSandboxHost,
			hydratePackagedEnvironment: async () => {
				await hydrateProcessEnvFromLoginShell({ logger: console });
				markStartup("login-shell-env-hydrated");
			},
			acquireDesktopStoreLock,
			formatDesktopStoreLockError: formatElectronDesktopStoreLockError,
		},
		// files/ 与 images/ 并列供给:非图片资产(拖放进来的 PDF/音视频)也要能被
		// `media://` 取到,否则面板里只有图片有预览。
		mediaProtocol: { getMediaImagesDir, getMediaFilesDir },
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
			shutdownGateway,
			shutdownMCP,
			shutdownACP,
			killTrackedDetachedChildren,
			killAllTerminals,
			killAllBrowserTabs,
			// 插件系统:桌面宿主是**唯一真的跑插件的宿主**,它的退出路径就是这张表。
			//
			// 两条日志都是有意的:`shutdown()` 自己一行不打,于是真机走查时
			// "app.log 里没有 [PluginManager]"既可能是没跑到、也可能是跑了但沉默 ——
			// 那次诊断为此多花了一整轮。现在退出路径在日志里是可判定的。
			shutdownPlugins: () => {
				const manager = getPluginManager();
				if (!manager) {
					console.log(
						"[PluginManager] Shutdown skipped: the plugin system was never bootstrapped",
					);
					return;
				}
				manager.shutdown();
				console.log("[PluginManager] Shut down");
			},
			shutdownStreamEngine,
			shutdownPermission: () => Permission.shutdown(),
			shutdownSessionLayer,
			shutdownEventSystem,
			flushAllPendingSaves,
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
			console.log(formatStartupSummary());
			getVoiceService().applySettings();
		},
		startPostWindowServices,
	});
}

export { mainWindow };
