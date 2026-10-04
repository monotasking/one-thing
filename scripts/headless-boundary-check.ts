import fs from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { findSourceControlCharacters } from './lib/source-text-policy.mjs'
import { checkBackendPublicBoundaries, objectMethodBody } from './lib/backend-public-boundary.mjs'
// 第二入口的判据只有一份(`<功能>/<功能>-client-api[-<方面>].ts`;机械改名 6b 删掉了旧复数前缀的过渡表)。
import { clientApiFeatureOf } from './lib/backend-structure.mjs'

const root = process.cwd()

// cordis 是**装配层专属**依赖（C0 底座替换，
// docs/design/cordis-adoption-2026-08.md §1）：只允许出现在
// packages/backend/**。core 与 runtime 不许用、hosts 与 renderer 一概不感知 —— 写法照搬 electron 禁令。
// 包根归位 B(2026-10-04):用 cordis 的那只底座(feature 挂载基座,从前的包根 `features/`)搬进了
// `feature-registry/`,所以 runtime 里**只有这一个目录**可以 import cordis,其余照旧不许。
const isFeatureRegistryFile = (file: string): boolean =>
  file.split(path.sep).join('/').includes('/packages/backend/feature-registry/')
const CORDIS_FORBIDDEN_PATTERNS: RegExp[] = [
  /from\s+['"]@deepseek-ai\/cordis['"]/,
  /import\(['"]@deepseek-ai\/cordis['"]\)/,
  /require\(['"]@deepseek-ai\/cordis['"]\)/,
]

// 「core 专属禁令」那张表(`@shared/ipc`、better-sqlite3、MCP / ACP SDK、zod / diff / uuid)随去 core 批 1
// (2026-10-03)撤掉:core 的「零依赖骨架」是为了让界面那侧复用,第①步以后界面只许 import `@shared` 与
// `@onething/backend-client`,碰不到 core 了,这张表守的东西没有对象。core 剩下的文件与 runtime 吃同一套宿主禁令
// (electron / `@main` / `@preload` / 渲染层别名 + cordis),见 `checkRuntimeHostBoundary`。

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

// 「gateway 只依赖 core + `@shared`」那两张表(不许 import core 的其余部分、不许 import runtime)随去 core 批 3(2026-10-03)
// 撤掉:core 没了,gateway 子树搬进了 `gateway/`,它就是 runtime 里一个普通功能(用户拍板)。宿主禁令由
// `checkRuntimeHostBoundary` 管。

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
 * 这张表只喂 `matchingImportSpecifierLines` —— 匹配的是 import/require 的说明符,
 * 不是整行。注释里的交叉引用、静态扫描测试里的 `path.join(REPO_ROOT, 'packages/backend/<功能>/…')`
 * 都不算命中;`packages/backend` 是独立的 workspace 包,外面进它走 `@onething/backend/<功能>` 包说明符,
 * 天然不含这串字面量。(2026-10-04 去掉 `runtime/` 这一层之后,判据从「`runtime/` 子树的仓内路径」放宽成
 * `packages/backend/`:功能目录直接住在包根下,任何仓内路径形式的说明符都是同一件事。)
 */
const MAIN_RUNTIME_SOURCE_IMPORT_FORBIDDEN_PATTERNS: RegExp[] = [
  /packages\/backend\//,
]

// core、gateway 两张同形的表(说明符里不许出现它们的仓内路径)随去 core 批 3(2026-10-03)撤掉:core 目录没了,
// gateway 搬进了 `gateway/`,上面 runtime 那一张已经管到它。

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
  /await\s+import\(['"]@onething\/backend\/gateway['"]\)/,
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
  // ③-收尾 B:装配层 agent-loop 目录平铺进 `agent-loop`,与产品那一半同住。这把尺子(只按目录走)从此量整个
  // `agent-loop`;产品那一半本来就不碰宿主、不做文件 IO,改后照样全绿。
  'packages/backend/agent-loop',
  // ③-收尾 C:装配层 engine 目录同理平铺进 `engine`,尺子从此量整个 `engine`(产品引擎那一半一并在内,照样全绿)。
  'packages/backend/engine',
  'packages/backend/event',
  // P3'a-3:`app/storage/` 已整只归位 `storage/storage-manager-bound.ts`
  // (除 consolePort 外零脊柱边),目录不复存在。
  // ③-收尾 A(2026-10-02):装配层的 permission、tools 两个目录平铺进了 runtime。尺子只跟着**搬过去的那几只文件**走:
  // 当时 `runtime/permission/` 整个目录就是原来装配层那一个;装配层的 tools 目录里只有 `core/`,所以这里写
  // `tool/access-control`,不写 `tool` —— 后者还住着本职就做文件 IO 的纯模块(bash 执行器、文件快照),从没在这把尺子上。
  // 去 core 批 1(2026-10-03):core 的 permission 目录也并进了 `runtime/permission/`,而那一半本职就要 `node:path`
  // (授权按路径匹配)、从没在这把尺子上。所以这里从「整个目录」改成点名原来装配层那四只文件,尺子量的东西不变。
  // 收尾整理 2(2026-10-03):`runtime/permission/` 并进 `permission/`,目录桶 `index.ts` 按内容改名 `permission.ts`;
  // 照旧只点这四只,`permissions/` 原有的文件不进这把尺子。
  'packages/backend/permission/permission-capabilities.ts',
  'packages/backend/permission/permission-grant-storage.ts',
  'packages/backend/permission/permission-with-grant-storage.ts',
  'packages/backend/permission/permission-message-anchor.ts',
  // 越层清零 C7(2026-10-04):`tool/access-control/` 那两只搬进了 permission,尺子跟着这两只文件走,量的东西不变。
  'packages/backend/permission/permission-enforcement.ts',
  'packages/backend/permission/permission-sandbox-roots.ts',
]

/** 有真实文件 IO 职责的装配目录:只禁宿主与原生 SDK,不禁 fs/path。 */
const MAIN_FILE_IO_SYSTEM_DIRS = [
  'packages/backend/session',
  // 包根归位 2(2026-10-03):包根 `stores/` 拆进各自功能,目录没了;照旧量原来那几只文件(换成新址),尺子量的东西不变。
  'packages/backend/settings/settings-store.ts',
  'packages/backend/settings/settings-defaults.ts',
  'packages/backend/settings/defaults',
  'packages/backend/storage/storage-docs-paths.ts',
  'packages/backend/file/file-connected-directories.ts',
  // P3'b-A:`backend/mcp/` 整域归位 `mcp/`(闭包零脊柱边),
  // 装配层不再有 mcp 目录 —— 这一条随之退役。
  'packages/backend/plugin',
  // 去 core 批 2(2026-10-03):core 的 engine 目录并进了 `engine/`(上面那把全套尺子量的目录);其中这一只
  // 本职就是读 `@` 提及的文件内容(`node:fs`),从没在全套尺子上 —— 改按这一级量,全套尺子遍历时跳过它。
  'packages/backend/agent-loop/agent-loop-file-mentions.ts',
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

// P3'b-A:唯一一条豁免曾是 `backend/mcp/mcp-client.ts`(MCP SDK 适配器)。mcp 整域
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
  // `AIProvider` 枚举已随服务商自述试点 P3 删除;同一种写法换成字面量照样拦。
  /refreshTokenIfNeeded\((?:AIProvider\.Codex|['"]codex['"])\)/,
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
// packages/backend/plugin/builtin/ 是**插座**:把宿主的能力(store/settings/日志目录)
// 注入给 @onething/backend/plugin 里的插件实现,自己不写行为。因此这里禁的是
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

// 装配层不许**复造**笔记/附件的解析规则:那些都是产品逻辑,住 runtime 的
// markdown/asset-service(它在那里问的是 `NoteVault` 自己)。P3 把三个 Obsidian
// 专名加进这张表 —— 一个笔记系统的名字出现在 backend 层,就是这条规则要抓的事。
const MAIN_MARKDOWN_ASSET_SERVICE_FORBIDDEN_PATTERNS: RegExp[] = [
  /IMAGE_EXTENSIONS/,
  /SKIP_SEARCH_DIRS/,
  /VAULT_ASSET_INDEX_TTL_MS/,
  /interface\s+MarkdownContext/,
  /function\s+markdownContext/,
  /function\s+cleanRawTarget/,
  /function\s+mimeTypeFromPath/,
  // 「附件落哪」只有一个产地:库自己的 `attachmentPathFor`。
  /attachmentPathFor\s*\(/,
  /function\s+attachmentPlacementForContext/,
  /function\s+candidatePaths/,
  /function\s+buildVaultAssetIndex/,
  /function\s+findObsidianAssetByBasename/,
  /\bObsidianCli\b/,
  /\breadObsidianConfig\b/,
  /\bfindObsidianVaultRoot\b/,
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
  // 两条从这张表里摘掉 —— 断言现在指的是 `voice/voice-client-api.ts`,而那里逐字保留着
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
  'packages/backend/search/search-runtime.ts',
  'packages/backend/search/ipc-operations.ts',
  'packages/backend/search/protocol.ts',
  'packages/backend/search/ipc.ts',
  'scripts/search-parity-a.mjs',
  'scripts/search-parity-b.mjs',
]

/**
 * 一类 = 一个文件(§4.3「加一类 = 一个文件 + 一行注册」)。缺一个就是有人把某一类
 * 的实现又搬回了公共文件里。
 */
const SEARCH_CAPABILITY_MODULES = [
  'packages/backend/search/capabilities/search-capabilities.ts',
  'packages/backend/search/capabilities/search-capabilities-actions.ts',
  'packages/backend/search/capabilities/search-capabilities-files.ts',
  'packages/backend/search/capabilities/search-capabilities-messages.ts',
  // P2(2026-09-18):`daily.ts` + `daily-notes.ts` 两件并成 `notes.ts` 一件 ——
  // 「每日笔记那个目录」变成「笔记库」之后,配置那半边搬去了笔记领域
  // (`note/`),这一类就真的只剩一个文件了。
  'packages/backend/search/capabilities/search-capabilities-notes.ts',
  'packages/backend/search/capabilities/search-capabilities-prompts.ts',
  'packages/backend/search/capabilities/search-capabilities-scan-adapter.ts',
  'packages/backend/search/capabilities/search-capabilities-sessions.ts',
  'packages/backend/search/capabilities/search-capabilities-text-match.ts',
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
  /function\s+formatStateVariablesForPrompt/,
  /function\s+assertValidName/,
  /function\s+assertValidValue/,
  /function\s+findDuplicateNames/,
  /const\s+RESERVED_NAMES/,
  /const\s+VARIABLE_LIMITS/,
  /class\s+VariableError/,
  /class\s+VariableRegistry/,
  /class\s+CoreProvider/,
  /class\s+SessionStoreProvider/,
  /class\s+GlobalStoreProvider/,
  /writeChains/,
  /function\s+uniqueRoots/,
  /resolveExistingDirectory/,
  /interface\s+WorkdirGateway/,
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
 * 起因(08-21 P2/D 组):"必须走包公开入口"那几条 check 拿 `packages/backend/<功能>/` 之类
 * 的裸字符串扫全行,15 条命中全是注释里的交叉引用(`见 packages/backend/plugin/…`)
 * 和静态扫描测试里的路径串(`path.join(REPO_ROOT, 'packages/backend/plugin')`)——
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

/**
 * 去 core 批 1(2026-10-03)撤掉的三条分层规则,理由写在这里(正本 `docs/design/server-client-split-2026-10.md` §4):
 *
 * - `checkCoreForbiddenImports`(core 与 `runtime/*\/kernel` 不许 import electron / `@shared/ipc` / 原生依赖 /
 *   MCP、ACP SDK / zod / diff / uuid):「零依赖骨架」是为了让界面那侧复用;第①步以后界面只许 import `@shared` 与
 *   `@onething/backend-client`,碰不到 core 了。宿主那一半(electron / `@main` / `@preload` / 渲染层别名 + cordis)并进了
 *   `checkRuntimeHostBoundary`,core 剩下的文件照旧被它管着。
 * - `checkRuntimeDomainKernelImportClosure`(`runtime/<d>/kernel/` 只许 import 自己、core、`@shared` 与 node 内建):
 *   它的源头是「kernel 当 core 判」,core 不再是一层,kernel 也就只是领域里一个普通子目录。
 * - 「core 在最底层」(core 不许 import runtime / gateway / 脊柱)住在 `architecture-boundaries.test.ts`,同批撤掉。
 */

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

// I3(§0b.3)「`*.wiring.ts` 是 runtime 里唯一许说 `@shared/ipc` 的文件形态」与它的另一半「非 wiring 文件不许
// import `*.wiring` 模块」随第③步拍平一起撤掉(正本 §4):server 包内部不再区分接线与产品逻辑,
// runtime 本来就能 import `@shared/ipc` 了,后缀不再表达任何权限。31 只 `*.wiring.ts` 随后(2026-10-03)去掉了后缀,
// 撞名的按内容改名(正本 §6「去 .wiring 后缀」落地记录有去向表);今天仓里没有 `*.wiring.ts`。

/**
 * `packages/backend` 下住着两类东西:包根(装配配方 backend.ts / backend-assemble-engine.ts 等几只文件、`http-server/`、
 * 包级测试 `__tests__/`)与 `<功能>/`(一个功能一个目录,平铺)。合包(第②步)时功能还住在 `core/`、`gateway/`、
 * `runtime/` 三棵子树里;去 core 批 1–3(2026-10-03)只剩 `runtime/`,机械改名 6a(2026-10-04)把这一层也去掉了,
 * 功能目录直接住在包根下。所以「包根」改成一张显式的非功能目录名单:名单里的目录与包根的散文件是包根,其余目录都是功能。
 */
const BACKEND_NON_FEATURE_DIRS = new Set(['__tests__', 'http-server', 'node_modules'])

/** 包根下的一个功能目录里的文件(非功能目录与包根散文件都不算)。 */
function isBackendFeatureFile(file: string): boolean {
  const backendRoot = path.join(root, 'packages/backend')
  if (!isInside(backendRoot, file)) return false
  const first = path.relative(backendRoot, file).split(path.sep)[0]
  return path.relative(backendRoot, file).includes(path.sep) && !BACKEND_NON_FEATURE_DIRS.has(first)
}

function isBackendSpineFile(file: string): boolean {
  const backendRoot = path.join(root, 'packages/backend')
  return isInside(backendRoot, file) && !isBackendFeatureFile(file)
}

function checkRuntimeHostBoundary(): void {
  // P3'd:装配层从 `runtime/app` 变成了独立包 `packages/backend`,所以这里走两棵
  // 树 —— 判据没变,只是"住哪棵树"现在由包边界表达,而不再由子目录前缀表达。
  // 合包(第②步)以后两棵树又住进同一个包;core / gateway 两棵子树有自己的规则,不在这条里。
  //
  // 第③步拍平(2026-10-02,用户拍板「server 包内部不再区分接线与产品逻辑」,正本
  // `docs/design/server-client-split-2026-10.md` §4):一个功能的文件平铺在 `runtime/<d>/`,
  // 所以「runtime 不许 import `@shared/ipc`(`*.wiring.ts` 除外)」这条撤掉 —— runtime 与脊柱吃同一套
  // 宿主禁令(electron / `@main` / `@preload` / 渲染层别名)。runtime 照旧不许 import cordis(装配底座专属,
  // 今天 runtime 里零处)。
  //
  // 去 core 批 1(2026-10-03):core 的专属禁令撤掉,core 剩下的文件按 runtime 判(同一套宿主禁令 + cordis);
  // 批 3 起 core 目录不存在,gateway 也在 `gateway/` 里,一并按 runtime 判。
  const backendRoot = path.join(root, 'packages/backend')
  const lines = [
    ...walkFiles(backendRoot).filter(isBackendFeatureFile),
    ...walkFiles(backendRoot).filter(isBackendSpineFile),
  ]
    .flatMap(file => matchingLines(
      file,
      isBackendSpineFile(file) || isFeatureRegistryFile(file)
        ? APP_ASSEMBLY_FORBIDDEN_PATTERNS
        : [...APP_ASSEMBLY_FORBIDDEN_PATTERNS, ...CORDIS_FORBIDDEN_PATTERNS],
    ))
  assertNoMatches('packages/backend features + package root have no Electron/main/preload/renderer forbidden imports', lines)
}

/**
 * 会话**词汇**只有一份:`SESSION_EVENT_TYPES`(50 条)+ `SESSION_COMMAND_TYPES`(12 条)
 * 都住在 `packages/shared/events/`(2026-10 ①a 从 core 搬回),core 从那里取。这条 check 守的是"别再手抄"。
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

// 2026-10(server / client 拆分 ①a):两张表的主人从 core 改为 shared —— 词汇是契约,core
// 从 shared 取,拆掉 core ↔ shared 的环。判据不变,只是权威文件换了住址。
const SESSION_VOCABULARY_REGISTRY_FILES = [
  'packages/shared/events/session-event-types.ts',
  'packages/shared/events/session-command-types.ts',
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
  // 合包(第②步)以后 core 与 runtime 是 `packages/backend` 的子树,扫 `packages/backend` 一棵就覆盖了原来的三棵
  // (再单列会把同一个违例报两遍)。
  const roots = [
    'packages/backend',
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
  // ③-收尾 C(2026-10-02):gateway 的依赖从「只 core」放宽成「core + `@shared`(含 `@shared/ipc`)」;去 core 批 3
  // (2026-10-03)把「只依赖 core + `@shared`」这一半整个撤掉 —— core 没了,gateway 搬进 `gateway/` 成了普通功能,
  // 它 import runtime 的别的功能是正常的。留下的是宿主禁令(electron / src/main / 相对爬进 shared 源码)。
  const lines = walkFiles(path.join(root, 'packages/backend/gateway'))
    .flatMap(file => matchingLines(file, [
      ...HOST_BOUNDARY_FORBIDDEN_PATTERNS.filter(pattern => pattern.source !== 'shared\\/ipc'),
    ]))
  assertNoMatches('packages/backend/gateway has no Electron/main forbidden imports', lines)
}

function checkGatewayLoadsRuntimeFromHostBoundary(): void {
  // D202:启动面(读运行时模块、按配置登记渠道)从网关入口搬进了 `gateway-standalone.ts`,两条断言跟着它走。
  const gatewayFile = path.join(root, 'packages/backend/gateway/gateway-standalone.ts')
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
      : ['packages/backend/gateway/gateway-standalone.ts: missing standalone gateway start surface']),
  ]

  assertNoMatches('packages/backend/gateway loads onething runtime from host instead of creating an agent', lines)
}

function checkGatewayUsesExplicitTypingSignal(): void {
  const channelFile = path.join(root, 'packages/backend/gateway/hub/gateway-hub-channel.ts')
  const bridgeFile = path.join(root, 'packages/backend/gateway/hub/gateway-hub-bridge.ts')
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
      : ['packages/backend/gateway/hub/gateway-hub-bridge.ts: missing gateway bridge']),
  ]

  assertNoMatches('packages/backend/gateway uses explicit typing signal instead of empty text messages', lines)
}

function checkGatewayRegistersConfiguredChannels(): void {
  // D202:启动面(读运行时模块、按配置登记渠道)从网关入口搬进了 `gateway-standalone.ts`,两条断言跟着它走。
  const gatewayFile = path.join(root, 'packages/backend/gateway/gateway-standalone.ts')
  const gatewayConfigFile = path.join(root, 'packages/backend/gateway/gateway-config.ts')
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
      : ['packages/backend/gateway/gateway-standalone.ts: missing standalone gateway start surface']),
  ]

  assertNoMatches('packages/backend/gateway registers configured IM channels', lines)
}

function checkGatewayWechatQrStateHandling(): void {
  const channelFile = path.join(root, 'packages/backend/gateway/channels/wechat/wechat.ts')
  const channelTestFile = path.join(root, 'packages/backend/gateway/channels/wechat/__tests__/channel.test.ts')
  const pollerTestFile = path.join(root, 'packages/backend/gateway/channels/wechat/ilink/__tests__/wechat-ilink-poller.test.ts')
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

  assertNoMatches('packages/backend/gateway follows official WeChat iLink QR and getupdates compatibility', lines)
}

function checkAgentsDomainRidesTheRpcChannel(): void {
  const retiredFiles = [
    'apps/electron/src/ipc/agents.ts',
    'apps/electron/src/main/ipc/agents.ts',
  ]
  const channelsFile = path.join(root, 'packages/shared/ipc/channels.ts')
  const routerFile = path.join(root, 'packages/shared/ipc/agents.ts')
  const domainFile = path.join(root, 'packages/backend/agent/agent-client-api.ts')
  const registryIndexFile = path.join(root, 'packages/backend/http-server/http-server-client-api-roster.ts')
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
    // 装配点是名册(包根归位 2026-10-04,决策 D21 / D26):域文件用 `defineClientApi({ id: 'rpc:agents',
    // router: agentsRouter, handlers: agentsRpcHandlers })` 交出一行,名册
    // `http-server/http-server-client-api-roster.ts` 列出 `AGENTS_CLIENT_API`。所以「域上了通用面」的判据认
    // **域文件里 router + handlers 成对交出、名册里有这一行**,而不是域文件里的绑定调用
    // (每域那只「只有测试在用的注册包装」已随 S3 删掉)。
    ...(!(domainContent.includes('router: agentsRouter, handlers: agentsRpcHandlers') && /\bAGENTS_CLIENT_API\b/.test(registryIndexContent))
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
  const domainFile = path.join(root, 'packages/backend/prompt/prompt-client-api.ts')
  const registryIndexFile = path.join(root, 'packages/backend/http-server/http-server-client-api-roster.ts')
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
    ...(!(domainContent.includes('router: promptsRouter, handlers: promptsRpcHandlers') && /\bPROMPTS_CLIENT_API\b/.test(registryIndexContent))
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
  const domainFile = path.join(root, 'packages/backend/markdown/markdown-client-api.ts')
  const guardFile = path.join(root, 'packages/backend/markdown/markdown-asset-sandbox.ts')
  const registryIndexFile = path.join(root, 'packages/backend/http-server/http-server-client-api-roster.ts')
  const serverRuntimeFile = path.join(root, 'packages/backend/http-server/http-server-runtime.ts')
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
  // 沙箱护栏必须留在 app 层的**调用路径**上：这几条是从 apps/backend-server 搬过来的,
  // 搬丢了就等于迁移把安全护栏一起迁没了 —— 批 1 退回这个域正是为了避免这件事。
  // 注:笔记库判定的**实现**已按 "owns Markdown asset service" 规则归位 runtime
  // (卫生批 7739c230;P3 起它问的是 `NoteVault` 而不是磁盘上的 `.obsidian`),
  // app 层留的是对它的调用 —— 守卫因此盯调用符号。
  const requiredGuardSymbols = [
    'isTargetInsideSandbox',
    // P3 改名:判据从「往上找 .obsidian」换成「问库自己附件放哪」,守卫的名字
    // 因此不再点任何一个笔记系统。
    'noteAttachmentRootStaysInside',
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
    ...(!(domainContent.includes('router: markdownRouter, handlers: markdownRpcHandlers') && /\bMARKDOWN_CLIENT_API\b/.test(registryIndexContent))
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
  const domainFile = path.join(root, 'packages/backend/permission/permission-client-api-grants.ts')
  const registryIndexFile = path.join(root, 'packages/backend/http-server/http-server-client-api-roster.ts')
  const mainPermissionFile = path.join(root, 'apps/electron/src/main/ipc/permission.ts')
  const serverRuntimeFile = path.join(root, 'packages/backend/http-server/http-server-runtime.ts')
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
    ...(!(domainContent.includes('router: permissionGrantsRouter, handlers: permissionGrantsRpcHandlers') && /\bPERMISSION_GRANTS_CLIENT_API\b/.test(registryIndexContent))
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
  const domainFile = path.join(root, 'packages/backend/provider/provider-client-api.ts')
  const registryIndexFile = path.join(root, 'packages/backend/http-server/http-server-client-api-roster.ts')
  const channelsContent = fs.existsSync(channelsFile) ? fs.readFileSync(channelsFile, 'utf-8') : ''
  const routerContent = fs.existsSync(routerFile) ? fs.readFileSync(routerFile, 'utf-8') : ''
  const domainContent = fs.existsSync(domainFile) ? fs.readFileSync(domainFile, 'utf-8') : ''
  const registryIndexContent = fs.existsSync(registryIndexFile) ? fs.readFileSync(registryIndexFile, 'utf-8') : ''
  const requiredDomainSymbols = [
    'listOnethingProvidersForIpc',
    // 批 5:配额经 `backend.quota`(`quota`)取,域里不再有取数流程。
    'getCurrentBackendInstance()?.quota',
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
    ...(!(domainContent.includes('router: providersRouter, handlers: providersRpcHandlers') && /\bPROVIDERS_CLIENT_API\b/.test(registryIndexContent))
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
  const domainFile = path.join(root, 'packages/backend/provider/provider-client-api-models.ts')
  const registryIndexFile = path.join(root, 'packages/backend/http-server/http-server-client-api-roster.ts')
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
    ...(!(domainContent.includes('router: modelsRouter, handlers: modelsRpcHandlers') && /\bMODELS_CLIENT_API\b/.test(registryIndexContent))
      ? [`${rel(registryIndexFile)}: models domain is not listed in the RPC assembly point`]
      : []),
  ]

  assertNoMatches('models domain rides the generic RPC channel', lines)
}

function checkMainUsesRuntimePackageImports(): void {
  const lines = walkFiles(path.join(root, 'packages/backend'), [], { includeTests: true })
    .flatMap(file => matchingImportSpecifierLines(file, MAIN_RUNTIME_SOURCE_IMPORT_FORBIDDEN_PATTERNS))
  assertNoMatches('Electron main and tests import packages/backend via package public entrypoints', lines)
}


/**
 * 「core 只许 import 批准表里的第三方包」(`checkCorePackageDependencies`)与「core 的大桶必须交出 AgentEngine /
 * EventBus / … 这几个名字」(`checkCorePublicExports`)随去 core 批 1(2026-10-03)撤掉:前一条是零依赖骨架的规矩,
 * 后一条把 core 当成对外的公共入口 —— core 不再是一层(正本 §4),两条都没有对象了。哪只桶交出哪个名字,
 * 由用它的人的 import 守着:名字没了,类型检查当场红。
 */

function checkMainCoreSystemAdapters(): void {
  const fileIoEntries = new Set(MAIN_FILE_IO_SYSTEM_DIRS.map(entry => path.join(root, entry)))
  const lines = [
    ...MAIN_CORE_SYSTEM_DIRS
      .map(entry => path.join(root, entry))
      .flatMap(entry => (fs.existsSync(entry) && fs.statSync(entry).isFile() ? [entry] : walkFiles(entry)))
      .filter(file => !fileIoEntries.has(file))
      .flatMap(file => matchingLines(file, MAIN_FORBIDDEN_IMPORT_PATTERNS)),
    ...MAIN_FILE_IO_SYSTEM_DIRS
      .map(entry => path.join(root, entry))
      .flatMap(entry => (fs.existsSync(entry) && fs.statSync(entry).isFile() ? [entry] : walkFiles(entry)))
      .flatMap(file => matchingLines(file, MAIN_HOST_FORBIDDEN_IMPORT_PATTERNS)),
  ].filter(line => !isAllowedMainAdapterLine(line))
  assertNoMatches('main core-system directories only keep explicit adapter imports', lines)
}

function checkCoreToolHelperTestsLiveInCorePackage(): void {
  // 去 core 批 1(2026-10-03):core 的 tools 目录并进了 `tool/`,这两只测试跟着搬过去(注册表那只随被测文件
  // 改名 `engine-tool-registry`)。位置断言改指新址;下面 `forbiddenMainTests` 那三个 `core-*` 名字是同一批测试换个
  // 前缀的副本,两半同住一个 `__tests__` 以后照旧不许出现。
  const requiredCoreTests = [
    'packages/backend/tool/__tests__/tool-engine-registry.test.ts',
    'packages/backend/tool/__tests__/tool-permission-guards.test.ts',
  ]
  // 2026-10 ①c:`tool-result.ts` 随会话投影的闭包搬进了 shared,它的测试跟着模块走。
  const requiredSharedTests = [
    'packages/shared/tools/__tests__/tool-result.test.ts',
  ]
  const forbiddenMainTests = [
    'packages/backend/tool/__tests__/core-registry.test.ts',
    'packages/backend/tool/__tests__/core-permission-guards.test.ts',
    'packages/backend/tool/__tests__/core-tool-result.test.ts',
  ]
  const lines = [
    ...requiredCoreTests
      .filter(file => !fs.existsSync(path.join(root, file)))
      .map(file => `${file}: missing tool helper test`),
    ...requiredSharedTests
      .filter(file => !fs.existsSync(path.join(root, file)))
      .map(file => `${file}: missing shared package tool helper test`),
    ...forbiddenMainTests
      .filter(file => fs.existsSync(path.join(root, file)))
      .map(file => `${file}: tool helper tests live under their own names in packages/backend/tool/__tests__`),
  ]

  assertNoMatches('packages/backend/tool owns the tool helper tests that came from core', lines)
}

/**
 * R4b —— 旧的 `coreProviderToolSchemaFromParameters`(provider schema 投影)随
 * 旧注册表删除。这条规则的意图没变(**JSON Schema → 宿主形状的投影归 core**),
 * 只是主语换成了新树唯一还在用的那一个:`coreToolDefinitionFromJsonSchema`,
 * 它的消费者是 `app/toolkit/catalog-projection.ts`。
 */
function checkCoreOwnsToolSchemaProjection(): void {
  const coreRegistryFile = path.join(root, 'packages/backend/tool/tool-engine-registry.ts')
  const coreIndexFile = path.join(root, 'packages/backend/tool/tool-helpers.ts')
  const coreTestFile = path.join(root, 'packages/backend/tool/__tests__/tool-engine-registry.test.ts')
  const projectionFile = path.join(root, 'packages/backend/toolkit/toolkit-catalog-projection.ts')
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
      .map(symbol => `${rel(coreRegistryFile)}: missing tool schema projection symbol ${symbol}`),
    ...requiredCoreSymbols
      .filter(symbol => !coreIndexContent.includes(symbol))
      .map(symbol => `${rel(coreIndexFile)}: missing tool helpers public export ${symbol}`),
    ...(!coreTestContent.includes('coreToolDefinitionFromJsonSchema')
      ? [`${rel(coreTestFile)}: missing parameter schema projection coverage`]
      : []),
    ...(!projectionContent.includes('coreToolDefinitionFromJsonSchema')
      ? [`${rel(projectionFile)}: catalog projection must reuse the core schema projection`]
      : []),
  ]

  assertNoMatches('packages/backend/tool owns legacy tool schema projection', lines)
}

/**
 * 2026-10(server / client 拆分第①步,`docs/design/server-client-split-2026-10.md` §2):
 * 下面四条从前叫「core owns …」—— 协议定义在 core,shared 留一个再导出门面,
 * 并禁止 shared 自己再写一份。①a / ①c 把这几份协议整块搬进了 shared(它们是 server 与
 * client 之间的契约,或两边必须算出同一个答案的纯逻辑),门面随之删除,core 改为从 shared 取。
 * 规则的**意图没变** —— 一份协议只有一个主人、别处不许再抄一份 —— 变的是主人的住址,
 * 于是「不许重抄」的禁令从 shared 挪到了 core 那一侧。
 */

function checkSharedOwnsToolFailureParameterSummary(): void {
  const sharedFile = path.join(root, 'packages/shared/tools/tool-result.ts')
  const sharedTestFile = path.join(root, 'packages/shared/tools/__tests__/tool-result.test.ts')
  const retiredFacade = path.join(root, 'packages/shared/tool-failure-params.ts')
  const sharedContent = fs.existsSync(sharedFile) ? fs.readFileSync(sharedFile, 'utf-8') : ''
  const sharedTestContent = fs.existsSync(sharedTestFile) ? fs.readFileSync(sharedTestFile, 'utf-8') : ''
  const requiredSymbols = [
    'ToolFailureParameterSummary',
    'summarizeToolFailureParameters',
  ]
  const lines = [
    ...requiredSymbols
      .filter(symbol => !sharedContent.includes(symbol))
      .map(symbol => `${rel(sharedFile)}: missing shared-owned tool failure parameter symbol ${symbol}`),
    ...requiredSymbols
      .filter(symbol => !sharedTestContent.includes(symbol))
      .map(symbol => `${rel(sharedTestFile)}: missing tool failure parameter test coverage for ${symbol}`),
    ...(fs.existsSync(retiredFacade)
      ? [`${rel(retiredFacade)}: the retired re-export facade must not come back (import @shared/tools/tool-result)`]
      : []),
    // 不许在 core 里再抄一份。
    ...walkFiles(path.join(root, 'packages/backend/tool'))
      .flatMap(file => matchingLines(file, SHARED_TOOL_FAILURE_PARAMETERS_FORBIDDEN_PATTERNS)),
  ]

  assertNoMatches('packages/shared owns tool failure parameter summary', lines)
}

function checkSharedOwnsToolPermissionErrorText(): void {
  const sharedFile = path.join(root, 'packages/shared/permission/rejection-message.ts')
  const sharedTestFile = path.join(root, 'packages/shared/permission/__tests__/permission-errors.test.ts')
  const sharedToolResultFile = path.join(root, 'packages/shared/tools/tool-result.ts')
  const retiredFacade = path.join(root, 'packages/shared/tool-errors.ts')
  const sharedContent = fs.existsSync(sharedFile) ? fs.readFileSync(sharedFile, 'utf-8') : ''
  const sharedTestContent = fs.existsSync(sharedTestFile) ? fs.readFileSync(sharedTestFile, 'utf-8') : ''
  const sharedToolResultContent = fs.existsSync(sharedToolResultFile) ? fs.readFileSync(sharedToolResultFile, 'utf-8') : ''
  const requiredSymbols = [
    'DEFAULT_PERMISSION_REJECTED_MESSAGE',
    'formatPermissionRejectedMessage',
  ]
  const lines = [
    ...requiredSymbols
      .filter(symbol => !sharedContent.includes(symbol))
      .map(symbol => `${rel(sharedFile)}: missing shared-owned tool permission error text ${symbol}`),
    ...requiredSymbols
      .filter(symbol => !sharedTestContent.includes(symbol))
      .map(symbol => `${rel(sharedTestFile)}: missing permission error text test coverage for ${symbol}`),
    // 工具失败的那句话复用这一份,不许自己再抄一句(§17.8 U1-a 的判例,住址换成 shared)。
    ...(!sharedToolResultContent.includes("from '../permission/rejection-message.js'")
      ? [`${rel(sharedToolResultFile)}: tool failure text must reuse the shared permission error text`]
      : []),
    ...(fs.existsSync(sharedToolResultFile)
      ? matchingLines(sharedToolResultFile, CORE_TOOL_RESULT_PERMISSION_ERROR_DUPLICATE_FORBIDDEN_PATTERNS)
      : [`${rel(sharedToolResultFile)}: missing shared tool result helper`]),
    ...(fs.existsSync(retiredFacade)
      ? [`${rel(retiredFacade)}: the retired re-export facade must not come back (import @shared/permission/rejection-message)`]
      : []),
    // 不许在权限目录(`permission`,去 core 批 1 起 core 那一半也住在这里)里再抄一份。
    ...walkFiles(path.join(root, 'packages/backend/permission'))
      .flatMap(file => matchingLines(file, SHARED_TOOL_ERRORS_FORBIDDEN_PATTERNS)),
  ]

  assertNoMatches('packages/shared owns tool permission error text', lines)
}

/**
 * R4b:`bash-runtime.test.ts` / `builtin/__tests__/time.test.ts` 随旧工具对象
 * 删除,必需清单换成**还活着的那几个纯模块测试**(它们正是新树 import 的那批)。
 * 规则的意图一个字没变:工具帮手的测试住在产品包里,不许爬进装配树。
 */
function checkRuntimeToolHelperTestsLiveInRuntimePackage(): void {
  const requiredRuntimeTests = [
    'packages/backend/tool/__tests__/tool-file-snapshot.test.ts',
    'packages/backend/tool/__tests__/tool-sandbox.test.ts',
    'packages/backend/tool/__tests__/tool-edit-engine.test.ts',
    'packages/backend/tool/__tests__/tool-sensitive-files.test.ts',
    'packages/backend/toolkit/__tests__/golden/time.test.ts',
    'packages/backend/toolkit/__tests__/golden/bash.test.ts',
  ]
  const timeTest = path.join(root, 'packages/backend/toolkit/__tests__/golden/time.test.ts')
  const timeContent = fs.existsSync(timeTest) ? fs.readFileSync(timeTest, 'utf-8') : ''
  const lines = [
    ...requiredRuntimeTests
      .filter(file => !fs.existsSync(path.join(root, file)))
      .map(file => `${file}: missing runtime package tool helper test`),
    // ③-收尾 A:原来这里还有一张「工具辅助测试不许住在装配层工具目录的 `__tests__/` 下」的表。那个目录平铺进了
    // `tool`,那张表照搬过来就成了「不许住在 runtime」,与本条「该住 runtime」自相矛盾 —— 前提是两层,撤掉。
    ...(!timeContent.includes('TimeTool')
      ? [`${rel(timeTest)}: missing runtime-owned direct time engine coverage`]
      : []),
  ]

  assertNoMatches('packages/backend owns runtime tool helper tests', lines)
}

function checkCoreOwnsSessionCommandIpcOperation(): void {
  const runtimeFiles = [
    path.join(root, 'packages/backend/event/event-ipc-operations.ts'),
    path.join(root, 'packages/backend/event/event-bus-primitives.ts'),
  ]
  // 结构债 P4c 第四批:命令总线的入口从 `@main/ipc/handlers.ts` 的 `ipcMain.handle`
  // 搬到 `session-command` RPC 域,所以「不许在别处重抄一遍 emit」这条守的是域文件。
  const mainFile = path.join(root, 'packages/backend/session/session-client-api-commands.ts')
  // 2026-08-22(#21):`@main/ipc/chat.ts` 已随第七条一起删掉,只剩 chat 域要守。
  const chatDomainFile = path.join(root, 'packages/backend/engine/engine-client-api.ts')
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
      .map(file => `${rel(file)}: missing session command IPC operation`),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `packages/backend/event/event-ipc-operations.ts: missing ${symbol}`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_SESSION_COMMAND_HANDLER_FORBIDDEN_PATTERNS)
      : ['packages/backend/session/session-client-api-commands.ts: missing session-command RPC domain']),
    // P4c 第五批:同一条规矩守 chat RPC 域(停止收尾在那里发会话事件)。
    ...(fs.existsSync(chatDomainFile)
      ? matchingLines(chatDomainFile, MAIN_SAFE_SESSION_EVENT_EMIT_FORBIDDEN_PATTERNS)
      : ['packages/backend/engine/engine-client-api.ts: missing chat RPC domain']),
  ]

  assertNoMatches('packages/backend/event owns session command/event IPC projections', lines)
}

function checkSharedOwnsStreamChunkProtocol(): void {
  const sharedFile = path.join(root, 'packages/shared/events/stream-chunks.ts')
  const sharedTestFile = path.join(root, 'packages/shared/events/__tests__/stream-chunks.test.ts')
  const sharedContent = fs.existsSync(sharedFile) ? fs.readFileSync(sharedFile, 'utf-8') : ''
  const sharedTestContent = fs.existsSync(sharedTestFile) ? fs.readFileSync(sharedTestFile, 'utf-8') : ''
  const requiredSymbols = [
    'TextDeltaChunk',
    'ReasoningPlacement',
    'ReasoningDeltaChunk',
    'ToolInputDeltaChunk',
    'StreamChunk',
  ]
  const lines = [
    ...(!fs.existsSync(sharedFile)
      ? [`${rel(sharedFile)}: missing shared-owned stream chunk protocol`]
      : []),
    ...(!fs.existsSync(sharedTestFile)
      ? [`${rel(sharedTestFile)}: missing shared-owned stream chunk protocol tests`]
      : []),
    ...requiredSymbols
      .filter(symbol => !sharedContent.includes(symbol))
      .map(symbol => `${rel(sharedFile)}: missing shared-owned stream chunk symbol ${symbol}`),
    ...requiredSymbols
      .filter(symbol => !sharedTestContent.includes(symbol))
      .map(symbol => `${rel(sharedTestFile)}: missing stream chunk protocol test coverage for ${symbol}`),
    // 不许在 core 的事件目录里再抄一份。
    ...walkFiles(path.join(root, 'packages/backend/event'))
      .flatMap(file => matchingLines(file, SHARED_STREAM_CHUNK_PROTOCOL_FORBIDDEN_PATTERNS)),
  ]

  assertNoMatches('packages/shared owns stream chunk protocol', lines)
}

function checkSharedOwnsJsonProtocol(): void {
  const sharedFile = path.join(root, 'packages/shared/json.ts')
  const sharedTestFile = path.join(root, 'packages/shared/__tests__/json.test.ts')
  // 去 core 批 3(2026-10-03):「core 下不许再有 `json.ts`」「清单里不许有 `./core/json` 键」「不许在 core 里再抄一份」三格
  // 随 core 目录一起撤掉。最后一格没有改成扫整个后端:后端里本来就有几只按需写的本地小帮手(变量的类型值、ACP 会话、
  // 工具契约的 schema 形状),它们不是 JSON 协议的第二份,那条判据只对 core 成立。
  const sharedContent = fs.existsSync(sharedFile) ? fs.readFileSync(sharedFile, 'utf-8') : ''
  const sharedTestContent = fs.existsSync(sharedTestFile) ? fs.readFileSync(sharedTestFile, 'utf-8') : ''
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
    ...(!fs.existsSync(sharedFile)
      ? [`${rel(sharedFile)}: missing shared-owned JSON protocol`]
      : []),
    ...(!fs.existsSync(sharedTestFile)
      ? [`${rel(sharedTestFile)}: missing shared-owned JSON protocol tests`]
      : []),
    ...requiredSymbols
      .filter(symbol => !sharedContent.includes(symbol))
      .map(symbol => `${rel(sharedFile)}: missing shared-owned JSON protocol symbol ${symbol}`),
    ...requiredSymbols
      .filter(symbol => !sharedTestContent.includes(symbol))
      .map(symbol => `${rel(sharedTestFile)}: missing JSON protocol test coverage for ${symbol}`),
  ]

  assertNoMatches('packages/shared owns JSON protocol', lines)
}

function checkChatResumeAfterToolConfirmStaysRetired(): void {
  const channelsFile = path.join(root, 'packages/shared/ipc/channels.ts')
  const channelsContent = fs.existsSync(channelsFile) ? fs.readFileSync(channelsFile, 'utf-8') : ''
  const retiredFiles = [
    'apps/electron/src/ipc/chat.ts',
    'apps/electron/src/main/ipc/chat.ts',
    'packages/backend/session/tool-confirmation.ts',
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
// 域的形状由 `packages/backend/file/__tests__/file-client-api.test.ts` 钉,
// 「投影逻辑不许搬进传输层」由下面六条 `checkRuntimeOwns*`(已改指域文件)守。

// P4c 第五批:sessions 的 26 条数据面已迁 `sessionsRouter`,那只手写 IPC 工厂
// (`apps/electron/src/ipc/sessions.ts`)与它的壳适配(`@main/ipc/sessions.ts`)
// **整只删掉** —— 连同四条契约表外的字面量通道。所以
// `checkElectronHostOwnsSessionsIpcHost` 也随之退休:没有宿主件要守了。
// 域的形状由 `packages/backend/session/__tests__/session-client-api.test.ts` 钉。

function checkCorePromptAssemblyOwnedByRuntime(): void {
  const files = [
    path.join(root, 'packages/backend/agent-loop/agent-loop-system-prompt.ts'),
    path.join(root, 'packages/backend/agent-loop/agent-loop.ts'),
  ]
  // 「快照组装不许回到 core 的 engine 目录」那一格随去 core 批 2(2026-10-03)撤掉:那个目录整个并进了
  // `engine/`,快照组装本来就住在 `engine/prompt/`,core 侧的位置不存在了。
  const removedFiles: string[] = []
  const lines = [
    ...files
      .filter(file => fs.existsSync(file))
      .flatMap(file => matchingLines(file, CORE_PROMPT_ASSEMBLY_FORBIDDEN_PATTERNS)),
    ...removedFiles.map(file => `${file}: prompt snapshot assembly belongs in packages/backend`),
  ]
  assertNoMatches('packages/backend/engine primitives keep prompt assembly out', lines)
}

// `checkCorePromptContextRegistryOwnedByRuntime`(「运行时注册表 / 应用状态不许回到 core」)随去 core 批 3(2026-10-03)撤掉:
// 批 1、批 2 已经把它守的两格清空,core 目录本身也删了。

function checkRuntimeOwnsOnethingStoragePaths(): void {
  const file = path.join(root, 'packages/backend/storage/storage-paths.ts')
  const lines = fs.existsSync(file)
    ? matchingLines(file, RUNTIME_STORAGE_PATH_CORE_PROXY_PATTERNS)
    : [`packages/backend/storage/storage-paths.ts: missing runtime storage path contract`]

  assertNoMatches('packages/backend owns onething storage path construction', lines)
}

function checkRuntimeOwnsPermissionGrantFileStorage(): void {
  const file = path.join(root, 'packages/backend/permission/permission-grants.ts')
  const lines = fs.existsSync(file)
    ? matchingLines(file, CORE_PERMISSION_FILE_STORAGE_FORBIDDEN_PATTERNS)
    : []

  assertNoMatches('packages/backend owns permission grant file storage layout', lines)
}

function checkRuntimeOwnsPermissionGrantsIpcPresentation(): void {
  const runtimeFile = path.join(root, 'packages/backend/permission/permission-grants-presentation.ts')
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

  assertNoMatches('packages/backend owns permission grants IPC presentation', lines)
}

function checkRuntimeOwnsPermissionSessionIpcPresentation(): void {
  const runtimeFile = path.join(root, 'packages/backend/permission/permission-session-presentation.ts')
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

  assertNoMatches('packages/backend owns permission session IPC presentation', lines)
}

/**
 * 批 8(`docs/design/subscription-accounts-2026-09.md` §8):`<store>/oauth-tokens.json` 单槽退役。
 *
 * 这条从前断言的是「runtime 拥有 token 存储 + `token-store.wiring.ts` 那层 safeStorage 门面在」;
 * 单槽写路删了以后,那层门面(一个只给装配层单槽用的进程单例)跟着删了。现在它钉的是反面:
 *  - runtime 的 `auth-token-store.ts` 还在,但**只读**(一次性归位读旧文件用),没有 `saveToken` /
 *    `deleteToken` / `writeFile`;
 *  - `token-store.wiring.ts` **回来就是红**(单槽复活);
 *  - 装配层那台 authService 不再注入单槽的 `tokenStore`、不提 `oauth-tokens.json`。
 *
 * 2026-10-04(D24 断边 ③)起 auth 不再缺省装上凭证池那一台:令牌存放面由 `backend.ts` 建好,经
 * `configureProcessAuthTokenStore(createOnethingSpaceTokenStore(...))` 交给进程那台登录服务。所以这里不再禁
 * `auth-process-service.ts` 提 `tokenStore` 这个词(它现在合法地持有一层转交),改禁的是单槽的那几样东西
 * (`oauth-tokens.json`、`token-store.wiring`、单槽类 `OnethingTokenStore` / `./auth-token-store.js`),并且正面钉住
 * 装配交进来的是凭证池那一台。
 */
function checkRuntimeOwnsAuthTokenStorage(): void {
  const runtimeFile = path.join(root, 'packages/backend/auth/auth-token-store.ts')
  const retiredWiringFile = path.join(root, 'packages/backend/auth/token-store.wiring.ts')
  const mainAuthServiceFile = path.join(root, 'packages/backend/auth/auth-process-service.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const mainContent = fs.existsSync(mainAuthServiceFile) ? fs.readFileSync(mainAuthServiceFile, 'utf-8') : ''
  const backendFile = path.join(root, 'packages/backend/backend.ts')
  const backendContent = fs.existsSync(backendFile) ? fs.readFileSync(backendFile, 'utf-8') : ''
  const lines = [
    ...(!runtimeContent
      ? [`${rel(runtimeFile)}: missing runtime-owned legacy OAuth token reader`]
      : []),
    ...(/\bsaveToken\s*\(|\bdeleteToken\s*\(|\bwriteFile\b/.test(runtimeContent)
      ? [`${rel(runtimeFile)}: the retired oauth-tokens.json slot must stay read-only (no saveToken / deleteToken / writeFile)`]
      : []),
    ...(fs.existsSync(retiredWiringFile)
      ? [`${rel(retiredWiringFile)}: the single-slot token store facade was retired in batch 8; tokens live in the space credential pool`]
      : []),
    ...(/oauth-tokens\.json|token-store\.wiring|\bOnethingTokenStore\b|['"]\.\/token-store(?:\.js)?['"]/.test(mainContent)
      ? [`${rel(mainAuthServiceFile)}: the assembly auth service must not wire a single-slot token store`]
      : []),
    ...(!/configureProcessAuthTokenStore\(\s*createOnethingSpaceTokenStore\b/.test(backendContent)
      ? [`${rel(backendFile)}: the process auth service must get the space credential pool as its token store (configureProcessAuthTokenStore(createOnethingSpaceTokenStore(...)))`]
      : []),
    ...(mainContent.includes('@onething/electron-host/')
      ? [`${rel(mainAuthServiceFile)}: auth service must stay host-agnostic (inject via configureAuthHost)`]
      : []),
  ]

  assertNoMatches('packages/backend owns OAuth token storage layout', lines)
}

function checkRuntimeOwnsAuthServiceFlow(): void {
  const runtimeFile = path.join(root, 'packages/backend/auth/auth-service.ts')
  const runtimeFactoryFile = path.join(root, 'packages/backend/auth/auth-service-factory.ts')
  const runtimeIndexFile = path.join(root, 'packages/backend/auth/auth.ts')
  const mainFile = path.join(root, 'packages/backend/auth/auth-process-service.ts')
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
    // 深层引用收口第四批(2026-10-04):入口改成只交外面真在用的名字(R6),登录服务工厂(`auth-service-factory.ts`)外面没人经入口拿,
    // 入口不再交出它;「归 packages/backend 所有」已由上面几条判了,这一条不再要求入口提到它。
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_AUTH_SERVICE_RUNTIME_FORBIDDEN_PATTERNS)
      : ['packages/backend/auth/auth-process-service.ts: missing Electron auth adapter facade']),
  ]

  assertNoMatches('packages/backend owns OAuth service flow orchestration', lines)
}

function checkRuntimeOwnsAuthCallbackServer(): void {
  const runtimeFile = path.join(root, 'packages/backend/auth/auth-callback-server.ts')
  const runtimeIndexFile = path.join(root, 'packages/backend/auth/auth.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const runtimeIndexContent = fs.existsSync(runtimeIndexFile) ? fs.readFileSync(runtimeIndexFile, 'utf-8') : ''
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
    // P3'a-1(I2)曾在这里钉「装配层 auth 目录下的 `callback-server.ts` 转发壳回来才算红」。③-收尾 A 把那个目录
    // 平铺进 `auth` 之后,同名的正是上面的 runtimeFile 本体 —— 前提是两层,撤掉。
  ]

  assertNoMatches('packages/backend owns OAuth callback server', lines)
}

function checkRuntimeOwnsOAuthIpcOperations(): void {
  const runtimeFile = path.join(root, 'packages/backend/auth/auth-ipc-operations.ts')
  // P4c 第七批:oauth 六条数据面整域迁 router,`@main` 那层壳适配已删 —— 判据改指域文件。
  const mainFile = path.join(root, 'packages/backend/auth/auth-client-api.ts')
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
      : ['packages/backend/auth/auth-client-api.ts: missing OAuth RPC domain']),
  ]

  assertNoMatches('packages/backend owns OAuth IPC operations', lines)
}

function checkRuntimeOwnsStreamRuntimeWiring(): void {
  const runtimeFile = 'packages/backend/engine/engine-product-stream-runtime.ts'
  // 从前查的是总桶 `runtime/index.ts`;总桶 2026-10-04 删掉,这两个名字由引擎入口交出(总桶原本就是从这里转发的)。
  const runtimeIndexFile = path.join(root, 'packages/backend/engine/engine.ts')
  const mainFile = path.join(root, 'packages/backend/engine/engine-main-stream-runtime.ts')
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
      ? [`${rel(mainFile)}: main stream runtime facade must delegate host adapter assembly to packages/backend`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_STREAM_RUNTIME_WIRING_FORBIDDEN_PATTERNS)
      : ['packages/backend/engine/engine-main-stream-runtime.ts: missing Electron stream runtime adapter facade']),
  ]

  assertNoMatches('packages/backend owns stream runtime wiring', lines)
}

function checkRuntimeOwnsHistoryHelperWiring(): void {
  const mainFiles = [
    path.join(root, 'packages/backend/engine/stream/engine-stream-message-helpers.ts'),
    path.join(root, 'packages/backend/engine/stream/engine-stream-resume-history.ts'),
  ]
  const lines = mainFiles.flatMap(file => fs.existsSync(file)
    ? matchingLines(file, MAIN_HISTORY_HELPER_CORE_WIRING_FORBIDDEN_PATTERNS)
    : []
  )

  assertNoMatches('packages/backend owns onething history helper wiring', lines)
}

function checkRuntimeOwnsAgentLoopRuntimeWiring(): void {
  const file = path.join(root, 'packages/backend/engine/stream/engine-agent-loop-stream-context.ts')
  const lines = fs.existsSync(file)
    ? matchingLines(file, MAIN_AGENT_LOOP_RUNTIME_WIRING_FORBIDDEN_PATTERNS)
    : []

  assertNoMatches('packages/backend owns agent-loop runtime adapter wiring', lines)
}

function checkRuntimeOwnsAgentLoopSelection(): void {
  const runtimeFile = 'packages/backend/engine/engine-agent-loop-stream-selection.ts'
  // P3'e-A2b 删掉了装配层那个换名薄适配(`engine/stream/agent-loop-selection.ts`,
  // 28 行、只把三个 `Onething*` 符号改回短名):调用点直接读产品层。所以这条断言
  // 从「门面必须在」翻成「门面**回来**才算红」—— 它一旦重新出现,就说明有人又在
  // 装配层复制了一份选路判据。
  const retiredFacade = 'packages/backend/engine/stream/agent-loop-selection.ts'
  const lines = [
    ...(!fs.existsSync(path.join(root, runtimeFile))
      ? [`${runtimeFile}: missing runtime-owned onething agent-loop stream selection`]
      : []),
    ...(fs.existsSync(path.join(root, retiredFacade))
      ? [`${retiredFacade}: retired selection facade came back (P3'e-A2b)`]
      : []),
    ...matchingLines(path.join(root, 'packages/backend/engine/prompt/engine-system-prompt-snapshot.ts'),
      MAIN_AGENT_LOOP_SELECTION_FORBIDDEN_PATTERNS),
  ]

  assertNoMatches('packages/backend owns onething agent-loop stream selection', lines)
}

function checkCoreOwnsAgentLoopPureFacades(): void {
  const mainIndexFile = path.join(root, 'packages/backend/provider-call/provider-call-process-providers.ts')
  const mainIndexContent = fs.existsSync(mainIndexFile) ? fs.readFileSync(mainIndexFile, 'utf-8') : ''
  // ③-收尾 B(2026-10-02)撤:原来这里还点名装配层 agent-loop 目录下 13 只已删的转发壳(bridge / runner / types /
  // providers/sse …)回来即红。那个目录整只平铺进了 `agent-loop`,照搬过来 `providers/sse.ts` 正是产品本体,
  // 其余几只与 core 的同名文件是不是「转发壳」也不再由住址说明 —— 前提是两层,撤掉。下面「入口不许再导出 core API」那一条照旧。
  const lines = ([] as string[])
    .concat(mainIndexContent.includes("@onething/backend/agent-loop/agent-loop-primitives")
      ? [`${rel(mainIndexFile)}: agent-loop entry should only export the process-bound providers; import @onething/backend/agent-loop/agent-loop-primitives directly for loop primitives`]
      : [])

  assertNoMatches('packages/backend/agent-loop keeps loop primitives out of its process-providers entry', lines)
}

function checkRuntimeOwnsProviderRequestDump(): void {
  const runtimeFile = 'packages/backend/logging/logging-provider-request-dump.ts'
  // 包根归位 3(2026-10-03):落盘薄壳从包根 `provider-binding/request-dump.ts` 搬到 providers 目录里,判据照旧。
  const mainFile = path.join(root, 'packages/backend/provider/provider-request-dump-writer.ts')
  const lines = [
    ...(!fs.existsSync(path.join(root, runtimeFile))
      ? [`${runtimeFile}: missing runtime-owned provider request dump implementation`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_PROVIDER_REQUEST_DUMP_FORBIDDEN_PATTERNS)
      : ['packages/backend/provider/provider-request-dump-writer.ts: missing main provider request dump facade']),
  ]

  assertNoMatches('packages/backend owns provider request dump implementation', lines)
}

function checkRuntimeOwnsProviderRegistry(): void {
  const runtimeFile = path.join(root, 'packages/backend/provider/provider-registry.ts')
  const mainFile = path.join(root, 'packages/backend/provider/provider-table.ts')
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
    // providers 收口(2026-10-04,D42 修订):注册表门面与它委派的注册表、类型面同住 providers,直取兄弟文件;
    // 从前认的是包名 `@onething/backend/provider`(合包前的「app 层委派给 runtime」),同一个功能里
    // 的文件经自己的入口取名字不合规矩,所以改认兄弟文件。
    ...(!mainContent.includes('./provider-registry.js') || !mainContent.includes('./provider-ipc-types.js')
      ? [`${rel(mainFile)}: provider registry facade must delegate to the runtime-owned registry and type facade (./provider-registry.js, ./provider-ipc-types.js)`]
      : []),
    ...(mainLines.length > 100
      ? [`${rel(mainFile)}: provider registry facade must stay thin`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_PROVIDER_REGISTRY_FORBIDDEN_PATTERNS)
      : ['packages/backend/provider/provider-table.ts: missing provider registry facade']),
  ]

  assertNoMatches('packages/backend owns provider registry', lines)
}

function checkRuntimeOwnsProviderDefinitionTypes(): void {
  const runtimeFile = path.join(root, 'packages/backend/provider/provider-definition.ts')
  const mainFile = path.join(root, 'packages/backend/provider/provider-ipc-types.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
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
    // providers 收口(2026-10-04,D42 修订):类型面直取兄弟文件 `./provider-definition.js`,入口不再为外面没人用的
    // 十个契约类型开口(R6),所以这里不再要求入口交出 `./provider-definition.js`。
    ...(!mainContent.includes('./provider-definition.js')
      ? [`${rel(mainFile)}: provider type facade must delegate to the runtime-owned provider definition types (./provider-definition.js)`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_PROVIDER_TYPES_FORBIDDEN_PATTERNS)
      : ['packages/backend/provider/provider-ipc-types.ts: missing provider type facade']),
  ]

  assertNoMatches('packages/backend owns provider definition types', lines)
}

function checkRuntimeOwnsProviderOauthConfigResolution(): void {
  const runtimeFile = path.join(root, 'packages/backend/provider/provider-oauth-config.ts')
  const mainFile = path.join(root, 'packages/backend/provider-call/provider-call-chat.ts')
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
      : ['packages/backend/provider-call/provider-call-chat.ts: missing provider facade']),
  ]

  assertNoMatches('packages/backend owns provider OAuth config resolution', lines)
}

function checkRuntimeOwnsProviderFacadeOrchestration(): void {
  const runtimeFile = path.join(root, 'packages/backend/provider/provider-facade.ts')
  const runtimeTestFile = path.join(root, 'packages/backend/provider/__tests__/provider-facade.test.ts')
  const runtimeIndexFile = path.join(root, 'packages/backend/provider/provider.ts')
  const mainFile = path.join(root, 'packages/backend/provider-call/provider-call-chat.ts')
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
      : ['packages/backend/provider-call/provider-call-chat.ts: missing provider facade']),
  ]

  assertNoMatches('packages/backend owns provider facade orchestration', lines)
}

function checkRuntimeOwnsProviderTitleOrchestration(): void {
  const runtimeFile = path.join(root, 'packages/backend/provider/provider-routing.ts')
  const mainFile = path.join(root, 'packages/backend/provider-call/provider-call-chat.ts')
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
      : ['packages/backend/provider-call/provider-call-chat.ts: missing provider facade']),
  ]

  assertNoMatches('packages/backend owns provider title orchestration', lines)
}

function checkRuntimeOwnsProviderTextResponseProjection(): void {
  const runtimeFile = path.join(root, 'packages/backend/provider/provider-routing.ts')
  const mainFile = path.join(root, 'packages/backend/provider-call/provider-call-chat.ts')
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
      : ['packages/backend/provider-call/provider-call-chat.ts: missing provider facade']),
  ]

  assertNoMatches('packages/backend owns provider text response projection', lines)
}

function checkRuntimeOwnsProviderGenerateReasoningOrchestration(): void {
  const runtimeFile = path.join(root, 'packages/backend/provider/provider-routing.ts')
  const mainFile = path.join(root, 'packages/backend/provider-call/provider-call-chat.ts')
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
      : ['packages/backend/provider-call/provider-call-chat.ts: missing provider facade']),
  ]

  assertNoMatches('packages/backend owns provider generate-with-reasoning orchestration', lines)
}

function checkRuntimeOwnsProviderAcpStreamProjection(): void {
  const runtimeFile = path.join(root, 'packages/backend/provider/provider-routing.ts')
  const mainFile = path.join(root, 'packages/backend/provider-call/provider-call-chat.ts')
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
      : ['packages/backend/provider-call/provider-call-chat.ts: missing provider facade']),
  ]

  assertNoMatches('packages/backend owns provider ACP stream projection', lines)
}

function checkRuntimeOwnsAcpIpcOperations(): void {
  const runtimeFile = path.join(root, 'packages/backend/acp/acp-ipc-operations.ts')
  // P4c 第六批:八条 acp 通道从 `@main` 壳适配搬到了 RPC 域,「不许在调用点重实现
  // 一遍」这条禁令跟着改指到新家。
  const mainFile = path.join(root, 'packages/backend/acp/acp-client-api.ts')
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
      : ['packages/backend/acp/acp-client-api.ts: missing ACP RPC domain']),
  ]

  assertNoMatches('packages/backend owns ACP IPC operations', lines)
}

function checkRuntimeOwnsAcpClientRuntime(): void {
  const runtimeClientFile = path.join(root, 'packages/backend/acp/acp-client.ts')
  const runtimeManagerFile = path.join(root, 'packages/backend/acp/acp-manager.ts')
  const runtimeTypesFile = path.join(root, 'packages/backend/acp/acp-types.ts')
  const runtimeIndexFile = path.join(root, 'packages/backend/acp/acp.ts')
  // 「装配那一半不许再自带 client / manager / types / index 的门面」:第③步拍平(2026-10-02)以后 acp 只有一个目录,
  // 装配那一半不存在了,这张表随之清空(留着变量,免得下面的判据形状跟着动)。原来它点名的是
  // 当时装配层 acp 目录下的 `{client,manager,types,index}.ts` —— 拍平后同名路径正是产品本体,不能再判「存在即红」。
  const mainFiles: string[] = []
  // 客户端本体与它给 SDK 的回调面(`acp-client-app.ts`,2026-10-04 拆出,D243)合起来读:符号表一格不减,
  // 只是 `acp.client(` / `createTerminal` / `requestPermission` 那几格搬进了回调面那只文件。
  const runtimeClientAppFile = path.join(root, 'packages/backend/acp/acp-client-app.ts')
  const runtimeClientContent = [runtimeClientFile, runtimeClientAppFile]
    .map(file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : ''))
    .join('\n')
  const runtimeManagerContent = fs.existsSync(runtimeManagerFile) ? fs.readFileSync(runtimeManagerFile, 'utf-8') : ''
  const runtimeTypesContent = fs.existsSync(runtimeTypesFile) ? fs.readFileSync(runtimeTypesFile, 'utf-8') : ''
  const runtimeIndexContent = fs.existsSync(runtimeIndexFile) ? fs.readFileSync(runtimeIndexFile, 'utf-8') : ''
  const requiredClientSymbols = [
    'ACPClient',
    // A0-1(SDK 1.x):连接对象由 `acp.client(...).connect(stream)` 建,旧的 ClientSideConnection 已弃用。
    'acp.client(',
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
  // P3'a-1(I2):这四个 app 门面本来就只是 `export … from '@onething/backend/acp'`
  // 的转发,和 runtime 里同名文件一字不差地重复着同一个概念。归位后它们被删除,
  // 调用方直接 import `@onething/backend/acp` —— 所以断言反过来:**它们回来才算红**
  // (同 checkRuntimeOwnsThemeRuntime 的 mainHelperFiles 判例)。文件真回来了,照旧
  // 扫一遍禁令模式,双保险不变。
  const mainFacadeLines = mainFiles.flatMap(file => fs.existsSync(file)
    ? [
        `${rel(file)}: ACP legacy facade should be removed; import @onething/backend/acp directly`,
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
    // 深层引用收口第四批(2026-10-04):入口改成只交外面真在用的名字(R6),`ACPClient` 外面没人经入口拿,
    // 入口只交 `ACPManager`;「客户端归 packages/backend 所有」已由上面几条判了。
    ...(!runtimeIndexContent.includes('ACPManager')
      ? [`${rel(runtimeIndexFile)}: missing ACP runtime public exports`]
      : []),
    ...mainFacadeLines,
  ]

  assertNoMatches('packages/backend owns ACP client runtime', lines)
}

/**
 * R4b —— 旧的 `tool/direct-tool-execution.ts`(把 ctx 回调翻成 IPC 的那
 * 约 350 行)随旧树删除,这条规则的意图仍然成立并且更硬了:**每一次工具直调只有
 * 一个必经点**,而它必须把活儿交出去,不许在装配层就地实现一条管线。
 */
function checkRuntimeOwnsDirectToolExecutionAdapter(): void {
  const mainFile = path.join(root, 'packages/backend/engine/stream/engine-stream-tool-execution.ts')
  const wiringFile = path.join(root, 'packages/backend/toolkit/toolkit-wiring.ts')
  const mainContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf-8') : ''
  const wiringContent = fs.existsSync(wiringFile) ? fs.readFileSync(wiringFile, 'utf-8') : ''
  const lines = [
    ...(!fs.existsSync(mainFile)
      ? ['packages/backend/engine/stream/engine-stream-tool-execution.ts: missing tool execution facade']
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

  assertNoMatches('packages/backend owns direct tool execution adapter', lines)
}

/**
 * R4b —— `tool/tool-execution.ts` 只是 `executeCoreToolAndUpdate` 外面
 * 三行转换器的一层壳,随旧树删除,三行搬到了唯一的调用点。规则的意图不变:
 * **工具调用状态的编排归 core**,装配层不许自己再写一份。
 */
function checkRuntimeOwnsToolUpdateOrchestration(): void {
  const coreFile = path.join(root, 'packages/backend/agent-loop/agent-loop.ts')
  const mainFile = path.join(root, 'packages/backend/engine/stream/engine-stream-tool-execution.ts')
  const coreContent = fs.existsSync(coreFile) ? fs.readFileSync(coreFile, 'utf-8') : ''
  const mainContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf-8') : ''
  const lines = [
    ...(!coreContent.includes('executeCoreToolAndUpdate')
      ? [`${rel(coreFile)}: missing core-owned tool update orchestration executeCoreToolAndUpdate`]
      : []),
    ...(!fs.existsSync(mainFile)
      ? ['packages/backend/engine/stream/engine-stream-tool-execution.ts: missing tool execution facade']
      : []),
    ...(!mainContent.includes('executeCoreToolAndUpdate')
      ? [`${rel(mainFile)}: tool update orchestration must delegate to core`]
      : []),
  ]

  assertNoMatches('packages/backend owns tool update orchestration', lines)
}

function checkRuntimeOwnsStreamProcessorAdapter(): void {
  const runtimeFile = path.join(root, 'packages/backend/engine/engine-stream-processor-factory.ts')
  const mainFile = path.join(root, 'packages/backend/engine/stream/engine-stream-processor.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  // F4-b1(§16.16):`createCoreId` 从这张必备表里下线 —— 适配器不再持有 step id
  // 的工厂(id 由 callId 派生,产地在 `packages/shared/engine/tool-step.ts`)。规则要守的
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
      : ['packages/backend/engine/stream/engine-stream-processor.ts: missing stream processor facade']),
  ]

  assertNoMatches('packages/backend owns stream processor adapter', lines)
}

function checkRuntimeOwnsImageStreamEntryPoint(): void {
  const runtimeFile = path.join(root, 'packages/backend/media/media-image-generation.ts')
  const mainFile = path.join(root, 'packages/backend/engine/stream/engine-image-stream.ts')
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
      : ['packages/backend/engine/stream/engine-image-stream.ts: missing image stream facade']),
  ]

  assertNoMatches('packages/backend owns image stream entry point', lines)
}

function checkRuntimeOwnsProvidersIpcUsageFlow(): void {
  // 批 5(docs/design/provider-settings-rework-2026-09.md §8):用量流程换成了配额源注册表。
  // 取数入口是产品层的 `fetchProviderQuota`(manifest 的 quotaSource → 注册表 → 源);
  // 适配器(RPC 域)与装配层的配额服务都**只读表**,一个 provider 名都不许出现 ——
  // 从前那张 `codexProviderIds` 枚举正是这条要防回来的东西。
  const runtimeFile = path.join(root, 'packages/backend/provider/quota/provider-quota.ts')
  const adapterFile = path.join(root, 'packages/backend/provider/provider-client-api.ts')
  const quotaWiringDir = path.join(root, 'packages/backend/quota')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const quotaWiringFiles = fs.existsSync(quotaWiringDir)
    ? fs.readdirSync(quotaWiringDir).filter(name => name.endsWith('.ts')).map(name => path.join(quotaWiringDir, name))
    : []
  const PROVIDER_NAME_LITERAL = [/['"](?:codex|claude-code|deepseek|kimi|openrouter)['"]/]
  const lines = [
    ...(!runtimeContent.includes('fetchProviderQuota')
      ? [`${rel(runtimeFile)}: missing runtime-owned provider quota flow`]
      : []),
    ...(fs.existsSync(adapterFile)
      ? matchingLines(adapterFile, [...MAIN_PROVIDERS_IPC_USAGE_FORBIDDEN_PATTERNS, ...PROVIDER_NAME_LITERAL])
      : [`${rel(adapterFile)}: missing providers RPC domain`]),
    ...(quotaWiringFiles.length === 0 ? [`${rel(quotaWiringDir)}: missing quota service wiring`] : []),
    ...quotaWiringFiles.flatMap(file => matchingLines(file, PROVIDER_NAME_LITERAL)),
  ]

  assertNoMatches('packages/backend owns provider usage flow', lines)
}

function checkRuntimeOwnsProvidersIpcPresentation(): void {
  const runtimeFile = path.join(root, 'packages/backend/provider/provider-presentation.ts')
  const adapterFile = path.join(root, 'packages/backend/provider/provider-client-api.ts')
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

  assertNoMatches('packages/backend owns provider IPC presentation', lines)
}

function checkRuntimeOwnsNetworkPolicy(): void {
  // 包根归位 3(2026-10-03):代理规则与受管 fetch 从 `provider/` 提成独立功能 `network/`,
  // 读设置的那层薄壳从包根 `provider-binding/bound-fetch.ts` 搬进 `settings/settings-proxy-fetch.ts`。判据不变,只换地址。
  const runtimeFile = 'packages/backend/network/network-proxy.ts'
  const runtimeBoundFetchFile = 'packages/backend/network/network-managed-fetch.ts'
  const runtimeBoundFetchTestFile = 'packages/backend/network/__tests__/network-managed-fetch.test.ts'
  const runtimeIndexFile = path.join(root, 'packages/backend/network/network.ts')
  const mainFile = path.join(root, 'packages/backend/settings/settings-proxy-fetch.ts')
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
    ...(!runtimeIndexContent.includes("} from './network-managed-fetch.js'")
      ? ['packages/backend/network/network.ts: missing managed-fetch export']
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_BOUND_FETCH_POLICY_FORBIDDEN_PATTERNS)
      : ['packages/backend/settings/settings-proxy-fetch.ts: missing main network fetch adapter']),
  ]

  assertNoMatches('packages/backend owns provider network policy and bound fetch runtime', lines)
}

function checkRuntimeOwnsModelRegistryRefresh(): void {
  const runtimeFile = path.join(root, 'packages/backend/provider/provider-model-registry.ts')
  const mainFile = path.join(root, 'packages/backend/settings/settings-model-registry-service.ts')
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
      : ['packages/backend/settings/settings-model-registry-service.ts: missing main model registry facade']),
  ]

  assertNoMatches('packages/backend owns model registry refresh orchestration', lines)
}

function checkRuntimeOwnsModelsIpcPresentation(): void {
  const runtimeFile = path.join(root, 'packages/backend/provider/provider-model-registry.ts')
  const adapterFile = path.join(root, 'packages/backend/provider/provider-client-api-models.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const requiredRuntimeSymbols = [
    'mergeOnethingModelsById',
    'getConfiguredOnethingFallbackModels',
    'acpAgentsToOnethingOpenRouterModels',
  ]
  // 服务商自述试点 P2 第 4 批:Copilot 的目录行与列表口取数随这家搬回 `vendors/github-copilot/`,
  // 断言跟着指向新家(仍是 runtime 拥有,不许回流到 RPC 域)。
  const copilotOwnedSymbols: Array<[string, string]> = [
    ['packages/backend/provider/vendors/github-copilot/github-copilot-models.ts', 'copilotModelInfoToOnethingOpenRouterModel'],
    ['packages/backend/provider/vendors/github-copilot/github-copilot-models-fetcher.ts', 'fetchOnethingGitHubCopilotModelsWithAuth'],
  ]
  const lines = [
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `${rel(runtimeFile)}: missing runtime-owned ${symbol}`),
    ...copilotOwnedSymbols
      .filter(([file, symbol]) => {
        const absolute = path.join(root, file)
        return !fs.existsSync(absolute) || !fs.readFileSync(absolute, 'utf-8').includes(symbol)
      })
      .map(([file, symbol]) => `${file}: missing runtime-owned ${symbol}`),
    ...(fs.existsSync(adapterFile)
      ? matchingLines(adapterFile, MAIN_MODELS_IPC_PRESENTATION_FORBIDDEN_PATTERNS)
      : [`${rel(adapterFile)}: missing models RPC domain`]),
  ]

  assertNoMatches('packages/backend owns models IPC presentation helpers', lines)
}

function checkRuntimeOwnsModelQueryIpcPresentation(): void {
  const runtimeFile = path.join(root, 'packages/backend/provider/provider-model-query-presentation.ts')
  const adapterFile = path.join(root, 'packages/backend/provider/provider-client-api-models.ts')
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

  assertNoMatches('packages/backend owns model query IPC presentation', lines)
}

function checkRuntimeOwnsMcpServerOrchestration(): void {
  const runtimeFile = path.join(root, 'packages/backend/mcp/mcp-server-orchestration.ts')
  // P4c 第六批:十六条 mcp 通道从 `@main` 壳适配搬到了 RPC 域,「不许在调用点重
  // 实现一遍」这条禁令跟着改指到新家。
  const mainFile = path.join(root, 'packages/backend/mcp/mcp-client-api.ts')
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
      : ['packages/backend/mcp/mcp-client-api.ts: missing MCP RPC domain']),
  ]

  assertNoMatches('packages/backend owns MCP server orchestration', lines)
}

function checkRuntimeOwnsMcpCapabilityOperations(): void {
  const runtimeFile = path.join(root, 'packages/backend/mcp/mcp-capability-operations.ts')
  // P4c 第六批:十六条 mcp 通道从 `@main` 壳适配搬到了 RPC 域,「不许在调用点重
  // 实现一遍」这条禁令跟着改指到新家。
  const mainFile = path.join(root, 'packages/backend/mcp/mcp-client-api.ts')
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
      : ['packages/backend/mcp/mcp-client-api.ts: missing MCP RPC domain']),
  ]

  assertNoMatches('packages/backend owns MCP capability operation projection', lines)
}

function checkRuntimeOwnsMcpIpcOperations(): void {
  const runtimeFile = path.join(root, 'packages/backend/mcp/mcp-ipc-operations.ts')
  // P4c 第六批:十六条 mcp 通道从 `@main` 壳适配搬到了 RPC 域,「不许在调用点重
  // 实现一遍」这条禁令跟着改指到新家。
  const mainFile = path.join(root, 'packages/backend/mcp/mcp-client-api.ts')
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
      : ['packages/backend/mcp/mcp-client-api.ts: missing MCP RPC domain']),
  ]

  assertNoMatches('packages/backend owns MCP IPC operations', lines)
}

function checkRuntimeOwnsSessionBranchCreation(): void {
  const runtimeFile = 'packages/backend/session/session-branching.ts'
  const runtimeIpcFile = 'packages/backend/session/session-ipc-operations.ts'
  // P4c 第五批:调用点从 `@main` 壳适配搬到了 RPC 域,「不许在调用点重实现一遍」
  // 这条禁令跟着改指到新家。
  const mainFile = path.join(root, 'packages/backend/session/session-client-api.ts')
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
      : ['packages/backend/session/session-client-api.ts: missing sessions RPC domain']),
  ]

  if (fs.existsSync(mainFile)) {
    const branch = objectMethodBody(mainFile, fs.readFileSync(mainFile, 'utf8'), 'sessionsRpcHandlers', 'createBranch')
    branch.split('\n').forEach((line, i) => {
      if (/return\s+\{\s*success:\s*false,\s*error:/.test(line)) {
        lines.push(`${rel(mainFile)}:${i + 1}: branch errors must come from runtime orchestration`)
      }
    })
  }
  assertNoMatches('packages/backend owns session branch creation orchestration', lines)
}

function checkRuntimeOwnsSessionUpdateFlows(): void {
  const runtimeFile = path.join(root, 'packages/backend/session/session-updates.ts')
  // P4c 第五批:调用点已是 RPC 域。
  const mainFile = path.join(root, 'packages/backend/session/session-client-api.ts')
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
      : ['packages/backend/session/session-client-api.ts: missing sessions RPC domain']),
  ]

  assertNoMatches('packages/backend owns session update flows', lines)
}

/*
 * `checkRuntimeOwnsSessionMessageRuntime` —— **已删除**(§17.7.1 批 3)。
 *
 * 它守的是"消息 mutation 的执行体归产品层(当时的 `runtime/`)"这条分层
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
 * `appendSessionLogEvent`(`session-event-log.ts`)是低层落账:分配 seq、编码、通知观察者、
 * 排队落盘。它**不**做 prepare、也**不**立活 surface —— 那两步是门
 * (`session-event-writer.ts` 的 `writeSessionEvent`)的第 1、2 步。直接调低层的后果是
 * 静默的:`ec2437ff` 那条病历里,`tool/result` 走素门落账,于是本进程内的那些
 * surface 格进不了活索引,压缩写下的 `sourceEventSeqs` 少 84 格。
 *
 * 装配层只可把低层 append 绑定到 Writer 端口(`session-event-layer.ts` 那一行);业务只能
 * 通过 Writer 写入,**测试也一样** —— 存储组件的故障注入用例照样从
 * `createSessionEventLayer().writer.write` 进去,验的是同一条落盘契约,少的只是
 * 一个后门。这里从前有一张三条的测试白名单(2026-09-07 那轮为了让新加的三个
 * 存储测试过闸而加),工单 4 D1 删掉了它:闸门不迁就代码。
 */
function checkSessionEventSingleWriteDoor(): void {
  const door = 'packages/backend/session/session-event-writer.ts'
  const definition = 'packages/backend/session/session-event-log.ts'
  const assembly = 'packages/backend/session/session-event-layer.ts'
  const offenders = walkFiles(path.join(root, 'packages'), [], { includeTests: true })
    .filter(file => /\.ts$/.test(file))
    .filter(file => rel(file) !== door && rel(file) !== definition)
    // 只看**剥掉注释之后**的代码(与形状类规则同一条纪律:注释里提一句名字
    // 不该打假红,假红会逼人放宽规则)。
    .flatMap(file => codeOnlyLines(fs.readFileSync(file, 'utf-8'))
      .filter(({ code }) => /\bappendSessionLogEvent\b/.test(code)
        && !(rel(file) === assembly && /^\s*(?:appendSessionLogEvent,|append:\s*appendSessionLogEvent,)\s*$/.test(code)))
      .map(({ raw, lineNo }) => `${rel(file)}:${lineNo}: ${raw.trim()}`))
  assertNoMatches(
    'session event log has a single write door (packages/backend/session/session-event-writer.ts)',
    offenders,
  )
}

/**
 * **契约层只放形状**(工单 4 E)。
 *
 * `packages/shared/contracts/**` 是那几份「持久化与传输两侧都要认」的可序列化
 * 形状(`TurnEvalRecord` / practice / usage)。它存在的理由,就是让契约不必为了
 * 被两侧共用而反向 import 产品树 —— 2026-09-06/07 那轮把它从 runtime 里拆出来,
 * 修的正是这条反向依赖。
 *
 * 一旦它开始 import `@onething/*`,或者开始 `defineRouter`(那是**通道**,不是
 * 形状),这一层就重新变成了一个薄薄的产品层,反向依赖当场长回来。所以这里守三条:
 *
 *  1. 不许 import 任何 `@onething/*`(`@shared/*` 同层可以);
 *  2. 不许 `defineRouter` —— 路由契约住 `@shared/ipc/<domain>.ts`;
 *  3. 顶层只许 `export type` / `export interface` / `export const`(纯形状与常量表);
 *     `export function` / `export class` / `export default` 都是**行为**,不属于这里。
 */
function checkSharedContractsHoldShapesOnly(): void {
  const contracts = path.join(root, 'packages/shared/contracts')
  const offenders = walkFiles(contracts, [], { extensions: /\.tsx?$/ })
    .flatMap(file => codeOnlyLines(fs.readFileSync(file, 'utf-8'))
      .filter(({ code }) =>
        /\bfrom\s+['"]@onething\//.test(code)
        || /\bimport\s*\(\s*['"]@onething\//.test(code)
        || /\bdefineRouter\b/.test(code)
        || /^\s*export\s+(?:async\s+)?(?:function|class|default|let|var)\b/.test(code))
      .map(({ raw, lineNo }) => `${rel(file)}:${lineNo}: ${raw.trim()}`))
  assertNoMatches(
    'packages/shared/contracts holds serializable shapes only (no @onething/* import, no defineRouter, no behaviour)',
    offenders,
  )
}

function checkRuntimeOwnsSessionWorkingDirectoryFlow(): void {
  const runtimeFile = path.join(root, 'packages/backend/session/session-working-directory.ts')
  // P4c 第五批:调用点已是 RPC 域。
  const mainFile = path.join(root, 'packages/backend/session/session-client-api.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const lines = [
    ...(!runtimeContent.includes('updateOnethingSessionWorkingDirectory')
      ? [`${rel(runtimeFile)}: missing runtime-owned session working directory flow`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_SESSIONS_IPC_WORKDIR_FORBIDDEN_PATTERNS)
      : ['packages/backend/session/session-client-api.ts: missing sessions RPC domain']),
  ]

  assertNoMatches('packages/backend owns session working directory flow', lines)
}

function checkRuntimeOwnsSessionSystemMarkerFlow(): void {
  const runtimeFile = path.join(root, 'packages/backend/session/session-system-messages.ts')
  // P4c 第五批:调用点已是 RPC 域。
  const mainFile = path.join(root, 'packages/backend/session/session-client-api.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const lines = [
    ...(!runtimeContent.includes('removeOnethingSystemMarkerMessage')
      ? [`${rel(runtimeFile)}: missing runtime-owned session system marker flow`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_SESSIONS_IPC_SYSTEM_MARKER_FORBIDDEN_PATTERNS)
      : ['packages/backend/session/session-client-api.ts: missing sessions RPC domain']),
  ]

  assertNoMatches('packages/backend owns session system marker flow', lines)
}

function checkRuntimeOwnsSessionIpcOperations(): void {
  const runtimeFile = path.join(root, 'packages/backend/session/session-ipc-operations.ts')
  const runtimeUsageFile = path.join(root, 'packages/backend/session/session-usage.ts')
  // P4c 第五批:调用点已是 RPC 域。
  const mainFile = path.join(root, 'packages/backend/session/session-client-api.ts')
  const usageFile = path.join(root, 'packages/backend/session/session-usage-updates.ts')
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
      : ['packages/backend/session/session-client-api.ts: missing sessions RPC domain']),
    ...(fs.existsSync(usageFile)
      ? matchingLines(usageFile, MAIN_SESSION_USAGE_FACADE_FORBIDDEN_PATTERNS)
      : ['packages/backend/session/session-usage-updates.ts: missing session usage adapter']),
  ]

  assertNoMatches('packages/backend owns session IPC operations', lines)
}

function checkRuntimeOwnsRendererMessageSanitizer(): void {
  const runtimeFile = path.join(root, 'packages/backend/session/session-renderer-sanitizer.ts')
  const mainFiles = [
    path.join(root, 'apps/electron/src/main/ipc/message-sanitizer.ts'),
    // P4c 第五批:会话与聊天两份调用点都已是 RPC 域(`@main/ipc/chat.ts` 在
    // 2026-08-22 的 #21 里整只删掉)。
    path.join(root, 'packages/backend/session/session-client-api.ts'),
    path.join(root, 'packages/backend/engine/engine-client-api.ts'),
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

  assertNoMatches('packages/backend owns renderer-safe message projection', lines)
}

function checkChatIpcDoesNotOwnLegacyStreamFlow(): void {
  // P4c 第五批:聊天面的六条已是 RPC 域;2026-08-22(#21)第七条与那层壳适配
  // 一起删掉之后,这条只剩域文件一处要守。
  const mainFiles = [
    path.join(root, 'packages/backend/engine/engine-client-api.ts'),
  ]
  const lines = mainFiles.flatMap(file => fs.existsSync(file)
    ? matchingLines(file, MAIN_CHAT_IPC_LEGACY_STREAM_FORBIDDEN_PATTERNS)
    : [`${rel(file)}: missing chat IPC adapter`])

  assertNoMatches('chat IPC delegates stream orchestration to EventBus/StreamEngine runtime', lines)
}

function checkRuntimeOwnsChatTitleGenerationFlow(): void {
  const runtimeFile = path.join(root, 'packages/backend/provider/provider-runtime.ts')
  // P4c 第五批:标题生成的调用点已是 RPC 域。
  const mainFile = path.join(root, 'packages/backend/engine/engine-client-api.ts')
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
      : ['packages/backend/engine/engine-client-api.ts: missing chat RPC domain']),
  ]

  assertNoMatches('packages/backend owns chat title generation flow', lines)
}

function checkRuntimeOwnsChatSessionIpcOperations(): void {
  const runtimeFile = path.join(root, 'packages/backend/session/session-ipc-operations.ts')
  // P4c 第五批:历史读取与思考时长补写的调用点已是 RPC 域。
  const mainFile = path.join(root, 'packages/backend/engine/engine-client-api.ts')
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
      : ['packages/backend/engine/engine-client-api.ts: missing chat RPC domain']),
  ]

  assertNoMatches('packages/backend owns chat session IPC operations', lines)
}

function checkRuntimeOwnsChatActiveStreamListing(): void {
  const runtimeFile = path.join(root, 'packages/backend/session/session-stream-abort.ts')
  // P4c 第五批:活流表的调用点已是 RPC 域。
  const mainFile = path.join(root, 'packages/backend/engine/engine-client-api.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const lines = [
    ...(!runtimeContent.includes('listOnethingActiveStreamsForIpc')
      ? [`${rel(runtimeFile)}: missing runtime-owned active stream listing projection`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_CHAT_IPC_ACTIVE_STREAMS_FORBIDDEN_PATTERNS)
      : ['packages/backend/engine/engine-client-api.ts: missing chat RPC domain']),
  ]

  assertNoMatches('packages/backend owns active stream listing projection', lines)
}

function checkRuntimeOwnsChatAbortCleanupFlow(): void {
  const runtimeFile = path.join(root, 'packages/backend/session/session-stream-abort.ts')
  // P4c 第五批:停止收尾的调用点已是 RPC 域。
  const mainFile = path.join(root, 'packages/backend/engine/engine-client-api.ts')
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
      : ['packages/backend/engine/engine-client-api.ts: missing chat RPC domain']),
  ]

  assertNoMatches('packages/backend owns chat abort cleanup flow', lines)
}

// 2026-08-22(#21):`checkRuntimeOwnsResumeAfterToolConfirmationFlow` 已退休 ——
// runtime 的 `sessions/tool-confirmation.ts` 与它唯一的调用点一起删掉了,
// 没有「归属」要守;换来的反向断言是 `checkChatResumeAfterToolConfirmStaysRetired`。

// P4c 第九批:tools 的七条数据面已迁 `toolsRouter`,`@main/ipc/tools.ts` 与
// `apps/electron/src/ipc/tools.ts` 整只删掉。下面四条「runtime 拥有 X 操作」的断言
// 因此改指**域处理者**(`packages/backend/tool/tool-client-api.ts`)—— 守的还是同一件事:
// 投影逻辑住在产品层,传输层只转调,不许在这里重抄一份。
const TOOLS_RPC_DOMAIN_FILE = 'packages/backend/tool/tool-client-api.ts'

function checkRuntimeOwnsToolCallStateProjection(): void {
  const runtimeFile = path.join(root, 'packages/backend/tool/tool-call-state.ts')
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

  assertNoMatches('packages/backend owns tool call state projection', lines)
}

/**
 * R4b —— 旧的 `OnethingToolRegistry` 随旧树删除。它守的那条线仍然在,只是主语换
 * 成了新工具系统:**工具与目录归产品层**(`toolkit`),装配层只负责
 * 建一档目录、接端口;宿主只拿投影。
 */
function checkRuntimeOwnsToolRegistryRuntime(): void {
  const kernelCatalogFile = path.join(root, 'packages/backend/toolkit/toolkit-catalog.ts')
  const productHostFile = path.join(root, 'packages/backend/toolkit/toolkit-host.ts')
  const productIndexFile = path.join(root, 'packages/backend/toolkit/toolkit.ts')
  const assemblyCatalogFile = path.join(root, 'packages/backend/toolkit/toolkit-tier-catalogs.ts')
  const assemblyWiringFile = path.join(root, 'packages/backend/toolkit/toolkit-wiring.ts')
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
    ...(!productIndexContent.includes('./toolkit-host.js')
      ? [`${rel(productIndexFile)}: missing toolkit host public export`]
      : []),
    ...requiredTierFactories
      .filter(symbol => !assemblyCatalogContent.includes(symbol))
      .map(symbol => `${rel(assemblyCatalogFile)}: missing tier catalog factory ${symbol}`),
    ...(!assemblyWiringContent.includes('buildToolkitCatalog')
      ? [`${rel(assemblyWiringFile)}: the assembly layer must own the single catalog build seam`]
      : []),
    // 旧树不许复活。(原来还有一条点名装配层工具目录下的 `registry.ts`,③-收尾 A 把那个目录平铺进
    // `tool` 之后,它照搬过来正好与下一条重复,撤了。)
    ...(fs.existsSync(path.join(root, 'packages/backend/tool/registry.ts'))
      ? ['packages/backend/tool/registry.ts: the legacy tool registry was deleted in R4b']
      : []),
    // 机械改名 6b 起 `tool/tool.ts` 是 tool 功能的入口(N3),所以这条从「文件不许在」改成「入口里不许长回 Tool.define」。
    ...(/\bTool\.define\s*[(<]|export\s+(?:const|namespace|class)\s+Tool\b/.test(
      fs.existsSync(path.join(root, 'packages/backend/tool/tool.ts')) ? fs.readFileSync(path.join(root, 'packages/backend/tool/tool.ts'), 'utf-8') : '')
      ? ['packages/backend/tool/tool.ts: Tool.define was deleted in R4b']
      : []),
  ]

  assertNoMatches('packages/backend owns tool registry runtime', lines)
}

function checkRuntimeOwnsToolsIpcListPresentation(): void {
  const runtimeFile = path.join(root, 'packages/backend/tool/tool-list-presentation.ts')
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

  assertNoMatches('packages/backend owns settings-visible tool list projection', lines)
}

function checkRuntimeOwnsToolsIpcExecutionContext(): void {
  const runtimeFile = path.join(root, 'packages/backend/tool/tool-execution-context.ts')
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

  assertNoMatches('packages/backend owns tool execution context assembly', lines)
}

function checkRuntimeOwnsToolsIpcBackgroundJobs(): void {
  const runtimeFile = path.join(root, 'packages/backend/tool/tool-ipc-operations.ts')
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

  assertNoMatches('packages/backend owns tools background-job IPC operations', lines)
}

function checkRuntimeOwnsSettingsSaveOrchestration(): void {
  const runtimeFile = path.join(root, 'packages/backend/settings/settings-save.ts')
  const runtimeIpcFile = path.join(root, 'packages/backend/settings/settings-ipc-operations.ts')
  // P4c 第十一批:保存链的调用点从 `@main/ipc/settings.ts` 搬进了域处理者 ——
  // 断言改指它,守的仍是同一件事(装配层不许把编排逻辑再抄一份)。
  const mainFile = path.join(root, 'packages/backend/settings/settings-client-api.ts')
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
      : ['packages/backend/settings/settings-client-api.ts: missing settings RPC domain']),
  ]

  assertNoMatches('packages/backend owns settings save orchestration', lines)
}

const BUILTIN_PLUGIN_FACADE_DIR = 'packages/backend/plugin/builtin'
const BUILTIN_PLUGIN_RUNTIME_DIR = 'packages/backend/plugin'
const BUILTIN_PLUGIN_FACADE_MAX_LINES = 60

const BUILTIN_PLUGIN_LOADER_FILE = 'packages/backend/plugin/plugin-disk-loader.ts'
// 机械改名 6b(命名规范 N2):门面叫 `builtin/plugin-builtin-<id>.ts`、实现叫 `plugin-<id>.ts`、测试叫
// `__tests__/plugin-<id>.test.ts`;插件 id 是去掉这两个前缀以后的部分(文件名仍然钉住 id,只是带了功能前缀)。
const BUILTIN_PLUGIN_FACADE_PREFIX = /^plugin-builtin-/
const builtinPluginFacadeName = (id: string): string => `plugin-builtin-${id}`
const builtinPluginRuntimeName = (id: string): string => `plugin-${id}`

/** 内置插件的 id 列表 = 插座目录的文件名。加一个插件就自动进入所有规则。 */
function listBuiltinPluginIds(): string[] {
  const dir = path.join(root, BUILTIN_PLUGIN_FACADE_DIR)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts'))
    .map(entry => entry.name.replace(/\.ts$/, ''))
    .map(name => name.replace(BUILTIN_PLUGIN_FACADE_PREFIX, ''))
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
  const imports = [...content.matchAll(/\bfrom\s+'\.\/builtin\/([\w.-]+?)(?:\.js)?'/g)].map(match => match[1].replace(BUILTIN_PLUGIN_FACADE_PREFIX, '')).sort()
  return { ids, imports }
}

function checkPluginLogicStaysOutOfHostAssembly(): void {
  const pluginIds = listBuiltinPluginIds()
  const runtimeIndexFile = path.join(root, BUILTIN_PLUGIN_RUNTIME_DIR, 'plugin.ts')
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
        lines.push(`${BUILTIN_PLUGIN_FACADE_DIR}/${builtinPluginFacadeName(id)}.ts: facade exists but "${id}" is not registered in getBuiltinPlugins()`)
      }
      if (!registered.imports.includes(id)) {
        lines.push(`${BUILTIN_PLUGIN_LOADER_FILE}: missing import of ./builtin/${builtinPluginFacadeName(id)}.js`)
      }
    }
    for (const name of registered.imports) {
      if (!pluginIds.includes(name)) {
        lines.push(`${BUILTIN_PLUGIN_LOADER_FILE}: imports ./builtin/${builtinPluginFacadeName(name)}.js which is not a facade file`)
      }
    }
  }

  for (const pluginId of pluginIds) {
    const facadeFile = path.join(root, BUILTIN_PLUGIN_FACADE_DIR, `${builtinPluginFacadeName(pluginId)}.ts`)
    const runtimeFile = path.join(root, BUILTIN_PLUGIN_RUNTIME_DIR, `${builtinPluginRuntimeName(pluginId)}.ts`)
    const runtimeTestFile = path.join(root, BUILTIN_PLUGIN_RUNTIME_DIR, '__tests__', `${builtinPluginRuntimeName(pluginId)}.test.ts`)
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
    if (!runtimeIndexContent.includes(`./${builtinPluginRuntimeName(pluginId)}.js`)) {
      lines.push(`${rel(runtimeIndexFile)}: missing public export for built-in plugin "${pluginId}"`)
    }

    // 2) 插座只许接线:委托、够薄、无行为。
    if (!facadeContent.includes('@onething/backend/plugin')) {
      lines.push(`${rel(facadeFile)}: built-in plugin facade must delegate to @onething/backend/plugin`)
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

  // 3)(已撤)「插件行为测试不许住在装配树的 __tests__」—— 第③步拍平(2026-10-02,正本 §4)以后插件的
  //    产品半边与装配半边住同一个目录 `plugin/`、共用一个 `__tests__/`,「装配树」不存在了,
  //    这一段的前提随之消失。1)/2) 两段(内置插件的实现住在领域根、插座只许薄委托)照旧。

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
/**
 * 去 core 批 1(2026-10-03)接收了 core 小目录的 runtime 领域目录。只给「内容」断言用(内核不点名具体功能),
 * 不是一层 —— 这些目录里 core 搬来的文件与原有的文件平铺同住。
 */
const CORE_MERGED_RUNTIME_DIRS = [
  'packages/backend/agent',
  'packages/backend/context',
  'packages/backend/event',
  'packages/backend/http',
  'packages/backend/lifecycle',
  'packages/backend/interaction',
  'packages/backend/logging',
  'packages/backend/memory',
  'packages/backend/permission',
  'packages/backend/provider',
  'packages/backend/resource',
  'packages/backend/storage',
  'packages/backend/toolkit',
  'packages/backend/tool',
  // 去 core 批 2(2026-10-03):core 的 session / engine / agent-loop 并进了这三个目录(整目录量;并进来之前这些目录里
  // 原有的文件同样零命中)。plugins 那一份不能整目录量 —— 产品那一半就是各个具体插件 —— 见下一张表。
  'packages/backend/session',
  'packages/backend/engine',
  'packages/backend/agent-loop',
  // D202(2026-10-04):插件与宿主约定的词汇从 `plugin/` 下沉成功能 `plugin-contract/`(整目录都是契约,
  // 所以整目录量;从下面那张逐文件表里撤掉了搬走的那 13 只与它们的测试,深链那一只搬回 `deeplink/`)。
  'packages/backend/plugin-contract',
]

/**
 * 去 core 批 2(2026-10-03)从 core 的 plugins 目录并进 `plugin/` 的插件契约与内核文件(含它们的测试)。
 * `plugin/` 里其余文件是具体插件与插件系统的产品一半,本来就要点名插件,所以这条内容断言只跟着这些文件走。
 */
const CORE_MERGED_PLUGIN_FILES = [
  '__tests__/agent-identity.test.ts',
  '__tests__/plugin-ambient.test.ts',
  '__tests__/external-root-plugin-capability.test.ts',
  '__tests__/plugin-input-intercept.test.ts',
  '__tests__/layout-verbs.test.ts',
  '__tests__/lifecycle-compact.test.ts',
  '__tests__/llm-protocol.test.ts',
  '__tests__/local-plugins-scan.test.ts',
  '__tests__/notify-sound-enum.test.ts',
  '__tests__/plugin-sessions.test.ts',
  '__tests__/plugin-storage-files.test.ts',
  '__tests__/plugin-tool-call-intercept.test.ts',
  '__tests__/plugin-tool-execution-mode.test.ts',
  '__tests__/plugin-tool-result-intercept.test.ts',
  '__tests__/webview-panel-channel.test.ts',
  'plugin-ambient.ts',
  'plugin-api-builder.ts',
  'plugin-api-context.ts',
  'plugin-api-build-capabilities.ts',
  'plugin-api-build-sessions.ts',
  'plugin-api-build-ui.ts',
  'plugin-api-build-storage.ts',
  'plugin-api-build-registries.ts',
  'plugin-api-state.ts',
  'plugin-freeze.ts',
  'plugin-input-intercept.ts',
  'plugin-install.ts',
  'plugin-lifecycle.ts',
  'plugin-llm.ts',
  'plugin-loader.ts',
  'plugin-log-monitor-primitives.ts',
  'plugin-manager-base.ts',
  'plugin-api-types.ts',
  'plugin-manifest-types.ts',
  'plugin-resources.ts',
  'plugin-scheduler.ts',
  'plugin-sessions.ts',
  'plugin-status.ts',
  'plugin-storage-files.ts',
  'plugin-storage.ts',
  'plugin-store.ts',
  'plugin-theme-contribution.ts',
  'plugin-tool-call-intercept.ts',
  'plugin-tool-execution-mode.ts',
  'plugin-tool-result-intercept.ts',
].map(name => `packages/backend/plugin/${name}`)

/** 去 core 批 3(2026-10-03):core 根上那三只文件的新家。 */
const CORE_MERGED_ROOT_FILES = [
  'packages/backend/gateway/gateway-conversation-runtime.ts',
  'packages/backend/http-server/http-server-runtime-facade.ts',
  'packages/backend/session/session-deep-freeze.ts',
  // D202:深链词汇(URL 语法、插件深链动作的登记契约)从 `plugin/plugin-deep-link.ts` 搬回深链功能,内容断言跟着它走。
  'packages/backend/deeplink/deeplink-contract.ts',
  'packages/backend/deeplink/__tests__/deeplink-contract.test.ts',
]

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
  // 去 core 批 1(2026-10-03):core 的小目录并进了 runtime 的同名领域目录,这条「内核不点名具体功能」是**内容**
  // 断言,跟着那些文件走 —— 量 core 剩下的部分,外加接收了 core 文件的那 14 个领域目录(整目录量;并进来之前
  // 这些目录里原有的文件同样零命中)。
  // 去 core 批 3(2026-10-03):core 目录没了;它根上那三只文件跟着各自的新家量。
  const scanRoots = [...CORE_MERGED_RUNTIME_DIRS]
  const scanFiles = [
    ...scanRoots.flatMap(dir => walkFiles(path.join(root, dir), [], { includeTests: true })),
    ...[...CORE_MERGED_PLUGIN_FILES, ...CORE_MERGED_ROOT_FILES].map(file => path.join(root, file)).filter(file => fs.existsSync(file)),
  ]
  for (const file of scanFiles) {
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

  assertNoMatches('runtime dirs and files merged from core know no concrete plugin or feature names', lines)
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
  const offenders = findSourceControlCharacters(root).map(({ file, line, byte }) =>
    `${file}:${line}: raw control character 0x${byte.toString(16).padStart(2, '0')} (write an escape instead)`)
  assertNoMatches('source files carry no raw control characters', offenders)
}

// 用户插件(仓外)从前还许 import core 的包说明符;去 core 批 3(2026-10-03)core 没了,这个口子随之关掉(样例插件零处用它)。
const PLUGIN_HOST_MODULE_SPECIFIER = /['"](@onething\/|@shared|@main\/|@preload\/|@renderer|@\/|electron['"]|electron\/)/
const PLUGIN_HOST_IMPORT_PATTERNS: RegExp[] = [PLUGIN_HOST_MODULE_SPECIFIER]

/**
 * 内置插件的那一半。2026-10(server / client 拆分 ①a)把会话词汇等零依赖的契约叶子从 core
 * 搬进了 shared —— 内置插件从前经 core 的事件桶(今天的 `@onething/backend/event/event-bus-primitives`)取 `SESSION_EVENT_TYPES`,现在只能经
 * `@shared/events/…` 取。shared 的这些叶子与它们在 core 时是同一种东西(词汇、形状、纯函数),
 * 所以对内置插件放行 `@shared/*`;**`@shared/ipc` 仍禁** —— 那是传输层的契约,插件不该认识宿主
 * 怎么跟外界说话。用户插件不变:它们住在仓外,`@shared` 对它们本来就不存在。
 */
// 去 core 批 2(2026-10-03):插件契约与内核从 core 的 plugins 目录并进了 `plugin/`(`CORE_MERGED_PLUGIN_FILES`),
// 内置插件取它们的包说明符从 core 的 plugins 桶变成 `@onething/backend/plugin/<那几只文件>`。
// 放行的仍是同一批文件 —— 只放那张表上的名字,不是整个 `plugin`(产品那一半是宿主,插件照旧不许认识)。
const CORE_MERGED_PLUGIN_SPECIFIER_NAMES = CORE_MERGED_PLUGIN_FILES
  .filter(file => !file.includes('/__tests__/'))
  .map(file => file.slice('packages/backend/plugin/'.length).replace(/\.ts$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
const BUILTIN_PLUGIN_HOST_MODULE_SPECIFIER = new RegExp(
  `['"](@onething\\/(?!backend\\/plugin\\/(?:${CORE_MERGED_PLUGIN_SPECIFIER_NAMES.join('|')})(?:\\.js)?['"])`
  + `|@shared\\/ipc(?:\\/|\\.js['"]|['"])|@main\\/|@preload\\/|@renderer|@\\/|electron['"]|electron\\/)`,
)
const BUILTIN_PLUGIN_HOST_IMPORT_PATTERNS: RegExp[] = [BUILTIN_PLUGIN_HOST_MODULE_SPECIFIER]

const USER_PLUGIN_HOST_IMPORT_PATTERNS: RegExp[] = [
  ...PLUGIN_HOST_IMPORT_PATTERNS,
  // 用户插件住在 <store>/plugins/<id>/,爬出插件目录去 import 宿主源码同样禁止
  // (同样按说明符匹配,静态/动态/require 一网打尽)。
  /['"]\.\.\/\.\./,
]

function checkPluginsOnlyUseInjectedApi(): void {
  const lines: string[] = []

  // (a) 内置插件实现:只准 Node 内置 / zod / 插件契约那几只文件 / shared 的非传输契约(见上)。
  for (const pluginId of listBuiltinPluginIds()) {
    const implFile = path.join(root, BUILTIN_PLUGIN_RUNTIME_DIR, `${builtinPluginRuntimeName(pluginId)}.ts`)
    if (!fs.existsSync(implFile)) continue
    lines.push(...matchingCodeLines(implFile, BUILTIN_PLUGIN_HOST_IMPORT_PATTERNS))
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
  const runtimeFile = path.join(root, 'packages/backend/skill/skill-session-runtime.ts')
  // P4c 第二批:skills 整域迁 router,`@main` 那层壳适配已删 —— 判据改指域文件。
  const mainFile = path.join(root, 'packages/backend/skill/skill-client-api.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const lines = [
    ...(!runtimeContent.includes('OnethingSessionSkillsRuntime')
      ? [`${rel(runtimeFile)}: missing runtime-owned session skill cache service`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_SKILLS_IPC_RUNTIME_CACHE_FORBIDDEN_PATTERNS)
      : ['packages/backend/skill/skill-client-api.ts: missing skills RPC domain']),
  ]

  assertNoMatches('packages/backend owns skills runtime cache and settings projection', lines)
}

function checkRuntimeOwnsSkillsIpcOperations(): void {
  const runtimeFile = path.join(root, 'packages/backend/skill/skill-ipc-operations.ts')
  // P4c 第二批:同上,消费投影的是 skills RPC 域而不再是 `@main` 的壳适配。
  const mainFile = path.join(root, 'packages/backend/skill/skill-client-api.ts')
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
      : ['packages/backend/skill/skill-client-api.ts: missing skills RPC domain']),
  ]

  assertNoMatches('packages/backend owns skills IPC operations', lines)
}

function checkRuntimeOwnsSkillManageOperations(): void {
  const runtimeFile = path.join(root, 'packages/backend/skill/skill-manage.ts')
  const mainFile = path.join(root, 'packages/backend/skill/skill-manage-setup.ts')
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
      : ['packages/backend/skill/skill-manage-setup.ts: missing skill_manage runtime adapter']),
  ]

  assertNoMatches('packages/backend owns skill_manage operations', lines)
}

function checkRuntimeOwnsSkillsLoader(): void {
  const runtimeFile = path.join(root, 'packages/backend/skill/skill-loader.ts')
  const mainFile = path.join(root, 'packages/backend/skill/skill-sources.ts')
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
      : ['packages/backend/skill/skill-sources.ts: missing skills loader runtime adapter']),
  ]

  assertNoMatches('packages/backend owns skills loader operations', lines)
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
  const runtimeFile = 'packages/backend/media/media-image-file-data-url.ts'
  // P4c 第三批:`readImageBase64` 的调用点从 `@main` 壳适配搬到了 RPC 域,
  // 「不许在调用点重实现一遍」这条禁令跟着改指到新家。
  const mainFile = path.join(root, 'packages/backend/media/media-client-api.ts')
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

  assertNoMatches('packages/backend owns image file data URL helper', lines)
}

function checkRuntimeOwnsMediaLegacyList(): void {
  const runtimeFile = path.join(root, 'packages/backend/media/media-library-service.ts')
  // P4c 第三批:`loadAll` 的调用点已是 RPC 域。
  const mainFile = path.join(root, 'packages/backend/media/media-client-api.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const lines = [
    ...(!runtimeContent.includes('listLegacyImages')
      ? [`${rel(runtimeFile)}: missing runtime-owned legacy image list helper`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_MEDIA_LEGACY_LIST_FORBIDDEN_PATTERNS)
      : ['apps/electron/src/main/ipc/media.ts: missing media IPC adapter']),
  ]

  assertNoMatches('packages/backend owns legacy media image list projection', lines)
}

function checkRuntimeOwnsMediaGeneratedImageLegacySave(): void {
  const runtimeFile = path.join(root, 'packages/backend/media/media-library-service.ts')
  // P3'a-2:整文件归位 `media/media-save-image.ts`(闭包只碰 stores/paths 转发)。
  const mainFile = path.join(root, 'packages/backend/media/media-save-image.ts')
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const lines = [
    ...(!runtimeContent.includes('saveGeneratedImageAsLegacyItem')
      ? [`${rel(runtimeFile)}: missing runtime-owned generated image legacy save helper`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_MEDIA_SAVE_IMAGE_FORBIDDEN_PATTERNS)
      : ['packages/backend/media/media-save-image.ts: missing media save adapter']),
  ]

  assertNoMatches('packages/backend owns generated image legacy save projection', lines)
}

function checkRuntimeOwnsMediaLibraryIpcOperations(): void {
  const runtimeFile = path.join(root, 'packages/backend/media/media-library-presentation.ts')
  // P4c 第三批:媒体库那八条投影的调用点已是 RPC 域。
  const mainFile = path.join(root, 'packages/backend/media/media-client-api.ts')
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

  assertNoMatches('packages/backend owns media library IPC operations', lines)
}

function checkRuntimeOwnsMarkdownAssetService(): void {
  const runtimeFile = path.join(root, 'packages/backend/markdown/markdown-asset-service.ts')
  const mainFile = path.join(root, 'packages/backend/markdown/markdown-asset-sandbox.ts')
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
      : ['packages/backend/markdown/markdown-asset-sandbox.ts: missing markdown asset adapter']),
  ]

  assertNoMatches('packages/backend owns Markdown asset service', lines)
}

function checkRuntimeOwnsMarkdownIpcOperations(): void {
  const runtimeFile = path.join(root, 'packages/backend/markdown/markdown-ipc-operations.ts')
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

  assertNoMatches('packages/backend owns Markdown IPC operations', lines)
}

function checkRuntimeOwnsVoiceIpcOperations(): void {
  const runtimeFile = path.join(root, 'packages/backend/voice/voice-ipc-operations.ts')
  // P4c 第十一批:十一条数据面的调用点从 `@main/ipc/voice.ts` 搬进了域处理者 ——
  // 断言改指它,守的仍是同一件事(装配层不许把投影逻辑再抄一份)。
  const mainFile = path.join(root, 'packages/backend/voice/voice-client-api.ts')
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
      : ['packages/backend/voice/voice-client-api.ts: missing voice RPC domain']),
  ]

  assertNoMatches('packages/backend owns voice IPC operations', lines)
}

function checkRuntimeOwnsVoiceProviderRuntime(): void {
  const runtimeFile = path.join(root, 'packages/backend/voice/voice-providers.ts')
  const runtimeIndexFile = path.join(root, 'packages/backend/voice/voice.ts')
  // 合包前查的是 runtime 自己清单里的 `"./voice/*"` 通配;合包后 runtime 没有自己的清单,公开子路径改由
  // backend 清单的精确键给出 —— 同一个意图:wiring 引的 `@onething/backend/voice/voice-providers` 必须是公开子路径。
  const runtimePackage = path.join(root, 'packages/backend/package.json')
  const mainFile = path.join(root, 'packages/backend/voice/voice-provider-calls.ts')
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
    // 深层引用收口第四批(2026-10-04):入口改成只交外面真在用的名字(R6),`voice-providers.ts` 的名字外面没人经入口拿,
    // 入口不再交出它;「归 packages/backend 所有」已由上面几条判了,这一条不再要求入口提到它。
    ...(!runtimePackageContent.includes('"./voice/voice-providers"')
      ? [`${rel(runtimePackage)}: missing @onething/backend/voice/voice-providers package export`]
      : []),
    ...(!mainContent.includes('@onething/backend/voice/voice-providers')
      ? [`${rel(mainFile)}: main voice providers facade must delegate to runtime voice providers`]
      : []),
    ...(mainLines.length > 70
      ? [`${rel(mainFile)}: main voice providers facade must stay thin`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_VOICE_PROVIDER_RUNTIME_FORBIDDEN_PATTERNS)
      : ['packages/backend/voice/voice-provider-calls.ts: missing voice providers facade']),
  ]

  assertNoMatches('packages/backend owns voice provider runtime', lines)
}

function checkRuntimeOwnsVoiceServicePolicy(): void {
  const runtimeFile = path.join(root, 'packages/backend/voice/voice-service-runtime.ts')
  const runtimeTestFile = path.join(root, 'packages/backend/voice/__tests__/voice-service-runtime.test.ts')
  const runtimeIndexFile = path.join(root, 'packages/backend/voice/voice.ts')
  const mainFile = path.join(root, 'packages/backend/voice/voice-service.ts')
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
    '@onething/backend/voice',
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
    // 深层引用收口第四批(2026-10-04):入口改成只交外面真在用的名字(R6),`voice-service-runtime.ts` 的名字外面没人用,
    // 入口不再整只转交它;「归 packages/backend 所有」已由上面几条判了,这一条不再要求入口提到它。
    ...requiredMainDelegations
      .filter(symbol => !mainContent.includes(symbol))
      .map(symbol => `${rel(mainFile)}: main voice service must delegate ${symbol} to runtime voice service policy`),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_VOICE_SERVICE_RUNTIME_FORBIDDEN_PATTERNS)
      : ['packages/backend/voice/voice-service.ts: missing voice service adapter']),
  ]

  assertNoMatches('packages/backend owns voice service policy', lines)
}

function checkRuntimeOwnsVoiceTextProcessing(): void {
  const runtimeFile = path.join(root, 'packages/backend/voice/voice-text.ts')
  const runtimeTestFile = path.join(root, 'packages/backend/voice/__tests__/voice-text.test.ts')
  const runtimeIndexFile = path.join(root, 'packages/backend/voice/voice.ts')
  const mainFile = path.join(root, 'packages/backend/voice/voice-service.ts')
  const sharedFiles = [
    path.join(root, 'packages/shared/voice/segmenter.ts'),
    path.join(root, 'packages/shared/voice/tts-stream.ts'),
    path.join(root, 'packages/shared/voice/speak-markup.ts'),
  ]
  const runtimeContent = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, 'utf-8') : ''
  const runtimeTestContent = fs.existsSync(runtimeTestFile) ? fs.readFileSync(runtimeTestFile, 'utf-8') : ''
  const runtimeIndexContent = fs.existsSync(runtimeIndexFile) ? fs.readFileSync(runtimeIndexFile, 'utf-8') : ''
  const mainContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf-8') : ''
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
    // 深层引用收口第四批(2026-10-04):入口改成只交外面真在用的名字(R6),`voice-text.ts` 的名字外面没人用,
    // 入口不再整只转交它;「归 packages/backend 所有」已由上面几条判了,这一条不再要求入口提到它。
    ...requiredMainDelegations
      .filter(symbol => !mainContent.includes(symbol))
      .map(symbol => `${rel(mainFile)}: main voice service must delegate voice text processing ${symbol} to runtime`),
    ...sharedFiles.filter(file => fs.existsSync(file))
      .map(file => `${rel(file)}: retired shared implementation facade must not be restored; import the runtime voice/text public entry`),
  ]

  assertNoMatches('packages/backend owns voice text processing', lines)
}

/**
 * **检索只有一条查询路**(检索重建 S5)。
 *
 * 一条 = `search/search-client-api.ts` → 进程单槽里的 `SearchService` → 注册表 → 能力。
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
  const facadeFile = path.join(root, 'packages/backend/search/search-install-providers.ts')
  const sharedSearchContent = fs.existsSync(sharedSearchFile) ? fs.readFileSync(sharedSearchFile, 'utf-8') : ''
  const facadeContent = fs.existsSync(facadeFile) ? fs.readFileSync(facadeFile, 'utf-8') : ''
  const facadeLines = facadeContent.split('\n').filter(line => line.trim().length > 0)

  // ① 旧路的形状:runtime 的检索树 + 装配层的检索接线 + 契约层那一份,全扫。
  const searchTrees = [
    // 装配层的检索接线(第③步起住在 `search/`)已含在这一棵里。
    path.join(root, 'packages/backend/search'),
    // 从前的 `rpc/domains/` 拆成了 `http-server/`(分发)与各功能的 `<功能>-client-api*.ts`(包根归位 2026-10-04),两半都扫。
    path.join(root, 'packages/backend/http-server'),
  ].filter(dir => fs.existsSync(dir))
  const runtimeRoot = path.join(root, 'packages/backend')
  const clientApiFiles = fs.readdirSync(runtimeRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !BACKEND_NON_FEATURE_DIRS.has(entry.name))
    .flatMap(entry => fs.readdirSync(path.join(runtimeRoot, entry.name))
      .filter(name => clientApiFeatureOf(`packages/backend/${entry.name}/${name}`) === entry.name)
      .map(name => path.join(runtimeRoot, entry.name, name)))

  const lines = [
    ...RETIRED_SCAN_PATH_MODULES
      .filter(module => fs.existsSync(path.join(root, module)))
      .map(module => `${module}: 旧扫描路的模块又回来了(S5 已退役)`),
    ...SEARCH_CAPABILITY_MODULES
      .filter(module => !fs.existsSync(path.join(root, module)))
      .map(module => `${module}: 缺一个内置能力的文件(一类 = 一个文件)`),
    ...searchTrees
      .flatMap(dir => walkFiles(dir))
      .concat(clientApiFiles)
      .flatMap(file => matchingCodeLines(file, RETIRED_SCAN_PATH_PATTERNS)),
    ...(fs.existsSync(sharedSearchFile)
      ? matchingCodeLines(sharedSearchFile, RETIRED_SCAN_PATH_PATTERNS)
      : [`packages/shared/ipc/search.ts: missing search IPC contract`]),
    // ② 契约层不许从 runtime 拿值(类型也不行:那会把产品层拖进渲染层的包)。
    ...(/from\s+['"]@onething\/backend/.test(sharedSearchContent)
      ? [`${rel(sharedSearchFile)}: 契约层不许 import runtime —— 「能搜什么」问 search.capabilities`]
      : []),
    // ③ 门面极薄。
    ...(fs.existsSync(facadeFile)
      ? []
      : ['packages/backend/search/search-install-providers.ts: missing search adapters assembly point']),
    ...(facadeLines.length > 40
      ? [`${rel(facadeFile)}: 取材面门面必须保持极薄(现在 ${facadeLines.length} 行)`]
      : []),
  ]

  assertNoMatches('search has exactly one query path (registry + capabilities)', lines)
}

/**
 * **会话状态只经账本到达客户端**(2026-09-07 撤回会话同步协议;
 * 验尸单 `docs/audit/session-sync-retirement-2026-09-07.md`)。
 *
 * 曾经有过第二套真相:服务端在每个 token 上重新取整会话消息、深比对、序列化,
 * 再经 `GET /api/sync` + `GET /api/events?sync=1` + `session:sync` 帧推给客户端,
 * 与流管道并行跑。仓里已有唯一账本 `sessions/<id>/events.jsonl` —— 渲染层自己
 * 折投影、`StreamWater` 走流水位、缺号整会话重折;断线恢复是 SSE 的 `?after=`
 * 从环形缓冲续播。整条协议已删,这条规则是它的验尸台:下面这些名字不许长回来。
 *
 * 扫 `packages/` / `apps/` / `scripts/` 的非测试 `.ts` / `.tsx`(本文件自己除外
 * —— 规则的模式串就写在这儿)。
 */
function checkSessionStateReachesClientsOnlyThroughTheLedger(): void {
  const retiredSyncProtocolPatterns: RegExp[] = [
    /session-sync/,
    /\/api\/sync/,
    /SessionSync/,
    /onSync\(/,
    /setSyncScopes/,
    /x-onething-sync-protocol/,
  ]
  const selfPath = path.join(root, 'scripts/headless-boundary-check.ts')
  const trees = ['packages', 'apps', 'scripts']
    .map(dir => path.join(root, dir))
    .filter(dir => fs.existsSync(dir))
  const lines = trees
    .flatMap(dir => walkFiles(dir, [], { extensions: /\.tsx?$/, excludeDirs: ['dist', 'dist-electron', 'release', 'out'] }))
    .filter(file => file !== selfPath && !/\.(test|spec)\.tsx?$/.test(path.basename(file)))
    .flatMap(file => matchingCodeLines(file, retiredSyncProtocolPatterns))
  assertNoMatches('session state reaches clients only through the ledger', lines)
}

function checkRuntimeOwnsHeadlessCliProjections(): void {
  const runtimeFile = path.join(root, 'packages/backend/headless/headless-cli-projections.ts')
  const mainFile = path.join(root, 'packages/backend/headless/headless-backend.ts')
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
      : ['packages/backend/headless/headless-backend.ts: missing headless backend adapter']),
  ]

  assertNoMatches('packages/backend owns headless CLI projections', lines)
}

function checkRuntimeOwnsPromptsStore(): void {
  const runtimeFile = path.join(root, 'packages/backend/prompt/prompt-store.ts')
  const runtimeIpcFile = path.join(root, 'packages/backend/prompt/prompt-ipc-operations.ts')
  // P3'a-2:归位 `prompt/prompt-store-bound.ts`(与 runtime 的 `store.ts` 同概念异角色,故带 -bound)。
  const mainFile = path.join(root, 'packages/backend/prompt/prompt-store-bound.ts')
  // 迁移后调用 ipc-operations 的是 RPC 域,不再是 @main 的 handler。
  const mainIpcFile = path.join(root, 'packages/backend/prompt/prompt-client-api.ts')
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
      : ['packages/backend/prompt/prompt-store-bound.ts: missing prompts store facade']),
    ...(fs.existsSync(mainIpcFile)
      ? matchingLines(mainIpcFile, MAIN_PROMPTS_IPC_OPERATIONS_FORBIDDEN_PATTERNS)
      : ['packages/backend/prompt/prompt-client-api.ts: missing prompts RPC domain']),
  ]

  assertNoMatches('packages/backend owns prompts store', lines)
}

function checkRuntimeOwnsSystemPromptSnapshot(): void {
  const runtimeFiles = [
    path.join(root, 'packages/backend/prompt/prompt-system-snapshot.ts'),
    path.join(root, 'packages/backend/prompt/prompt.ts'),
  ]
  const mainFile = path.join(root, 'packages/backend/engine/prompt/engine-system-prompt-snapshot.ts')
  // P4c 第五批:快照读取的调用点已是 RPC 域。
  const chatIpcFile = path.join(root, 'packages/backend/engine/engine-client-api.ts')
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
      .map(symbol => `packages/backend/prompt/prompt-system-snapshot.ts: missing runtime-owned ${symbol}`),
    // 去 core 批 2(2026-10-03):从前判的是「经 core 的 engine 桶那条相对路径引组装函数」;那个目录并进了 runtime,
    // 相对路径不存在了。意图不变 —— 组装函数要从产品那一份(`prompt`)引 —— 判据改成直接看它是不是从那里来的。
    ...(mainContent.includes('buildSystemPromptSnapshotWithAdapters') && !/buildSystemPromptSnapshotWithAdapters,?\s*\}\s*from\s*'@onething\/backend\/prompt'/.test(mainContent)
      ? [`${rel(mainFile)}: system prompt snapshot adapter should import runtime-owned builder`]
      : []),
    ...(fs.existsSync(chatIpcFile)
      ? matchingLines(chatIpcFile, MAIN_CHAT_IPC_SYSTEM_PROMPT_SNAPSHOT_FORBIDDEN_PATTERNS)
      : ['packages/backend/engine/engine-client-api.ts: missing chat RPC domain']),
  ]

  assertNoMatches('packages/backend owns system prompt snapshot assembly', lines)
}

function checkRuntimeOwnsProjectDirsStore(): void {
  const runtimeFiles = [
    path.join(root, 'packages/backend/project-dir/project-dir-store.ts'),
    path.join(root, 'packages/backend/project-dir/project-dir-persistence.ts'),
    path.join(root, 'packages/backend/project-dir/project-dir-id.ts'),
    path.join(root, 'packages/backend/project-dir/project-dir-prompt.ts'),
    path.join(root, 'packages/backend/project-dir/project-dir-types.ts'),
    path.join(root, 'packages/backend/project-dir/project-dir-ipc-operations.ts'),
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
      .map(symbol => `packages/backend/project-dir: missing runtime-owned ${symbol}`),
    // ③-收尾 A 撤:原来这里还点名装配层 project-dirs 目录下五只「转发壳」(store/prompt/types…)回来即红。
    // 那个目录整只平铺进了 `project-dir`,照搬过来点名的就是上面那几只产品本体 —— 前提是两层,撤掉。
    ...(fs.existsSync(mainIpcFile)
      ? matchingLines(mainIpcFile, MAIN_PROJECT_DIRS_IPC_OPERATIONS_FORBIDDEN_PATTERNS)
      // 结构债 P4c:该域已整只迁到通用 RPC 通道,旧的 `@main/ipc/<域>.ts` 适配文件
      // 不存在了 —— 「文件缺席 = 红」这一支随之退役,上面「runtime 拥有实现」的断言照旧。
      : []),
  ]

  assertNoMatches('packages/backend owns project-dirs store and prompt helpers', lines)
}

function checkRuntimeOwnsVariablesStoreAndHelpers(): void {
  const runtimeFiles = [
    path.join(root, 'packages/backend/variable/variable-store.ts'),
    path.join(root, 'packages/backend/variable/variable-schema.ts'),
    path.join(root, 'packages/backend/variable/variable-format.ts'),
    path.join(root, 'packages/backend/variable/variable-validation.ts'),
    path.join(root, 'packages/backend/variable/variable-types.ts'),
    path.join(root, 'packages/backend/variable/variable-ipc-operations.ts'),
    path.join(root, 'packages/backend/variable/variable-registry.ts'),
    path.join(root, 'packages/backend/variable/providers/variable-providers-core.ts'),
    path.join(root, 'packages/backend/variable/providers/variable-providers-session-store.ts'),
    path.join(root, 'packages/backend/variable/providers/variable-providers-global-store.ts'),
    path.join(root, 'packages/backend/variable/providers/variable-providers.ts'),
  ]
  // P3'a-2:归位 `variable/variable-store-bound.ts`(盘上 IO 在同批的 variable-store-persistence.ts)。
  const mainStoreFile = path.join(root, 'packages/backend/variable/variable-store-bound.ts')
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
    'SessionStoreProvider',
    'GlobalStoreProvider',
  ]
  const lines = [
    ...runtimeFiles
      .filter(file => !fs.existsSync(file))
      .map(file => `${rel(file)}: missing runtime-owned variables module`),
    ...requiredRuntimeSymbols
      .filter(symbol => !runtimeContent.includes(symbol))
      .map(symbol => `packages/backend/variable: missing runtime-owned ${symbol}`),
    ...(fs.existsSync(mainStoreFile)
      ? matchingLines(mainStoreFile, MAIN_VARIABLES_RUNTIME_FORBIDDEN_PATTERNS)
      : ['packages/backend/variable/variable-store-bound.ts: missing variables store host adapter']),
    // ③-收尾 A 撤:原来这里还点名装配层 variables 目录下九只已删的转发壳(format / registry / providers/*…)回来即红。
    // 那个目录整只平铺进了 `variable`,照搬过来点名的正是 runtimeFiles 里的产品本体 —— 前提是两层,撤掉。
    ...(fs.existsSync(mainIpcFile)
      ? matchingLines(mainIpcFile, MAIN_VARIABLES_IPC_OPERATIONS_FORBIDDEN_PATTERNS)
      // 结构债 P4c:该域已整只迁到通用 RPC 通道,旧的 `@main/ipc/<域>.ts` 适配文件
      // 不存在了 —— 「文件缺席 = 红」这一支随之退役,上面「runtime 拥有实现」的断言照旧。
      : []),
  ]

  assertNoMatches('packages/backend owns variables store and pure helpers', lines)
}

function checkRuntimeOwnsAgentsStoreAndIpcOperations(): void {
  const runtimeStoreFile = path.join(root, 'packages/backend/agent/agent-store.ts')
  const runtimeIpcFile = path.join(root, 'packages/backend/agent/agent-ipc-operations.ts')
  // P3'a-2:归位 `agent/agent-store-bound.ts`(吃 @shared/ipc 的 AgentDefinition;当年因此带 `.wiring` 后缀,2026-10-03 去掉)。
  const mainStoreFile = path.join(root, 'packages/backend/agent/agent-store-bound.ts')
  const adapterFile = path.join(root, 'packages/backend/agent/agent-client-api.ts')
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
      : ['packages/backend/agent/agent-store-bound.ts: missing agent store adapter']),
    ...(fs.existsSync(adapterFile)
      ? matchingLines(adapterFile, MAIN_AGENTS_IPC_OPERATIONS_FORBIDDEN_PATTERNS)
      : [`${rel(adapterFile)}: missing agents RPC domain`]),
  ]

  assertNoMatches('packages/backend owns agents store and IPC operations', lines)
}

function checkRuntimeOwnsAppStateUiSave(): void {
  const runtimeFile = path.join(root, 'packages/backend/storage/storage-app-state.ts')
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

  assertNoMatches('packages/backend owns app-state UI save flow', lines)
}

function checkRuntimeOwnsSchedulerIpcOperations(): void {
  const runtimeFile = path.join(root, 'packages/backend/scheduler/scheduler-ipc-operations.ts')
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

  assertNoMatches('packages/backend owns scheduler IPC operations', lines)
}

function checkRuntimeOwnsSchedulerCore(): void {
  const runtimeSchedulerFile = path.join(root, 'packages/backend/scheduler/scheduler-cron-runner.ts')
  const runtimeCronFile = path.join(root, 'packages/backend/scheduler/scheduler-cron.ts')
  const runtimeTypesFile = path.join(root, 'packages/backend/scheduler/scheduler-types.ts')
  const runtimeIndexFile = path.join(root, 'packages/backend/scheduler/scheduler.ts')
  // P3'a-3:绑定件从 `app/scheduler/index.ts` 归位到 `scheduler/scheduler-bound.ts`
  // —— 它配的是 store 路径 + `./scheduler.js`,唯一的装配层边 `consolePort` 也已归位。
  const mainSchedulerFile = path.join(root, 'packages/backend/scheduler/scheduler-bound.ts')
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
    './scheduler-cron.js',
    './scheduler-cron-runner.js',
    // `./scheduler-types.js`:深层引用收口第四批(2026-10-04)起入口只交外面真在用的名字(R6),
    // 调度器的类型外面没人经入口拿,入口不再整只转交它;类型的归属由下面 requiredRuntimeTypeSymbols 判。
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
      // 归位之后它是包内文件,说的是相对路径 `./scheduler-cron-runner.js`(同 runtime 其余源码的
      // 惯例:只有测试用 `@onething/backend/<功能>/*` 自引用)。断言的语义不变:**绑定件必须
      // 去配 runtime 拥有的那台调度器,而不是自己长一台**。
      mainSchedulerContent.includes('./scheduler-cron-runner.js') && mainSchedulerContent.includes('configureOnethingScheduler')
        ? []
        : [`${rel(mainSchedulerFile)}: bound scheduler facade must configure the runtime-owned scheduler`]
    ),
    // P3'a-2(I2)曾在这里钉「装配层 scheduler 目录下的 `cron.ts` / `types.ts` 两只转发壳回来才算红」。
    // ③-收尾 A 把那个目录平铺进 `scheduler` 之后,同名的正是产品本体 —— 前提是两层,撤掉。
    ...(fs.existsSync(mainSchedulerFile)
      ? matchingLines(mainSchedulerFile, MAIN_SCHEDULER_CORE_FORBIDDEN_PATTERNS)
      : ['packages/backend/scheduler/scheduler-bound.ts: missing scheduler core adapter']),
  ]

  assertNoMatches('packages/backend owns scheduler core runtime', lines)
}

function checkRuntimeOwnsSchedulerRunHistory(): void {
  const runtimeFile = path.join(root, 'packages/backend/scheduler/scheduler-run-history.ts')
  const runtimeIndexFile = path.join(root, 'packages/backend/scheduler/scheduler.ts')
  // P3'a-3:绑定件从 `app/scheduler/run-history.ts` 归位到
  // `scheduler/scheduler-run-history-bound.ts` —— 它吃 `@shared/ipc` 的 `SchedulerRunDetailDTO`
  // (当年因此带 `.wiring` 后缀,2026-10-03 去掉)。
  const mainFile = path.join(root, 'packages/backend/scheduler/scheduler-run-history-bound.ts')
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
    ...(!runtimeIndexContent.includes('./scheduler-run-history.js')
      ? [`${rel(runtimeIndexFile)}: missing scheduler run-history public export`]
      : []),
    ...(
      mainContent.includes('./scheduler-run-history.js') && mainContent.includes('OnethingSchedulerRunHistory')
        ? []
        : [`${rel(mainFile)}: bound scheduler run-history facade must use the runtime-owned run history`]
    ),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_SCHEDULER_RUN_HISTORY_FORBIDDEN_PATTERNS)
      : ['packages/backend/scheduler/scheduler-run-history-bound.ts: missing scheduler run-history adapter']),
  ]

  assertNoMatches('packages/backend owns scheduler run-history storage', lines)
}

function checkRuntimeOwnsSchedulerUserTaskStore(): void {
  const runtimeFile = path.join(root, 'packages/backend/scheduler/scheduler-user-tasks.ts')
  const runtimeIndexFile = path.join(root, 'packages/backend/scheduler/scheduler.ts')
  const mainFile = path.join(root, 'packages/backend/scheduler/scheduler-user-task-service.ts')
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
    ...(!runtimeIndexContent.includes('./scheduler-user-tasks.js')
      ? [`${rel(runtimeIndexFile)}: missing scheduler user-task public export`]
      : []),
    ...(
      mainContent.includes('@onething/backend/scheduler')
        && mainContent.includes('OnethingSchedulerUserTaskStore')
        && mainContent.includes('previewOnethingSchedulerPrompt')
        ? []
        : [`${rel(mainFile)}: main scheduler user-tasks adapter must use @onething/backend/scheduler user-task store`]
    ),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_SCHEDULER_USER_TASK_STORE_FORBIDDEN_PATTERNS)
      : ['packages/backend/scheduler/scheduler-user-task-service.ts: missing scheduler user-tasks adapter']),
  ]

  assertNoMatches('packages/backend owns scheduler user-task store', lines)
}

function checkRuntimeOwnsSchedulerRunDetailProjection(): void {
  const runtimeFile = path.join(root, 'packages/backend/scheduler/scheduler-run-detail.ts')
  const runtimeRunnerFile = path.join(root, 'packages/backend/scheduler/scheduler-agent-task-runner.ts')
  const runtimeIndexFile = path.join(root, 'packages/backend/scheduler/scheduler.ts')
  const mainUserTasksFile = path.join(root, 'packages/backend/scheduler/scheduler-user-task-service.ts')
  // 结构债 P4c:定时任务的传输面从 `@main/ipc/scheduler.ts` 换成了 RPC 域文件。
  // 断言本身不变 —— 传输面必须把运行详情的投影**委托**给 runtime,而不是自己拼。
  const mainIpcFile = path.join(root, 'packages/backend/scheduler/scheduler-client-api.ts')
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
    // 深层引用收口第四批(2026-10-04):入口改成只交外面真在用的名字(R6),`scheduler-run-detail.ts` 的名字外面没人用,
    // 入口不再整只转交它;「归 packages/backend 所有」已由上面几条判了,这一条不再要求入口提到它。
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
      : ['packages/backend/scheduler/scheduler-user-task-service.ts: missing scheduler user-tasks adapter']),
  ]

  assertNoMatches('packages/backend owns scheduler run-detail projection', lines)
}

function checkRuntimeOwnsSchedulerAgentTaskRunner(): void {
  const runtimeFile = path.join(root, 'packages/backend/scheduler/scheduler-agent-task-runner.ts')
  const runtimeIndexFile = path.join(root, 'packages/backend/scheduler/scheduler.ts')
  const mainFile = path.join(root, 'packages/backend/scheduler/scheduler-user-task-service.ts')
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
    ...(!runtimeIndexContent.includes('./scheduler-agent-task-runner.js')
      ? [`${rel(runtimeIndexFile)}: missing scheduler agent-task runner public export`]
      : []),
    ...(
      mainContent.includes('runOnethingSchedulerAgentTask')
        ? []
        : [`${rel(mainFile)}: main scheduler user-tasks must delegate agent task execution to runtime`]
    ),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_SCHEDULER_AGENT_TASK_RUNNER_FORBIDDEN_PATTERNS)
      : ['packages/backend/scheduler/scheduler-user-task-service.ts: missing scheduler user-tasks adapter']),
  ]

  assertNoMatches('packages/backend owns scheduler agent task runner', lines)
}

// P4c 第八批:files 的十四条数据面已迁 `filesRouter`,`@main/ipc/files.ts` 与
// `apps/electron/src/ipc/files.ts` 整只删掉。下面六条「runtime 拥有 X 操作」的断言
// 因此改指**域处理者**(`packages/backend/file/file-client-api.ts`)—— 守的还是同一件事:
// 投影逻辑住在产品层,传输层只转调,不许在这里重抄一份。
const FILES_RPC_DOMAIN_FILE = 'packages/backend/file/file-client-api.ts'

function checkRuntimeOwnsFilesListIpcOperation(): void {
  const runtimeFile = path.join(root, 'packages/backend/file/file-search.ts')
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

  assertNoMatches('packages/backend owns files list IPC operation', lines)
}

function checkRuntimeOwnsDirsListIpcOperation(): void {
  const runtimeFile = path.join(root, 'packages/backend/file/file-directory-listing.ts')
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

  assertNoMatches('packages/backend owns dirs list IPC operation', lines)
}

function checkRuntimeOwnsFileContentAndDirectoryOperations(): void {
  const runtimeFile = path.join(root, 'packages/backend/file/file-operations.ts')
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

  assertNoMatches('packages/backend owns file content and directory operations', lines)
}

function checkRuntimeOwnsFileMutationOperations(): void {
  const runtimeFile = path.join(root, 'packages/backend/file/file-operations.ts')
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

  assertNoMatches('packages/backend owns file mutation operations', lines)
}

function checkRuntimeOwnsFileRollbackOperation(): void {
  const runtimeFile = path.join(root, 'packages/backend/file/file-rollback.ts')
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

  assertNoMatches('packages/backend owns file rollback operation', lines)
}

function checkRuntimeOwnsFileWatchOperations(): void {
  const runtimeFile = path.join(root, 'packages/backend/file/file-watch.ts')
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

  assertNoMatches('packages/backend owns file watch IPC operations', lines)
}

function checkRuntimeOwnsRipgrepFileSearchRuntime(): void {
  const runtimeFile = path.join(root, 'packages/backend/file/file-ripgrep.ts')
  const runtimeIndexFile = path.join(root, 'packages/backend/file/file.ts')
  const runtimeTestFile = path.join(root, 'packages/backend/file/__tests__/file-ripgrep.test.ts')
  const mainFile = path.join(root, 'packages/backend/file/file-ripgrep-app-fetch.ts')
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
    ...(!runtimeIndexContent.includes('./file-ripgrep.js')
      ? [`${rel(runtimeIndexFile)}: missing ripgrep public export`]
      : []),
    // 包根归位 B(2026-10-04):门面从包根 `utils/ripgrep.ts` 搬进了 files 自己(`files-ripgrep-app-fetch.ts`),
    // 与实现同目录,委派写相对路径 `./file-ripgrep.js`;两种写法都认。
    ...(!/@onething\/backend\/file\/file-ripgrep|\.\/file-ripgrep\.js/.test(mainContent)
      ? [`${rel(mainFile)}: ripgrep facade must delegate to runtime ripgrep`]
      : []),
    ...(mainLines.length > 40
      ? [`${rel(mainFile)}: ripgrep facade must stay thin`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_RIPGREP_UTIL_FORBIDDEN_PATTERNS)
      : [`${rel(mainFile)}: missing ripgrep main facade`]),
  ]

  assertNoMatches('packages/backend owns ripgrep file search runtime', lines)
}

function checkRuntimeOwnsToolSandboxRuntime(): void {
  const runtimeFile = path.join(root, 'packages/backend/tool/tool-sandbox-runtime.ts')
  const runtimeIndexFile = path.join(root, 'packages/backend/tool/tool.ts')
  const runtimeTestFile = path.join(root, 'packages/backend/tool/__tests__/tool-sandbox-runtime.test.ts')
  const mainFile = path.join(root, 'packages/backend/permission/permission-sandbox-roots.ts')
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
    ...(!runtimeIndexContent.includes('./tool-sandbox-runtime.js')
      ? [`${rel(runtimeIndexFile)}: missing sandbox-runtime public export`]
      : []),
    // 深层引用收口第三批(2026-10-04)起门面经 tool 入口拿这几只函数(入口从 `./tool-sandbox-runtime.js` 转交,上面那条已经判了),
    // 所以「委托给 sandbox-runtime」认入口或深层两种写法。
    ...(!mainContent.includes('@onething/backend/tool/tool-sandbox-runtime') && !/from '@onething\/backend\/tool'/.test(mainContent)
      ? [`${rel(mainFile)}: sandbox facade must delegate to runtime sandbox-runtime`]
      : []),
    ...(mainLines.length > 70
      ? [`${rel(mainFile)}: sandbox facade must stay thin`]
      : []),
    ...(fs.existsSync(mainFile)
      ? matchingLines(mainFile, MAIN_TOOL_SANDBOX_FORBIDDEN_PATTERNS)
      : [`${rel(mainFile)}: missing sandbox main facade`]),
  ]

  assertNoMatches('packages/backend owns tool sandbox runtime', lines)
}

function checkRuntimeOwnsToolEditEngine(): void {
  const runtimeFile = path.join(root, 'packages/backend/tool/tool-edit-engine.ts')
  const runtimeIndexFile = path.join(root, 'packages/backend/tool/tool.ts')
  const runtimeTestFile = path.join(root, 'packages/backend/tool/__tests__/tool-edit-engine.test.ts')
  const mainFile = path.join(root, 'packages/backend/tool/access-control/edit-engine.ts')
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
    ...(!runtimeIndexContent.includes('./tool-edit-engine.js')
      ? [`${rel(runtimeIndexFile)}: missing edit-engine public export`]
      : []),
    ...(fs.existsSync(mainFile)
      ? [
          `${rel(mainFile)}: edit-engine facade should be removed; import @onething/backend/tool/tool-edit-engine directly`,
          ...matchingLines(mainFile, MAIN_TOOL_EDIT_ENGINE_FORBIDDEN_PATTERNS),
        ]
      : []),
  ]

  assertNoMatches('packages/backend owns tool edit engine', lines)
}

/**
 * R4b —— 具体工具实现归产品层。
 *
 * 主语从旧 `tool/builtin/*.ts`(`Tool.define` 那一批)换成新树的
 * `toolkit/builtin/*.ts`;三档目录的装配住在 `app/toolkit/catalog.ts`。
 * `removedFiles` 那张长表原样保留 —— 它守的是"这些东西不许再爬回 core / 装配层",
 * 而 R4b 又给它添了旧 builtin 那一批。
 */
function checkRuntimeOwnsConcreteBuiltinTools(): void {
  const removedFiles = [
    // 「这些不许爬回 core 的 tools 目录」那 13 格随去 core 批 1(2026-10-03)撤掉:那个目录整个并进了
    // `tool/`,那几只纯模块本来就住在那里,core 侧的那个位置不存在了。
    'packages/backend/tool/builtin/get-current-time.ts',
    'packages/backend/tool/builtin/fart.ts',
    'packages/backend/tool/builtin/index.ts',
    'packages/backend/tool/builtin/headless.ts',
    'packages/backend/tool/builtin/readonly.ts',
    'packages/backend/tool/access-control/bash-classifier.ts',
    'packages/backend/tool/access-control/edit-engine.ts',
    'packages/backend/tool/access-control/file-mutation-audit.ts',
    'packages/backend/tool/access-control/file-mutation-queue.ts',
    'packages/backend/tool/access-control/output-accumulator.ts',
    'packages/backend/tool/access-control/sensitive-files.ts',
    'packages/backend/tool/access-control/text-truncation.ts',
    'packages/backend/tool/access-control/tool-effect.ts',
    'packages/backend/tool/access-control/tool-result.ts',
    'packages/backend/tool/access-control/tool.ts',
    // R4b:旧的 `Tool.define` 工具对象。它们的实现搬进了 `toolkit/builtin/`。
    'packages/backend/tool/builtin/read.ts',
    'packages/backend/tool/builtin/write.ts',
    'packages/backend/tool/builtin/edit.ts',
    'packages/backend/tool/builtin/bash.ts',
    'packages/backend/tool/builtin/time.ts',
    'packages/backend/tool/builtin/variable.ts',
    'packages/backend/tool/builtin/say.ts',
    'packages/backend/tool/scene-surface.ts',
  ].filter(file => fs.existsSync(path.join(root, file)))
  const publicExportPaths = [
    path.join(root, 'packages/backend/tool/tool-helpers.ts'),
  ]
  const toolkitIndexFile = path.join(root, 'packages/backend/toolkit/toolkit.ts')
  const toolkitTimeFile = path.join(root, 'packages/backend/toolkit/builtin/toolkit-builtin-time.ts')
  const timeRuntimeFile = path.join(root, 'packages/backend/tool/builtin/tool-builtin-time-runtime.ts')
  const timeGoldenFile = path.join(root, 'packages/backend/toolkit/__tests__/golden/time.test.ts')
  const catalogFile = path.join(root, 'packages/backend/toolkit/toolkit-tier-catalogs.ts')
  const toolkitIndexContent = fs.existsSync(toolkitIndexFile) ? fs.readFileSync(toolkitIndexFile, 'utf-8') : ''
  const toolkitTimeContent = fs.existsSync(toolkitTimeFile) ? fs.readFileSync(toolkitTimeFile, 'utf-8') : ''
  const timeRuntimeContent = fs.existsSync(timeRuntimeFile) ? fs.readFileSync(timeRuntimeFile, 'utf-8') : ''
  const catalogContent = fs.existsSync(catalogFile) ? fs.readFileSync(catalogFile, 'utf-8') : ''
  const requiredTimeSymbols = ['TimeTool', 'executeCoreTimeTool', 'resolveCoreTimezone']
  const lines = [
    ...removedFiles.map(file => `${file}: concrete builtin tools belong in packages/backend/toolkit`),
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
    ...(!toolkitIndexContent.includes('./builtin/toolkit-builtin-time.js')
      ? [`${rel(toolkitIndexFile)}: missing time public export`]
      : []),
    ...(!catalogContent.includes('createTimeTool')
      ? [`${rel(catalogFile)}: tier catalogs must register the time tool`]
      : []),
  ]

  assertNoMatches('packages/backend owns concrete builtin tool implementations', lines)
}

// ── C0(`docs/design/client-sdk-2026-09.md` §3):`packages/backend-client` 的两条边界 ──

/**
 * `packages/backend-client`(`@onething/backend-client`)禁 import 的东西。
 *
 * 判据一句话:**它是 core 的客户端底座,不是任何一个壳的一部分**。所以既不认识
 * 前端框架(react / vue),也不认识宿主(electron / `@main` / `@preload`),也不
 * 反向依赖上层(`@onething/backend` 与它的任何子路径 —— 依赖是单向的:
 * 产品 ← 装配 ← 宿主,而客户端在这条链之外,只吃 `@shared` 契约)。2026-10 ①d 起
 * 连 core 的纯类型也不许了(core 已于 2026-10-03 整个并进 runtime),那一条由 `checkClientImportsOnlySharedAndBackendClient`
 * 统一守(它覆盖 client 侧三棵树)。`@renderer` / `@/` 是 Vue 渲染层的两个别名 —— 搬家的**目的**就是
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
  /^@onething\/electron-host(?:\/|$)/,
  // 相对路径爬出包外(`../../renderer/...`)也是同一件事。
  /^\.\.\/\.\.\//,
]

/**
 * 浏览器独有的全局,`packages/backend-client` 一个都不许**裸用** —— 连
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
  const clientRoot = path.join(root, 'packages/backend-client')
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
    'packages/backend-client stays framework-free, host-free and browser-global-free',
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
  // (`capabilities/search-capabilities-sessions.ts` 的 manifest),设计文档 §10 里叫 `sessions`。
  // 哪个名字最后活下来是**能力自己的事**,core 里一个都不许出现 —— 只列文档那个
  // 名字,等于给真正在跑的那个 id 开了后门。
  /(['"])(?:messages|chats|sessions|files|actions|prompts|daily)\1/,
  /(['"])plugin:/,
]

const CORE_SEARCH_KIND_SWITCH_PATTERN = /\bswitch\s*\([^)]*\.(?:kind|capability)\b/

function checkCoreSearchNamesNoCapability(): void {
  const searchRoot = path.join(root, 'packages/backend/search/kernel')
  if (!fs.existsSync(searchRoot)) {
    // 从前目录不在时这里打一行「absent (S1 pending)」的 ok:S1 早已落地,目标目录不见了只可能是搬家没跟上,
    // 绿着放过去就是「尺子丢了还报平安」。
    assertNoMatches('packages/backend/search/kernel names no capability (no capability-id literals, no switch on .kind/.capability)',
      [`${rel(searchRoot)}: search kernel directory is missing — the check lost its target`])
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
    'packages/backend/search/kernel names no capability (no capability-id literals, no switch on .kind/.capability)',
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
 * **shared 只 import shared;client 侧只 import shared、`@onething/backend-client` 与自己**
 * (server / client 拆分第①步 ①d,`docs/design/server-client-split-2026-10.md` §0 / §2)。
 * 零基线硬闸。
 *
 * 依赖方向只有一种:`client 侧 → shared ← server 侧`,client 与 server 互不 import。
 *
 * - **shared**:非测试代码只许 import shared 自己(相对路径不出 `packages/shared`,或 `@shared/*`)。
 *   不许 `@onething/*`、不许 `node:` / node 内建、不许 electron、不许第三方包 —— shared 要同时进
 *   浏览器包、Metro(手机)与 node,带一个 node 依赖就有一边会坏。测试另放行 `vitest` 与 node
 *   内建(用例跑在 node 里),其余同样禁。
 * - **client 侧**(`apps/desktop-react/src`、`apps/mobile/{app,src}`、`packages/backend-client`):非测试代码
 *   只许 import `@shared/*`、`@onething/backend-client` 与自己(第三方 npm 包不在本条射程内)。类型导入
 *   一样算 —— 类型也是对 server 包的依赖,合包以后它会让 client 依赖 server。
 *
 * 放行写在这里,不写在注释里:
 * - `apps/desktop-react/src` → `apps/desktop-react/electron/native-view-protocol.ts`:那是页面与
 *   主进程之间的协议(原生视图的帧形状),属于 client 内部,与 server 无关。
 * - 测试(`__tests__/`、`*.test.*`、`*.spec.*`)与 `__fixtures__/`:夹具要演「后端下发的那一份」,
 *   最诚实的做法是跑后端那一个投影,在测试里手抄一份才是会漂的第二产地。
 * - (从前还有一条:`packages/shared/backend/http-discovery.ts` 的四个 `node:` 内建。第②步把它碰 node 的
 *   那一半拆成 server / client 各一份最小实现 —— `packages/backend/http-server/http-server-discovery-io.ts` 与
 *   `packages/backend-client/http-discovery-io.ts`,对拍测试钉住两份同答 —— shared 里只剩记录形状,放行随之删除。)
 *
 * 服务商自述试点 P4 的 `checkReactShellReadsProvidersOverRpc`(壳不许 import
 * `@onething/backend/provider|agent-loop`)是本条的子集,已并入这里。
 */
const NODE_BUILTIN_MODULE_NAMES = new Set(builtinModules.map(name => name.replace(/^node:/, '')))

function isNodeBuiltinSpecifier(specifier: string): boolean {
  return specifier.startsWith('node:') || NODE_BUILTIN_MODULE_NAMES.has(specifier.split('/')[0] ?? '')
}

function isTestOrFixtureFile(file: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)
    || file.split(path.sep).includes('__tests__')
    || file.split(path.sep).includes('__fixtures__')
}

function relativeTargetOf(file: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  return path.resolve(path.dirname(file), specifier)
}

function isInside(dir: string, target: string): boolean {
  const relPath = path.relative(dir, target)
  return relPath === '' || (!relPath.startsWith('..') && !path.isAbsolute(relPath))
}

function forbiddenImportLines(
  file: string,
  isForbidden: (specifier: string) => boolean,
): string[] {
  return codeOnlyLines(fs.readFileSync(file, 'utf-8'))
    .filter(({ code }) => importSpecifiersInCode(code).some(isForbidden))
    .map(({ raw, lineNo }) => `${rel(file)}:${lineNo}: ${raw.trim()}`)
}

function checkSharedImportsOnlyShared(): void {
  const sharedRoot = path.join(root, 'packages/shared')
  const files = walkFiles(sharedRoot, [], { includeTests: true, extensions: /\.(ts|tsx|js|mjs|cjs)$/ })
    .filter(file => !file.endsWith('.d.ts'))
  const lines = files.flatMap(file => {
    const isTest = isTestOrFixtureFile(file)
    return forbiddenImportLines(file, specifier => {
      const target = relativeTargetOf(file, specifier)
      if (target) return !isInside(sharedRoot, target)
      if (specifier === '@shared' || specifier.startsWith('@shared/')) return false
      if (isTest && (specifier === 'vitest' || isNodeBuiltinSpecifier(specifier))) return false
      return true
    })
  })
  assertNoMatches(
    'packages/shared imports only packages/shared (no @onething/*, no node built-ins, no electron, no third-party)',
    lines,
  )
}

const CLIENT_SIDE_ROOTS: Array<{ root: string; scan: string[] }> = [
  { root: 'apps/desktop-react/src', scan: ['apps/desktop-react/src'] },
  { root: 'apps/mobile', scan: ['apps/mobile/app', 'apps/mobile/src'] },
  { root: 'packages/backend-client', scan: ['packages/backend-client'] },
]

const CLIENT_SIDE_ALLOWED_ESCAPES: Array<{ from: string; to: string }> = [
  // 页面 ↔ 主进程的原生视图协议,属 client 内部。
  { from: 'apps/desktop-react/src', to: 'apps/desktop-react/electron/native-view-protocol' },
]

function checkClientImportsOnlySharedAndBackendClient(): void {
  const lines: string[] = []
  for (const side of CLIENT_SIDE_ROOTS) {
    const sideRoot = path.join(root, side.root)
    const escapes = CLIENT_SIDE_ALLOWED_ESCAPES
      .filter(escape => escape.from === side.root)
      .map(escape => path.join(root, escape.to))
    const files = side.scan.flatMap(dir => walkFiles(path.join(root, dir), [], {
      excludeDirs: ['__fixtures__'],
      extensions: /\.(ts|tsx|js|mjs|cjs)$/,
    }))
      .filter(file => !file.endsWith('.d.ts') && !isTestOrFixtureFile(file))
    for (const file of files) {
      lines.push(...forbiddenImportLines(file, specifier => {
        const target = relativeTargetOf(file, specifier)
        if (target) {
          if (isInside(sideRoot, target)) return false
          return !escapes.some(allowed => target.replace(/\.(ts|js)$/, '') === allowed)
        }
        if (/^@onething\//.test(specifier)) return !/^@onething\/backend-client(?:\/|$)/.test(specifier)
        return false
      }))
    }
  }
  assertNoMatches(
    'client side (apps/desktop-react/src, apps/mobile, packages/backend-client) imports only @shared/*, @onething/backend-client and itself',
    lines,
  )
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

checkVueHostStaysRetired()
checkRuntimeHostBoundary()
checkClientPackageBoundary()
checkCoreSearchNamesNoCapability()
checkShellsDoNotImportOtherShells()
checkSharedImportsOnlyShared()
checkClientImportsOnlySharedAndBackendClient()
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
checkMainCoreSystemAdapters()
checkCoreToolHelperTestsLiveInCorePackage()
checkCoreOwnsToolSchemaProjection()
checkSharedOwnsToolFailureParameterSummary()
checkSharedOwnsToolPermissionErrorText()
checkRuntimeToolHelperTestsLiveInRuntimePackage()
checkCoreOwnsSessionCommandIpcOperation()
checkSharedOwnsJsonProtocol()
checkSharedOwnsStreamChunkProtocol()
checkChatResumeAfterToolConfirmStaysRetired()
checkCorePromptAssemblyOwnedByRuntime()
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
checkSharedContractsHoldShapesOnly()
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
checkSessionStateReachesClientsOnlyThroughTheLedger()
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

assertNoMatches('backend public boundaries and shared contracts', checkBackendPublicBoundaries({ root }).violations)

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
