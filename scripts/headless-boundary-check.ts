import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()

// cordis 是**装配层专属**依赖（C0 底座替换，
// docs/design/cordis-adoption-2026-08.md §1）：只允许出现在
// packages/backend/**。core 保持零依赖、runtime 产品层保持纯
// 库、hosts 与 renderer 一概不感知 —— 写法照搬 electron 禁令。
const CORDIS_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]@deepseek-ai\/cordis['"]/,
  /import\(['"]@deepseek-ai\/cordis['"]\)/,
  /require\(['"]@deepseek-ai\/cordis['"]\)/,
]

const CORE_FORBIDDEN_PATTERNS: RegExp[] = [
  ...CORDIS_FORBIDDEN_PATTERNS,
  /from\s+['"]electron['"]/,
  /require\(['"]electron['"]\)/,
  /src\/main/,
  /src\/shared/,
  /shared\/ipc/,
  /\.\.\/\.\.\/shared/,
  /\.\.\/\.\.\/\.\.\/shared/,
  /better-sqlite3/,
  /@modelcontextprotocol\/sdk/,
  /@modelcontextprotocol\/client/,
  /@agentclientprotocol\/sdk/,
  /from\s+['"]zod['"]/,
  /from\s+['"]diff['"]/,
  /from\s+['"]uuid['"]/,
]

const HOST_BOUNDARY_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /require\(['"]electron['"]\)/,
  /src\/main/,
  /src\/shared/,
  /shared\/ipc/,
  /\.\.\/\.\.\/shared/,
  /\.\.\/\.\.\/\.\.\/shared/,
]

const MAIN_DIRECT_ELECTRON_IMPORT_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /import\(['"]electron['"]\)/,
  /require\(['"]electron['"]\)/,
]

const MAIN_APP_BOOTSTRAP_FORBIDDEN_PATTERNS: RegExp[] = [
  /@onething\/electron-host\/app\/activate/,
  /@onething\/electron-host\/app\/before-quit/,
  /@onething\/electron-host\/app\/did-become-active/,
  /@onething\/electron-host\/app\/ready/,
  /@onething\/electron-host\/app\/window-all-closed/,
  /@onething\/electron-host\/media\/protocol/,
  /@onething\/electron-host\/power\/resume/,
  /createAndBindElectronMainWindow/,
  /registerElectronActivateHandler/,
  /registerElectronBeforeQuitCleanup/,
  /registerElectronDidBecomeActiveHandler/,
  /configureElectronStorePathHost/,
  /registerElectronReadyHandler/,
  /registerElectronWindowAllClosedHandler/,
  /registerElectronMediaProtocol/,
  /registerElectronPowerResumeHandlers/,
]

const ELECTRON_MAIN_ENTRY_FORBIDDEN_PATTERNS: RegExp[] = [
  /index:\s*resolve\(__dirname,\s*['"]src\/main\/index\.ts['"]\)/,
]

const ELECTRON_PRELOAD_ENTRY_FORBIDDEN_PATTERNS: RegExp[] = [
  /index:\s*resolve\(__dirname,\s*['"]src\/preload\/index\.ts['"]\)/,
]

const GATEWAY_CORE_DEPENDENCY_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]@onething\/core(?!\/gateway-runtime['"])(?:\/[^'"]*)?['"]/,
]

const GATEWAY_RUNTIME_DEPENDENCY_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]@onething\/runtime['"]/,
  /from\s+['"]@onething\/runtime\/[^'"]+['"]/,
  /"@onething\/runtime"/,
]

const GATEWAY_STANDALONE_AGENT_FORBIDDEN_PATTERNS: RegExp[] = [
  /AgentEngine/,
  /createOnethingRuntime/,
  /createOnethingRuntimeFromStreamRuntime/,
  /new\s+CoreStreamEngine/,
  /Standalone Gateway no longer creates its own AgentEngine/,
]

const GATEWAY_BRIDGE_TYPING_FORBIDDEN_PATTERNS: RegExp[] = [
  /text:\s*['"]['"]/,
  /typing placeholder/,
]

const GATEWAY_CHANNEL_SELECTION_FORBIDDEN_PATTERNS: RegExp[] = [
  /gateway\.register\(new WechatChannel\(\)\)/,
]

/**
 * 这三张表只喂 `matchingImportSpecifierLines` —— 匹配的是 import/require 的说明符,
 * 不是整行。注释里的交叉引用、静态扫描测试里的 `path.join(REPO_ROOT, 'packages/core/…')`
 * 都不算命中;`packages/backend`(P3'd 前的 `src/app`)是独立的 workspace 包,它进
 * runtime 走 `@onething/runtime/<sub>` 包说明符,天然不含这串字面量。
 */
const MAIN_RUNTIME_SOURCE_IMPORT_FORBIDDEN_PATTERNS: RegExp[] = [
  /packages\/onething-runtime\/src/,
]

const MAIN_CORE_SOURCE_IMPORT_FORBIDDEN_PATTERNS: RegExp[] = [
  /packages\/core\//,
]

const MAIN_SESSION_COMMAND_HANDLER_FORBIDDEN_PATTERNS: RegExp[] = [
  /const\s+\{\s*getEventBus\s*\}\s*=\s*await\s+import\(['"]\.\.\/events\/index\.js['"]\)/,
  /const\s+result\s*=\s*await\s+eventBus\.emit\(sessionId,\s*command\)/,
  /return\s+\{\s*success:\s*true,\s*result\s*\}/,
  /\[IPC\]\s+session:command handler error/,
  /Failed to handle command/,
]

const MAIN_SAFE_SESSION_EVENT_EMIT_FORBIDDEN_PATTERNS: RegExp[] = [
  /try\s*\{\s*\n\s*await\s+getEventBus\(\)\.emit\(sessionId,\s*event\)/,
  /console\.error\(['"]\[ChatIPC\]\s+EventBus emit failed:/,
]

const MAIN_GATEWAY_SOURCE_IMPORT_FORBIDDEN_PATTERNS: RegExp[] = [
  /packages\/gateway\/src/,
]

const MAIN_GATEWAY_ENABLEMENT_FORBIDDEN_PATTERNS: RegExp[] = [
  /GATEWAY_CHANNELS/,
  /GATEWAY_TELEGRAM_BOT_TOKEN/,
  /TELEGRAM_BOT_TOKEN/,
  /function\s+isTruthyGatewayValue/,
  /function\s+isSupportedGatewayChannel/,
]

const MAIN_GATEWAY_LIFECYCLE_FORBIDDEN_PATTERNS: RegExp[] = [
  /let\s+gatewayRuntime/,
  /let\s+starting/,
  /await\s+import\(['"]@onething\/gateway['"]\)/,
  /startGateway\(\{/,
  /runtime:\s*getConversationRuntime\(\)/,
  /runtime\.gateway\.stop\(\)/,
  /\[Gateway\]\s+Started from Electron main process/,
]

const ELECTRON_GATEWAY_LIFECYCLE_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"].*src\/main/,
  /from\s+['"]@main\//,
]

const VOICE_RUNTIME_WINDOW_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /new\s+BrowserWindow\(/,
  /let\s+runtimeWindow/,
  /let\s+runtimeReady/,
  /pendingCommands/,
  /\.on\(['"]closed['"]/,
  /\.loadURL\(/,
  /\.loadFile\(/,
  /webContents\.send\(IPC_CHANNELS\.VOICE_RUNTIME_COMMAND/,
  /\.destroy\(\)/,
]

const VOICE_EVENT_BROADCAST_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /BrowserWindow\.getAllWindows\(\)/,
  /webContents\.send\(/,
  /type\s+WebContents/,
]

const VOICE_TRAY_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /new\s+Tray/,
  /Menu\.buildFromTemplate/,
  /nativeImage\.createFromPath/,
  /nativeImage\.createEmpty/,
  /app\.quit\(\)/,
  /tray\.setContextMenu/,
  /tray\?\.destroy/,
  /mainWindow\.show\(\)/,
  /mainWindow\.focus\(\)/,
]

const MAIN_MEDIA_PROTOCOL_FORBIDDEN_PATTERNS: RegExp[] = [
  /protocol\.handle\(['"]media['"]/,
  /media:\/\/['"]\.length/,
  /pathToFileURL\(filePath\)/,
  /net\.fetch\(pathToFileURL/,
]

const MAIN_LOGGING_ELECTRON_CAPTURE_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /type\s+WebContents/,
  /Electron\.Event/,
  /app\.setAppLogsPath/,
  /app\.on\(['"]web-contents-created['"]/,
  /app\.off\(['"]web-contents-created['"]/,
  /function\s+attachWebContentsLogging/,
  /webContents\.on\(['"]console-message['"]/,
  /renderer:\$\{webContents\.id\}/,
]

const MAIN_ACCESSIBILITY_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /systemPreferences/,
  /shell\.openExternal/,
  /isTrustedAccessibilityClient/,
  /x-apple\.systempreferences/,
  /process\.platform\s*===\s*['"]darwin['"]/,
  /process\.platform\s*!==\s*['"]darwin['"]/,
]

/**
 * 结构债 P4 终态批 A1-b 之后的**反向棘轮**:这四条通道名从此不该在 apps/electron
 * 的源码树里出现 —— 前三条走 `shellRouter`、第四条走 `windowRouter`,都不再有
 * 自己的 `ipcMain.handle`。它们从来不在 `IPC_CHANNELS` 表上,所以 transport 门
 * 数不到,只有这条断言拦得住它们长回来。
 */
const LEGACY_SHELL_LITERAL_CHANNEL_PATTERNS: RegExp[] = [
  /['"`]shell:open-path['"`]/,
  /['"`]shell:open-external['"`]/,
  /['"`]app:get-data-path['"`]/,
  /['"`]window:set-button-visibility['"`]/,
]

const MAIN_SHELL_OPERATIONS_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /ipcMain\.handle/,
  /from\s+['"]path['"]/,
  /from\s+['"]os['"]/,
  /@onething\/electron-host\/shell\/operations/,
  /from\s+['"]electron['"].*\bshell\b/,
  /from\s+['"]electron['"].*\bBrowserWindow\b/,
  /openElectron(Path|External)/,
  /shell\.openPath/,
  /shell\.openExternal/,
  /BrowserWindow\.fromWebContents/,
  /setWindowButtonVisibility/,
  /setWindowButtonPosition/,
  /process\.platform\s*===\s*['"]darwin['"]/,
]

const MAIN_NETWORK_PROXY_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /session\.defaultSession/,
  /\.setProxy\(\{\s*mode:/,
  /mode:\s*['"]fixed_servers['"]/,
  /mode:\s*['"]direct['"]/,
]

const MAIN_GLOBAL_SHORTCUTS_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /globalShortcut\./,
  /registeredAccelerators/,
  /function\s+normalizeKey/,
  /function\s+unregisterWindowShortcuts/,
  /function\s+registerWindowShortcut/,
  /process\.platform\s*===\s*['"]darwin['"]/,
]

const MAIN_POWER_RESUME_FORBIDDEN_PATTERNS: RegExp[] = [
  /powerMonitor/,
  /powerMonitor\.on\(['"]resume['"]/,
  /powerMonitor\.on\(['"]unlock-screen['"]/,
  /recoverMainWindowAfterSystemResume\(mainWindow,\s*['"]resume['"]\)/,
  /recoverMainWindowAfterSystemResume\(mainWindow,\s*['"]unlock-screen['"]\)/,
  /\[Window\]\s+Resume recovery failed/,
  /\[Window\]\s+Unlock recovery failed/,
]

const MAIN_WINDOW_ALL_CLOSED_FORBIDDEN_PATTERNS: RegExp[] = [
  /app\.on\(['"]window-all-closed['"]/,
  /process\.platform\s*!==\s*['"]darwin['"]/,
]

const MAIN_DID_BECOME_ACTIVE_FORBIDDEN_PATTERNS: RegExp[] = [
  /app\.on\(['"]did-become-active['"]/,
  /BrowserWindow\.getFocusedWindow\(\)/,
  /isTodoPlanBrowserWindow\(focusedWindow\)/,
]

const MAIN_BEFORE_QUIT_FORBIDDEN_PATTERNS: RegExp[] = [
  /app\.on\(['"]before-quit['"]/,
  /^\s*markVoiceQuitRequested\(\)/,
  /^\s*getVoiceService\(\)\.shutdown\(\)/,
  /^\s*await\s+shutdownGateway\(\)/,
  /^\s*await\s+shutdownMCP\(\)/,
  /^\s*await\s+shutdownACP\(\)/,
  /^\s*killTrackedDetachedChildren\(\)/,
  /^\s*shutdownStreamEngine\(\)/,
  /^\s*Permission\.shutdown\(\)/,
  /^\s*await\s+flushAllPendingSaves\(\)/,
  /^\s*await\s+shutdownAppLogging\(\)/,
]

const MAIN_ACTIVATE_FORBIDDEN_PATTERNS: RegExp[] = [
  /app\.on\(['"]activate['"]/,
  /if\s*\(mainWindow\s*===\s*null\)\s*\{/,
  /^\s*if\s*\(shouldSuppressMainWindowActivation\(\)\)\s*\{/,
  /^\s*mainWindow\s*=\s*createWindow\(\)/,
  /^\s*attachVoiceTrayMainWindow\(mainWindow\)/,
  /^\s*registerGlobalWindowShortcuts\(mainWindow\)/,
  /^\s*initializeIPCBridge\(mainWindow\.webContents\)/,
  /^\s*getStreamEngine\(\)\.bind\(mainWindow\.webContents\)/,
  /^\s*activateMainWindow\(mainWindow\)/,
]

const MAIN_READY_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /@main\/utils\/login-shell-env/,
  /app\.on\(['"]ready['"]/,
  /dialog\.showErrorBox/,
  /app\.quit\(\)/,
  /app\.isPackaged/,
  /app\.getPath/,
  /process\.resourcesPath/,
]

const MAIN_WINDOW_BINDING_FORBIDDEN_PATTERNS: RegExp[] = [
  /^\s*mainWindow\s*=\s*createWindow\(\)/,
  /^\s*attachVoiceTrayMainWindow\(mainWindow\)/,
  /^\s*registerGlobalWindowShortcuts\(mainWindow\)/,
  /^\s*initializeIPCBridge\(mainWindow\.webContents\)/,
  /^\s*getStreamEngine\(\)\.bind\(mainWindow\.webContents\)/,
  /^\s*mainWindow\.on\(['"]closed['"]/,
  /^\s*getVoiceService\(\)\.attachMainWindow\(mainWindow\)/,
  /^\s*warmSearchWindow\(mainWindow\)/,
  /^\s*warmTodoPlanWindow\(\{/,
]

const WINDOW_APPLICATION_MENU_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"].*\bMenu\b/,
  /from\s+['"]electron['"].*\bapp\b/,
  /function\s+setupApplicationMenu/,
  /MenuItemConstructorOptions/,
  /Menu\.buildFromTemplate/,
  /Menu\.setApplicationMenu/,
  /app\.name/,
]

const WINDOW_SESSION_SECURITY_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"].*\bsession\b/,
  /\btype\s+Session\b/,
  /function\s+setupContentSecurityPolicy/,
  /function\s+setupMediaPermissions/,
  /mediaPermissionHandlersRegistered/,
  /session\.defaultSession/,
  /webRequest\.onHeadersReceived/,
  /setPermissionRequestHandler/,
  /setPermissionCheckHandler/,
]

const WINDOW_EXTERNAL_LINKS_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"].*\bshell\b/,
  /shell\.openExternal/,
  /webContents\.on\(['"]will-navigate['"]/,
  /setWindowOpenHandler/,
]

const WINDOW_MAIN_RECOVERY_FORBIDDEN_PATTERNS: RegExp[] = [
  /MAIN_WINDOW_HEALTH_CHECK_SCRIPT/,
  /MAIN_WINDOW_RELOAD_DEBOUNCE_MS/,
  /type\s+MainWindowRendererHealth/,
  /lastMainWindowRendererReloadAt/,
  /function\s+reloadMainWindowRenderer/,
  /function\s+requestMainWindowRepaint/,
  /function\s+getMainWindowRendererHealth/,
  /function\s+isHealthyMainWindowRenderer/,
  /function\s+attachMainWindowRecovery/,
  /mainWindow\.webContents\.on\(['"]did-fail-load['"]/,
  /mainWindow\.webContents\.on\(['"]render-process-gone['"]/,
  /executeJavaScript\(MAIN_WINDOW_HEALTH_CHECK_SCRIPT/,
  /reloadIgnoringCache\(\)/,
]

const WINDOW_SETTINGS_WINDOW_FORBIDDEN_PATTERNS: RegExp[] = [
  /new\s+BrowserWindow\(/,
  /settingsWindow\.once\(['"]ready-to-show['"]/,
  /settingsWindow\.on\(['"]closed['"]/,
  /#\/settings/,
  /settingsWindow\.loadURL/,
  /settingsWindow\.loadFile/,
  /settingsWindow\.webContents\.on\(['"]did-fail-load['"]/,
]

const WINDOW_IMAGE_PREVIEW_WINDOW_FORBIDDEN_PATTERNS: RegExp[] = [
  /new\s+BrowserWindow\(/,
  /imagePreviewWindow\.webContents\.send/,
  /imagePreviewWindow\.webContents\.once\(['"]dom-ready['"]/,
  /imagePreviewWindow\.once\(['"]ready-to-show['"]/,
  /imagePreviewWindow\.on\(['"]closed['"]/,
  /imagePreviewWindow\.loadURL/,
  /imagePreviewWindow\.loadFile/,
  /imagePreviewWindow\.restore\(\)/,
  /imagePreviewWindow\.show\(\)/,
  /imagePreviewWindow\.focus\(\)/,
]

const WINDOW_MAIN_WINDOW_FORBIDDEN_PATTERNS: RegExp[] = [
  /new\s+BrowserWindow\(/,
  /mainWindow\.once\(['"]ready-to-show['"]/,
  /mainWindow\.on\(['"]resize['"]/,
  /mainWindow\.on\(['"]move['"]/,
  /mainWindow\.on\(['"]close['"]/,
  /mainWindow\.maximize\(\)/,
  /mainWindow\.webContents\.openDevTools\(\)/,
]

const WINDOW_TODO_PLAN_WINDOW_FORBIDDEN_PATTERNS: RegExp[] = [
  /new\s+BrowserWindow\(/,
  /todoPlanWindow\.once\(['"]ready-to-show['"]/,
  /todoPlanWindow\.on\(['"]resize['"]/,
  /todoPlanWindow\.on\(['"]move['"]/,
  /todoPlanWindow\.on\(['"]close['"]/,
  /todoPlanWindow\.on\(['"]closed['"]/,
  /todoPlanWindow\.loadURL/,
  /todoPlanWindow\.loadFile/,
  /webPreferences:\s*\{/,
]

const WINDOW_MACOS_PANEL_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]\.\/native\/macos-panel(?:\.js)?['"]/,
  /from\s+['"]\.\.\/native\/macos-panel(?:\.js)?['"]/,
]

const WINDOW_RENDERER_TARGETS_FORBIDDEN_PATTERNS: RegExp[] = [
  /function\s+isAppWebContents\b/,
  /function\s+getRendererDevUrl\b/,
  /mainWindow\.loadURL\(/,
  /mainWindow\.loadFile\(/,
]

const WINDOW_STATE_PERSISTENCE_FORBIDDEN_PATTERNS: RegExp[] = [
  /interface\s+WindowState\b/,
  /interface\s+WindowStateFile\b/,
  /const\s+defaultWindowState\b/,
  /const\s+defaultTodoPlanWindowState\b/,
  /function\s+sanitizeWindowState\b/,
  /readJsonFile<.*WindowState/,
  /writeJsonFile\(getWindowStatePath\(\)/,
]

const WINDOW_ACTIVATION_FORBIDDEN_PATTERNS: RegExp[] = [
  /suppressMainWindowActivationUntil/,
  /AUXILIARY_CLOSE_ACTIVATION_SUPPRESSION_MS/,
  /Date\.now\(\)\s*<\s*suppress/,
  /mainWindow\.isMinimized\(\)/,
  /mainWindow\.restore\(\)/,
  /mainWindow\.show\(\)/,
  /mainWindow\.focus\(\)/,
]

const WINDOW_VISIBILITY_SNAPSHOT_FORBIDDEN_PATTERNS: RegExp[] = [
  /interface\s+MainWindowVisibilitySnapshot/,
  /function\s+isMainAppWindow\b/,
  /BrowserWindow\.getAllWindows\(\)/,
  /hiddenMainWindows/,
  /for\s*\(const\s+delay\s+of\s+\[0,\s*80,\s*250,\s*600,\s*1200,\s*2400\]\)/,
  /item\.window\.hide\(\)/,
]

const WINDOW_TODO_PLAN_PRESENTATION_FORBIDDEN_PATTERNS: RegExp[] = [
  /interface\s+NormalizedTodoPlanWindowActionOptions/,
  /function\s+shouldPreserveCurrentMacApp/,
  /options\.activation\s*===\s*['"]preserve-current-app['"]/,
  /BrowserWindow\.getFocusedWindow\(\)/,
  /window\.showInactive\(\)/,
  /window\.moveTop\(\)/,
  /window\.show\(\)/,
  /window\.focus\(\)/,
  /isNonActivatingPanelFrontmost\(window\)\s*\|\|\s*window\.isFocused\(\)/,
]

const SEARCH_WINDOW_TARGET_FORBIDDEN_PATTERNS: RegExp[] = [
  /const\s+AUXILIARY_HASH_PREFIXES/,
  /function\s+isRendererWindowUrl\b/,
  /function\s+isMainAppWindowUrl\b/,
  /process\.env\.ELECTRON_RENDERER_URL/,
]

const SEARCH_WINDOW_LIFECYCLE_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /new\s+BrowserWindow\(/,
  /function\s+clearGuideHideTimer\b/,
  /function\s+applySearchWindowConstraints\b/,
  /function\s+getGuideParentWindow\b/,
  /function\s+emitSearchWindowGuides\b/,
  /function\s+updateSearchWindowGuides\b/,
  /function\s+positionSearchWindow\b/,
  /function\s+showSearchWindow\b/,
  /function\s+createSearchWindow\b/,
  /webContents\.send\(IPC_CHANNELS\.SEARCH_WINDOW/,
  /\.once\(['"]ready-to-show['"]/,
  /\.on\(['"]blur['"]/,
  /\.on\(['"]move['"]/,
  /\.on\(['"]resize['"]/,
  /\.on\(['"]closed['"]/,
  /\.loadURL\(/,
  /\.loadFile\(/,
  /\.setMinimumSize\(/,
  /\.setMaximumSize\(/,
  /\.setParentWindow\(/,
  /\.setBounds\(/,
  /\.show\(\)/,
  /\.focus\(\)/,
  /\.hide\(\)/,
]

const SEARCH_WINDOW_LAYOUT_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"].*\.\/window-layout/,
  /\bSearchWindowRectangle\b/,
  /\bSearchWindowSizeConstraints\b/,
  /DEFAULT_WIDTH_RATIO/,
  /DEFAULT_HEIGHT_RATIO/,
  /MAX_PARENT_WIDTH_RATIO/,
  /MAX_PARENT_HEIGHT_RATIO/,
  /DEFAULT_TOP_RATIO/,
  /PARENT_EDGE_PADDING/,
  /GUIDE_THRESHOLD/,
  /\bSEARCH_WINDOW_MIN_WIDTH\b/,
  /\bSEARCH_WINDOW_MIN_HEIGHT\b/,
  /\bSEARCH_WINDOW_MAX_DEFAULT_WIDTH\b/,
  /\bSEARCH_WINDOW_MAX_DEFAULT_HEIGHT\b/,
  /function\s+clamp\b/,
  /function\s+getSearchWindowSizeConstraints\b/,
  /function\s+getDefaultSearchWindowBounds\b/,
  /function\s+getSearchWindowGuideState\b/,
]

const SEARCH_WINDOW_ACTION_DELIVERY_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /from\s+['"].*window-selection/,
  /function\s+isMainAppWindow\b/,
  /function\s+findMainAppWindow\b/,
  /BrowserWindow\.getFocusedWindow\(\)/,
  /BrowserWindow\.getAllWindows\(\)/,
  /\.getParentWindow\(\)/,
  /webContents\.send\(IPC_CHANNELS\.SEARCH_ACTION/,
  /\.focus\(\)/,
  /No main app window found for action/,
]

const SEARCH_IPC_WINDOW_SOURCE_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /ipcMain\.handle/,
  /Electron\.IpcMainInvokeEvent/,
  /BrowserWindow\.fromWebContents/,
]

/**
 * 装配目录的两级禁令(08-21 P2/D 组重订)。
 *
 * 原来只有一张名单,禁的是 electron + fs/path + sqlite/MCP+ACP SDK。两处过期:
 * 1. `apps/electron/src/main/bridges` 在名单里 —— 那是 **Electron 宿主自己的桥**,
 *    禁它 import electron 是反的(`ipc-bridge-lifecycle.ts` 就要 `BrowserWindow`);
 * 2. 会话事件日志 / blob 仓、插件 loader+tarball+install、MCP OAuth 凭证盘存、
 *    会话仓储这些目录**本职就是文件 IO**,fs/path 是它们的工作而不是越界。
 *
 * 所以拆成两级:真该无宿主、无文件 IO 的目录走全套禁令;确有 IO 职责的目录只保留
 * "不碰 electron、不直连 better-sqlite3 / MCP+ACP SDK" 这一半。
 */
const MAIN_CORE_SYSTEM_DIRS = [
  'packages/backend/wiring/agent-loop',
  'packages/backend/wiring/engine',
  'packages/backend/events',
  // P3'a-3:`app/storage/` 已整只归位 `runtime/src/storage/storage-manager-bound.ts`
  // (除 consolePort 外零脊柱边),目录不复存在。
  'packages/backend/wiring/permission',
  'packages/backend/wiring/tools',
]

/** 有真实文件 IO 职责的装配目录:只禁宿主与原生 SDK,不禁 fs/path。 */
const MAIN_FILE_IO_SYSTEM_DIRS = [
  'packages/backend/session',
  'packages/backend/stores',
  // P3'b-A:`backend/mcp/` 整域归位 `runtime/src/mcp/`(闭包零脊柱边),
  // 装配层不再有 mcp 目录 —— 这一条随之退役。
  'packages/backend/wiring/plugins',
]

const MAIN_HOST_FORBIDDEN_IMPORT_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /require\(['"]electron['"]\)/,
  /better-sqlite3/,
  /@modelcontextprotocol\/sdk/,
  /@modelcontextprotocol\/client/,
  /@agentclientprotocol\/sdk/,
]

const MAIN_FILE_IO_FORBIDDEN_IMPORT_PATTERNS: RegExp[] = [
  /from\s+['"]node:fs['"]/,
  /from\s+['"]node:fs\/promises['"]/,
  /from\s+['"]node:path['"]/,
  /from\s+['"]fs['"]/,
  /from\s+['"]fs\/promises['"]/,
  /from\s+['"]path['"]/,
]

const MAIN_FORBIDDEN_IMPORT_PATTERNS: RegExp[] = [
  ...MAIN_HOST_FORBIDDEN_IMPORT_PATTERNS,
  ...MAIN_FILE_IO_FORBIDDEN_IMPORT_PATTERNS,
]

// P3'b-A:唯一一条豁免曾是 `backend/mcp/client.ts`(MCP SDK 适配器)。mcp 整域
// 归位产品层后,装配层已经没有任何目录需要豁免 —— 表留着,内容为空。
const MAIN_ADAPTER_ALLOWLIST = new Map<string, RegExp[]>([])

const CORE_PROMPT_ASSEMBLY_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]node:fs['"]/,
  /from\s+['"]node:os['"]/,
  /from\s+['"]node:path['"]/,
  /export\s+(async\s+)?function\s+buildPrompt/,
  /export\s+(async\s+)?function\s+buildSystemPrompt/,
  /export\s+function\s+loadAgentsMdInstructions/,
  /AGENTS\.md/,
  /Tool Guidelines:/,
]

const RUNTIME_STORAGE_PATH_CORE_PROXY_PATTERNS: RegExp[] = [
  /get[A-Z][A-Za-z0-9]+Path\s+as\s+getCore/,
  /get[A-Z][A-Za-z0-9]+Dir\s+as\s+getCore/,
  /getStoreDirs\s+as\s+getCoreStoreDirs/,
  /ensureStoreDirs\s+as\s+ensureCoreStoreDirs/,
  /type\s+CoreStorePathOptions/,
]

const SHARED_BACKEND_STORE_LOCK_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]node:fs['"]/,
  /from\s+['"]node:path['"]/,
  /class\s+StoreLock/,
  /class\s+LockConflictError/,
  /function\s+readLockMeta/,
  /function\s+isProcessAlive/,
  /function\s+formatCliLockConflict/,
  /function\s+formatDesktopLockConflict/,
  /getStorePath/,
  /getOnethingStorePath/,
]

const CORE_PERMISSION_FILE_STORAGE_FORBIDDEN_PATTERNS: RegExp[] = [
  /workspace-grants\.json/,
  /PermissionGrantFileStorageAdapters/,
  /PermissionGrantWorkspaceFile/,
  /getPermissionWorkspaceGrantsPath/,
  /createPermissionGrantFileStorage/,
  /configurePermissionGrantFileStorage/,
]

const MAIN_PERMISSION_IPC_GRANTS_FORBIDDEN_PATTERNS: RegExp[] = [
  /Failed to list permission grants/,
  /Failed to revoke permission grant/,
  /Failed to clear session grants/,
  /Failed to clear workspace grants/,
  /return\s+\{\s*success:\s*false,\s*error:/,
  /request\.sessionId\s*\?\s*PermissionGrants\.listSessionGrants/,
  /request\.workspaceRoot\s*\?\s*PermissionGrants\.listWorkspaceGrants/,
  /PermissionGrants\.revokeGrant\(request\.id\)/,
  /PermissionGrants\.clearSessionGrants\(request\.sessionId\)/,
  /PermissionGrants\.clearWorkspaceGrants\(request\.workspaceRoot\)/,
]

const MAIN_PERMISSION_IPC_SESSION_FORBIDDEN_PATTERNS: RegExp[] = [
  /Failed to get pending permissions/,
  /Failed to clear session/,
  /return\s+\{\s*success:\s*false,\s*error:/,
  /const\s+pending\s*=\s*Permission\.getPending\(sessionId\)/,
  /Permission\.clearSession\(sessionId\)/,
  /return\s+\{\s*success:\s*true,\s*pending\s*\}/,
]

const MAIN_PERMISSION_IPC_HOST_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /ipcMain\.handle/,
]

const MAIN_AGENTS_STORE_FORBIDDEN_PATTERNS: RegExp[] = [
  /readJsonFile/,
  /writeJsonFile/,
  /DEFAULT_AGENT_NAME/,
  /function\s+normalizeAgent/,
  /function\s+normalizeFile/,
]

const MAIN_AGENTS_IPC_OPERATIONS_FORBIDDEN_PATTERNS: RegExp[] = [
  /function\s+errorMessage/,
  /console\.error\(\s*['"]\[AgentsIPC\]/,
  /return\s+\{\s*success:\s*false,\s*error:/,
  /id:\s*`agent-\$\{uuidv4\(\)\}`/,
  /return\s+\{\s*success:\s*true,\s*agents:\s*listAgents\(\)\s*\}/,
  /return\s+\{\s*success:\s*true,\s*agent\s*\}/,
  /if\s*\(!agentId\)\s*throw new Error\('Agent id is required'\)/,
  /if\s*\(agentId\s*===\s*DEFAULT_AGENT_ID\)\s*throw/,
  /getSessionsList\(\)\.some/,
  /Agent is used by one or more sessions/,
  /^\s*deleteAgent\(agentId\)/,
]

const MAIN_AGENTS_IPC_HOST_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /ipcMain\.handle/,
]

const MAIN_APP_STATE_IPC_UI_SAVE_FORBIDDEN_PATTERNS: RegExp[] = [
  /saveAppState/,
  /saveOnethingUiState\(getAppStatePath\(\),\s*uiState\)/,
  /return\s+\{\s*success:\s*true\s*\}/,
  /const\s+state\s*=\s*getAppState\(\)/,
  /state\.openTabs\s*=/,
  /state\.activeTabIndex\s*=/,
  /state\.sidebarCollapsed\s*=/,
]

const MAIN_APP_STATE_IPC_HOST_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /ipcMain\.handle/,
]

const MAIN_SCHEDULER_IPC_OPERATIONS_FORBIDDEN_PATTERNS: RegExp[] = [
  /SchedulerIPC/,
  /return\s+\{\s*success:\s*false,\s*error:/,
  /return\s+\{\s*success:\s*true,\s*tasks:\s*getScheduler\(\)\.list\(\)\s*\}/,
  /const\s+task\s*=\s*getScheduler\(\)\.getStatus\(request\.id\)/,
  /const\s+record\s*=\s*await\s+getScheduler\(\)\.runNow/,
  /reason:\s*'manual'/,
  /force:\s*request\.force\s*\?\?\s*true/,
  /if\s*\(!isUserSchedulerTask\(request\.id\)\)/,
  /Plugin scheduled tasks cannot be edited/,
  /Plugin scheduled tasks cannot be deleted/,
  /const\s+savedRuns\s*=\s*listSchedulerRunDetails/,
  /Math\.max\(1,\s*Math\.min\(50/,
  /recentRuns\?\.\find/,
]

const MAIN_SCHEDULER_IPC_HOST_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /ipcMain\.handle/,
]

const MAIN_SCHEDULER_CORE_FORBIDDEN_PATTERNS: RegExp[] = [
  /SCHEDULER_STATE_VERSION/,
  /SCHEDULER_HEARTBEAT_MS/,
  /MAX_RUN_HISTORY/,
  /type\s+StoredTaskState/,
  /type\s+SchedulerStateFile/,
  /type\s+InternalTask/,
  /export\s+class\s+Scheduler/,
  /randomUUID/,
  /fs\.existsSync/,
  /fs\.writeFileSync/,
  /fs\.renameSync/,
  /computeInitialNextRunAt/,
  /computeFollowingNextRunAt/,
  /private\s+async\s+tick/,
  /private\s+async\s+runTask/,
  /private\s+recordRun/,
]

const MAIN_SCHEDULER_RUN_HISTORY_FORBIDDEN_PATTERNS: RegExp[] = [
  /MAX_RUN_HISTORY_PER_TASK/,
  /function\s+safeTaskFileName/,
  /function\s+runHistoryPath/,
  /function\s+readRuns/,
  /function\s+writeRuns/,
  /JSON\.parse\(line\)/,
  /JSON\.stringify\(run\)/,
  /fs\.readFileSync/,
  /fs\.writeFileSync/,
  /\.slice\(-MAX_RUN_HISTORY_PER_TASK\)/,
]

const MAIN_SCHEDULER_USER_TASK_STORE_FORBIDDEN_PATTERNS: RegExp[] = [
  /function\s+readTasksFile/,
  /function\s+writeTasksFile/,
  /function\s+normalizeStoredTask/,
  /function\s+normalizeSchedule/,
  /function\s+validateTaskInput/,
  /fs\.existsSync/,
  /fs\.readFileSync/,
  /fs\.writeFileSync/,
  /fs\.renameSync/,
  /JSON\.parse\(fs\.readFileSync/,
  /JSON\.stringify\(\{\s*version:\s*1,\s*tasks:/,
  /parseCronExpression\(expr\)/,
  /isValidTimezone\(timezone\)/,
  /agentExists\(agentId\)/,
]

const MAIN_SCHEDULER_RUN_DETAIL_FORBIDDEN_PATTERNS: RegExp[] = [
  /function\s+previewValue/,
  /function\s+toRunStep/,
  /function\s+toRunToolCall/,
  /export\s+function\s+genericRunDetailFromRecord/,
  /const\s+resultPreview\s*=/,
  /JSON\.stringify\(value\s*\?\?\s*''\)/,
  /argumentsPreview:\s*previewValue/,
  /resultPreview:\s*previewValue/,
  /status:\s*record\.skipped/,
]

const MAIN_SCHEDULER_AGENT_TASK_RUNNER_FORBIDDEN_PATTERNS: RegExp[] = [
  /const\s+terminal\s*=\s*new\s+Promise/,
  /eventBus\.onAny\(sessionId,\s*\(envelope/,
  /command:send-message/,
  /permission:blocked/,
  /Scheduled tasks can only use tools that were already authorized/,
  /stream:complete/,
  /stream:error/,
  /stream:aborted/,
  /getStreamEngineSafe\(\)\?\.abort/,
  /store\.createSession\(sessionId/,
  /assistantMessageId\s*=/,
  /failedTool\s*=/,
]

const MAIN_FILES_IPC_LIST_FORBIDDEN_PATTERNS: RegExp[] = [
  /function\s+getNoteRootLabel/,
  /function\s+getFileSearchRoots/,
  /function\s+entryMatchesQuery/,
  /const\s+files:\s*string\[\]/,
  /const\s+entries:\s*FileSearchEntry\[\]/,
  /const\s+searchRoots\s*=/,
  /for await\s*\(const file of listFiles/,
  /path\.join\(root\.path,\s*file\)/,
  /entries\.slice\(0,\s*limit\)/,
  /Failed to list files/,
  /console\.error\(\s*['"]\[Files IPC\] Failed to list files/,
]

const MAIN_FILES_IPC_DIRS_LIST_FORBIDDEN_PATTERNS: RegExp[] = [
  /let\s+expandedPath/,
  /const\s+pathStat/,
  /let\s+dirToList/,
  /filterPrefix/,
  /const\s+dirs:\s*string\[\]\s*=/,
  /entry\.name\.startsWith\('\.'\)/,
  /dirs\.sort\(\(a,\s*b\)\s*=>\s*path\.basename/,
  /Failed to list directories/,
  /console\.error\(\s*['"]\[Files IPC\] Failed to list directories/,
  // P4c 第八批:`basePath: ''` 从此不再是「适配层手搓响应」的信号 —— 它是
  // `files` 域夹紧失败时逐字沿用旧 server 路由的那个形状。判据交给上面几条
  // (真正的投影逻辑:filterPrefix / dirs.sort / 隐藏文件过滤)。
]

const MAIN_FILES_IPC_FILE_OPERATIONS_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"].*\bshell\b/,
  /shell\.showItemInFolder/,
  /function\s+looksBinary/,
  /const\s+isBinary\s*=/,
  /Path is not a file/,
  /File changed on disk\. Review before saving again\./,
  /Math\.abs\(.*mtimeMs/,
  /const\s+result:\s*DirectoryEntry\[\]/,
  /entry\.name\s*===\s*'node_modules'/,
  /entry\.name\s*===\s*'\.git'/,
  /entry\.isDirectory\(\)\s*\?\s*'directory'/,
  /result\.sort\(\(a,\s*b\)/,
  /type:\s*stats\.isDirectory\(\)\s*\?\s*'directory'\s*:\s*'file'/,
]

const MAIN_FILES_IPC_MUTATION_OPERATIONS_FORBIDDEN_PATTERNS: RegExp[] = [
  /await\s+fs\.writeFile\(request\.path/,
  /await\s+fs\.mkdir\(request\.path/,
  /await\s+fs\.rename\(request\.oldPath/,
  /await\s+fs\.rm\(request\.path/,
  /const\s+targetPath\s*=\s*request\.path/,
  /Path is required/,
  /Failed to create file/,
  /Failed to create directory/,
  /Failed to rename path/,
  /Failed to delete path/,
  /Failed to reveal path/,
]

const MAIN_FILES_IPC_ROLLBACK_FORBIDDEN_PATTERNS: RegExp[] = [
  /const\s+\{\s*auditPath,\s*filePath,\s*originalContent,\s*isNew\s*\}/,
  /File path or audit path is required/,
  /Legacy rollback path/,
  /restoredExists:\s*!isNew/,
  /Failed to rollback file/,
  /await\s+fs\.unlink\(filePath\)/,
  /fs\.writeFile\(filePath,\s*originalContent/,
]

const MAIN_FILES_IPC_WATCH_FORBIDDEN_PATTERNS: RegExp[] = [
  /Workspace root is required/,
  /recursive fs\.watch can overwhelm/,
  /void request/,
  /return\s+\{\s*success:\s*true\s*\}/,
]

const MAIN_RIPGREP_UTIL_FORBIDDEN_PATTERNS: RegExp[] = [
  /PLATFORM_CONFIG/,
  /RIPGREP_VERSION/,
  /downloadRipgrep/,
  /extractTarGz/,
  /extractZip/,
  /BlobReader/,
  /BlobWriter/,
  /ZipReader/,
  /spawn\(/,
  /parseOnethingRipgrepSearchOutput\s*\(/,
  /buildOnethingRipgrepFileListArgs\s*\(/,
  /buildOnethingRipgrepSearchArgs\s*\(/,
]

const MAIN_TOOL_SANDBOX_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"](?:node:)?os['"]/,
  /from\s+['"](?:node:)?path['"]/,
  /joinPaths/,
  /uniqueCorePaths/,
  /checkCoreFileAccess/,
  /expandCorePath/,
  /findCore(Read)?SandboxRootForPath/,
  /getCore(Read)?SandboxRoots/,
  /getCoreSandboxBoundary/,
  /isCorePathContained/,
  /resolveCoreToolPath/,
  /os\.homedir/,
  /['"]Downloads['"]/,
  /function\s+getConfiguredDefaultWorkingDirectory/,
]

const MAIN_TOOL_EDIT_ENGINE_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]diff['"]/,
  /createTwoFilesPatch/,
  /prepareExactEditPreview/,
  /applyExactEditsToNormalizedContent/,
  /interface\s+ExactEditPreviewResult/,
  /function\s+previewExactEdits/,
]

const MAIN_AUTH_TOKEN_STORE_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /require\(['"]electron['"]\)/,
  /createRequire\b/,
  /from\s+['"]node:fs['"]/,
  /from\s+['"]node:fs\/promises['"]/,
  /from\s+['"]node:os['"]/,
  /from\s+['"]node:path['"]/,
  /from\s+['"]fs['"]/,
  /from\s+['"]fs\/promises['"]/,
  /from\s+['"]os['"]/,
  /from\s+['"]path['"]/,
  /existsSync/,
  /readFile/,
  /writeFile/,
  /oauth-tokens\.json/,
  /function\s+getSafeStorage/,
  /safeStorage/,
]

const MAIN_AUTH_SERVICE_RUNTIME_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /require\(['"]electron['"]\)/,
  /createRequire\b/,
  /from\s+['"]uuid['"]/,
  /flows\s*=\s*new Map/,
  /providerFlowIds\s*=\s*new Map/,
  /providerErrors\s*=\s*new Map/,
  /startDeviceFlow/,
  /completeAuthorizationCodeFlow/,
  /buildAuthorizationUrl/,
  /normalizeToken/,
  /requireDefinition/,
  /getFlow/,
  /clearFlow/,
  /FLOW_TIMEOUT_MS/,
  /REFRESH_BUFFER_MS/,
  /getElectronNetFetch/,
  /function\s+getElectronNetFetch/,
  /electron\.net/,
  /net\?\.fetch/,
]

const MAIN_AUTH_CALLBACK_SERVER_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]node:http['"]/,
  /from\s+['"]http['"]/,
  /http\.createServer/,
  /server\.listen/,
  /servers\s*=\s*new Map/,
  /registrations\s*=\s*new Map/,
  /function\s+handleRequest/,
  /writeCallbackPage/,
  /Authorization Complete/,
  /OAuth callback processing failed/,
]

const MAIN_OAUTH_IPC_OPERATIONS_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"].*\bBrowserWindow\b/,
  /from\s+['"]electron['"].*\bshell\b/,
  /BrowserWindow\.getAllWindows/,
  /webContents\.send\(IPC_CHANNELS\.OAUTH_TOKEN_/,
  /shell\.openExternal/,
  /OAuth start failed/,
  /Poll failed/,
  /Refresh failed/,
  /Status check failed/,
  /Logout failed/,
  /authService\.start\(request\.providerId\)/,
  /authService\.pollDeviceFlow\(request\.providerId/,
  /authService\.refreshToken\(request\.providerId\)/,
  /authService\.getStatus\(request\.providerId\)/,
  /authService\.deleteToken\(request\.providerId\)/,
  /const\s+url\s*=\s*response\.authUrl\s*\|\|\s*response\.verificationUri/,
  /return\s+\{\s*success:\s*true\s*\}/,
  /success:\s*false,\s*completed:\s*false/,
  /isLoggedIn:\s*false/,
]

const MAIN_STREAM_RUNTIME_WIRING_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]@onething\/runtime['"]/,
  /createOnethingProductStreamRuntime\s*</,
  /createOnethingStreamEngineRuntime/,
  /createOnethingStreamProviderAdapter/,
  /StreamEngineProviderAdapter/,
  /StreamEngineHistoryAdapter/,
  /StreamEngineMediaAdapter/,
  /StreamEnginePromptAdapter/,
  /StreamEngineSkillsAdapter/,
  /StreamEngineStreamsAdapter/,
]

const MAIN_HISTORY_HELPER_CORE_WIRING_FORBIDDEN_PATTERNS: RegExp[] = [
  /buildHistoryMessages\s+as\s+buildCoreHistoryMessages/,
  /buildResumeHistoryAfterToolConfirmation\s+as\s+buildCore/,
  /filterHistoryForNonToolAPI\s+as\s+filterCore/,
]

const MAIN_AGENT_LOOP_RUNTIME_WIRING_FORBIDDEN_PATTERNS: RegExp[] = [
  /agentLoopInitSkills/,
  /message:user-created/,
  /skillsForRefs/,
  /enableSkills\s*!==\s*false/,
]

const MAIN_AGENT_LOOP_SELECTION_FORBIDDEN_PATTERNS: RegExp[] = [
  /resolveAgentLoopStreamRoute\s+as\s+resolveCoreAgentLoopStreamRoute/,
  /shouldUseAgentLoopStream\s+as\s+shouldUseCoreAgentLoopStream/,
  /getSupportedAgentProviderRuntimeIds/,
  /isAgentProviderRuntimeSupported/,
]

const MAIN_PROVIDER_REQUEST_DUMP_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]fs/,
  /from\s+['"]node:fs/,
  /from\s+['"]path['"]/,
  /from\s+['"]node:path['"]/,
  /requestDumpDir/,
  /safeFilenamePart/,
  /stringifyForDump/,
  /ONETHING_DUMP_PROVIDER_REQUESTS/,
]

const MAIN_PROVIDER_REGISTRY_FORBIDDEN_PATTERNS: RegExp[] = [
  /new\s+Map\s*<\s*string\s*,\s*ProviderDefinition\s*>/,
  /providers\.has\(/,
  /providers\.set\(/,
  /providers\.delete\(/,
  /providers\.values\(/,
  /providerId\.startsWith\(['"]custom-/,
  /Provider \$\{definition\.id\} is already registered/,
]

const MAIN_PROVIDER_TYPES_FORBIDDEN_PATTERNS: RegExp[] = [
  /export\s+interface\s+ProviderInfo\b/,
  /export\s+interface\s+ProviderConfig\b/,
  /export\s+interface\s+ProviderToolSchema\b/,
  /export\s+interface\s+ProviderToolCallOption\b/,
  /export\s+interface\s+ProviderOptionsMap\b/,
  /export\s+interface\s+ProviderCallOptions\b/,
  /export\s+interface\s+ProviderCallPreparationContext\b/,
  /export\s+interface\s+ProviderDefinition\b/,
  /export\s+type\s+ProviderCallMode\s*=\s*['"]/,
  /\|\s+['"]required['"]\s*\n\s*\|\s+\{\s*type:\s*['"]auto['"]\s*\}/,
]

const MAIN_PROVIDERS_IPC_USAGE_FORBIDDEN_PATTERNS: RegExp[] = [
  /function\s+toUsageAccount/,
  /providerId\s*!==\s*['"]codex['"]/,
  /refreshTokenIfNeeded\(AIProvider\.Codex\)/,
  /fetchCodexUsage\(token\)/,
  /capturedAt:\s*Date\.now\(\)/,
  /isFedramp:\s*token\.isFedrampAccount/,
]

const MAIN_PROVIDER_OAUTH_CONFIG_FORBIDDEN_PATTERNS: RegExp[] = [
  /if\s*\(!requiresOAuth\(providerId\)\)/,
  /oauthManager\.refreshTokenIfNeeded\(providerId\)/,
  /Failed to get OAuth config for/,
  /apiKey:\s*token\.accessToken/,
]

const MAIN_PROVIDER_FACADE_LOW_LEVEL_FORBIDDEN_PATTERNS: RegExp[] = [
  /generateWithOnethingDeepSeekAgent/,
  /generateOnethingChatResponseWithReasoning/,
  /generateOnethingProviderChatTitle/,
  /generateOnethingTextChatResponse/,
  /mergeOnethingSystemMessagesForGenerateIfNeeded/,
  /onethingToolChatMessagesFromUIMessages/,
  /streamOnethingACPChatResponseWithTools/,
  /streamOnethingDeepSeekAgentTurn/,
  /runOnethingUtilityAgentTurn/,
  /streamOnethingChatResponseWithReasoning/,
  /streamOnethingChatResponseWithTools/,
  /streamOnethingTextChatResponse/,
  /streamOnethingAgentProviderToolTurn/,
  /streamOnethingUtilityAgentTurn/,
]

const MAIN_PROVIDER_TITLE_ORCHESTRATION_FORBIDDEN_PATTERNS: RegExp[] = [
  /buildOnethingChatTitleGenerationRequest/,
  /cleanOnethingGeneratedChatTitle/,
  /fallbackOnethingACPChatTitle/,
  /debugPurpose:\s*['"]chat-title['"]/,
]

const MAIN_PROVIDER_TEXT_RESPONSE_PROJECTION_FORBIDDEN_PATTERNS: RegExp[] = [
  /const\s+result\s*=\s*await\s+generateChatResponseWithReasoning\(/,
  /for await\s*\(const chunk of streamChatResponseWithReasoning\(/,
  /chunk\.type === ["']text["'] && \(chunk\.text \|\| chunk\.reasoning\)/,
]

const MAIN_PROVIDER_GENERATE_REASONING_ORCHESTRATION_FORBIDDEN_PATTERNS: RegExp[] = [
  /if\s*\(isACPProvider\(providerId\)\)/,
  /let\s+reasoning\s*=\s*["']/,
  /for await\s*\(const chunk of streamACPChatResponseWithTools\(/,
  /Provider \$\{providerId\} does not have an AgentProvider runtime for generate\./,
]

const MAIN_PROVIDER_ACP_STREAM_PROJECTION_FORBIDDEN_PATTERNS: RegExp[] = [
  /getLatestUserMessageText\(messages\)/,
  /ACP prompt is empty/,
  /const\s+localSessionId\s*=\s*options\.debugSessionId/,
  /event\.notification\.update/,
  /mapACPStopReason\(event\.stopReason\)/,
  /formatACPPlan\(update\)/,
  /formatACPTool\(update\)/,
]

const MAIN_EMBEDDINGS_RUNTIME_FORBIDDEN_PATTERNS: RegExp[] = [
  /function\s+configForProvider/,
  /function\s+firstOpenAICompatibleCustom/,
  /function\s+resolveConfiguredProvider/,
  /function\s+resolveAutoProvider/,
  /function\s+vectorsFromOpenAIResponse/,
  /function\s+vectorsFromGeminiResponse/,
  /function\s+embedOpenAICompatible/,
  /function\s+embedGemini/,
  /batchEmbedContents/,
  /\}\/embeddings/,
  /settings\.ai\.providers/,
]

const MAIN_DIRECT_TOOL_EXECUTION_FORBIDDEN_PATTERNS: RegExp[] = [
  /executeCoreDirectTool/,
  /createExecutionContext:\s*source\s*=>/,
  /approvedAnalysis:\s*\{/,
]

const SHARED_TOOL_FAILURE_PARAMETERS_FORBIDDEN_PATTERNS: RegExp[] = [
  /interface\s+ToolFailureParameterSummary/,
  /function\s+summarizeToolFailureParameters/,
  /function\s+shortPath/,
  /normalizedToolName\s*===\s*['"]edit['"]/,
  /normalizedToolName\s*===\s*['"]bash['"]/,
  /preferredKeys\s*=\s*\[/,
]

const SHARED_TOOL_ERRORS_FORBIDDEN_PATTERNS: RegExp[] = [
  /const\s+DEFAULT_PERMISSION_REJECTED_MESSAGE/,
  /function\s+formatPermissionRejectedMessage/,
  /trimmedReason/,
  /Reason:\s*\$\{trimmedReason\}/,
]

const CORE_TOOL_RESULT_PERMISSION_ERROR_DUPLICATE_FORBIDDEN_PATTERNS: RegExp[] = [
  /const\s+DEFAULT_PERMISSION_REJECTED_MESSAGE\s*=/,
  /function\s+formatPermissionRejectedMessage/,
]

const MAIN_STREAM_PROCESSOR_ADAPTER_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]@onething\/runtime['"]/,
  /createCoreStreamProcessor/,
  // F4-b1(§16.16):`createStepId: createCoreId` 这条从前钉的是"step id 的工厂
  // 归 runtime 适配器,后端门面不许自己造"。那个工厂已经没有了 —— step id 由
  // `coreStepIdForToolCall(callId)` 派生,唯一产地在 core。留着一条**永远匹配
  // 不到**的断言只会让人以为它还在守什么(P2 清过同一类僵尸断言),故删;
  // 规则本身的意思由上面那条 `createCoreStreamProcessor` 照旧守住。
  /ctx:\s*\{\s*sessionId:\s*ctx\.sessionId/,
]

const MAIN_IMAGE_STREAM_ENTRY_FORBIDDEN_PATTERNS: RegExp[] = [
  /executeCoreImageGenerationStream/,
]

const MAIN_PROVIDERS_IPC_PRESENTATION_FORBIDDEN_PATTERNS: RegExp[] = [
  /Failed to get providers/,
  /Failed to inspect provider environment variables/,
  /return\s+\{\s*success:\s*false,\s*error:/,
  /const\s+providers\s*=\s*getAvailableProviders\(\)/,
  /providers,\s*\}/,
  /status:\s*getProviderEnvStatus\(request\.providerId\)/,
]

const MAIN_PROVIDERS_IPC_HOST_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /ipcMain\.handle/,
  /Electron\.IpcMainInvokeEvent/,
]

const MAIN_MODELS_IPC_HOST_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /ipcMain\.handle/,
  /Electron\.IpcMainInvokeEvent/,
]

const MAIN_BOUND_FETCH_POLICY_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]undici['"]/,
  /from\s+['"]socks['"]/,
  /SocksClient/,
  /Socks5ProxyAgent/,
  /dispatcherCache/,
  /createDispatcherOptions/,
  /createProxyDispatcherOptions/,
  /createSocks5ProxyAgent/,
  /new\s+undici\.(Agent|ProxyAgent)/,
  /undici\.fetch/,
  /getOnethingNetworkDispatcherCacheKey/,
  /normalizeOnethingHostname/,
  /normalizeOnethingProxySettings/,
  /normalizeOnethingNetworkInterfaceSettings/,
  /shouldBindOnethingProxyConnection/,
  /function\s+normalizeProxySettings/,
  /function\s+normalizeNetworkInterfaceSettings/,
  /function\s+splitBypassRules/,
  /function\s+hostnameMatchesRule/,
  /function\s+dispatcherKey/,
  /function\s+normalizeHostname/,
  /function\s+isLoopbackHostname/,
  /function\s+shouldBindProxyConnection/,
]

const MAIN_MODEL_REGISTRY_REFRESH_FORBIDDEN_PATTERNS: RegExp[] = [
  /createOnethingModelEntriesFromModelsDev/,
  /createOnethingModelEntriesFromOpenRouterModels/,
  /getOnethingModelsDevProviderId/,
  /ONETHING_MODELS_DEV_API/,
  /modelsLastFetched\s*=/,
  /Object\.keys\(providers\)\.filter/,
  /No models\.dev data/,
]

const MAIN_MODELS_IPC_PRESENTATION_FORBIDDEN_PATTERNS: RegExp[] = [
  /detectModelCapabilities/,
  /function\s+mergeModelsById/,
  /function\s+getConfiguredCodexModelIds/,
  /Not logged in to GitHub Copilot/,
  /request\.providerId\s*===/,
  /const\s+inputModalities\s*=\s*\['text'\]/,
  /const\s+outputModalities\s*=\s*\['text'\]/,
  /context_length:\s*128000/,
  /providerMetadata:\s*\{/,
]

const MAIN_MODELS_IPC_QUERY_PRESENTATION_FORBIDDEN_PATTERNS: RegExp[] = [
  /Failed to get all models/,
  /Failed to search models/,
  /Failed to refresh model registry/,
  /Failed to get model name aliases/,
  /Failed to get model display name/,
  /return\s+\{\s*success:\s*false,\s*error:/,
  /const\s+models\s*=\s*await\s+modelRegistry\.getAllModels\(\)/,
  /const\s+models\s*=\s*await\s+modelRegistry\.searchModels/,
  /await\s+modelRegistry\.forceRefresh\(\)/,
  /const\s+aliases\s*=\s*modelRegistry\.getModelNameAliases\(\)/,
  /const\s+displayName\s*=\s*modelRegistry\.getModelDisplayName/,
  /return\s+\{\s*success:\s*true,\s*models\s*\}/,
  /return\s+\{\s*success:\s*true,\s*aliases\s*\}/,
  /return\s+\{\s*success:\s*true,\s*displayName\s*\}/,
]

const MAIN_MCP_IPC_SERVER_ORCHESTRATION_FORBIDDEN_PATTERNS: RegExp[] = [
  /uuidv4/,
  /config\.id\s*=\s*uuidv4\(\)/,
  /mcpSettings\.servers\.push/,
  /const\s+index\s*=\s*mcpSettings\.servers\.findIndex/,
  /mcpSettings\.servers\[index\]\s*=\s*config/,
  /mcpSettings\.servers\s*=\s*mcpSettings\.servers\.filter/,
  /const\s+config\s*=\s*mcpSettings\.servers\.find/,
  /JSON\.parse\(JSON\.stringify\(serverState\)\)/,
  /status:\s*['"]disconnected['"]/,
]

const MAIN_MCP_IPC_CAPABILITY_OPERATIONS_FORBIDDEN_PATTERNS: RegExp[] = [
  /const\s+tools\s*=\s*MCPManager\.getAllTools\(\)/,
  /const\s+resources\s*=\s*MCPManager\.getAllResources\(\)/,
  /const\s+prompts\s*=\s*MCPManager\.getAllPrompts\(\)/,
  /const\s+result\s*=\s*await\s+MCPManager\.callTool/,
  /const\s+result\s*=\s*await\s+MCPManager\.readResource/,
  /const\s+result\s*=\s*await\s+MCPManager\.getPrompt/,
  /content:\s*result\.content/,
  /isError:\s*result\.isError/,
  /messages:\s*result\.messages/,
]

const MAIN_MCP_IPC_OPERATIONS_FORBIDDEN_PATTERNS: RegExp[] = [
  /Failed to get servers/,
  /Failed to add server/,
  /Failed to update server/,
  /Failed to remove server/,
  /Failed to connect server/,
  /Failed to disconnect server/,
  /Failed to refresh server/,
  /Failed to get tools/,
  /Failed to call tool/,
  /Failed to get resources/,
  /Failed to read resource/,
  /Failed to get prompts/,
  /Failed to get prompt/,
  /Failed to read config file/,
  /File not found/,
  /JSON\.parse\(content\)/,
  /return\s+\{\s*success:\s*false,\s*error:/,
]

const MAIN_SESSIONS_IPC_BRANCH_FORBIDDEN_PATTERNS: RegExp[] = [
  /createOnethingBranchSession</,
  /parentSession\.messages\.findIndex/,
  /branchName\s*=\s*`\$\{parentSession\.name\} \(Branch\)`/,
  /inheritedMessages\s*=\s*parentSession\.messages/,
  /\.slice\(0,\s*messageIndex\s*\+\s*1\)/,
  /Message not found/,
  /Parent session not found/,
  /sanitizeOnethingSessionForRenderer/,
  /Error creating branch/,
  /Failed to create branch/,
  /return\s+\{\s*success:\s*false,\s*error:/,
]

const MAIN_SESSIONS_IPC_UPDATE_FORBIDDEN_PATTERNS: RegExp[] = [
  /const\s+success\s*=\s*store\.updateSessionModel/,
  /const\s+nextAgentId\s*=\s*agentId\s*\|\|/,
  /Agent not found/,
  /const\s+allowed:\s*PermissionMode\[\]/,
  /Invalid permission mode/,
]

const MAIN_SESSIONS_IPC_WORKDIR_FORBIDDEN_PATTERNS: RegExp[] = [
  /workingDirectory === null/,
  /workingDirectory === ['"]{2}/,
  /Not a directory:/,
  /Directory does not exist:/,
  /fs\.stat\(workingDirectory\)/,
  /workdirGateway\.write\(sessionId,\s*workingDirectory/,
]

const MAIN_SESSIONS_IPC_SYSTEM_MARKER_FORBIDDEN_PATTERNS: RegExp[] = [
  /session\.messages\.find/,
  /m\.role === ['"]system['"]/,
  /content\.includes\(['"]\\"type\\":/,
  /removedId:\s*existing\.id/,
]

const MAIN_SESSIONS_IPC_OPERATIONS_FORBIDDEN_PATTERNS: RegExp[] = [
  /Failed to get sessions list/,
  /Failed to activate session/,
  /Failed to get messages/,
  /Failed to get user markers/,
  /Failed to get session token usage/,
  /Failed to add message/,
  /Failed to remove message/,
  /return\s+\{\s*success:\s*false,\s*error:\s*['"]Session not found['"]\s*\}/,
  /messageCount:\s*session\.messageCount\s*\?\?/,
  /sanitizeOnethingMessagesForRenderer/,
  /return\s+\{\s*success:\s*true,\s*session:\s*sanitizeOnethingSessionForRenderer\(session\)/,
  /deletedCount:\s*result\.deletedIds\.length/,
  /const\s+usage\s*=\s*getSessionUsage\(sessionId\)/,
  /return\s+\{\s*success:\s*true,\s*usage\s*\}/,
]

const MAIN_SESSION_USAGE_FACADE_FORBIDDEN_PATTERNS: RegExp[] = [
  /store\.updateSessionTokenUsage\(sessionId,\s*usage,\s*lastTurnUsage\)/,
  /totalInputTokens:\s*usage\?\.totalInputTokens\s*\?\?\s*0/,
  /totalOutputTokens:\s*usage\?\.totalOutputTokens\s*\?\?\s*0/,
  /totalTokens:\s*usage\?\.totalTokens\s*\?\?\s*0/,
  /maxTokens:\s*128000/,
  /lastInputTokens:\s*usage\?\.lastInputTokens\s*\?\?\s*0/,
  /contextSize:\s*usage\?\.contextSize\s*\?\?\s*0/,
  /No-op:\s*session file deletion handles this/,
]

const MAIN_SESSION_MESSAGE_RUNTIME_FORBIDDEN_PATTERNS: RegExp[] = [
  /applySessionAppendMessageWithAdapters/,
  /applySessionDeleteMessageWithAdapters/,
  /applySessionInsertMessageAfterWithAdapters/,
  /applySessionMessageMutationWithAdapters/,
  /applySessionMessageStepsUsageByTurnWithAdapters/,
  /applySessionTruncateMessagesWithAdapters/,
  /applySessionUpdateMessageAndTruncateWithAdapters/,
  /patchSessionMessage/,
  /appendSessionMessageContentPart/,
  /addOrUpdateSessionMessageStep/,
  /updateSessionMessageStep/,
  /getSessionTokenUsageSnapshot/,
  /pendingSqliteMessageSyncs/,
  /function\s+syncMessageToSqliteIfReady/,
  /function\s+logSubtractedMessageUsage/,
]

const MAIN_RENDERER_SANITIZER_FORBIDDEN_PATTERNS: RegExp[] = [
  /message-sanitizer/,
  /provider-data/,
  /sanitizeContentParts/,
  /contentParts.*filter/,
]

const MAIN_CHAT_IPC_LEGACY_STREAM_FORBIDDEN_PATTERNS: RegExp[] = [
  /_handleSendMessageStream/,
  /_handleEditAndResendStream/,
  /executeMessageStream/,
  /resolvePromptReferences/,
  /buildHistoryMessages/,
  /mediaLibraryService/,
  /getEffectiveProviderConfig/,
  /resolveConfigWithAuth/,
]

const MAIN_CHAT_IPC_TITLE_FORBIDDEN_PATTERNS: RegExp[] = [
  /settings\.tools\?\.toolCallModel/,
  /settings\.ai\.providers/,
  /configuredProviderId/,
  /configuredModel/,
  /userMessage\.slice\(0,\s*30\)/,
  /return\s+\{\s*success:\s*true,\s*title:\s*result\.title\s*\}/,
]

const MAIN_CHAT_IPC_PROVIDER_ERROR_FORBIDDEN_PATTERNS: RegExp[] = [
  /type\s+ProviderErrorDetails/,
  /ProviderErrorDetails/,
  /extractErrorDetails/,
  /function\s+caughtErrorMessage/,
  /function\s+caughtErrorDetails/,
  /responseBody:\s*'responseBody'\s+in\s+error/,
]

const MAIN_CHAT_IPC_SESSION_OPERATIONS_FORBIDDEN_PATTERNS: RegExp[] = [
  /const\s+session\s*=\s*store\.getSession\(sessionId\)/,
  /session\.messages/,
  /store\.updateMessageThinkingTime\(sessionId,\s*messageId,\s*thinkingTime\)/,
  /const\s+updated\s*=\s*store\.updateMessageThinkingTime/,
  /success:\s*updated/,
]

const MAIN_CHAT_IPC_ACTIVE_STREAMS_FORBIDDEN_PATTERNS: RegExp[] = [
  /let\s+engineSessionIds/,
  /engineSessionIds\s*=\s*getStreamEngine\(\)\.getActiveSessionIds\(\)/,
  /new Set\(\[\.\.\.activeStreams\.keys\(\),\s*\.\.\.engineSessionIds\]\)/,
]

const MAIN_CHAT_IPC_SYSTEM_PROMPT_SNAPSHOT_FORBIDDEN_PATTERNS: RegExp[] = [
  /snapshot:\s*await\s+buildSystemPromptSnapshot\(sessionId\)/,
  /Failed to build system prompt snapshot/,
  /\[Chat\]\s+Failed to build system prompt snapshot/,
]

const MAIN_CHAT_IPC_ABORT_CLEANUP_FORBIDDEN_PATTERNS: RegExp[] = [
  /cancelOnethingStreamingStepsForAbort/,
  /cancelPendingSteps/,
  /awaiting-confirmation/,
  /stream:complete/,
  /step:updated/,
  /streamingMessage/,
  /step\.status/,
  /step\.toolCall/,
  /for\s*\(const\s+step/,
  /activeStreams\.size\s*>\s*0/,
  /activeStreams\.clear\(\)/,
  /for\s*\(const\s+\[sid,\s*controller\]\s+of\s+activeStreams/,
]

// 2026-08-22(#21):chat 的第七条「工具审批后恢复流」整链已删,
// `MAIN_CHAT_IPC_RESUME_CONFIRM_FORBIDDEN_PATTERNS` /
// `MAIN_CHAT_IPC_HOST_FORBIDDEN_PATTERNS` 两张禁令表随它们守的文件一起退休
// (见下面的 checkChatResumeAfterToolConfirmStaysRetired)。

const MAIN_TOOLS_IPC_TOOL_CALL_UPDATE_FORBIDDEN_PATTERNS: RegExp[] = [
  /message\.toolCalls\.map/,
  /toolCalls\s*=\s*message\.toolCalls/,
  /updates\.status\s*===/,
  /awaiting-confirmation/,
  /JSON\.stringify\(updates\.result\)/,
  /toolCall:\s*\{\s*\.\.\.step\.toolCall/,
  /Message or tool calls not found/,
  /Failed to update tool call/,
  /Error updating tool call/,
  /return\s+\{\s*success:\s*false,\s*error:/,
]

const MAIN_TOOLS_IPC_LIST_PRESENTATION_FORBIDDEN_PATTERNS: RegExp[] = [
  /sessionsList\.length/,
  /firstSession/,
  /allTools\s*=\s*await/,
  /startsWith\(["']mcp:/,
  /startsWith\(["']plugin:/,
  /builtinTools/,
  /mcpRouterTool/,
  /source:\s*["']mcp["']/,
  /Failed to get tools/,
  /Error getting tools/,
  /return\s+\{\s*success:\s*false,\s*error:/,
  /success:\s*true,\s*tools/,
]

const MAIN_TOOLS_IPC_EXECUTION_CONTEXT_FORBIDDEN_PATTERNS: RegExp[] = [
  /Get session's workingDirectory/,
  /session\?\.workingDirectory/,
  /workingDirectoryRoots\s*=\s*session/,
  /const\s+context:\s*ToolExecutionContext/,
  /executeTool\(toolId,\s*args,\s*context\)/,
  /Failed to execute tool/,
  /Error executing tool/,
  /return\s+\{\s*success:\s*false,\s*error:/,
]

const MAIN_TOOLS_IPC_BACKGROUND_JOBS_FORBIDDEN_PATTERNS: RegExp[] = [
  /Cancel tool requested/,
  /return\s+\{\s*success:\s*true\s*\}/,
  /success:\s*true,\s*jobs:/,
  /success:\s*stopBackgroundJob/,
  /Failed to list background jobs/,
  /Failed to stop background job/,
]

const MAIN_SETTINGS_IPC_SAVE_ORCHESTRATION_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"].*\b(dialog|BrowserWindow|nativeTheme)\b/,
  /BrowserWindow\.getFocusedWindow/,
  /BrowserWindow\.getAllWindows/,
  /nativeTheme\.shouldUseDarkColors/,
  /nativeTheme\.on\(['"]updated['"]/,
  /dialog\.showOpenDialog/,
  /webContents\.send\(IPC_CHANNELS\.(SYSTEM_THEME_CHANGED|SETTINGS_CHANGED)/,
  /return\s+\{\s*success:\s*true,\s*settings:\s*store\.getSettings\(\)\s*\}/,
  /return\s+\{\s*success:\s*true,\s*theme:\s*isDark\s*\?\s*['"]dark['"]\s*:\s*['"]light['"]\s*\}/,
  /return\s+\{\s*success:\s*true,\s*interfaces:\s*listNetworkInterfaces\(\)\s*\}/,
  /Failed to list network interfaces\./,
  /store\.saveSettings\(settings\)/,
  /const\s+normalizedSettings\s*=\s*store\.getSettings\(\)/,
  /invalidateProviderCache\(\)/,
  /applyNetworkProxySettings\(normalizedSettings\.network\?\.proxy\)/,
  /MCPManager\.updateSettings\(normalizedSettings\.mcp/,
  /ACPManager\.updateSettings\(normalizedSettings\.acp/,
]

const MAIN_SETTINGS_IPC_HOST_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /ipcMain\.handle/,
  /Electron\.IpcMainInvokeEvent/,
]

const MAIN_ACP_IPC_OPERATIONS_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]uuid['"]/,
  /errorMessage\(error/,
  /normalizeConfig/,
  /ACP agent command is required/,
  /already exists/,
  /not found/,
  /acpSettings\.agents\.push/,
  /acpSettings\.agents\s*=\s*acpSettings\.agents\.filter/,
  /const\s+index\s*=\s*acpSettings\.agents\.findIndex/,
  /acpSettings\.agents\[index\]\s*=\s*config/,
  /return\s+\{\s*success:\s*false,\s*error:/,
  /return\s+\{\s*success:\s*true,\s*agent:/,
]

const MAIN_ACP_RUNTIME_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]child_process['"]/,
  /from\s+['"]crypto['"]/,
  /from\s+['"]fs['"]/,
  /from\s+['"]path['"]/,
  /from\s+['"]stream['"]/,
  /@agentclientprotocol\/sdk/,
  /BoundedAsyncQueue/,
  /class\s+ACPClient/,
  /class\s+ACPManagerClass/,
  /spawn\(this\.config\.command/,
  /ClientSideConnection/,
  /ndJsonStream/,
  /createTerminal/,
  /readTextFile/,
  /writeTextFile/,
  /setInterval/,
]

const MAIN_PLUGINS_IPC_LIST_PROJECTION_FORBIDDEN_PATTERNS: RegExp[] = [
  /plugins\.map/,
  /definition\.manifest\.name/,
  /definition\.manifest\.version/,
  /definition\.manifest\.description/,
  /definition\.manifest\.author/,
  /needsInstall:\s*p\.definition\.needsInstall/,
  /commands:\s*p\.commands/,
]

const MAIN_PLUGINS_IPC_COMMAND_PROJECTION_FORBIDDEN_PATTERNS: RegExp[] = [
  /getPluginCommands\(\)\.values\(\)\)\.map/,
  /command\.name\.replace/,
  /description:\s*command\.description\s*\|\|/,
  /usage:\s*command\.usage\s*\|\|/,
]

const MAIN_PLUGINS_IPC_COMMAND_EXECUTION_FORBIDDEN_PATTERNS: RegExp[] = [
  /request\.commandName\.startsWith\(['"]\/['"]\)/,
  /manager\.getCommandHandler\(commandName\)/,
  /Unknown plugin command: \$\{commandName\}/,
  /lastNotification/,
  /command\.handler\(request\.args/,
  /type:\s*['"]command:inject-steering['"]/,
  /type:\s*['"]command:inject-followup['"]/,
  /type:\s*['"]plugin:notification['"]/,
  /source:\s*`plugin-command:\$\{commandName\}`/,
  /cwd:\s*session\?\.workingDirectory/,
  /lastNotification\s*\|\|\s*`\$\{commandName\} completed`/,
]

const MAIN_PLUGINS_IPC_OPERATIONS_FORBIDDEN_PATTERNS: RegExp[] = [
  /Plugin system not initialized/,
  /Failed to list plugins/,
  /Failed to enable plugin/,
  /Failed to disable plugin/,
  /Failed to refresh plugins/,
  /Failed to list plugin commands/,
  /Failed to execute plugin command/,
  /return\s+\{\s*success:\s*true/,
  /success:\s*false,\s*error/,
]

const MAIN_PLUGINS_IPC_HOST_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /ipcMain\.handle/,
]

// 插件逻辑不得回流主进程 —— 一条按目录走的通用规则,取代原先按符号逐个点名的
// MAIN_LOG_MONITOR_PLUGIN_* / MAIN_NOTE_SKILLS_PLUGIN_* 两张表(它们只认识
// findObsidianVaultRoot 这类具体名字,新插件一加就是新盲区)。
//
// packages/backend/wiring/plugins/builtin/ 是**插座**:把宿主的能力(store/settings/日志目录)
// 注入给 @onething/runtime/plugins 里的插件实现,自己不写行为。因此这里禁的是
// "行为的形状"而不是"某个名字":schema、Node I/O、直接 api.* 注册、控制流、
// 计时器、长字面量(描述/提示词)。
const BUILTIN_PLUGIN_FACADE_FORBIDDEN_PATTERNS: RegExp[] = [
  // 参数 schema 属于插件实现(它才是被模型调用的那一侧)。
  /from\s+['"]zod['"]/,
  // Node I/O / 子进程:插件能力,必须经运行时实现或注入的适配器。
  // 三种取模块的写法都要堵:静态 import、require、动态 import(含 await 与裸用)。
  /from\s+['"](?:node:)?(?:fs|fs\/promises|os|path|child_process|http|https|net|readline|worker_threads)['"]/,
  /\brequire\(\s*['"](?:node:)?(?:fs|fs\/promises|os|path|child_process|http|https|net|readline|worker_threads)['"]\s*\)/,
  /\bimport\(\s*['"](?:node:)?(?:fs|fs\/promises|os|path|child_process|http|https|net|readline|worker_threads)['"]\s*\)/,
  // **开放式**禁令:碰 api 的任何成员都是插件逻辑长在装配层。插座唯一合法的
  // 形状是把 api 整个转交下去(`registerOnething*Plugin(api, { … })`)——那条
  // 形状里不出现 `api.`,所以不需要成员白名单。逐个点名成员的旧写法漏掉的正是
  // "下次新增的那个成员"。
  /\bapi\s*\./,
  // 解构 / 重命名入口参数 = 绕开上面那条的等价写法(`function p({ registerTool })`
  // 之后就再也看不见 `api.` 了)。
  /\bfunction\s*\w*\s*\(\s*\{/,
  /\(\s*\{[^)]*\}\s*(?::\s*[^)]*)?\)\s*=>/,
  /\b(?:const|let|var)\s+(?:\{[^}]*\}|\w+)\s*=\s*api\b/,
  // 控制流 = 行为,不是接线。
  /^\s*(?:if|for|while|switch|do)\s*[({]/,
  /^\s*(?:try|catch|finally)\b/,
  /\?\?=|\|\|=/,
  // 生命周期(定时器)由插件实现自己持有,插座不许起。
  /\bset(?:Interval|Timeout|Immediate)\s*\(/,
]

// 描述文案 / 提示词 / 路径模板这类长字面量属于插件实现;插座里只该出现模块路径。
const BUILTIN_PLUGIN_FACADE_LONG_LITERAL = /(['"`])(?:(?!\1)[^\\])[^'"`\n]{40,}\1/

const MAIN_SKILLS_IPC_RUNTIME_CACHE_FORBIDDEN_PATTERNS: RegExp[] = [
  /skillsCache\s*:/,
  /skillsCache\s*=\s*loadAllSkills/,
  /skillsCacheByDir/,
  /loadProjectSkillsForDirectory/,
  /function\s+applySkillSettings/,
  /function\s+mergeSkillsByPriority/,
  /function\s+getSkillsForDirectory/,
  /Cache MISS/,
  /skillsCache\.find/,
]

const MAIN_SKILLS_IPC_OPERATIONS_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"].*\bshell\b/,
  /shell\.openPath/,
  /Failed to get skills/,
  /Failed to refresh skills/,
  /File not found or not readable/,
  /Failed to read skill file/,
  /Failed to open skill directory/,
  /Failed to create skill/,
  /Failed to delete skill/,
  /Failed to toggle skill/,
  /Skill not found/,
  /return\s+\{\s*success:\s*true/,
  /success:\s*false/,
  /settings\.skills\s*=\s*\{\s*enableSkills:\s*true,\s*skills:\s*\{\}\s*\}/,
  /settings\.skills\.skills\[skillId\]\s*=\s*\{\s*enabled\s*\}/,
]

const MAIN_SKILL_MANAGE_FORBIDDEN_PATTERNS: RegExp[] = [
  /createTwoFilesPatch/,
  /parseYaml/,
  /SKILL_NAME_PATTERN/,
  /MAX_SUPPORT_FILE_BYTES/,
  /function\s+validateSkillMarkdown/,
  /function\s+planSkillManage/,
  /function\s+createPlan/,
  /function\s+editPlan/,
  /function\s+patchPlan/,
  /function\s+deletePlan/,
  /function\s+writeFilePlan/,
  /function\s+removeFilePlan/,
  /function\s+supportFiles/,
  /function\s+removeEmptyParentDirectories/,
]

const MAIN_SKILLS_LOADER_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /require\(['"]electron['"]\)/,
  /createRequire\b/,
  /app\.isPackaged/,
  /process\.resourcesPath/,
  /interface\s+SkillFrontmatter/,
  /parseYaml/,
  /function\s+parseFrontmatter/,
  /function\s+scanSkillFiles/,
  /function\s+skillIdFor/,
  /function\s+loadSkillFromDirectory/,
  /function\s+loadSkillsFromPath/,
  /function\s+loadBuiltinSkills/,
  /function\s+loadPluginRootSkills/,
  /function\s+loadProjectSkillsForDirectoryWithPaths/,
  /EXCLUDED_DIRECTORIES/,
  /EXCLUDED_FILES/,
  /ONETHING_SKILLS_CONFIG_FILENAME/,
]

const MAIN_MEDIA_PREVIEW_REGISTRY_FORBIDDEN_PATTERNS: RegExp[] = [
  /imagePreviewRecords\s*=\s*new Map/,
  /IMAGE_PREVIEW_TTL_MS/,
  /MAX_IMAGE_PREVIEW_RECORDS/,
  /function\s+pruneImagePreviewRecords/,
  /function\s+createImagePreviewRecord/,
  /const\s+previewId\s*=\s*imagePreviewRegistry\.create/,
  /openImagePreviewWindow\(\{\s*mode:\s*['"]single['"]/,
  /openImagePreviewWindow\(\{\s*mode:\s*['"]gallery['"]/,
  /srcPrefix:\s*data\.src\.substring/,
  /return\s+\{\s*success:\s*true\s*\}/,
  /Image preview expired or was not found/,
]

const MAIN_MEDIA_IMAGE_DATA_URL_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]path['"]/,
  /from\s+['"]node:path['"]/,
  /path\.extname/,
  /image\/jpeg/,
  /image\/webp/,
  /data:\$\{mimeType\};base64/,
  /Failed to read image/,
  /console\.error\(\s*['"]\[Media IPC\] Failed to read image/,
]

const MAIN_MEDIA_LEGACY_LIST_FORBIDDEN_PATTERNS: RegExp[] = [
  /mediaAssetToLegacyImage/,
  /listAssets\(\{\s*kind:\s*['"]image['"]\s*\}\)/,
  /fs\.existsSync\(asset\.filePath\)/,
]

const MAIN_MEDIA_SAVE_IMAGE_FORBIDDEN_PATTERNS: RegExp[] = [
  /mediaAssetToLegacyImage/,
  /ingestGeneratedImage/,
]

const MAIN_MEDIA_LIBRARY_IPC_OPERATIONS_FORBIDDEN_PATTERNS: RegExp[] = [
  /mediaLibraryService\.listAssets\(query\s*\|\|\s*\{\}\)/,
  /success:\s*mediaLibraryService\.hideAsset\(id\)/,
  /mediaLibraryService\.rebuildFromSessions\(getSessions\(\)\)/,
  /sessions:\s*getSessions\(\)/,
  /added:\s*0,\s*skipped:\s*0/,
  /return\s+\{\s*success:\s*true,\s*\.\.\.result\s*\}/,
  /mediaLibraryService\.getGallery\(data\.assetId/,
  /return\s+mediaLibraryService\.listLegacyImages\(\)/,
  /return\s+mediaLibraryService\.hideAsset\(id\)/,
  /^\s*mediaLibraryService\.hideAllAssets\(\)/,
]

const MAIN_MEDIA_IPC_HOST_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /ipcMain\.handle/,
  /Electron\.IpcMainInvokeEvent/,
]

const MAIN_MARKDOWN_ASSET_SERVICE_FORBIDDEN_PATTERNS: RegExp[] = [
  /IMAGE_EXTENSIONS/,
  /SKIP_SEARCH_DIRS/,
  /VAULT_ASSET_INDEX_TTL_MS/,
  /interface\s+ObsidianConfig/,
  /interface\s+MarkdownContext/,
  /function\s+markdownContext/,
  /function\s+cleanRawTarget/,
  /function\s+mimeTypeFromPath/,
  /function\s+obsidianAttachmentDirectory/,
  /function\s+attachmentDirectoryForContext/,
  /function\s+candidatePaths/,
  /function\s+buildVaultAssetIndex/,
  /function\s+findObsidianAssetByBasename/,
  /attachmentFolderPath/,
  /useMarkdownLinks/,
  /Buffer\.from\(file\.base64Data/,
]

const MAIN_MARKDOWN_IPC_OPERATIONS_FORBIDDEN_PATTERNS: RegExp[] = [
  /success:\s*true/,
  /code:\s*['"]INTERNAL['"]/,
  /Failed to resolve Markdown asset/,
  /Failed to save Markdown attachments/,
]

const MAIN_THEMES_IPC_RUNTIME_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /ipcMain\.handle/,
  /from\s+['"]electron['"].*\bshell\b/,
  /shell\.openPath/,
  /let\s+isInitialized/,
  /initializeThemes\(\)/,
  /loadCustomThemes\(\)/,
  /getThemeList\(\)/,
  /const\s+theme\s*=\s*getTheme/,
  /const\s+cssVariables\s*=\s*applyTheme/,
  /const\s+themes\s*=\s*refreshThemes/,
  /const\s+themesPath\s*=\s*getThemesFolderPath/,
  /Theme not found:/,
  /Error opening themes folder/,
  /return\s+\{\s*success:\s*true\s*\}/,
  /success:\s*false,\s*error/,
]

const MAIN_THEMES_INDEX_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]fs['"]/,
  /from\s+['"]path['"]/,
  /from\s+['"]os['"]/,
  /builtinThemeMap/,
  /customThemeMap/,
  /function\s+getThemeDirs/,
  /function\s+loadThemeFile/,
  /function\s+detectColorScheme/,
  /function\s+applyThemeInternal/,
  /parseBase46Lua/,
  /generateCSSVariables/,
]

const MAIN_THEMES_HELPER_IMPLEMENTATION_FORBIDDEN_PATTERNS: RegExp[] = [
  /\.\.\/\.\.\/shared\/ipc\/themes/,
  /from\s+['"]@ant-design\/colors['"]/,
  /from\s+['"]culori['"]/,
  /BASE46_HIGHLIGHT_ALIASES/,
  /CSS_VAR_MAP/,
  /SEMANTIC_HIGHLIGHT_TOKENS/,
  /SEMANTIC_UI_TOKENS/,
  /THEME_NEUTRAL_COLOR_TOKENS/,
  /function\s+parseBase46Lua/,
  /function\s+convertBase46ToTheme/,
  /function\s+resolveTheme/,
  /function\s+generateCSSVariables/,
  /function\s+deriveSurfaceRoles/,
  /interface\s+ThemeSurfaceRoleInput/,
]

const MAIN_WINDOW_THEME_SELECTION_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"].*\bnativeTheme\b/,
  /nativeTheme\.shouldUseDarkColors/,
  /function\s+getEffectiveTheme\b/,
  /function\s+getEffectiveThemeId\b/,
  /function\s+getEffectiveColorTheme\b/,
  /settingsTheme\s*===\s*['"]system['"]/,
  /general\?\.(darkThemeId|lightThemeId|themeId)/,
  /DEFAULT_GENERAL_SETTINGS\.(darkThemeId|lightThemeId|themeId|colorTheme)/,
]

const MAIN_TODO_PLAN_STORE_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /from\s+['"]crypto['"]/,
  /from\s+['"]node:crypto['"]/,
  /from\s+['"]fs\/promises['"]/,
  /from\s+['"]node:fs\/promises['"]/,
  /BrowserWindow\.getAllWindows\(\)/,
  /webContents\.send\(IPC_CHANNELS\.TODO_PLAN_CHANGED/,
  /shell\.openPath/,
  /createRequire/,
  /function\s+getElectronModule/,
  /function\s+countTasks/,
  /function\s+safeSlug/,
  /function\s+readDocument/,
  /function\s+writeFileEnsured/,
  /function\s+hasSubstantiveMarkdownContent/,
  /session-ai-todo content is empty/,
  /USER_NOTES_DIR/,
  /SESSIONS_DIR/,
]

const MAIN_TODO_PLAN_IPC_OPERATIONS_FORBIDDEN_PATTERNS: RegExp[] = [
  /return\s+\{\s*success:\s*true,\s*snapshot:/,
  /return\s+\{\s*success:\s*true,\s*document:/,
  /return\s+\{\s*success:\s*true\s*\}/,
  /return\s+\{\s*success:\s*true,\s*pinned:/,
  /Failed to read todo\/plan files/,
  /Failed to create todo note/,
  /Failed to update todo\/plan file/,
  /Failed to rename todo note/,
  /Failed to delete todo note/,
  /Failed to open todo\/plan directory/,
  /^\s*openTodoPlanWindow\(request\)/,
  /^\s*hideTodoPlanWindow\(request\)/,
  /^\s*toggleTodoPlanWindow\(request\)/,
  /setTodoPlanWindowPinned\(request\.pinned\)/,
]

const MAIN_TODO_PLAN_IPC_HOST_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /ipcMain\.handle/,
  /Electron\.IpcMainInvokeEvent/,
]

const MAIN_VOICE_IPC_OPERATIONS_FORBIDDEN_PATTERNS: RegExp[] = [
  /success:\s*true,\s*state:\s*getVoiceService\(\)\.getState\(\)/,
  /Attach or record audio before testing ASR\./,
  /ASR test failed\./,
  /TTS test failed\./,
  /Voice test succeeded\./,
  /Failed to load TTS models\./,
  /return\s+\{\s*success:\s*true,\s*transcript:/,
  // P4c 第十一批:`/return { success: true, models: … }/` 与 `/return { success: true }/`
  // 两条从这张表里摘掉 —— 断言现在指的是 `rpc/domains/voice.ts`,而那里逐字保留着
  // 旧 server adapter 的 http 桩(`stop` 恒成功、`getTTSModels` 恒空表、`audioChunk`
  // 的空回执),形状与它们撞车。真正要守的「不许把投影再抄一份」由上面那几条
  // 文案与 `const transcript = await transcribeUtterance` 之类的实现痕迹继续守。
  /const\s+transcript\s*=\s*await\s+transcribeUtterance/,
  /const\s+result\s*=\s*await\s+getOpenRouterTTSModels/,
  /^\s*getVoiceService\(\)\.handleRuntimeReady\(event\.sender\)/,
  /^\s*getVoiceService\(\)\.handleRuntimeEvent\(runtimeEvent\)/,
]

const MAIN_VOICE_PROVIDER_RUNTIME_FORBIDDEN_PATTERNS: RegExp[] = [
  /https:\/\/api\.openai\.com\/v1\/audio/,
  /https:\/\/openrouter\.ai\/api\/v1\/audio/,
  /https:\/\/openrouter\.ai\/api\/v1\/models/,
  /function\s+getOpenAIKey/,
  /function\s+getOpenRouterKey/,
  /function\s+base64ToBlob/,
  /function\s+audioFormatFromMimeType/,
  /function\s+streamSpeechEndpoint/,
  /function\s+normalizeAudioMimeType/,
  /OpenRouterSpeechModel/,
  /response\.body\.getReader/,
  /settings\.asr\.provider\s*===/,
  /settings\.tts\.provider\s*===/,
  /new\s+FormData\(/,
]

const MAIN_VOICE_SERVICE_RUNTIME_FORBIDDEN_PATTERNS: RegExp[] = [
  /\.\.\/\.\.\/shared\/voice/,
  /shared\/voice\/segmenter/,
  /shared\/voice\/tts-stream/,
  /function\s+isWebSpeechWakeFailure/,
  /function\s+normalizeVoiceError/,
  /function\s+isMissingCloudTTSConfiguration/,
  /function\s+getTTSModelName/,
  /lastError:\s*status\s*===\s*['"]error['"]/,
  /this\.state\.lastError\s*=/,
  /this\.state\.lastMilestone\s*=/,
  /at:\s*Date\.now\(\)/,
  /OpenRouter transcription failed \(401\)/,
  /OpenAI transcription failed \(401\)/,
  /Qwen\/CosyVoice base URL is required/,
  /Wake phrase listener could not access a microphone/,
]

const SHARED_STREAM_CHUNK_PROTOCOL_FORBIDDEN_PATTERNS: RegExp[] = [
  /interface\s+TextDeltaChunk/,
  /type\s+ReasoningPlacement\s*=/,
  /interface\s+ReasoningDeltaChunk/,
  /interface\s+ToolInputDeltaChunk/,
  /type\s+StreamChunk\s*=/,
]

const SHARED_JSON_PROTOCOL_FORBIDDEN_PATTERNS: RegExp[] = [
  /type\s+JsonPrimitive\s*=/,
  /type\s+JsonValue\s*=/,
  /type\s+JsonObjectProperty\s*=/,
  /interface\s+JsonObject/,
  /type\s+JsonArray\s*=/,
  /interface\s+JsonSchemaObject/,
  /function\s+isJsonObject/,
  /function\s+parseJsonObject/,
  /function\s+toJsonValue/,
  /function\s+toJsonObject/,
  /function\s+toJsonSchemaObject/,
]

const SHARED_IPC_ROUTER_FORBIDDEN_PATTERNS: RegExp[] = [
  /type\s+RoutePayload\s*=/,
  /interface\s+RouteConfig/,
  /type\s+DomainRoutes\s*=/,
  /interface\s+Router/,
  /type\s+RouteHandlers\s*=/,
  /type\s+RouteAPI\s*=/,
  /function\s+toKebab/,
  /function\s+getChannelName/,
  /function\s+defineRouter/,
]

const SHARED_VOICE_TEXT_RUNTIME_FORBIDDEN_PATTERNS: RegExp[] = [
  /const\s+SENTENCE_END_RE/,
  /function\s+findLowLatencyBreak/,
  /function\s+applyTag/,
  /return\s+chunk\.text\s*\|\|\s*chunk\.voiceSpeakText/,
]

/**
 * 旧扫描路的**尸检表**(检索重建 S5,`docs/design/search-index-2026-09.md` §10 S5)。
 *
 * S5 之前这里有三张表,守的是「旧路的编排别从 runtime 漏进装配层 / 契约层」。
 * 旧路整条删掉之后,守的东西反过来:**它不许长回来**。所以这一张表列的是那条路
 * 独有的形状与名字 —— 一个 `switch(category)`、一张写死的类别清单、六个扫描器的
 * 函数名。命中任何一条,就是有人在能力注册表旁边又开了第二条查询路。
 *
 * `searchActions` / `searchPrompts` / `searchFiles` **不在这张表里**:它们是
 * `capabilities/{actions,prompts,files}.ts` 各自的匹配器,是能力的实现,不是第二条路。
 */
const RETIRED_SCAN_PATH_PATTERNS: RegExp[] = [
  /switch\s*\(category\)/,
  /\bexecuteOnethingSearch\b/,
  /\bexecuteOnethingSearchForIpc\b/,
  /\bONETHING_SEARCH_CATEGORIES\b/,
  /\bisOnethingSearchCategory\b/,
  /\bnormalizeOnethingSearchCategory\b/,
  /\bcreateOnethingSearchProviders\b/,
  /\bcreateOnethingSearchRuntimeAdapters\b/,
  /function\s+searchChats/,
  /function\s+searchMessages/,
  /function\s+searchDailyNotes/,
  /\bparseDateFromPath\b/,
]

/** 那条路的三个模块 —— 存在即红。 */
const RETIRED_SCAN_PATH_MODULES = [
  'packages/onething-runtime/src/search/search-runtime.ts',
  'packages/onething-runtime/src/search/ipc-operations.ts',
  'packages/onething-runtime/src/search/protocol.ts',
  'packages/backend/wiring/search/ipc.ts',
  'scripts/search-parity-a.mjs',
  'scripts/search-parity-b.mjs',
]

/**
 * 一类 = 一个文件(§4.3「加一类 = 一个文件 + 一行注册」)。缺一个就是有人把某一类
 * 的实现又搬回了公共文件里。
 */
const SEARCH_CAPABILITY_MODULES = [
  'packages/onething-runtime/src/search/capabilities/index.ts',
  'packages/onething-runtime/src/search/capabilities/actions.ts',
  'packages/onething-runtime/src/search/capabilities/daily.ts',
  'packages/onething-runtime/src/search/capabilities/daily-notes.ts',
  'packages/onething-runtime/src/search/capabilities/files.ts',
  'packages/onething-runtime/src/search/capabilities/messages.ts',
  'packages/onething-runtime/src/search/capabilities/prompts.ts',
  'packages/onething-runtime/src/search/capabilities/scan-adapter.ts',
  'packages/onething-runtime/src/search/capabilities/sessions.ts',
  'packages/onething-runtime/src/search/capabilities/text-match.ts',
]

const MAIN_HEADLESS_CLI_PROJECTION_FORBIDDEN_PATTERNS: RegExp[] = [
  /getSessionsList\(\)\.map\(session\s*=>\s*\(\{/,
  /Object\.entries\(settings\.ai\.providers\s*\|\|\s*\{\}\)\.map/,
  /settings\.ai\.providers\[providerId\]\s*=/,
  /settings\.ai\.provider\s*=\s*providerId/,
  /Object\.keys\(provider\.models\s*\|\|\s*\{\}\)/,
  /tools\.map\(tool\s*=>\s*\(\{/,
  /settings\.tools\.tools\[toolId\]\s*=/,
  /settings\.tools\.permissionMode\s*=\s*mode/,
]

const MAIN_PROMPTS_STORE_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]zod['"]/,
  /PROMPT_SCHEMA/,
  /PROMPTS_FILE_SCHEMA/,
  /interface\s+PromptsFile/,
  /let\s+promptsCache/,
  /let\s+promptsPathOverride/,
  /function\s+normalizeTags/,
  /function\s+cleanPrompt/,
  /function\s+parsePromptsFile/,
  /function\s+loadFromDisk/,
  /function\s+saveToDisk/,
  /function\s+getState/,
  /function\s+persist/,
  /crypto\.randomUUID\(\)/,
]

const MAIN_PROMPTS_IPC_OPERATIONS_FORBIDDEN_PATTERNS: RegExp[] = [
  /function\s+errorMessage/,
  /return\s+\{\s*success:\s*true,\s*prompts:\s*listPrompts\(\)\s*\}/,
  /Prompt not found/,
  /Title is required/,
  /return\s+\{\s*success:\s*true,\s*prompt/,
  /return\s+\{\s*success:\s*deletePrompt\(request\.id\)\s*\}/,
  /Failed to list prompts/,
  /Failed to read prompt/,
  /Failed to create prompt/,
  /Failed to update prompt/,
  /Failed to delete prompt/,
]

const MAIN_PROMPTS_IPC_HOST_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /ipcMain\.handle/,
]

const MAIN_PROJECT_DIRS_STORE_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]crypto['"]/,
  /from\s+['"]node:crypto['"]/,
  /from\s+['"]fs['"]/,
  /from\s+['"]node:fs['"]/,
  /from\s+['"]os['"]/,
  /from\s+['"]node:os['"]/,
  /from\s+['"]zod['"]/,
  /PROJECT_INDEX_SCHEMA/,
  /PROJECT_SCHEMA/,
  /class\s+ProjectsStore/,
  /function\s+projectIdFromPath/,
  /function\s+canonicalize/,
  /function\s+loadIndex/,
  /function\s+saveIndex/,
  /function\s+loadProject/,
  /function\s+saveProject/,
  /function\s+deleteProject/,
  /ROOT_DIR/,
  /DATA_DIR/,
  /buildProjectDirsPromptVars/,
  /function\s+resolveActive/,
  /function\s+resolveKnown/,
]

const MAIN_PROJECT_DIRS_IPC_OPERATIONS_FORBIDDEN_PATTERNS: RegExp[] = [
  /function\s+toRecord/,
  /function\s+toErrorPayload/,
  /description:\s*project\?\.description\s*\?\?\s*['"]/,
  /return\s+\{\s*success:\s*true,\s*entries\s*\}/,
  /return\s+\{\s*success:\s*true,\s*project:/,
  /No project for path/,
  /code:\s*['"]NOT_FOUND['"]/,
  /Unknown project-dirs error/,
  /code:\s*['"]INTERNAL['"]/,
]

const MAIN_PROJECT_DIRS_IPC_HOST_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /ipcMain\.handle/,
]

const MAIN_VARIABLES_RUNTIME_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]zod['"]/,
  /VARIABLES_FILE_SCHEMA/,
  /GLOBAL_VARIABLE_SCHEMA/,
  /class\s+VariablesStore/,
  /function\s+createDefaultVariablesFile/,
  /function\s+parseVariablesFile/,
  /function\s+migrateReservedGlobals/,
  /function\s+formatStateVariablesForPrompt/,
  /function\s+assertValidName/,
  /function\s+assertValidValue/,
  /function\s+findDuplicateNames/,
  /const\s+RESERVED_NAMES/,
  /const\s+VARIABLE_LIMITS/,
  /class\s+VariableError/,
  /class\s+VariableRegistry/,
  /class\s+CoreProvider/,
  /class\s+NotesProvider/,
  /class\s+SessionStoreProvider/,
  /class\s+GlobalStoreProvider/,
  /writeChains/,
  /function\s+uniqueRoots/,
  /resolveExistingDirectory/,
  /interface\s+WorkdirGateway/,
  /interface\s+NotesGateway/,
  /interface\s+SessionStoreGateway/,
  /interface\s+GlobalStoreGateway/,
  /private\s+findClaimant/,
  /private\s+serialize/,
  /private\s+persistAndNotify/,
]

const MAIN_VARIABLES_IPC_OPERATIONS_FORBIDDEN_PATTERNS: RegExp[] = [
  /function\s+toErrorPayload/,
  /VariableError/,
  /return\s+\{\s*success:\s*true,\s*variables\s*\}/,
  /return\s+\{\s*success:\s*true,\s*variable\s*\}/,
  /return\s+\{\s*success:\s*true\s*\}/,
  /Unknown variable error/,
  /code:\s*['"]INTERNAL['"]/,
]

const MAIN_VARIABLES_IPC_HOST_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /ipcMain\.handle/,
]

const CORE_TOOL_RUNTIME_FORBIDDEN_PATTERNS: RegExp[] = [
  /executeCoreTimeTool/,
  /parseCoreTimeInput/,
  /resolveCoreTimezone/,
  /CoreTimeArgs/,
  /classifySensitiveFile/,
  /SensitiveFileCategory/,
  /SensitiveFileClassification/,
  /createLocalBashOperations/,
  /configureCoreBackgroundJobs/,
  /BackgroundJob/,
  /BashOperations/,
  /BashSpawnContext/,
  /BashSpawnHook/,
  /ShellConfig/,
  /killTrackedDetachedChildren/,
  /killProcessTree/,
  /listBackgroundJobs/,
  /refreshBackgroundJob/,
  /registerBackgroundJob/,
  /stopBackgroundJob/,
  /resolveSpawnContext/,
  /trackDetachedChildPid/,
  /untrackDetachedChildPid/,
  /waitForChildProcess/,
  /OutputAccumulator/,
  /OutputSnapshot/,
  /OutputTruncation/,
  /DEFAULT_OUTPUT_MAX_BYTES/,
  /DEFAULT_OUTPUT_MAX_LINES/,
  /DEFAULT_TEXT_MAX_BYTES/,
  /TextTruncationResult/,
  /truncateTextHead/,
  /truncateLine/,
  /formatSize/,
  /utf8Bytes/,
  /withFileMutationQueue/,
  /clearFileMutationQueuesForTests/,
  /getFileMutationQueueSize/,
  /readTextFileSnapshot/,
  /hashTextFileSnapshot/,
  /countLineChanges/,
  /TextFileSnapshot/,
  /recordFileMutationAudit/,
  /readFileMutationAudit/,
  /applyFileMutationUndo/,
  /hashAuditContent/,
  /FileMutationAuditRecord/,
  /FileMutationOperation/,
  /RecordFileMutationAuditInput/,
  /RecordFileMutationAuditResult/,
  /checkCoreFileAccess/,
  /expandCorePath/,
  /findCoreReadSandboxRootForPath/,
  /findCoreSandboxRootForPath/,
  /getCoreReadSandboxRoots/,
  /getCoreSandboxBoundary/,
  /getCoreSandboxRoots/,
  /isCorePathContained/,
  /resolveCoreToolPath/,
  /uniqueCorePaths/,
  /CoreFileAccessContext/,
  /CoreFileAccessOptions/,
  /CoreFileAccessTargetType/,
  /CoreReadSandboxRootsOptions/,
  /CoreSandboxBoundaryOptions/,
  /CoreSandboxRootsOptions/,
  /applyExactEditsToNormalizedContent/,
  /prepareExactEditPreview/,
  /detectLineEnding/,
  /normalizeToLF/,
  /restoreLineEndings/,
  /stripBom/,
  /ExactEdit/,
  /ExactEditApplyResult/,
  /ExactEditPreviewContentResult/,
  /REPLACERS/,
  /SimpleReplacer/,
  /LineTrimmedReplacer/,
  /BlockAnchorReplacer/,
  /WhitespaceNormalizedReplacer/,
  /IndentationFlexibleReplacer/,
  /EscapeNormalizedReplacer/,
  /TrimmedBoundaryReplacer/,
  /ContextAwareReplacer/,
  /MultiOccurrenceReplacer/,
  /normalizeLineEndings/,
  /trimDiff/,
  /classifyBashCommand/,
  /classifyCommand/,
  /getCommandPattern/,
  /parseCommand/,
  /splitShellWords/,
  /BashClassification/,
  /BashPermissionDecision/,
  /ClassifiedBashCommand/,
]

interface WalkFilesOptions {
  includeTests?: boolean
  /** 覆盖默认扩展名集合。08-31 前这个字段被静默忽略(调用方传了但没人读),
   *  控制字符规则注释里说的 .vue/.css/.md 从没真被扫过 —— 修表即修意图。 */
  extensions?: RegExp
  /** 额外跳过的目录名(构建产物等)。gitignore 掉的产物不进 git,
   *  「diff 不可审」的立法理由对它们不成立,扫了只会报假案。 */
  excludeDirs?: readonly string[]
}

function walkFiles(dir: string, output: string[] = [], options: WalkFilesOptions = {}): string[] {
  if (!fs.existsSync(dir)) return output
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if ((!options.includeTests && entry.name === '__tests__')
      || entry.name === 'node_modules'
      || entry.name === '.git'
      || options.excludeDirs?.includes(entry.name)) continue
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkFiles(fullPath, output, options)
    } else if ((options.extensions ?? /\.(ts|tsx|js|mjs|cjs|json)$/).test(entry.name)) {
      output.push(fullPath)
    }
  }
  return output
}

function rel(filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join('/')
}

function matchingLines(filePath: string, patterns: RegExp[]): string[] {
  const content = fs.readFileSync(filePath, 'utf-8')
  return content
    .split(/\r?\n/)
    .map((line, index) => ({ line, lineNo: index + 1 }))
    .filter(({ line }) => patterns.some(pattern => pattern.test(line)))
    .map(({ line, lineNo }) => `${rel(filePath)}:${lineNo}: ${line.trim()}`)
}

/**
 * 逐行剥掉注释后的代码视图。
 *
 * 形状类规则(禁 api.*、禁控制流…)如果拿原始行去匹配,注释里随手写一句
 * `// 这里不要 api.registerTool` 就会打出假红,而假红会逼人放宽规则 —— 棘轮
 * 就是这么被磨钝的。
 */
function codeOnlyLines(content: string): Array<{ raw: string; code: string; lineNo: number }> {
  let inBlockComment = false
  return content.split(/\r?\n/).map((raw, index) => {
    let code = raw
    if (inBlockComment) {
      const end = code.indexOf('*/')
      if (end === -1) {
        code = ''
      } else {
        code = ' '.repeat(end + 2) + code.slice(end + 2)
        inBlockComment = false
      }
    }
    code = code.replace(/\/\*[\s\S]*?\*\//g, ' ')
    const blockStart = code.indexOf('/*')
    if (blockStart !== -1) {
      inBlockComment = true
      code = code.slice(0, blockStart)
    }
    // `[^:]` 挡住 `https://…` 这类协议分隔符被误当行注释。
    code = code.replace(/(^|[^:])\/\/.*$/, '$1')
    return { raw, code, lineNo: index + 1 }
  })
}

function matchingCodeLines(filePath: string, patterns: RegExp[]): string[] {
  return codeOnlyLines(fs.readFileSync(filePath, 'utf-8'))
    .filter(({ code }) => code.trim().length > 0 && patterns.some(pattern => pattern.test(code)))
    .map(({ raw, lineNo }) => `${rel(filePath)}:${lineNo}: ${raw.trim()}`)
}

/**
 * 只在 **import / require 说明符** 上匹配,不在整行上匹配。
 *
 * 起因(08-21 P2/D 组):"必须走包公开入口"那几条 check 拿 `packages/core/` 之类
 * 的裸字符串扫全行,15 条命中全是注释里的交叉引用(`见 packages/core/plugins/…`)
 * 和静态扫描测试里的路径串(`path.join(REPO_ROOT, 'packages/core/plugins')`)——
 * 前者是文档,后者是那些测试的**工作对象**,都不是 import。
 *
 * 这里先剥注释(`codeOnlyLines`),再从代码里抠出 `from '…'` / `import('…')` /
 * `import '…'` / `require('…')` 的说明符,只拿说明符去过模式 —— 断言语义回到它
 * 本来要说的那句话:**不许用深路径 import,要走包的公开入口**。
 */
function importSpecifiersInCode(code: string): string[] {
  const specifiers: string[] = []
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])([^'"]+)\1/g
  for (const match of code.matchAll(pattern)) specifiers.push(match[2])
  return specifiers
}

function matchingImportSpecifierLines(filePath: string, patterns: RegExp[]): string[] {
  return codeOnlyLines(fs.readFileSync(filePath, 'utf-8'))
    .filter(({ code }) =>
      importSpecifiersInCode(code).some(specifier => patterns.some(pattern => pattern.test(specifier))),
    )
    .map(({ raw, lineNo }) => `${rel(filePath)}:${lineNo}: ${raw.trim()}`)
}

function matchingTextLines(label: string, content: string, patterns: RegExp[], lineOffset = 0): string[] {
  return content
    .split(/\r?\n/)
    .map((line, index) => ({ line, lineNo: index + 1 + lineOffset }))
    .filter(({ line }) => patterns.some(pattern => pattern.test(line)))
    .map(({ line, lineNo }) => `${label}:${lineNo}: ${line.trim()}`)
}

function isAllowedMainAdapterLine(line: string): boolean {
  const [file] = line.split(':', 1)
  const allowPatterns = MAIN_ADAPTER_ALLOWLIST.get(file)
  return Boolean(allowPatterns?.some(pattern => pattern.test(line)))
}

function assertNoMatches(label: string, lines: string[]): void {
  if (lines.length === 0) {
    console.log(`[boundary] ok: ${label}`)
    return
  }

  console.error(`[boundary] failed: ${label}`)
  for (const line of lines) {
    console.error(`  ${line}`)
  }
  process.exitCode = 1
}

function checkCoreForbiddenImports(): void {
  const lines = walkFiles(path.join(root, 'packages/core'))
    .flatMap(file => matchingLines(file, CORE_FORBIDDEN_PATTERNS))
  assertNoMatches('packages/core has no Electron/main/shared/native npm forbidden imports', lines)
}

// packages/backend (`@onething/backend`, P3'd 前叫 src/app,再往前是
// apps/electron/src/main 的胶水) is the product assembly package. Unlike the
// runtime product package it may import @shared contracts and cordis — but it
// must stay electron-free: hosts inject their surfaces through configure*Host.
//
// C2(2026-09-03,`docs/design/client-sdk-2026-09.md` §5.2)加最后两条:**装配层
// 不许伸手拿壳的类型**。`@/` 与 `@renderer` 是 Vue 渲染层的两个别名 —— 装配层
// 引它们等于把一棵已退役的壳树钉进自己的类型图,还逼得 React 壳的 tsconfig 替
// 别人的账留一条 `@/types` 精确键(C1 留账,C2 结清:那四处已改引 `@shared/ipc`,
// 那张 Vue 桶本来就是从 `@shared` 再导出的)。方向只有一条:装配层 → `@shared`。
// **只管非测试文件**(`walkFiles` 缺省跳过 `__tests__`):
// `rpc/__tests__/session-events-listraw-projection.test.ts` 故意拿渲染层的
// `stores/ui-refold` 折叠器当被测对象——那是"RPC 交回来的账本喂不喂得动壳的折叠器"
// 这一格的**测试意图**,不是产品代码的依赖。
const APP_ASSEMBLY_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /require\(['"]electron['"]\)/,
  /@onething\/electron-host/,
  /from\s+['"]@main\//,
  /from\s+['"]@preload\//,
  /from\s+['"]@\//,
  /from\s+['"]@renderer(?:\/|['"])/,
]

/**
 * I3(§0b.3):**角色写在文件名里**。P3'a 起,产品层里跨进程契约的接线不再靠
 * "住在装配层那棵树"来表达,而是靠 `*.wiring.ts` 这个文件名后缀 —— 它是
 * `packages/onething-runtime/src`(app 之外)唯一允许 import `@shared/ipc` /
 * `@shared/events` 的文件形态。其余禁令(electron / @main / @preload / cordis)
 * 对 wiring 文件照旧生效:它只是被允许说跨进程词汇,不是被允许认识宿主。
 */
const SHARED_CONTRACT_PATTERN_SOURCES = new Set([
  String(/src\/shared/),
  String(/shared\/ipc/),
  String(/\.\.\/\.\.\/shared/),
  String(/\.\.\/\.\.\/\.\.\/shared/),
])

const RUNTIME_WIRING_FORBIDDEN_PATTERNS: RegExp[] = HOST_BOUNDARY_FORBIDDEN_PATTERNS
  .filter(pattern => !SHARED_CONTRACT_PATTERN_SOURCES.has(String(pattern)))

function isRuntimeWiringFile(file: string): boolean {
  return file.endsWith('.wiring.ts') || file.endsWith('.wiring.tsx')
}

function checkRuntimeHostBoundary(): void {
  // P3'd:装配层从 `runtime/src/app` 变成了独立包 `packages/backend`,所以这里走两棵
  // 树 —— 判据没变,只是"住哪棵树"现在由包边界表达,而不再由子目录前缀表达。
  const backendRoot = path.join(root, 'packages/backend')
  const lines = [...walkFiles(path.join(root, 'packages/onething-runtime')), ...walkFiles(backendRoot)]
    .flatMap(file => matchingLines(
      file,
      // packages/backend 是唯一可以 import cordis / @shared/ipc 的地方；产品层不感知底座。
      file.startsWith(backendRoot)
        ? APP_ASSEMBLY_FORBIDDEN_PATTERNS
        : [
            ...(isRuntimeWiringFile(file) ? RUNTIME_WIRING_FORBIDDEN_PATTERNS : HOST_BOUNDARY_FORBIDDEN_PATTERNS),
            ...CORDIS_FORBIDDEN_PATTERNS,
          ],
    ))
  assertNoMatches('packages/onething-runtime + packages/backend have no Electron/main/shared IPC forbidden imports', lines)
}

/**
 * I3 的另一半:`*.wiring.ts` 是**出口**,不是可以随便被产品逻辑拿来用的库。
 * 非 wiring 文件 import 一个 wiring 模块 = 跨进程词汇从后门渗回产品层,和
 * 直接 import `@shared/ipc` 等价 —— 所以同样禁掉。app 装配层不受此限
 * (它本来就可以说 `@shared/ipc`,接 wiring 出口正是它的工作;P3'd 之后它已是
 * 另一个包,根本不在这次遍历的范围里)。
 */
const RUNTIME_WIRING_IMPORT_PATTERN = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*\.wiring(?:\.js)?['"]/

function checkRuntimeWiringModulesStayAtTheEdge(): void {
  const lines = walkFiles(path.join(root, 'packages/onething-runtime/src'))
    .filter(file => !isRuntimeWiringFile(file)
      // 测试是那个模块的**验证**,不是产品逻辑对它的依赖 —— 允许直接 import。
      && !file.includes(`${path.sep}__tests__${path.sep}`)
      && !/\.(?:test|spec)\.tsx?$/.test(file))
    .flatMap(file => matchingLines(file, [RUNTIME_WIRING_IMPORT_PATTERN]))
  assertNoMatches('packages/onething-runtime product layer does not import *.wiring modules', lines)
}

/**
 * 会话**词汇**只有一份:`SESSION_EVENT_TYPES`(50 条)+ `SESSION_COMMAND_TYPES`(12 条)
 * 都住在 `packages/core/events/`,shared 只做再导出。这条 check 守的是"别再手抄"。
 *
 * 判据形态:**精确值集**,不是命名空间前缀。两张表在这里被当场解析出来(所以加一条
 * 事件 = 自动进禁令,不用改这个文件),然后在 core / backend / runtime / renderer /
 * shared-events 的**非测试**源码里找与表中某个值**逐字相等**的引号字面量 —— 任何位置:
 * `type: 'stream:error'`、`case 'message:updated':`、`onAnySession('stream:start')`、
 * `=== 'stream:complete'` 全算。
 *
 * 为什么不只扫 `type:` 后面:发射点和**消费点**各占词汇的一半,只守发射点等于
 * Shift+F12 只能列出一半引用 —— 订阅 / switch / 比较才是"谁在听"。
 *
 * 为什么不用 `/'[a-z]+:[a-z-]+'/` 这种前缀式模式:那会连 `media:`、`rpc:`、
 * `plugin:notification`、`node:fs`、全局事件 `session:created` 一起误伤。精确值集
 * 没有这个问题 —— 命中就是命中了这 62 个协议字符串之一。
 *
 * 豁免三类:两张表自己(它们**是**权威);测试(测试里手打字面量正是对常量值的独立
 * 复核 —— 常量改了值而测试没改,测试就该红);注释(`codeOnlyLines` 剥掉)。
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const SESSION_VOCABULARY_REGISTRY_FILES = [
  'packages/core/events/session-event-types.ts',
  'packages/core/events/session-command-types.ts',
]

/**
 * 值集当场从两张表里解析出来 —— 加一条事件 / 命令**自动**进禁令,不用回来改这个文件。
 * 每张表至少要出 10 条,否则说明表的书写形态变了而这里的解析悄悄空了(空集会让
 * 这条 check 永远绿,那比红更糟),当场报红。
 */
function sessionVocabularyLiterals(): string[] | null {
  const values: string[] = []
  for (const relFile of SESSION_VOCABULARY_REGISTRY_FILES) {
    const content = fs.readFileSync(path.join(root, relFile), 'utf-8')
    const parsed = [...content.matchAll(/^\s{2}[A-Z0-9_]+:\s*'([^']+)',$/gm)].map(match => match[1])
    if (parsed.length < 10) {
      console.error(`[boundary] failed: ${relFile} did not parse as a vocabulary table (${parsed.length} entries)`)
      return null
    }
    values.push(...parsed)
  }
  return values
}

function walkSourceFilesForVocabulary(dir: string, output: string[] = []): string[] {
  if (!fs.existsSync(dir)) return output
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === '.git') continue
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkSourceFilesForVocabulary(fullPath, output)
    } else if (/\.(ts|tsx|vue|mts)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
      output.push(fullPath)
    }
  }
  return output
}

function checkSessionVocabularyUsesTheRegistry(): void {
  const values = sessionVocabularyLiterals()
  if (!values) {
    process.exitCode = 1
    return
  }
  const registrySources = new Set(SESSION_VOCABULARY_REGISTRY_FILES.map(relFile => path.join(root, relFile)))
  const literalPattern = new RegExp(`(['"\`])(${values.map(escapeRegExp).join('|')})\\1`)
  const roots = [
    'packages/core',
    'packages/backend',
    'packages/onething-runtime/src',
    'packages/renderer',
    'packages/shared/events',
  ]
  const lines: string[] = []
  for (const relRoot of roots) {
    for (const file of walkSourceFilesForVocabulary(path.join(root, relRoot))) {
      if (registrySources.has(file)) continue
      // `.vue` 的 `<!-- … -->` 是注释,而 `codeOnlyLines` 只认 JS 的两种注释形态;
      // 挖空时保留换行,行号才对得上原文(报错行仍从原文取)。
      const original = fs.readFileSync(file, 'utf-8')
      const content = file.endsWith('.vue')
        ? original.replace(/<!--[\s\S]*?-->/g, block => block.replace(/[^\n]/g, ' '))
        : original
      const originalLines = original.split(/\r?\n/)
      for (const { code, lineNo } of codeOnlyLines(content)) {
        if (literalPattern.test(code)) lines.push(`${rel(file)}:${lineNo}: ${(originalLines[lineNo - 1] ?? '').trim()}`)
      }
    }
  }
  assertNoMatches(
    'session event/command vocabulary goes through SESSION_EVENT_TYPES / SESSION_COMMAND_TYPES (no hand-typed literals)',
    lines,
  )
}

function checkGatewayHostBoundary(): void {
  const lines = walkFiles(path.join(root, 'packages/gateway'))
    .flatMap(file => matchingLines(file, [
      ...HOST_BOUNDARY_FORBIDDEN_PATTERNS,
      ...GATEWAY_CORE_DEPENDENCY_FORBIDDEN_PATTERNS,
      ...GATEWAY_RUNTIME_DEPENDENCY_FORBIDDEN_PATTERNS,
    ]))
  assertNoMatches('packages/gateway has no Electron/main/shared IPC forbidden imports', lines)
}

function checkGatewayLoadsRuntimeFromHostBoundary(): void {
  const gatewayFile = path.join(root, 'packages/gateway/src/index.ts')
  const content = fs.existsSync(gatewayFile) ? fs.readFileSync(gatewayFile, 'utf-8') : ''
  const requiredSymbols = [
    'ONETHING_GATEWAY_RUNTIME_MODULE',
    'loadGatewayConversationRuntimeFromEnv',
    'isCoreConversationRuntime',
  ]
  const lines = [
    ...requiredSymbols
      .filter(symbol => !content.includes(symbol))
      .map(symbol => `${rel(gatewayFile)}: missing gateway runtime loader symbol ${symbol}`),
    ...(fs.existsSync(gatewayFile)
      ? matchingLines(gatewayFile, GATEWAY_STANDALONE_AGENT_FORBIDDEN_PATTERNS)
      : ['packages/gateway/src/index.ts: missing gateway package entrypoint']),
  ]

  assertNoMatches('packages/gateway loads onething runtime from host instead of creating an agent', lines)
}

function checkGatewayUsesExplicitTypingSignal(): void {
  const channelFile = path.join(root, 'packages/gateway/src/core/channel.ts')
  const bridgeFile = path.join(root, 'packages/gateway/src/core/bridge.ts')
  const channelContent = fs.existsSync(channelFile) ? fs.readFileSync(channelFile, 'utf-8') : ''
  const bridgeContent = fs.existsSync(bridgeFile) ? fs.readFileSync(bridgeFile, 'utf-8') : ''
  const lines = [
    ...(!channelContent.includes('typing?(msg: TypingMessage)')
      ? [`${rel(channelFile)}: missing explicit channel typing capability`]
      : []),
    ...(!bridgeContent.includes('channel.typing?.(msg)')
      ? [`${rel(bridgeFile)}: missing explicit typing signal dispatch`]
      : []),
    ...(fs.existsSync(bridgeFile)
      ? matchingLines(bridgeFile, GATEWAY_BRIDGE_TYPING_FORBIDDEN_PATTERNS)
      : ['packages/gateway/src/core/bridge.ts: missing gateway bridge']),
  ]

  assertNoMatches('packages/gateway uses explicit typing signal instead of empty text messages', lines)
}

function checkGatewayRegistersConfiguredChannels(): void {
  const gatewayFile = path.join(root, 'packages/gateway/src/index.ts')
  const gatewayConfigFile = path.join(root, 'packages/gateway/src/config.ts')
  const content = fs.existsSync(gatewayFile) ? fs.readFileSync(gatewayFile, 'utf-8') : ''
  const configContent = fs.existsSync(gatewayConfigFile) ? fs.readFileSync(gatewayConfigFile, 'utf-8') : ''
  const requiredGatewaySymbols = [
    'TelegramChannel',
    'createGatewayChannelsFromEnv',
    'readGatewayChannelIdsFromEnv',
    'for (const channel of channels)',
  ]
  const requiredConfigSymbols = [
    'GATEWAY_CHANNELS',
    'GATEWAY_TELEGRAM_BOT_TOKEN',
  ]
  const lines = [
    ...requiredGatewaySymbols
      .filter(symbol => !content.includes(symbol))
      .map(symbol => `${rel(gatewayFile)}: missing configured gateway channel symbol ${symbol}`),
    ...requiredConfigSymbols
      .filter(symbol => !configContent.includes(symbol))
      .map(symbol => `${rel(gatewayConfigFile)}: missing configured gateway channel config symbol ${symbol}`),
    ...(fs.existsSync(gatewayFile)
      ? matchingLines(gatewayFile, GATEWAY_CHANNEL_SELECTION_FORBIDDEN_PATTERNS)
      : ['packages/gateway/src/index.ts: missing gateway entrypoint']),
  ]

  assertNoMatches('packages/gateway registers configured IM channels', lines)
}

function checkGatewayWechatQrStateHandling(): void {
  const channelFile = path.join(root, 'packages/gateway/src/channels/wechat/index.ts')
  const channelTestFile = path.join(root, 'packages/gateway/src/channels/wechat/__tests__/channel.test.ts')
  const pollerTestFile = path.join(root, 'packages/gateway/src/channels/wechat/ilink/__tests__/poller.test.ts')
  const channelContent = fs.existsSync(channelFile) ? fs.readFileSync(channelFile, 'utf-8') : ''
  const channelTestContent = fs.existsSync(channelTestFile) ? fs.readFileSync(channelTestFile, 'utf-8') : ''
  const pollerTestContent = fs.existsSync(pollerTestFile) ? fs.readFileSync(pollerTestFile, 'utf-8') : ''
  const requiredChannelSymbols = [
    'scaned_but_redirect',
    'normalizeRedirectBaseUrl',
    'need_verifycode',
    'verify_code_blocked',
    'auth.baseUrl',
  ]
  const requiredChannelTestSymbols = [
    'follows QR login IDC redirects',
    'pair-code verification',
    'starts the poller with the saved auth base URL',
  ]
  const requiredPollerTestSymbols = [
    'accepts getupdates responses that omit ret',
    'sync_buf',
    'get_updates_buf',
  ]
  const lines = [
    ...(!fs.existsSync(channelFile)
      ? [`${rel(channelFile)}: missing WeChat gateway channel`]
      : []),
    ...(!fs.existsSync(channelTestFile)
      ? [`${rel(channelTestFile)}: missing WeChat channel QR-state tests`]
      : []),
    ...(!fs.existsSync(pollerTestFile)
      ? [`${rel(pollerTestFile)}: missing WeChat poller optional-ret tests`]
      : []),
    ...requiredChannelSymbols
      .filter(symbol => !channelContent.includes(symbol))
      .map(symbol => `${rel(channelFile)}: missing official iLink QR-state handling symbol ${symbol}`),
    ...requiredChannelTestSymbols
      .filter(symbol => !channelTestContent.includes(symbol))
      .map(symbol => `${rel(channelTestFile)}: missing WeChat channel QR-state test coverage ${symbol}`),
    ...requiredPollerTestSymbols
      .filter(symbol => !pollerTestContent.includes(symbol))
      .map(symbol => `${rel(pollerTestFile)}: missing WeChat poller getupdates compatibility test coverage ${symbol}`),
  ]

  assertNoMatches('packages/gateway follows official WeChat iLink QR and getupdates compatibility', lines)
}

function checkAgentsDomainRidesTheRpcChannel(): void {
  const retiredFiles = [
    'apps/electron/src/ipc/agents.ts',
    'apps/electron/src/main/ipc/agents.ts',
  ]
  const channelsFile = path.join(root, 'packages/shared/ipc/channels.ts')
  const routerFile = path.join(root, 'packages/shared/ipc/agents.ts')
  const domainFile = path.join(root, 'packages/backend/rpc/domains/agents.ts')
  const registryIndexFile = path.join(root, 'packages/backend/rpc/index.ts')
  const channelsContent = fs.existsSync(channelsFile) ? fs.readFileSync(channelsFile, 'utf-8') : ''
  const routerContent = fs.existsSync(routerFile) ? fs.readFileSync(routerFile, 'utf-8') : ''
  const domainContent = fs.existsSync(domainFile) ? fs.readFileSync(domainFile, 'utf-8') : ''
  const registryIndexContent = fs.existsSync(registryIndexFile) ? fs.readFileSync(registryIndexFile, 'utf-8') : ''
  const requiredDomainSymbols = [
    'listOnethingAgentsForIpc',
    'createOnethingAgentFromRequestForIpc',
    'updateOnethingAgentFromRequestForIpc',
    'deleteOnethingAgentFromRequestForIpc',
    'restoreOnethingAgentFromRequestForIpc',
  ]
  const lines = [
    ...retiredFiles
      .filter(file => fs.existsSync(path.join(root, file)))
      .map(file => `${file}: retired agents IPC line is back — the domain rides rpc:invoke now`),
    ...(/\bAGENTS_(LIST|CREATE|UPDATE|DELETE|RESTORE)\b/.test(channelsContent)
      ? ['packages/shared/ipc/channels.ts: a hand-written agents channel constant is back']
      : []),
    ...(!routerContent.includes("defineRouter<AgentsRoutes>('agents'")
      ? [`${rel(routerFile)}: missing agentsRouter definition`]
      : []),
    ...(!fs.existsSync(domainFile)
      ? [`${rel(domainFile)}: missing agents RPC domain`]
      : []),
    ...requiredDomainSymbols
      .filter(symbol => !domainContent.includes(symbol))
      .map(symbol => `${rel(domainFile)}: missing agents RPC domain symbol ${symbol}`),
    // 装配点是 feature 描述子(`{ id: 'rpc:agents', mount: ctx =>
    // ctx.registerRpcDomain(agentsRouter, agentsRpcHandlers) }`,K0/C0)。域文件
    // 本身只导出 handlers —— 每域那只「只有测试在用的注册包装」已随 S3 删掉
    // (它长得像入口,生产却零调用)。所以「域上了通用面」的判据认
    // **装配点上 router + handlers 成对出现**,而不是域文件里的绑定调用。
    ...(!registryIndexContent.includes('agentsRouter, agentsRpcHandlers')
      ? [`${rel(registryIndexFile)}: agents domain is not listed in the RPC assembly point`]
      : []),
  ]

  assertNoMatches('agents domain rides the generic RPC channel', lines)
}

/**
 * 提示词片段域已整体迁到通用 RPC 通道(主线 T1 第一批)。
 *
 * 这条检查因此是**反向**的:它守的不是"Electron 那侧还在",而是"Electron 那侧
 * 已经不在,而且没人偷偷把它加回来"。旧线只要复活一处(重建 @main handler、
 * 重新往 channels.ts 加 PROMPTS_* 常量),这里就红。
 */
function checkPromptsDomainRidesTheRpcChannel(): void {
  const retiredFiles = [
    'apps/electron/src/ipc/prompts.ts',
    'apps/electron/src/main/ipc/prompts.ts',
  ]
  const channelsFile = path.join(root, 'packages/shared/ipc/channels.ts')
  const routerFile = path.join(root, 'packages/shared/ipc/prompts.ts')
  const domainFile = path.join(root, 'packages/backend/rpc/domains/prompts.ts')
  const registryIndexFile = path.join(root, 'packages/backend/rpc/index.ts')
  const channelsContent = fs.existsSync(channelsFile) ? fs.readFileSync(channelsFile, 'utf-8') : ''
  const routerContent = fs.existsSync(routerFile) ? fs.readFileSync(routerFile, 'utf-8') : ''
  const domainContent = fs.existsSync(domainFile) ? fs.readFileSync(domainFile, 'utf-8') : ''
  const registryIndexContent = fs.existsSync(registryIndexFile) ? fs.readFileSync(registryIndexFile, 'utf-8') : ''
  const requiredDomainSymbols = [
    'listOnethingPromptsForIpc',
    'getOnethingPromptForIpc',
    'createOnethingPromptForIpc',
    'updateOnethingPromptForIpc',
    'deleteOnethingPromptForIpc',
  ]
  const lines = [
    ...retiredFiles
      .filter(file => fs.existsSync(path.join(root, file)))
      .map(file => `${file}: retired prompts IPC line is back — the domain rides rpc:invoke now`),
    ...(/\bPROMPTS_(LIST|GET|CREATE|UPDATE|DELETE)\b/.test(channelsContent)
      ? ['packages/shared/ipc/channels.ts: a hand-written prompts channel constant is back']
      : []),
    ...(!routerContent.includes("defineRouter<PromptsRoutes>('prompts'")
      ? [`${rel(routerFile)}: missing promptsRouter definition`]
      : []),
    ...(!fs.existsSync(domainFile)
      ? [`${rel(domainFile)}: missing prompts RPC domain`]
      : []),
    ...requiredDomainSymbols
      .filter(symbol => !domainContent.includes(symbol))
      .map(symbol => `${rel(domainFile)}: missing prompts RPC domain symbol ${symbol}`),
    ...(!registryIndexContent.includes('promptsRouter, promptsRpcHandlers')
      ? [`${rel(registryIndexFile)}: prompts domain is not listed in the RPC assembly point`]
      : []),
  ]

  assertNoMatches('prompts domain rides the generic RPC channel', lines)
}

function checkMarkdownDomainRidesTheRpcChannel(): void {
  // 主线 T 批 3：markdown 整只迁到通用 RPC 通道。守的还是同一件事 ——
  // 适配器不许把 runtime 拥有的那套流程再抄一遍 —— 只是适配器换了地址：
  // 从 `@main/ipc/markdown.ts` 变成 `app/rpc/domains/markdown.ts`。
  const retiredFiles = [
    'apps/electron/src/ipc/markdown.ts',
    'apps/electron/src/main/ipc/markdown.ts',
  ]
  const channelsFile = path.join(root, 'packages/shared/ipc/channels.ts')
  const routerFile = path.join(root, 'packages/shared/ipc/markdown.ts')
  const domainFile = path.join(root, 'packages/backend/rpc/domains/markdown.ts')
  const guardFile = path.join(root, 'packages/backend/wiring/markdown/asset-service.ts')
  const registryIndexFile = path.join(root, 'packages/backend/rpc/index.ts')
  const serverRuntimeFile = path.join(root, 'packages/backend/server/runtime.ts')
  const channelsContent = fs.existsSync(channelsFile) ? fs.readFileSync(channelsFile, 'utf-8') : ''
  const routerContent = fs.existsSync(routerFile) ? fs.readFileSync(routerFile, 'utf-8') : ''
  const domainContent = fs.existsSync(domainFile) ? fs.readFileSync(domainFile, 'utf-8') : ''
  const guardContent = fs.existsSync(guardFile) ? fs.readFileSync(guardFile, 'utf-8') : ''
  const registryIndexContent = fs.existsSync(registryIndexFile) ? fs.readFileSync(registryIndexFile, 'utf-8') : ''
  const serverRuntimeContent = fs.existsSync(serverRuntimeFile) ? fs.readFileSync(serverRuntimeFile, 'utf-8') : ''
  const requiredDomainSymbols = [
    'resolveRpcSandbox',
    'prepareMarkdownRequest',
    'clampResolvedAsset',
    'clampSavedAttachments',
    'resolveOnethingMarkdownAssetForIpc',
    'saveOnethingMarkdownAttachmentsForIpc',
  ]
  // 沙箱护栏必须留在 app 层的**调用路径**上：这几条是从 apps/server 搬过来的,
  // 搬丢了就等于迁移把安全护栏一起迁没了 —— 批 1 退回这个域正是为了避免这件事。
  // 注:Obsidian vault 判定的**实现**已按 "owns Markdown asset service" 规则归位
  // runtime(卫生批 7739c230),app 层留的是对它的调用 —— 守卫因此盯调用符号。
  const requiredGuardSymbols = [
    'isTargetInsideSandbox',
    'obsidianAttachmentRootStaysInside',
    'clampAttachmentDirectory',
  ]
  const lines = [
    ...retiredFiles
      .filter(file => fs.existsSync(path.join(root, file)))
      .map(file => `${file}: retired markdown IPC line is back — the domain rides rpc:invoke now`),
    ...(/\bMARKDOWN_(RESOLVE_ASSET|SAVE_ATTACHMENTS)\b/.test(channelsContent)
      ? ['packages/shared/ipc/channels.ts: a hand-written markdown channel constant is back']
      : []),
    ...(!routerContent.includes("defineRouter<MarkdownRoutes>('markdown'")
      ? [`${rel(routerFile)}: missing markdownRouter definition`]
      : []),
    ...(!fs.existsSync(domainFile)
      ? [`${rel(domainFile)}: missing markdown RPC domain`]
      : []),
    ...requiredDomainSymbols
      .filter(symbol => !domainContent.includes(symbol))
      .map(symbol => `${rel(domainFile)}: missing markdown RPC domain symbol ${symbol}`),
    ...requiredGuardSymbols
      .filter(symbol => !guardContent.includes(symbol))
      .map(symbol => `${rel(guardFile)}: missing markdown workspace sandbox guard ${symbol}`),
    ...(!registryIndexContent.includes('markdownRouter, markdownRpcHandlers')
      ? [`${rel(registryIndexFile)}: markdown domain is not listed in the RPC assembly point`]
      : []),
    ...(/prepareServerMarkdownRequest|sanitizeServerMarkdownAsset/.test(serverRuntimeContent)
      ? [`${rel(serverRuntimeFile)}: the server-side markdown sandbox helper is back — the guard lives in @onething/backend now`]
      : []),
  ]

  assertNoMatches('markdown domain rides the generic RPC channel', lines)
}

function checkPermissionGrantsDomainRidesTheRpcChannel(): void {
  // 主线 T 批 3：授权账页四条迁到通用 RPC 通道；`@main/ipc/permission.ts`
  // **不退役**,它还留着运行中权限询问那两条,所以这里守的是「四条别回来」
  // 而不是「文件别回来」。
  const channelsFile = path.join(root, 'packages/shared/ipc/channels.ts')
  const routerFile = path.join(root, 'packages/shared/ipc/permission-grants.ts')
  const domainFile = path.join(root, 'packages/backend/rpc/domains/permission-grants.ts')
  const registryIndexFile = path.join(root, 'packages/backend/rpc/index.ts')
  const mainPermissionFile = path.join(root, 'apps/electron/src/main/ipc/permission.ts')
  const serverRuntimeFile = path.join(root, 'packages/backend/server/runtime.ts')
  const channelsContent = fs.existsSync(channelsFile) ? fs.readFileSync(channelsFile, 'utf-8') : ''
  const routerContent = fs.existsSync(routerFile) ? fs.readFileSync(routerFile, 'utf-8') : ''
  const domainContent = fs.existsSync(domainFile) ? fs.readFileSync(domainFile, 'utf-8') : ''
  const registryIndexContent = fs.existsSync(registryIndexFile) ? fs.readFileSync(registryIndexFile, 'utf-8') : ''
  const mainPermissionContent = fs.existsSync(mainPermissionFile) ? fs.readFileSync(mainPermissionFile, 'utf-8') : ''
  const serverRuntimeContent = fs.existsSync(serverRuntimeFile) ? fs.readFileSync(serverRuntimeFile, 'utf-8') : ''
  const requiredDomainSymbols = [
    'resolveRpcSandbox',
    'listOnethingPermissionGrantsForIpc',
    'revokeOnethingPermissionGrantForIpc',
    'clearOnethingSessionPermissionGrantsForIpc',
    'clearOnethingWorkspacePermissionGrantsForIpc',
  ]
  const lines = [
    ...(/\bPERMISSION_(LIST_GRANTS|REVOKE_GRANT|CLEAR_SESSION_GRANTS|CLEAR_WORKSPACE_GRANTS)\b/.test(channelsContent)
      ? ['packages/shared/ipc/channels.ts: a hand-written permission grant channel constant is back']
      : []),
    ...(/listGrants|revokeGrant|clearSessionGrants|clearWorkspaceGrants/.test(mainPermissionContent)
      ? [`${rel(mainPermissionFile)}: a permission grant handler is back in @main — the domain rides rpc:invoke now`]
      : []),
    ...(!routerContent.includes("defineRouter<PermissionGrantsRoutes>('permissionGrants'")
      ? [`${rel(routerFile)}: missing permissionGrantsRouter definition`]
      : []),
    ...(!fs.existsSync(domainFile)
      ? [`${rel(domainFile)}: missing permissionGrants RPC domain`]
      : []),
    ...requiredDomainSymbols
      .filter(symbol => !domainContent.includes(symbol))
      .map(symbol => `${rel(domainFile)}: missing permissionGrants RPC domain symbol ${symbol}`),
    ...(!registryIndexContent.includes('permissionGrantsRouter, permissionGrantsRpcHandlers')
      ? [`${rel(registryIndexFile)}: permissionGrants domain is not listed in the RPC assembly point`]
      : []),
    // `resolveServerWorkspaceGrantRoot` 已随 P4c 第二批(skills 整域迁 router)一起删 ——
    // skills 是它最后一个消费者。这里只守授权归属那一个。
    ...(/canRevokePermissionGrant/.test(serverRuntimeContent)
      ? [`${rel(serverRuntimeFile)}: the server-side grant ownership helper is back — the guard lives in @onething/backend now`]
      : []),
  ]

  assertNoMatches('permissionGrants domain rides the generic RPC channel', lines)
}

/**
 * Provider 目录 / 配额 / env 域已整体迁到通用 RPC 通道(主线 T1 第二批)。
 * 反向检查,同 prompts / agents。
 */
function checkProvidersDomainRidesTheRpcChannel(): void {
  const retiredFiles = [
    'apps/electron/src/ipc/providers.ts',
    'apps/electron/src/main/ipc/providers.ts',
  ]
  const channelsFile = path.join(root, 'packages/shared/ipc/channels.ts')
  const routerFile = path.join(root, 'packages/shared/ipc/providers.ts')
  const domainFile = path.join(root, 'packages/backend/rpc/domains/providers.ts')
  const registryIndexFile = path.join(root, 'packages/backend/rpc/index.ts')
  const channelsContent = fs.existsSync(channelsFile) ? fs.readFileSync(channelsFile, 'utf-8') : ''
  const routerContent = fs.existsSync(routerFile) ? fs.readFileSync(routerFile, 'utf-8') : ''
  const domainContent = fs.existsSync(domainFile) ? fs.readFileSync(domainFile, 'utf-8') : ''
  const registryIndexContent = fs.existsSync(registryIndexFile) ? fs.readFileSync(registryIndexFile, 'utf-8') : ''
  const requiredDomainSymbols = [
    'listOnethingProvidersForIpc',
    'getOnethingProviderUsage',
    'inspectOnethingProviderEnvStatusForIpc',
  ]
  const lines = [
    ...retiredFiles
      .filter(file => fs.existsSync(path.join(root, file)))
      .map(file => `${file}: retired providers IPC line is back — the domain rides rpc:invoke now`),
    ...(/\bGET_PROVIDERS\b|\bGET_PROVIDER_USAGE\b|\bGET_PROVIDER_ENV_STATUS\b/.test(channelsContent)
      ? ['packages/shared/ipc/channels.ts: a hand-written providers channel constant is back']
      : []),
    ...(!routerContent.includes("defineRouter<ProvidersRoutes>('providers'")
      ? [`${rel(routerFile)}: missing providersRouter definition`]
      : []),
    ...(!fs.existsSync(domainFile)
      ? [`${rel(domainFile)}: missing providers RPC domain`]
      : []),
    ...requiredDomainSymbols
      .filter(symbol => !domainContent.includes(symbol))
      .map(symbol => `${rel(domainFile)}: missing providers RPC domain symbol ${symbol}`),
    ...(!registryIndexContent.includes('providersRouter, providersRpcHandlers')
      ? [`${rel(registryIndexFile)}: providers domain is not listed in the RPC assembly point`]
      : []),
  ]

  assertNoMatches('providers domain rides the generic RPC channel', lines)
}

/**
 * 模型注册表域已整体迁到通用 RPC 通道(主线 T1 第二批)。反向检查,同上。
 */
function checkModelsDomainRidesTheRpcChannel(): void {
  const retiredFiles = [
    'apps/electron/src/ipc/models.ts',
    'apps/electron/src/main/ipc/models.ts',
  ]
  const channelsFile = path.join(root, 'packages/shared/ipc/channels.ts')
  const routerFile = path.join(root, 'packages/shared/ipc/providers.ts')
  const domainFile = path.join(root, 'packages/backend/rpc/domains/models.ts')
  const registryIndexFile = path.join(root, 'packages/backend/rpc/index.ts')
  const channelsContent = fs.existsSync(channelsFile) ? fs.readFileSync(channelsFile, 'utf-8') : ''
  const routerContent = fs.existsSync(routerFile) ? fs.readFileSync(routerFile, 'utf-8') : ''
  const domainContent = fs.existsSync(domainFile) ? fs.readFileSync(domainFile, 'utf-8') : ''
  const registryIndexContent = fs.existsSync(registryIndexFile) ? fs.readFileSync(registryIndexFile, 'utf-8') : ''
  const requiredDomainSymbols = [
    'getOnethingModelsWithCapabilities',
    'getAllOnethingModelRegistryModelsForIpc',
    'searchOnethingModelRegistryForIpc',
    'refreshOnethingModelRegistryForIpc',
    'getOnethingModelRegistryNameAliasesForIpc',
    'getOnethingModelRegistryDisplayNameForIpc',
  ]
  const lines = [
    ...retiredFiles
      .filter(file => fs.existsSync(path.join(root, file)))
      .map(file => `${file}: retired models IPC line is back — the domain rides rpc:invoke now`),
    ...(/\bGET_MODELS_WITH_CAPABILITIES\b|\bGET_ALL_MODELS\b|\bSEARCH_MODELS\b|\bREFRESH_MODEL_REGISTRY\b|\bGET_MODEL_NAME_ALIASES\b|\bGET_MODEL_DISPLAY_NAME\b/.test(channelsContent)
      ? ['packages/shared/ipc/channels.ts: a hand-written models channel constant is back']
      : []),
    ...(!routerContent.includes("defineRouter<ModelsRoutes>('models'")
      ? [`${rel(routerFile)}: missing modelsRouter definition`]
      : []),
    ...(!fs.existsSync(domainFile)
      ? [`${rel(domainFile)}: missing models RPC domain`]
      : []),
    ...requiredDomainSymbols
      .filter(symbol => !domainContent.includes(symbol))
      .map(symbol => `${rel(domainFile)}: missing models RPC domain symbol ${symbol}`),
    ...(!registryIndexContent.includes('modelsRouter, modelsRpcHandlers')
      ? [`${rel(registryIndexFile)}: models domain is not listed in the RPC assembly point`]
      : []),
  ]

  assertNoMatches('models domain rides the generic RPC channel', lines)
}

function checkMainUsesRuntimePackageImports(): void {
  const lines = walkFiles(path.join(root, 'packages/backend'), [], { includeTests: true })
    .flatMap(file => matchingImportSpecifierLines(file, MAIN_RUNTIME_SOURCE_IMPORT_FORBIDDEN_PATTERNS))
  assertNoMatches('Electron main and tests import onething-runtime via package public entrypoints', lines)
}

function checkMainUsesCorePackageImports(): void {
  const lines = walkFiles(path.join(root, 'packages/backend'), [], { includeTests: true })
    .flatMap(file => matchingImportSpecifierLines(file, MAIN_CORE_SOURCE_IMPORT_FORBIDDEN_PATTERNS))
  assertNoMatches('Electron main and tests import headless core via package public entrypoints', lines)
}

function checkMainUsesGatewayPackageImports(): void {
  const lines = walkFiles(path.join(root, 'packages/backend'), [], { includeTests: true })
    .flatMap(file => matchingImportSpecifierLines(file, MAIN_GATEWAY_SOURCE_IMPORT_FORBIDDEN_PATTERNS))
  assertNoMatches('Electron main and tests import gateway via package public entrypoints', lines)
}

function checkCorePackageDependencies(): void {
  const packagePath = path.join(root, 'packages/core/package.json')
  const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf-8')) as {
    dependencies?: Record<string, string>
  }
  const allowed = new Set(['@anthropic-ai/sdk'])
  const dependencyNames = Object.keys(parsed.dependencies ?? {})
  const disallowed = dependencyNames.filter(name => !allowed.has(name))
  assertNoMatches(
    'packages/core package dependencies are limited to approved runtime dependencies',
    disallowed.map(name => `${rel(packagePath)}: dependency ${name}`),
  )
}

function checkMainCoreSystemAdapters(): void {
  const lines = [
    ...MAIN_CORE_SYSTEM_DIRS
      .flatMap(dir => walkFiles(path.join(root, dir)))
      .flatMap(file => matchingLines(file, MAIN_FORBIDDEN_IMPORT_PATTERNS)),
    ...MAIN_FILE_IO_SYSTEM_DIRS
      .flatMap(dir => walkFiles(path.join(root, dir)))
      .flatMap(file => matchingLines(file, MAIN_HOST_FORBIDDEN_IMPORT_PATTERNS)),
  ].filter(line => !isAllowedMainAdapterLine(line))
  assertNoMatches('main core-system directories only keep explicit adapter imports', lines)
}

function checkCorePublicExports(): void {
  const indexPath = path.join(root, 'packages/core/index.ts')
  const content = fs.readFileSync(indexPath, 'utf-8')
  const required = [
    'AgentEngine',
    'EventBus',
    'ContextManager',
    'CoreStreamEngine',
    'HeadlessMCPManager',
    'CorePluginManager',
  ]
  const missing = required.filter(symbol => !content.includes(symbol))
  assertNoMatches(
    'packages/core/index.ts exports required public core interfaces',
    missing.map(symbol => `${rel(indexPath)}: missing ${symbol}`),
  )
}

function checkCoreToolHelperTestsLiveInCorePackage(): void {
  const requiredCoreTests = [
    'packages/core/tools/__tests__/registry.test.ts',
    'packages/core/tools/__tests__/permission-guards.test.ts',
    'packages/core/tools/__tests__/tool-result.test.ts',
  ]
  const forbiddenMainTests = [
    'packages/backend/wiring/tools/__tests__/core-registry.test.ts',
    'packages/backend/wiring/tools/__tests__/core-permission-guards.test.ts',
    'packages/backend/wiring/tools/__tests__/core-tool-result.test.ts',
  ]
  const lines = [
    ...requiredCoreTests
      .filter(file => !fs.existsSync(path.join(root, file)))
      .map(file => `${file}: missing core package tool helper test`),
    ...forbiddenMainTests
      .filter(file => fs.existsSync(path.join(root, file)))
      .map(file => `${file}: core tool helper tests belong in packages/core/tools/__tests__`),
  ]

  assertNoMatches('packages/core owns core tool helper tests', lines)
}

/**
 * R4b —— 旧的 `coreProviderToolSchemaFromParameters`(provider schema 投影)随
 * 旧注册表删除。这条规则的意图没变(**JSON Schema → 宿主形状的投影归 core**),
 * 只是主语换成了新树唯一还在用的那一个:`coreToolDefinitionFromJsonSchema`,
 * 它的消费者是 `app/toolkit/catalog-projection.ts`。
 */
function checkCoreOwnsToolSchemaProjection(): void {
  const coreRegistryFile = path.join(root, 'packages/core/tools/registry.ts')
  const coreIndexFile = path.join(root, 'packages/core/tools/index.ts')
  const coreTestFile = path.join(root, 'packages/core/tools/__tests__/registry.test.ts')
  const projectionFile = path.join(root, 'packages/onething-runtime/src/toolkit/catalog-projection.wiring.ts')
  const coreRegistryContent = fs.existsSync(coreRegistryFile) ? fs.readFileSync(coreRegistryFile, 'utf-8') : ''
  const coreIndexContent = fs.existsSync(coreIndexFile) ? fs.readFileSync(coreIndexFile, 'utf-8') : ''
  const coreTestContent = fs.existsSync(coreTestFile) ? fs.readFileSync(coreTestFile, 'utf-8') : ''
  const projectionContent = fs.existsSync(projectionFile) ? fs.readFileSync(projectionFile, 'utf-8') : ''
  const requiredCoreSymbols = [
    'CoreToolDefinitionFromJsonSchemaInput',
    'coreToolDefinitionFromJsonSchema',
    'coreToolParameterFromSchema',
    'normalizeCoreToolParameterType',
  ]
  const lines = [
    ...requiredCoreSymbols
      .filter(symbol => !coreRegistryContent.includes(symbol))
      .map(symbol => `${rel(coreRegistryFile)}: missing core-owned tool schema projection symbol ${symbol}`),
    ...requiredCoreSymbols
      .filter(symbol => !coreIndexContent.includes(symbol))
      .map(symbol => `${rel(coreIndexFile)}: missing core tools public export ${symbol}`),
    ...(!coreTestContent.includes('coreToolDefinitionFromJsonSchema')
      ? [`${rel(coreTestFile)}: missing core-owned parameter schema projection coverage`]
      : []),
    ...(!projectionContent.includes('coreToolDefinitionFromJsonSchema')
      ? [`${rel(projectionFile)}: catalog projection must reuse the core schema projection`]
      : []),
  ]

  assertNoMatches('packages/core owns legacy tool schema projection', lines)
}

function checkCoreOwnsToolFailureParameterSummary(): void {
  const coreFile = path.join(root, 'packages/core/tools/tool-result.ts')
  const coreIndexFile = path.join(root, 'packages/core/tools/index.ts')
  const coreRootIndexFile = path.join(root, 'packages/core/index.ts')
  const coreTestFile = path.join(root, 'packages/core/tools/__tests__/tool-result.test.ts')
  const sharedFile = path.join(root, 'packages/shared/tool-failure-params.ts')
  const coreContent = fs.existsSync(coreFile) ? fs.readFileSync(coreFile, 'utf-8') : ''
  const coreIndexContent = fs.existsSync(coreIndexFile) ? fs.readFileSync(coreIndexFile, 'utf-8') : ''
  const coreRootIndexContent = fs.existsSync(coreRootIndexFile) ? fs.readFileSync(coreRootIndexFile, 'utf-8') : ''
  const coreTestContent = fs.existsSync(coreTestFile) ? fs.readFileSync(coreTestFile, 'utf-8') : ''
  const sharedContent = fs.existsSync(sharedFile) ? fs.readFileSync(sharedFile, 'utf-8') : ''
  const requiredSymbols = [
    'ToolFailureParameterSummary',
    'summarizeToolFailureParameters',
  ]
  const lines = [
    ...requiredSymbols
      .filter(symbol => !coreContent.includes(symbol))
      .map(symbol => `${rel(coreFile)}: missing core-owned tool failure parameter symbol ${symbol}`),
    ...requiredSymbols
      .filter(symbol => !coreIndexContent.includes(symbol))
      .map(symbol => `${rel(coreIndexFile)}: missing public core tools failure parameter export ${symbol}`),
    ...requiredSymbols
      .filter(symbol => !coreRootIndexContent.includes(symbol))
      .map(symbol => `${rel(coreRootIndexFile)}: missing public root core failure parameter export ${symbol}`),
    ...requiredSymbols
      .filter(symbol => !coreTestContent.includes(symbol))
      .map(symbol => `${rel(coreTestFile)}: missing core failure parameter test coverage for ${symbol}`),
    ...(!sharedContent.includes('@onething/core/tools')
      ? [`${rel(sharedFile)}: legacy shared tool failure parameters must re-export core tools protocol`]
      : []),
    ...(/from\s+['"]@onething\/core['"]/.test(sharedContent)
      ? [`${rel(sharedFile)}: legacy shared tool failure parameters must not import broad core root entrypoint`]
      : []),
    ...(fs.existsSync(sharedFile)
      ? matchingLines(sharedFile, SHARED_TOOL_FAILURE_PARAMETERS_FORBIDDEN_PATTERNS)
      : [`${rel(sharedFile)}: missing legacy tool failure parameter facade`]),
  ]

  assertNoMatches('packages/core owns tool failure parameter summary', lines)
}

function checkCoreOwnsToolPermissionErrorText(): void {
  const coreFile = path.join(root, 'packages/core/permission/index.ts')
  const coreRootIndexFile = path.join(root, 'packages/core/index.ts')
  const coreTestFile = path.join(root, 'packages/core/permission/__tests__/permission-errors.test.ts')
  const coreToolResultFile = path.join(root, 'packages/core/tools/tool-result.ts')
  const sharedFile = path.join(root, 'packages/shared/tool-errors.ts')
  const coreContent = fs.existsSync(coreFile) ? fs.readFileSync(coreFile, 'utf-8') : ''
  const coreRootIndexContent = fs.existsSync(coreRootIndexFile) ? fs.readFileSync(coreRootIndexFile, 'utf-8') : ''
  const coreTestContent = fs.existsSync(coreTestFile) ? fs.readFileSync(coreTestFile, 'utf-8') : ''
  const coreToolResultContent = fs.existsSync(coreToolResultFile) ? fs.readFileSync(coreToolResultFile, 'utf-8') : ''
  const sharedContent = fs.existsSync(sharedFile) ? fs.readFileSync(sharedFile, 'utf-8') : ''
  const requiredSymbols = [
    'DEFAULT_PERMISSION_REJECTED_MESSAGE',
    'formatPermissionRejectedMessage',
  ]
  const lines = [
    ...requiredSymbols
      .filter(symbol => !coreContent.includes(symbol))
      .map(symbol => `${rel(coreFile)}: missing core-owned tool permission error text ${symbol}`),
    ...requiredSymbols
      .filter(symbol => !coreRootIndexContent.includes(symbol))
      .map(symbol => `${rel(coreRootIndexFile)}: missing root core permission error text export ${symbol}`),
    ...requiredSymbols
      .filter(symbol => !coreTestContent.includes(symbol))
      .map(symbol => `${rel(coreTestFile)}: missing permission error text test coverage for ${symbol}`),
    // §17.8 U1-a:那句话搬去了零依赖叶子 `permission/rejection-message.ts`
    // (桶带 `node:crypto|os|path`,而 `tool-result` 在投影折叠器的浏览器闭包里)。
    // 门守的**事实没变** —— "复用 core 那一份,不许自己再抄一句";变的只是它从
    // 哪条路径取。两条都认:桶再导出的就是叶子里那两样。
    ...(!coreToolResultContent.includes("from '../permission/index.js'")
      && !coreToolResultContent.includes("from '../permission/rejection-message.js'")
      ? [`${rel(coreToolResultFile)}: tool failure text must reuse core permission error text`]
      : []),
    ...(fs.existsSync(coreToolResultFile)
      ? matchingLines(coreToolResultFile, CORE_TOOL_RESULT_PERMISSION_ERROR_DUPLICATE_FORBIDDEN_PATTERNS)
      : [`${rel(coreToolResultFile)}: missing core tool result helper`]),
    ...(!sharedContent.includes('@onething/core/permission')
      ? [`${rel(sharedFile)}: legacy shared tool errors must re-export core permission protocol`]
      : []),
    ...(fs.existsSync(sharedFile)
      ? matchingLines(sharedFile, SHARED_TOOL_ERRORS_FORBIDDEN_PATTERNS)
      : [`${rel(sharedFile)}: missing legacy tool errors facade`]),
  ]

  assertNoMatches('packages/core owns tool permission error text', lines)
}

/**
 * R4b:`bash-runtime.test.ts` / `builtin/__tests__/time.test.ts` 随旧工具对象
 * 删除,必需清单换成**还活着的那几个纯模块测试**(它们正是新树 import 的那批)。
 * 规则的意图一个字没变:工具帮手的测试住在产品包里,不许爬进装配树。
 */
function checkRuntimeToolHelperTestsLiveInRuntimePackage(): void {
  const requiredRuntimeTests = [
    'packages/onething-runtime/src/tools/__tests__/file-snapshot.test.ts',
    'packages/onething-runtime/src/tools/__tests__/sandbox.test.ts',
    'packages/onething-runtime/src/tools/__tests__/edit-engine.test.ts',
    'packages/onething-runtime/src/tools/__tests__/sensitive-files.test.ts',
    'packages/onething-runtime/src/toolkit/__tests__/golden/time.test.ts',
    'packages/onething-runtime/src/toolkit/__tests__/golden/bash.test.ts',
  ]
  const forbiddenMainTests = [
    'packages/backend/wiring/tools/__tests__/core-bash-runtime.test.ts',
    'packages/backend/wiring/tools/__tests__/core-file-snapshot.test.ts',
    'packages/backend/wiring/tools/__tests__/core-sandbox.test.ts',
    'packages/backend/wiring/tools/__tests__/core-time.test.ts',
  ]
  const timeTest = path.join(root, 'packages/onething-runtime/src/toolkit/__tests__/golden/time.test.ts')
  const timeContent = fs.existsSync(timeTest) ? fs.readFileSync(timeTest, 'utf-8') : ''
  const lines = [
    ...requiredRuntimeTests
      .filter(file => !fs.existsSync(path.join(root, file)))
      .map(file => `${file}: missing runtime package tool helper test`),
    ...forbiddenMainTests
      .filter(file => fs.existsSync(path.join(root, file)))
      .map(file => `${file}: tool helper tests belong in packages/onething-runtime`),
    ...(!timeContent.includes('TimeTool')
      ? [`${rel(timeTest)}: missing runtime-owned direct time engine coverage`]
      : []),
  ]

  assertNoMatches('packages/onething-runtime owns runtime tool helper tests', lines)
}

function checkCoreOwnsSessionCommandIpcOperation(): void {
  const runtimeFiles = [
    path.join(root, 'packages/core/events/ipc-operations.ts'),
    path.join(root, 'packages/core/events/index.ts'),
  ]
  // 结构债 P4c 第四批:命令总线的入口从 `@main/ipc/handlers.ts` 的 `ipcMain.handle`
  // 搬到 `session-command` RPC 域,所以「不许在别处重抄一遍 emit」这条守的是域文件。
  const mainFile = path.join(root, 'packages/backend/rpc/domains/session-command.ts')
  // 2026-08-22(#21):`@main/ipc/chat.ts` 已随第七条一起删掉,只剩 chat 域要守。
  const chatDomainFile = path.join(root, 'packages/backend/rpc/domains/chat.ts')
  const runtimeContent = runtimeFiles
    .map(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '')
    .join('\n')
  const requiredRuntimeSymbols = [
    'emitCoreSessionCommandForIpc',
    'emitCoreSessionEventSafely',
    'CoreSessionCommandEmitterLike',
    'CoreSessionCommandIpcResult',
    'CoreSessionEventEmitterLike',
  ]
  const lines = [
    ...runtimeFiles
      .filter(file => !fs.existsSync(file))
      .map(file => `${rel(file)}: missing core-owned session command IPC operation`),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `packages/core/events/ipc-operations.ts: missing core-owned ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_SESSION_COMMAND_HANDLER_FORBIDDEN_PATTERNS)
      : ['packages/backend/rpc/domains/session-command.ts: missing session-command RPC domain']),
    // P4c 第五批:同一条规矩守 chat RPC 域(停止收尾在那里发会话事件)。
    ...(fs.existsSync(chatDomainFile)
      ? matchingLines(chatDomainFile, MAIN_SAFE_SESSION_EVENT_EMIT_FORBIDDEN_PATTERNS)
      : ['packages/backend/rpc/domains/chat.ts: missing chat RPC domain']),
  ]

  assertNoMatches('packages/core owns session command/event IPC projections', lines)
}

function checkCoreOwnsStreamChunkProtocol(): void {
  const coreFile = path.join(root, 'packages/core/events/stream-chunks.ts')
  const coreIndexFile = path.join(root, 'packages/core/events/index.ts')
  const coreTestFile = path.join(root, 'packages/core/events/__tests__/stream-chunks.test.ts')
  const sharedFile = path.join(root, 'packages/shared/events/stream-chunks.ts')
  const coreContent = fs.existsSync(coreFile) ? fs.readFileSync(coreFile, 'utf-8') : ''
  const coreIndexContent = fs.existsSync(coreIndexFile) ? fs.readFileSync(coreIndexFile, 'utf-8') : ''
  const coreTestContent = fs.existsSync(coreTestFile) ? fs.readFileSync(coreTestFile, 'utf-8') : ''
  const sharedContent = fs.existsSync(sharedFile) ? fs.readFileSync(sharedFile, 'utf-8') : ''
  const requiredSymbols = [
    'TextDeltaChunk',
    'ReasoningPlacement',
    'ReasoningDeltaChunk',
    'ToolInputDeltaChunk',
    'StreamChunk',
  ]
  const lines = [
    ...(!fs.existsSync(coreFile)
      ? [`${rel(coreFile)}: missing core-owned stream chunk protocol`]
      : []),
    ...(!fs.existsSync(coreTestFile)
      ? [`${rel(coreTestFile)}: missing core-owned stream chunk protocol tests`]
      : []),
    ...requiredSymbols
      .filter(symbol => !coreContent.includes(symbol))
      .map(symbol => `${rel(coreFile)}: missing core-owned stream chunk symbol ${symbol}`),
    ...requiredSymbols
      .filter(symbol => !coreIndexContent.includes(symbol))
      .map(symbol => `${rel(coreIndexFile)}: missing public core stream chunk export ${symbol}`),
    ...requiredSymbols
      .filter(symbol => !coreTestContent.includes(symbol))
      .map(symbol => `${rel(coreTestFile)}: missing stream chunk protocol test coverage for ${symbol}`),
    ...(!sharedContent.includes('@onething/core/events')
      ? [`${rel(sharedFile)}: legacy shared stream chunks must re-export core event protocol`]
      : []),
    ...(fs.existsSync(sharedFile)
      ? matchingLines(sharedFile, SHARED_STREAM_CHUNK_PROTOCOL_FORBIDDEN_PATTERNS)
      : [`${rel(sharedFile)}: missing legacy stream chunk facade`]),
  ]

  assertNoMatches('packages/core owns stream chunk protocol', lines)
}

function checkCoreOwnsJsonProtocol(): void {
  const coreFile = path.join(root, 'packages/core/json.ts')
  const coreIndexFile = path.join(root, 'packages/core/index.ts')
  const corePackageFile = path.join(root, 'packages/core/package.json')
  const coreTestFile = path.join(root, 'packages/core/__tests__/json.test.ts')
  const sharedFile = path.join(root, 'packages/shared/json.ts')
  const coreContent = fs.existsSync(coreFile) ? fs.readFileSync(coreFile, 'utf-8') : ''
  const coreIndexContent = fs.existsSync(coreIndexFile) ? fs.readFileSync(coreIndexFile, 'utf-8') : ''
  const corePackageContent = fs.existsSync(corePackageFile) ? fs.readFileSync(corePackageFile, 'utf-8') : ''
  const coreTestContent = fs.existsSync(coreTestFile) ? fs.readFileSync(coreTestFile, 'utf-8') : ''
  const sharedContent = fs.existsSync(sharedFile) ? fs.readFileSync(sharedFile, 'utf-8') : ''
  const requiredSymbols = [
    'JsonPrimitive',
    'JsonValue',
    'JsonObjectProperty',
    'JsonObject',
    'JsonArray',
    'JsonSchemaObject',
    'isJsonObject',
    'parseJsonObject',
    'toJsonValue',
    'toJsonObject',
    'toJsonSchemaObject',
  ]
  const lines = [
    ...(!fs.existsSync(coreFile)
      ? [`${rel(coreFile)}: missing core-owned JSON protocol`]
      : []),
    ...(!fs.existsSync(coreTestFile)
      ? [`${rel(coreTestFile)}: missing core-owned JSON protocol tests`]
      : []),
    ...requiredSymbols
      .filter(symbol => !coreContent.includes(symbol))
      .map(symbol => `${rel(coreFile)}: missing core-owned JSON protocol symbol ${symbol}`),
    ...requiredSymbols
      .filter(symbol => !coreIndexContent.includes(symbol))
      .map(symbol => `${rel(coreIndexFile)}: missing public core JSON protocol export ${symbol}`),
    ...requiredSymbols
      .filter(symbol => !coreTestContent.includes(symbol))
      .map(symbol => `${rel(coreTestFile)}: missing JSON protocol test coverage for ${symbol}`),
    ...(!corePackageContent.includes('"./json": "./json.ts"')
      ? [`${rel(corePackageFile)}: missing public @onething/core/json export`]
      : []),
    ...(!sharedContent.includes('@onething/core/json')
      ? [`${rel(sharedFile)}: legacy shared JSON protocol must re-export core JSON protocol`]
      : []),
    ...(/from\s+['"]@onething\/core['"]/.test(sharedContent)
      ? [`${rel(sharedFile)}: legacy shared JSON protocol must not import broad core root entrypoint`]
      : []),
    ...(fs.existsSync(sharedFile)
      ? matchingLines(sharedFile, SHARED_JSON_PROTOCOL_FORBIDDEN_PATTERNS)
      : [`${rel(sharedFile)}: missing legacy JSON protocol facade`]),
  ]

  assertNoMatches('packages/core owns JSON protocol', lines)
}

function checkChatResumeAfterToolConfirmStaysRetired(): void {
  const channelsFile = path.join(root, 'packages/shared/ipc/channels.ts')
  const channelsContent = fs.existsSync(channelsFile) ? fs.readFileSync(channelsFile, 'utf-8') : ''
  const retiredFiles = [
    'apps/electron/src/ipc/chat.ts',
    'apps/electron/src/main/ipc/chat.ts',
    'packages/onething-runtime/src/sessions/tool-confirmation.ts',
  ]
  const lines = [
    ...(channelsContent.includes('chat:resume-after-tool-confirm')
      ? [`${rel(channelsFile)}: retired chat resume-after-tool-confirm channel came back`]
      : []),
    ...retiredFiles
      .filter(file => fs.existsSync(path.join(root, file)))
      .map(file => `${file}: retired chat resume-after-tool-confirm handwritten IPC came back`),
  ]

  assertNoMatches('chat resume-after-tool-confirm IPC chain stays retired', lines)
}

// P4c 第八批:files 的十四条数据面已迁 `filesRouter`,那只手写 IPC 工厂
// (`apps/electron/src/ipc/files.ts`)与它的壳适配(`@main/ipc/files.ts`)**整只删掉**,
// 连同 `apps/electron/package.json` 的 `./ipc/files` 导出。所以
// `checkElectronHostOwnsFilesIpcHost` 也随之退休:没有宿主件要守了。
// 域的形状由 `packages/backend/rpc/__tests__/files-domain.test.ts` 钉,
// 「投影逻辑不许搬进传输层」由下面六条 `checkRuntimeOwns*`(已改指域文件)守。

// P4c 第五批:sessions 的 26 条数据面已迁 `sessionsRouter`,那只手写 IPC 工厂
// (`apps/electron/src/ipc/sessions.ts`)与它的壳适配(`@main/ipc/sessions.ts`)
// **整只删掉** —— 连同四条契约表外的字面量通道。所以
// `checkElectronHostOwnsSessionsIpcHost` 也随之退休:没有宿主件要守了。
// 域的形状由 `packages/backend/rpc/__tests__/sessions-domain.test.ts` 钉。

function checkCorePromptAssemblyOwnedByRuntime(): void {
  const files = [
    path.join(root, 'packages/core/engine/system-prompt.ts'),
    path.join(root, 'packages/core/engine/index.ts'),
  ]
  const removedFiles = [
    'packages/core/engine/system-prompt-snapshot.ts',
  ].filter(file => fs.existsSync(path.join(root, file)))
  const lines = [
    ...files
      .filter(file => fs.existsSync(file))
      .flatMap(file => matchingLines(file, CORE_PROMPT_ASSEMBLY_FORBIDDEN_PATTERNS)),
    ...removedFiles.map(file => `${file}: prompt snapshot assembly belongs in packages/onething-runtime`),
  ]
  assertNoMatches('packages/core keeps prompt assembly out of the headless boundary', lines)
}

function checkCorePromptContextRegistryOwnedByRuntime(): void {
  const removedFiles = [
    'packages/core/engine/plugin-context.ts',
    'packages/core/storage/app-state.ts',
  ].filter(file => fs.existsSync(path.join(root, file)))

  assertNoMatches(
    'packages/core keeps runtime registries and app state out of the headless boundary',
    removedFiles.map(file => `${file}: runtime-owned state belongs in packages/onething-runtime`),
  )
}

function checkRuntimeOwnsOnethingStoragePaths(): void {
  const file = path.join(root, 'packages/onething-runtime/src/storage/paths.ts')
  const lines = fs.existsSync(file)
    ? matchingLines(file, RUNTIME_STORAGE_PATH_CORE_PROXY_PATTERNS)
    : [`packages/onething-runtime/src/storage/paths.ts: missing runtime storage path contract`]

  assertNoMatches('packages/onething-runtime owns onething storage path construction', lines)
}

function checkRuntimeOwnsPermissionGrantFileStorage(): void {
  const file = path.join(root, 'packages/core/permission/permission-grants.ts')
  const lines = fs.existsSync(file)
    ? matchingLines(file, CORE_PERMISSION_FILE_STORAGE_FORBIDDEN_PATTERNS)
    : []

  assertNoMatches('packages/onething-runtime owns permission grant file storage layout', lines)
}

function checkRuntimeOwnsPermissionGrantsIpcPresentation(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/permissions/permission-grants-presentation.ts')
  const mainFile = path.join(root, 'apps/electron/src/main/ipc/permission.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'listOnethingPermissionGrants',
    'listOnethingPermissionGrantsForIpc',
    'revokeOnethingPermissionGrant',
    'revokeOnethingPermissionGrantForIpc',
    'clearOnethingSessionPermissionGrants',
    'clearOnethingSessionPermissionGrantsForIpc',
    'clearOnethingWorkspacePermissionGrants',
    'clearOnethingWorkspacePermissionGrantsForIpc',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_PERMISSION_IPC_GRANTS_FORBIDDEN_PATTERNS)
      // 结构债 P4c:该域已整只迁到通用 RPC 通道,旧的 `@main/ipc/<域>.ts` 适配文件
      // 不存在了 —— 「文件缺席 = 红」这一支随之退役,上面「runtime 拥有实现」的断言照旧。
      : []),
  ]

  assertNoMatches('packages/onething-runtime owns permission grants IPC presentation', lines)
}

function checkRuntimeOwnsPermissionSessionIpcPresentation(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/permissions/permission-session-presentation.ts')
  const mainFile = path.join(root, 'apps/electron/src/main/ipc/permission.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'getOnethingPendingPermissions',
    'getOnethingPendingPermissionsForIpc',
    'clearOnethingPermissionSession',
    'clearOnethingPermissionSessionForIpc',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_PERMISSION_IPC_SESSION_FORBIDDEN_PATTERNS)
      // 结构债 P4c:该域已整只迁到通用 RPC 通道,旧的 `@main/ipc/<域>.ts` 适配文件
      // 不存在了 —— 「文件缺席 = 红」这一支随之退役,上面「runtime 拥有实现」的断言照旧。
      : []),
  ]

  assertNoMatches('packages/onething-runtime owns permission session IPC presentation', lines)
}

function checkRuntimeOwnsAuthTokenStorage(): void {
  const runtimeFile = 'packages/onething-runtime/src/auth/token-store.ts'
  const mainFile = path.join(root, 'packages/onething-runtime/src/auth/token-store.wiring.ts')
  const mainContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf-8') : ''
  const mainFacadeLines = mainContent.split('\n').filter(line => line.trim().length > 0)
  const lines = [
    ...(!fs.existsSync(path.join(root, runtimeFile))
      ? [`${runtimeFile}: missing runtime-owned OAuth token store`]
      : []),
    ...(!mainContent.includes('tokenCryptoAdapter')
      ? [`${rel(mainFile)}: token store must take encryption via the injected auth host port`]
      : []),
    ...(mainContent.includes('@onething/electron-host/')
      ? [`${rel(mainFile)}: main/auth token store must stay host-agnostic (inject via configureAuthHost)`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_AUTH_TOKEN_STORE_FORBIDDEN_PATTERNS)
      : ['packages/onething-runtime/src/auth/token-store.wiring.ts: missing Electron safeStorage adapter facade']),
  ]

  assertNoMatches('packages/onething-runtime owns OAuth token storage layout', lines)
}

function checkRuntimeOwnsAuthServiceFlow(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/auth/auth-service.ts')
  const runtimeFactoryFile = path.join(root, 'packages/onething-runtime/src/auth/service-factory.ts')
  const runtimeIndexFile = path.join(root, 'packages/onething-runtime/src/auth/index.ts')
  const mainFile = path.join(root, 'packages/backend/wiring/auth/auth-service.ts')
  const runtimeFactoryContent = fs.existsSync(runtimeFactoryFile) ? fs.readFileSync(runtimeFactoryFile, 'utf-8') : ''
  const runtimeIndexContent = fs.existsSync(runtimeIndexFile) ? fs.readFileSync(runtimeIndexFile, 'utf-8') : ''
  const requiredRuntimeFactorySymbols = [
    'OnethingAuthRuntimeOptions',
    'createOnethingAuthServiceOptions',
    'createOnethingAuthService',
    'getAuthProviderDefinition',
    'callbackServerManager',
  ]
  const lines = [
    ...(!fs.existsSync(runtimeFile)
      ? [`${rel(runtimeFile)}: missing runtime-owned OAuth service flow`]
      : []),
    ...(!fs.existsSync(runtimeFactoryFile)
      ? [`${rel(runtimeFactoryFile)}: missing runtime-owned OAuth service factory`]
      : []),
    ...requiredRuntimeFactorySymbols
      .filter(symbol => !runtimeFactoryContent.includes(symbol))
      .map(symbol => `${rel(runtimeFactoryFile)}: missing runtime auth service factory symbol ${symbol}`),
    ...(!runtimeIndexContent.includes('createOnethingAuthServiceOptions')
      ? [`${rel(runtimeIndexFile)}: missing auth service factory public export`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_AUTH_SERVICE_RUNTIME_FORBIDDEN_PATTERNS)
      : ['packages/backend/wiring/auth/auth-service.ts: missing Electron auth adapter facade']),
  ]

  assertNoMatches('packages/onething-runtime owns OAuth service flow orchestration', lines)
}

function checkRuntimeOwnsAuthCallbackServer(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/auth/callback-server.ts')
  const runtimeIndexFile = path.join(root, 'packages/onething-runtime/src/auth/index.ts')
  const mainFile = path.join(root, 'packages/backend/wiring/auth/callback-server.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const runtimeIndexContent = fs.existsSync(runtimeIndexFile) ? fs.readFileSync(runtimeIndexFile, 'utf-8') : ''
  const mainContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'CallbackServerManager',
    'callbackServerManager',
    'OnethingAuthCallbackRegistration',
    'http.createServer',
    'registerFlow',
    'unregisterState',
    'cleanup',
    'writeCallbackPage',
  ]
  const lines = [
    ...(!fs.existsSync(runtimeFile)
      ? [`${rel(runtimeFile)}: missing runtime-owned OAuth callback server`]
      : []),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned OAuth callback server symbol ${symbol}`),
    ...(!runtimeIndexContent.includes('callbackServerManager')
      ? [`${rel(runtimeIndexFile)}: missing auth callback server public export`]
      : []),
    // P3'a-1(I2):`app/auth/callback-server.ts` 只是 `export … from
    // '@onething/runtime/auth'` 的转发,与 runtime 同名文件重复同一概念,已删除;
    // 调用方直接 import `@onething/runtime/auth`。**它回来才算红。**
    ...(fs.existsSync(mainFile)
      ? [
          `${rel(mainFile)}: auth callback-server legacy facade should be removed; import @onething/runtime/auth directly`,
          ...matchingLines(mainFile, MAIN_AUTH_CALLBACK_SERVER_FORBIDDEN_PATTERNS),
        ]
      : []),
  ]

  assertNoMatches('packages/onething-runtime owns OAuth callback server', lines)
}

function checkRuntimeOwnsOAuthIpcOperations(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/auth/ipc-operations.ts')
  // P4c 第七批:oauth 六条数据面整域迁 router,`@main` 那层壳适配已删 —— 判据改指域文件。
  const mainFile = path.join(root, 'packages/backend/rpc/domains/oauth.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'startOnethingOAuthForIpc',
    'completeOnethingOAuthCallbackForIpc',
    'pollOnethingOAuthDeviceFlowForIpc',
    'refreshOnethingOAuthForIpc',
    'getOnethingOAuthStatusForIpc',
    'logoutOnethingOAuthForIpc',
  ]
  const lines = [
    ...(!fs.existsSync(runtimeFile)
      ? [`${rel(runtimeFile)}: missing runtime-owned OAuth IPC operations`]
      : []),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned OAuth IPC operation ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_OAUTH_IPC_OPERATIONS_FORBIDDEN_PATTERNS)
      : ['packages/backend/rpc/domains/oauth.ts: missing OAuth RPC domain']),
  ]

  assertNoMatches('packages/onething-runtime owns OAuth IPC operations', lines)
}

function checkRuntimeOwnsStreamRuntimeWiring(): void {
  const runtimeFile = 'packages/onething-runtime/src/product-stream-runtime.ts'
  const runtimeIndexFile = path.join(root, 'packages/onething-runtime/src/index.ts')
  const mainFile = path.join(root, 'packages/backend/wiring/engine/stream-engine-runtime.ts')
  const runtimeContent = fs.existsSync(path.join(root, runtimeFile))
    ? fs.readFileSync(path.join(root, runtimeFile), 'utf-8')
    : ''
  const runtimeIndexContent = fs.existsSync(runtimeIndexFile) ? fs.readFileSync(runtimeIndexFile, 'utf-8') : ''
  const mainContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'OnethingProductStreamRuntimeHostAdapters',
    'createOnethingProductStreamRuntimeFromHostAdapters',
  ]
  const lines = [
    ...(!fs.existsSync(path.join(root, runtimeFile))
      ? [`${runtimeFile}: missing runtime-owned onething product stream runtime builder`]
      : []),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${runtimeFile}: missing runtime-owned product stream host adapter symbol ${symbol}`),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeIndexContent.includes(symbol))
      .map(symbol => `${rel(runtimeIndexFile)}: missing public product stream host adapter export ${symbol}`),
    ...(!mainContent.includes('createOnethingProductStreamRuntimeFromHostAdapters')
      ? [`${rel(mainFile)}: main stream runtime facade must delegate host adapter assembly to packages/onething-runtime`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_STREAM_RUNTIME_WIRING_FORBIDDEN_PATTERNS)
      : ['packages/backend/wiring/engine/stream-engine-runtime.ts: missing Electron stream runtime adapter facade']),
  ]

  assertNoMatches('packages/onething-runtime owns stream runtime wiring', lines)
}

function checkRuntimeOwnsHistoryHelperWiring(): void {
  const mainFiles = [
    path.join(root, 'packages/backend/wiring/engine/stream/message-helpers.ts'),
    path.join(root, 'packages/backend/wiring/engine/stream/resume-history.ts'),
  ]
  const lines = mainFiles.flatMap(file => fs.existsSync(file)
    ? matchingLines(file, MAIN_HISTORY_HELPER_CORE_WIRING_FORBIDDEN_PATTERNS)
    : []
  )

  assertNoMatches('packages/onething-runtime owns onething history helper wiring', lines)
}

function checkRuntimeOwnsAgentLoopRuntimeWiring(): void {
  const file = path.join(root, 'packages/backend/wiring/engine/stream/agent-loop-runtime.ts')
  const lines = fs.existsSync(file)
    ? matchingLines(file, MAIN_AGENT_LOOP_RUNTIME_WIRING_FORBIDDEN_PATTERNS)
    : []

  assertNoMatches('packages/onething-runtime owns agent-loop runtime adapter wiring', lines)
}

function checkRuntimeOwnsAgentLoopSelection(): void {
  const runtimeFile = 'packages/onething-runtime/src/agent-loop/selection.ts'
  // P3'e-A2b 删掉了装配层那个换名薄适配(`wiring/engine/stream/agent-loop-selection.ts`,
  // 28 行、只把三个 `Onething*` 符号改回短名):调用点直接读产品层。所以这条断言
  // 从「门面必须在」翻成「门面**回来**才算红」—— 它一旦重新出现,就说明有人又在
  // 装配层复制了一份选路判据。
  const retiredFacade = 'packages/backend/wiring/engine/stream/agent-loop-selection.ts'
  const lines = [
    ...(!fs.existsSync(path.join(root, runtimeFile))
      ? [`${runtimeFile}: missing runtime-owned onething agent-loop stream selection`]
      : []),
    ...(fs.existsSync(path.join(root, retiredFacade))
      ? [`${retiredFacade}: retired selection facade came back (P3'e-A2b)`]
      : []),
    ...matchingLines(path.join(root, 'packages/backend/wiring/engine/prompt/system-prompt-snapshot.ts'),
      MAIN_AGENT_LOOP_SELECTION_FORBIDDEN_PATTERNS),
  ]

  assertNoMatches('packages/onething-runtime owns onething agent-loop stream selection', lines)
}

function checkCoreOwnsAgentLoopPureFacades(): void {
  const mainIndexFile = path.join(root, 'packages/backend/wiring/agent-loop/index.ts')
  const mainIndexContent = fs.existsSync(mainIndexFile) ? fs.readFileSync(mainIndexFile, 'utf-8') : ''
  const removedMainFacades = [
    'packages/backend/wiring/agent-loop/bridge.ts',
    'packages/backend/wiring/agent-loop/capabilities.ts',
    'packages/backend/wiring/agent-loop/chunks.ts',
    'packages/backend/wiring/agent-loop/errors.ts',
    'packages/backend/wiring/agent-loop/messages.ts',
    'packages/backend/wiring/agent-loop/prompts.ts',
    'packages/backend/wiring/agent-loop/provider-stream.ts',
    'packages/backend/wiring/agent-loop/runner.ts',
    'packages/backend/wiring/agent-loop/stream.ts',
    'packages/backend/wiring/agent-loop/tool-names.ts',
    'packages/backend/wiring/agent-loop/tool-results.ts',
    'packages/backend/wiring/agent-loop/types.ts',
    'packages/backend/wiring/agent-loop/providers/sse.ts',
  ]
  const lines = removedMainFacades
    .filter(file => fs.existsSync(path.join(root, file)))
    .map(file => `${file}: agent-loop facade should be removed; import @onething/core/agent-loop or @onething/runtime/agent-loop/providers directly`)
    .concat(mainIndexContent.includes("@onething/core/agent-loop")
      ? [`${rel(mainIndexFile)}: agent-loop index should only export Electron host adapters; import @onething/core/agent-loop directly for core APIs`]
      : [])

  assertNoMatches('packages/core owns pure agent-loop facades', lines)
}

function checkRuntimeOwnsProviderRequestDump(): void {
  const runtimeFile = 'packages/onething-runtime/src/providers/request-dump.ts'
  const mainFile = path.join(root, 'packages/backend/provider-binding/request-dump.ts')
  const lines = [
    ...(!fs.existsSync(path.join(root, runtimeFile))
      ? [`${runtimeFile}: missing runtime-owned provider request dump implementation`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_PROVIDER_REQUEST_DUMP_FORBIDDEN_PATTERNS)
      : ['packages/backend/provider-binding/request-dump.ts: missing main provider request dump facade']),
  ]

  assertNoMatches('packages/onething-runtime owns provider request dump implementation', lines)
}

function checkRuntimeOwnsProviderRegistry(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/providers/registry.ts')
  const mainFile = path.join(root, 'packages/backend/wiring/providers/registry.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const mainContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'OnethingProviderRegistryDefinition',
    'OnethingProviderRegistry',
    'createProviderRegistry',
    'invalidateProviderCache',
    'isProviderSupported',
    'requiresSystemMerge',
    'requiresOAuth',
  ]
  const mainLines = mainContent.split('\n').filter(line => line.trim().length > 0)
  const lines = [
    ...(!fs.existsSync(runtimeFile)
      ? [`${rel(runtimeFile)}: missing runtime-owned provider registry`]
      : []),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned provider registry symbol ${symbol}`),
    ...(!mainContent.includes('@onething/runtime/providers')
      ? [`${rel(mainFile)}: provider registry facade must delegate to @onething/runtime/providers`]
      : []),
    ...(mainLines.length > 100
      ? [`${rel(mainFile)}: provider registry facade must stay thin`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_PROVIDER_REGISTRY_FORBIDDEN_PATTERNS)
      : ['packages/backend/wiring/providers/registry.ts: missing provider registry facade']),
  ]

  assertNoMatches('packages/onething-runtime owns provider registry', lines)
}

function checkRuntimeOwnsProviderDefinitionTypes(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/providers/provider-definition.ts')
  const runtimeIndexFile = path.join(root, 'packages/onething-runtime/src/providers/index.ts')
  const mainFile = path.join(root, 'packages/onething-runtime/src/providers/types.wiring.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const runtimeIndexContent = fs.existsSync(runtimeIndexFile) ? fs.readFileSync(runtimeIndexFile, 'utf-8') : ''
  const mainContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'OnethingProviderInfo',
    'OnethingProviderConfig',
    'OnethingProviderCallOptions',
    'OnethingProviderCallPreparationContext',
    'OnethingProviderDefinition',
  ]
  const lines = [
    ...(!fs.existsSync(runtimeFile)
      ? [`${rel(runtimeFile)}: missing runtime-owned provider definition types`]
      : []),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned provider definition type ${symbol}`),
    ...(!runtimeIndexContent.includes('./provider-definition.js')
      ? [`${rel(runtimeIndexFile)}: missing provider definition public export`]
      : []),
    // P3'b-B:这张 `@shared/ipc` 口味的类型面搬进了 `runtime/src/providers/`
    // (闭包零脊柱边),所以"委派给 runtime"现在写成同包相对的 `./index.js`。
    ...(!mainContent.includes('./index.js')
      ? [`${rel(mainFile)}: provider type facade must delegate to the runtime provider barrel`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_PROVIDER_TYPES_FORBIDDEN_PATTERNS)
      : ['packages/onething-runtime/src/providers/types.wiring.ts: missing provider type facade']),
  ]

  assertNoMatches('packages/onething-runtime owns provider definition types', lines)
}

function checkRuntimeOwnsProviderOauthConfigResolution(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/providers/oauth-config.ts')
  const mainFile = path.join(root, 'packages/backend/wiring/providers/index.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'resolveOnethingOAuthProviderConfig',
    'refreshTokenIfNeeded',
    'requiresOAuth',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned provider OAuth config resolution ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_PROVIDER_OAUTH_CONFIG_FORBIDDEN_PATTERNS)
      : ['packages/backend/wiring/providers/index.ts: missing provider facade']),
  ]

  assertNoMatches('packages/onething-runtime owns provider OAuth config resolution', lines)
}

function checkRuntimeOwnsProviderFacadeOrchestration(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/providers/provider-facade.ts')
  const runtimeTestFile = path.join(root, 'packages/onething-runtime/src/providers/__tests__/provider-facade.test.ts')
  const runtimeIndexFile = path.join(root, 'packages/onething-runtime/src/providers/index.ts')
  const mainFile = path.join(root, 'packages/backend/wiring/providers/index.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const runtimeIndexContent = fs.existsSync(runtimeIndexFile) ? fs.readFileSync(runtimeIndexFile, 'utf-8') : ''
  const mainContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf-8') : ''
  // The stream-side facade members (streamChatResponseWithTools /
  // streamChatWithUIMessages / streamChatResponse*) were deleted in P0 of
  // docs/design/provider-abstraction.md — they had zero production callers.
  // What this rule still guards: the facade itself lives in runtime and the
  // app layer only delegates to it.
  const requiredRuntimeSymbols = [
    'createOnethingProviderFacade',
    'OnethingProviderFacadeAdapters',
    'generateChatResponseWithReasoning',
  ]
  const lines = [
    ...(!fs.existsSync(runtimeFile)
      ? [`${rel(runtimeFile)}: missing runtime-owned provider facade orchestration`]
      : []),
    ...(!fs.existsSync(runtimeTestFile)
      ? [`${rel(runtimeTestFile)}: missing runtime-owned provider facade tests`]
      : []),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned provider facade symbol ${symbol}`),
    ...(!runtimeIndexContent.includes('./provider-facade.js')
      ? [`${rel(runtimeIndexFile)}: missing provider facade public export`]
      : []),
    ...(!mainContent.includes('createOnethingProviderFacade')
      ? [`${rel(mainFile)}: main provider facade must delegate orchestration to createOnethingProviderFacade`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_PROVIDER_FACADE_LOW_LEVEL_FORBIDDEN_PATTERNS)
      : ['packages/backend/wiring/providers/index.ts: missing provider facade']),
  ]

  assertNoMatches('packages/onething-runtime owns provider facade orchestration', lines)
}

function checkRuntimeOwnsProviderTitleOrchestration(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/providers/provider-routing.ts')
  const mainFile = path.join(root, 'packages/backend/wiring/providers/index.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'generateOnethingProviderChatTitle',
    'buildOnethingChatTitleGenerationRequest',
    'cleanOnethingGeneratedChatTitle',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned provider title orchestration ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_PROVIDER_TITLE_ORCHESTRATION_FORBIDDEN_PATTERNS)
      : ['packages/backend/wiring/providers/index.ts: missing provider facade']),
  ]

  assertNoMatches('packages/onething-runtime owns provider title orchestration', lines)
}

function checkRuntimeOwnsProviderTextResponseProjection(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/providers/provider-routing.ts')
  const mainFile = path.join(root, 'packages/backend/wiring/providers/index.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  // streamOnethingTextChatResponse was deleted in P0 (zero callers); the
  // generate-side projection is still the live one.
  const requiredRuntimeSymbols = [
    'generateOnethingTextChatResponse',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned provider text response projection ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_PROVIDER_TEXT_RESPONSE_PROJECTION_FORBIDDEN_PATTERNS)
      : ['packages/backend/wiring/providers/index.ts: missing provider facade']),
  ]

  assertNoMatches('packages/onething-runtime owns provider text response projection', lines)
}

function checkRuntimeOwnsProviderGenerateReasoningOrchestration(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/providers/provider-routing.ts')
  const mainFile = path.join(root, 'packages/backend/wiring/providers/index.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'generateOnethingChatResponseWithReasoning',
    'streamACPResponse',
    'resolveRuntimeRoute',
    'mergeMessagesForGenerate',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned provider generate-with-reasoning orchestration ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_PROVIDER_GENERATE_REASONING_ORCHESTRATION_FORBIDDEN_PATTERNS)
      : ['packages/backend/wiring/providers/index.ts: missing provider facade']),
  ]

  assertNoMatches('packages/onething-runtime owns provider generate-with-reasoning orchestration', lines)
}

function checkRuntimeOwnsProviderAcpStreamProjection(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/providers/provider-routing.ts')
  const mainFile = path.join(root, 'packages/backend/wiring/providers/index.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'streamOnethingACPChatResponseWithTools',
    'projectOnethingACPPromptStreamEvent',
    'getLatestOnethingUserMessageText',
    'mapOnethingACPStopReason',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned ACP stream projection ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_PROVIDER_ACP_STREAM_PROJECTION_FORBIDDEN_PATTERNS)
      : ['packages/backend/wiring/providers/index.ts: missing provider facade']),
  ]

  assertNoMatches('packages/onething-runtime owns provider ACP stream projection', lines)
}

function checkRuntimeOwnsAcpIpcOperations(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/acp/ipc-operations.ts')
  // P4c 第六批:八条 acp 通道从 `@main` 壳适配搬到了 RPC 域,「不许在调用点重实现
  // 一遍」这条禁令跟着改指到新家。
  const mainFile = path.join(root, 'packages/backend/rpc/domains/acp.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'normalizeOnethingACPAgentConfig',
    'getOnethingACPAgentsForIpc',
    'addOnethingACPAgentForIpc',
    'updateOnethingACPAgentForIpc',
    'removeOnethingACPAgentForIpc',
    'connectOnethingACPAgentForIpc',
    'disconnectOnethingACPAgentForIpc',
    'refreshOnethingACPAgentForIpc',
    'cancelOnethingACPSessionForIpc',
  ]
  const lines = [
    ...(!fs.existsSync(runtimeFile)
      ? [`${rel(runtimeFile)}: missing runtime-owned ACP IPC operations`]
      : []),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned ACP IPC operation ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_ACP_IPC_OPERATIONS_FORBIDDEN_PATTERNS)
      : ['packages/backend/rpc/domains/acp.ts: missing ACP RPC domain']),
  ]

  assertNoMatches('packages/onething-runtime owns ACP IPC operations', lines)
}

function checkRuntimeOwnsAcpClientRuntime(): void {
  const runtimeClientFile = path.join(root, 'packages/onething-runtime/src/acp/client.ts')
  const runtimeManagerFile = path.join(root, 'packages/onething-runtime/src/acp/manager.ts')
  const runtimeTypesFile = path.join(root, 'packages/onething-runtime/src/acp/types.ts')
  const runtimeIndexFile = path.join(root, 'packages/onething-runtime/src/acp/index.ts')
  const mainFiles = [
    path.join(root, 'packages/backend/wiring/acp/client.ts'),
    path.join(root, 'packages/backend/wiring/acp/manager.ts'),
    path.join(root, 'packages/backend/wiring/acp/types.ts'),
    path.join(root, 'packages/backend/wiring/acp/index.ts'),
  ]
  const runtimeClientContent = fs.existsSync(runtimeClientFile) ? fs.readFileSync(runtimeClientFile, 'utf-8') : ''
  const runtimeManagerContent = fs.existsSync(runtimeManagerFile) ? fs.readFileSync(runtimeManagerFile, 'utf-8') : ''
  const runtimeTypesContent = fs.existsSync(runtimeTypesFile) ? fs.readFileSync(runtimeTypesFile, 'utf-8') : ''
  const runtimeIndexContent = fs.existsSync(runtimeIndexFile) ? fs.readFileSync(runtimeIndexFile, 'utf-8') : ''
  const requiredClientSymbols = [
    'ACPClient',
    'ClientSideConnection',
    'ndJsonStream',
    'streamPrompt',
    'createTerminal',
    'requestPermission',
  ]
  const requiredManagerSymbols = [
    'ACPManager',
    'ACPManagerClass',
    'syncClients',
    'streamPrompt',
    'ensureCleanupTimer',
  ]
  const requiredTypeSymbols = [
    'ACPAgentConfig',
    'ACPAgentState',
    'ACPSettings',
    'ACPPromptStreamEvent',
    'ACPPromptStreamOptions',
  ]
  // P3'a-1(I2):这四个 app 门面本来就只是 `export … from '@onething/runtime/acp'`
  // 的转发,和 runtime 里同名文件一字不差地重复着同一个概念。归位后它们被删除,
  // 调用方直接 import `@onething/runtime/acp` —— 所以断言反过来:**它们回来才算红**
  // (同 checkRuntimeOwnsThemeRuntime 的 mainHelperFiles 判例)。文件真回来了,照旧
  // 扫一遍禁令模式,双保险不变。
  const mainFacadeLines = mainFiles.flatMap(file => fs.existsSync(file)
    ? [
        `${rel(file)}: ACP legacy facade should be removed; import @onething/runtime/acp directly`,
        ...matchingLines(file, MAIN_ACP_RUNTIME_FORBIDDEN_PATTERNS),
      ]
    : [])
  const lines = [
    ...(!fs.existsSync(runtimeClientFile)
      ? [`${rel(runtimeClientFile)}: missing runtime ACP client`]
      : []),
    ...(!fs.existsSync(runtimeManagerFile)
      ? [`${rel(runtimeManagerFile)}: missing runtime ACP manager`]
      : []),
    ...(!fs.existsSync(runtimeTypesFile)
      ? [`${rel(runtimeTypesFile)}: missing runtime ACP types`]
      : []),
    ...requiredClientSymbols
      .filter(symbol => !runtimeClientContent.includes(symbol))
      .map(symbol => `${rel(runtimeClientFile)}: missing runtime ACP client symbol ${symbol}`),
    ...requiredManagerSymbols
      .filter(symbol => !runtimeManagerContent.includes(symbol))
      .map(symbol => `${rel(runtimeManagerFile)}: missing runtime ACP manager symbol ${symbol}`),
    ...requiredTypeSymbols
      .filter(symbol => !runtimeTypesContent.includes(symbol))
      .map(symbol => `${rel(runtimeTypesFile)}: missing runtime ACP type symbol ${symbol}`),
    ...(!runtimeIndexContent.includes('ACPClient') || !runtimeIndexContent.includes('ACPManager')
      ? [`${rel(runtimeIndexFile)}: missing ACP runtime public exports`]
      : []),
    ...mainFacadeLines,
  ]

  assertNoMatches('packages/onething-runtime owns ACP client runtime', lines)
}

/**
 * R4b —— 旧的 `runtime/tools/direct-tool-execution.ts`(把 ctx 回调翻成 IPC 的那
 * 约 350 行)随旧树删除,这条规则的意图仍然成立并且更硬了:**每一次工具直调只有
 * 一个必经点**,而它必须把活儿交出去,不许在装配层就地实现一条管线。
 */
function checkRuntimeOwnsDirectToolExecutionAdapter(): void {
  const mainFile = path.join(root, 'packages/backend/wiring/engine/stream/tool-execution.ts')
  const wiringFile = path.join(root, 'packages/backend/wiring/toolkit/wiring.ts')
  const mainContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf-8') : ''
  const wiringContent = fs.existsSync(wiringFile) ? fs.readFileSync(wiringFile, 'utf-8') : ''
  const lines = [
    ...(!fs.existsSync(mainFile)
      ? ['packages/backend/wiring/engine/stream/tool-execution.ts: missing tool execution facade']
      : []),
    ...(!mainContent.includes('runToolkitToolDirectly')
      ? [`${rel(mainFile)}: executeToolDirectly must delegate to the toolkit runner`]
      : []),
    ...(!wiringContent.includes('createAppToolRunner')
      ? [`${rel(wiringFile)}: the single direct-call seam must build the app tool runner`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_DIRECT_TOOL_EXECUTION_FORBIDDEN_PATTERNS)
      : []),
  ]

  assertNoMatches('packages/onething-runtime owns direct tool execution adapter', lines)
}

/**
 * R4b —— `runtime/tools/tool-execution.ts` 只是 `executeCoreToolAndUpdate` 外面
 * 三行转换器的一层壳,随旧树删除,三行搬到了唯一的调用点。规则的意图不变:
 * **工具调用状态的编排归 core**,装配层不许自己再写一份。
 */
function checkRuntimeOwnsToolUpdateOrchestration(): void {
  const coreFile = path.join(root, 'packages/core/engine/index.ts')
  const mainFile = path.join(root, 'packages/backend/wiring/engine/stream/tool-execution.ts')
  const coreContent = fs.existsSync(coreFile) ? fs.readFileSync(coreFile, 'utf-8') : ''
  const mainContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf-8') : ''
  const lines = [
    ...(!coreContent.includes('executeCoreToolAndUpdate')
      ? [`${rel(coreFile)}: missing core-owned tool update orchestration executeCoreToolAndUpdate`]
      : []),
    ...(!fs.existsSync(mainFile)
      ? ['packages/backend/wiring/engine/stream/tool-execution.ts: missing tool execution facade']
      : []),
    ...(!mainContent.includes('executeCoreToolAndUpdate')
      ? [`${rel(mainFile)}: tool update orchestration must delegate to core`]
      : []),
  ]

  assertNoMatches('packages/onething-runtime owns tool update orchestration', lines)
}

function checkRuntimeOwnsStreamProcessorAdapter(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/stream-processor.ts')
  const mainFile = path.join(root, 'packages/backend/wiring/engine/stream/stream-processor.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  // F4-b1(§16.16):`createCoreId` 从这张必备表里下线 —— 适配器不再持有 step id
  // 的工厂(id 由 callId 派生,产地在 `core/engine/tool-step.ts`)。规则要守的
  // "装配 core 处理器的是 runtime 适配器、后端只留门面"由这两个符号照旧钉住。
  const requiredRuntimeSymbols = [
    'createOnethingStreamProcessor',
    'createCoreStreamProcessor',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned stream processor adapter ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_STREAM_PROCESSOR_ADAPTER_FORBIDDEN_PATTERNS)
      : ['packages/backend/wiring/engine/stream/stream-processor.ts: missing stream processor facade']),
  ]

  assertNoMatches('packages/onething-runtime owns stream processor adapter', lines)
}

function checkRuntimeOwnsImageStreamEntryPoint(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/media/image-generation.ts')
  const mainFile = path.join(root, 'packages/backend/wiring/engine/stream/image-stream.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'executeOnethingImageGenerationStream',
    'executeCoreImageGenerationStream',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned image stream entry point ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_IMAGE_STREAM_ENTRY_FORBIDDEN_PATTERNS)
      : ['packages/backend/wiring/engine/stream/image-stream.ts: missing image stream facade']),
  ]

  assertNoMatches('packages/onething-runtime owns image stream entry point', lines)
}

function checkRuntimeOwnsProvidersIpcUsageFlow(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/providers/provider-usage.ts')
  // 域迁到通用 RPC 通道后(主线 T1 第二批),宿主适配器换了地址:守的还是
  // 同一件事 —— 适配器不许把 runtime 拥有的那套流程再抄一遍。
  const adapterFile = path.join(root, 'packages/backend/rpc/domains/providers.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const lines = [
    ...(!runtimeContent.includes('getOnethingProviderUsage')
      ? [`${rel(runtimeFile)}: missing runtime-owned provider usage flow`]
      : []),
    ...(fs.existsSync(adapterFile)
      ? matchingLines(adapterFile, MAIN_PROVIDERS_IPC_USAGE_FORBIDDEN_PATTERNS)
      : [`${rel(adapterFile)}: missing providers RPC domain`]),
  ]

  assertNoMatches('packages/onething-runtime owns provider usage flow', lines)
}

function checkRuntimeOwnsProvidersIpcPresentation(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/providers/provider-presentation.ts')
  const adapterFile = path.join(root, 'packages/backend/rpc/domains/providers.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'listOnethingProviders',
    'listOnethingProvidersForIpc',
    'inspectOnethingProviderEnvStatus',
    'inspectOnethingProviderEnvStatusForIpc',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned ${symbol}`),
    ...(fs.existsSync(adapterFile)
      ? matchingLines(adapterFile, MAIN_PROVIDERS_IPC_PRESENTATION_FORBIDDEN_PATTERNS)
      : [`${rel(adapterFile)}: missing providers RPC domain`]),
  ]

  assertNoMatches('packages/onething-runtime owns provider IPC presentation', lines)
}

function checkRuntimeOwnsNetworkPolicy(): void {
  const runtimeFile = 'packages/onething-runtime/src/providers/network.ts'
  const runtimeBoundFetchFile = 'packages/onething-runtime/src/providers/bound-fetch.ts'
  const runtimeBoundFetchTestFile = 'packages/onething-runtime/src/providers/__tests__/bound-fetch.test.ts'
  const runtimeIndexFile = path.join(root, 'packages/onething-runtime/src/providers/index.ts')
  const mainFile = path.join(root, 'packages/backend/provider-binding/bound-fetch.ts')
  const runtimeBoundFetchContent = fs.existsSync(path.join(root, runtimeBoundFetchFile))
    ? fs.readFileSync(path.join(root, runtimeBoundFetchFile), 'utf-8')
    : ''
  const runtimeIndexContent = fs.existsSync(runtimeIndexFile) ? fs.readFileSync(runtimeIndexFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'createOnethingAppFetch',
    'createRequiredOnethingAppFetch',
    'createOnethingBoundFetch',
    'getOnethingAppDispatcher',
    'clearOnethingAppDispatcherCache',
    'shouldBypassOnethingAppProxy',
    'validateOnethingAppProxyUrl',
  ]
  const lines = [
    ...(!fs.existsSync(path.join(root, runtimeFile))
      ? [`${runtimeFile}: missing runtime-owned provider network policy helpers`]
      : []),
    ...(!fs.existsSync(path.join(root, runtimeBoundFetchFile))
      ? [`${runtimeBoundFetchFile}: missing runtime-owned provider bound fetch implementation`]
      : []),
    ...(!fs.existsSync(path.join(root, runtimeBoundFetchTestFile))
      ? [`${runtimeBoundFetchTestFile}: missing runtime-owned provider bound fetch tests`]
      : []),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeBoundFetchContent.includes(symbol))
      .map(symbol => `${runtimeBoundFetchFile}: missing runtime-owned ${symbol}`),
    ...(!runtimeIndexContent.includes("export * from './bound-fetch.js'")
      ? ['packages/onething-runtime/src/providers/index.ts: missing bound-fetch export']
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_BOUND_FETCH_POLICY_FORBIDDEN_PATTERNS)
      : ['packages/backend/provider-binding/bound-fetch.ts: missing main network fetch adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns provider network policy and bound fetch runtime', lines)
}

function checkRuntimeOwnsModelRegistryRefresh(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/providers/model-registry.ts')
  const mainFile = path.join(root, 'packages/backend/wiring/providers/model-registry.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'saveOnethingProviderModels',
    'refreshOnethingProviderModels',
    'refreshAllOnethingProviderModels',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_MODEL_REGISTRY_REFRESH_FORBIDDEN_PATTERNS)
      : ['packages/backend/wiring/providers/model-registry.ts: missing main model registry facade']),
  ]

  assertNoMatches('packages/onething-runtime owns model registry refresh orchestration', lines)
}

function checkRuntimeOwnsModelsIpcPresentation(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/providers/model-registry.ts')
  const adapterFile = path.join(root, 'packages/backend/rpc/domains/models.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'mergeOnethingModelsById',
    'getConfiguredOnethingFallbackModels',
    'copilotModelInfoToOnethingOpenRouterModel',
    'fetchOnethingGitHubCopilotModelsWithAuth',
    'acpAgentsToOnethingOpenRouterModels',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned ${symbol}`),
    ...(fs.existsSync(adapterFile)
      ? matchingLines(adapterFile, MAIN_MODELS_IPC_PRESENTATION_FORBIDDEN_PATTERNS)
      : [`${rel(adapterFile)}: missing models RPC domain`]),
  ]

  assertNoMatches('packages/onething-runtime owns models IPC presentation helpers', lines)
}

function checkRuntimeOwnsModelQueryIpcPresentation(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/providers/model-query-presentation.ts')
  const adapterFile = path.join(root, 'packages/backend/rpc/domains/models.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'getAllOnethingModelRegistryModels',
    'getAllOnethingModelRegistryModelsForIpc',
    'searchOnethingModelRegistry',
    'searchOnethingModelRegistryForIpc',
    'refreshOnethingModelRegistry',
    'refreshOnethingModelRegistryForIpc',
    'getOnethingModelRegistryNameAliases',
    'getOnethingModelRegistryNameAliasesForIpc',
    'getOnethingModelRegistryDisplayName',
    'getOnethingModelRegistryDisplayNameForIpc',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned ${symbol}`),
    ...(fs.existsSync(adapterFile)
      ? matchingLines(adapterFile, MAIN_MODELS_IPC_QUERY_PRESENTATION_FORBIDDEN_PATTERNS)
      : [`${rel(adapterFile)}: missing models RPC domain`]),
  ]

  assertNoMatches('packages/onething-runtime owns model query IPC presentation', lines)
}

function checkRuntimeOwnsMcpServerOrchestration(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/mcp/server-orchestration.ts')
  // P4c 第六批:十六条 mcp 通道从 `@main` 壳适配搬到了 RPC 域,「不许在调用点重
  // 实现一遍」这条禁令跟着改指到新家。
  const mainFile = path.join(root, 'packages/backend/rpc/domains/mcp.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'addOnethingMCPServer',
    'updateOnethingMCPServer',
    'removeOnethingMCPServer',
    'connectOnethingMCPServer',
    'disconnectOnethingMCPServer',
    'refreshOnethingMCPServer',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_MCP_IPC_SERVER_ORCHESTRATION_FORBIDDEN_PATTERNS)
      : ['packages/backend/rpc/domains/mcp.ts: missing MCP RPC domain']),
  ]

  assertNoMatches('packages/onething-runtime owns MCP server orchestration', lines)
}

function checkRuntimeOwnsMcpCapabilityOperations(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/mcp/capability-operations.ts')
  // P4c 第六批:十六条 mcp 通道从 `@main` 壳适配搬到了 RPC 域,「不许在调用点重
  // 实现一遍」这条禁令跟着改指到新家。
  const mainFile = path.join(root, 'packages/backend/rpc/domains/mcp.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'listOnethingMCPTools',
    'callOnethingMCPTool',
    'listOnethingMCPResources',
    'readOnethingMCPResource',
    'listOnethingMCPPrompts',
    'getOnethingMCPPrompt',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_MCP_IPC_CAPABILITY_OPERATIONS_FORBIDDEN_PATTERNS)
      : ['packages/backend/rpc/domains/mcp.ts: missing MCP RPC domain']),
  ]

  assertNoMatches('packages/onething-runtime owns MCP capability operation projection', lines)
}

function checkRuntimeOwnsMcpIpcOperations(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/mcp/ipc-operations.ts')
  // P4c 第六批:十六条 mcp 通道从 `@main` 壳适配搬到了 RPC 域,「不许在调用点重
  // 实现一遍」这条禁令跟着改指到新家。
  const mainFile = path.join(root, 'packages/backend/rpc/domains/mcp.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'getOnethingMCPServersForIpc',
    'addOnethingMCPServerForIpc',
    'updateOnethingMCPServerForIpc',
    'removeOnethingMCPServerForIpc',
    'connectOnethingMCPServerForIpc',
    'disconnectOnethingMCPServerForIpc',
    'refreshOnethingMCPServerForIpc',
    'listOnethingMCPToolsForIpc',
    'callOnethingMCPToolForIpc',
    'listOnethingMCPResourcesForIpc',
    'readOnethingMCPResourceForIpc',
    'listOnethingMCPPromptsForIpc',
    'getOnethingMCPPromptForIpc',
    'readOnethingMCPConfigFileForIpc',
  ]
  const lines = [
    ...(!fs.existsSync(runtimeFile)
      ? [`${rel(runtimeFile)}: missing runtime-owned MCP IPC operations`]
      : []),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned MCP IPC operation ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_MCP_IPC_OPERATIONS_FORBIDDEN_PATTERNS)
      : ['packages/backend/rpc/domains/mcp.ts: missing MCP RPC domain']),
  ]

  assertNoMatches('packages/onething-runtime owns MCP IPC operations', lines)
}

function checkRuntimeOwnsSessionBranchCreation(): void {
  const runtimeFile = 'packages/onething-runtime/src/sessions/branching.ts'
  const runtimeIpcFile = 'packages/onething-runtime/src/sessions/ipc-operations.ts'
  // P4c 第五批:调用点从 `@main` 壳适配搬到了 RPC 域,「不许在调用点重实现一遍」
  // 这条禁令跟着改指到新家。
  const mainFile = path.join(root, 'packages/backend/rpc/domains/sessions.ts')
  const runtimeContent = fs.existsSync(path.join(root, runtimeFile))
    ? fs.readFileSync(path.join(root, runtimeFile), 'utf-8')
    : ''
  const runtimeIpcContent = fs.existsSync(path.join(root, runtimeIpcFile))
    ? fs.readFileSync(path.join(root, runtimeIpcFile), 'utf-8')
    : ''
  const lines = [
    ...(!fs.existsSync(path.join(root, runtimeFile))
      ? [`${runtimeFile}: missing runtime-owned session branch orchestration`]
      : []),
    ...(!runtimeContent.includes('createOnethingBranchSession')
      ? [`${runtimeFile}: missing runtime-owned session branch orchestration createOnethingBranchSession`]
      : []),
    ...(!runtimeIpcContent.includes('createOnethingBranchSessionForIpc')
      ? [`${runtimeIpcFile}: missing runtime-owned session branch IPC operation createOnethingBranchSessionForIpc`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_SESSIONS_IPC_BRANCH_FORBIDDEN_PATTERNS)
      : ['packages/backend/rpc/domains/sessions.ts: missing sessions RPC domain']),
  ]

  assertNoMatches('packages/onething-runtime owns session branch creation orchestration', lines)
}

function checkRuntimeOwnsSessionUpdateFlows(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/sessions/session-updates.ts')
  // P4c 第五批:调用点已是 RPC 域。
  const mainFile = path.join(root, 'packages/backend/rpc/domains/sessions.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'updateOnethingSessionModel',
    'updateOnethingSessionAgent',
    'updateOnethingSessionPermissionMode',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_SESSIONS_IPC_UPDATE_FORBIDDEN_PATTERNS)
      : ['packages/backend/rpc/domains/sessions.ts: missing sessions RPC domain']),
  ]

  assertNoMatches('packages/onething-runtime owns session update flows', lines)
}

/*
 * `checkRuntimeOwnsSessionMessageRuntime` —— **已删除**(§17.7.1 批 3)。
 *
 * 它守的是"消息 mutation 的执行体归 `packages/onething-runtime`"这条分层
 * (`OnethingSessionMessageRuntime` 那一层)。批 3 把老 reducer 与那一层整件删了:
 * 会话账由事件折叠产出、落盘档与索引元数据由写门自算、消息数组早在 c4-d 就归了
 * 折叠产物 —— 被守的那个东西不存在了,守它的门只会以"文件不见了"的理由常红。
 *
 * 它守的**那句话**没有失守,只是换了看门人:"对 ChatMessage / Step / ToolCall 的
 * 字段赋值只有一个算法处"由 `scripts/session-check.mjs` 规则 B 用 AST 守着(比
 * 字符串匹配更紧),而"写路只有一扇门"由规则 A/C 守。
 */

/**
 * **事件写入只有一扇门**(§17.7 #6)。
 *
 * `appendSessionLogEvent`(`event-log.ts`)是低层落账:分配 seq、编码、通知观察者、
 * 排队落盘。它**不**做 prepare、也**不**立活 surface —— 那两步是门
 * (`event-writer.ts` 的 `writeSessionEvent`)的第 1、2 步。直接调低层的后果是
 * 静默的:`ec2437ff` 那条病历里,`tool/result` 走素门落账,于是本进程内的那些
 * surface 格进不了活索引,压缩写下的 `sourceEventSeqs` 少 84 格。
 *
 * 所以这里守一条:**除了那扇门,没有人该提到 `appendSessionLogEvent`**。
 * (`event-log.ts` 自己是定义处;测试里也不许 —— 测试绕开门就等于在验一条
 * 生产上不存在的路。)
 */
function checkSessionEventSingleWriteDoor(): void {
  const door = 'packages/backend/session/event-writer.ts'
  const definition = 'packages/backend/session/event-log.ts'
  const offenders = walkFiles(path.join(root, 'packages'), [], { includeTests: true })
    .filter(file => /\.ts$/.test(file))
    .filter(file => rel(file) !== door && rel(file) !== definition)
    // 只看**剥掉注释之后**的代码(与形状类规则同一条纪律:注释里提一句名字
    // 不该打假红,假红会逼人放宽规则)。
    .flatMap(file => codeOnlyLines(fs.readFileSync(file, 'utf-8'))
      .filter(({ code }) => /\bappendSessionLogEvent\b/.test(code))
      .map(({ raw, lineNo }) => `${rel(file)}:${lineNo}: ${raw.trim()}`))
  assertNoMatches(
    'session event log has a single write door (packages/backend/session/event-writer.ts)',
    offenders,
  )
}

function checkRuntimeOwnsSessionWorkingDirectoryFlow(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/sessions/working-directory.ts')
  // P4c 第五批:调用点已是 RPC 域。
  const mainFile = path.join(root, 'packages/backend/rpc/domains/sessions.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const lines = [
    ...(!runtimeContent.includes('updateOnethingSessionWorkingDirectory')
      ? [`${rel(runtimeFile)}: missing runtime-owned session working directory flow`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_SESSIONS_IPC_WORKDIR_FORBIDDEN_PATTERNS)
      : ['packages/backend/rpc/domains/sessions.ts: missing sessions RPC domain']),
  ]

  assertNoMatches('packages/onething-runtime owns session working directory flow', lines)
}

function checkRuntimeOwnsSessionSystemMarkerFlow(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/sessions/system-messages.ts')
  // P4c 第五批:调用点已是 RPC 域。
  const mainFile = path.join(root, 'packages/backend/rpc/domains/sessions.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const lines = [
    ...(!runtimeContent.includes('removeOnethingSystemMarkerMessage')
      ? [`${rel(runtimeFile)}: missing runtime-owned session system marker flow`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_SESSIONS_IPC_SYSTEM_MARKER_FORBIDDEN_PATTERNS)
      : ['packages/backend/rpc/domains/sessions.ts: missing sessions RPC domain']),
  ]

  assertNoMatches('packages/onething-runtime owns session system marker flow', lines)
}

function checkRuntimeOwnsSessionIpcOperations(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/sessions/ipc-operations.ts')
  const runtimeUsageFile = path.join(root, 'packages/onething-runtime/src/sessions/session-usage.ts')
  // P4c 第五批:调用点已是 RPC 域。
  const mainFile = path.join(root, 'packages/backend/rpc/domains/sessions.ts')
  const usageFile = path.join(root, 'packages/backend/session/usage.ts')
  const runtimeContent = [
    runtimeFile,
    runtimeUsageFile,
  ].map(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '').join('\n')
  const requiredRuntimeSymbols = [
    'ONETHING_SESSION_NOT_FOUND',
    'listOnethingSessionsForIpc',
    'activateOnethingSessionForIpc',
    'getOnethingSessionMessagesForIpc',
    'getOnethingSessionMessagesPageForIpc',
    'listOnethingSessionUserMarkersForIpc',
    'createOnethingSessionForIpc',
    'switchOnethingSessionForIpc',
    'getOnethingSessionForIpc',
    'deleteOnethingSessionForIpc',
    'renameOnethingSessionForIpc',
    'updateOnethingSessionPinForIpc',
    'updateOnethingSessionArchivedForIpc',
    'normalizeOnethingSessionTokenUsage',
    'updateOnethingSessionUsage',
    'getOnethingSessionUsage',
    'clearOnethingSessionUsage',
    'getOnethingSessionTokenUsageForIpc',
    'addOnethingSystemMessageForIpc',
    'removeOnethingMessageForIpc',
  ]
  const lines = [
    ...(!fs.existsSync(runtimeFile)
      ? [`${rel(runtimeFile)}: missing runtime-owned session IPC operations`]
      : []),
    ...(!fs.existsSync(runtimeUsageFile)
      ? [`${rel(runtimeUsageFile)}: missing runtime-owned session usage operations`]
      : []),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned session IPC operation ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_SESSIONS_IPC_OPERATIONS_FORBIDDEN_PATTERNS)
      : ['packages/backend/rpc/domains/sessions.ts: missing sessions RPC domain']),
    ...(fs.existsSync(usageFile)
      ? matchingLines(usageFile, MAIN_SESSION_USAGE_FACADE_FORBIDDEN_PATTERNS)
      : ['packages/backend/session/usage.ts: missing session usage adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns session IPC operations', lines)
}

function checkRuntimeOwnsRendererMessageSanitizer(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/sessions/renderer-sanitizer.ts')
  const mainFiles = [
    path.join(root, 'apps/electron/src/main/ipc/message-sanitizer.ts'),
    // P4c 第五批:会话与聊天两份调用点都已是 RPC 域(`@main/ipc/chat.ts` 在
    // 2026-08-22 的 #21 里整只删掉)。
    path.join(root, 'packages/backend/rpc/domains/sessions.ts'),
    path.join(root, 'packages/backend/rpc/domains/chat.ts'),
  ]
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const lines = [
    ...(!runtimeContent.includes('sanitizeOnethingSessionForRenderer')
      ? [`${rel(runtimeFile)}: missing runtime-owned renderer message sanitizer`]
      : []),
    ...mainFiles.flatMap(file => fs.existsSync(file)
      ? matchingLines(file, MAIN_RENDERER_SANITIZER_FORBIDDEN_PATTERNS)
      : []
    ),
  ]

  assertNoMatches('packages/onething-runtime owns renderer-safe message projection', lines)
}

function checkChatIpcDoesNotOwnLegacyStreamFlow(): void {
  // P4c 第五批:聊天面的六条已是 RPC 域;2026-08-22(#21)第七条与那层壳适配
  // 一起删掉之后,这条只剩域文件一处要守。
  const mainFiles = [
    path.join(root, 'packages/backend/rpc/domains/chat.ts'),
  ]
  const lines = mainFiles.flatMap(file => fs.existsSync(file)
    ? matchingLines(file, MAIN_CHAT_IPC_LEGACY_STREAM_FORBIDDEN_PATTERNS)
    : [`${rel(file)}: missing chat IPC adapter`])

  assertNoMatches('chat IPC delegates stream orchestration to EventBus/StreamEngine runtime', lines)
}

function checkRuntimeOwnsChatTitleGenerationFlow(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/providers/provider-runtime.ts')
  // P4c 第五批:标题生成的调用点已是 RPC 域。
  const mainFile = path.join(root, 'packages/backend/rpc/domains/chat.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const lines = [
    ...(!runtimeContent.includes('generateOnethingChatTitle')
      ? [`${rel(runtimeFile)}: missing runtime-owned chat title generation flow`]
      : []),
    ...(!runtimeContent.includes('generateOnethingChatTitleForIpc')
      ? [`${rel(runtimeFile)}: missing runtime-owned chat title IPC projection`]
      : []),
    ...(!runtimeContent.includes('getOnethingCaughtErrorMessage')
      ? [`${rel(runtimeFile)}: missing runtime-owned caught error message helper`]
      : []),
    ...(!runtimeContent.includes('extractOnethingCaughtErrorDetails')
      ? [`${rel(runtimeFile)}: missing runtime-owned caught error details helper`]
      : []),
    ...(fs.existsSync(mainFile)
      ? [
          ...matchingLines(mainFile, MAIN_CHAT_IPC_TITLE_FORBIDDEN_PATTERNS),
          ...matchingLines(mainFile, MAIN_CHAT_IPC_PROVIDER_ERROR_FORBIDDEN_PATTERNS),
        ]
      : ['packages/backend/rpc/domains/chat.ts: missing chat RPC domain']),
  ]

  assertNoMatches('packages/onething-runtime owns chat title generation flow', lines)
}

function checkRuntimeOwnsChatSessionIpcOperations(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/sessions/ipc-operations.ts')
  // P4c 第五批:历史读取与思考时长补写的调用点已是 RPC 域。
  const mainFile = path.join(root, 'packages/backend/rpc/domains/chat.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'getOnethingChatHistoryForIpc',
    'updateOnethingMessageThinkingTimeForIpc',
  ]
  const lines = [
    ...(!fs.existsSync(runtimeFile)
      ? [`${rel(runtimeFile)}: missing runtime-owned chat session IPC operations`]
      : []),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned chat session IPC operation ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_CHAT_IPC_SESSION_OPERATIONS_FORBIDDEN_PATTERNS)
      : ['packages/backend/rpc/domains/chat.ts: missing chat RPC domain']),
  ]

  assertNoMatches('packages/onething-runtime owns chat session IPC operations', lines)
}

function checkRuntimeOwnsChatActiveStreamListing(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/sessions/stream-abort.ts')
  // P4c 第五批:活流表的调用点已是 RPC 域。
  const mainFile = path.join(root, 'packages/backend/rpc/domains/chat.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const lines = [
    ...(!runtimeContent.includes('listOnethingActiveStreamsForIpc')
      ? [`${rel(runtimeFile)}: missing runtime-owned active stream listing projection`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_CHAT_IPC_ACTIVE_STREAMS_FORBIDDEN_PATTERNS)
      : ['packages/backend/rpc/domains/chat.ts: missing chat RPC domain']),
  ]

  assertNoMatches('packages/onething-runtime owns active stream listing projection', lines)
}

function checkRuntimeOwnsChatAbortCleanupFlow(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/sessions/stream-abort.ts')
  // P4c 第五批:停止收尾的调用点已是 RPC 域。
  const mainFile = path.join(root, 'packages/backend/rpc/domains/chat.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const lines = [
    ...(!runtimeContent.includes('cancelOnethingStreamingStepsForAbort')
      ? [`${rel(runtimeFile)}: missing runtime-owned chat abort cleanup flow`]
      : []),
    ...(!runtimeContent.includes('abortOnethingStreamsForIpc')
      ? [`${rel(runtimeFile)}: missing runtime-owned chat abort IPC orchestration`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_CHAT_IPC_ABORT_CLEANUP_FORBIDDEN_PATTERNS)
      : ['packages/backend/rpc/domains/chat.ts: missing chat RPC domain']),
  ]

  assertNoMatches('packages/onething-runtime owns chat abort cleanup flow', lines)
}

// 2026-08-22(#21):`checkRuntimeOwnsResumeAfterToolConfirmationFlow` 已退休 ——
// runtime 的 `sessions/tool-confirmation.ts` 与它唯一的调用点一起删掉了,
// 没有「归属」要守;换来的反向断言是 `checkChatResumeAfterToolConfirmStaysRetired`。

// P4c 第九批:tools 的七条数据面已迁 `toolsRouter`,`@main/ipc/tools.ts` 与
// `apps/electron/src/ipc/tools.ts` 整只删掉。下面四条「runtime 拥有 X 操作」的断言
// 因此改指**域处理者**(`packages/backend/rpc/domains/tools.ts`)—— 守的还是同一件事:
// 投影逻辑住在产品层,传输层只转调,不许在这里重抄一份。
const TOOLS_RPC_DOMAIN_FILE = 'packages/backend/rpc/domains/tools.ts'

function checkRuntimeOwnsToolCallStateProjection(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/tools/tool-call-state.ts')
  const mainFile = path.join(root, TOOLS_RPC_DOMAIN_FILE)
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'applyOnethingToolCallUpdate',
    'applyOnethingToolCallUpdateForIpc',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned tool call state projection ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_TOOLS_IPC_TOOL_CALL_UPDATE_FORBIDDEN_PATTERNS)
      : [`${TOOLS_RPC_DOMAIN_FILE}: missing tools RPC domain`]),
  ]

  assertNoMatches('packages/onething-runtime owns tool call state projection', lines)
}

/**
 * R4b —— 旧的 `OnethingToolRegistry` 随旧树删除。它守的那条线仍然在,只是主语换
 * 成了新工具系统:**工具与目录归产品层**(`runtime/src/toolkit`),装配层只负责
 * 建一档目录、接端口;宿主只拿投影。
 */
function checkRuntimeOwnsToolRegistryRuntime(): void {
  const kernelCatalogFile = path.join(root, 'packages/core/toolkit/catalog.ts')
  const productHostFile = path.join(root, 'packages/onething-runtime/src/toolkit/host.ts')
  const productIndexFile = path.join(root, 'packages/onething-runtime/src/toolkit/index.ts')
  const assemblyCatalogFile = path.join(root, 'packages/backend/wiring/toolkit/catalog.ts')
  const assemblyWiringFile = path.join(root, 'packages/backend/wiring/toolkit/wiring.ts')
  const productHostContent = fs.existsSync(productHostFile) ? fs.readFileSync(productHostFile, 'utf-8') : ''
  const productIndexContent = fs.existsSync(productIndexFile) ? fs.readFileSync(productIndexFile, 'utf-8') : ''
  const assemblyCatalogContent = fs.existsSync(assemblyCatalogFile) ? fs.readFileSync(assemblyCatalogFile, 'utf-8') : ''
  const assemblyWiringContent = fs.existsSync(assemblyWiringFile) ? fs.readFileSync(assemblyWiringFile, 'utf-8') : ''
  const requiredProductSymbols = [
    'configureToolkitCatalog',
    'getToolkitCatalog',
    'resolveToolkitSurface',
  ]
  const requiredTierFactories = [
    'createDesktopCatalog',
    'createHeadlessCatalog',
    'createReadonlyCatalog',
  ]
  const lines = [
    ...(!fs.existsSync(kernelCatalogFile)
      ? [`${rel(kernelCatalogFile)}: missing kernel-owned Catalog`]
      : []),
    ...requiredProductSymbols
      .filter(symbol => !productHostContent.includes(symbol))
      .map(symbol => `${rel(productHostFile)}: missing product-owned catalog port ${symbol}`),
    ...(!productIndexContent.includes('./host.js')
      ? [`${rel(productIndexFile)}: missing toolkit host public export`]
      : []),
    ...requiredTierFactories
      .filter(symbol => !assemblyCatalogContent.includes(symbol))
      .map(symbol => `${rel(assemblyCatalogFile)}: missing tier catalog factory ${symbol}`),
    ...(!assemblyWiringContent.includes('buildToolkitCatalog')
      ? [`${rel(assemblyWiringFile)}: the assembly layer must own the single catalog build seam`]
      : []),
    // 旧树不许复活:装配层不得再出现一棵工具注册表。
    ...(fs.existsSync(path.join(root, 'packages/backend/wiring/tools/registry.ts'))
      ? ['packages/backend/wiring/tools/registry.ts: the legacy tool registry facade was deleted in R4b']
      : []),
    ...(fs.existsSync(path.join(root, 'packages/onething-runtime/src/tools/registry.ts'))
      ? ['packages/onething-runtime/src/tools/registry.ts: the legacy tool registry was deleted in R4b']
      : []),
    ...(fs.existsSync(path.join(root, 'packages/onething-runtime/src/tools/tool.ts'))
      ? ['packages/onething-runtime/src/tools/tool.ts: Tool.define was deleted in R4b']
      : []),
  ]

  assertNoMatches('packages/onething-runtime owns tool registry runtime', lines)
}

function checkRuntimeOwnsToolsIpcListPresentation(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/tools/tool-list-presentation.ts')
  const mainFile = path.join(root, TOOLS_RPC_DOMAIN_FILE)
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'listOnethingSettingsTools',
    'listOnethingSettingsToolsForIpc',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned settings-visible tool list projection ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_TOOLS_IPC_LIST_PRESENTATION_FORBIDDEN_PATTERNS)
      : [`${TOOLS_RPC_DOMAIN_FILE}: missing tools RPC domain`]),
  ]

  assertNoMatches('packages/onething-runtime owns settings-visible tool list projection', lines)
}

function checkRuntimeOwnsToolsIpcExecutionContext(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/tools/tool-execution-context.ts')
  const mainFile = path.join(root, TOOLS_RPC_DOMAIN_FILE)
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'executeOnethingToolWithSessionContext',
    'executeOnethingToolWithSessionContextForIpc',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned tool execution context assembly ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_TOOLS_IPC_EXECUTION_CONTEXT_FORBIDDEN_PATTERNS)
      : [`${TOOLS_RPC_DOMAIN_FILE}: missing tools RPC domain`]),
  ]

  assertNoMatches('packages/onething-runtime owns tool execution context assembly', lines)
}

function checkRuntimeOwnsToolsIpcBackgroundJobs(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/tools/ipc-operations.ts')
  const mainFile = path.join(root, TOOLS_RPC_DOMAIN_FILE)
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'cancelOnethingToolForIpc',
    'listOnethingBackgroundJobsForIpc',
    'stopOnethingBackgroundJobForIpc',
    'Failed to list background jobs',
    'Failed to stop background job',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned tools IPC operation ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_TOOLS_IPC_BACKGROUND_JOBS_FORBIDDEN_PATTERNS)
      : [`${TOOLS_RPC_DOMAIN_FILE}: missing tools RPC domain`]),
  ]

  assertNoMatches('packages/onething-runtime owns tools background-job IPC operations', lines)
}

function checkRuntimeOwnsSettingsSaveOrchestration(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/settings/settings-save.ts')
  const runtimeIpcFile = path.join(root, 'packages/onething-runtime/src/settings/ipc-operations.ts')
  // P4c 第十一批:保存链的调用点从 `@main/ipc/settings.ts` 搬进了域处理者 ——
  // 断言改指它,守的仍是同一件事(装配层不许把编排逻辑再抄一份)。
  const mainFile = path.join(root, 'packages/backend/rpc/domains/settings.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const runtimeIpcContent = fs.existsSync(runtimeIpcFile) ? fs.readFileSync(runtimeIpcFile, 'utf-8') : ''
  const requiredRuntimeIpcSymbols = [
    'getOnethingSettingsForIpc',
    'saveOnethingSettingsWithRuntimeEffectsForIpc',
    'getOnethingSystemThemeForIpc',
    // `listOnethingNetworkInterfacesForIpc` 于 603582d9 随网卡枚举一起退役 —— 断言删除。
  ]
  const lines = [
    ...(!runtimeContent.includes('saveOnethingSettingsWithRuntimeEffects')
      ? [`${rel(runtimeFile)}: missing runtime-owned settings save orchestration`]
      : []),
    ...requiredRuntimeIpcSymbols
      .filter(symbol => !runtimeIpcContent.includes(symbol))
      .map(symbol => `${rel(runtimeIpcFile)}: missing runtime-owned settings IPC operation ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_SETTINGS_IPC_SAVE_ORCHESTRATION_FORBIDDEN_PATTERNS)
      : ['packages/backend/rpc/domains/settings.ts: missing settings RPC domain']),
  ]

  assertNoMatches('packages/onething-runtime owns settings save orchestration', lines)
}

const BUILTIN_PLUGIN_FACADE_DIR = 'packages/backend/wiring/plugins/builtin'
const BUILTIN_PLUGIN_RUNTIME_DIR = 'packages/onething-runtime/src/plugins'
const BUILTIN_PLUGIN_FACADE_MAX_LINES = 60

const BUILTIN_PLUGIN_LOADER_FILE = 'packages/backend/wiring/plugins/loader.ts'

/** 内置插件的 id 列表 = 插座目录的文件名。加一个插件就自动进入所有规则。 */
function listBuiltinPluginIds(): string[] {
  const dir = path.join(root, BUILTIN_PLUGIN_FACADE_DIR)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts'))
    .map(entry => entry.name.replace(/\.ts$/, ''))
    .sort()
}

/**
 * loader 眼中的内置插件:`getBuiltinPlugins()` 里的 id 字面量 + 它从 builtin/
 * 目录 import 的模块名。这是**运行时**的那份权威。
 */
function listRegisteredBuiltinPluginIds(): { ids: string[]; imports: string[] } | null {
  const loaderFile = path.join(root, BUILTIN_PLUGIN_LOADER_FILE)
  if (!fs.existsSync(loaderFile)) return null
  const content = fs.readFileSync(loaderFile, 'utf-8')

  const body = /function\s+getBuiltinPlugins\s*\([^)]*\)\s*:[^{]*\{([\s\S]*?)\n\}/.exec(content)
  if (!body) return null

  const ids = [...body[1].matchAll(/\bid:\s*'([^']+)'/g)].map(match => match[1]).sort()
  const imports = [...content.matchAll(/\bfrom\s+'\.\/builtin\/([\w.-]+?)(?:\.js)?'/g)].map(match => match[1]).sort()
  return { ids, imports }
}

function checkPluginLogicStaysOutOfHostAssembly(): void {
  const pluginIds = listBuiltinPluginIds()
  const runtimeIndexFile = path.join(root, BUILTIN_PLUGIN_RUNTIME_DIR, 'index.ts')
  const runtimeIndexContent = fs.existsSync(runtimeIndexFile) ? fs.readFileSync(runtimeIndexFile, 'utf-8') : ''
  const lines: string[] = []

  if (pluginIds.length === 0) {
    lines.push(`${BUILTIN_PLUGIN_FACADE_DIR}: no built-in plugin facades found`)
  }

  // 0) 两份权威必须闭合。
  //
  // 本文件的全部规则以**目录**为权威(builtin/*.ts),拆除测试以 loader 的
  // getBuiltinPlugins() 为权威。两边不做交叉断言的话,一个绕开 builtin/ 目录
  // 直接注册的插件就同时逃过四条规则和拆除测试 —— 谁都没觉得自己漏了。
  const registered = listRegisteredBuiltinPluginIds()
  if (!registered) {
    lines.push(`${BUILTIN_PLUGIN_LOADER_FILE}: getBuiltinPlugins() could not be parsed — the two builtin-plugin authorities can no longer be cross-checked`)
  } else {
    for (const id of registered.ids) {
      if (!pluginIds.includes(id)) {
        lines.push(`${BUILTIN_PLUGIN_LOADER_FILE}: built-in plugin "${id}" is registered but has no facade in ${BUILTIN_PLUGIN_FACADE_DIR}/`)
      }
    }
    for (const id of pluginIds) {
      if (!registered.ids.includes(id)) {
        lines.push(`${BUILTIN_PLUGIN_FACADE_DIR}/${id}.ts: facade exists but "${id}" is not registered in getBuiltinPlugins()`)
      }
      if (!registered.imports.includes(id)) {
        lines.push(`${BUILTIN_PLUGIN_LOADER_FILE}: missing import of ./builtin/${id}.js`)
      }
    }
    for (const name of registered.imports) {
      if (!pluginIds.includes(name)) {
        lines.push(`${BUILTIN_PLUGIN_LOADER_FILE}: imports ./builtin/${name}.js which is not a facade file`)
      }
    }
  }

  for (const pluginId of pluginIds) {
    const facadeFile = path.join(root, BUILTIN_PLUGIN_FACADE_DIR, `${pluginId}.ts`)
    const runtimeFile = path.join(root, BUILTIN_PLUGIN_RUNTIME_DIR, `${pluginId}.ts`)
    const runtimeTestFile = path.join(root, BUILTIN_PLUGIN_RUNTIME_DIR, '__tests__', `${pluginId}.test.ts`)
    const facadeContent = fs.readFileSync(facadeFile, 'utf-8')
    const facadeLines = facadeContent.split('\n').filter(line => line.trim().length > 0)

    // 1) 实现必须住在 runtime 产品层,并且自带测试与公开导出。
    if (!fs.existsSync(runtimeFile)) {
      lines.push(`${rel(runtimeFile)}: missing runtime-owned implementation for built-in plugin "${pluginId}"`)
    } else {
      const runtimeContent = fs.readFileSync(runtimeFile, 'utf-8')
      if (!/export\s+function\s+registerOnething\w+Plugin\b/.test(runtimeContent)) {
        lines.push(`${rel(runtimeFile)}: must export a registerOnething*Plugin(api, options) entry`)
      }
      if (!/export\s+const\s+ONETHING_\w*MANIFEST\b/.test(runtimeContent)) {
        lines.push(`${rel(runtimeFile)}: must own its ONETHING_*_MANIFEST (manifests are product data, not core data)`)
      }
    }
    if (!fs.existsSync(runtimeTestFile)) {
      lines.push(`${rel(runtimeTestFile)}: missing runtime tests for built-in plugin "${pluginId}"`)
    }
    if (!runtimeIndexContent.includes(`./${pluginId}.js`)) {
      lines.push(`${rel(runtimeIndexFile)}: missing public export for built-in plugin "${pluginId}"`)
    }

    // 2) 插座只许接线:委托、够薄、无行为。
    if (!facadeContent.includes('@onething/runtime/plugins')) {
      lines.push(`${rel(facadeFile)}: built-in plugin facade must delegate to @onething/runtime/plugins`)
    }
    if (facadeLines.length > BUILTIN_PLUGIN_FACADE_MAX_LINES) {
      lines.push(`${rel(facadeFile)}: built-in plugin facade must stay thin (${facadeLines.length} > ${BUILTIN_PLUGIN_FACADE_MAX_LINES} lines)`)
    }
    lines.push(...matchingCodeLines(facadeFile, BUILTIN_PLUGIN_FACADE_FORBIDDEN_PATTERNS))
    lines.push(...codeOnlyLines(facadeContent)
      .filter(({ code }) => !/\bfrom\s+['"]/.test(code)
        && !/\bimport\s*\(/.test(code)
        && BUILTIN_PLUGIN_FACADE_LONG_LITERAL.test(code))
      .map(({ raw, lineNo }) => `${rel(facadeFile)}:${lineNo}: ${raw.trim()}`))
  }

  // 3) 插件**行为**的测试跟着实现走。装配层的两个 __tests__ 目录只留装配测试:
  //    core 原语、插座接线、拆除快照。判据是 import 白名单 —— 只要伸手去
  //    @onething/runtime/*(插件实现所在的产品层),这个测试就站错了树。
  //    按目录全扫,不再只探两个候选文件名(那样改个文件名就绕过去了)。
  //
  //    P3'd(装配层成包 `@onething/backend`)之后判据的**单位从行改成文件**,
  //    语义不变:从前"装配测试"是靠 `../manager.js` 这种相对 import 表达的,而
  //    相对 import 整行免检 —— 同一个文件里顺手写的 `../../../plugins/x.js`
  //    (产品层)也一并免检了。拆包把这些相对写法逼成了包说明符,行级判据会
  //    把一批本来就绿的装配测试判红。所以现在先问"这个文件是不是装配测试"
  //    (import 了装配层模块 = 是),再对**纯产品层**的停车文件报红 —— 这正是
  //    这条规则一直想说、而相对路径口子一直没让它说出口的那句话。
  const assemblyModuleImport = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|vi\.mock\(\s*|vi\.doMock\(\s*)['"](?:\.{1,2}\/|@onething\/backend(?:\/|['"]))/
  for (const testDir of [
    path.join(root, BUILTIN_PLUGIN_FACADE_DIR, '..', '__tests__'),
    path.join(root, BUILTIN_PLUGIN_FACADE_DIR, '__tests__'),
  ]) {
    if (!fs.existsSync(testDir)) continue
    for (const entry of fs.readdirSync(testDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.test.ts')) continue
      const parked = path.join(testDir, entry.name)
      const code = codeOnlyLines(fs.readFileSync(parked, 'utf-8'))
      // 接了装配层 = 它测的是接线,不是插件行为,住在这里是对的。
      if (code.some(({ code: line }) => assemblyModuleImport.test(line))) continue
      lines.push(...code
        .filter(({ code }) => /\bfrom\s+['"]/.test(code)
          && !/from\s+['"](?:node:)?(?:fs|fs\/promises|os|path|crypto|util|url|events|zlib)['"]/.test(code)
          && !/from\s+['"]vitest['"]/.test(code)
          && !/from\s+['"]@onething\/core(?:\/|['"])/.test(code)
          && !/from\s+['"]@shared(?:\/|['"])/.test(code))
        .map(({ raw, lineNo }) => `${rel(parked)}:${lineNo}: assembly-tree test must not import the product layer — plugin-behaviour tests belong next to the implementation — ${raw.trim()}`))
    }
  }

  assertNoMatches('plugin logic stays out of the host assembly tree', lines)
}

// 已退役但仍必须防复发的功能名。import 方向检查抓不到"知识泄漏":
// soul-memory 当年把 general.soulMemory.activeMemory.timeoutMs 直接读进了 core,
// 一行 import 都没多加。
const RETIRED_FEATURE_TOKENS = [
  'soul-memory',
  'soulMemory',
  'activeMemory',
]

/** 归一化后 kebab/camel/snake/pascal 全部相等,所以不需要生成变体。 */
function normalizeFeatureToken(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '').toLowerCase()
}

/**
 * core 不认识任何具体功能。
 *
 * **覆盖范围(有意为之的有限集)**:token 集 = 内置插件 id(builtin/ 目录)+
 * RETIRED_FEATURE_TOKENS 退役名单。它抓的是"已知功能名泄漏进 core",不是
 * 一个通用的领域词检测器 —— 一个从没在这两处登记过的新功能名不会被抓到,
 * 加内置插件时目录会自动带上,退役功能要手工进名单。
 *
 * **扫描面**:字符串字面量(含**模板串**,`${…}` 段剔除;跨行模板做文件级
 * 配对粗扫)与属性名 —— `name: 'log-monitor'`、`` `[LogMonitor] …` ``、
 * `settings.general.soulMemory.x`、`data['note-skills']` 全部算红。
 * 标识符本身不算(`CORE_LOG_MONITOR_MAX` 这类符号名属文件布局问题);
 * import/export 的模块说明符同样排除,由分层检查另管。
 */
function checkCoreKnowsNoConcreteFeatures(): void {
  const known = [...new Set(
    [...listBuiltinPluginIds(), ...RETIRED_FEATURE_TOKENS].map(normalizeFeatureToken),
  )].filter(Boolean)

  // 反引号进字符类:`[LogMonitor] ${x}` 这类模板串正是活样本的逃逸口。
  const stringLiteral = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g
  const moduleSpecifier = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(?:\\.|(?!\1)[^\\])*\1/g
  const memberAccess = /\.\s*([A-Za-z_$][\w$]*)/g
  const objectKey = /(?:^|[{,;])\s*([A-Za-z_$][\w$]*)\s*:/g
  const multilineTemplate = /`(?:\\[\s\S]|[^`\\])*`/g

  const hitToken = (value: string): string | undefined => {
    const normalized = normalizeFeatureToken(value)
    return normalized.length > 0 && known.some(token => normalized.includes(token))
      ? normalized
      : undefined
  }
  // 插值段剔除:它是变量,不是 core 写下的知识。
  const withoutInterpolation = (value: string): string => value.replace(/\$\{[^}]*\}/g, ' ')

  const lines: string[] = []
  for (const file of walkFiles(path.join(root, 'packages/core'), [], { includeTests: true })) {
    if (!/\.(ts|tsx|js|mjs|cjs)$/.test(file)) continue
    const content = fs.readFileSync(file, 'utf-8')
    const reported = new Set<number>()
    const report = (lineNo: number, hit: string, raw: string): void => {
      if (reported.has(lineNo)) return
      reported.add(lineNo)
      lines.push(`${rel(file)}:${lineNo}: core must not know concrete feature "${hit}" — ${raw.trim()}`)
    }

    const rawLines = content.split(/\r?\n/)
    rawLines.forEach((rawLine, index) => {
      if (/^\s*(?:\*|\/\/|\/\*)/.test(rawLine)) return
      const line = rawLine.replace(moduleSpecifier, ' ')
      const candidates: string[] = []
      for (const match of line.matchAll(stringLiteral)) candidates.push(withoutInterpolation(match[2]))
      for (const match of line.matchAll(memberAccess)) candidates.push(match[1])
      for (const match of line.matchAll(objectKey)) candidates.push(match[1])

      for (const candidate of candidates) {
        const hit = hitToken(candidate)
        if (hit) {
          report(index + 1, hit, rawLine)
          return
        }
      }
    })

    // 跨行模板串逐行扫不到(单行正则配不上首尾反引号)。文件级配对粗扫补上。
    for (const match of content.matchAll(multilineTemplate)) {
      const body = match[0]
      if (!body.includes('\n')) continue
      const hit = hitToken(withoutInterpolation(body.slice(1, -1)))
      if (!hit) continue
      const lineNo = content.slice(0, match.index ?? 0).split('\n').length
      report(lineNo, hit, rawLines[lineNo - 1] ?? body.slice(0, 80))
    }
  }

  assertNoMatches('packages/core knows no concrete plugin or feature names', lines)
}

/**
 * 源码里不许出现**裸控制字符**(0x00-0x08 / 0x0b / 0x0c / 0x0e-0x1f)。
 *
 * 起因是一次真事故:R6 的状态账本用了一个裸 NUL 做 Map 键的分隔符,git 据此把
 * 整个文件判成二进制 —— 那一期最核心的 188 行在 diff 里**完全不可审**,评审只能
 * 看到 `Bin 0 -> 7524 bytes`。代码看起来完全正常,测试全绿,而审查这一环被静默
 * 掐掉了。
 *
 * 需要控制字符时写转义(`\u0000`),不要把字节本身放进文件。
 * 制表符/换行/回车(0x09/0x0a/0x0d)照常放行。
 */
function checkNoRawControlCharacters(): void {
  const offenders: string[] = []
  const roots = ['packages', 'apps', 'scripts']
  // 扩展名比默认集合宽:.vue 的 SFC、.css、.md 里的裸控制字符同样让 git 判
  // 二进制、同样不可审。任何进 git 的文本文件都适用同一条规则。
  const walkOptions: WalkFilesOptions = {
    includeTests: true,
    extensions: /\.(ts|tsx|js|mjs|cjs|json|vue|css|md)$/,
    // 构建产物不进 git,不在本规则的立法射程内(minified 产物里出现控制字节也轮不到人审)。
    excludeDirs: ['dist', 'dist-electron', 'dist-web', 'out', 'release', 'ds-bundle', '.ds-sync', 'coverage'],
  }
  for (const dirName of roots) {
    for (const filePath of walkFiles(path.join(root, dirName), [], walkOptions)) {
      const buffer = fs.readFileSync(filePath)
      for (let i = 0; i < buffer.length; i += 1) {
        const byte = buffer[i]
        const isControl = byte < 0x09 || byte === 0x0b || byte === 0x0c || (byte >= 0x0e && byte <= 0x1f)
        if (!isControl) continue
        const line = buffer.subarray(0, i).toString('utf-8').split('\n').length
        offenders.push(`${rel(filePath)}:${line}: raw control character 0x${byte.toString(16).padStart(2, '0')} (write an escape instead)`)
        break
      }
    }
  }
  assertNoMatches('source files carry no raw control characters', offenders)
}

const PLUGIN_HOST_MODULE_SPECIFIER = /['"](@onething\/(?!core(?:\/|['"]))|@shared|@main\/|@preload\/|@renderer|@\/|electron['"]|electron\/)/
const PLUGIN_HOST_IMPORT_PATTERNS: RegExp[] = [PLUGIN_HOST_MODULE_SPECIFIER]

const USER_PLUGIN_HOST_IMPORT_PATTERNS: RegExp[] = [
  ...PLUGIN_HOST_IMPORT_PATTERNS,
  // 用户插件住在 <store>/plugins/<id>/,爬出插件目录去 import 宿主源码同样禁止
  // (同样按说明符匹配,静态/动态/require 一网打尽)。
  /['"]\.\.\/\.\./,
]

function checkPluginsOnlyUseInjectedApi(): void {
  const lines: string[] = []

  // (a) 内置插件实现:只准 Node 内置 / zod / @onething/core。
  for (const pluginId of listBuiltinPluginIds()) {
    const implFile = path.join(root, BUILTIN_PLUGIN_RUNTIME_DIR, `${pluginId}.ts`)
    if (!fs.existsSync(implFile)) continue
    lines.push(...matchingCodeLines(implFile, PLUGIN_HOST_IMPORT_PATTERNS))
    lines.push(...codeOnlyLines(fs.readFileSync(implFile, 'utf-8'))
      .filter(({ code }) => /(?:\bfrom\s+|\brequire\(\s*|\bimport\(\s*|\bimport\s+)['"]\.{1,2}\//.test(code))
      .map(({ raw, lineNo }) => `${rel(implFile)}:${lineNo}: plugin implementation must not reach into sibling host modules — ${raw.trim()}`))
  }

  // (b) 用户插件形态的样例:它们是这条宪法唯一的可执行说明书。
  const samplesDir = path.join(root, 'sample-plugins')
  if (fs.existsSync(samplesDir)) {
    for (const file of walkFiles(samplesDir)) {
      if (!/\.(tsx?|jsx?|mjs|cjs)$/.test(file)) continue
      lines.push(...matchingCodeLines(file, USER_PLUGIN_HOST_IMPORT_PATTERNS))
    }
  }

  assertNoMatches('plugins reach the host only through the injected api object', lines)
}

function checkRuntimeOwnsSkillsRuntimeCache(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/skills/session-skills.ts')
  // P4c 第二批:skills 整域迁 router,`@main` 那层壳适配已删 —— 判据改指域文件。
  const mainFile = path.join(root, 'packages/backend/rpc/domains/skills.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const lines = [
    ...(!runtimeContent.includes('OnethingSessionSkillsRuntime')
      ? [`${rel(runtimeFile)}: missing runtime-owned session skill cache service`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_SKILLS_IPC_RUNTIME_CACHE_FORBIDDEN_PATTERNS)
      : ['packages/backend/rpc/domains/skills.ts: missing skills RPC domain']),
  ]

  assertNoMatches('packages/onething-runtime owns skills runtime cache and settings projection', lines)
}

function checkRuntimeOwnsSkillsIpcOperations(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/skills/ipc-operations.ts')
  // P4c 第二批:同上,消费投影的是 skills RPC 域而不再是 `@main` 的壳适配。
  const mainFile = path.join(root, 'packages/backend/rpc/domains/skills.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'listOnethingSkillsForIpc',
    'refreshOnethingSkillsForIpc',
    'readOnethingSkillFileForIpc',
    'openOnethingSkillDirectoryForIpc',
    'createOnethingSkillForIpc',
    'deleteOnethingSkillForIpc',
    'toggleOnethingSkillEnabledForIpc',
  ]
  const lines = [
    ...(!fs.existsSync(runtimeFile)
      ? [`${rel(runtimeFile)}: missing runtime-owned skills IPC operations`]
      : []),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned skills IPC operation ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_SKILLS_IPC_OPERATIONS_FORBIDDEN_PATTERNS)
      : ['packages/backend/rpc/domains/skills.ts: missing skills RPC domain']),
  ]

  assertNoMatches('packages/onething-runtime owns skills IPC operations', lines)
}

function checkRuntimeOwnsSkillManageOperations(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/skills/manage.ts')
  const mainFile = path.join(root, 'packages/backend/wiring/skills/manage.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'configureOnethingSkillManageRuntime',
    'executeSkillManage',
    'previewSkillManage',
    'isSkillManageMutation',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_SKILL_MANAGE_FORBIDDEN_PATTERNS)
      : ['packages/backend/wiring/skills/manage.ts: missing skill_manage runtime adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns skill_manage operations', lines)
}

function checkRuntimeOwnsSkillsLoader(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/skills/loader.ts')
  const mainFile = path.join(root, 'packages/backend/wiring/skills/loader.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'configureOnethingSkillsLoaderRuntime',
    'loadAllSkills',
    'loadProjectSkillsForDirectory',
    'loadSkillsFromPath',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_SKILLS_LOADER_FORBIDDEN_PATTERNS)
      : ['packages/backend/wiring/skills/loader.ts: missing skills loader runtime adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns skills loader operations', lines)
}

/*
 * 08-21 P2/D 组:两条 SQLite 会话仓储 check(`checkRuntimeOwnsSqliteSessionRepository`
 * 与 `checkRuntimeOwnsSessionSqliteFailoverPolicy`)整条删除。它们盯的三个文件
 * (`sessions/sqlite-repository.ts`、`sessions/resilient-sqlite-adapters.ts`、
 * `app/stores/session-repository/sqlite-repository.ts`)在 072e96b4 之后已经不存在,
 * 会话存储 07 月起就是 per-session JSONL(见 docs/design/session-storage-jsonl.md),
 * 断言只剩下对一段不存在历史的怀念。
 */

function checkRuntimeOwnsMediaImageDataUrl(): void {
  const runtimeFile = 'packages/onething-runtime/src/media/image-file-data-url.ts'
  // P4c 第三批:`readImageBase64` 的调用点从 `@main` 壳适配搬到了 RPC 域,
  // 「不许在调用点重实现一遍」这条禁令跟着改指到新家。
  const mainFile = path.join(root, 'packages/backend/rpc/domains/media.ts')
  const runtimeContent = fs.existsSync(path.join(root, runtimeFile))
    ? fs.readFileSync(path.join(root, runtimeFile), 'utf-8')
    : ''
  const lines = [
    ...(!fs.existsSync(path.join(root, runtimeFile))
      ? [`${runtimeFile}: missing runtime-owned image file data URL helper`]
      : []),
    ...(!runtimeContent.includes('readOnethingImageFileDataUrlForIpc')
      ? [`${runtimeFile}: missing runtime-owned image file data URL IPC helper`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_MEDIA_IMAGE_DATA_URL_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/main/ipc/media.ts: missing media IPC adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns image file data URL helper', lines)
}

function checkRuntimeOwnsMediaLegacyList(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/media/media-library-service.ts')
  // P4c 第三批:`loadAll` 的调用点已是 RPC 域。
  const mainFile = path.join(root, 'packages/backend/rpc/domains/media.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const lines = [
    ...(!runtimeContent.includes('listLegacyImages')
      ? [`${rel(runtimeFile)}: missing runtime-owned legacy image list helper`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_MEDIA_LEGACY_LIST_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/main/ipc/media.ts: missing media IPC adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns legacy media image list projection', lines)
}

function checkRuntimeOwnsMediaGeneratedImageLegacySave(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/media/media-library-service.ts')
  // P3'a-2:整文件归位 `runtime/media/save-image.ts`(闭包只碰 stores/paths 转发)。
  const mainFile = path.join(root, 'packages/onething-runtime/src/media/save-image.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const lines = [
    ...(!runtimeContent.includes('saveGeneratedImageAsLegacyItem')
      ? [`${rel(runtimeFile)}: missing runtime-owned generated image legacy save helper`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_MEDIA_SAVE_IMAGE_FORBIDDEN_PATTERNS)
      : ['packages/onething-runtime/src/media/save-image.ts: missing media save adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns generated image legacy save projection', lines)
}

function checkRuntimeOwnsMediaLibraryIpcOperations(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/media/media-library-presentation.ts')
  // P4c 第三批:媒体库那八条投影的调用点已是 RPC 域。
  const mainFile = path.join(root, 'packages/backend/rpc/domains/media.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'listOnethingMediaAssets',
    'hideOnethingMediaAsset',
    'rebuildOnethingMediaLibrary',
    'rebuildOnethingMediaLibraryForIpc',
    'getOnethingMediaGallery',
    'listOnethingLegacyMediaImages',
    'deleteOnethingMediaItem',
    'clearOnethingMediaLibrary',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_MEDIA_LIBRARY_IPC_OPERATIONS_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/main/ipc/media.ts: missing media IPC adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns media library IPC operations', lines)
}

function checkRuntimeOwnsMarkdownAssetService(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/markdown/asset-service.ts')
  const mainFile = path.join(root, 'packages/backend/wiring/markdown/asset-service.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'resolveOnethingMarkdownAsset',
    'saveOnethingMarkdownAttachments',
    'OnethingMarkdownAssetServiceAdapters',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_MARKDOWN_ASSET_SERVICE_FORBIDDEN_PATTERNS)
      : ['packages/backend/wiring/markdown/asset-service.ts: missing markdown asset adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns Markdown asset service', lines)
}

function checkRuntimeOwnsMarkdownIpcOperations(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/markdown/ipc-operations.ts')
  const mainFile = path.join(root, 'apps/electron/src/main/ipc/markdown.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'resolveOnethingMarkdownAssetForIpc',
    'saveOnethingMarkdownAttachmentsForIpc',
    'Failed to resolve Markdown asset',
    'Failed to save Markdown attachments',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned Markdown IPC operation ${symbol}`),
    // 缺席现在是**正确**状态,不是缺口:主线 T 批 3 把 markdown 整只迁到通用 RPC 通道,
    // 这个适配器随之退役 —— checkMarkdownDomainRidesTheRpcChannel 把同一个路径列进
    // retiredFiles,它**回来**才算红。原来那句 else 要求它必须在,和孪生规则要求它必须
    // 不在,是两条规则在同一个文件上说反话;谁在跑谁说了算,而两条都在跑。
    // 文件若真回来了,这里照旧扫禁令模式,双保险不变。
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_MARKDOWN_IPC_OPERATIONS_FORBIDDEN_PATTERNS)
      : []),
  ]

  assertNoMatches('packages/onething-runtime owns Markdown IPC operations', lines)
}

function checkRuntimeOwnsVoiceIpcOperations(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/voice/ipc-operations.ts')
  // P4c 第十一批:十一条数据面的调用点从 `@main/ipc/voice.ts` 搬进了域处理者 ——
  // 断言改指它,守的仍是同一件事(装配层不许把投影逻辑再抄一份)。
  const mainFile = path.join(root, 'packages/backend/rpc/domains/voice.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'getOnethingVoiceStateForIpc',
    'testOnethingVoiceASRForIpc',
    'testOnethingVoiceTTSForIpc',
    'listOnethingVoiceTTSModelsForIpc',
    'acknowledgeOnethingVoiceRuntimeReadyForIpc',
    'handleOnethingVoiceRuntimeEventForIpc',
  ]
  const lines = [
    ...(!fs.existsSync(runtimeFile)
      ? [`${rel(runtimeFile)}: missing runtime-owned voice IPC operations`]
      : []),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned voice IPC operation ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_VOICE_IPC_OPERATIONS_FORBIDDEN_PATTERNS)
      : ['packages/backend/rpc/domains/voice.ts: missing voice RPC domain']),
  ]

  assertNoMatches('packages/onething-runtime owns voice IPC operations', lines)
}

function checkRuntimeOwnsVoiceProviderRuntime(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/voice/providers.ts')
  const runtimeIndexFile = path.join(root, 'packages/onething-runtime/src/voice/index.ts')
  const runtimePackage = path.join(root, 'packages/onething-runtime/package.json')
  const mainFile = path.join(root, 'packages/backend/wiring/voice/providers.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const runtimeIndexContent = fs.existsSync(runtimeIndexFile) ? fs.readFileSync(runtimeIndexFile, 'utf-8') : ''
  const runtimePackageContent = fs.existsSync(runtimePackage) ? fs.readFileSync(runtimePackage, 'utf-8') : ''
  const mainContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf-8') : ''
  const mainLines = mainContent.split('\n').filter(line => line.trim().length > 0)
  const requiredRuntimeSymbols = [
    'transcribeOnethingUtterance',
    'getOnethingVoiceInputConfigurationError',
    'getOnethingOpenRouterTTSModels',
    'synthesizeOnethingSpeech',
    'streamSynthesizeOnethingSpeech',
    'OnethingVoiceProviderRuntimeAdapters',
  ]
  const lines = [
    ...(!fs.existsSync(runtimeFile)
      ? [`${rel(runtimeFile)}: missing runtime-owned voice provider runtime`]
      : []),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned voice provider symbol ${symbol}`),
    ...(!runtimeIndexContent.includes('./providers.js')
      ? [`${rel(runtimeIndexFile)}: missing voice provider runtime public export`]
      : []),
    ...(!runtimePackageContent.includes('"./voice/*"')
      ? [`${rel(runtimePackage)}: missing @onething/runtime voice wildcard package export`]
      : []),
    ...(!mainContent.includes('@onething/runtime/voice/providers')
      ? [`${rel(mainFile)}: main voice providers facade must delegate to runtime voice providers`]
      : []),
    ...(mainLines.length > 70
      ? [`${rel(mainFile)}: main voice providers facade must stay thin`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_VOICE_PROVIDER_RUNTIME_FORBIDDEN_PATTERNS)
      : ['packages/backend/wiring/voice/providers.ts: missing voice providers facade']),
  ]

  assertNoMatches('packages/onething-runtime owns voice provider runtime', lines)
}

function checkRuntimeOwnsVoiceServicePolicy(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/voice/service-runtime.ts')
  const runtimeTestFile = path.join(root, 'packages/onething-runtime/src/voice/__tests__/service-runtime.test.ts')
  const runtimeIndexFile = path.join(root, 'packages/onething-runtime/src/voice/index.ts')
  const mainFile = path.join(root, 'packages/backend/wiring/voice/service.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const runtimeTestContent = fs.existsSync(runtimeTestFile) ? fs.readFileSync(runtimeTestFile, 'utf-8') : ''
  const runtimeIndexContent = fs.existsSync(runtimeIndexFile) ? fs.readFileSync(runtimeIndexFile, 'utf-8') : ''
  const mainContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'normalizeOnethingVoiceError',
    'isOnethingMissingCloudTTSConfiguration',
    'getOnethingTTSModelName',
    'isOnethingWebSpeechWakeFailure',
    'applyOnethingVoiceWakeFailureFallback',
    'applyOnethingVoiceRuntimeStatus',
    'applyOnethingVoiceRuntimeError',
    'createOnethingVoiceLatencyMilestone',
    'applyOnethingVoiceRuntimeMilestone',
  ]
  const requiredMainDelegations = [
    '@onething/runtime/voice',
    'normalizeOnethingVoiceError',
    'isOnethingMissingCloudTTSConfiguration',
    'getOnethingTTSModelName',
    'applyOnethingVoiceWakeFailureFallback',
    'applyOnethingVoiceRuntimeStatus',
    'applyOnethingVoiceRuntimeError',
    'createOnethingVoiceLatencyMilestone',
    'applyOnethingVoiceRuntimeMilestone',
  ]
  const lines = [
    ...(!fs.existsSync(runtimeFile)
      ? [`${rel(runtimeFile)}: missing runtime-owned voice service policy`]
      : []),
    ...(!fs.existsSync(runtimeTestFile)
      ? [`${rel(runtimeTestFile)}: missing runtime-owned voice service policy tests`]
      : []),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned voice service policy symbol ${symbol}`),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeTestContent.includes(symbol))
      .map(symbol => `${rel(runtimeTestFile)}: missing voice service policy test coverage for ${symbol}`),
    ...(!runtimeIndexContent.includes('./service-runtime.js')
      ? [`${rel(runtimeIndexFile)}: missing voice service runtime public export`]
      : []),
    ...requiredMainDelegations
      .filter(symbol => !mainContent.includes(symbol))
      .map(symbol => `${rel(mainFile)}: main voice service must delegate ${symbol} to runtime voice service policy`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_VOICE_SERVICE_RUNTIME_FORBIDDEN_PATTERNS)
      : ['packages/backend/wiring/voice/service.ts: missing voice service adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns voice service policy', lines)
}

function checkRuntimeOwnsVoiceTextProcessing(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/voice/text.ts')
  const runtimeTestFile = path.join(root, 'packages/onething-runtime/src/voice/__tests__/text.test.ts')
  const runtimeIndexFile = path.join(root, 'packages/onething-runtime/src/voice/index.ts')
  const mainFile = path.join(root, 'packages/backend/wiring/voice/service.ts')
  const sharedFiles = [
    path.join(root, 'packages/shared/voice/segmenter.ts'),
    path.join(root, 'packages/shared/voice/tts-stream.ts'),
    path.join(root, 'packages/shared/voice/speak-markup.ts'),
  ]
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const runtimeTestContent = fs.existsSync(runtimeTestFile) ? fs.readFileSync(runtimeTestFile, 'utf-8') : ''
  const runtimeIndexContent = fs.existsSync(runtimeIndexFile) ? fs.readFileSync(runtimeIndexFile, 'utf-8') : ''
  const mainContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf-8') : ''
  const sharedContent = sharedFiles
    .map(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '')
    .join('\n')
  const requiredRuntimeSymbols = [
    'splitOnethingSpeakableSentences',
    'getOnethingSpeakableTextFromDelta',
    'createOnethingSpeakMarkupFilter',
    'getOnethingProtocolSpeakText',
  ]
  const requiredMainDelegations = [
    'splitOnethingSpeakableSentences',
    'getOnethingSpeakableTextFromDelta',
  ]
  const lines = [
    ...(!fs.existsSync(runtimeFile)
      ? [`${rel(runtimeFile)}: missing runtime-owned voice text processing`]
      : []),
    ...(!fs.existsSync(runtimeTestFile)
      ? [`${rel(runtimeTestFile)}: missing runtime-owned voice text processing tests`]
      : []),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned voice text symbol ${symbol}`),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeTestContent.includes(symbol))
      .map(symbol => `${rel(runtimeTestFile)}: missing voice text test coverage for ${symbol}`),
    ...(!runtimeIndexContent.includes('./text.js')
      ? [`${rel(runtimeIndexFile)}: missing voice text public export`]
      : []),
    ...requiredMainDelegations
      .filter(symbol => !mainContent.includes(symbol))
      .map(symbol => `${rel(mainFile)}: main voice service must delegate voice text processing ${symbol} to runtime`),
    ...(!sharedContent.includes('@onething/runtime/voice/text')
      ? ['packages/shared/voice: legacy shared voice files must re-export browser-safe runtime voice text helpers']
      : []),
    ...(/from\s+['"]@onething\/runtime\/voice['"]/.test(sharedContent)
      ? ['packages/shared/voice: renderer-facing voice text facades must not import Node-capable runtime voice entrypoint']
      : []),
    ...sharedFiles.flatMap(file => fs.existsSync(file)
      ? matchingLines(file, SHARED_VOICE_TEXT_RUNTIME_FORBIDDEN_PATTERNS)
      : [`${rel(file)}: missing legacy voice text facade`]),
  ]

  assertNoMatches('packages/onething-runtime owns voice text processing', lines)
}

/**
 * **检索只有一条查询路**(检索重建 S5)。
 *
 * 一条 = `rpc/domains/search.ts` → 进程单槽里的 `SearchService` → 注册表 → 能力。
 * 三条判据:
 *
 *  ① 旧扫描路的模块与它的形状(`switch(category)`、写死的类别清单、六个扫描器)
 *     **一处都不许有** —— 全仓扫,不限目录:第二条路长在哪儿都是第二条路;
 *  ② **契约层不许 import runtime** —— `@shared/ipc/search.ts` 是给壳吃的,
 *     「能搜什么」由 `search.capabilities` 那条路由答,不由一张转发过来的常量表答;
 *  ③ 装配层的取材面门面**保持极薄**(≤ 40 行,零编排):它只装单槽,不判档、
 *     不并结果。
 */
function checkSearchHasOneQueryPath(): void {
  const sharedSearchFile = path.join(root, 'packages/shared/ipc/search.ts')
  const facadeFile = path.join(root, 'packages/backend/wiring/search/providers.ts')
  const sharedSearchContent = fs.existsSync(sharedSearchFile) ? fs.readFileSync(sharedSearchFile, 'utf-8') : ''
  const facadeContent = fs.existsSync(facadeFile) ? fs.readFileSync(facadeFile, 'utf-8') : ''
  const facadeLines = facadeContent.split('\n').filter(line => line.trim().length > 0)

  // ① 旧路的形状:runtime 的检索树 + 装配层的检索接线 + 契约层那一份,全扫。
  const searchTrees = [
    path.join(root, 'packages/onething-runtime/src/search'),
    path.join(root, 'packages/backend/wiring/search'),
    path.join(root, 'packages/backend/rpc/domains'),
  ].filter(dir => fs.existsSync(dir))

  const lines = [
    ...RETIRED_SCAN_PATH_MODULES
      .filter(module => fs.existsSync(path.join(root, module)))
      .map(module => `${module}: 旧扫描路的模块又回来了(S5 已退役)`),
    ...SEARCH_CAPABILITY_MODULES
      .filter(module => !fs.existsSync(path.join(root, module)))
      .map(module => `${module}: 缺一个内置能力的文件(一类 = 一个文件)`),
    ...searchTrees
      .flatMap(dir => walkFiles(dir))
      .flatMap(file => matchingCodeLines(file, RETIRED_SCAN_PATH_PATTERNS)),
    ...(fs.existsSync(sharedSearchFile)
      ? matchingCodeLines(sharedSearchFile, RETIRED_SCAN_PATH_PATTERNS)
      : [`packages/shared/ipc/search.ts: missing search IPC contract`]),
    // ② 契约层不许从 runtime 拿值(类型也不行:那会把产品层拖进渲染层的包)。
    ...(/from\s+['"]@onething\/runtime/.test(sharedSearchContent)
      ? [`${rel(sharedSearchFile)}: 契约层不许 import runtime —— 「能搜什么」问 search.capabilities`]
      : []),
    // ③ 门面极薄。
    ...(fs.existsSync(facadeFile)
      ? []
      : ['packages/backend/wiring/search/providers.ts: missing search adapters assembly point']),
    ...(facadeLines.length > 40
      ? [`${rel(facadeFile)}: 取材面门面必须保持极薄(现在 ${facadeLines.length} 行)`]
      : []),
  ]

  assertNoMatches('search has exactly one query path (registry + capabilities)', lines)
}

function checkRuntimeOwnsHeadlessCliProjections(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/headless/cli-projections.ts')
  const mainFile = path.join(root, 'packages/backend/wiring/headless/backend.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'listOnethingHeadlessSessionSummaries',
    'listOnethingHeadlessProviderSummaries',
    'upsertOnethingHeadlessProviderConfig',
    'useOnethingHeadlessProvider',
    'listOnethingHeadlessProviderModels',
    'listOnethingHeadlessToolSummaries',
    'updateOnethingHeadlessToolSetting',
    'setOnethingHeadlessPermissionMode',
  ]
  const lines = [
    ...(!fs.existsSync(runtimeFile)
      ? [`${rel(runtimeFile)}: missing runtime-owned headless CLI projection module`]
      : []),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned headless CLI projection ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_HEADLESS_CLI_PROJECTION_FORBIDDEN_PATTERNS)
      : ['packages/backend/wiring/headless/backend.ts: missing headless backend adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns headless CLI projections', lines)
}

function checkRuntimeOwnsPromptsStore(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/prompts/store.ts')
  const runtimeIpcFile = path.join(root, 'packages/onething-runtime/src/prompts/ipc-operations.ts')
  // P3'a-2:归位 `runtime/prompts/store-bound.ts`(与 runtime 的 `store.ts` 同概念异角色,故带 -bound)。
  const mainFile = path.join(root, 'packages/onething-runtime/src/prompts/store-bound.ts')
  // 迁移后调用 ipc-operations 的是 RPC 域,不再是 @main 的 handler。
  const mainIpcFile = path.join(root, 'packages/backend/rpc/domains/prompts.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const runtimeIpcContent = fs.existsSync(runtimeIpcFile) ? fs.readFileSync(runtimeIpcFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'OnethingPromptStore',
    'list()',
    'create(request',
    'update(request',
    'delete(id',
    'setPathForTests',
  ]
  const requiredRuntimeIpcSymbols = [
    'listOnethingPromptsForIpc',
    'getOnethingPromptForIpc',
    'createOnethingPromptForIpc',
    'updateOnethingPromptForIpc',
    'deleteOnethingPromptForIpc',
  ]
  const lines = [
    ...(!fs.existsSync(runtimeFile)
      ? [`${rel(runtimeFile)}: missing runtime-owned prompts store`]
      : []),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned ${symbol}`),
    ...(!fs.existsSync(runtimeIpcFile)
      ? [`${rel(runtimeIpcFile)}: missing runtime-owned prompts IPC operations`]
      : []),
    ...requiredRuntimeIpcSymbols
      .filter(symbol => !runtimeIpcContent.includes(symbol))
      .map(symbol => `${rel(runtimeIpcFile)}: missing runtime-owned prompts IPC operation ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_PROMPTS_STORE_FORBIDDEN_PATTERNS)
      : ['packages/onething-runtime/src/prompts/store-bound.ts: missing prompts store facade']),
    ...(fs.existsSync(mainIpcFile)
      ? matchingLines(mainIpcFile, MAIN_PROMPTS_IPC_OPERATIONS_FORBIDDEN_PATTERNS)
      : ['packages/backend/rpc/domains/prompts.ts: missing prompts RPC domain']),
  ]

  assertNoMatches('packages/onething-runtime owns prompts store', lines)
}

function checkRuntimeOwnsSystemPromptSnapshot(): void {
  const runtimeFiles = [
    path.join(root, 'packages/onething-runtime/src/prompts/system-prompt-snapshot.ts'),
    path.join(root, 'packages/onething-runtime/src/prompts/index.ts'),
  ]
  const mainFile = path.join(root, 'packages/backend/wiring/engine/prompt/system-prompt-snapshot.ts')
  // P4c 第五批:快照读取的调用点已是 RPC 域。
  const chatIpcFile = path.join(root, 'packages/backend/rpc/domains/chat.ts')
  const runtimeContent = runtimeFiles
    .map(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '')
    .join('\n')
  const mainContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'buildSystemPromptSnapshotWithAdapters',
    'toolSnapshot',
    'mcpToolSnapshot',
    'nativeToolSnapshot',
    'skillSnapshot',
    'providerConfigForPrompt',
    'buildOnethingSystemPromptSnapshotForIpc',
  ]
  const lines = [
    ...runtimeFiles
      .filter(file => !fs.existsSync(file))
      .map(file => `${rel(file)}: missing runtime-owned system prompt snapshot module`),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `packages/onething-runtime/src/prompts/system-prompt-snapshot.ts: missing runtime-owned ${symbol}`),
    ...(mainContent.includes("from '../../../../packages/core/engine/index.js'") && mainContent.includes('buildSystemPromptSnapshotWithAdapters')
      ? [`${rel(mainFile)}: system prompt snapshot adapter should import runtime-owned builder`]
      : []),
    ...(fs.existsSync(chatIpcFile)
      ? matchingLines(chatIpcFile, MAIN_CHAT_IPC_SYSTEM_PROMPT_SNAPSHOT_FORBIDDEN_PATTERNS)
      : ['packages/backend/rpc/domains/chat.ts: missing chat RPC domain']),
  ]

  assertNoMatches('packages/onething-runtime owns system prompt snapshot assembly', lines)
}

function checkRuntimeOwnsProjectDirsStore(): void {
  const runtimeFiles = [
    path.join(root, 'packages/onething-runtime/src/project-dirs/store.ts'),
    path.join(root, 'packages/onething-runtime/src/project-dirs/persistence.ts'),
    path.join(root, 'packages/onething-runtime/src/project-dirs/id.ts'),
    path.join(root, 'packages/onething-runtime/src/project-dirs/prompt.ts'),
    path.join(root, 'packages/onething-runtime/src/project-dirs/types.ts'),
    path.join(root, 'packages/onething-runtime/src/project-dirs/ipc-operations.ts'),
  ]
  const mainFiles = [
    path.join(root, 'packages/backend/wiring/project-dirs/store/index.ts'),
    path.join(root, 'packages/backend/wiring/project-dirs/store/persistence.ts'),
    path.join(root, 'packages/backend/wiring/project-dirs/store/id.ts'),
    path.join(root, 'packages/backend/wiring/project-dirs/prompt.ts'),
    path.join(root, 'packages/backend/wiring/project-dirs/types.ts'),
  ]
  const mainIpcFile = path.join(root, 'apps/electron/src/main/ipc/project-dirs.ts')
  const runtimeContent = runtimeFiles
    .map(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '')
    .join('\n')
  const requiredRuntimeSymbols = [
    'ProjectsStore',
    'projectIdFromPath',
    'loadIndex',
    'saveProject',
    'buildProjectDirsPromptVars',
    'parseProjectIndex',
    'listOnethingProjectDirsForIpc',
    'getOnethingProjectDirForIpc',
    'addOnethingProjectDirForIpc',
    'updateOnethingProjectDirForIpc',
    'removeOnethingProjectDirForIpc',
  ]
  const lines = [
    ...runtimeFiles
      .filter(file => !fs.existsSync(file))
      .map(file => `${rel(file)}: missing runtime-owned project-dirs module`),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `packages/onething-runtime/src/project-dirs: missing runtime-owned ${symbol}`),
    ...mainFiles.flatMap(file => fs.existsSync(file)
      ? [`${rel(file)}: project-dirs store/prompt facade should be removed; import @onething/runtime/project-dirs directly`]
      : []
    ),
    ...(fs.existsSync(mainIpcFile)
      ? matchingLines(mainIpcFile, MAIN_PROJECT_DIRS_IPC_OPERATIONS_FORBIDDEN_PATTERNS)
      // 结构债 P4c:该域已整只迁到通用 RPC 通道,旧的 `@main/ipc/<域>.ts` 适配文件
      // 不存在了 —— 「文件缺席 = 红」这一支随之退役,上面「runtime 拥有实现」的断言照旧。
      : []),
  ]

  assertNoMatches('packages/onething-runtime owns project-dirs store and prompt helpers', lines)
}

function checkRuntimeOwnsVariablesStoreAndHelpers(): void {
  const runtimeFiles = [
    path.join(root, 'packages/onething-runtime/src/variables/store.ts'),
    path.join(root, 'packages/onething-runtime/src/variables/schema.ts'),
    path.join(root, 'packages/onething-runtime/src/variables/format.ts'),
    path.join(root, 'packages/onething-runtime/src/variables/validation.ts'),
    path.join(root, 'packages/onething-runtime/src/variables/types.ts'),
    path.join(root, 'packages/onething-runtime/src/variables/ipc-operations.ts'),
    path.join(root, 'packages/onething-runtime/src/variables/registry.ts'),
    path.join(root, 'packages/onething-runtime/src/variables/providers/core.ts'),
    path.join(root, 'packages/onething-runtime/src/variables/providers/notes.ts'),
    path.join(root, 'packages/onething-runtime/src/variables/providers/session-store.ts'),
    path.join(root, 'packages/onething-runtime/src/variables/providers/global-store.ts'),
    path.join(root, 'packages/onething-runtime/src/variables/providers/index.ts'),
  ]
  // P3'a-2:归位 `runtime/variables/store-bound.ts`(盘上 IO 在同批的 store-persistence.ts)。
  const mainStoreFile = path.join(root, 'packages/onething-runtime/src/variables/store-bound.ts')
  const removedMainFacadeFiles = [
    path.join(root, 'packages/backend/wiring/variables/store/schema.ts'),
    path.join(root, 'packages/backend/wiring/variables/format.ts'),
    path.join(root, 'packages/backend/wiring/variables/validation.ts'),
    path.join(root, 'packages/backend/wiring/variables/types.ts'),
    path.join(root, 'packages/backend/wiring/variables/registry.ts'),
    path.join(root, 'packages/backend/wiring/variables/providers/core.ts'),
    path.join(root, 'packages/backend/wiring/variables/providers/notes.ts'),
    path.join(root, 'packages/backend/wiring/variables/providers/session-store.ts'),
    path.join(root, 'packages/backend/wiring/variables/providers/global-store.ts'),
  ]
  const mainIpcFile = path.join(root, 'apps/electron/src/main/ipc/variables.ts')
  const runtimeContent = runtimeFiles
    .map(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '')
    .join('\n')
  const requiredRuntimeSymbols = [
    'VariablesStore',
    'createDefaultVariablesFile',
    'parseVariablesFile',
    'formatStateVariablesForPrompt',
    'assertValidName',
    'VariableError',
    'listOnethingVariablesForIpc',
    'setOnethingVariableForIpc',
    'deleteOnethingVariableForIpc',
    'variableIpcError',
    'VariableRegistry',
    'getVariableRegistry',
    'CoreProvider',
    'NotesProvider',
    'SessionStoreProvider',
    'GlobalStoreProvider',
  ]
  const lines = [
    ...runtimeFiles
      .filter(file => !fs.existsSync(file))
      .map(file => `${rel(file)}: missing runtime-owned variables module`),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `packages/onething-runtime/src/variables: missing runtime-owned ${symbol}`),
    ...(fs.existsSync(mainStoreFile)
      ? matchingLines(mainStoreFile, MAIN_VARIABLES_RUNTIME_FORBIDDEN_PATTERNS)
      : ['packages/onething-runtime/src/variables/store-bound.ts: missing variables store host adapter']),
    ...removedMainFacadeFiles.flatMap(file => fs.existsSync(file)
      ? [`${rel(file)}: variables facade should be removed; import @onething/runtime/variables directly`]
      : []
    ),
    ...(fs.existsSync(mainIpcFile)
      ? matchingLines(mainIpcFile, MAIN_VARIABLES_IPC_OPERATIONS_FORBIDDEN_PATTERNS)
      // 结构债 P4c:该域已整只迁到通用 RPC 通道,旧的 `@main/ipc/<域>.ts` 适配文件
      // 不存在了 —— 「文件缺席 = 红」这一支随之退役,上面「runtime 拥有实现」的断言照旧。
      : []),
  ]

  assertNoMatches('packages/onething-runtime owns variables store and pure helpers', lines)
}

function checkRuntimeOwnsAgentsStoreAndIpcOperations(): void {
  const runtimeStoreFile = path.join(root, 'packages/onething-runtime/src/agents/store.ts')
  const runtimeIpcFile = path.join(root, 'packages/onething-runtime/src/agents/ipc-operations.ts')
  // P3'a-2:归位 `runtime/agents/store-bound.wiring.ts`(吃 @shared/ipc 的 AgentDefinition,故带 .wiring)。
  const mainStoreFile = path.join(root, 'packages/onething-runtime/src/agents/store-bound.wiring.ts')
  const adapterFile = path.join(root, 'packages/backend/rpc/domains/agents.ts')
  const runtimeContent = [
    fs.existsSync(runtimeStoreFile) ? fs.readFileSync(runtimeStoreFile, 'utf-8') : '',
    fs.existsSync(runtimeIpcFile) ? fs.readFileSync(runtimeIpcFile, 'utf-8') : '',
  ].join('\n')
  const requiredRuntimeSymbols = [
    'createOnethingAgentStore',
    'listOnethingAgents',
    'listOnethingAgentsForIpc',
    'createOnethingAgentFromRequest',
    'createOnethingAgentFromRequestForIpc',
    'updateOnethingAgentFromRequest',
    'updateOnethingAgentFromRequestForIpc',
    'deleteOnethingAgentFromRequest',
    'deleteOnethingAgentFromRequestForIpc',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeIpcFile)}: missing runtime-owned ${symbol}`),
    ...(fs.existsSync(mainStoreFile)
      ? matchingLines(mainStoreFile, MAIN_AGENTS_STORE_FORBIDDEN_PATTERNS)
      : ['packages/onething-runtime/src/agents/store-bound.wiring.ts: missing agent store adapter']),
    ...(fs.existsSync(adapterFile)
      ? matchingLines(adapterFile, MAIN_AGENTS_IPC_OPERATIONS_FORBIDDEN_PATTERNS)
      : [`${rel(adapterFile)}: missing agents RPC domain`]),
  ]

  assertNoMatches('packages/onething-runtime owns agents store and IPC operations', lines)
}

function checkRuntimeOwnsAppStateUiSave(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/storage/app-state.ts')
  const mainFile = path.join(root, 'apps/electron/src/main/ipc/app-state.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'mergeOnethingUiState',
    'saveOnethingUiState',
    'saveOnethingUiStateForIpc',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_APP_STATE_IPC_UI_SAVE_FORBIDDEN_PATTERNS)
      // 结构债 P4c:该域已整只迁到通用 RPC 通道,旧的 `@main/ipc/<域>.ts` 适配文件
      // 不存在了 —— 「文件缺席 = 红」这一支随之退役,上面「runtime 拥有实现」的断言照旧。
      : []),
  ]

  assertNoMatches('packages/onething-runtime owns app-state UI save flow', lines)
}

function checkRuntimeOwnsSchedulerIpcOperations(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/scheduler/ipc-operations.ts')
  const mainFile = path.join(root, 'apps/electron/src/main/ipc/scheduler.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'listOnethingSchedulerTasks',
    'listOnethingSchedulerTasksForIpc',
    'getOnethingSchedulerTask',
    'getOnethingSchedulerTaskForIpc',
    'runOnethingSchedulerTaskNow',
    'runOnethingSchedulerTaskNowForIpc',
    'setOnethingSchedulerTaskEnabled',
    'setOnethingSchedulerTaskEnabledForIpc',
    'createOnethingUserSchedulerTask',
    'createOnethingUserSchedulerTaskForIpc',
    'updateOnethingUserSchedulerTask',
    'updateOnethingUserSchedulerTaskForIpc',
    'deleteOnethingUserSchedulerTask',
    'deleteOnethingUserSchedulerTaskForIpc',
    'listOnethingSchedulerRuns',
    'listOnethingSchedulerRunsForIpc',
    'getOnethingSchedulerRun',
    'getOnethingSchedulerRunForIpc',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_SCHEDULER_IPC_OPERATIONS_FORBIDDEN_PATTERNS)
      // 结构债 P4c:该域已整只迁到通用 RPC 通道,旧的 `@main/ipc/<域>.ts` 适配文件
      // 不存在了 —— 「文件缺席 = 红」这一支随之退役,上面「runtime 拥有实现」的断言照旧。
      : []),
  ]

  assertNoMatches('packages/onething-runtime owns scheduler IPC operations', lines)
}

function checkRuntimeOwnsSchedulerCore(): void {
  const runtimeSchedulerFile = path.join(root, 'packages/onething-runtime/src/scheduler/scheduler.ts')
  const runtimeCronFile = path.join(root, 'packages/onething-runtime/src/scheduler/cron.ts')
  const runtimeTypesFile = path.join(root, 'packages/onething-runtime/src/scheduler/types.ts')
  const runtimeIndexFile = path.join(root, 'packages/onething-runtime/src/scheduler/index.ts')
  // P3'a-3:绑定件从 `app/scheduler/index.ts` 归位到 `runtime/src/scheduler/scheduler-bound.ts`
  // —— 它配的是 store 路径 + `./scheduler.js`,唯一的装配层边 `consolePort` 也已归位。
  const mainSchedulerFile = path.join(root, 'packages/onething-runtime/src/scheduler/scheduler-bound.ts')
  const mainCronFile = path.join(root, 'packages/backend/wiring/scheduler/cron.ts')
  const mainTypesFile = path.join(root, 'packages/backend/wiring/scheduler/types.ts')
  const runtimeSchedulerContent = fs.existsSync(runtimeSchedulerFile) ? fs.readFileSync(runtimeSchedulerFile, 'utf-8') : ''
  const runtimeCronContent = fs.existsSync(runtimeCronFile) ? fs.readFileSync(runtimeCronFile, 'utf-8') : ''
  const runtimeTypesContent = fs.existsSync(runtimeTypesFile) ? fs.readFileSync(runtimeTypesFile, 'utf-8') : ''
  const runtimeIndexContent = fs.existsSync(runtimeIndexFile) ? fs.readFileSync(runtimeIndexFile, 'utf-8') : ''
  const mainSchedulerContent = fs.existsSync(mainSchedulerFile) ? fs.readFileSync(mainSchedulerFile, 'utf-8') : ''
  const requiredRuntimeSchedulerSymbols = [
    'export class Scheduler',
    'SchedulerOptions',
    'configureOnethingScheduler',
    'getOnethingScheduler',
    'resetOnethingSchedulerForTests',
  ]
  const requiredRuntimeCronSymbols = [
    'parseCronExpression',
    'nextCronRunAt',
    'currentCronRunAt',
    'cronRunKey',
  ]
  const requiredRuntimeTypeSymbols = [
    'SchedulerTaskRegistration',
    'SchedulerTaskSnapshot',
    'SchedulerRunRecord',
  ]
  const requiredRuntimeIndexExports = [
    './cron.js',
    './scheduler.js',
    './types.js',
  ]
  const lines = [
    ...requiredRuntimeSchedulerSymbols
      .filter(symbol => !runtimeSchedulerContent.includes(symbol))
      .map(symbol => `${rel(runtimeSchedulerFile)}: missing runtime-owned scheduler symbol ${symbol}`),
    ...requiredRuntimeCronSymbols
      .filter(symbol => !runtimeCronContent.includes(symbol))
      .map(symbol => `${rel(runtimeCronFile)}: missing runtime-owned cron symbol ${symbol}`),
    ...requiredRuntimeTypeSymbols
      .filter(symbol => !runtimeTypesContent.includes(symbol))
      .map(symbol => `${rel(runtimeTypesFile)}: missing runtime-owned scheduler type ${symbol}`),
    ...requiredRuntimeIndexExports
      .filter(symbol => !runtimeIndexContent.includes(symbol))
      .map(symbol => `${rel(runtimeIndexFile)}: missing scheduler public export ${symbol}`),
    ...(
      runtimeSchedulerContent.includes('../stores/paths.js') || runtimeSchedulerContent.includes('packages/backend') || runtimeSchedulerContent.includes('@main/')
        ? [`${rel(runtimeSchedulerFile)}: runtime scheduler must not import main/store path globals`]
        : []
    ),
    ...(
      // 归位之后它是包内文件,说的是相对路径 `./scheduler.js`(同 runtime 其余源码的
      // 惯例:只有测试用 `@onething/runtime/*` 自引用)。断言的语义不变:**绑定件必须
      // 去配 runtime 拥有的那台调度器,而不是自己长一台**。
      mainSchedulerContent.includes('./scheduler.js') && mainSchedulerContent.includes('configureOnethingScheduler')
        ? []
        : [`${rel(mainSchedulerFile)}: bound scheduler facade must configure the runtime-owned scheduler`]
    ),
    // P3'a-2(I2):`app/scheduler/{cron,types}.ts` 本来就只是 `export … from
    // '@onething/runtime/scheduler'` 的转发,与 runtime 里同名文件重复着同一个概念。
    // 已删,调用方直接 import `@onething/runtime/scheduler` —— 断言反过来:
    // **它们回来才算红**(同 checkRuntimeOwnsAcpRuntime 的 mainFacadeLines 判例)。
    ...[mainCronFile, mainTypesFile].flatMap(file => fs.existsSync(file)
      ? [`${rel(file)}: scheduler legacy facade should be removed; import @onething/runtime/scheduler directly`]
      : []),
    ...(fs.existsSync(mainSchedulerFile)
      ? matchingLines(mainSchedulerFile, MAIN_SCHEDULER_CORE_FORBIDDEN_PATTERNS)
      : ['packages/onething-runtime/src/scheduler/scheduler-bound.ts: missing scheduler core adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns scheduler core runtime', lines)
}

function checkRuntimeOwnsSchedulerRunHistory(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/scheduler/run-history.ts')
  const runtimeIndexFile = path.join(root, 'packages/onething-runtime/src/scheduler/index.ts')
  // P3'a-3:绑定件从 `app/scheduler/run-history.ts` 归位到
  // `runtime/src/scheduler/run-history-bound.wiring.ts` —— 带 `.wiring` 是因为它吃
  // `@shared/ipc` 的 `SchedulerRunDetailDTO`(I3:角色写在文件名里)。
  const mainFile = path.join(root, 'packages/onething-runtime/src/scheduler/run-history-bound.wiring.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const runtimeIndexContent = fs.existsSync(runtimeIndexFile) ? fs.readFileSync(runtimeIndexFile, 'utf-8') : ''
  const mainContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'OnethingSchedulerRunHistory',
    'SchedulerRunDetailLike',
    'safeSchedulerRunTaskFileName',
    'getSchedulerRunHistoryPath',
    'MAX_ONETHING_SCHEDULER_RUN_HISTORY_PER_TASK',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned scheduler run-history symbol ${symbol}`),
    ...(!runtimeIndexContent.includes('./run-history.js')
      ? [`${rel(runtimeIndexFile)}: missing scheduler run-history public export`]
      : []),
    ...(
      mainContent.includes('./run-history.js') && mainContent.includes('OnethingSchedulerRunHistory')
        ? []
        : [`${rel(mainFile)}: bound scheduler run-history facade must use the runtime-owned run history`]
    ),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_SCHEDULER_RUN_HISTORY_FORBIDDEN_PATTERNS)
      : ['packages/onething-runtime/src/scheduler/run-history-bound.wiring.ts: missing scheduler run-history adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns scheduler run-history storage', lines)
}

function checkRuntimeOwnsSchedulerUserTaskStore(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/scheduler/user-tasks.ts')
  const runtimeIndexFile = path.join(root, 'packages/onething-runtime/src/scheduler/index.ts')
  const mainFile = path.join(root, 'packages/backend/wiring/scheduler/user-tasks.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const runtimeIndexContent = fs.existsSync(runtimeIndexFile) ? fs.readFileSync(runtimeIndexFile, 'utf-8') : ''
  const mainContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'OnethingSchedulerUserTaskStore',
    'OnethingSchedulerUserTask',
    'OnethingSchedulerCreateTaskRequest',
    'OnethingSchedulerUpdateTaskRequest',
    'normalizeOnethingSchedulerUserTaskSchedule',
    'previewOnethingSchedulerPrompt',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned scheduler user-task symbol ${symbol}`),
    ...(!runtimeIndexContent.includes('./user-tasks.js')
      ? [`${rel(runtimeIndexFile)}: missing scheduler user-task public export`]
      : []),
    ...(
      mainContent.includes('@onething/runtime/scheduler')
        && mainContent.includes('OnethingSchedulerUserTaskStore')
        && mainContent.includes('previewOnethingSchedulerPrompt')
        ? []
        : [`${rel(mainFile)}: main scheduler user-tasks adapter must use @onething/runtime/scheduler user-task store`]
    ),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_SCHEDULER_USER_TASK_STORE_FORBIDDEN_PATTERNS)
      : ['packages/backend/wiring/scheduler/user-tasks.ts: missing scheduler user-tasks adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns scheduler user-task store', lines)
}

function checkRuntimeOwnsSchedulerRunDetailProjection(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/scheduler/run-detail.ts')
  const runtimeRunnerFile = path.join(root, 'packages/onething-runtime/src/scheduler/agent-task-runner.ts')
  const runtimeIndexFile = path.join(root, 'packages/onething-runtime/src/scheduler/index.ts')
  const mainUserTasksFile = path.join(root, 'packages/backend/wiring/scheduler/user-tasks.ts')
  // 结构债 P4c:定时任务的传输面从 `@main/ipc/scheduler.ts` 换成了 RPC 域文件。
  // 断言本身不变 —— 传输面必须把运行详情的投影**委托**给 runtime,而不是自己拼。
  const mainIpcFile = path.join(root, 'packages/backend/rpc/domains/scheduler.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const runtimeRunnerContent = fs.existsSync(runtimeRunnerFile) ? fs.readFileSync(runtimeRunnerFile, 'utf-8') : ''
  const runtimeIndexContent = fs.existsSync(runtimeIndexFile) ? fs.readFileSync(runtimeIndexFile, 'utf-8') : ''
  const mainUserTasksContent = fs.existsSync(mainUserTasksFile) ? fs.readFileSync(mainUserTasksFile, 'utf-8') : ''
  const mainIpcContent = fs.existsSync(mainIpcFile) ? fs.readFileSync(mainIpcFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'createOnethingSchedulerTimelineEntry',
    'toOnethingSchedulerRunStep',
    'toOnethingSchedulerRunToolCall',
    'finishOnethingSchedulerRunDetail',
    'createOnethingSchedulerRunDetailFromRecord',
    'previewOnethingSchedulerRunValue',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned scheduler run-detail symbol ${symbol}`),
    ...(!runtimeIndexContent.includes('./run-detail.js')
      ? [`${rel(runtimeIndexFile)}: missing scheduler run-detail public export`]
      : []),
    ...(
      runtimeRunnerContent.includes('createOnethingSchedulerTimelineEntry')
        && runtimeRunnerContent.includes('toOnethingSchedulerRunStep')
        && runtimeRunnerContent.includes('toOnethingSchedulerRunToolCall')
        && runtimeRunnerContent.includes('finishOnethingSchedulerRunDetail')
        ? []
        : [`${rel(runtimeRunnerFile)}: scheduler agent task runner must build run-detail projection with runtime helpers`]
    ),
    ...(
      mainUserTasksContent.includes('runOnethingSchedulerAgentTask')
        && mainUserTasksContent.includes('saveRunDetail')
        ? []
        : [`${rel(mainUserTasksFile)}: main scheduler user-tasks must delegate run-detail projection through runtime agent task runner`]
    ),
    ...(
      mainIpcContent.includes('createOnethingSchedulerRunDetailFromRecord')
        ? []
        : [`${rel(mainIpcFile)}: scheduler IPC must delegate generic run detail projection to runtime`]
    ),
    ...(fs.existsSync(mainUserTasksFile)
      ? matchingLines(mainUserTasksFile, MAIN_SCHEDULER_RUN_DETAIL_FORBIDDEN_PATTERNS)
      : ['packages/backend/wiring/scheduler/user-tasks.ts: missing scheduler user-tasks adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns scheduler run-detail projection', lines)
}

function checkRuntimeOwnsSchedulerAgentTaskRunner(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/scheduler/agent-task-runner.ts')
  const runtimeIndexFile = path.join(root, 'packages/onething-runtime/src/scheduler/index.ts')
  const mainFile = path.join(root, 'packages/backend/wiring/scheduler/user-tasks.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const runtimeIndexContent = fs.existsSync(runtimeIndexFile) ? fs.readFileSync(runtimeIndexFile, 'utf-8') : ''
  const mainContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'runOnethingSchedulerAgentTask',
    'OnethingSchedulerAgentTaskRunnerOptions',
    'OnethingSchedulerAgentTaskEventBus',
    'OnethingSchedulerAgentTaskSessionStore',
    'OnethingSchedulerAgentTaskStreamHost',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned scheduler agent task runner symbol ${symbol}`),
    ...(!runtimeIndexContent.includes('./agent-task-runner.js')
      ? [`${rel(runtimeIndexFile)}: missing scheduler agent-task runner public export`]
      : []),
    ...(
      mainContent.includes('runOnethingSchedulerAgentTask')
        ? []
        : [`${rel(mainFile)}: main scheduler user-tasks must delegate agent task execution to runtime`]
    ),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_SCHEDULER_AGENT_TASK_RUNNER_FORBIDDEN_PATTERNS)
      : ['packages/backend/wiring/scheduler/user-tasks.ts: missing scheduler user-tasks adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns scheduler agent task runner', lines)
}

// P4c 第八批:files 的十四条数据面已迁 `filesRouter`,`@main/ipc/files.ts` 与
// `apps/electron/src/ipc/files.ts` 整只删掉。下面六条「runtime 拥有 X 操作」的断言
// 因此改指**域处理者**(`packages/backend/rpc/domains/files.ts`)—— 守的还是同一件事:
// 投影逻辑住在产品层,传输层只转调,不许在这里重抄一份。
const FILES_RPC_DOMAIN_FILE = 'packages/backend/rpc/domains/files.ts'

function checkRuntimeOwnsFilesListIpcOperation(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/files/file-search.ts')
  const mainFile = path.join(root, FILES_RPC_DOMAIN_FILE)
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'resolveOnethingFileSearchRoots',
    'listOnethingFileSearchEntries',
    'listOnethingFileSearchEntriesForIpc',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_FILES_IPC_LIST_FORBIDDEN_PATTERNS)
      : [`${FILES_RPC_DOMAIN_FILE}: missing files RPC domain`]),
  ]

  assertNoMatches('packages/onething-runtime owns files list IPC operation', lines)
}

function checkRuntimeOwnsDirsListIpcOperation(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/files/directory-listing.ts')
  const mainFile = path.join(root, FILES_RPC_DOMAIN_FILE)
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'expandOnethingDirectoryBasePath',
    'listOnethingDirectoriesForCompletion',
    'listOnethingDirectoriesForCompletionForIpc',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_FILES_IPC_DIRS_LIST_FORBIDDEN_PATTERNS)
      : [`${FILES_RPC_DOMAIN_FILE}: missing files RPC domain`]),
  ]

  assertNoMatches('packages/onething-runtime owns dirs list IPC operation', lines)
}

function checkRuntimeOwnsFileContentAndDirectoryOperations(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/files/file-operations.ts')
  const mainFile = path.join(root, FILES_RPC_DOMAIN_FILE)
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'readOnethingFileContent',
    'saveOnethingFileContent',
    'listOnethingDirectory',
    'statOnethingPath',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_FILES_IPC_FILE_OPERATIONS_FORBIDDEN_PATTERNS)
      : [`${FILES_RPC_DOMAIN_FILE}: missing files RPC domain`]),
  ]

  assertNoMatches('packages/onething-runtime owns file content and directory operations', lines)
}

function checkRuntimeOwnsFileMutationOperations(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/files/file-operations.ts')
  const mainFile = path.join(root, FILES_RPC_DOMAIN_FILE)
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'createOnethingFile',
    'createOnethingDirectory',
    'renameOnethingPath',
    'deleteOnethingPath',
    'revealOnethingPath',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_FILES_IPC_MUTATION_OPERATIONS_FORBIDDEN_PATTERNS)
      : [`${FILES_RPC_DOMAIN_FILE}: missing files RPC domain`]),
  ]

  assertNoMatches('packages/onething-runtime owns file mutation operations', lines)
}

function checkRuntimeOwnsFileRollbackOperation(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/files/file-rollback.ts')
  const mainFile = path.join(root, FILES_RPC_DOMAIN_FILE)
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'rollbackOnethingFile',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_FILES_IPC_ROLLBACK_FORBIDDEN_PATTERNS)
      : [`${FILES_RPC_DOMAIN_FILE}: missing files RPC domain`]),
  ]

  assertNoMatches('packages/onething-runtime owns file rollback operation', lines)
}

function checkRuntimeOwnsFileWatchOperations(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/files/file-watch.ts')
  const mainFile = path.join(root, FILES_RPC_DOMAIN_FILE)
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'startOnethingFileWatchForIpc',
    'stopOnethingFileWatchForIpc',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_FILES_IPC_WATCH_FORBIDDEN_PATTERNS)
      : [`${FILES_RPC_DOMAIN_FILE}: missing files RPC domain`]),
  ]

  assertNoMatches('packages/onething-runtime owns file watch IPC operations', lines)
}

function checkRuntimeOwnsRipgrepFileSearchRuntime(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/files/ripgrep.ts')
  const runtimeIndexFile = path.join(root, 'packages/onething-runtime/src/files/index.ts')
  const runtimeTestFile = path.join(root, 'packages/onething-runtime/src/files/__tests__/ripgrep.test.ts')
  const mainFile = path.join(root, 'packages/backend/utils/ripgrep.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const runtimeIndexContent = fs.existsSync(runtimeIndexFile) ? fs.readFileSync(runtimeIndexFile, 'utf-8') : ''
  const mainContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf-8') : ''
  const mainLines = mainContent.split('\n').filter(line => line.trim().length > 0)
  const requiredRuntimeSymbols = [
    'configureOnethingRipgrepRuntime',
    'getOnethingRipgrepPath',
    'listOnethingRipgrepFiles',
    'searchOnethingRipgrep',
    'parseOnethingRipgrepSearchOutput',
    'buildOnethingRipgrepFileListArgs',
    'buildOnethingRipgrepSearchArgs',
  ]
  const lines = [
    ...(!fs.existsSync(runtimeFile)
      ? [`${rel(runtimeFile)}: missing runtime-owned ripgrep implementation`]
      : []),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime ripgrep symbol ${symbol}`),
    ...(!fs.existsSync(runtimeTestFile)
      ? [`${rel(runtimeTestFile)}: missing runtime ripgrep tests`]
      : []),
    ...(!runtimeIndexContent.includes('./ripgrep.js')
      ? [`${rel(runtimeIndexFile)}: missing ripgrep public export`]
      : []),
    ...(!mainContent.includes('@onething/runtime/files/ripgrep')
      ? [`${rel(mainFile)}: ripgrep facade must delegate to runtime ripgrep`]
      : []),
    ...(mainLines.length > 40
      ? [`${rel(mainFile)}: ripgrep facade must stay thin`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_RIPGREP_UTIL_FORBIDDEN_PATTERNS)
      : [`${rel(mainFile)}: missing ripgrep main facade`]),
  ]

  assertNoMatches('packages/onething-runtime owns ripgrep file search runtime', lines)
}

function checkRuntimeOwnsToolSandboxRuntime(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/tools/sandbox-runtime.ts')
  const runtimeIndexFile = path.join(root, 'packages/onething-runtime/src/tools/index.ts')
  const runtimeTestFile = path.join(root, 'packages/onething-runtime/src/tools/__tests__/sandbox-runtime.test.ts')
  const mainFile = path.join(root, 'packages/backend/wiring/tools/core/sandbox.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const runtimeIndexContent = fs.existsSync(runtimeIndexFile) ? fs.readFileSync(runtimeIndexFile, 'utf-8') : ''
  const mainContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf-8') : ''
  const mainLines = mainContent.split('\n').filter(line => line.trim().length > 0)
  const requiredRuntimeSymbols = [
    'configureOnethingToolSandboxRuntime',
    'getOnethingDefaultReadRoots',
    'getOnethingDownloadsDirectory',
    'getOnethingReadSandboxRoots',
    'checkOnethingFileAccess',
    'resolveOnethingToolPath',
  ]
  const lines = [
    ...(!fs.existsSync(runtimeFile)
      ? [`${rel(runtimeFile)}: missing runtime-owned tool sandbox runtime`]
      : []),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime tool sandbox symbol ${symbol}`),
    ...(!fs.existsSync(runtimeTestFile)
      ? [`${rel(runtimeTestFile)}: missing runtime tool sandbox tests`]
      : []),
    ...(!runtimeIndexContent.includes('./sandbox-runtime.js')
      ? [`${rel(runtimeIndexFile)}: missing sandbox-runtime public export`]
      : []),
    ...(!mainContent.includes('@onething/runtime/tools/sandbox-runtime')
      ? [`${rel(mainFile)}: sandbox facade must delegate to runtime sandbox-runtime`]
      : []),
    ...(mainLines.length > 70
      ? [`${rel(mainFile)}: sandbox facade must stay thin`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_TOOL_SANDBOX_FORBIDDEN_PATTERNS)
      : [`${rel(mainFile)}: missing sandbox main facade`]),
  ]

  assertNoMatches('packages/onething-runtime owns tool sandbox runtime', lines)
}

function checkRuntimeOwnsToolEditEngine(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/tools/edit-engine.ts')
  const runtimeIndexFile = path.join(root, 'packages/onething-runtime/src/tools/index.ts')
  const runtimeTestFile = path.join(root, 'packages/onething-runtime/src/tools/__tests__/edit-engine.test.ts')
  const mainFile = path.join(root, 'packages/backend/wiring/tools/core/edit-engine.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const runtimeIndexContent = fs.existsSync(runtimeIndexFile) ? fs.readFileSync(runtimeIndexFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'ExactEditPreviewResult',
    'applyExactEditsToNormalizedContent',
    'prepareExactEditPreview',
    'previewExactEdits',
  ]
  const lines = [
    ...(!fs.existsSync(runtimeFile)
      ? [`${rel(runtimeFile)}: missing runtime-owned edit engine`]
      : []),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime edit-engine symbol ${symbol}`),
    ...(!fs.existsSync(runtimeTestFile)
      ? [`${rel(runtimeTestFile)}: missing runtime edit-engine tests`]
      : []),
    ...(!runtimeIndexContent.includes('./edit-engine.js')
      ? [`${rel(runtimeIndexFile)}: missing edit-engine public export`]
      : []),
    ...(fs.existsSync(mainFile)
      ? [
          `${rel(mainFile)}: edit-engine facade should be removed; import @onething/runtime/tools/edit-engine directly`,
          ...matchingLines(mainFile, MAIN_TOOL_EDIT_ENGINE_FORBIDDEN_PATTERNS),
        ]
      : []),
  ]

  assertNoMatches('packages/onething-runtime owns tool edit engine', lines)
}

/**
 * R4b —— 具体工具实现归产品层。
 *
 * 主语从旧 `runtime/src/tools/builtin/*.ts`(`Tool.define` 那一批)换成新树的
 * `runtime/src/toolkit/builtin/*.ts`;三档目录的装配住在 `app/toolkit/catalog.ts`。
 * `removedFiles` 那张长表原样保留 —— 它守的是"这些东西不许再爬回 core / 装配层",
 * 而 R4b 又给它添了旧 builtin 那一批。
 */
function checkRuntimeOwnsConcreteBuiltinTools(): void {
  const removedFiles = [
    'packages/core/tools/time.ts',
    'packages/backend/wiring/tools/builtin/get-current-time.ts',
    'packages/backend/wiring/tools/builtin/fart.ts',
    'packages/backend/wiring/tools/builtin/time.ts',
    'packages/backend/wiring/tools/builtin/index.ts',
    'packages/backend/wiring/tools/builtin/headless.ts',
    'packages/backend/wiring/tools/builtin/readonly.ts',
    'packages/backend/wiring/tools/core/bash-classifier.ts',
    'packages/backend/wiring/tools/core/edit-engine.ts',
    'packages/backend/wiring/tools/core/file-mutation-audit.ts',
    'packages/backend/wiring/tools/core/file-mutation-queue.ts',
    'packages/backend/wiring/tools/core/output-accumulator.ts',
    'packages/backend/wiring/tools/core/sensitive-files.ts',
    'packages/backend/wiring/tools/core/text-truncation.ts',
    'packages/backend/wiring/tools/core/tool-effect.ts',
    'packages/backend/wiring/tools/core/tool-result.ts',
    'packages/backend/wiring/tools/core/tool.ts',
    'packages/core/tools/sensitive-files.ts',
    'packages/core/tools/background-jobs.ts',
    'packages/core/tools/bash-executor.ts',
    'packages/core/tools/output-accumulator.ts',
    'packages/core/tools/text-truncation.ts',
    'packages/core/tools/file-mutation-queue.ts',
    'packages/core/tools/file-snapshot.ts',
    'packages/core/tools/file-mutation-audit.ts',
    'packages/core/tools/sandbox.ts',
    'packages/core/tools/edit-engine.ts',
    'packages/core/tools/replacers.ts',
    'packages/core/tools/bash-classifier.ts',
    // R4b:旧的 `Tool.define` 工具对象。它们的实现搬进了 `toolkit/builtin/`。
    'packages/onething-runtime/src/tools/builtin/read.ts',
    'packages/onething-runtime/src/tools/builtin/write.ts',
    'packages/onething-runtime/src/tools/builtin/edit.ts',
    'packages/onething-runtime/src/tools/builtin/bash.ts',
    'packages/onething-runtime/src/tools/builtin/time.ts',
    'packages/onething-runtime/src/tools/builtin/variable.ts',
    'packages/onething-runtime/src/tools/builtin/say.ts',
    'packages/onething-runtime/src/tools/scene-surface.ts',
  ].filter(file => fs.existsSync(path.join(root, file)))
  const publicExportPaths = [
    path.join(root, 'packages/core/tools/index.ts'),
    path.join(root, 'packages/core/index.ts'),
  ]
  const toolkitIndexFile = path.join(root, 'packages/onething-runtime/src/toolkit/index.ts')
  const toolkitTimeFile = path.join(root, 'packages/onething-runtime/src/toolkit/builtin/time.ts')
  const timeRuntimeFile = path.join(root, 'packages/onething-runtime/src/tools/builtin/time-runtime.ts')
  const timeGoldenFile = path.join(root, 'packages/onething-runtime/src/toolkit/__tests__/golden/time.test.ts')
  const catalogFile = path.join(root, 'packages/backend/wiring/toolkit/catalog.ts')
  const toolkitIndexContent = fs.existsSync(toolkitIndexFile) ? fs.readFileSync(toolkitIndexFile, 'utf-8') : ''
  const toolkitTimeContent = fs.existsSync(toolkitTimeFile) ? fs.readFileSync(toolkitTimeFile, 'utf-8') : ''
  const timeRuntimeContent = fs.existsSync(timeRuntimeFile) ? fs.readFileSync(timeRuntimeFile, 'utf-8') : ''
  const catalogContent = fs.existsSync(catalogFile) ? fs.readFileSync(catalogFile, 'utf-8') : ''
  const requiredTimeSymbols = ['TimeTool', 'executeCoreTimeTool', 'resolveCoreTimezone']
  const lines = [
    ...removedFiles.map(file => `${file}: concrete builtin tools belong in packages/onething-runtime/src/toolkit`),
    ...publicExportPaths.flatMap(file => fs.existsSync(file)
      ? matchingLines(file, CORE_TOOL_RUNTIME_FORBIDDEN_PATTERNS)
      : []
    ),
    ...(!fs.existsSync(toolkitTimeFile)
      ? [`${rel(toolkitTimeFile)}: missing runtime-owned time tool`]
      : []),
    ...requiredTimeSymbols
      .filter(symbol => !`${toolkitTimeContent}${timeRuntimeContent}`.includes(symbol))
      .map(symbol => `${rel(toolkitTimeFile)}: missing runtime-owned time symbol ${symbol}`),
    ...(!fs.existsSync(timeGoldenFile)
      ? [`${rel(timeGoldenFile)}: missing runtime time tests`]
      : []),
    ...(!toolkitIndexContent.includes('./builtin/time.js')
      ? [`${rel(toolkitIndexFile)}: missing time public export`]
      : []),
    ...(!catalogContent.includes('createTimeTool')
      ? [`${rel(catalogFile)}: tier catalogs must register the time tool`]
      : []),
  ]

  assertNoMatches('packages/onething-runtime owns concrete builtin tool implementations', lines)
}

// ── C0(`docs/design/client-sdk-2026-09.md` §3):`packages/client` 的两条边界 ──

/**
 * `packages/client`(`@onething/client`)禁 import 的东西。
 *
 * 判据一句话:**它是 core 的客户端底座,不是任何一个壳的一部分**。所以既不认识
 * 前端框架(react / vue),也不认识宿主(electron / `@main` / `@preload`),也不
 * 反向依赖上层(`@onething/backend` / `@onething/runtime` —— 依赖是单向的:
 * 产品 ← 装配 ← 宿主,而客户端在这条链之外,只吃 `@shared` 契约与 `@onething/core`
 * 的纯类型)。`@renderer` / `@/` 是 Vue 渲染层的两个别名 —— 搬家的**目的**就是
 * 把这一层从那棵树里摘出来,搬完再引回去等于白搬。
 */
const CLIENT_PACKAGE_FORBIDDEN_IMPORT_PATTERNS: RegExp[] = [
  /^react(?:\/|$)/,
  /^react-dom(?:\/|$)/,
  /^vue(?:\/|$)/,
  /^electron(?:\/|$)/,
  /^@main\//,
  /^@preload\//,
  /^@renderer(?:\/|$)/,
  /^@\//,
  /^@onething\/backend(?:\/|$)/,
  /^@onething\/runtime(?:\/|$)/,
  /^@onething\/electron-host(?:\/|$)/,
  // 相对路径爬出包外(`../../renderer/...`)也是同一件事。
  /^\.\.\/\.\.\//,
]

/**
 * 浏览器独有的全局,`packages/client` 一个都不许**裸用** —— 连
 * `typeof window === 'undefined'` 这种守卫也不许。
 *
 * 守卫看着无害,其实是这层"双环境"承诺的漏点:一旦允许问,下一步就是
 * "在浏览器里走这条、在 Node 里走那条",于是 Node 那条永远没人跑,某天 CLI 一用
 * 就炸。**本包根本不该问自己在哪儿** —— 宿主能力(系统主题 / 剪贴板 / 打开外链)
 * 由参数注入,不由环境嗅探(§4.3)。
 *
 * `fetch` / `URL` / `TextDecoder` / `ReadableStream` / `AbortController` 不在名单上:
 * 它们是 Node 18+ 与浏览器都有的标准全局,正是"同一份代码"的物质基础。
 *
 * 一个例外,**写在这里而不是写在注释里**:`__tests__` 里允许出现 `window`,因为
 * "跑在 node 环境"这件事的证词恰恰是一句 `expect(typeof window).toBe('undefined')`。
 */
const CLIENT_PACKAGE_FORBIDDEN_GLOBAL_PATTERNS: RegExp[] = [
  /(?<![\w.$])window(?![\w$])/,
  /(?<![\w.$])document(?![\w$])/,
  /(?<![\w.$])navigator(?![\w$])/,
  /(?<![\w.$])EventSource(?![\w$])/,
  /(?<![\w.$])localStorage(?![\w$])/,
  /(?<![\w.$])sessionStorage(?![\w$])/,
]

/** 每个 client 测试文件都要自己钉住 node 环境(vitest 4 没有 environmentMatchGlobs)。 */
const CLIENT_TEST_ENVIRONMENT_PRAGMA = /@vitest-environment\s+node/

function checkClientPackageBoundary(): void {
  const clientRoot = path.join(root, 'packages/client')
  const files = walkFiles(clientRoot, [], { includeTests: true })
  const sourceFiles = files.filter(file => !isClientTestFile(file))

  const lines = [
    ...files.flatMap(file =>
      matchingImportSpecifierLines(file, CLIENT_PACKAGE_FORBIDDEN_IMPORT_PATTERNS)),
    // 全局禁令只对**产品源码**生效;测试要用 `window` 当证词(见上面的常量注释)。
    ...sourceFiles.flatMap(file =>
      matchingCodeLines(file, CLIENT_PACKAGE_FORBIDDEN_GLOBAL_PATTERNS)),
    ...files
      .filter(file => isClientTestFile(file)
        && !CLIENT_TEST_ENVIRONMENT_PRAGMA.test(fs.readFileSync(file, 'utf-8')))
      .map(file => `${rel(file)}:1: missing \`// @vitest-environment node\``),
  ]

  assertNoMatches(
    'packages/client stays framework-free, host-free and browser-global-free',
    lines,
  )
}

function isClientTestFile(file: string): boolean {
  return file.includes(`${path.sep}__tests__${path.sep}`) || /\.(?:test|spec)\.tsx?$/.test(file)
}

/**
 * **core 里不出现任何能力的名字**(CLAUDE.md 顶部「加功能不许改骨架」那条法的
 * 机械化;检索重建 S0,`docs/design/search-index-2026-09.md` §10 / §11 S3)。
 *
 * 起因写在法条里:检索方案 v2 被用户拿 symbol 能力一问,就露出 `Doc.kind` 的
 * `'message' | 'session' | 'daily'` 字面量联合与一处 `switch(category)` —— 两个
 * **按能力枚举**的点,加一类就得回来改骨架。v3.1 把它们改成「能力自述、别人读表」
 * (manifest + 注册表),这条规则守的就是它们别长回来。
 *
 * 两条判据,都只看**代码**(注释里写 `'messages'` 当然可以 —— 上一段就在写):
 *  ① 出现某个具体能力 id 的字符串字面量;
 *  ② 在 `.kind` / `.capability` 上 `switch` —— 联邦骨架里这两个字段的取值由能力
 *     自己定义,core 对它们一无所知,能 switch 就说明 core 认识那些取值。
 *
 * 目录还不存在(S1 之前)时打印一行「跳过」并返回,不红:S0 与 S1 是并行的两张
 * 派工单,S0 先把门立起来。
 */
const CORE_SEARCH_CAPABILITY_NAME_PATTERNS: RegExp[] = [
  // 今天六类的 id + 将来插件能力的命名空间前缀。单双引号都算,反引号不算
  // (模板串里出现这些名字的场景只可能是拼接,那本身就该红 —— 但今天零命中,
  //  不为一个不存在的形状加规则)。
  //
  // **会话那一类有两个名字,两个都禁**:跑着的那个 id 是 `chats`
  // (`capabilities/sessions.ts` 的 manifest),设计文档 §10 里叫 `sessions`。
  // 哪个名字最后活下来是**能力自己的事**,core 里一个都不许出现 —— 只列文档那个
  // 名字,等于给真正在跑的那个 id 开了后门。
  /(['"])(?:messages|chats|sessions|files|actions|prompts|daily)\1/,
  /(['"])plugin:/,
]

const CORE_SEARCH_KIND_SWITCH_PATTERN = /\bswitch\s*\([^)]*\.(?:kind|capability)\b/

function checkCoreSearchNamesNoCapability(): void {
  const searchRoot = path.join(root, 'packages/core/search')
  if (!fs.existsSync(searchRoot)) {
    console.log('[boundary] ok: core/search absent (S1 pending)')
    return
  }
  // `__tests__` 不在射程内(`walkFiles` 缺省就跳过):夹具与用例当然要拿真能力
  // 名字当证词,那正是它们的工作。
  const files = walkFiles(searchRoot)
  const lines = files.flatMap(file => matchingCodeLines(file, [
    ...CORE_SEARCH_CAPABILITY_NAME_PATTERNS,
    CORE_SEARCH_KIND_SWITCH_PATTERN,
  ]))
  assertNoMatches(
    'packages/core/search names no capability (no capability-id literals, no switch on .kind/.capability)',
    lines,
  )
}

/**
 * **壳不许 import 别的壳**(§3)。
 *
 * `apps/desktop-react`(React 壳)今天还向 `packages/renderer`(Vue 渲染层)伸手 ——
 * 那正是本方案要拆的东西。所以这条不是零基线硬闸,是**只减不增的棘轮**:基线
 * `docs/audit/shell-isolation-baseline-2026-09-03.txt` 记着每个文件今天有几条,
 * 任何文件高于它的数、或出现基线里没有的文件 → 红。C1 清零之后把基线清空,
 * 这条自然变成硬闸。
 *
 * 反方向(`packages/renderer` → `apps/desktop-react`)今天是 0,所以直接硬闸:
 * 一条都不许有,退役中的那棵树不该长出对新壳的依赖。
 */
const SHELL_ISOLATION_BASELINE_FILE = 'docs/audit/shell-isolation-baseline-2026-09-03.txt'

const REACT_SHELL_FORBIDDEN_SHELL_IMPORT_PATTERNS: RegExp[] = [
  /^@renderer(?:\/|$)/,
  /packages\/renderer\//,
]

const VUE_RENDERER_FORBIDDEN_SHELL_IMPORT_PATTERNS: RegExp[] = [
  /apps\/desktop-react/,
]

function readShellIsolationBaseline(): Map<string, number> {
  const baseline = new Map<string, number>()
  const filePath = path.join(root, SHELL_ISOLATION_BASELINE_FILE)
  if (!fs.existsSync(filePath)) return baseline
  for (const line of fs.readFileSync(filePath, 'utf-8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = /^(\S+)\s+(\d+)$/.exec(trimmed)
    if (match) baseline.set(match[1], Number.parseInt(match[2], 10))
  }
  return baseline
}

function checkShellsDoNotImportOtherShells(): void {
  const baseline = readShellIsolationBaseline()
  const counts = new Map<string, string[]>()
  for (const file of walkFiles(path.join(root, 'apps/desktop-react'), [], {
    includeTests: true,
    excludeDirs: ['dist', 'out', 'release'],
  })) {
    const hits = matchingImportSpecifierLines(file, REACT_SHELL_FORBIDDEN_SHELL_IMPORT_PATTERNS)
    if (hits.length > 0) counts.set(rel(file), hits)
  }

  const lines: string[] = []
  for (const [file, hits] of counts) {
    const allowed = baseline.get(file) ?? 0
    if (hits.length > allowed) {
      lines.push(
        `${file}: ${hits.length} cross-shell import(s), baseline ${allowed} — 壳不许 import 别的壳`,
        ...hits.map(hit => `  ${hit}`),
      )
    }
  }
  // 反方向:硬闸,一条都不许。
  // packages/renderer 于 2026-09-04 退役;反方向那一半随之消失,由 checkVueHostStaysRetired 守目录不许回来。

  assertNoMatches(
    `shells do not import other shells (ratchet: ${SHELL_ISOLATION_BASELINE_FILE})`,
    lines,
  )

  // 基线松了就说一声(不判红)—— C1 迁完之后照这几行把基线收紧。
  const improved: string[] = []
  for (const [file, allowed] of baseline) {
    const actual = counts.get(file)?.length ?? 0
    if (actual < allowed) improved.push(`  ${file}: ${actual} < baseline ${allowed}`)
  }
  if (improved.length > 0) {
    console.log(`[boundary] note: shell-isolation baseline can be tightened (${SHELL_ISOLATION_BASELINE_FILE})`)
    for (const line of improved) console.log(line)
  }
}

/**
 * Vue 宿主退役后不许长回来(运行时统一第四步,2026-09-04)。
 *
 * 三样东西任一出现即红:①`apps/electron` / `packages/renderer` / `apps/web` 三个目录;
 * ②根 package.json 里 vue / pinia / electron-vite / @vitejs/plugin-vue / vue-tsc 任一依赖;
 * ③仓里(node_modules 外)任何 `.vue` 文件。React 壳是唯一的桌面壳与浏览器壳。
 */
function checkVueHostStaysRetired(): void {
  const failures: string[] = []
  for (const dir of ['apps/electron', 'packages/renderer', 'apps/web']) {
    if (fs.existsSync(path.join(root, dir))) failures.push(`${dir}: directory must not exist (Vue host retired 2026-09-04)`)
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  for (const dep of ['vue', 'pinia', 'electron-vite', '@vitejs/plugin-vue', 'vue-tsc', 'eslint-plugin-vue', '@vue/test-utils']) {
    if (dep in all) failures.push(`package.json: dependency "${dep}" must not come back`)
  }
  const vueFiles: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'release', 'dist', 'out', '.claude'].includes(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.vue')) vueFiles.push(path.relative(root, full))
    }
  }
  walk(root)
  for (const file of vueFiles) failures.push(`${file}: .vue files are retired`)
  assertNoMatches('Vue host stays retired (no apps/electron, packages/renderer, apps/web, .vue files, or vue deps)', failures)
}

checkCoreForbiddenImports()
checkVueHostStaysRetired()
checkRuntimeHostBoundary()
checkClientPackageBoundary()
checkCoreSearchNamesNoCapability()
checkShellsDoNotImportOtherShells()
checkRuntimeWiringModulesStayAtTheEdge()
checkSessionVocabularyUsesTheRegistry()
checkGatewayHostBoundary()
checkGatewayLoadsRuntimeFromHostBoundary()
checkGatewayUsesExplicitTypingSignal()
checkGatewayRegistersConfiguredChannels()
checkGatewayWechatQrStateHandling()
checkAgentsDomainRidesTheRpcChannel()
checkPromptsDomainRidesTheRpcChannel()
checkMarkdownDomainRidesTheRpcChannel()
checkPermissionGrantsDomainRidesTheRpcChannel()
checkProvidersDomainRidesTheRpcChannel()
checkModelsDomainRidesTheRpcChannel()
checkMainUsesRuntimePackageImports()
checkMainUsesCorePackageImports()
checkMainUsesGatewayPackageImports()
checkCorePackageDependencies()
checkMainCoreSystemAdapters()
checkCorePublicExports()
checkCoreToolHelperTestsLiveInCorePackage()
checkCoreOwnsToolSchemaProjection()
checkCoreOwnsToolFailureParameterSummary()
checkCoreOwnsToolPermissionErrorText()
checkRuntimeToolHelperTestsLiveInRuntimePackage()
checkCoreOwnsSessionCommandIpcOperation()
checkCoreOwnsJsonProtocol()
checkCoreOwnsStreamChunkProtocol()
checkChatResumeAfterToolConfirmStaysRetired()
checkCorePromptAssemblyOwnedByRuntime()
checkCorePromptContextRegistryOwnedByRuntime()
checkRuntimeOwnsOnethingStoragePaths()
checkRuntimeOwnsPermissionGrantFileStorage()
checkRuntimeOwnsPermissionGrantsIpcPresentation()
checkRuntimeOwnsPermissionSessionIpcPresentation()
checkRuntimeOwnsAuthTokenStorage()
checkRuntimeOwnsAuthServiceFlow()
checkRuntimeOwnsAuthCallbackServer()
checkRuntimeOwnsOAuthIpcOperations()
checkRuntimeOwnsStreamRuntimeWiring()
checkRuntimeOwnsHistoryHelperWiring()
checkRuntimeOwnsAgentLoopRuntimeWiring()
checkRuntimeOwnsAgentLoopSelection()
checkCoreOwnsAgentLoopPureFacades()
checkRuntimeOwnsProviderRequestDump()
checkRuntimeOwnsProviderRegistry()
checkRuntimeOwnsProviderDefinitionTypes()
checkRuntimeOwnsProviderOauthConfigResolution()
checkRuntimeOwnsProviderFacadeOrchestration()
checkRuntimeOwnsProviderTitleOrchestration()
checkRuntimeOwnsProviderTextResponseProjection()
checkRuntimeOwnsProviderGenerateReasoningOrchestration()
checkRuntimeOwnsProviderAcpStreamProjection()
checkRuntimeOwnsAcpIpcOperations()
checkRuntimeOwnsAcpClientRuntime()
checkRuntimeOwnsDirectToolExecutionAdapter()
checkRuntimeOwnsToolUpdateOrchestration()
checkRuntimeOwnsStreamProcessorAdapter()
checkRuntimeOwnsImageStreamEntryPoint()
checkRuntimeOwnsProvidersIpcUsageFlow()
checkRuntimeOwnsProvidersIpcPresentation()
checkRuntimeOwnsNetworkPolicy()
checkRuntimeOwnsModelRegistryRefresh()
checkRuntimeOwnsModelsIpcPresentation()
checkRuntimeOwnsModelQueryIpcPresentation()
checkRuntimeOwnsMcpServerOrchestration()
checkRuntimeOwnsMcpCapabilityOperations()
checkRuntimeOwnsMcpIpcOperations()
checkRuntimeOwnsSessionBranchCreation()
checkRuntimeOwnsSessionUpdateFlows()
checkSessionEventSingleWriteDoor()
checkRuntimeOwnsSessionWorkingDirectoryFlow()
checkRuntimeOwnsSessionSystemMarkerFlow()
checkRuntimeOwnsSessionIpcOperations()
checkRuntimeOwnsRendererMessageSanitizer()
checkChatIpcDoesNotOwnLegacyStreamFlow()
checkRuntimeOwnsChatTitleGenerationFlow()
checkRuntimeOwnsChatSessionIpcOperations()
checkRuntimeOwnsChatActiveStreamListing()
checkRuntimeOwnsChatAbortCleanupFlow()
checkRuntimeOwnsToolRegistryRuntime()
checkRuntimeOwnsToolCallStateProjection()
checkRuntimeOwnsToolsIpcListPresentation()
checkRuntimeOwnsToolsIpcExecutionContext()
checkRuntimeOwnsToolsIpcBackgroundJobs()
checkRuntimeOwnsSettingsSaveOrchestration()
checkPluginLogicStaysOutOfHostAssembly()
checkPluginsOnlyUseInjectedApi()
checkCoreKnowsNoConcreteFeatures()
checkNoRawControlCharacters()
checkRuntimeOwnsSkillsRuntimeCache()
checkRuntimeOwnsSkillsIpcOperations()
checkRuntimeOwnsSkillManageOperations()
checkRuntimeOwnsSkillsLoader()
checkRuntimeOwnsMediaImageDataUrl()
checkRuntimeOwnsMediaLegacyList()
checkRuntimeOwnsMediaGeneratedImageLegacySave()
checkRuntimeOwnsMediaLibraryIpcOperations()
checkRuntimeOwnsMarkdownAssetService()
checkRuntimeOwnsMarkdownIpcOperations()
checkRuntimeOwnsVoiceIpcOperations()
checkRuntimeOwnsVoiceProviderRuntime()
checkRuntimeOwnsVoiceServicePolicy()
checkRuntimeOwnsVoiceTextProcessing()
checkSearchHasOneQueryPath()
checkRuntimeOwnsHeadlessCliProjections()
checkRuntimeOwnsPromptsStore()
checkRuntimeOwnsSystemPromptSnapshot()
checkRuntimeOwnsProjectDirsStore()
checkRuntimeOwnsVariablesStoreAndHelpers()
checkRuntimeOwnsAgentsStoreAndIpcOperations()
checkRuntimeOwnsAppStateUiSave()
checkRuntimeOwnsSchedulerIpcOperations()
checkRuntimeOwnsSchedulerCore()
checkRuntimeOwnsSchedulerRunHistory()
checkRuntimeOwnsSchedulerUserTaskStore()
checkRuntimeOwnsSchedulerRunDetailProjection()
checkRuntimeOwnsSchedulerAgentTaskRunner()
checkRuntimeOwnsFilesListIpcOperation()
checkRuntimeOwnsDirsListIpcOperation()
checkRuntimeOwnsFileContentAndDirectoryOperations()
checkRuntimeOwnsFileMutationOperations()
checkRuntimeOwnsFileRollbackOperation()
checkRuntimeOwnsFileWatchOperations()
checkRuntimeOwnsRipgrepFileSearchRuntime()
checkRuntimeOwnsToolSandboxRuntime()
checkRuntimeOwnsToolEditEngine()
checkRuntimeOwnsConcreteBuiltinTools()

if (!process.exitCode) {
  console.log('[boundary] ok: headless core boundary checks passed')
}

// 跑完的凭据。检查器中途崩掉时(比如调用了一个已被删掉的检查函数 —— 2026-08-14
// 就是这么塌的:d5cec15a 把 agents/providers/models 换成反向守卫,加了新声明却
// 漏改三处调用点,脚本在第 49 个检查处 ReferenceError 退出),前面已经打出的红
// 仍是「非空」,棘轮 gate 的空集护栏放行,于是一次半程运行被当成全绿 —— 那不是
// 绿,是只看了四分之一。这行只有走到文件末尾才会出现,gate 拿它当「这次结果算数」
// 的凭据;没有它一律不认。
console.log('[boundary] complete: all boundary checks executed')
