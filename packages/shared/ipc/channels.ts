/**
 * IPC Channel Names
 * All IPC channel constants for Electron main <-> renderer communication
 */

export const IPC_CHANNELS = {
	/**
	 * Generic RPC envelope (主线 T0). One channel for every domain router —
	 * `{ domain, method, payload }` in, `RpcResponse` out. This is the LAST
	 * per-domain-free channel we need: a new domain is a router file plus a
	 * backend handler registration, never a new constant here.
	 */
	RPC_INVOKE: "rpc:invoke",

	// Chat related
	GET_CHAT_HISTORY: "chat:get-history",
	CLEAR_CHAT: "chat:clear",
	GENERATE_TITLE: "chat:generate-title",
	GET_SYSTEM_PROMPT_SNAPSHOT: "chat:get-system-prompt-snapshot",

	// Streaming control
	ABORT_STREAM: "chat:abort-stream",
	GET_ACTIVE_STREAMS: "chat:get-active-streams",

	// Skill usage notification
	SKILL_ACTIVATED: "chat:skill-activated",

	// Image generation notification
	IMAGE_GENERATED: "chat:image-generated",

	// Step tracking for showing AI reasoning process
	STEP_ADDED: "chat:step-added",
	STEP_UPDATED: "chat:step-updated",

	// Session related
	GET_SESSIONS: "sessions:get-all",
	CREATE_SESSION: "sessions:create",
	SWITCH_SESSION: "sessions:switch",
	DELETE_SESSION: "sessions:delete",
	RENAME_SESSION: "sessions:rename",
	CREATE_BRANCH: "sessions:create-branch",
	UPDATE_SESSION_PIN: "sessions:update-pin",
	UPDATE_SESSION_MODEL: "sessions:update-model",
	UPDATE_SESSION_AGENT: "sessions:update-agent",
	UPDATE_SESSION_PERMISSION_MODE: "sessions:update-permission-mode",
	UPDATE_SESSION_ARCHIVED: "sessions:update-archived",
	UPDATE_SESSION_WORKING_DIRECTORY: "sessions:update-working-directory",
	GET_SESSION: "sessions:get",
	GET_SESSION_TOKEN_USAGE: "sessions:get-token-usage",
	UPDATE_SESSION_MAX_TOKENS: "sessions:update-max-tokens",
	CONTEXT_SIZE_UPDATED: "sessions:context-size-updated",
	// P1(2026-08-14):压缩的开始/结束通知只有一条正路 —— session:event 信封里
	// 的 context:compact-started / context:compact-completed。专用 IPC 通道
	// (主进程从来没往里发过一条)已删,别再加回来。
	// Session optimization (metadata separation)
	GET_SESSIONS_LIST: "sessions:get-list", // Returns SessionMeta[] only (no messages)
	ACTIVATE_SESSION: "sessions:activate", // Mark session as active, return details
	GET_SESSION_MESSAGES: "sessions:get-messages", // Returns ChatMessage[] for a session
	GET_SESSION_MESSAGES_PAGE: "sessions:get-messages-page", // Returns a cursor-addressed ChatMessage page
	GET_SESSION_USER_MARKERS: "sessions:get-user-markers", // Returns lightweight user-message nav markers
	GET_SESSION_SEGMENTS: "sessions:get-segments", // Returns the session's TOC segments
	SESSION_MESSAGES_CHANGED: "sessions:messages-changed", // Event: messages added/updated
	GET_SESSION_CACHE_STATS: "sessions:get-cache-stats", // Returns in-memory LRU cache stats
	EVICT_SESSION_CACHE: "sessions:evict-cache", // Evicts a session from the in-memory LRU cache

	// Settings related
	GET_SETTINGS: "settings:get",
	SAVE_SETTINGS: "settings:save",
	OPEN_SETTINGS_WINDOW: "settings:open-window",
	SETTINGS_NAVIGATE: "settings:navigate", // main → settings window: jump to a tab
	SETTINGS_CHANGED: "settings:changed",
	GET_SYSTEM_THEME: "settings:get-system-theme",
	SYSTEM_THEME_CHANGED: "settings:system-theme-changed",

	// Voice related
	VOICE_GET_STATE: "voice:get-state",
	VOICE_START: "voice:start",
	VOICE_STOP: "voice:stop",
	VOICE_SUBMIT_UTTERANCE: "voice:submit-utterance",
	VOICE_SUBMIT_TRANSCRIPT: "voice:submit-transcript",
	VOICE_SYNTHESIZE: "voice:synthesize",
	VOICE_TEST_ASR: "voice:test-asr",
	VOICE_TEST_TTS: "voice:test-tts",
	VOICE_GET_TTS_MODELS: "voice:get-tts-models",
	VOICE_EVENT: "voice:event",
	VOICE_RUNTIME_COMMAND: "voice:runtime-command",
	VOICE_RUNTIME_EVENT: "voice:runtime-event",
	VOICE_RUNTIME_READY: "voice:runtime-ready",
	VOICE_AUDIO_CHUNK: "voice:audio-chunk",

	// Music radio related
	MUSIC_GET_STATE: "music:get-state",
	MUSIC_SETUP: "music:setup",
	MUSIC_EVENT: "music:event",
	/** Transport controls for the composer's music bar (main -> ncm-cli directly). */
	MUSIC_COMMAND: "music:command",
	/** main -> renderer: what is playing, or null when nothing is. */
	MUSIC_NOW_PLAYING: "music:now-playing",
	/**
	 * renderer -> main pull of the same answer. MUSIC_NOW_PLAYING only fires on
	 * change, so a renderer that subscribes mid-song (reload, second window)
	 * must ask once or it waits until the next track for its first update.
	 */
	MUSIC_GET_NOW_PLAYING: "music:get-now-playing",
	/** renderer -> main: radio brief snapshot (active/intent/lastError). */
	MUSIC_GET_RADIO: "music:get-radio",
	/** main -> renderer: the current song's timed lyrics, once per song start. */
	MUSIC_LYRICS: "music:lyrics",
	/** renderer -> main pull of the same (reload mid-song). */
	MUSIC_GET_LYRICS: "music:get-lyrics",
	/**
	 * main -> renderer: the DJ's synthesized patter to play in the gap before a
	 * song. Audio rides here (not mpv) so music and voice stay on separate
	 * tracks; the renderer plays it and acks on MUSIC_DJ_SPEAK_DONE.
	 */
	MUSIC_DJ_SPEAK: "music:dj-speak",
	/** renderer -> main: DJ patter finished (or failed) playing, keyed by id. */
	MUSIC_DJ_SPEAK_DONE: "music:dj-speak-done",
	/** renderer -> main: open/retune the station from the bar (empty intent = DJ's call). */
	MUSIC_OPEN_RADIO: "music:open-radio",
	/** renderer -> main: song search for the panel's request box. */
	MUSIC_SEARCH: "music:search",
	/** renderer -> main: cut a named song in as the next track. */
	MUSIC_REQUEST_SONG: "music:request-song",
	/** renderer -> main: the visible programme queue for the panel. */
	MUSIC_GET_PROGRAMME: "music:get-programme",
	/** renderer -> main: panel edits (remove=skip signal, promote, move). */
	MUSIC_PROGRAMME_ACTION: "music:programme-action",
	/** renderer -> main: available music CLI providers (settings selector). */
	MUSIC_LIST_PROVIDERS: "music:list-providers",
	/** renderer -> main: switch the music CLI provider (a retune: programme cleared). */
	MUSIC_SET_PROVIDER: "music:set-provider",

	// Gateway / IM channel related
	GATEWAY_GET_STATUS: "gateway:get-status",
	GATEWAY_START: "gateway:start",
	GATEWAY_STOP: "gateway:stop",
	GATEWAY_WECHAT_LOGOUT: "gateway:wechat-logout",
	GATEWAY_WECHAT_ADD_ACCOUNT: "gateway:wechat-add-account",
	GATEWAY_WECHAT_STOP_ACCOUNT: "gateway:wechat-stop-account",
	GATEWAY_WECHAT_REMOVE_ACCOUNT: "gateway:wechat-remove-account",
	GATEWAY_WECHAT_RENAME_ACCOUNT: "gateway:wechat-rename-account",

	// Agent 档案 CRUD:已迁到通用 RPC 通道(agentsRouter),此处不再有常量。

	// User prompt snippets:已迁到通用 RPC 通道(promptsRouter),此处不再有常量。

	// Network related
	TEST_PROXY: "network:test-proxy",

	// Model registry 与 Providers:已迁到通用 RPC 通道(modelsRouter /
	// providersRouter),此处不再有常量。

	// Tools related
	GET_TOOLS: "tools:get-all",
	EXECUTE_TOOL: "tools:execute",
	CANCEL_TOOL: "tools:cancel",
	UPDATE_TOOL_CALL: "tools:update-tool-call",
	BACKGROUND_JOBS_LIST: "tools:background-jobs:list",
	BACKGROUND_JOBS_STOP: "tools:background-jobs:stop",
	REFRESH_ASYNC_TOOLS: "tools:refresh-async",
	UPDATE_MESSAGE_THINKING_TIME: "chat:update-thinking-time",
	RESUME_AFTER_TOOL_CONFIRM: "chat:resume-after-tool-confirm",

	// Permission related
	PERMISSION_REQUEST: "permission:request",

	// Interaction related (agent 提问 → 用户应答)
	INTERACTION_RESPOND: "interaction:respond",
	INTERACTION_GET_PENDING: "interaction:get-pending",

	// MCP related
	MCP_GET_SERVERS: "mcp:get-servers",
	MCP_ADD_SERVER: "mcp:add-server",
	MCP_UPDATE_SERVER: "mcp:update-server",
	MCP_REMOVE_SERVER: "mcp:remove-server",
	MCP_CONNECT_SERVER: "mcp:connect-server",
	MCP_DISCONNECT_SERVER: "mcp:disconnect-server",
	MCP_LOGOUT_SERVER: "mcp:logout-server",
	MCP_PROBE_SERVER: "mcp:probe-server",
	MCP_REFRESH_SERVER: "mcp:refresh-server",
	MCP_GET_TOOLS: "mcp:get-tools",
	MCP_CALL_TOOL: "mcp:call-tool",
	MCP_GET_RESOURCES: "mcp:get-resources",
	MCP_READ_RESOURCE: "mcp:read-resource",
	MCP_GET_PROMPTS: "mcp:get-prompts",
	MCP_GET_PROMPT: "mcp:get-prompt",
	MCP_READ_CONFIG_FILE: "mcp:read-config-file",

	// ACP related
	ACP_GET_AGENTS: "acp:get-agents",
	ACP_ADD_AGENT: "acp:add-agent",
	ACP_UPDATE_AGENT: "acp:update-agent",
	ACP_REMOVE_AGENT: "acp:remove-agent",
	ACP_CONNECT_AGENT: "acp:connect-agent",
	ACP_DISCONNECT_AGENT: "acp:disconnect-agent",
	ACP_REFRESH_AGENT: "acp:refresh-agent",
	ACP_CANCEL_SESSION: "acp:cancel-session",

	// Dialog related
	SHOW_OPEN_DIALOG: "dialog:show-open",

	// Image Preview related
	LIST_MEDIA_ASSETS: "media:list-assets",
	INGEST_MEDIA_FILES: "media:ingest-files",
	SAVE_MEDIA_AS: "media:save-as",
	HIDE_MEDIA_ASSET: "media:hide-asset",
	REBUILD_MEDIA_LIBRARY: "media:rebuild-library",
	GET_MEDIA_GALLERY: "media:get-gallery",
	OPEN_IMAGE_PREVIEW: "media:open-image-preview",
	GET_IMAGE_PREVIEW: "media:get-image-preview",
	OPEN_IMAGE_GALLERY: "media:open-image-gallery",
	IMAGE_PREVIEW_UPDATE: "image-preview:update",
	IMAGE_GALLERY_UPDATE: "image-gallery:update",

	// Skills related
	SKILLS_GET_ALL: "skills:get-all",
	SKILLS_REFRESH: "skills:refresh",
	SKILLS_READ_FILE: "skills:read-file",
	SKILLS_OPEN_DIRECTORY: "skills:open-directory",
	SKILLS_CREATE: "skills:create",
	SKILLS_DELETE: "skills:delete",
	SKILLS_TOGGLE_ENABLED: "skills:toggle-enabled",
	SKILLS_LIST_DIRECTORIES: "skills:list-directories",
	SKILLS_ADD_DIRECTORY: "skills:add-directory",
	SKILLS_UPDATE_DIRECTORY: "skills:update-directory",
	SKILLS_REMOVE_DIRECTORY: "skills:remove-directory",
	SKILLS_SET_AGENT: "skills:set-agent",

	// Theme related
	THEME_GET_ALL: "themes:get-all",
	THEME_GET: "themes:get",
	THEME_APPLY: "themes:apply",
	THEME_REFRESH: "themes:refresh",
	THEME_OPEN_FOLDER: "themes:open-folder",

	// OAuth related
	OAUTH_START: "oauth:start",
	OAUTH_CALLBACK: "oauth:callback",
	OAUTH_REFRESH: "oauth:refresh",
	OAUTH_LOGOUT: "oauth:logout",
	OAUTH_STATUS: "oauth:status",
	OAUTH_DEVICE_POLL: "oauth:device-poll",
	OAUTH_TOKEN_REFRESHED: "oauth:token-refreshed",
	OAUTH_TOKEN_EXPIRED: "oauth:token-expired",

	// Files related (for @ file search)
	FILES_LIST: "files:list",

	// File rollback related
	FILE_ROLLBACK: "files:rollback",

	// Directories related (for /cd path completion)
	DIRS_LIST: "dirs:list",

	// File Preview related (for reading file content)
	FILE_READ_CONTENT: "file:read-content",
	FILE_SAVE_CONTENT: "file:save-content",
	FILE_LIST_DIRECTORY: "file:list-directory",
	FILE_CREATE: "file:create",
	FILE_CREATE_DIRECTORY: "file:create-directory",
	FILE_RENAME: "file:rename",
	FILE_DELETE: "file:delete",
	FILE_STAT: "file:stat",
	FILE_REVEAL: "file:reveal",
	FILE_WATCH_START: "file:watch-start",
	FILE_WATCH_STOP: "file:watch-stop",
	FILE_WATCH_EVENT: "file:watch-event",

	// Unified event-driven channels (Phase 4)
	SESSION_EVENT: "session:event",
	SESSION_STREAM: "session:stream",
	SESSION_COMMAND: "session:command",

	// Variables subsystem (scalar-only)

	// Session goals:已迁到通用 RPC 通道(goalRouter)。实时变化仍走 session:goal-updated。

	// Project directories — independent module

	// Spaces (workspaces):请求/响应面已整只迁到通用 RPC 通道(结构债 P0.3,
	// `@shared/ipc/spaces.ts` 的 `spacesRouter` + `app/rpc/domains/spaces.ts`)。
	// 这里只剩下面这条**广播** —— router 今天没有推送面。
	/**
	 * 空间数据变更广播(批 B9-0,主进程 → 所有窗口)。
	 *
	 * 设置窗与主窗是两个独立 BrowserWindow、两份 Pinia:在设置窗里配好的 key /
	 * 登录态,主窗那份 `spaceProviders` 缓存不会知道(它已经 `loadedSpaceId ===
	 * spaceId`),于是模型选择器一直把那个 provider 藏着,直到切走再切回空间。
	 * 载荷 `{ spaceId, kind }` —— kind 分 'credentials' / 'overlay',两份文件、
	 * 两条缓存。
	 */
	SPACES_CHANGED: "spaces:changed",

	// Plugin management
	PLUGINS_LIST: "plugins:list",
	PLUGINS_ENABLE: "plugins:enable",
	PLUGINS_DISABLE: "plugins:disable",
	PLUGINS_REFRESH: "plugins:refresh",
	PLUGINS_COMMANDS: "plugins:commands",
	PLUGINS_EXECUTE_COMMAND: "plugins:execute-command",
	// main → renderer 推送:api.ui.notify 与熔断自动禁用都走它。
	// 在此之前 'plugin:notification' 只被 emitGlobal 到全局总线上,而全局总线
	// 在 core/events 之外零订阅者 —— 插件的唯一 UI 触点其实从未接通。
	PLUGINS_NOTIFICATION: "plugins:notification",
	// 统一请求通道(R2):UI → 插件的唯一通路,按 pluginId + action 分发。
	// 三条语义从第一天就在:requestId(可寻址)、abort(真取消)、progress(中间态)。
	PLUGINS_REQUEST: "plugins:request",
	PLUGINS_REQUEST_ABORT: "plugins:request-abort",
	PLUGINS_REQUEST_PROGRESS: "plugins:request-progress",
	// 插件自有配置(R3):schema 单源在 manifest,存储与校验全在宿主,
	// 所以未启用的插件也能读写配置 —— 这两条通道不碰任何插件代码。
	PLUGINS_CONFIG_GET: "plugins:config-get",
	PLUGINS_CONFIG_SET: "plugins:config-set",
	// 真卸载(R4):停用 → 归档数据 → 删源目录 → 清 plugin-settings 三键。
	// 仅用户插件;内置插件与 app 同一份构建,没有卸载可言。
	PLUGINS_UNINSTALL: "plugins:uninstall",
	// npm 生命周期(P1):装/更/查更新 + 能力面(无 npm 置灰,裁决 8)。
	PLUGINS_INSTALL: "plugins:install",
	PLUGINS_UPDATE: "plugins:update",
	PLUGINS_CHECK_UPDATES: "plugins:check-updates",
	PLUGINS_LIFECYCLE_INFO: "plugins:lifecycle-info",
	// 装前清单预读(file: 开发通道):包名与声明本来就在 tarball 里,
	// 宿主自己读出来,用户不必再抄一遍。预读只喂 UI,不是信任来源。
	PLUGINS_READ_TARBALL: "plugins:read-tarball",
	// 市场(P3):索引视图(声明 + 本机安装态 + 版本兼容 join 好),
	// 拉取失败回上次缓存并 stale 置位 —— 断网时市场区明示过期而非消失。
	PLUGINS_MARKET: "plugins:market",
	// 落盘足迹(R4 建枚举,R5 接出口):卸载确认框据此展示"将被归档的东西"。
	PLUGINS_FOOTPRINT: "plugins:footprint",
	// file-pick 节点的宿主托管导入(B 期,用户壁纸):renderer 只递节点的声明,
	// 对话框 + 闸 + 拷贝全在主进程,回来的是一个 `storage:` 地址而不是字节。
	// 挂在 PLUGINS_* 家族里而不是另开一支:它的授权语境是"某个插件的某个节点"。
	PLUGINS_PICK_FILE: "plugins:pick-file",

	// Generic scheduler

	// Window
	WINDOW_CLOSE: "window:close",

	// App State (restore on startup)

	// Search Everywhere
	SEARCH_WINDOW_TOGGLE: "search-window:toggle",
	SEARCH_WINDOW_CLOSE: "search-window:close",
	SEARCH_WINDOW_SHOWN: "search-window:shown",
	SEARCH_WINDOW_GUIDES: "search-window:guides",
	SEARCH_WINDOW_SET_ANCHOR: "search-window:set-anchor",
	SEARCH_QUERY: "search:query",
	SEARCH_EXECUTE_ACTION: "search:execute-action",
	SEARCH_ACTION: "search:action",

	// onething:// 深链(H4)。三条,刚好对应确认门的三个时刻:
	// 渲染层说"我能画卡了"(READY)、主进程推一张卡(REQUEST)、用户按了钮(RESPOND)。
	DEEPLINK_READY: "deeplink:ready",
	DEEPLINK_REQUEST: "deeplink:request",
	DEEPLINK_RESPOND: "deeplink:respond",

	// Todo / Plan
	// 数据面(get/create/update/rename/delete/revealDirectory)已迁到通用 RPC 通道
	// (todoPlanRouter);下面七条动窗口、一条推变更,是宿主原生的,留在这里。
	TODO_PLAN_OPEN_WINDOW: "todo-plan:open-window",
	TODO_PLAN_HIDE_WINDOW: "todo-plan:hide-window",
	TODO_PLAN_TOGGLE_WINDOW: "todo-plan:toggle-window",
	TODO_PLAN_SET_WINDOW_PINNED: "todo-plan:set-window-pinned",
	// 独立窗自绘红绿灯与手动拖拽的三条。它们只对 Todo 窗有意义:那扇窗是 macOS
	// non-activating NSPanel,系统交通灯永远是灰的、原生 app-region 拖拽也不生效,
	// 所以「最小化 / 缩放 / 挪窗」必须由渲染层显式发回主进程。
	TODO_PLAN_MINIMIZE_WINDOW: "todo-plan:minimize-window",
	TODO_PLAN_ZOOM_WINDOW: "todo-plan:zoom-window",
	TODO_PLAN_DRAG_WINDOW: "todo-plan:drag-window",
	TODO_PLAN_CHANGED: "todo-plan:changed",

	// Scratchpad (per-session draft paper the AI silently perceives)
	SCRATCHPAD_CHANGED: "scratchpad:changed",

	// Practice (kegel / pomodoro / exercise log)
	// 十条请求/响应通道已整只迁到通用 RPC 通道(P4a,`@shared/ipc/practice.ts`
	// 的 practiceRouter)。只剩这一条**推送** —— router 没有推送面。
	PRACTICE_EVENT: "practice:event",

	// Evals (prompt evaluation) related
	EVALS_RECORD_DOWNVOTE: "evals:record-downvote",

	// Evals Phase 1 - Review (read-only)
	EVALS_LIST_RECORDS: "evals:list-records",
	EVALS_LIST_FIXTURES: "evals:list-fixtures",
	EVALS_READ_FIXTURE: "evals:read-fixture",
	EVALS_READ_SNAPSHOT: "evals:read-snapshot",
	EVALS_LIST_RESULTS: "evals:list-results",

	// Evals Phase 2 - Run
	EVALS_RUN_START: "evals:run-start",
	EVALS_RUN_CANCEL: "evals:run-cancel",
	EVALS_RUN_PROGRESS: "evals:run-progress",
	EVALS_LIST_CASES: "evals:list-cases",
	EVALS_GET_CASE: "evals:get-case",

	// Evals Phase 3 - Actions
	EVALS_PROMOTE_FIXTURE: "evals:promote-fixture",
	EVALS_RETIRE_CASE: "evals:retire-case",
	EVALS_GENERATE_TRIAGE: "evals:generate-triage",
	EVALS_READ_RUN_DETAIL: "evals:read-run-detail",

	// Evals Workbench (incident-centric, W1-W5)
	EVALS_INCIDENT_LIST: "evals:incident-list",
	EVALS_INCIDENT_GET: "evals:incident-get",
	EVALS_INCIDENT_UPDATE: "evals:incident-update",
	EVALS_INCIDENT_READ_FILE: "evals:incident-read-file",
	EVALS_REPLAY_START: "evals:replay-start",
	EVALS_REPLAY_CANCEL: "evals:replay-cancel",
	EVALS_REPLAY_PROGRESS: "evals:replay-progress",
	EVALS_INCIDENT_ANALYZE: "evals:incident-analyze",
	EVALS_INCIDENT_PROMOTE: "evals:incident-promote",
	EVALS_DIAGNOSE_START: "evals:diagnose-start",
	EVALS_DIAGNOSE_PROGRESS: "evals:diagnose-progress",
	EVALS_ROUND_LIST: "evals:round-list",
	EVALS_ROUND_REPLAY: "evals:round-replay",

	// Token usage / billing moved to the generic RPC channel (usageRouter).

	// Terminal (real PTY, user-driven; distinct from the ACP protocol "terminal")
	TERMINAL_CREATE: "terminal:create",
	TERMINAL_LIST: "terminal:list",
	TERMINAL_WRITE: "terminal:write",
	TERMINAL_RESIZE: "terminal:resize",
	TERMINAL_KILL: "terminal:kill",
	TERMINAL_ATTACH: "terminal:attach",
	// One-way renderer→main flow-control ack (ipcRenderer.send, not invoke)
	TERMINAL_ACK: "terminal:ack",
	// Push main→renderer
	TERMINAL_DATA: "terminal:data",
	TERMINAL_EXIT: "terminal:exit",

	// Browser (embedded WebContentsView; distinct from the WorkbenchTab
	// 'browser' <iframe> which stays only as the apps/web fallback)
	BROWSER_HYDRATE: "browser:hydrate",
	BROWSER_CREATE_TAB: "browser:create-tab",
	BROWSER_CLOSE_TAB: "browser:close-tab",
	BROWSER_SELECT_TAB: "browser:select-tab",
	BROWSER_NAVIGATE: "browser:navigate",
	BROWSER_GO_BACK: "browser:go-back",
	BROWSER_GO_FORWARD: "browser:go-forward",
	BROWSER_RELOAD: "browser:reload",
	BROWSER_STOP: "browser:stop",
	BROWSER_SET_BOUNDS: "browser:set-bounds",
	BROWSER_SET_VISIBLE: "browser:set-visible",
	// Element pick mode: invoke resolves with the picked element (or null on cancel)
	BROWSER_PICK_ELEMENT: "browser:pick-element",
	BROWSER_PICK_CANCEL: "browser:pick-cancel",
	// Search engine (omnibox queries + default new-tab page): get/set the selection
	BROWSER_GET_SEARCH_ENGINE: "browser:get-search-engine",
	BROWSER_SET_SEARCH_ENGINE: "browser:set-search-engine",
	// Profiles (Chrome-style isolated logins): list/add/remove/switch
	BROWSER_LIST_PROFILES: "browser:list-profiles",
	BROWSER_ADD_PROFILE: "browser:add-profile",
	BROWSER_REMOVE_PROFILE: "browser:remove-profile",
	BROWSER_SWITCH_PROFILE: "browser:switch-profile",
	// Push main→renderer: single coalesced tab-state batch
	BROWSER_TABS_CHANGED: "browser:tabs-changed",

	// 系统通知与 dock 徽标(agent-dm-user.md §4.2)。判定在 renderer(焦点/可见性/
	// 水位都在那边),这三条只负责执行与回传点击。
	NOTIFY_SHOW: "notify:show",
	NOTIFY_BADGE: "notify:set-badge",
	// Push main→renderer:用户点了通知,带上要打开的会话。
	NOTIFY_ACTIVATE: "notify:activate",

	// collab(多 agent 协作房)的十五条请求/响应通道已整只迁到通用 RPC 通道
	// (P4a,`./collab.ts` 的 collabRouter)。这个域一条推送也没有 —— 看板 /
	// 协调器 / agent 的实时更新与表情回灌走的是 `collab:*-changed` /
	// `message:updated` 会话事件,不是这张表上的通道。
} as const;
