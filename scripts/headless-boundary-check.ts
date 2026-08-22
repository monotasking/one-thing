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
  /basePath:\s*''/,
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

const MAIN_FILES_IPC_HOST_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /ipcMain\.handle/,
  /Electron\.IpcMainInvokeEvent/,
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
  /createStepId:\s*createCoreId/,
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

const MAIN_CHAT_IPC_RESUME_CONFIRM_FORBIDDEN_PATTERNS: RegExp[] = [
  /handleResumeAfterToolConfirm/,
  /process\.nextTick/,
  /Resuming after tool confirm for session/,
  /completedToolCalls/,
  /pendingToolCalls/,
  /No completed tool calls to process/,
  /Still have pending tool calls awaiting confirmation/,
  /content:continuation/,
  /Assistant message not found/,
  /toolCalls\.filter/,
]

const MAIN_CHAT_IPC_HOST_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /ipcMain\.handle/,
  /Electron\.IpcMainInvokeEvent/,
]

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

const MAIN_TOOLS_IPC_HOST_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /ipcMain\.handle/,
  /Electron\.IpcMainInvokeEvent/,
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
  /return\s+\{\s*success:\s*true,\s*models:/,
  /return\s+\{\s*success:\s*true\s*\}/,
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

const MAIN_VOICE_IPC_HOST_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /ipcMain\.handle/,
  /Electron\.IpcMainInvokeEvent/,
]

const MAIN_SEARCH_IPC_OPERATIONS_FORBIDDEN_PATTERNS: RegExp[] = [
  /isSearchCategory/,
  /const\s+category\s*=\s*isSearchCategory/,
  /const\s+results\s*=\s*await\s+executeSearch/,
  /return\s+\{\s*success:\s*true,\s*results\s*\}/,
  /^\s*closeSearchWindow\(\)/,
  /return\s+\{\s*success:\s*true\s*\}/,
]

const SHARED_SEARCH_CATEGORY_FORBIDDEN_PATTERNS: RegExp[] = [
  /const\s+SEARCH_CATEGORIES\s*=\s*\[/,
  /type\s+SearchCategory\s*=\s*typeof\s+SEARCH_CATEGORIES/,
  /function\s+isSearchCategory/,
  /SEARCH_CATEGORIES\.includes/,
]

const MAIN_SEARCH_PROVIDER_ORCHESTRATION_FORBIDDEN_PATTERNS: RegExp[] = [
  /switch\s*\(category\)/,
  /case\s+['"]all['"]/,
  /const\s+includeDaily\s*=\s*Boolean\(normalizeQuery\(query\)\)/,
  /const\s+\[chats,\s*messages,\s*files,\s*daily,\s*prompts,\s*actions\]/,
  /query\.trim\(\)\.startsWith\(['"]\/['"]\)/,
  /\[\.\.\.actions,\s*\.\.\.prompts,\s*\.\.\.chats/,
  /\[\.\.\.chats,\s*\.\.\.prompts,\s*\.\.\.daily/,
  /function\s+normalizeQuery/,
  /function\s+searchChats/,
  /function\s+searchMessages/,
  /function\s+searchPrompts/,
  /function\s+getSearchDirs/,
  /async\s+function\s+searchFiles/,
  /async\s+function\s+getDailyNoteProfiles/,
  /async\s+function\s+searchDailyNotes/,
  /DEFAULT_DAILY_FORMAT/,
  /readObsidianDailyProfile/,
  /formatDailyDate/,
  /parseDateFromPath/,
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
}

function walkFiles(dir: string, output: string[] = [], options: WalkFilesOptions = {}): string[] {
  if (!fs.existsSync(dir)) return output
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if ((!options.includeTests && entry.name === '__tests__')
      || entry.name === 'node_modules'
      || entry.name === '.git') continue
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkFiles(fullPath, output, options)
    } else if (/\.(ts|tsx|js|mjs|cjs|json)$/.test(entry.name)) {
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
const APP_ASSEMBLY_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]electron['"]/,
  /require\(['"]electron['"]\)/,
  /@onething\/electron-host/,
  /from\s+['"]@main\//,
  /from\s+['"]@preload\//,
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

function checkCoreOwnsGatewayConversationRuntimeProtocol(): void {
  const coreFile = path.join(root, 'packages/core/gateway-runtime.ts')
  const corePackageFile = path.join(root, 'packages/core/package.json')
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/gateway-runtime.ts')
  const runtimeEntrypointFile = path.join(root, 'packages/onething-runtime/src/runtime.ts')
  const gatewayPackageFile = path.join(root, 'packages/gateway/package.json')
  const coreContent = fs.existsSync(coreFile) ? fs.readFileSync(coreFile, 'utf-8') : ''
  const corePackageContent = fs.existsSync(corePackageFile) ? fs.readFileSync(corePackageFile, 'utf-8') : ''
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const runtimeEntrypointContent = fs.existsSync(runtimeEntrypointFile) ? fs.readFileSync(runtimeEntrypointFile, 'utf-8') : ''
  const gatewayPackageContent = fs.existsSync(gatewayPackageFile) ? fs.readFileSync(gatewayPackageFile, 'utf-8') : ''
  const gatewayAndHostFiles = [
    ...walkFiles(path.join(root, 'packages/gateway')),
    path.join(root, 'apps/electron/src/gateway/lifecycle-controller.ts'),
    path.join(root, 'packages/backend/wiring/engine/index.ts'),
  ].filter(file => fs.existsSync(file))
  const requiredCoreSymbols = [
    'CoreConversationRuntime',
    'CoreConversationRuntimeFactoryOptions',
    'CoreConversationSendMessageCommand',
    'CoreSessionRuntime',
    'CoreStreamChannelLike',
    'CoreTextStreamChunk',
    'isCoreConversationRuntime',
    'isCoreTextStreamChunk',
  ]
  const lines = [
    ...(!fs.existsSync(coreFile)
      ? [`${rel(coreFile)}: missing core-owned gateway conversation runtime protocol`]
      : []),
    ...requiredCoreSymbols
      .filter(symbol => !coreContent.includes(symbol))
      .map(symbol => `${rel(coreFile)}: missing core gateway conversation protocol symbol ${symbol}`),
    ...(!corePackageContent.includes('"./gateway-runtime": "./gateway-runtime.ts"')
      ? [`${rel(corePackageFile)}: missing @onething/core/gateway-runtime export`]
      : []),
    ...(!runtimeContent.includes('@onething/core/gateway-runtime')
      ? [`${rel(runtimeFile)}: onething runtime gateway facade must re-export the core protocol`]
      : []),
    ...(!runtimeEntrypointContent.includes('@onething/core/gateway-runtime')
      ? [`${rel(runtimeEntrypointFile)}: onething runtime entrypoint must import gateway protocol types from core`]
      : []),
    ...matchingLines(runtimeEntrypointFile, [
      /type\s+OnethingConversationRuntime/,
      /type\s+OnethingSessionRuntime/,
      /type\s+OnethingStreamChannelLike/,
    ]),
    ...(!runtimeContent.includes('createOnethingConversationRuntimeFromStreamEngine')
      ? [`${rel(runtimeFile)}: onething runtime gateway facade must own an onething-named conversation runtime factory`]
      : []),
    ...matchingLines(runtimeFile, [
      /createCoreStreamConversationRuntime/,
      /CoreStreamConversationRuntimeOptions/,
    ]),
    ...(gatewayPackageContent.includes('"@onething/runtime"')
      ? [`${rel(gatewayPackageFile)}: gateway package must not depend on onething runtime implementation`]
      : []),
    ...(!gatewayPackageContent.includes('"@onething/core"')
      ? [`${rel(gatewayPackageFile)}: gateway package must depend on core protocol types`]
      : []),
    ...gatewayAndHostFiles.flatMap(file => matchingLines(file, [
      /@onething\/runtime\/gateway/,
      /function\s+isOnethingConversationRuntime/,
      /function\s+isCoreTextStreamChunk/,
      /type\s*===\s*['"]text-delta['"]/,
    ])),
  ]

  assertNoMatches('packages/core owns gateway conversation runtime protocol', lines)
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

function checkGatewayOwnsEnablementConfig(): void {
  const gatewayFile = path.join(root, 'packages/gateway/src/index.ts')
  const gatewayConfigFile = path.join(root, 'packages/gateway/src/config.ts')
  const gatewayPackageFile = path.join(root, 'packages/gateway/package.json')
  const electronGatewayFile = path.join(root, 'apps/electron/src/gateway/lifecycle-controller.ts')
  const mainFile = path.join(root, 'packages/backend/gateway/lifecycle.ts')
  const gatewayContent = fs.existsSync(gatewayFile) ? fs.readFileSync(gatewayFile, 'utf-8') : ''
  const gatewayConfigContent = fs.existsSync(gatewayConfigFile) ? fs.readFileSync(gatewayConfigFile, 'utf-8') : ''
  const gatewayPackageContent = fs.existsSync(gatewayPackageFile) ? fs.readFileSync(gatewayPackageFile, 'utf-8') : ''
  const electronGatewayContent = fs.existsSync(electronGatewayFile) ? fs.readFileSync(electronGatewayFile, 'utf-8') : ''
  const requiredGatewaySymbols = [
    'isGatewayEnabledFromEnv',
    'ONETHING_GATEWAY',
    'GATEWAY_ENABLED',
    'GATEWAY_CHANNELS',
    'TELEGRAM_BOT_TOKEN',
  ]
  const lines = [
    ...requiredGatewaySymbols
      .filter(symbol => !gatewayConfigContent.includes(symbol))
      .map(symbol => `${rel(gatewayConfigFile)}: missing gateway-owned enablement config symbol ${symbol}`),
    ...(!gatewayContent.includes('./config.js')
      ? [`${rel(gatewayFile)}: gateway entrypoint must re-export config from the lightweight config module`]
      : []),
    ...(!gatewayPackageContent.includes('"./config": "./src/config.ts"')
      ? [`${rel(gatewayPackageFile)}: missing @onething/gateway/config export`]
      : []),
    ...(!electronGatewayContent.includes('@onething/gateway/config')
      ? [`${rel(electronGatewayFile)}: Electron gateway lifecycle must delegate enablement to @onething/gateway/config`]
      : []),
    ...(fs.existsSync(mainFile)
      ? [`${rel(mainFile)}: remove legacy gateway lifecycle adapter; use @onething/electron-host/gateway/lifecycle directly`]
      : []),
  ]

  assertNoMatches('packages/gateway owns gateway enablement config', lines)
}

function checkElectronHostOwnsGatewayLifecycle(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronGatewayControllerFile = path.join(root, 'apps/electron/src/gateway/lifecycle-controller.ts')
  const electronGatewayFile = path.join(root, 'apps/electron/src/gateway/lifecycle.ts')
  const mainFile = path.join(root, 'packages/backend/gateway/lifecycle.ts')
  const mainGatewayIpcFile = path.join(root, 'apps/electron/src/main/ipc/gateway.ts')
  const mainSettingsIpcFile = path.join(root, 'apps/electron/src/main/ipc/settings.ts')
  const tsconfigNode = path.join(root, 'tsconfig.node.json')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronGatewayControllerContent = fs.existsSync(electronGatewayControllerFile)
    ? fs.readFileSync(electronGatewayControllerFile, 'utf-8')
    : ''
  const electronGatewayContent = fs.existsSync(electronGatewayFile) ? fs.readFileSync(electronGatewayFile, 'utf-8') : ''
  const mainGatewayIpcContent = fs.existsSync(mainGatewayIpcFile) ? fs.readFileSync(mainGatewayIpcFile, 'utf-8') : ''
  const mainSettingsIpcContent = fs.existsSync(mainSettingsIpcFile) ? fs.readFileSync(mainSettingsIpcFile, 'utf-8') : ''
  const tsconfigContent = fs.existsSync(tsconfigNode) ? fs.readFileSync(tsconfigNode, 'utf-8') : ''
  const requiredControllerSymbols = [
    'createElectronGatewayLifecycle',
    'ElectronGatewayLifecycleOptions',
    'startGateway',
    'isGatewayEnabledFromEnv',
    'shutdownGateway',
  ]
  const requiredHostSymbols = [
    'configureGatewayLifecycle',
    'createElectronGatewayLifecycle',
    'initializeGateway',
    'shutdownGateway',
  ]
  const lines = [
    ...(!packageContent.includes('@onething/electron-host')
      ? [`${rel(electronPackage)}: missing @onething/electron-host package`]
      : []),
    ...requiredControllerSymbols
      .filter(symbol => !electronGatewayControllerContent.includes(symbol))
      .map(symbol => `${rel(electronGatewayControllerFile)}: missing Electron-hosted gateway lifecycle controller symbol ${symbol}`),
    ...requiredHostSymbols
      .filter(symbol => !electronGatewayContent.includes(symbol))
      .map(symbol => `${rel(electronGatewayFile)}: missing Electron-hosted gateway lifecycle facade symbol ${symbol}`),
    ...(!mainGatewayIpcContent.includes('@onething/electron-host/gateway/lifecycle')
      ? [`${rel(mainGatewayIpcFile)}: gateway IPC must import lifecycle operations from electron-host directly`]
      : []),
    ...(!mainSettingsIpcContent.includes('@onething/electron-host/gateway/lifecycle')
      ? [`${rel(mainSettingsIpcFile)}: settings IPC must apply gateway settings through electron-host directly`]
      : []),
    ...(mainGatewayIpcContent.includes('./lifecycle')
      ? [`${rel(mainGatewayIpcFile)}: gateway IPC must not import legacy ./lifecycle facade`]
      : []),
    ...(mainSettingsIpcContent.includes('../gateway/lifecycle')
      ? [`${rel(mainSettingsIpcFile)}: settings IPC must not import legacy gateway lifecycle facade`]
      : []),
    ...(!tsconfigContent.includes('apps/electron/**/*')
      ? [`${rel(tsconfigNode)}: missing apps/electron from node typecheck include`]
      : []),
    ...(!fs.readFileSync(path.join(root, 'vitest.config.ts'), 'utf-8').includes('apps/**/*.test.ts')
      ? ['vitest.config.ts: missing apps test include']
      : []),
    ...(fs.existsSync(electronGatewayControllerFile)
      ? matchingLines(electronGatewayControllerFile, ELECTRON_GATEWAY_LIFECYCLE_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/gateway/lifecycle.ts: missing Electron gateway lifecycle owner']),
    ...(fs.existsSync(electronGatewayFile)
      ? matchingLines(electronGatewayFile, ELECTRON_GATEWAY_LIFECYCLE_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/gateway/lifecycle.ts: missing Electron gateway lifecycle facade']),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_GATEWAY_LIFECYCLE_FORBIDDEN_PATTERNS)
      : []),
    ...(fs.existsSync(mainFile)
      ? [`${rel(mainFile)}: remove legacy gateway lifecycle facade; use @onething/electron-host/gateway/lifecycle directly`]
      : []),
  ]

  assertNoMatches('apps/electron owns Electron gateway lifecycle', lines)
}

function checkElectronHostOwnsVoiceRuntimeWindow(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronRuntimeControllerFile = path.join(root, 'apps/electron/src/voice/runtime-window-controller.ts')
  const electronRuntimeFile = path.join(root, 'apps/electron/src/voice/runtime-window.ts')
  const mainRuntimeFile = path.join(root, 'packages/backend/wiring/voice/runtime-window.ts')
  const mainVoiceServiceFile = path.join(root, 'packages/backend/wiring/voice/service.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronRuntimeControllerContent = fs.existsSync(electronRuntimeControllerFile)
    ? fs.readFileSync(electronRuntimeControllerFile, 'utf-8')
    : ''
  const electronRuntimeContent = fs.existsSync(electronRuntimeFile)
    ? fs.readFileSync(electronRuntimeFile, 'utf-8')
    : ''
  const mainVoiceServiceContent = fs.existsSync(mainVoiceServiceFile) ? fs.readFileSync(mainVoiceServiceFile, 'utf-8') : ''
  const requiredControllerSymbols = [
    'createElectronVoiceRuntimeWindowController',
    'new BrowserWindow',
    'loadURL',
    'loadFile',
    'webContents.send',
    'pendingCommands',
    'markReady',
    'flushCommands',
  ]
  const requiredHostFacadeSymbols = [
    'createElectronVoiceRuntimeWindowController',
    'IPC_CHANNELS.VOICE_RUNTIME_COMMAND',
    'getElectronRendererDevUrl',
  ]
  const lines = [
    ...(!packageContent.includes('./voice/runtime-window')
      ? [`${rel(electronPackage)}: missing voice runtime-window export`]
      : []),
    ...requiredControllerSymbols
      .filter(symbol => !electronRuntimeControllerContent.includes(symbol))
      .map(symbol => `${rel(electronRuntimeControllerFile)}: missing Electron voice runtime-window controller symbol ${symbol}`),
    ...requiredHostFacadeSymbols
      .filter(symbol => !electronRuntimeContent.includes(symbol))
      .map(symbol => `${rel(electronRuntimeFile)}: missing Electron voice runtime-window host facade symbol ${symbol}`),
    ...(!mainVoiceServiceContent.includes('runtimeWindow?.')
      ? [`${rel(mainVoiceServiceFile)}: voice service must reach the runtime window via injected host ports`]
      : []),
    ...(mainVoiceServiceContent.includes('@onething/electron-host/')
      ? [`${rel(mainVoiceServiceFile)}: voice service must stay host-agnostic (inject via configureVoiceHost)`]
      : []),
    ...(mainVoiceServiceContent.includes('./runtime-window.js')
      ? [`${rel(mainVoiceServiceFile)}: voice service must not import legacy runtime-window facade`]
      : []),
    ...(fs.existsSync(mainRuntimeFile)
      ? [`${rel(mainRuntimeFile)}: remove legacy voice runtime-window facade; use @onething/electron-host/voice/runtime-window directly`]
      : []),
  ]

  assertNoMatches('apps/electron owns Electron voice runtime window', lines)
}

function checkElectronHostOwnsVoiceEventBroadcasting(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronEventsFile = path.join(root, 'apps/electron/src/voice/events.ts')
  const mainVoiceServiceFile = path.join(root, 'packages/backend/wiring/voice/service.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronEventsContent = fs.existsSync(electronEventsFile) ? fs.readFileSync(electronEventsFile, 'utf-8') : ''
  const mainVoiceServiceContent = fs.existsSync(mainVoiceServiceFile) ? fs.readFileSync(mainVoiceServiceFile, 'utf-8') : ''
  const requiredHostSymbols = [
    'broadcastElectronVoiceMessage',
    'sendElectronVoiceMessageToWindow',
    'getElectronWebContentsId',
    'BrowserWindow.getAllWindows',
    'webContents.send',
  ]
  // Voice pushes go through main/voice/host-ports (configureVoiceHost);
  // the Electron impls are wired in app/main-process.ts.
  const requiredFacadeSymbols = [
    'broadcastVoiceHostMessage',
    'sendVoiceHostMessageToWindow',
  ]
  const lines = [
    ...(!packageContent.includes('./voice/events')
      ? [`${rel(electronPackage)}: missing voice events export`]
      : []),
    ...requiredHostSymbols
      .filter(symbol => !electronEventsContent.includes(symbol))
      .map(symbol => `${rel(electronEventsFile)}: missing Electron voice event symbol ${symbol}`),
    ...requiredFacadeSymbols
      .filter(symbol => !mainVoiceServiceContent.includes(symbol))
      .map(symbol => `${rel(mainVoiceServiceFile)}: missing voice event facade delegation ${symbol}`),
    ...(fs.existsSync(mainVoiceServiceFile)
      ? matchingLines(mainVoiceServiceFile, VOICE_EVENT_BROADCAST_FORBIDDEN_PATTERNS)
      : ['packages/backend/wiring/voice/service.ts: missing voice service']),
  ]

  assertNoMatches('apps/electron owns Electron voice event broadcasting', lines)
}

function checkElectronHostOwnsVoiceTray(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronTrayControllerFile = path.join(root, 'apps/electron/src/voice/tray-controller.ts')
  const electronTrayFile = path.join(root, 'apps/electron/src/voice/tray.ts')
  const electronMainFile = path.join(root, 'apps/electron/src/app/main-process.ts')
  const mainTrayFile = path.join(root, 'packages/backend/wiring/voice/tray.ts')
  const mainVoiceServiceFile = path.join(root, 'packages/backend/wiring/voice/service.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronTrayControllerContent = fs.existsSync(electronTrayControllerFile)
    ? fs.readFileSync(electronTrayControllerFile, 'utf-8')
    : ''
  const electronTrayContent = fs.existsSync(electronTrayFile) ? fs.readFileSync(electronTrayFile, 'utf-8') : ''
  const electronMainContent = fs.existsSync(electronMainFile) ? fs.readFileSync(electronMainFile, 'utf-8') : ''
  const mainVoiceServiceContent = fs.existsSync(mainVoiceServiceFile) ? fs.readFileSync(mainVoiceServiceFile, 'utf-8') : ''
  const requiredControllerSymbols = [
    'createElectronVoiceTrayController',
    'new Tray',
    'Menu.buildFromTemplate',
    'nativeImage.createFromPath',
    'nativeImage.createEmpty',
    'app.quit',
    'shouldHideMainWindowForVoice',
  ]
  const requiredHostFacadeSymbols = [
    'createElectronVoiceTrayController',
    'configureVoiceTray',
    'getIconPath',
  ]
  const lines = [
    ...(!packageContent.includes('./voice/tray')
      ? [`${rel(electronPackage)}: missing voice tray export`]
      : []),
    ...requiredControllerSymbols
      .filter(symbol => !electronTrayControllerContent.includes(symbol))
      .map(symbol => `${rel(electronTrayControllerFile)}: missing Electron voice tray controller symbol ${symbol}`),
    ...requiredHostFacadeSymbols
      .filter(symbol => !electronTrayContent.includes(symbol))
      .map(symbol => `${rel(electronTrayFile)}: missing Electron voice tray host facade symbol ${symbol}`),
    ...(electronTrayContent.includes('@main/')
      ? [`${rel(electronTrayFile)}: Electron voice tray host must not import @main runtime modules`]
      : []),
    ...(!electronMainContent.includes('configureVoiceTray')
      ? [`${rel(electronMainFile)}: Electron app bootstrap must configure voice tray from runtime settings`]
      : []),
    ...(!electronMainContent.includes('getSettings().voice')
      ? [`${rel(electronMainFile)}: Electron app bootstrap must inject voice settings into electron-host tray`]
      : []),
    ...(!electronMainContent.includes('getVoiceServiceSafe()?.shutdown')
      ? [`${rel(electronMainFile)}: Electron app bootstrap must inject voice shutdown into electron-host tray`]
      : []),
    ...(!mainVoiceServiceContent.includes('updateTray?.')
      ? [`${rel(mainVoiceServiceFile)}: voice service must reach the tray via injected host ports`]
      : []),
    ...(mainVoiceServiceContent.includes('./tray.js')
      ? [`${rel(mainVoiceServiceFile)}: voice service must not import legacy voice tray facade`]
      : []),
    ...(fs.existsSync(mainTrayFile)
      ? [`${rel(mainTrayFile)}: remove legacy voice tray facade; use @onething/electron-host/voice/tray directly`]
      : []),
  ]

  assertNoMatches('apps/electron owns Electron voice tray', lines)
}

function checkElectronHostOwnsVoiceIpcHost(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronVoiceIpcFile = path.join(root, 'apps/electron/src/voice/ipc.ts')
  const mainVoiceIpcFile = path.join(root, 'apps/electron/src/main/ipc/voice.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronVoiceIpcContent = fs.existsSync(electronVoiceIpcFile)
    ? fs.readFileSync(electronVoiceIpcFile, 'utf-8')
    : ''
  const mainVoiceIpcContent = fs.existsSync(mainVoiceIpcFile) ? fs.readFileSync(mainVoiceIpcFile, 'utf-8') : ''
  const requiredHostSymbols = [
    'registerElectronVoiceIpcHandlers',
    'options.ipcMain ?? ipcMain',
    'host.handle',
    'ElectronVoiceIpcChannels',
    'ElectronVoiceIpcInvokeEvent',
    'options.runtimeReady((event as ElectronVoiceIpcInvokeEvent).sender)',
  ]
  const requiredFacadeSymbols = [
    '@onething/electron-host/voice/ipc',
    'registerElectronVoiceIpcHandlers',
    'IPC_CHANNELS.VOICE_GET_STATE',
    'IPC_CHANNELS.VOICE_START',
    'IPC_CHANNELS.VOICE_STOP',
    'IPC_CHANNELS.VOICE_SUBMIT_UTTERANCE',
    'IPC_CHANNELS.VOICE_SUBMIT_TRANSCRIPT',
    'IPC_CHANNELS.VOICE_SYNTHESIZE',
    'IPC_CHANNELS.VOICE_TEST_ASR',
    'IPC_CHANNELS.VOICE_TEST_TTS',
    'IPC_CHANNELS.VOICE_GET_TTS_MODELS',
    'IPC_CHANNELS.VOICE_RUNTIME_READY',
    'IPC_CHANNELS.VOICE_RUNTIME_EVENT',
  ]
  const lines = [
    ...(!packageContent.includes('./voice/ipc')
      ? [`${rel(electronPackage)}: missing voice IPC host export`]
      : []),
    ...requiredHostSymbols
      .filter(symbol => !electronVoiceIpcContent.includes(symbol))
      .map(symbol => `${rel(electronVoiceIpcFile)}: missing Electron voice IPC host symbol ${symbol}`),
    ...requiredFacadeSymbols
      .filter(symbol => !mainVoiceIpcContent.includes(symbol))
      .map(symbol => `${rel(mainVoiceIpcFile)}: missing voice IPC host delegation ${symbol}`),
    ...(fs.existsSync(mainVoiceIpcFile)
      ? matchingLines(mainVoiceIpcFile, MAIN_VOICE_IPC_HOST_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/main/ipc/voice.ts: missing voice IPC adapter']),
  ]

  assertNoMatches('apps/electron owns Electron voice IPC host operations', lines)
}

function checkElectronHostOwnsReadyHandler(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronReadyFile = path.join(root, 'apps/electron/src/app/ready.ts')
  const electronLoginShellEnvFile = path.join(root, 'apps/electron/src/app/login-shell-env.ts')
  const electronLoginShellEnvTestFile = path.join(root, 'apps/electron/src/app/__tests__/login-shell-env.test.ts')
  const mainFile = path.join(root, 'apps/electron/src/app/main-process.ts')
  const legacyLoginShellEnvFile = path.join(root, 'packages/backend/utils/login-shell-env.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronReadyContent = fs.existsSync(electronReadyFile) ? fs.readFileSync(electronReadyFile, 'utf-8') : ''
  const electronLoginShellEnvContent = fs.existsSync(electronLoginShellEnvFile) ? fs.readFileSync(electronLoginShellEnvFile, 'utf-8') : ''
  const electronLoginShellEnvTestContent = fs.existsSync(electronLoginShellEnvTestFile) ? fs.readFileSync(electronLoginShellEnvTestFile, 'utf-8') : ''
  const legacyLoginShellEnvContent = fs.existsSync(legacyLoginShellEnvFile) ? fs.readFileSync(legacyLoginShellEnvFile, 'utf-8') : ''
  const mainContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf-8') : ''
  const requiredReadySymbols = [
    'configureElectronStorePathHost',
    'registerElectronReadyHandler',
    'runElectronReady',
    'hydratePackagedEnvironment',
    'acquireDesktopStoreLock',
    'formatDesktopStoreLockError',
    'showErrorBox',
    'electronApp.quit',
  ]
  const requiredLoginShellEnvSymbols = [
    'hydrateProcessEnvFromLoginShell',
    'parseLoginShellEnvOutput',
    'mergeMissingEnv',
    'spawn(',
  ]
  const lines = [
    ...(!packageContent.includes('./app/ready')
      ? [`${rel(electronPackage)}: missing ready export`]
      : []),
    ...(!packageContent.includes('./app/login-shell-env')
      ? [`${rel(electronPackage)}: missing login-shell-env export`]
      : []),
    ...requiredReadySymbols
      .filter(symbol => !electronReadyContent.includes(symbol))
      .map(symbol => `${rel(electronReadyFile)}: missing Electron ready symbol ${symbol}`),
    ...requiredLoginShellEnvSymbols
      .filter(symbol => !electronLoginShellEnvContent.includes(symbol))
      .map(symbol => `${rel(electronLoginShellEnvFile)}: missing Electron login-shell env symbol ${symbol}`),
    ...(!electronLoginShellEnvTestContent.includes('login shell environment helpers')
      ? [`${rel(electronLoginShellEnvTestFile)}: missing Electron login-shell env test coverage`]
      : []),
    ...(fs.existsSync(legacyLoginShellEnvFile)
      ? [`${rel(legacyLoginShellEnvFile)}: legacy login-shell env facade was removed; import @onething/electron-host/app/login-shell-env directly`]
      : []),
    ...(!mainContent.includes('configureElectronStorePathHost({ configureStorePathHost })')
      && !mainContent.includes('registerElectronAppBootstrap')
      ? [`${rel(mainFile)}: main must delegate store path host configuration to apps/electron`]
      : []),
    ...(!mainContent.includes('@onething/electron-host/app/login-shell-env')
      ? [`${rel(mainFile)}: main must import login-shell env hydration from apps/electron host`]
      : []),
    ...(!mainContent.includes('registerElectronReadyHandler')
      && !mainContent.includes('registerElectronAppBootstrap')
      ? [`${rel(mainFile)}: main must delegate ready handling to apps/electron`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_READY_FORBIDDEN_PATTERNS)
      : ['packages/backend/index.ts: missing Electron main entry']),
  ]

  assertNoMatches('apps/electron owns Electron ready handler', lines)
}

function checkElectronHostOwnsActivateHandler(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronActivateFile = path.join(root, 'apps/electron/src/app/activate.ts')
  const mainFile = path.join(root, 'apps/electron/src/app/main-process.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronActivateContent = fs.existsSync(electronActivateFile) ? fs.readFileSync(electronActivateFile, 'utf-8') : ''
  const mainContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf-8') : ''
  const singleQuoteActivateStart = mainContent.indexOf("app.on('activate'")
  const doubleQuoteActivateStart = mainContent.indexOf('app.on("activate"')
  const legacyActivateStart = singleQuoteActivateStart >= 0 ? singleQuoteActivateStart : doubleQuoteActivateStart
  const legacyActivateLineOffset = legacyActivateStart >= 0
    ? mainContent.slice(0, legacyActivateStart).split(/\r?\n/).length - 1
    : 0
  const requiredActivateSymbols = [
    'registerElectronActivateHandler',
    'handleElectronActivate',
    'createAndBindElectronMainWindow',
    'shouldSuppressMainWindowActivation',
    'initializeIPCBridge',
    'bindStreamEngine',
    'warmTodoPlanWindow',
    'activateMainWindow',
  ]
  const lines = [
    ...(!packageContent.includes('./app/activate')
      ? [`${rel(electronPackage)}: missing activate export`]
      : []),
    ...requiredActivateSymbols
      .filter(symbol => !electronActivateContent.includes(symbol))
      .map(symbol => `${rel(electronActivateFile)}: missing Electron activate symbol ${symbol}`),
    ...(!mainContent.includes('registerElectronActivateHandler')
      && !mainContent.includes('registerElectronAppBootstrap')
      ? [`${rel(mainFile)}: main must delegate activate handling to apps/electron`]
      : []),
    ...(fs.existsSync(mainFile) && legacyActivateStart >= 0
      ? matchingTextLines(rel(mainFile), mainContent.slice(legacyActivateStart), MAIN_ACTIVATE_FORBIDDEN_PATTERNS, legacyActivateLineOffset)
      : []),
    ...(!fs.existsSync(mainFile)
      ? ['packages/backend/index.ts: missing Electron main entry']
      : []),
  ]

  assertNoMatches('apps/electron owns Electron activate handler', lines)
}

function checkElectronHostOwnsMainWindowBinding(): void {
  const mainFile = path.join(root, 'apps/electron/src/app/main-process.ts')
  const mainContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf-8') : ''
  const lines = [
    ...(!mainContent.includes('createAndBindElectronMainWindow(createElectronMainWindowOptions())')
      && !mainContent.includes('registerElectronAppBootstrap')
      ? [`${rel(mainFile)}: ready startup must use apps/electron main-window binding helper`]
      : []),
    ...(!mainContent.includes('registerElectronActivateHandler(createElectronMainWindowOptions())')
      && !mainContent.includes('registerElectronAppBootstrap')
      ? [`${rel(mainFile)}: activate handler must reuse the same apps/electron main-window binding options`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_WINDOW_BINDING_FORBIDDEN_PATTERNS)
      : ['packages/backend/index.ts: missing Electron main entry']),
  ]

  assertNoMatches('apps/electron owns Electron main-window binding', lines)
}

function checkElectronHostOwnsApplicationMenu(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronMenuFile = path.join(root, 'apps/electron/src/menu/application-menu.ts')
  const windowFile = path.join(root, 'apps/electron/src/window/index.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronMenuContent = fs.existsSync(electronMenuFile) ? fs.readFileSync(electronMenuFile, 'utf-8') : ''
  const windowContent = fs.existsSync(windowFile) ? fs.readFileSync(windowFile, 'utf-8') : ''
  const requiredMenuSymbols = [
    'setupElectronApplicationMenu',
    'ElectronApplicationMenuOptions',
    'buildFromTemplate',
    'setApplicationMenu',
    'openSettingsWindow',
    'menu:new-chat',
  ]
  // 08-21:原断言要求 `window/index.ts` 里逐字出现
  // `setupElectronApplicationMenu({ mainWindow, openSettingsWindow })`。真实调用早已
  // 是多行形态(还传 browser / webPreview 两组回调),字面量断言过期。语义收窄为
  // "调用存在,且 mainWindow / openSettingsWindow 这两个参数确实传了进去"。
  const menuDelegationFragments = ['setupElectronApplicationMenu(', 'mainWindow,', 'openSettingsWindow']
  const menuDelegationMissing = menuDelegationFragments.some(fragment => !windowContent.includes(fragment))
  const lines = [
    ...(!packageContent.includes('./menu/application-menu')
      ? [`${rel(electronPackage)}: missing application menu export`]
      : []),
    ...requiredMenuSymbols
      .filter(symbol => !electronMenuContent.includes(symbol))
      .map(symbol => `${rel(electronMenuFile)}: missing Electron application-menu symbol ${symbol}`),
    ...(menuDelegationMissing
      ? [`${rel(windowFile)}: window creation must delegate application menu setup to apps/electron`]
      : []),
    ...(fs.existsSync(windowFile)
      ? matchingLines(windowFile, WINDOW_APPLICATION_MENU_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/window/index.ts: missing Electron window module']),
  ]

  assertNoMatches('apps/electron owns Electron application menu', lines)
}

function checkElectronHostOwnsSessionSecurity(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronSessionFile = path.join(root, 'apps/electron/src/window/session-security.ts')
  const windowFile = path.join(root, 'apps/electron/src/window/index.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronSessionContent = fs.existsSync(electronSessionFile) ? fs.readFileSync(electronSessionFile, 'utf-8') : ''
  const windowContent = fs.existsSync(windowFile) ? fs.readFileSync(windowFile, 'utf-8') : ''
  const requiredSessionSymbols = [
    'registerElectronContentSecurityPolicy',
    'registerElectronMediaPermissions',
    'onHeadersReceived',
    'Content-Security-Policy',
    'setPermissionRequestHandler',
    'setPermissionCheckHandler',
  ]
  const lines = [
    ...(!packageContent.includes('./window/session-security')
      ? [`${rel(electronPackage)}: missing session-security export`]
      : []),
    ...requiredSessionSymbols
      .filter(symbol => !electronSessionContent.includes(symbol))
      .map(symbol => `${rel(electronSessionFile)}: missing Electron session-security symbol ${symbol}`),
    ...(!windowContent.includes('registerElectronContentSecurityPolicy()')
      ? [`${rel(windowFile)}: window creation must delegate CSP setup to apps/electron`]
      : []),
    ...(!windowContent.includes('registerElectronMediaPermissions({')
      ? [`${rel(windowFile)}: window creation must delegate media permissions to apps/electron`]
      : []),
    ...(!windowContent.includes('isElectronAppWebContents')
      ? [`${rel(windowFile)}: media permission webContents checks must delegate to apps/electron renderer targets`]
      : []),
    ...(fs.existsSync(windowFile)
      ? matchingLines(windowFile, WINDOW_SESSION_SECURITY_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/window/index.ts: missing Electron window module']),
  ]

  assertNoMatches('apps/electron owns Electron session security', lines)
}

function checkElectronHostOwnsExternalLinkHandling(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronExternalLinksFile = path.join(root, 'apps/electron/src/window/external-links.ts')
  const windowFile = path.join(root, 'apps/electron/src/window/index.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronExternalLinksContent = fs.existsSync(electronExternalLinksFile) ? fs.readFileSync(electronExternalLinksFile, 'utf-8') : ''
  const windowContent = fs.existsSync(windowFile) ? fs.readFileSync(windowFile, 'utf-8') : ''
  const requiredExternalLinkSymbols = [
    'setupElectronExternalLinkHandling',
    'openExternal',
    'will-navigate',
    'setWindowOpenHandler',
    'isAppUrl',
    "action: 'deny'",
  ]
  const lines = [
    ...(!packageContent.includes('./window/external-links')
      ? [`${rel(electronPackage)}: missing external-links export`]
      : []),
    ...requiredExternalLinkSymbols
      .filter(symbol => !electronExternalLinksContent.includes(symbol))
      .map(symbol => `${rel(electronExternalLinksFile)}: missing Electron external-links symbol ${symbol}`),
    ...(!windowContent.includes('setupElectronExternalLinkHandling({')
      ? [`${rel(windowFile)}: window creation must delegate external-link handling to apps/electron`]
      : []),
    ...(fs.existsSync(windowFile)
      ? matchingLines(windowFile, WINDOW_EXTERNAL_LINKS_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/window/index.ts: missing Electron window module']),
  ]

  assertNoMatches('apps/electron owns Electron external-link handling', lines)
}

function checkElectronHostOwnsMainWindowRecovery(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronRecoveryFile = path.join(root, 'apps/electron/src/window/main-window-recovery.ts')
  const windowFile = path.join(root, 'apps/electron/src/window/index.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronRecoveryContent = fs.existsSync(electronRecoveryFile) ? fs.readFileSync(electronRecoveryFile, 'utf-8') : ''
  const windowContent = fs.existsSync(windowFile) ? fs.readFileSync(windowFile, 'utf-8') : ''
  const requiredRecoverySymbols = [
    'attachElectronMainWindowRecovery',
    'recoverElectronMainWindowAfterSystemResume',
    'reloadElectronMainWindowRenderer',
    'getElectronMainWindowRendererHealth',
    'MAIN_WINDOW_RESUME_HEALTH_CHECK_DELAY_MS',
    'did-fail-load',
    'render-process-gone',
  ]
  const lines = [
    ...(!packageContent.includes('./window/main-window-recovery')
      ? [`${rel(electronPackage)}: missing main-window-recovery export`]
      : []),
    ...requiredRecoverySymbols
      .filter(symbol => !electronRecoveryContent.includes(symbol))
      .map(symbol => `${rel(electronRecoveryFile)}: missing Electron main-window-recovery symbol ${symbol}`),
    ...(!windowContent.includes('attachElectronMainWindowRecovery({ mainWindow, loadMainWindowContent })')
      ? [`${rel(windowFile)}: main window creation must delegate renderer recovery to apps/electron`]
      : []),
    ...(!windowContent.includes('recoverElectronMainWindowAfterSystemResume({')
      ? [`${rel(windowFile)}: resume recovery must delegate renderer recovery to apps/electron`]
      : []),
    ...(fs.existsSync(windowFile)
      ? matchingLines(windowFile, WINDOW_MAIN_RECOVERY_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/window/index.ts: missing Electron window module']),
  ]

  assertNoMatches('apps/electron owns Electron main-window renderer recovery', lines)
}

function checkElectronHostOwnsSettingsWindow(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronSettingsFile = path.join(root, 'apps/electron/src/window/settings-window.ts')
  const windowFile = path.join(root, 'apps/electron/src/window/index.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronSettingsContent = fs.existsSync(electronSettingsFile) ? fs.readFileSync(electronSettingsFile, 'utf-8') : ''
  const windowContent = fs.existsSync(windowFile) ? fs.readFileSync(windowFile, 'utf-8') : ''
  const settingsStart = windowContent.indexOf('export function openSettingsWindow')
  const settingsEnd = windowContent.indexOf('export function openTodoPlanWindow', settingsStart)
  const settingsRegion = settingsStart >= 0 && settingsEnd > settingsStart
    ? windowContent.slice(settingsStart, settingsEnd)
    : ''
  const settingsLineOffset = settingsStart >= 0
    ? windowContent.slice(0, settingsStart).split(/\r?\n/).length - 1
    : 0
  const requiredSettingsSymbols = [
    'openElectronSettingsWindow',
    'BrowserWindow',
    'ready-to-show',
    'setCurrentWindow',
    '#/settings',
    'did-fail-load',
  ]
  const lines = [
    ...(!packageContent.includes('./window/settings-window')
      ? [`${rel(electronPackage)}: missing settings-window export`]
      : []),
    ...requiredSettingsSymbols
      .filter(symbol => !electronSettingsContent.includes(symbol))
      .map(symbol => `${rel(electronSettingsFile)}: missing Electron settings-window symbol ${symbol}`),
    ...(!windowContent.includes('openElectronSettingsWindow({')
      ? [`${rel(windowFile)}: settings window must delegate BrowserWindow setup to apps/electron`]
      : []),
    ...(settingsRegion
      ? matchingTextLines(rel(windowFile), settingsRegion, WINDOW_SETTINGS_WINDOW_FORBIDDEN_PATTERNS, settingsLineOffset)
      : [`${rel(windowFile)}: missing openSettingsWindow region`]),
  ]

  assertNoMatches('apps/electron owns Electron settings window', lines)
}

function checkElectronHostOwnsImagePreviewWindow(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronImagePreviewFile = path.join(root, 'apps/electron/src/window/image-preview-window.ts')
  const windowFile = path.join(root, 'apps/electron/src/window/index.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronImagePreviewContent = fs.existsSync(electronImagePreviewFile) ? fs.readFileSync(electronImagePreviewFile, 'utf-8') : ''
  const windowContent = fs.existsSync(windowFile) ? fs.readFileSync(windowFile, 'utf-8') : ''
  const previewStart = windowContent.indexOf('export function openImagePreviewWindow')
  const previewRegion = previewStart >= 0
    ? windowContent.slice(previewStart)
    : ''
  const previewLineOffset = previewStart >= 0
    ? windowContent.slice(0, previewStart).split(/\r?\n/).length - 1
    : 0
  const requiredPreviewSymbols = [
    'openElectronImagePreviewWindow',
    'BrowserWindow',
    'dom-ready',
    'ready-to-show',
    'setCurrentWindow',
    'updateChannel',
    'routeHash',
  ]
  const lines = [
    ...(!packageContent.includes('./window/image-preview-window')
      ? [`${rel(electronPackage)}: missing image-preview-window export`]
      : []),
    ...requiredPreviewSymbols
      .filter(symbol => !electronImagePreviewContent.includes(symbol))
      .map(symbol => `${rel(electronImagePreviewFile)}: missing Electron image-preview-window symbol ${symbol}`),
    ...(!windowContent.includes('openElectronImagePreviewWindow({')
      ? [`${rel(windowFile)}: image preview window must delegate BrowserWindow setup to apps/electron`]
      : []),
    ...(previewRegion
      ? matchingTextLines(rel(windowFile), previewRegion, WINDOW_IMAGE_PREVIEW_WINDOW_FORBIDDEN_PATTERNS, previewLineOffset)
      : [`${rel(windowFile)}: missing openImagePreviewWindow region`]),
  ]

  assertNoMatches('apps/electron owns Electron image preview window', lines)
}

function checkElectronHostOwnsMainWindowCreation(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronMainWindowFile = path.join(root, 'apps/electron/src/window/main-window.ts')
  const windowFile = path.join(root, 'apps/electron/src/window/index.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronMainWindowContent = fs.existsSync(electronMainWindowFile) ? fs.readFileSync(electronMainWindowFile, 'utf-8') : ''
  const windowContent = fs.existsSync(windowFile) ? fs.readFileSync(windowFile, 'utf-8') : ''
  const createStart = windowContent.indexOf('export function createWindow')
  const createEnd = windowContent.indexOf('// Keep track of the image preview window', createStart)
  const createRegion = createStart >= 0 && createEnd > createStart
    ? windowContent.slice(createStart, createEnd)
    : ''
  const createLineOffset = createStart >= 0
    ? windowContent.slice(0, createStart).split(/\r?\n/).length - 1
    : 0
  const requiredMainWindowSymbols = [
    'createElectronMainWindow',
    'BrowserWindow',
    'ready-to-show',
    'shouldSuppressActivation',
    'shouldHideForVoice',
    'saveWindowState',
    'openDevTools',
  ]
  const lines = [
    ...(!packageContent.includes('./window/main-window')
      ? [`${rel(electronPackage)}: missing main-window export`]
      : []),
    ...requiredMainWindowSymbols
      .filter(symbol => !electronMainWindowContent.includes(symbol))
      .map(symbol => `${rel(electronMainWindowFile)}: missing Electron main-window symbol ${symbol}`),
    ...(!windowContent.includes('createElectronMainWindow({')
      ? [`${rel(windowFile)}: main window must delegate BrowserWindow setup to apps/electron`]
      : []),
    ...(createRegion
      ? matchingTextLines(rel(windowFile), createRegion, WINDOW_MAIN_WINDOW_FORBIDDEN_PATTERNS, createLineOffset)
      : [`${rel(windowFile)}: missing createWindow region`]),
  ]

  assertNoMatches('apps/electron owns Electron main window creation', lines)
}

function checkElectronHostOwnsTodoPlanWindowCreation(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronTodoFile = path.join(root, 'apps/electron/src/window/todo-plan-window.ts')
  const windowFile = path.join(root, 'apps/electron/src/window/index.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronTodoContent = fs.existsSync(electronTodoFile) ? fs.readFileSync(electronTodoFile, 'utf-8') : ''
  const windowContent = fs.existsSync(windowFile) ? fs.readFileSync(windowFile, 'utf-8') : ''
  const todoStart = windowContent.indexOf('function createTodoPlanBrowserWindow')
  const todoEnd = windowContent.indexOf('export function openSettingsWindow', todoStart)
  const todoRegion = todoStart >= 0 && todoEnd > todoStart
    ? windowContent.slice(todoStart, todoEnd)
    : ''
  const todoLineOffset = todoStart >= 0
    ? windowContent.slice(0, todoStart).split(/\r?\n/).length - 1
    : 0
  const requiredTodoSymbols = [
    'createElectronTodoPlanWindow',
    'BrowserWindow',
    'ready-to-show',
    'onCreated',
    'onReadyToShow',
    'routeHash',
  ]
  const lines = [
    ...(!packageContent.includes('./window/todo-plan-window')
      ? [`${rel(electronPackage)}: missing todo-plan-window export`]
      : []),
    ...requiredTodoSymbols
      .filter(symbol => !electronTodoContent.includes(symbol))
      .map(symbol => `${rel(electronTodoFile)}: missing Electron todo-plan-window symbol ${symbol}`),
    ...(!windowContent.includes('createElectronTodoPlanWindow({')
      ? [`${rel(windowFile)}: todo plan window must delegate BrowserWindow setup to apps/electron`]
      : []),
    ...(todoRegion
      ? matchingTextLines(rel(windowFile), todoRegion, WINDOW_TODO_PLAN_WINDOW_FORBIDDEN_PATTERNS, todoLineOffset)
      : [`${rel(windowFile)}: missing createTodoPlanBrowserWindow region`]),
  ]

  assertNoMatches('apps/electron owns Electron todo plan window creation', lines)
}

function checkElectronHostOwnsMacOSPanelBridge(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronPanelFile = path.join(root, 'apps/electron/src/window/macos-panel.ts')
  const legacyPanelFile = path.join(root, 'packages/backend/native/macos-panel.ts')
  const windowFile = path.join(root, 'apps/electron/src/window/index.ts')
  const todoWindowTestFile = path.join(root, 'apps/electron/src/main/__tests__/todo-plan-window.test.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronPanelContent = fs.existsSync(electronPanelFile) ? fs.readFileSync(electronPanelFile, 'utf-8') : ''
  const windowContent = fs.existsSync(windowFile) ? fs.readFileSync(windowFile, 'utf-8') : ''
  const todoWindowTestContent = fs.existsSync(todoWindowTestFile) ? fs.readFileSync(todoWindowTestFile, 'utf-8') : ''
  const requiredPanelSymbols = [
    'configureNonActivatingPanel',
    'showNonActivatingPanel',
    'hideNonActivatingPanel',
    'isNonActivatingPanelFrontmost',
    'setNonActivatingPanelPinned',
    'createRequire',
    'process.resourcesPath',
    'getNativeWindowHandle',
  ]
  const lines = [
    ...(!packageContent.includes('./window/macos-panel')
      ? [`${rel(electronPackage)}: missing macOS panel export`]
      : []),
    ...requiredPanelSymbols
      .filter(symbol => !electronPanelContent.includes(symbol))
      .map(symbol => `${rel(electronPanelFile)}: missing Electron macOS panel bridge symbol ${symbol}`),
    ...(!windowContent.includes('@onething/electron-host/window/macos-panel')
      ? [`${rel(windowFile)}: window facade must import macOS panel bridge from apps/electron`]
      : []),
    ...(!todoWindowTestContent.includes('@onething/electron-host/window/macos-panel')
      ? [`${rel(todoWindowTestFile)}: todo plan window test must mock the electron-host macOS panel bridge`]
      : []),
    ...(fs.existsSync(legacyPanelFile)
      ? [`${rel(legacyPanelFile)}: macOS native panel bridge belongs in apps/electron`]
      : []),
    ...(fs.existsSync(windowFile)
      ? matchingLines(windowFile, WINDOW_MACOS_PANEL_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/window/index.ts: missing Electron window module']),
    ...(fs.existsSync(todoWindowTestFile)
      ? matchingLines(todoWindowTestFile, WINDOW_MACOS_PANEL_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/main/__tests__/todo-plan-window.test.ts: missing todo plan window test']),
  ]

  assertNoMatches('apps/electron owns Electron macOS native panel bridge', lines)
}

function checkElectronHostOwnsRendererTargets(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronTargetsFile = path.join(root, 'apps/electron/src/window/renderer-targets.ts')
  const windowFile = path.join(root, 'apps/electron/src/window/index.ts')
  const searchTargetFile = path.join(root, 'packages/backend/wiring/search/window-target.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronTargetsContent = fs.existsSync(electronTargetsFile) ? fs.readFileSync(electronTargetsFile, 'utf-8') : ''
  const windowContent = fs.existsSync(windowFile) ? fs.readFileSync(windowFile, 'utf-8') : ''
  const requiredTargetSymbols = [
    'getElectronRendererDevUrl',
    'isElectronRendererWindowUrl',
    'isElectronMainAppWindowUrl',
    'isElectronAppWebContents',
    'loadElectronMainWindowContent',
    'AUXILIARY_HASH_PREFIXES',
  ]
  const lines = [
    ...(!packageContent.includes('./window/renderer-targets')
      ? [`${rel(electronPackage)}: missing renderer-targets export`]
      : []),
    ...requiredTargetSymbols
      .filter(symbol => !electronTargetsContent.includes(symbol))
      .map(symbol => `${rel(electronTargetsFile)}: missing Electron renderer target symbol ${symbol}`),
    ...(!windowContent.includes('loadElectronMainWindowContent')
      ? [`${rel(windowFile)}: main window content loading must delegate to apps/electron`]
      : []),
    ...(!windowContent.includes('isElectronAppWebContents')
      ? [`${rel(windowFile)}: app webContents checks must delegate to apps/electron`]
      : []),
    ...(windowContent.includes('@main/search/window-target')
      ? [`${rel(windowFile)}: main window must not route renderer-target checks through packages/backend/wiring/search/window-target.ts`]
      : []),
    ...(fs.existsSync(windowFile)
      ? matchingLines(windowFile, WINDOW_RENDERER_TARGETS_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/window/index.ts: missing Electron window module']),
    ...(fs.existsSync(searchTargetFile)
      ? [`${rel(searchTargetFile)}: remove legacy search window target facade; use @onething/electron-host/window/renderer-targets directly`]
      : []),
  ]

  assertNoMatches('apps/electron owns Electron renderer URL targets and main window content loading', lines)
}

function checkElectronHostOwnsSearchWindowLifecycle(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronSearchWindowControllerFile = path.join(root, 'apps/electron/src/window/search-window.ts')
  const electronSearchWindowFile = path.join(root, 'apps/electron/src/search/window.ts')
  const searchWindowFile = path.join(root, 'packages/backend/wiring/search/window.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronSearchWindowControllerContent = fs.existsSync(electronSearchWindowControllerFile)
    ? fs.readFileSync(electronSearchWindowControllerFile, 'utf-8')
    : ''
  const electronSearchWindowContent = fs.existsSync(electronSearchWindowFile)
    ? fs.readFileSync(electronSearchWindowFile, 'utf-8')
    : ''
  const requiredSearchWindowControllerSymbols = [
    'createElectronSearchWindowController',
    'getElectronSystemShouldUseDarkColors',
    'new BrowserWindow',
    'ready-to-show',
    'webContents.send',
    'loadURL',
    'loadFile',
  ]
  const requiredHostFacadeSymbols = [
    'createElectronSearchWindowController',
    'getElectronSystemShouldUseDarkColors',
    'getSearchWindowVisualOptions',
  ]
  const lines = [
    ...(!packageContent.includes('./window/search-window')
      ? [`${rel(electronPackage)}: missing search-window export`]
      : []),
    ...(!packageContent.includes('./search/window')
      ? [`${rel(electronPackage)}: missing search window aggregate export`]
      : []),
    ...requiredSearchWindowControllerSymbols
      .filter(symbol => !electronSearchWindowControllerContent.includes(symbol))
      .map(symbol => `${rel(electronSearchWindowControllerFile)}: missing Electron search-window symbol ${symbol}`),
    ...requiredHostFacadeSymbols
      .filter(symbol => !electronSearchWindowContent.includes(symbol))
      .map(symbol => `${rel(electronSearchWindowFile)}: missing onething search-window host facade symbol ${symbol}`),
    ...(fs.existsSync(searchWindowFile)
      ? [`${rel(searchWindowFile)}: remove legacy search window facade; use @onething/electron-host/search/window directly`]
      : []),
  ]

  assertNoMatches('apps/electron owns Electron search window lifecycle', lines)
}

function checkElectronHostOwnsSearchWindowActionDelivery(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronSearchActionsFile = path.join(root, 'apps/electron/src/search/window-actions.ts')
  const electronSearchControllerFile = path.join(root, 'apps/electron/src/search/window-controller.ts')
  const electronSearchIpcFile = path.join(root, 'apps/electron/src/search/ipc.ts')
  const legacySelectionFile = path.join(root, 'packages/backend/wiring/search/window-selection.ts')
  const searchControllerFile = path.join(root, 'packages/backend/wiring/search/window-controller.ts')
  const searchIpcFile = path.join(root, 'packages/backend/wiring/search/ipc.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronSearchActionsContent = fs.existsSync(electronSearchActionsFile)
    ? fs.readFileSync(electronSearchActionsFile, 'utf-8')
    : ''
  const electronSearchControllerContent = fs.existsSync(electronSearchControllerFile)
    ? fs.readFileSync(electronSearchControllerFile, 'utf-8')
    : ''
  const electronSearchIpcContent = fs.existsSync(electronSearchIpcFile)
    ? fs.readFileSync(electronSearchIpcFile, 'utf-8')
    : ''
  const requiredHostSymbols = [
    'findElectronMainSearchWindow',
    'getElectronSearchWindowFromWebContents',
    'registerElectronSearchIpcHandlers',
    'options.ipcMain ?? ipcMain',
    'host.handle',
    'ElectronSearchIpcChannels',
    'toggleElectronSearchWindowFrom',
    'executeElectronSearchActionFrom',
    'BrowserWindow.fromWebContents',
    'BrowserWindow.getFocusedWindow',
    'BrowserWindow.getAllWindows',
    'webContents.send',
    'focus',
  ]
  const requiredControllerSymbols = [
    '@onething/electron-host/search/window-actions',
    'toggleElectronSearchWindowFrom',
    'executeElectronSearchActionFrom',
    'resolveActionId',
  ]
  const requiredIpcFacadeSymbols = [
    'registerSearchHandlers',
    'registerElectronSearchIpcHandlers',
    'closeOnethingSearchWindowForIpc',
    'executeOnethingSearchForIpc',
    'toggleSearchWindowFrom',
    'executeSearchActionFrom',
  ]
  const lines = [
    ...(!packageContent.includes('./search/window-actions')
      ? [`${rel(electronPackage)}: missing search window-actions export`]
      : []),
    ...(!packageContent.includes('./search/window-controller')
      ? [`${rel(electronPackage)}: missing search window-controller export`]
      : []),
    ...(!packageContent.includes('./search/ipc')
      ? [`${rel(electronPackage)}: missing search IPC host export`]
      : []),
    ...requiredHostSymbols
      .filter(symbol => !electronSearchActionsContent.includes(symbol))
      .map(symbol => `${rel(electronSearchActionsFile)}: missing Electron search window-actions symbol ${symbol}`),
    ...requiredControllerSymbols
      .filter(symbol => !electronSearchControllerContent.includes(symbol))
      .map(symbol => `${rel(electronSearchControllerFile)}: missing Electron search controller facade symbol ${symbol}`),
    ...requiredIpcFacadeSymbols
      .filter(symbol => !electronSearchIpcContent.includes(symbol))
      .map(symbol => `${rel(electronSearchIpcFile)}: missing Electron search IPC host facade symbol ${symbol}`),
    ...[
      'IPC_CHANNELS.SEARCH_WINDOW_TOGGLE',
      'IPC_CHANNELS.SEARCH_WINDOW_CLOSE',
      'IPC_CHANNELS.SEARCH_QUERY',
      'IPC_CHANNELS.SEARCH_EXECUTE_ACTION',
    ]
      .filter(symbol => !electronSearchIpcContent.includes(symbol))
      .map(symbol => `${rel(electronSearchIpcFile)}: missing search IPC channel ${symbol}`),
    ...(fs.existsSync(legacySelectionFile)
      ? [`${rel(legacySelectionFile)}: search main-window selection belongs in apps/electron`]
      : []),
    ...(fs.existsSync(searchControllerFile)
      ? [`${rel(searchControllerFile)}: remove legacy search window controller facade; use @onething/electron-host/search/window-controller directly`]
      : []),
    ...(fs.existsSync(searchIpcFile)
      ? [`${rel(searchIpcFile)}: remove legacy search IPC facade; use @onething/electron-host/search/ipc directly`]
      : []),
  ]

  assertNoMatches('apps/electron owns Electron search window action delivery', lines)
}

function checkElectronHostOwnsSearchWindowLayout(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronLayoutFile = path.join(root, 'apps/electron/src/window/search-window-layout.ts')
  const electronSearchWindowFile = path.join(root, 'apps/electron/src/search/window.ts')
  const legacyLayoutFile = path.join(root, 'packages/backend/wiring/search/window-layout.ts')
  const searchWindowFile = path.join(root, 'packages/backend/wiring/search/window.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronLayoutContent = fs.existsSync(electronLayoutFile) ? fs.readFileSync(electronLayoutFile, 'utf-8') : ''
  const electronSearchWindowContent = fs.existsSync(electronSearchWindowFile)
    ? fs.readFileSync(electronSearchWindowFile, 'utf-8')
    : ''
  const requiredLayoutSymbols = [
    'ELECTRON_SEARCH_WINDOW_MIN_WIDTH',
    'ELECTRON_SEARCH_WINDOW_MIN_HEIGHT',
    'ELECTRON_SEARCH_WINDOW_MAX_DEFAULT_HEIGHT',
    'getElectronSearchWindowSizeConstraints',
    'getElectronDefaultSearchWindowBounds',
    'getElectronSearchWindowGuideState',
  ]
  const requiredHostFacadeSymbols = [
    '@onething/electron-host/window/search-window-layout',
    'getElectronSearchWindowSizeConstraints',
    'getElectronDefaultSearchWindowBounds',
    'getElectronSearchWindowGuideState',
  ]
  const lines = [
    ...(!packageContent.includes('./window/search-window-layout')
      ? [`${rel(electronPackage)}: missing search-window-layout export`]
      : []),
    ...requiredLayoutSymbols
      .filter(symbol => !electronLayoutContent.includes(symbol))
      .map(symbol => `${rel(electronLayoutFile)}: missing Electron search-window-layout symbol ${symbol}`),
    ...requiredHostFacadeSymbols
      .filter(symbol => !electronSearchWindowContent.includes(symbol))
      .map(symbol => `${rel(electronSearchWindowFile)}: missing search-window layout host delegation ${symbol}`),
    ...(fs.existsSync(legacyLayoutFile)
      ? [`${rel(legacyLayoutFile)}: search window layout belongs in apps/electron`]
      : []),
    ...(fs.existsSync(searchWindowFile)
      ? [`${rel(searchWindowFile)}: remove legacy search window facade; use @onething/electron-host/search/window directly`]
      : []),
  ]

  assertNoMatches('apps/electron owns Electron search window layout', lines)
}

function checkElectronHostOwnsWindowStatePersistence(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronWindowStateFile = path.join(root, 'apps/electron/src/window/window-state.ts')
  const windowFile = path.join(root, 'apps/electron/src/window/index.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronWindowStateContent = fs.existsSync(electronWindowStateFile) ? fs.readFileSync(electronWindowStateFile, 'utf-8') : ''
  const windowContent = fs.existsSync(windowFile) ? fs.readFileSync(windowFile, 'utf-8') : ''
  const requiredWindowStateSymbols = [
    'ElectronWindowState',
    'sanitizeElectronWindowState',
    'readElectronWindowState',
    'readElectronTodoPlanWindowState',
    'saveElectronMainWindowState',
    'saveElectronTodoPlanWindowState',
  ]
  const requiredFacadeSymbols = [
    'getWindowStateOptions',
    'readElectronWindowState',
    'readElectronTodoPlanWindowState',
    'saveElectronMainWindowState',
    'saveElectronTodoPlanWindowState',
  ]
  const lines = [
    ...(!packageContent.includes('./window/window-state')
      ? [`${rel(electronPackage)}: missing window-state export`]
      : []),
    ...requiredWindowStateSymbols
      .filter(symbol => !electronWindowStateContent.includes(symbol))
      .map(symbol => `${rel(electronWindowStateFile)}: missing Electron window-state symbol ${symbol}`),
    ...requiredFacadeSymbols
      .filter(symbol => !windowContent.includes(symbol))
      .map(symbol => `${rel(windowFile)}: missing window-state facade delegation ${symbol}`),
    ...(fs.existsSync(windowFile)
      ? matchingLines(windowFile, WINDOW_STATE_PERSISTENCE_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/window/index.ts: missing Electron window module']),
  ]

  assertNoMatches('apps/electron owns Electron window state persistence', lines)
}

function checkElectronHostOwnsMainWindowActivation(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronActivationFile = path.join(root, 'apps/electron/src/window/activation.ts')
  const windowFile = path.join(root, 'apps/electron/src/window/index.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronActivationContent = fs.existsSync(electronActivationFile) ? fs.readFileSync(electronActivationFile, 'utf-8') : ''
  const windowContent = fs.existsSync(windowFile) ? fs.readFileSync(windowFile, 'utf-8') : ''
  const requiredActivationSymbols = [
    'createElectronMainWindowActivationController',
    'suppressFromAuxiliaryWindow',
    'shouldSuppressActivation',
    'activateMainWindow',
    'isMinimized',
    'isVisible',
    'focus',
  ]
  const lines = [
    ...(!packageContent.includes('./window/activation')
      ? [`${rel(electronPackage)}: missing activation export`]
      : []),
    ...requiredActivationSymbols
      .filter(symbol => !electronActivationContent.includes(symbol))
      .map(symbol => `${rel(electronActivationFile)}: missing Electron activation symbol ${symbol}`),
    ...(!windowContent.includes('createElectronMainWindowActivationController')
      ? [`${rel(windowFile)}: main window activation must delegate to apps/electron`]
      : []),
    ...(fs.existsSync(windowFile)
      ? matchingLines(windowFile, WINDOW_ACTIVATION_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/window/index.ts: missing Electron window module']),
  ]

  assertNoMatches('apps/electron owns Electron main window activation semantics', lines)
}

function checkElectronHostOwnsWindowVisibilitySnapshots(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronVisibilityFile = path.join(root, 'apps/electron/src/window/window-visibility.ts')
  const windowFile = path.join(root, 'apps/electron/src/window/index.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronVisibilityContent = fs.existsSync(electronVisibilityFile) ? fs.readFileSync(electronVisibilityFile, 'utf-8') : ''
  const windowContent = fs.existsSync(windowFile) ? fs.readFileSync(windowFile, 'utf-8') : ''
  const requiredVisibilitySymbols = [
    'ElectronMainWindowVisibilitySnapshot',
    'isElectronMainAppWindow',
    'captureElectronMainWindowVisibility',
    'restoreElectronHiddenMainWindows',
    'getAllWindows',
    'restoreDelaysMs',
  ]
  const requiredFacadeSymbols = [
    'captureElectronMainWindowVisibility',
    'restoreElectronHiddenMainWindows',
    'ElectronMainWindowVisibilitySnapshot',
  ]
  const lines = [
    ...(!packageContent.includes('./window/window-visibility')
      ? [`${rel(electronPackage)}: missing window-visibility export`]
      : []),
    ...requiredVisibilitySymbols
      .filter(symbol => !electronVisibilityContent.includes(symbol))
      .map(symbol => `${rel(electronVisibilityFile)}: missing Electron window-visibility symbol ${symbol}`),
    ...requiredFacadeSymbols
      .filter(symbol => !windowContent.includes(symbol))
      .map(symbol => `${rel(windowFile)}: missing window-visibility facade delegation ${symbol}`),
    ...(fs.existsSync(windowFile)
      ? matchingLines(windowFile, WINDOW_VISIBILITY_SNAPSHOT_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/window/index.ts: missing Electron window module']),
  ]

  assertNoMatches('apps/electron owns Electron main window visibility snapshots', lines)
}

function checkElectronHostOwnsTodoPlanNotifications(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronNotificationsFile = path.join(root, 'apps/electron/src/todo-plan/notifications.ts')
  const storeFile = path.join(root, 'packages/backend/wiring/todo-plan/store.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronNotificationsContent = fs.existsSync(electronNotificationsFile)
    ? fs.readFileSync(electronNotificationsFile, 'utf-8')
    : ''
  const storeContent = fs.existsSync(storeFile) ? fs.readFileSync(storeFile, 'utf-8') : ''
  const requiredHostSymbols = [
    'broadcastElectronTodoPlanChanged',
    'revealElectronTodoPlanDirectory',
    'BrowserWindow.getAllWindows',
    'webContents.send',
    'shell.openPath',
  ]
  // main/todo-plan is host-agnostic: it exposes injection ports; the Electron
  // host wires the real notification impls in main/ipc/todo-plan.ts.
  const requiredFacadeSymbols = [
    'configureTodoPlanHost',
    'broadcastChanged',
    'revealDirectory',
  ]
  const ipcWiringFile = path.join(root, 'apps/electron/src/main/ipc/todo-plan.ts')
  const ipcWiringContent = fs.existsSync(ipcWiringFile) ? fs.readFileSync(ipcWiringFile, 'utf-8') : ''
  const lines = [
    ...(!ipcWiringContent.includes('configureTodoPlanHost')
      ? [`${rel(ipcWiringFile)}: Electron host must wire configureTodoPlanHost`]
      : []),
    ...(storeContent.includes('@onething/electron-host/')
      ? [`${rel(storeFile)}: main/todo-plan must stay host-agnostic (inject via configureTodoPlanHost)`]
      : []),
    ...(!packageContent.includes('./todo-plan/notifications')
      ? [`${rel(electronPackage)}: missing todo-plan notifications export`]
      : []),
    ...requiredHostSymbols
      .filter(symbol => !electronNotificationsContent.includes(symbol))
      .map(symbol => `${rel(electronNotificationsFile)}: missing Electron todo-plan notification symbol ${symbol}`),
    ...requiredFacadeSymbols
      .filter(symbol => !storeContent.includes(symbol))
      .map(symbol => `${rel(storeFile)}: missing todo-plan notification facade delegation ${symbol}`),
    ...(fs.existsSync(storeFile)
      ? matchingLines(storeFile, MAIN_TODO_PLAN_STORE_FORBIDDEN_PATTERNS)
      : ['packages/backend/wiring/todo-plan/store.ts: missing todo-plan store facade']),
  ]

  assertNoMatches('apps/electron owns Electron todo-plan notifications', lines)
}

function checkElectronHostOwnsTodoPlanPresentation(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronPresentationFile = path.join(root, 'apps/electron/src/window/todo-plan-presentation.ts')
  const windowFile = path.join(root, 'apps/electron/src/window/index.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronPresentationContent = fs.existsSync(electronPresentationFile)
    ? fs.readFileSync(electronPresentationFile, 'utf-8')
    : ''
  const windowContent = fs.existsSync(windowFile) ? fs.readFileSync(windowFile, 'utf-8') : ''
  const requiredPresentationSymbols = [
    'normalizeElectronTodoPlanWindowActionOptions',
    'shouldPreserveElectronCurrentMacApp',
    'prepareElectronTodoPlanWindowAction',
    'presentElectronTodoPlanWindow',
    'isElectronTodoPlanWindowFrontmost',
    'showInactive',
    'moveTop',
    'BrowserWindow.getFocusedWindow',
  ]
  const requiredFacadeSymbols = [
    'normalizeElectronTodoPlanWindowActionOptions',
    'prepareElectronTodoPlanWindowAction',
    'presentElectronTodoPlanWindow',
    'isElectronTodoPlanWindowFrontmost',
  ]
  const lines = [
    ...(!packageContent.includes('./window/todo-plan-presentation')
      ? [`${rel(electronPackage)}: missing todo-plan-presentation export`]
      : []),
    ...requiredPresentationSymbols
      .filter(symbol => !electronPresentationContent.includes(symbol))
      .map(symbol => `${rel(electronPresentationFile)}: missing Electron todo-plan-presentation symbol ${symbol}`),
    ...requiredFacadeSymbols
      .filter(symbol => !windowContent.includes(symbol))
      .map(symbol => `${rel(windowFile)}: missing todo-plan presentation facade delegation ${symbol}`),
    ...(fs.existsSync(windowFile)
      ? matchingLines(windowFile, WINDOW_TODO_PLAN_PRESENTATION_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/window/index.ts: missing Electron window module']),
  ]

  assertNoMatches('apps/electron owns Electron todo plan presentation strategy', lines)
}

function checkElectronHostOwnsWindowFacade(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const windowHostFile = path.join(root, 'apps/electron/src/window/index.ts')
  const windowFacadeFile = path.join(root, 'packages/backend/window.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const windowHostContent = fs.existsSync(windowHostFile) ? fs.readFileSync(windowHostFile, 'utf-8') : ''
  const windowFacadeContent = fs.existsSync(windowFacadeFile) ? fs.readFileSync(windowFacadeFile, 'utf-8') : ''
  const facadeLines = windowFacadeContent.split('\n').filter(line => line.trim().length > 0)
  const requiredHostSymbols = [
    'createWindow',
    'openTodoPlanWindow',
    'recoverMainWindowAfterSystemResume',
    'setupElectronApplicationMenu',
  ]
  const lines = [
    ...(!packageContent.includes('./window')
      ? [`${rel(electronPackage)}: missing window aggregate export`]
      : []),
    ...requiredHostSymbols
      .filter(symbol => !windowHostContent.includes(symbol))
      .map(symbol => `${rel(windowHostFile)}: missing Electron window orchestration symbol ${symbol}`),
    ...(fs.existsSync(windowFacadeFile)
      ? [`${rel(windowFacadeFile)}: legacy window facade was removed; import @onething/electron-host/window directly`]
      : []),
    ...(facadeLines.length > 20
      ? [`${rel(windowFacadeFile)}: legacy Electron window facade must stay thin`]
      : []),
  ]

  assertNoMatches('apps/electron owns Electron window facade', lines)
}

function checkElectronHostOwnsWindowAllClosedHandler(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronWindowFile = path.join(root, 'apps/electron/src/app/window-all-closed.ts')
  const mainFile = path.join(root, 'apps/electron/src/app/main-process.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronWindowContent = fs.existsSync(electronWindowFile) ? fs.readFileSync(electronWindowFile, 'utf-8') : ''
  const mainContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf-8') : ''
  const requiredWindowSymbols = [
    'registerElectronWindowAllClosedHandler',
    'window-all-closed',
    'isVoiceKeepAliveEnabled',
    'process.platform',
    'electronApp.quit',
  ]
  const lines = [
    ...(!packageContent.includes('./app/window-all-closed')
      ? [`${rel(electronPackage)}: missing window-all-closed export`]
      : []),
    ...requiredWindowSymbols
      .filter(symbol => !electronWindowContent.includes(symbol))
      .map(symbol => `${rel(electronWindowFile)}: missing Electron window-all-closed symbol ${symbol}`),
    ...(!mainContent.includes('registerElectronWindowAllClosedHandler')
      && !mainContent.includes('registerElectronAppBootstrap')
      ? [`${rel(mainFile)}: main must delegate window-all-closed handling to apps/electron`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_WINDOW_ALL_CLOSED_FORBIDDEN_PATTERNS)
      : ['packages/backend/index.ts: missing Electron main entry']),
  ]

  assertNoMatches('apps/electron owns Electron window-all-closed handler', lines)
}

function checkElectronHostOwnsDidBecomeActiveHandler(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronActiveFile = path.join(root, 'apps/electron/src/app/did-become-active.ts')
  const mainFile = path.join(root, 'apps/electron/src/app/main-process.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronActiveContent = fs.existsSync(electronActiveFile) ? fs.readFileSync(electronActiveFile, 'utf-8') : ''
  const mainContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf-8') : ''
  const requiredActiveSymbols = [
    'registerElectronDidBecomeActiveHandler',
    'did-become-active',
    'getFocusedWindow',
    'isTodoPlanWindow',
    'activateMainWindow',
  ]
  const lines = [
    ...(!packageContent.includes('./app/did-become-active')
      ? [`${rel(electronPackage)}: missing did-become-active export`]
      : []),
    ...requiredActiveSymbols
      .filter(symbol => !electronActiveContent.includes(symbol))
      .map(symbol => `${rel(electronActiveFile)}: missing Electron did-become-active symbol ${symbol}`),
    ...(!mainContent.includes('registerElectronDidBecomeActiveHandler')
      && !mainContent.includes('registerElectronAppBootstrap')
      ? [`${rel(mainFile)}: main must delegate did-become-active handling to apps/electron`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_DID_BECOME_ACTIVE_FORBIDDEN_PATTERNS)
      : ['packages/backend/index.ts: missing Electron main entry']),
  ]

  assertNoMatches('apps/electron owns Electron did-become-active handler', lines)
}

function checkElectronHostOwnsBeforeQuitCleanup(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronBeforeQuitFile = path.join(root, 'apps/electron/src/app/before-quit.ts')
  const mainFile = path.join(root, 'apps/electron/src/app/main-process.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronBeforeQuitContent = fs.existsSync(electronBeforeQuitFile) ? fs.readFileSync(electronBeforeQuitFile, 'utf-8') : ''
  const mainContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf-8') : ''
  const requiredBeforeQuitSymbols = [
    'registerElectronBeforeQuitCleanup',
    'before-quit',
    'markVoiceQuitRequested',
    'shutdownGateway',
    'flushAllPendingSaves',
    'releaseDesktopStoreLock',
    'flushAllPendingSaves error',
  ]
  const lines = [
    ...(!packageContent.includes('./app/before-quit')
      ? [`${rel(electronPackage)}: missing before-quit export`]
      : []),
    ...requiredBeforeQuitSymbols
      .filter(symbol => !electronBeforeQuitContent.includes(symbol))
      .map(symbol => `${rel(electronBeforeQuitFile)}: missing Electron before-quit symbol ${symbol}`),
    ...(!mainContent.includes('registerElectronBeforeQuitCleanup')
      && !mainContent.includes('registerElectronAppBootstrap')
      ? [`${rel(mainFile)}: main must delegate before-quit cleanup to apps/electron`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_BEFORE_QUIT_FORBIDDEN_PATTERNS)
      : ['packages/backend/index.ts: missing Electron main entry']),
  ]

  assertNoMatches('apps/electron owns Electron before-quit cleanup', lines)
}

function checkElectronHostOwnsMediaProtocol(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronMediaFile = path.join(root, 'apps/electron/src/media/protocol.ts')
  const mainFile = path.join(root, 'apps/electron/src/app/main-process.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronMediaContent = fs.existsSync(electronMediaFile) ? fs.readFileSync(electronMediaFile, 'utf-8') : ''
  const mainContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf-8') : ''
  const requiredMediaSymbols = [
    'registerElectronMediaProtocol',
    'getMediaImagesDir',
    'protocol.handle',
    'net.fetch',
    'pathToFileURL',
  ]
  const lines = [
    ...(!packageContent.includes('./media/protocol')
      ? [`${rel(electronPackage)}: missing media protocol export`]
      : []),
    ...requiredMediaSymbols
      .filter(symbol => !electronMediaContent.includes(symbol))
      .map(symbol => `${rel(electronMediaFile)}: missing Electron media protocol symbol ${symbol}`),
    ...(!mainContent.includes('registerElectronMediaProtocol({ getMediaImagesDir })')
      && !mainContent.includes('registerElectronAppBootstrap')
      ? [`${rel(mainFile)}: main must delegate media protocol registration to apps/electron`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_MEDIA_PROTOCOL_FORBIDDEN_PATTERNS)
      : ['packages/backend/index.ts: missing Electron main entry']),
  ]

  assertNoMatches('apps/electron owns Electron media protocol registration', lines)
}

function checkElectronHostOwnsLoggingCapture(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronLoggingFile = path.join(root, 'apps/electron/src/logging/console-capture.ts')
  const mainLoggingFile = path.join(root, 'packages/backend/wiring/logging/index.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronLoggingContent = fs.existsSync(electronLoggingFile) ? fs.readFileSync(electronLoggingFile, 'utf-8') : ''
  const mainLoggingContent = fs.existsSync(mainLoggingFile) ? fs.readFileSync(mainLoggingFile, 'utf-8') : ''
  const requiredHostSymbols = [
    'setElectronAppLogsPath',
    'createElectronRendererConsoleCapture',
    'web-contents-created',
    'console-message',
    'NUMERIC_RENDERER_LEVELS',
    'renderer:${webContents.id}',
  ]
  // main/logging is host-agnostic: it exposes injection ports instead of
  // importing electron-host. The Electron host wires the real capture in
  // app/main-process.ts.
  const requiredFacadeSymbols = [
    'configureAppLoggingHost',
    'createRendererConsoleCapture',
    'setAppLogsPath',
    'attachLoggingCapture',
    'process.on',
  ]
  const mainProcessFile = path.join(root, 'apps/electron/src/app/main-process.ts')
  const mainProcessContent = fs.existsSync(mainProcessFile) ? fs.readFileSync(mainProcessFile, 'utf-8') : ''
  const lines = [
    ...(!packageContent.includes('./logging/console-capture')
      ? [`${rel(electronPackage)}: missing logging console-capture export`]
      : []),
    ...requiredHostSymbols
      .filter(symbol => !electronLoggingContent.includes(symbol))
      .map(symbol => `${rel(electronLoggingFile)}: missing Electron logging capture symbol ${symbol}`),
    ...requiredFacadeSymbols
      .filter(symbol => !mainLoggingContent.includes(symbol))
      .map(symbol => `${rel(mainLoggingFile)}: missing logging host-port symbol ${symbol}`),
    ...(!mainProcessContent.includes('configureAppLoggingHost')
      ? [`${rel(mainProcessFile)}: Electron host must wire configureAppLoggingHost before initializeAppLogging`]
      : []),
    ...(mainLoggingContent.includes('@onething/electron-host/')
      ? [`${rel(mainLoggingFile)}: main/logging must stay host-agnostic (inject via configureAppLoggingHost)`]
      : []),
    ...(fs.existsSync(mainLoggingFile)
      ? matchingLines(mainLoggingFile, MAIN_LOGGING_ELECTRON_CAPTURE_FORBIDDEN_PATTERNS)
      : ['packages/backend/wiring/logging/index.ts: missing logging facade']),
  ]

  assertNoMatches('apps/electron owns Electron logging capture', lines)
}

function checkElectronHostOwnsAccessibilityPermissions(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronAccessibilityFile = path.join(root, 'apps/electron/src/accessibility/permissions.ts')
  const mainAccessibilityFile = path.join(root, 'packages/backend/utils/accessibility.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronAccessibilityContent = fs.existsSync(electronAccessibilityFile) ? fs.readFileSync(electronAccessibilityFile, 'utf-8') : ''
  const mainAccessibilityContent = fs.existsSync(mainAccessibilityFile) ? fs.readFileSync(mainAccessibilityFile, 'utf-8') : ''
  const requiredHostSymbols = [
    'systemPreferences',
    'shell',
    'checkElectronAccessibilityPermission',
    'getElectronAccessibilityPermissionError',
    'openElectronAccessibilitySettings',
    'checkElectronScreenRecordingPermission',
    'getElectronAutomationPermissionStatus',
    'isTrustedAccessibilityClient',
    'x-apple.systempreferences',
  ]
  const requiredFacadeSymbols = [
    '@onething/electron-host/accessibility/permissions',
    'checkElectronAccessibilityPermission',
    'getElectronAccessibilityPermissionError',
    'openElectronAccessibilitySettings',
    'checkElectronScreenRecordingPermission',
    'getElectronAutomationPermissionStatus',
  ]
  const lines = [
    ...(!packageContent.includes('./accessibility/permissions')
      ? [`${rel(electronPackage)}: missing accessibility permissions export`]
      : []),
    ...requiredHostSymbols
      .filter(symbol => !electronAccessibilityContent.includes(symbol))
      .map(symbol => `${rel(electronAccessibilityFile)}: missing Electron accessibility symbol ${symbol}`),
    ...(fs.existsSync(mainAccessibilityFile)
      ? [`${rel(mainAccessibilityFile)}: legacy accessibility facade was removed; import @onething/electron-host/accessibility/permissions directly`]
      : []),
    ...(fs.existsSync(mainAccessibilityFile)
      ? matchingLines(mainAccessibilityFile, MAIN_ACCESSIBILITY_FORBIDDEN_PATTERNS)
      : []),
  ]

  assertNoMatches('apps/electron owns Electron accessibility permissions', lines)
}

function checkElectronHostOwnsShellOperations(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronShellFile = path.join(root, 'apps/electron/src/shell/operations.ts')
  const electronShellIpcControllerFile = path.join(root, 'apps/electron/src/ipc/shell-controller.ts')
  const electronShellIpcFile = path.join(root, 'apps/electron/src/ipc/shell.ts')
  const mainShellFile = path.join(root, 'apps/electron/src/main/ipc/shell.ts')
  // P4c 第二批:外壳能力从此有一个产品层端口(`@onething/runtime/shell`),
  // 装配层与产品层通过它要能力,而不是各自直连 `@onething/electron-host/shell/operations`。
  const shellHostPortFile = path.join(root, 'packages/onething-runtime/src/shell/host-ports.ts')
  const mainProcessWiringFile = path.join(root, 'apps/electron/src/app/main-process.ts')
  const shellHostPortContent = fs.existsSync(shellHostPortFile) ? fs.readFileSync(shellHostPortFile, 'utf-8') : ''
  const mainProcessWiringContent = fs.existsSync(mainProcessWiringFile) ? fs.readFileSync(mainProcessWiringFile, 'utf-8') : ''
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronShellContent = fs.existsSync(electronShellFile) ? fs.readFileSync(electronShellFile, 'utf-8') : ''
  const electronShellIpcControllerContent = fs.existsSync(electronShellIpcControllerFile)
    ? fs.readFileSync(electronShellIpcControllerFile, 'utf-8')
    : ''
  const electronShellIpcContent = fs.existsSync(electronShellIpcFile) ? fs.readFileSync(electronShellIpcFile, 'utf-8') : ''
  const mainShellContent = fs.existsSync(mainShellFile) ? fs.readFileSync(mainShellFile, 'utf-8') : ''
  const requiredHostSymbols = [
    'BrowserWindow',
    'shell',
    'openElectronPath',
    'openElectronExternal',
    'revealElectronPath',
    'setElectronWindowButtonVisibility',
    'openPath',
    'openExternal',
    'showItemInFolder',
    'fromWebContents',
    'setWindowButtonVisibility',
    'setWindowButtonPosition',
  ]
  const requiredIpcHostSymbols = [
    'registerElectronShellIpcHandlers',
    'ipcMain',
    'openElectronPath',
    'openElectronExternal',
    'setElectronWindowButtonVisibility',
    'shell:open-path',
    'shell:open-external',
    'app:get-data-path',
    'window:set-button-visibility',
    'getDataPath',
  ]
  const requiredHostFacadeSymbols = [
    'registerShellHandlers',
    'registerElectronShellIpcHandlers',
    // P3'a-2:`app/stores/paths.ts` 的同名转发层已删,宿主直取 runtime 的真名。
    'getOnethingStorePath',
  ]
  const requiredLegacyFacadeSymbols = [
    '@onething/electron-host/ipc/shell',
    'registerShellHandlers',
  ]
  const mainShellFacadeLines = mainShellContent.split('\n').filter(line => line.trim().length > 0)
  const lines = [
    ...(!packageContent.includes('./shell/operations')
      ? [`${rel(electronPackage)}: missing shell operations export`]
      : []),
    ...(!packageContent.includes('./ipc/shell')
      ? [`${rel(electronPackage)}: missing shell IPC host export`]
      : []),
    ...requiredHostSymbols
      .filter(symbol => !electronShellContent.includes(symbol))
      .map(symbol => `${rel(electronShellFile)}: missing Electron shell operation symbol ${symbol}`),
    ...requiredIpcHostSymbols
      .filter(symbol => !electronShellIpcControllerContent.includes(symbol))
      .map(symbol => `${rel(electronShellIpcControllerFile)}: missing Electron shell IPC controller symbol ${symbol}`),
    ...requiredHostFacadeSymbols
      .filter(symbol => !electronShellIpcContent.includes(symbol))
      .map(symbol => `${rel(electronShellIpcFile)}: missing Electron shell IPC host facade symbol ${symbol}`),
    ...requiredLegacyFacadeSymbols
      .filter(symbol => !mainShellContent.includes(symbol))
      .map(symbol => `${rel(mainShellFile)}: missing shell IPC legacy facade delegation ${symbol}`),
    ...(mainShellFacadeLines.length > 6
      ? [`${rel(mainShellFile)}: legacy shell IPC facade must stay thin`]
      : []),
    ...(fs.existsSync(mainShellFile)
      ? matchingLines(mainShellFile, MAIN_SHELL_OPERATIONS_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/main/ipc/shell.ts: missing shell IPC facade']),
    ...['configureShellHost', 'getShellHost', 'SHELL_HOST_UNAVAILABLE']
      .filter(symbol => !shellHostPortContent.includes(symbol))
      .map(symbol => `${rel(shellHostPortFile)}: missing shell host port symbol ${symbol}`),
    ...(!mainProcessWiringContent.includes('configureShellHost')
      ? [`${rel(mainProcessWiringFile)}: Electron host must wire configureShellHost`]
      : []),
  ]

  assertNoMatches('apps/electron owns Electron shell operations', lines)
}

function checkElectronHostOwnsOAuthEvents(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronOAuthFile = path.join(root, 'apps/electron/src/oauth/events.ts')
  const mainOAuthFile = path.join(root, 'apps/electron/src/main/ipc/oauth.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronOAuthContent = fs.existsSync(electronOAuthFile) ? fs.readFileSync(electronOAuthFile, 'utf-8') : ''
  const mainOAuthContent = fs.existsSync(mainOAuthFile) ? fs.readFileSync(mainOAuthFile, 'utf-8') : ''
  const requiredHostSymbols = [
    'BrowserWindow',
    'BrowserWindow.getAllWindows',
    'broadcastElectronOAuthTokenRefreshed',
    'broadcastElectronOAuthTokenExpired',
    'webContents.send',
  ]
  const requiredFacadeSymbols = [
    '@onething/electron-host/oauth/events',
    'broadcastElectronOAuthTokenRefreshed',
    'broadcastElectronOAuthTokenExpired',
    'IPC_CHANNELS.OAUTH_TOKEN_REFRESHED',
    'IPC_CHANNELS.OAUTH_TOKEN_EXPIRED',
    // P4c 第七批:数据面迁走之后,这两条推送靠一个注入端口找到宿主 ——
    // 桌面这一侧的注入就是本文件仅剩的内容(同 practice / scratchpad 判例)。
    'configureOAuthEventBroadcaster',
  ]
  // 端口本体在装配层 wiring/auth 里:单槽 + 可读回(server 要串联)+ 令牌过期的
  // 统一通知口(`refresh` 那条改走事件源,而不是各宿主自己广播一次)。
  const oauthEventPortFile = path.join(root, 'packages/backend/wiring/auth/oauth-events.ts')
  const oauthEventPortContent = fs.existsSync(oauthEventPortFile)
    ? fs.readFileSync(oauthEventPortFile, 'utf-8')
    : ''
  const lines = [
    ...['configureOAuthEventBroadcaster', 'getOAuthEventBroadcaster', 'notifyOAuthTokenExpired']
      .filter(symbol => !oauthEventPortContent.includes(symbol))
      .map(symbol => `${rel(oauthEventPortFile)}: missing OAuth event broadcaster port symbol ${symbol}`),
    ...(!packageContent.includes('./oauth/events')
      ? [`${rel(electronPackage)}: missing OAuth events export`]
      : []),
    ...requiredHostSymbols
      .filter(symbol => !electronOAuthContent.includes(symbol))
      .map(symbol => `${rel(electronOAuthFile)}: missing Electron OAuth event symbol ${symbol}`),
    ...requiredFacadeSymbols
      .filter(symbol => !mainOAuthContent.includes(symbol))
      .map(symbol => `${rel(mainOAuthFile)}: missing OAuth IPC event delegation ${symbol}`),
    ...(fs.existsSync(mainOAuthFile)
      ? matchingLines(mainOAuthFile, MAIN_OAUTH_IPC_OPERATIONS_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/main/ipc/oauth.ts: missing OAuth IPC facade']),
  ]

  assertNoMatches('apps/electron owns Electron OAuth event broadcasting', lines)
}

function checkElectronHostOwnsSettingsIpcHost(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronSettingsFile = path.join(root, 'apps/electron/src/settings/ipc-host.ts')
  const mainSettingsFile = path.join(root, 'apps/electron/src/main/ipc/settings.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronSettingsContent = fs.existsSync(electronSettingsFile) ? fs.readFileSync(electronSettingsFile, 'utf-8') : ''
  const mainSettingsContent = fs.existsSync(mainSettingsFile) ? fs.readFileSync(mainSettingsFile, 'utf-8') : ''
  const requiredHostSymbols = [
    'BrowserWindow',
    'dialog',
    'ipcMain',
    'nativeTheme',
    'registerElectronSettingsIpcHandlers',
    'options.ipcMain ?? ipcMain',
    'host.handle',
    'ElectronSettingsIpcChannels',
    'getElectronShouldUseDarkColors',
    'registerElectronSystemThemeChangedBroadcast',
    'broadcastElectronSettingsChanged',
    'showElectronOpenDialog',
    'BrowserWindow.getAllWindows',
    'BrowserWindow.getFocusedWindow',
    'dialog.showOpenDialog',
    'nativeTheme.on',
  ]
  const requiredFacadeSymbols = [
    '@onething/electron-host/settings/ipc-host',
    'registerElectronSettingsIpcHandlers',
    'getElectronShouldUseDarkColors',
    'registerElectronSystemThemeChangedBroadcast',
    'broadcastElectronSettingsChanged',
    'showElectronOpenDialog',
    'IPC_CHANNELS.OPEN_SETTINGS_WINDOW',
    'IPC_CHANNELS.GET_SETTINGS',
    'IPC_CHANNELS.GET_SYSTEM_THEME',
    'IPC_CHANNELS.SAVE_SETTINGS',
    'IPC_CHANNELS.TEST_PROXY',
    // `GET_NETWORK_INTERFACES` 于 603582d9 随网卡枚举一起退役,全仓 0 命中 —— 断言删除。
    'IPC_CHANNELS.SHOW_OPEN_DIALOG',
    'IPC_CHANNELS.SYSTEM_THEME_CHANGED',
    'IPC_CHANNELS.SETTINGS_CHANGED',
  ]
  const lines = [
    ...(!packageContent.includes('./settings/ipc-host')
      ? [`${rel(electronPackage)}: missing settings IPC host export`]
      : []),
    ...requiredHostSymbols
      .filter(symbol => !electronSettingsContent.includes(symbol))
      .map(symbol => `${rel(electronSettingsFile)}: missing Electron settings IPC host symbol ${symbol}`),
    ...requiredFacadeSymbols
      .filter(symbol => !mainSettingsContent.includes(symbol))
      .map(symbol => `${rel(mainSettingsFile)}: missing settings IPC host delegation ${symbol}`),
    ...(fs.existsSync(mainSettingsFile)
      ? [
          ...matchingLines(mainSettingsFile, MAIN_SETTINGS_IPC_SAVE_ORCHESTRATION_FORBIDDEN_PATTERNS),
          ...matchingLines(mainSettingsFile, MAIN_SETTINGS_IPC_HOST_FORBIDDEN_PATTERNS),
        ]
      : ['apps/electron/src/main/ipc/settings.ts: missing settings IPC adapter']),
  ]

  assertNoMatches('apps/electron owns Electron settings IPC host operations', lines)
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
    'agentsRouter',
    'registerRouterHandlers',
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
    // 装配点从「逐域调 registerXRpcDomain()」换成了 feature 描述子
    // (`{ id: 'rpc:agents', mount: ctx => ctx.registerRpcDomain(...) }`,K0/C0),
    // 域函数本身还在 domains/agents.ts 里、也还有测试在用,只是 index 不再直接叫它。
    // 认 handlers 名 —— 和 markdown / permissionGrants 两条同族规则一个口径。
    ...(!registryIndexContent.includes('agentsRpcHandlers')
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
    'promptsRouter',
    'registerRouterHandlers',
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
    ...(!registryIndexContent.includes('promptsRpcHandlers')
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
    'markdownRouter',
    'registerRouterHandlers',
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
    ...(!registryIndexContent.includes('markdownRpcHandlers')
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
    'permissionGrantsRouter',
    'registerRouterHandlers',
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
    ...(!registryIndexContent.includes('permissionGrantsRpcHandlers')
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


function checkElectronHostOwnsPluginsIpcHost(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronPluginsFile = path.join(root, 'apps/electron/src/ipc/plugins.ts')
  const mainPluginsFile = path.join(root, 'apps/electron/src/main/ipc/plugins.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronPluginsContent = fs.existsSync(electronPluginsFile) ? fs.readFileSync(electronPluginsFile, 'utf-8') : ''
  const mainPluginsContent = fs.existsSync(mainPluginsFile) ? fs.readFileSync(mainPluginsFile, 'utf-8') : ''
  const requiredHostSymbols = [
    'registerElectronPluginsIpcHandlers',
    'options.ipcMain ?? ipcMain',
    'host.handle',
    'ElectronPluginToggleRequest',
    'ElectronPluginExecuteCommandRequest',
  ]
  const requiredFacadeSymbols = [
    '@onething/electron-host/ipc/plugins',
    'registerElectronPluginsIpcHandlers',
    'IPC_CHANNELS.PLUGINS_LIST',
    'IPC_CHANNELS.PLUGINS_ENABLE',
    'IPC_CHANNELS.PLUGINS_DISABLE',
    'IPC_CHANNELS.PLUGINS_REFRESH',
    'IPC_CHANNELS.PLUGINS_COMMANDS',
    'IPC_CHANNELS.PLUGINS_EXECUTE_COMMAND',
    'listOnethingPluginsForIpc',
    'enableOnethingPluginForIpc',
    'disableOnethingPluginForIpc',
    'refreshOnethingPluginsForIpc',
    'listOnethingPluginCommandsForIpc',
    'executeOnethingPluginCommandForIpc',
  ]
  const lines = [
    ...(!packageContent.includes('./ipc/plugins')
      ? [`${rel(electronPackage)}: missing plugins IPC host export`]
      : []),
    ...requiredHostSymbols
      .filter(symbol => !electronPluginsContent.includes(symbol))
      .map(symbol => `${rel(electronPluginsFile)}: missing Electron plugins IPC host symbol ${symbol}`),
    ...requiredFacadeSymbols
      .filter(symbol => !mainPluginsContent.includes(symbol))
      .map(symbol => `${rel(mainPluginsFile)}: missing plugins IPC adapter symbol ${symbol}`),
    ...(fs.existsSync(mainPluginsFile)
      ? matchingLines(mainPluginsFile, MAIN_PLUGINS_IPC_HOST_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/main/ipc/plugins.ts: missing plugins IPC adapter']),
  ]

  assertNoMatches('apps/electron owns Electron plugins IPC host operations', lines)
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
    'providersRouter',
    'registerRouterHandlers',
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
    ...(!registryIndexContent.includes('providersRpcHandlers')
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
    'modelsRouter',
    'registerRouterHandlers',
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
    ...(!registryIndexContent.includes('modelsRpcHandlers')
      ? [`${rel(registryIndexFile)}: models domain is not listed in the RPC assembly point`]
      : []),
  ]

  assertNoMatches('models domain rides the generic RPC channel', lines)
}

function checkElectronHostOwnsMediaIpcHost(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronMediaFile = path.join(root, 'apps/electron/src/ipc/media.ts')
  const mainMediaFile = path.join(root, 'apps/electron/src/main/ipc/media.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronMediaContent = fs.existsSync(electronMediaFile) ? fs.readFileSync(electronMediaFile, 'utf-8') : ''
  const mainMediaContent = fs.existsSync(mainMediaFile) ? fs.readFileSync(mainMediaFile, 'utf-8') : ''
  // P4c 第三批:十一条数据面已迁 `mediaRouter`(域测试
  // `packages/backend/rpc/__tests__/media-domain.test.ts` 钉它们)。这只工厂只剩
  // **要宿主本体**的三条,断言随之收窄 —— 断言的是「这三条仍然由 apps/electron 拥有」,
  // 不再是「那十四条都还在」。
  const requiredHostSymbols = [
    'registerElectronMediaIpcHandlers',
    'options.ipcMain ?? ipcMain',
    'host.handle',
    'ElectronMediaIpcChannels',
    'ElectronImagePreviewRequest',
    'ElectronImageGalleryRequest',
    'saveElectronMediaFileAs',
  ]
  const requiredFacadeSymbols = [
    '@onething/electron-host/ipc/media',
    'registerElectronMediaIpcHandlers',
    'IPC_CHANNELS.SAVE_MEDIA_AS',
    'IPC_CHANNELS.OPEN_IMAGE_PREVIEW',
    'IPC_CHANNELS.OPEN_IMAGE_GALLERY',
    'openOnethingImagePreviewForIpc',
    'openOnethingImageGalleryForIpc',
  ]
  const lines = [
    ...(!packageContent.includes('./ipc/media')
      ? [`${rel(electronPackage)}: missing media IPC host export`]
      : []),
    ...requiredHostSymbols
      .filter(symbol => !electronMediaContent.includes(symbol))
      .map(symbol => `${rel(electronMediaFile)}: missing Electron media IPC host symbol ${symbol}`),
    ...requiredFacadeSymbols
      .filter(symbol => !mainMediaContent.includes(symbol))
      .map(symbol => `${rel(mainMediaFile)}: missing media IPC adapter symbol ${symbol}`),
    ...(fs.existsSync(mainMediaFile)
      ? matchingLines(mainMediaFile, MAIN_MEDIA_IPC_HOST_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/main/ipc/media.ts: missing media IPC adapter']),
  ]

  assertNoMatches('apps/electron owns Electron media IPC host operations', lines)
}

function checkElectronHostOwnsTodoPlanIpcHost(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronTodoPlanFile = path.join(root, 'apps/electron/src/ipc/todo-plan.ts')
  const mainTodoPlanFile = path.join(root, 'apps/electron/src/main/ipc/todo-plan.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronTodoPlanContent = fs.existsSync(electronTodoPlanFile) ? fs.readFileSync(electronTodoPlanFile, 'utf-8') : ''
  const mainTodoPlanContent = fs.existsSync(mainTodoPlanFile) ? fs.readFileSync(mainTodoPlanFile, 'utf-8') : ''
  const requiredHostSymbols = [
    'registerElectronTodoPlanIpcHandlers',
    'options.ipcMain ?? ipcMain',
    'host.handle',
    'ElectronTodoPlanIpcChannels',
    'ElectronTodoPlanPinnedRequest',
  ]
  const requiredFacadeSymbols = [
    // 数据面(get/create/update/rename/delete/revealDirectory)已迁到通用 RPC 通道,
    // 留在 @main 的只有窗口面 + configureTodoPlanHost 的端口注入。
    '@onething/electron-host/ipc/todo-plan',
    'registerElectronTodoPlanIpcHandlers',
    'configureTodoPlanHost',
    'IPC_CHANNELS.TODO_PLAN_CHANGED',
    'IPC_CHANNELS.TODO_PLAN_OPEN_WINDOW',
    'IPC_CHANNELS.TODO_PLAN_HIDE_WINDOW',
    'IPC_CHANNELS.TODO_PLAN_TOGGLE_WINDOW',
    'IPC_CHANNELS.TODO_PLAN_SET_WINDOW_PINNED',
    'runOnethingTodoPlanWindowActionForIpc',
    'setOnethingTodoPlanWindowPinnedForIpc',
  ]
  const lines = [
    ...(!packageContent.includes('./ipc/todo-plan')
      ? [`${rel(electronPackage)}: missing todo-plan IPC host export`]
      : []),
    ...requiredHostSymbols
      .filter(symbol => !electronTodoPlanContent.includes(symbol))
      .map(symbol => `${rel(electronTodoPlanFile)}: missing Electron todo-plan IPC host symbol ${symbol}`),
    ...requiredFacadeSymbols
      .filter(symbol => !mainTodoPlanContent.includes(symbol))
      .map(symbol => `${rel(mainTodoPlanFile)}: missing todo-plan IPC adapter symbol ${symbol}`),
    ...(fs.existsSync(mainTodoPlanFile)
      ? matchingLines(mainTodoPlanFile, MAIN_TODO_PLAN_IPC_HOST_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/main/ipc/todo-plan.ts: missing todo-plan IPC adapter']),
  ]

  assertNoMatches('apps/electron owns Electron todo-plan IPC host operations', lines)
}

function checkElectronHostOwnsToolsIpcHost(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronToolsFile = path.join(root, 'apps/electron/src/ipc/tools.ts')
  const mainToolsFile = path.join(root, 'apps/electron/src/main/ipc/tools.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronToolsContent = fs.existsSync(electronToolsFile) ? fs.readFileSync(electronToolsFile, 'utf-8') : ''
  const mainToolsContent = fs.existsSync(mainToolsFile) ? fs.readFileSync(mainToolsFile, 'utf-8') : ''
  const requiredHostSymbols = [
    'registerElectronToolsIpcHandlers',
    'options.ipcMain ?? ipcMain',
    'host.handle',
    'ElectronToolsIpcChannels',
    'ElectronToolCancelRequest',
    'ElectronBackgroundJobsListRequest',
    'ElectronBackgroundJobsStopRequest',
    'ElectronRefreshAsyncToolsRequest',
  ]
  const requiredFacadeSymbols = [
    '@onething/electron-host/ipc/tools',
    'registerElectronToolsIpcHandlers',
    'IPC_CHANNELS.GET_TOOLS',
    'IPC_CHANNELS.EXECUTE_TOOL',
    'IPC_CHANNELS.CANCEL_TOOL',
    'IPC_CHANNELS.BACKGROUND_JOBS_LIST',
    'IPC_CHANNELS.BACKGROUND_JOBS_STOP',
    'IPC_CHANNELS.REFRESH_ASYNC_TOOLS',
    'IPC_CHANNELS.UPDATE_TOOL_CALL',
    'listOnethingSettingsToolsForIpc',
    'executeOnethingToolWithSessionContextForIpc',
    'cancelOnethingToolForIpc',
    'listOnethingBackgroundJobsForIpc',
    'stopOnethingBackgroundJobForIpc',
    'applyOnethingToolCallUpdateForIpc',
  ]
  const lines = [
    ...(!packageContent.includes('./ipc/tools')
      ? [`${rel(electronPackage)}: missing tools IPC host export`]
      : []),
    ...requiredHostSymbols
      .filter(symbol => !electronToolsContent.includes(symbol))
      .map(symbol => `${rel(electronToolsFile)}: missing Electron tools IPC host symbol ${symbol}`),
    ...requiredFacadeSymbols
      .filter(symbol => !mainToolsContent.includes(symbol))
      .map(symbol => `${rel(mainToolsFile)}: missing tools IPC host delegation ${symbol}`),
    ...(fs.existsSync(mainToolsFile)
      ? matchingLines(mainToolsFile, MAIN_TOOLS_IPC_HOST_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/main/ipc/tools.ts: missing tools IPC adapter']),
  ]

  assertNoMatches('apps/electron owns Electron tools IPC host operations', lines)
}

function checkElectronHostOwnsAuthElectronAdapters(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronAuthFetchFile = path.join(root, 'apps/electron/src/auth/auth-fetch.ts')
  const electronAuthFile = path.join(root, 'apps/electron/src/auth/electron-auth.ts')
  const electronTokenStoreFile = path.join(root, 'apps/electron/src/auth/token-store.ts')
  const mainAuthFile = path.join(root, 'packages/backend/wiring/auth/auth-service.ts')
  const mainTokenStoreFile = path.join(root, 'packages/onething-runtime/src/auth/token-store.wiring.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronAuthFetchContent = fs.existsSync(electronAuthFetchFile)
    ? fs.readFileSync(electronAuthFetchFile, 'utf-8')
    : ''
  const electronAuthContent = fs.existsSync(electronAuthFile) ? fs.readFileSync(electronAuthFile, 'utf-8') : ''
  const electronTokenStoreContent = fs.existsSync(electronTokenStoreFile)
    ? fs.readFileSync(electronTokenStoreFile, 'utf-8')
    : ''
  const mainAuthContent = fs.existsSync(mainAuthFile) ? fs.readFileSync(mainAuthFile, 'utf-8') : ''
  const mainTokenStoreContent = fs.existsSync(mainTokenStoreFile) ? fs.readFileSync(mainTokenStoreFile, 'utf-8') : ''
  const requiredHostSymbols = [
    'createRequire',
    "require('electron')",
    'resolveElectronNetFetch',
    'getElectronNetFetch',
    'electronNet?.fetch',
    'resolveElectronSafeStorage',
    'getElectronSafeStorage',
    'safeStorage',
  ]
  const requiredAuthFetchHostSymbols = [
    'createElectronAuthFetch',
    'getElectronNetFetch',
    'fallbackFetch',
    'getElectronFetch',
    'net.fetch failed; falling back to app fetch',
  ]
  // main/auth is host-agnostic: net.fetch/safeStorage arrive via
  // configureAuthHost (wired in app/main-process.ts), with app-fetch and
  // plaintext token fallbacks when unset.
  const requiredAuthFacadeSymbols = [
    'getAuthHostPorts',
    'authFetch',
    'createRequiredAppFetch',
  ]
  const requiredTokenStoreHostFacadeSymbols = [
    'getDefaultOnethingTokenFilePath',
    'OnethingTokenStore',
    'getElectronSafeStorage',
    'cryptoAdapter: getElectronSafeStorage',
    'OAuthToken',
  ]
  const requiredTokenStoreLegacyFacadeSymbols = [
    'getAuthHostPorts',
    'tokenCryptoAdapter',
    'TokenStore',
    'tokenStore',
  ]
  const mainTokenStoreFacadeLines = mainTokenStoreContent.split('\n').filter(line => line.trim().length > 0)
  const lines = [
    ...(!packageContent.includes('./auth/auth-fetch')
      ? [`${rel(electronPackage)}: missing auth fetch host export`]
      : []),
    ...(!packageContent.includes('./auth/electron-auth')
      ? [`${rel(electronPackage)}: missing auth electron adapter export`]
      : []),
    ...(!packageContent.includes('./auth/token-store')
      ? [`${rel(electronPackage)}: missing auth token-store host export`]
      : []),
    ...requiredHostSymbols
      .filter(symbol => !electronAuthContent.includes(symbol))
      .map(symbol => `${rel(electronAuthFile)}: missing Electron auth adapter symbol ${symbol}`),
    ...requiredAuthFetchHostSymbols
      .filter(symbol => !electronAuthFetchContent.includes(symbol))
      .map(symbol => `${rel(electronAuthFetchFile)}: missing Electron auth fetch host symbol ${symbol}`),
    ...requiredAuthFacadeSymbols
      .filter(symbol => !mainAuthContent.includes(symbol))
      .map(symbol => `${rel(mainAuthFile)}: missing auth service facade delegation ${symbol}`),
    ...requiredTokenStoreHostFacadeSymbols
      .filter(symbol => !electronTokenStoreContent.includes(symbol))
      .map(symbol => `${rel(electronTokenStoreFile)}: missing Electron token store host facade symbol ${symbol}`),
    ...requiredTokenStoreLegacyFacadeSymbols
      .filter(symbol => !mainTokenStoreContent.includes(symbol))
      .map(symbol => `${rel(mainTokenStoreFile)}: missing token store legacy facade symbol ${symbol}`),
    ...(mainTokenStoreContent.includes('@onething/electron-host/')
      ? [`${rel(mainTokenStoreFile)}: main/auth token store must stay host-agnostic (inject via configureAuthHost)`]
      : []),
    ...(fs.existsSync(mainAuthFile)
      ? matchingLines(mainAuthFile, MAIN_AUTH_SERVICE_RUNTIME_FORBIDDEN_PATTERNS)
      : ['packages/backend/wiring/auth/auth-service.ts: missing auth service facade']),
    ...(fs.existsSync(mainTokenStoreFile)
      ? matchingLines(mainTokenStoreFile, MAIN_AUTH_TOKEN_STORE_FORBIDDEN_PATTERNS)
      : ['packages/onething-runtime/src/auth/token-store.wiring.ts: missing token store facade']),
  ]

  assertNoMatches('apps/electron owns Electron auth adapters', lines)
}

function checkElectronHostOwnsSkillsEnvironment(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronSkillsFile = path.join(root, 'apps/electron/src/skills/environment.ts')
  const mainSkillsFile = path.join(root, 'packages/backend/wiring/skills/loader.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronSkillsContent = fs.existsSync(electronSkillsFile) ? fs.readFileSync(electronSkillsFile, 'utf-8') : ''
  const mainSkillsContent = fs.existsSync(mainSkillsFile) ? fs.readFileSync(mainSkillsFile, 'utf-8') : ''
  const requiredHostSymbols = [
    'createRequire',
    "require('electron')",
    'resolveElectronAppIsPackaged',
    'getElectronAppIsPackaged',
    'getElectronResourcesPath',
    'process.resourcesPath',
  ]
  // main/skills is host-agnostic: packaged-app resource getters are injected
  // via configureSkillsEnvironmentHost, wired by the Electron host at startup.
  const requiredFacadeSymbols = [
    'configureSkillsEnvironmentHost',
    'envPorts.isPackaged',
    'envPorts.getResourcesPath',
  ]
  const mainProcessWiringFile = path.join(root, 'apps/electron/src/app/main-process.ts')
  const mainProcessWiringContent = fs.existsSync(mainProcessWiringFile) ? fs.readFileSync(mainProcessWiringFile, 'utf-8') : ''
  const lines = [
    ...(!packageContent.includes('./skills/environment')
      ? [`${rel(electronPackage)}: missing skills environment export`]
      : []),
    ...(!mainProcessWiringContent.includes('configureSkillsEnvironmentHost')
      ? [`${rel(mainProcessWiringFile)}: Electron host must wire configureSkillsEnvironmentHost`]
      : []),
    ...(mainSkillsContent.includes('@onething/electron-host/')
      ? [`${rel(mainSkillsFile)}: main/skills must stay host-agnostic (inject via configureSkillsEnvironmentHost)`]
      : []),
    ...requiredHostSymbols
      .filter(symbol => !electronSkillsContent.includes(symbol))
      .map(symbol => `${rel(electronSkillsFile)}: missing Electron skills environment symbol ${symbol}`),
    ...requiredFacadeSymbols
      .filter(symbol => !mainSkillsContent.includes(symbol))
      .map(symbol => `${rel(mainSkillsFile)}: missing skills loader environment delegation ${symbol}`),
    ...(fs.existsSync(mainSkillsFile)
      ? matchingLines(mainSkillsFile, MAIN_SKILLS_LOADER_FORBIDDEN_PATTERNS)
      : ['packages/backend/wiring/skills/loader.ts: missing skills loader facade']),
  ]

  assertNoMatches('apps/electron owns Electron skills environment', lines)
}

function checkElectronHostOwnsNetworkProxy(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronProxyFile = path.join(root, 'apps/electron/src/network/proxy.ts')
  const mainProxyFile = path.join(root, 'apps/electron/src/main/ipc/network-proxy.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronProxyContent = fs.existsSync(electronProxyFile) ? fs.readFileSync(electronProxyFile, 'utf-8') : ''
  const mainProxyContent = fs.existsSync(mainProxyFile) ? fs.readFileSync(mainProxyFile, 'utf-8') : ''
  const requiredHostSymbols = [
    'applyElectronNetworkProxySettings',
    'session.defaultSession',
    'setProxy',
    'fixed_servers',
    'direct',
  ]
  const requiredFacadeSymbols = [
    '@onething/electron-host/network/proxy',
    'applyElectronNetworkProxySettings',
    'buildElectronProxyRules',
    'clearAppDispatcherCache',
    'validateProxyUrl',
  ]
  const lines = [
    ...(!packageContent.includes('./network/proxy')
      ? [`${rel(electronPackage)}: missing network proxy export`]
      : []),
    ...requiredHostSymbols
      .filter(symbol => !electronProxyContent.includes(symbol))
      .map(symbol => `${rel(electronProxyFile)}: missing Electron network proxy symbol ${symbol}`),
    ...requiredFacadeSymbols
      .filter(symbol => !mainProxyContent.includes(symbol))
      .map(symbol => `${rel(mainProxyFile)}: missing network proxy facade delegation ${symbol}`),
    ...(fs.existsSync(mainProxyFile)
      ? matchingLines(mainProxyFile, MAIN_NETWORK_PROXY_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/main/ipc/network-proxy.ts: missing network proxy facade']),
  ]

  assertNoMatches('apps/electron owns Electron network proxy application', lines)
}

function checkElectronHostOwnsGlobalShortcuts(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronShortcutsFile = path.join(root, 'apps/electron/src/shortcuts/global-shortcuts.ts')
  const electronMainFile = path.join(root, 'apps/electron/src/app/main-process.ts')
  const mainShortcutsFile = path.join(root, 'packages/backend/shortcuts/global-shortcuts.ts')
  const mainSettingsIpcFile = path.join(root, 'apps/electron/src/main/ipc/settings.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronShortcutsContent = fs.existsSync(electronShortcutsFile)
    ? fs.readFileSync(electronShortcutsFile, 'utf-8')
    : ''
  const mainSettingsIpcContent = fs.existsSync(mainSettingsIpcFile) ? fs.readFileSync(mainSettingsIpcFile, 'utf-8') : ''
  const electronMainContent = fs.existsSync(electronMainFile) ? fs.readFileSync(electronMainFile, 'utf-8') : ''
  const requiredHostSymbols = [
    'configureGlobalWindowShortcuts',
    'createElectronGlobalShortcutController',
    'globalShortcut',
    'shortcutToAccelerator',
    'registerGlobalWindowShortcuts',
    'unregisterGlobalWindowShortcuts',
    'normalizeKey',
    'registeredAccelerators',
  ]
  const requiredHostFacadeSymbols = [
    'createElectronGlobalShortcutController',
    'toggleTodoPlanWindow',
    'preserve-current-app',
  ]
  const lines = [
    ...(!packageContent.includes('./shortcuts/global-shortcuts')
      ? [`${rel(electronPackage)}: missing global shortcuts export`]
      : []),
    ...requiredHostSymbols
      .filter(symbol => !electronShortcutsContent.includes(symbol))
      .map(symbol => `${rel(electronShortcutsFile)}: missing Electron global shortcuts symbol ${symbol}`),
    ...requiredHostFacadeSymbols
      .filter(symbol => !electronShortcutsContent.includes(symbol))
      .map(symbol => `${rel(electronShortcutsFile)}: missing Electron global shortcuts host facade symbol ${symbol}`),
    ...(electronShortcutsContent.includes('@main/')
      ? [`${rel(electronShortcutsFile)}: Electron global shortcuts host must not import @main runtime modules`]
      : []),
    ...(!electronMainContent.includes('configureGlobalWindowShortcuts')
      ? [`${rel(electronMainFile)}: Electron app bootstrap must configure global shortcuts from runtime settings`]
      : []),
    ...(!electronMainContent.includes('getSettings().general?.shortcuts')
      ? [`${rel(electronMainFile)}: Electron app bootstrap must inject shortcut settings into electron-host`]
      : []),
    ...(!mainSettingsIpcContent.includes('@onething/electron-host/shortcuts/global-shortcuts')
      ? [`${rel(mainSettingsIpcFile)}: settings IPC must import global shortcuts from electron-host directly`]
      : []),
    ...(mainSettingsIpcContent.includes('../shortcuts/global-shortcuts')
      ? [`${rel(mainSettingsIpcFile)}: settings IPC must not import legacy global shortcuts facade`]
      : []),
    ...(!electronMainContent.includes('@onething/electron-host/shortcuts/global-shortcuts')
      ? [`${rel(electronMainFile)}: Electron app bootstrap must import global shortcuts from electron-host`]
      : []),
    ...(electronMainContent.includes('@main/shortcuts/global-shortcuts')
      ? [`${rel(electronMainFile)}: Electron app bootstrap must not import global shortcuts through legacy @main facade`]
      : []),
    ...(fs.existsSync(mainShortcutsFile)
      ? [`${rel(mainShortcutsFile)}: remove legacy global shortcuts facade; use @onething/electron-host/shortcuts/global-shortcuts directly`]
      : []),
  ]

  assertNoMatches('apps/electron owns Electron global shortcuts', lines)
}

function checkElectronHostOwnsPowerResumeHandlers(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronPowerFile = path.join(root, 'apps/electron/src/power/resume.ts')
  const mainFile = path.join(root, 'apps/electron/src/app/main-process.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronPowerContent = fs.existsSync(electronPowerFile) ? fs.readFileSync(electronPowerFile, 'utf-8') : ''
  const mainContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf-8') : ''
  const requiredPowerSymbols = [
    'registerElectronPowerResumeHandlers',
    'powerMonitor',
    'unlock-screen',
    'recoverMainWindow',
    'Resume',
    'Unlock',
    'recovery failed',
  ]
  const lines = [
    ...(!packageContent.includes('./power/resume')
      ? [`${rel(electronPackage)}: missing power resume export`]
      : []),
    ...requiredPowerSymbols
      .filter(symbol => !electronPowerContent.includes(symbol))
      .map(symbol => `${rel(electronPowerFile)}: missing Electron power resume symbol ${symbol}`),
    ...(!mainContent.includes('registerElectronPowerResumeHandlers')
      && !mainContent.includes('registerElectronAppBootstrap')
      ? [`${rel(mainFile)}: main must delegate power resume handlers to apps/electron`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_POWER_RESUME_FORBIDDEN_PATTERNS)
      : ['packages/backend/index.ts: missing Electron main entry']),
  ]

  assertNoMatches('apps/electron owns Electron power resume handlers', lines)
}

function checkElectronHostOwnsAppBootstrap(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronBootstrapFile = path.join(root, 'apps/electron/src/app/bootstrap.ts')
  const mainProcessFile = path.join(root, 'apps/electron/src/app/main-process.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronBootstrapContent = fs.existsSync(electronBootstrapFile)
    ? fs.readFileSync(electronBootstrapFile, 'utf-8')
    : ''
  const mainProcessContent = fs.existsSync(mainProcessFile) ? fs.readFileSync(mainProcessFile, 'utf-8') : ''
  const requiredHostSymbols = [
    'registerElectronAppBootstrap',
    'configureElectronStorePathHost',
    'registerElectronReadyHandler',
    'createAndBindElectronMainWindow',
    'registerElectronActivateHandler',
    'registerElectronDidBecomeActiveHandler',
    'registerElectronWindowAllClosedHandler',
    'registerElectronBeforeQuitCleanup',
    'registerElectronMediaProtocol',
    'registerElectronPowerResumeHandlers',
  ]
  const requiredMainSymbols = [
    '@onething/electron-host/app/bootstrap',
    'registerElectronAppBootstrap',
    'storePathHost',
    'createMainWindowOptions',
    'afterMainWindowCreated',
    'startPostWindowServices',
  ]
  const lines = [
    ...(!packageContent.includes('./app/bootstrap')
      ? [`${rel(electronPackage)}: missing Electron app bootstrap export`]
      : []),
    ...requiredHostSymbols
      .filter(symbol => !electronBootstrapContent.includes(symbol))
      .map(symbol => `${rel(electronBootstrapFile)}: missing Electron app bootstrap symbol ${symbol}`),
    ...requiredMainSymbols
      .filter(symbol => !mainProcessContent.includes(symbol))
      .map(symbol => `${rel(mainProcessFile)}: missing Electron app bootstrap delegation ${symbol}`),
    ...(fs.existsSync(mainProcessFile)
      ? matchingLines(mainProcessFile, MAIN_APP_BOOTSTRAP_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/app/main-process.ts: missing Electron main process implementation']),
  ]

  assertNoMatches('apps/electron owns Electron app lifecycle bootstrap', lines)
}

function checkElectronHostOwnsMainEntry(): void {
  const electronMainFile = path.join(root, 'apps/electron/src/main.ts')
  const electronMainProcessFile = path.join(root, 'apps/electron/src/app/main-process.ts')
  const viteConfig = path.join(root, 'electron.vite.config.ts')
  const electronMainContent = fs.existsSync(electronMainFile) ? fs.readFileSync(electronMainFile, 'utf-8') : ''
  const electronMainProcessContent = fs.existsSync(electronMainProcessFile) ? fs.readFileSync(electronMainProcessFile, 'utf-8') : ''
  const viteContent = fs.existsSync(viteConfig) ? fs.readFileSync(viteConfig, 'utf-8') : ''
  // 08-21:两条 "legacy Electron main facade" 断言(`packages/backend/index.ts`
  // 必须再导出 `@onething/electron-host/app/main-process`、且必须保持 ≤5 行)已删。
  // 该文件早已不存在,而且断言与 `checkRuntimeHostBoundary` 的
  // `APP_ASSEMBLY_FORBIDDEN_PATTERNS`(装配层禁 import `@onething/electron-host`)
  // 直接互斥 —— 一条要求装配层引宿主,另一条禁止它。留下的是宿主侧那三条真断言。
  const lines = [
    ...(!electronMainContent.includes('startOnethingElectronMain')
      ? [`${rel(electronMainFile)}: missing Electron-hosted main entry startup call`]
      : []),
    ...(!electronMainContent.includes('./app/main-process.js')
      ? [`${rel(electronMainFile)}: Electron main entry must start apps/electron app/main-process`]
      : []),
    ...(!electronMainProcessContent.includes('export function startOnethingElectronMain')
      ? [`${rel(electronMainProcessFile)}: missing callable onething Electron main process export`]
      : []),
    ...(!viteContent.includes("index: resolve(__dirname, 'apps/electron/src/main.ts')")
      ? [`${rel(viteConfig)}: Electron main input must point at apps/electron/src/main.ts`]
      : []),
    ...(fs.existsSync(viteConfig)
      ? matchingLines(viteConfig, ELECTRON_MAIN_ENTRY_FORBIDDEN_PATTERNS)
      : ['electron.vite.config.ts: missing Electron Vite config']),
  ]

  assertNoMatches('apps/electron owns Electron main process entrypoint', lines)
}

function checkElectronHostOwnsPreloadEntry(): void {
  const electronPreloadFile = path.join(root, 'apps/electron/src/preload.ts')
  const preloadBridgeFile = path.join(root, 'apps/electron/src/preload/bridge.ts')
  const legacyPreloadDir = path.join(root, 'src/preload')
  const viteConfig = path.join(root, 'electron.vite.config.ts')
  const electronPreloadContent = fs.existsSync(electronPreloadFile) ? fs.readFileSync(electronPreloadFile, 'utf-8') : ''
  const preloadBridgeContent = fs.existsSync(preloadBridgeFile) ? fs.readFileSync(preloadBridgeFile, 'utf-8') : ''
  const viteContent = fs.existsSync(viteConfig) ? fs.readFileSync(viteConfig, 'utf-8') : ''
  const legacyPreloadFiles = walkFiles(legacyPreloadDir)
    .filter(file => !rel(file).split('/').some(part => part.startsWith('.')))
  const lines = [
    ...(!electronPreloadContent.includes('installOnethingPreloadBridge')
      ? [`${rel(electronPreloadFile)}: missing Electron-hosted preload bridge install call`]
      : []),
    ...(!electronPreloadContent.includes('./preload/bridge.js')
      ? [`${rel(electronPreloadFile)}: Electron preload entry must install the apps/electron preload bridge`]
      : []),
    ...(!preloadBridgeContent.includes('export function installOnethingPreloadBridge')
      ? [`${rel(preloadBridgeFile)}: missing callable onething preload bridge export`]
      : []),
    ...(!viteContent.includes("index: resolve(__dirname, 'apps/electron/src/preload.ts')")
      ? [`${rel(viteConfig)}: Electron preload input must point at apps/electron/src/preload.ts`]
      : []),
    // P3'd:`onethingPackageAliases` 整张表已随 `@onething/backend` 成包退役
    // (@onething/* 全是真 workspace 包,走 node 解析 + 各包 exports)。这里改
    // 守剩下的那一条:preload 段必须能解析 apps/electron 自己的路径族。
    ...(!/preload:\s*\{[\s\S]*?resolve:\s*\{[\s\S]*?\.\.\.electronHostAliases/.test(viteContent)
      ? [`${rel(viteConfig)}: Electron preload build must resolve electron-host aliases`]
      : []),
    ...(fs.existsSync(viteConfig)
      ? matchingLines(viteConfig, ELECTRON_PRELOAD_ENTRY_FORBIDDEN_PATTERNS)
      : ['electron.vite.config.ts: missing Electron Vite config']),
    ...legacyPreloadFiles.map(file => `${rel(file)}: Electron preload implementation must live under apps/electron/src/preload`),
  ]

  assertNoMatches('apps/electron owns Electron preload entrypoint', lines)
}

function checkMainUsesRuntimePackageImports(): void {
  const lines = walkFiles(path.join(root, 'packages/backend'), [], { includeTests: true })
    .flatMap(file => matchingImportSpecifierLines(file, MAIN_RUNTIME_SOURCE_IMPORT_FORBIDDEN_PATTERNS))
  assertNoMatches('Electron main and tests import onething-runtime via package public entrypoints', lines)
}

function checkMainFacadesUseElectronHostImports(): void {
  const lines = walkFiles(path.join(root, 'packages/backend'))
    .flatMap(file => matchingLines(file, MAIN_DIRECT_ELECTRON_IMPORT_FORBIDDEN_PATTERNS))
  assertNoMatches('Electron main facades use apps/electron host imports instead of direct electron imports', lines)
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
    ...(!coreToolResultContent.includes("from '../permission/index.js'")
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
  const chatFile = path.join(root, 'apps/electron/src/main/ipc/chat.ts')
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
    ...(fs.existsSync(chatFile)
      ? matchingLines(chatFile, MAIN_SAFE_SESSION_EVENT_EMIT_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/main/ipc/chat.ts: missing chat IPC adapter']),
    // P4c 第五批:同一条规矩也守 chat RPC 域(停止收尾在那里发会话事件)。
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

function checkCoreOwnsIpcRouterProtocol(): void {
  const coreFile = path.join(root, 'packages/core/ipc/index.ts')
  const coreIndexFile = path.join(root, 'packages/core/index.ts')
  const corePackageFile = path.join(root, 'packages/core/package.json')
  const coreTestFile = path.join(root, 'packages/core/ipc/__tests__/router.test.ts')
  const sharedFile = path.join(root, 'packages/shared/ipc/router.ts')
  const legacySharedTestFile = path.join(root, 'packages/shared/ipc/__tests__/router.test.ts')
  const preloadCreateApiFile = path.join(root, 'apps/electron/src/preload/create-api.ts')
  const coreContent = fs.existsSync(coreFile) ? fs.readFileSync(coreFile, 'utf-8') : ''
  const coreIndexContent = fs.existsSync(coreIndexFile) ? fs.readFileSync(coreIndexFile, 'utf-8') : ''
  const corePackageContent = fs.existsSync(corePackageFile) ? fs.readFileSync(corePackageFile, 'utf-8') : ''
  const coreTestContent = fs.existsSync(coreTestFile) ? fs.readFileSync(coreTestFile, 'utf-8') : ''
  const sharedContent = fs.existsSync(sharedFile) ? fs.readFileSync(sharedFile, 'utf-8') : ''
  const preloadCreateApiContent = fs.existsSync(preloadCreateApiFile) ? fs.readFileSync(preloadCreateApiFile, 'utf-8') : ''
  const requiredSymbols = [
    'RoutePayload',
    'RouteConfig',
    'DomainRoutes',
    'Router',
    'RouteHandlers',
    'RouteAPI',
    'getChannelName',
    'defineRouter',
  ]
  const requiredTestCoverage = [
    'getChannelName',
    'defineRouter',
    'preserves legacy channel naming compatibility',
  ]
  const lines = [
    ...(!fs.existsSync(coreFile)
      ? [`${rel(coreFile)}: missing core-owned IPC router protocol`]
      : []),
    ...(!fs.existsSync(coreTestFile)
      ? [`${rel(coreTestFile)}: missing core-owned IPC router protocol tests`]
      : []),
    ...requiredSymbols
      .filter(symbol => !coreContent.includes(symbol))
      .map(symbol => `${rel(coreFile)}: missing core-owned IPC router symbol ${symbol}`),
    ...requiredSymbols
      .filter(symbol => !coreIndexContent.includes(symbol))
      .map(symbol => `${rel(coreIndexFile)}: missing public core IPC router export ${symbol}`),
    ...requiredTestCoverage
      .filter(symbol => !coreTestContent.includes(symbol))
      .map(symbol => `${rel(coreTestFile)}: missing IPC router protocol test coverage for ${symbol}`),
    ...(!corePackageContent.includes('"./ipc": "./ipc/index.ts"')
      ? [`${rel(corePackageFile)}: missing public @onething/core/ipc export`]
      : []),
    ...(!sharedContent.includes('@onething/core/ipc')
      ? [`${rel(sharedFile)}: legacy shared IPC router must re-export core protocol`]
      : []),
    ...(fs.existsSync(sharedFile)
      ? matchingLines(sharedFile, SHARED_IPC_ROUTER_FORBIDDEN_PATTERNS)
      : [`${rel(sharedFile)}: missing legacy IPC router facade`]),
    ...(fs.existsSync(legacySharedTestFile)
      ? [`${rel(legacySharedTestFile)}: IPC router protocol tests must live in packages/core`]
      : []),
    ...(!preloadCreateApiContent.includes('@onething/core/ipc')
      ? [`${rel(preloadCreateApiFile)}: Electron preload API factory must import IPC router protocol from @onething/core/ipc`]
      : []),
    ...(preloadCreateApiContent.includes('packages/shared/ipc/router') || preloadCreateApiContent.includes('../../shared/ipc/router')
      ? [`${rel(preloadCreateApiFile)}: Electron preload API factory must not import legacy shared IPC router protocol`]
      : []),
  ]

  assertNoMatches('packages/core owns IPC router protocol', lines)
}

function checkElectronHostOwnsChatIpcHost(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronChatFile = path.join(root, 'apps/electron/src/ipc/chat.ts')
  const mainChatFile = path.join(root, 'apps/electron/src/main/ipc/chat.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronChatContent = fs.existsSync(electronChatFile) ? fs.readFileSync(electronChatFile, 'utf-8') : ''
  const mainChatContent = fs.existsSync(mainChatFile) ? fs.readFileSync(mainChatFile, 'utf-8') : ''
  // P4c 第五批:六条数据面迁 `chatRouter`,工厂与壳适配**只缩不删** —— 留下的
  // 是第七条 `RESUME_AFTER_TOOL_CONFIRM`(拍板 #21:它往引擎递 `event.sender`,
  // 而 router 的信封里没有「谁在问」这一格)。断言因此只守这一条:六条的归宿
  // 在 `packages/backend/rpc/domains/chat.ts`,由域测试钉。
  const requiredHostSymbols = [
    'registerElectronChatIpcHandlers',
    'options.ipcMain ?? ipcMain',
    'host.handle',
    'ElectronChatIpcChannels',
    'ElectronChatIpcInvokeEvent',
    'options.resumeAfterToolConfirm(request, (event as ElectronChatIpcInvokeEvent).sender)',
  ]
  const requiredFacadeSymbols = [
    '@onething/electron-host/ipc/chat',
    'registerElectronChatIpcHandlers',
    'IPC_CHANNELS.RESUME_AFTER_TOOL_CONFIRM',
    'resumeOnethingAfterToolConfirmationForIpc',
  ]
  const lines = [
    ...(!packageContent.includes('./ipc/chat')
      ? [`${rel(electronPackage)}: missing chat IPC host export`]
      : []),
    ...requiredHostSymbols
      .filter(symbol => !electronChatContent.includes(symbol))
      .map(symbol => `${rel(electronChatFile)}: missing Electron chat IPC host symbol ${symbol}`),
    ...requiredFacadeSymbols
      .filter(symbol => !mainChatContent.includes(symbol))
      .map(symbol => `${rel(mainChatFile)}: missing chat IPC host delegation ${symbol}`),
    ...(fs.existsSync(mainChatFile)
      ? matchingLines(mainChatFile, MAIN_CHAT_IPC_HOST_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/main/ipc/chat.ts: missing chat IPC adapter']),
  ]

  assertNoMatches('apps/electron owns Electron chat IPC host operations', lines)
}

function checkElectronHostOwnsFilesIpcHost(): void {
  const electronPackage = path.join(root, 'apps/electron/package.json')
  const electronFilesFile = path.join(root, 'apps/electron/src/ipc/files.ts')
  const mainFilesFile = path.join(root, 'apps/electron/src/main/ipc/files.ts')
  const packageContent = fs.existsSync(electronPackage) ? fs.readFileSync(electronPackage, 'utf-8') : ''
  const electronFilesContent = fs.existsSync(electronFilesFile) ? fs.readFileSync(electronFilesFile, 'utf-8') : ''
  const mainFilesContent = fs.existsSync(mainFilesFile) ? fs.readFileSync(mainFilesFile, 'utf-8') : ''
  const requiredHostSymbols = [
    'registerElectronFilesIpcHandlers',
    'options.ipcMain ?? ipcMain',
    'host.handle',
    'ElectronFilesIpcChannels',
  ]
  const requiredFacadeSymbols = [
    '@onething/electron-host/ipc/files',
    'registerElectronFilesIpcHandlers',
    'IPC_CHANNELS.FILES_LIST',
    'IPC_CHANNELS.FILE_ROLLBACK',
    'IPC_CHANNELS.DIRS_LIST',
    'IPC_CHANNELS.FILE_READ_CONTENT',
    'IPC_CHANNELS.FILE_SAVE_CONTENT',
    'IPC_CHANNELS.FILE_LIST_DIRECTORY',
    'IPC_CHANNELS.FILE_STAT',
    'IPC_CHANNELS.FILE_CREATE',
    'IPC_CHANNELS.FILE_CREATE_DIRECTORY',
    'IPC_CHANNELS.FILE_RENAME',
    'IPC_CHANNELS.FILE_DELETE',
    'IPC_CHANNELS.FILE_REVEAL',
    'IPC_CHANNELS.FILE_WATCH_START',
    'IPC_CHANNELS.FILE_WATCH_STOP',
  ]
  const lines = [
    ...(!packageContent.includes('./ipc/files')
      ? [`${rel(electronPackage)}: missing files IPC host export`]
      : []),
    ...requiredHostSymbols
      .filter(symbol => !electronFilesContent.includes(symbol))
      .map(symbol => `${rel(electronFilesFile)}: missing Electron files IPC host symbol ${symbol}`),
    ...requiredFacadeSymbols
      .filter(symbol => !mainFilesContent.includes(symbol))
      .map(symbol => `${rel(mainFilesFile)}: missing files IPC host delegation ${symbol}`),
    ...(fs.existsSync(mainFilesFile)
      ? matchingLines(mainFilesFile, MAIN_FILES_IPC_HOST_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/main/ipc/files.ts: missing files IPC adapter']),
  ]

  assertNoMatches('apps/electron owns Electron files IPC host operations', lines)
}

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

function checkRuntimeOwnsStoreLock(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/storage/store-lock.ts')
  const runtimeIndexFile = path.join(root, 'packages/onething-runtime/src/storage/index.ts')
  const runtimeTestFile = path.join(root, 'packages/onething-runtime/src/storage/__tests__/store-lock.test.ts')
  const sharedFile = path.join(root, 'packages/shared/backend/store-lock.ts')
  const sharedTestFile = path.join(root, 'packages/shared/backend/__tests__/store-lock.test.ts')
  const electronMainFile = path.join(root, 'apps/electron/src/app/main-process.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const runtimeIndexContent = fs.existsSync(runtimeIndexFile) ? fs.readFileSync(runtimeIndexFile, 'utf-8') : ''
  const runtimeTestContent = fs.existsSync(runtimeTestFile) ? fs.readFileSync(runtimeTestFile, 'utf-8') : ''
  const sharedContent = fs.existsSync(sharedFile) ? fs.readFileSync(sharedFile, 'utf-8') : ''
  const electronMainContent = fs.existsSync(electronMainFile) ? fs.readFileSync(electronMainFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'StoreLock',
    'LockConflictError',
    'readLockMeta',
    'formatCliLockConflict',
    'formatDesktopLockConflict',
    'getOnethingStorePath',
  ]
  const lines = [
    ...(!fs.existsSync(runtimeFile)
      ? [`${rel(runtimeFile)}: missing runtime-owned store lock`]
      : []),
    ...(!fs.existsSync(runtimeTestFile)
      ? [`${rel(runtimeTestFile)}: missing runtime-owned store lock tests`]
      : []),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned store lock symbol ${symbol}`),
    ...['StoreLock', 'LockConflictError', 'formatCliLockConflict']
      .filter(symbol => !runtimeTestContent.includes(symbol))
      .map(symbol => `${rel(runtimeTestFile)}: missing runtime store lock test coverage for ${symbol}`),
    ...(!runtimeIndexContent.includes("./store-lock.js")
      ? [`${rel(runtimeIndexFile)}: missing store lock public export`]
      : []),
    ...(!sharedContent.includes('@onething/runtime/storage')
      ? [`${rel(sharedFile)}: legacy shared store lock must re-export runtime storage`]
      : []),
    ...(fs.existsSync(sharedFile)
      ? matchingLines(sharedFile, SHARED_BACKEND_STORE_LOCK_FORBIDDEN_PATTERNS)
      : [`${rel(sharedFile)}: missing legacy store lock facade`]),
    ...(fs.existsSync(sharedTestFile)
      ? [`${rel(sharedTestFile)}: store lock tests belong in packages/onething-runtime/src/storage/__tests__`]
      : []),
    ...(!electronMainContent.includes('@onething/runtime/storage')
      ? [`${rel(electronMainFile)}: Electron host must import store lock from runtime storage public API`]
      : []),
  ]

  assertNoMatches('packages/onething-runtime owns store lock runtime', lines)
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
  const requiredRuntimeSymbols = [
    'createOnethingStreamProcessor',
    'createCoreStreamProcessor',
    'createCoreId',
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

function checkRuntimeOwnsSessionMessageRuntime(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/sessions/session-message-runtime.ts')
  const runtimeTestFile = path.join(root, 'packages/onething-runtime/src/sessions/__tests__/session-message-runtime.test.ts')
  const runtimeIndexFile = path.join(root, 'packages/onething-runtime/src/sessions/index.ts')
  const mainStoreFile = path.join(root, 'packages/backend/stores/sessions.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const runtimeIndexContent = fs.existsSync(runtimeIndexFile) ? fs.readFileSync(runtimeIndexFile, 'utf-8') : ''
  const mainStoreContent = fs.existsSync(mainStoreFile) ? fs.readFileSync(mainStoreFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'createOnethingSessionMessageRuntime',
    'OnethingSessionMessageRuntime',
    'syncMessageToSqliteIfReady',
    'updateMessageAndTruncate',
    'updateStepsUsageByTurn',
  ]
  const lines = [
    ...(!fs.existsSync(runtimeFile)
      ? [`${rel(runtimeFile)}: missing runtime-owned session message runtime`]
      : []),
    ...(!fs.existsSync(runtimeTestFile)
      ? [`${rel(runtimeTestFile)}: missing runtime-owned session message runtime tests`]
      : []),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned session message runtime symbol ${symbol}`),
    ...(!runtimeIndexContent.includes('./session-message-runtime.js')
      ? [`${rel(runtimeIndexFile)}: missing session message runtime public export`]
      : []),
    ...(!mainStoreContent.includes('createOnethingSessionMessageRuntime')
      ? [`${rel(mainStoreFile)}: main sessions facade must delegate message mutations to createOnethingSessionMessageRuntime`]
      : []),
    ...(fs.existsSync(mainStoreFile)
      ? matchingLines(mainStoreFile, MAIN_SESSION_MESSAGE_RUNTIME_FORBIDDEN_PATTERNS)
      : ['packages/backend/stores/sessions.ts: missing sessions store facade']),
  ]

  assertNoMatches('packages/onething-runtime owns session message mutation runtime', lines)
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
    path.join(root, 'apps/electron/src/main/ipc/chat.ts'),
    // P4c 第五批:会话与聊天两份调用点都已是 RPC 域。
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
  // P4c 第五批:聊天面的六条已是 RPC 域,所以这条守的是**两处** —— 域文件,
  // 以及只剩第七条的那层壳适配。
  const mainFiles = [
    path.join(root, 'packages/backend/rpc/domains/chat.ts'),
    path.join(root, 'apps/electron/src/main/ipc/chat.ts'),
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

function checkRuntimeOwnsResumeAfterToolConfirmationFlow(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/sessions/tool-confirmation.ts')
  const mainFile = path.join(root, 'apps/electron/src/main/ipc/chat.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const lines = [
    ...(!runtimeContent.includes('resumeOnethingAfterToolConfirmation')
      ? [`${rel(runtimeFile)}: missing runtime-owned resume-after-tool-confirmation flow`]
      : []),
    ...(!runtimeContent.includes('resumeOnethingAfterToolConfirmationForIpc')
      ? [`${rel(runtimeFile)}: missing runtime-owned resume-after-tool-confirmation IPC wrapper`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_CHAT_IPC_RESUME_CONFIRM_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/main/ipc/chat.ts: missing chat IPC adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns resume-after-tool-confirmation flow', lines)
}

function checkRuntimeOwnsToolCallStateProjection(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/tools/tool-call-state.ts')
  const mainFile = path.join(root, 'apps/electron/src/main/ipc/tools.ts')
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
      : ['apps/electron/src/main/ipc/tools.ts: missing tools IPC adapter']),
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
  const mainFile = path.join(root, 'apps/electron/src/main/ipc/tools.ts')
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
      : ['apps/electron/src/main/ipc/tools.ts: missing tools IPC adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns settings-visible tool list projection', lines)
}

function checkRuntimeOwnsToolsIpcExecutionContext(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/tools/tool-execution-context.ts')
  const mainFile = path.join(root, 'apps/electron/src/main/ipc/tools.ts')
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
      : ['apps/electron/src/main/ipc/tools.ts: missing tools IPC adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns tool execution context assembly', lines)
}

function checkRuntimeOwnsToolsIpcBackgroundJobs(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/tools/ipc-operations.ts')
  const mainFile = path.join(root, 'apps/electron/src/main/ipc/tools.ts')
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
      : ['apps/electron/src/main/ipc/tools.ts: missing tools IPC adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns tools background-job IPC operations', lines)
}

function checkRuntimeOwnsSettingsSaveOrchestration(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/settings/settings-save.ts')
  const runtimeIpcFile = path.join(root, 'packages/onething-runtime/src/settings/ipc-operations.ts')
  const mainFile = path.join(root, 'apps/electron/src/main/ipc/settings.ts')
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
      : ['apps/electron/src/main/ipc/settings.ts: missing settings IPC adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns settings save orchestration', lines)
}

function checkRuntimeOwnsPluginsIpcListProjection(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/plugins/plugin-list.ts')
  const mainFile = path.join(root, 'apps/electron/src/main/ipc/plugins.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const lines = [
    ...(!runtimeContent.includes('projectOnethingPluginsForRenderer')
      ? [`${rel(runtimeFile)}: missing runtime-owned plugin list projection`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_PLUGINS_IPC_LIST_PROJECTION_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/main/ipc/plugins.ts: missing plugins IPC adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns plugin list projection', lines)
}

function checkRuntimeOwnsPluginsIpcCommandProjection(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/plugins/plugin-list.ts')
  const mainFile = path.join(root, 'apps/electron/src/main/ipc/plugins.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const lines = [
    ...(!runtimeContent.includes('projectOnethingPluginCommandsForRenderer')
      ? [`${rel(runtimeFile)}: missing runtime-owned plugin command projection`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_PLUGINS_IPC_COMMAND_PROJECTION_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/main/ipc/plugins.ts: missing plugins IPC adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns plugin command projection', lines)
}

function checkRuntimeOwnsPluginCommandExecution(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/plugins/plugin-command-execution.ts')
  const mainFile = path.join(root, 'apps/electron/src/main/ipc/plugins.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'normalizeOnethingPluginCommandName',
    'executeOnethingPluginCommand',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_PLUGINS_IPC_COMMAND_EXECUTION_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/main/ipc/plugins.ts: missing plugins IPC adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns plugin command execution orchestration', lines)
}

function checkRuntimeOwnsPluginsIpcOperations(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/plugins/ipc-operations.ts')
  const mainFile = path.join(root, 'apps/electron/src/main/ipc/plugins.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'ONETHING_PLUGIN_SYSTEM_NOT_INITIALIZED',
    'listOnethingPluginsForIpc',
    'enableOnethingPluginForIpc',
    'disableOnethingPluginForIpc',
    'refreshOnethingPluginsForIpc',
    'listOnethingPluginCommandsForIpc',
    'executeOnethingPluginCommandForIpc',
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned plugin IPC operation ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_PLUGINS_IPC_OPERATIONS_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/main/ipc/plugins.ts: missing plugins IPC adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns plugin IPC operations', lines)
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
  const walkOptions = { includeTests: true, extensions: /\.(ts|tsx|js|mjs|cjs|json|vue|css|md)$/ }
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

/**
 * `onething.aliases.ts` 每条 alias 的目标必须真实存在。
 *
 * P1'-3 复核(08-21):这张表已经从 241 条缩到 3 条 —— `@onething/backend` 前缀一条
 * (等 P3' backend 成包后消失)、`@onething/electron-host` 正则两条。三族包
 * (core / gateway / runtime)全部走 package.json `"exports"`,缺子路径 typecheck
 * 就红,"登记即门禁"那 158 条 `missing … alias` 断言随 P1'-0 / P1'-2 已全部退役。
 *
 * 但这一条 check 留着:electron-host **不是包**,是 `apps/electron/src/<域>/<文件>.ts`
 * 的路径别名,tsconfig 那条通配符对任何子路径都放行 —— 死目标只会在 build/run 时炸,
 * typecheck 永远不报。三条表几秒就扫完,留着不亏。
 */
function checkAliasTargetsExist(): void {
  const aliasFile = path.join(root, 'onething.aliases.ts')
  if (!fs.existsSync(aliasFile)) {
    assertNoMatches('onething.aliases.ts targets exist', ['onething.aliases.ts: missing alias registry'])
    return
  }

  const content = fs.readFileSync(aliasFile, 'utf-8')
  const entry = /\{\s*find:\s*(\/(?:\\.|[^/\\])+\/[a-z]*|'[^']+'|"[^"]+")\s*,\s*replacement:\s*resolve\(\s*projectRoot\s*,\s*'([^']+)'\s*\)/g
  const lines: string[] = []
  let count = 0

  for (const match of content.matchAll(entry)) {
    count += 1
    const find = match[1]
    const target = match[2]
    // 正则 alias 的 replacement 带 $1 捕获,能验证的是它的落点目录。
    // `…/sessions/$1.ts` 截出来是 `…/sessions/`,已经就是目录 —— 再 dirname
    // 一次会退到 `src/`,那就等于什么也没验。
    let probe: string
    if (target.includes('$')) {
      const prefix = target.slice(0, target.indexOf('$'))
      probe = path.join(root, prefix.endsWith('/') ? prefix.slice(0, -1) : path.dirname(prefix))
    } else {
      probe = path.join(root, target)
    }
    if (!fs.existsSync(probe)) {
      const lineNo = content.slice(0, match.index ?? 0).split('\n').length
      lines.push(`onething.aliases.ts:${lineNo}: alias ${find} points at a missing target ${target}`)
    }
  }

  if (count === 0) {
    lines.push('onething.aliases.ts: alias table could not be parsed (entry shape changed?)')
  }

  assertNoMatches('onething.aliases.ts targets exist', lines)
}

// 宪法第 1 条:插件的全部权力 = 注入的 api 对象。
// 插件代码(用户插件样例 + 内置插件实现)只准吃 Node 内置、zod、@onething/core;
// 任何指向宿主 bundle 的 import 都是把"通道"变回"整个进程"。
//
// 按**模块说明符**匹配,不按语句形状:`import x from`、`import 'x'`、
// `export … from`、`require()`、`await import()`、裸 `import()`、
// `const m = await import()` —— 取模块的写法太多,逐个枚举语句形状必漏
// (旧写法就漏了 export-from 与不带 await 的动态 import)。
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

function checkRuntimeOwnsMediaPreviewRegistry(): void {
  const runtimeFile = 'packages/onething-runtime/src/media/image-preview-registry.ts'
  const boundRegistryFile = 'packages/onething-runtime/src/media/image-preview-registry-bound.ts'
  const mainFile = path.join(root, 'apps/electron/src/main/ipc/media.ts')
  const runtimeContent = fs.existsSync(path.join(root, runtimeFile))
    ? fs.readFileSync(path.join(root, runtimeFile), 'utf-8')
    : ''
  const lines = [
    ...(!fs.existsSync(path.join(root, runtimeFile))
      ? [`${runtimeFile}: missing runtime-owned image preview registry`]
      : []),
    ...(!runtimeContent.includes('openOnethingImagePreviewForIpc')
      ? [`${runtimeFile}: missing runtime-owned image preview IPC opener`]
      : []),
    ...(!runtimeContent.includes('openOnethingImageGalleryForIpc')
      ? [`${runtimeFile}: missing runtime-owned image gallery IPC opener`]
      : []),
    // P4c 第三批:登记簿的两半从此不在同一个包里(写在宿主的开预览窗,读在 RPC 域),
    // 所以**绑好的那一本**必须只有一处 —— 否则两半各拿一本簿子,预览永远查不到。
    ...(!fs.existsSync(path.join(root, boundRegistryFile))
      ? [`${boundRegistryFile}: missing the one process-wide image preview registry`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_MEDIA_PREVIEW_REGISTRY_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/main/ipc/media.ts: missing media IPC adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns image preview registry', lines)
}

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

function checkRuntimeOwnsThemeRuntime(): void {
  const runtimeFiles = [
    'packages/onething-runtime/src/themes/index.ts',
    'packages/onething-runtime/src/themes/theme-runtime.ts',
    'packages/onething-runtime/src/themes/types.ts',
    'packages/onething-runtime/src/themes/window-theme.ts',
  ]
  const mainFiles = [
    // P4c 第七批:themes 整域迁 router,`@main` 那层壳适配已删 —— 判据改指域文件。
    path.join(root, 'packages/backend/rpc/domains/themes.ts'),
    path.join(root, 'packages/backend/themes/index.ts'),
    path.join(root, 'apps/electron/src/window/index.ts'),
  ]
  const mainHelperFiles = [
    path.join(root, 'packages/backend/themes/base46-parser.ts'),
    path.join(root, 'packages/backend/themes/css-mapper.ts'),
    path.join(root, 'packages/backend/themes/resolver.ts'),
    path.join(root, 'packages/backend/themes/role-mapping.ts'),
    // P3'a-1:`app/themes/builtin/` 是 runtime 同名目录的逐字副本(index.ts 一字不差,
    // 两个 json 还停在旧版),且全仓零 import —— 已删。它回来才算红。
    path.join(root, 'packages/backend/themes/builtin/index.ts'),
  ]
  const runtimeContent = runtimeFiles
    .map(file => fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), 'utf-8') : '')
    .join('\n')
  const requiredRuntimeSymbols = [
    'OnethingThemeRuntime',
    'defaultOnethingThemeRuntime',
    'initializeThemes',
    'loadCustomThemes',
    'applyTheme',
    'refreshThemes',
    'openThemesFolder',
    'resolveOnethingWindowThemeSelection',
    'resolveOnethingThemeMode',
  ]
  const lines = [
    ...runtimeFiles
      .filter(file => !fs.existsSync(path.join(root, file)))
      .map(file => `${file}: missing runtime-owned theme module`),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `packages/onething-runtime/src/themes/theme-runtime.ts: missing runtime-owned ${symbol}`),
    ...(fs.existsSync(mainFiles[0])
      ? matchingLines(mainFiles[0], MAIN_THEMES_IPC_RUNTIME_FORBIDDEN_PATTERNS)
      : ['packages/backend/rpc/domains/themes.ts: missing themes RPC domain']),
    ...(fs.existsSync(mainFiles[1])
      ? [`${rel(mainFiles[1])}: themes facade should be removed; import @onething/runtime/themes directly`]
      : []),
    ...(!fs.existsSync(mainFiles[2])
      ? ['apps/electron/src/window/index.ts: missing Electron window module']
      : []),
    ...(fs.existsSync(mainFiles[2]) && !fs.readFileSync(mainFiles[2], 'utf-8').includes('resolveOnethingWindowThemeSelection')
      ? ['apps/electron/src/window/index.ts: window theme selection must delegate to packages/onething-runtime']
      : []),
    ...(fs.existsSync(mainFiles[2])
      ? matchingLines(mainFiles[2], MAIN_WINDOW_THEME_SELECTION_FORBIDDEN_PATTERNS)
      : []),
    ...mainHelperFiles.flatMap(file => fs.existsSync(file)
      ? [`${rel(file)}: themes helper facade should be removed; import @onething/runtime/themes/* directly`]
      : []
    ),
  ]

  assertNoMatches('packages/onething-runtime owns theme runtime', lines)
}

function checkRuntimeOwnsTodoPlanStore(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/todo-plan/store.ts')
  const runtimeIpcFile = path.join(root, 'packages/onething-runtime/src/todo-plan/ipc-operations.ts')
  const mainFile = path.join(root, 'packages/backend/wiring/todo-plan/store.ts')
  const mainIpcFile = path.join(root, 'apps/electron/src/main/ipc/todo-plan.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const runtimeIpcContent = fs.existsSync(runtimeIpcFile) ? fs.readFileSync(runtimeIpcFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'OnethingTodoPlanStore',
    'readSnapshot',
    'createUserNote',
    'updateDocument',
    'renameUserNote',
    'deleteUserNote',
  ]
  const requiredRuntimeIpcSymbols = [
    'getOnethingTodoPlanForIpc',
    'createOnethingTodoNoteForIpc',
    'updateOnethingTodoPlanDocumentForIpc',
    'renameOnethingTodoNoteForIpc',
    'deleteOnethingTodoNoteForIpc',
    'revealOnethingTodoPlanDirectoryForIpc',
    'runOnethingTodoPlanWindowActionForIpc',
    'setOnethingTodoPlanWindowPinnedForIpc',
  ]
  const lines = [
    ...(!fs.existsSync(runtimeFile)
      ? [`${rel(runtimeFile)}: missing runtime-owned todo-plan store`]
      : []),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned ${symbol}`),
    ...(!fs.existsSync(runtimeIpcFile)
      ? [`${rel(runtimeIpcFile)}: missing runtime-owned todo-plan IPC operations`]
      : []),
    ...requiredRuntimeIpcSymbols
      .filter(symbol => !runtimeIpcContent.includes(symbol))
      .map(symbol => `${rel(runtimeIpcFile)}: missing runtime-owned todo-plan IPC operation ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_TODO_PLAN_STORE_FORBIDDEN_PATTERNS)
      : ['packages/backend/wiring/todo-plan/store.ts: missing todo-plan store facade']),
    ...(fs.existsSync(mainIpcFile)
      ? matchingLines(mainIpcFile, MAIN_TODO_PLAN_IPC_OPERATIONS_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/main/ipc/todo-plan.ts: missing todo-plan IPC adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns todo-plan store', lines)
}

function checkRuntimeOwnsVoiceIpcOperations(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/voice/ipc-operations.ts')
  const mainFile = path.join(root, 'apps/electron/src/main/ipc/voice.ts')
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
      : ['apps/electron/src/main/ipc/voice.ts: missing voice IPC adapter']),
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

function checkRuntimeOwnsSearchIpcOperations(): void {
  const runtimeFiles = [
    path.join(root, 'packages/onething-runtime/src/search/protocol.ts'),
    path.join(root, 'packages/onething-runtime/src/search/ipc-operations.ts'),
    path.join(root, 'packages/onething-runtime/src/search/providers.ts'),
    path.join(root, 'packages/onething-runtime/src/search/search-runtime.ts'),
  ]
  const mainIpcFile = path.join(root, 'packages/backend/wiring/search/ipc.ts')
  const mainProviderFile = path.join(root, 'packages/backend/wiring/search/providers.ts')
  const sharedSearchFile = path.join(root, 'packages/shared/ipc/search.ts')
  const sharedSearchTestFile = path.join(root, 'packages/shared/ipc/__tests__/search.test.ts')
  const mainProviderContent = fs.existsSync(mainProviderFile) ? fs.readFileSync(mainProviderFile, 'utf-8') : ''
  const mainProviderLines = mainProviderContent.split('\n').filter(line => line.trim().length > 0)
  const sharedSearchContent = fs.existsSync(sharedSearchFile) ? fs.readFileSync(sharedSearchFile, 'utf-8') : ''
  const sharedSearchTestContent = fs.existsSync(sharedSearchTestFile) ? fs.readFileSync(sharedSearchTestFile, 'utf-8') : ''
  const runtimeContent = runtimeFiles
    .map(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '')
    .join('\n')
  const requiredRuntimeSymbols = [
    'ONETHING_SEARCH_CATEGORIES',
    'isOnethingSearchCategory',
    'normalizeOnethingSearchCategory',
    'executeOnethingSearchForIpc',
    'closeOnethingSearchWindowForIpc',
    'executeOnethingSearch',
    'OnethingSearchRuntimeAdapters',
    'isOnethingCommandSearchQuery',
    'OnethingSearchProvidersAdapters',
    'createOnethingSearchProviders',
    'configureOnethingSearchProviders',
    'createDailyNote',
    'searchDailyNotes',
    'formatDailyDate',
  ]
  const lines = [
    ...runtimeFiles
      .filter(file => !fs.existsSync(file))
      .map(file => `${rel(file)}: missing runtime-owned search operation module`),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `packages/onething-runtime/src/search: missing runtime-owned search operation ${symbol}`),
    ...(fs.existsSync(mainIpcFile)
      ? [`${rel(mainIpcFile)}: remove legacy search IPC adapter; register @onething/electron-host/search/ipc directly`]
      : []),
    ...(fs.existsSync(mainProviderFile)
      ? matchingLines(mainProviderFile, MAIN_SEARCH_PROVIDER_ORCHESTRATION_FORBIDDEN_PATTERNS)
      : ['packages/backend/wiring/search/providers.ts: missing search provider adapter']),
    ...(!mainProviderContent.includes('@onething/runtime/search')
      ? [`${rel(mainProviderFile)}: search provider facade must delegate to @onething/runtime/search`]
      : []),
    ...(!mainProviderContent.includes('OnethingSearchCategory')
      ? [`${rel(mainProviderFile)}: search provider facade must use runtime search category type`]
      : []),
    ...(mainProviderLines.length > 50
      ? [`${rel(mainProviderFile)}: search provider facade must stay thin`]
      : []),
    ...(!sharedSearchContent.includes('@onething/runtime/search/protocol')
      ? [`${rel(sharedSearchFile)}: shared search category protocol must re-export browser-safe runtime search protocol`]
      : []),
    ...(/from\s+['"]@onething\/runtime\/search['"]/.test(sharedSearchContent)
      ? [`${rel(sharedSearchFile)}: renderer-facing search IPC facade must not import Node-only runtime search entrypoint`]
      : []),
    ...(fs.existsSync(sharedSearchFile)
      ? matchingLines(sharedSearchFile, SHARED_SEARCH_CATEGORY_FORBIDDEN_PATTERNS)
      : [`${rel(sharedSearchFile)}: missing legacy search IPC facade`]),
    ...(!sharedSearchTestContent.includes('re-exports the runtime-owned search category protocol')
      ? [`${rel(sharedSearchTestFile)}: missing shared search category facade coverage`]
      : []),
  ]

  assertNoMatches('packages/onething-runtime owns search IPC and provider orchestration', lines)
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

function checkRuntimeOwnsFilesListIpcOperation(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/files/file-search.ts')
  const mainFile = path.join(root, 'apps/electron/src/main/ipc/files.ts')
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
      : ['apps/electron/src/main/ipc/files.ts: missing files IPC adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns files list IPC operation', lines)
}

function checkRuntimeOwnsDirsListIpcOperation(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/files/directory-listing.ts')
  const mainFile = path.join(root, 'apps/electron/src/main/ipc/files.ts')
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
      : ['apps/electron/src/main/ipc/files.ts: missing files IPC adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns dirs list IPC operation', lines)
}

function checkRuntimeOwnsFileContentAndDirectoryOperations(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/files/file-operations.ts')
  const mainFile = path.join(root, 'apps/electron/src/main/ipc/files.ts')
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
      : ['apps/electron/src/main/ipc/files.ts: missing files IPC adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns file content and directory operations', lines)
}

function checkRuntimeOwnsFileMutationOperations(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/files/file-operations.ts')
  const mainFile = path.join(root, 'apps/electron/src/main/ipc/files.ts')
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
      : ['apps/electron/src/main/ipc/files.ts: missing files IPC adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns file mutation operations', lines)
}

function checkRuntimeOwnsFileRollbackOperation(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/files/file-rollback.ts')
  const mainFile = path.join(root, 'apps/electron/src/main/ipc/files.ts')
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
      : ['apps/electron/src/main/ipc/files.ts: missing files IPC adapter']),
  ]

  assertNoMatches('packages/onething-runtime owns file rollback operation', lines)
}

function checkRuntimeOwnsFileWatchOperations(): void {
  const runtimeFile = path.join(root, 'packages/onething-runtime/src/files/file-watch.ts')
  const mainFile = path.join(root, 'apps/electron/src/main/ipc/files.ts')
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
      : ['apps/electron/src/main/ipc/files.ts: missing files IPC adapter']),
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

checkCoreForbiddenImports()
checkRuntimeHostBoundary()
checkRuntimeWiringModulesStayAtTheEdge()
checkSessionVocabularyUsesTheRegistry()
checkGatewayHostBoundary()
checkCoreOwnsGatewayConversationRuntimeProtocol()
checkGatewayLoadsRuntimeFromHostBoundary()
checkGatewayUsesExplicitTypingSignal()
checkGatewayRegistersConfiguredChannels()
checkGatewayWechatQrStateHandling()
checkGatewayOwnsEnablementConfig()
checkElectronHostOwnsGatewayLifecycle()
checkElectronHostOwnsVoiceRuntimeWindow()
checkElectronHostOwnsVoiceEventBroadcasting()
checkElectronHostOwnsVoiceTray()
checkElectronHostOwnsVoiceIpcHost()
checkElectronHostOwnsReadyHandler()
checkElectronHostOwnsActivateHandler()
checkElectronHostOwnsMainWindowBinding()
checkElectronHostOwnsApplicationMenu()
checkElectronHostOwnsSessionSecurity()
checkElectronHostOwnsExternalLinkHandling()
checkElectronHostOwnsMainWindowRecovery()
checkElectronHostOwnsSettingsWindow()
checkElectronHostOwnsImagePreviewWindow()
checkElectronHostOwnsMainWindowCreation()
checkElectronHostOwnsTodoPlanWindowCreation()
checkElectronHostOwnsMacOSPanelBridge()
checkElectronHostOwnsRendererTargets()
checkElectronHostOwnsSearchWindowLayout()
checkElectronHostOwnsSearchWindowLifecycle()
checkElectronHostOwnsSearchWindowActionDelivery()
checkElectronHostOwnsWindowStatePersistence()
checkElectronHostOwnsMainWindowActivation()
checkElectronHostOwnsWindowVisibilitySnapshots()
checkElectronHostOwnsTodoPlanNotifications()
checkElectronHostOwnsTodoPlanPresentation()
checkElectronHostOwnsWindowFacade()
checkElectronHostOwnsBeforeQuitCleanup()
checkElectronHostOwnsDidBecomeActiveHandler()
checkElectronHostOwnsWindowAllClosedHandler()
checkElectronHostOwnsMediaProtocol()
checkElectronHostOwnsLoggingCapture()
checkElectronHostOwnsAccessibilityPermissions()
checkElectronHostOwnsShellOperations()
checkElectronHostOwnsOAuthEvents()
checkElectronHostOwnsSettingsIpcHost()
checkAgentsDomainRidesTheRpcChannel()
checkPromptsDomainRidesTheRpcChannel()
checkMarkdownDomainRidesTheRpcChannel()
checkPermissionGrantsDomainRidesTheRpcChannel()
checkElectronHostOwnsPluginsIpcHost()
checkProvidersDomainRidesTheRpcChannel()
checkModelsDomainRidesTheRpcChannel()
checkElectronHostOwnsMediaIpcHost()
checkElectronHostOwnsTodoPlanIpcHost()
checkElectronHostOwnsToolsIpcHost()
checkElectronHostOwnsAuthElectronAdapters()
checkElectronHostOwnsSkillsEnvironment()
checkElectronHostOwnsNetworkProxy()
checkElectronHostOwnsGlobalShortcuts()
checkElectronHostOwnsPowerResumeHandlers()
checkElectronHostOwnsAppBootstrap()
checkElectronHostOwnsMainEntry()
checkElectronHostOwnsPreloadEntry()
checkMainUsesRuntimePackageImports()
checkMainFacadesUseElectronHostImports()
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
checkCoreOwnsIpcRouterProtocol()
checkCoreOwnsStreamChunkProtocol()
checkElectronHostOwnsChatIpcHost()
checkElectronHostOwnsFilesIpcHost()
checkCorePromptAssemblyOwnedByRuntime()
checkCorePromptContextRegistryOwnedByRuntime()
checkRuntimeOwnsOnethingStoragePaths()
checkRuntimeOwnsStoreLock()
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
checkRuntimeOwnsSessionMessageRuntime()
checkRuntimeOwnsSessionWorkingDirectoryFlow()
checkRuntimeOwnsSessionSystemMarkerFlow()
checkRuntimeOwnsSessionIpcOperations()
checkRuntimeOwnsRendererMessageSanitizer()
checkChatIpcDoesNotOwnLegacyStreamFlow()
checkRuntimeOwnsChatTitleGenerationFlow()
checkRuntimeOwnsChatSessionIpcOperations()
checkRuntimeOwnsChatActiveStreamListing()
checkRuntimeOwnsChatAbortCleanupFlow()
checkRuntimeOwnsResumeAfterToolConfirmationFlow()
checkRuntimeOwnsToolRegistryRuntime()
checkRuntimeOwnsToolCallStateProjection()
checkRuntimeOwnsToolsIpcListPresentation()
checkRuntimeOwnsToolsIpcExecutionContext()
checkRuntimeOwnsToolsIpcBackgroundJobs()
checkRuntimeOwnsSettingsSaveOrchestration()
checkRuntimeOwnsPluginsIpcListProjection()
checkRuntimeOwnsPluginsIpcCommandProjection()
checkRuntimeOwnsPluginCommandExecution()
checkRuntimeOwnsPluginsIpcOperations()
checkPluginLogicStaysOutOfHostAssembly()
checkPluginsOnlyUseInjectedApi()
checkCoreKnowsNoConcreteFeatures()
checkAliasTargetsExist()
checkNoRawControlCharacters()
checkRuntimeOwnsSkillsRuntimeCache()
checkRuntimeOwnsSkillsIpcOperations()
checkRuntimeOwnsSkillManageOperations()
checkRuntimeOwnsSkillsLoader()
checkRuntimeOwnsMediaPreviewRegistry()
checkRuntimeOwnsMediaImageDataUrl()
checkRuntimeOwnsMediaLegacyList()
checkRuntimeOwnsMediaGeneratedImageLegacySave()
checkRuntimeOwnsMediaLibraryIpcOperations()
checkRuntimeOwnsMarkdownAssetService()
checkRuntimeOwnsMarkdownIpcOperations()
checkRuntimeOwnsThemeRuntime()
checkRuntimeOwnsTodoPlanStore()
checkRuntimeOwnsVoiceIpcOperations()
checkRuntimeOwnsVoiceProviderRuntime()
checkRuntimeOwnsVoiceServicePolicy()
checkRuntimeOwnsVoiceTextProcessing()
checkRuntimeOwnsSearchIpcOperations()
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
