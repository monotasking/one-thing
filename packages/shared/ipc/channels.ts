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
	CLEAR_CHAT: "chat:clear",
	// 聊天面的六条数据面(历史/标题/提示词快照/思考时长/停止/活流表)已走通用
	// RPC 通道(chatRouter,P4c 第五批);第七条「工具审批后恢复流」于 2026-08-22
	// (#21)整条删除,引擎的 `command:resume-after-confirm` 仍在命令总线上。

	// Skill usage notification
	SKILL_ACTIVATED: "chat:skill-activated",

	// Image generation notification
	IMAGE_GENERATED: "chat:image-generated",

	// Step tracking for showing AI reasoning process
	STEP_ADDED: "chat:step-added",
	STEP_UPDATED: "chat:step-updated",

	// Session related
	// 会话域(sessions)的 22 条数据面已迁到通用 RPC 通道(P4c 第五批,
	// sessionsRouter)—— 连同四条契约表外的字面量通道
	// (add-system-message / remove-files-changed-message /
	// remove-git-status-message / remove-message)一起消失。这里只剩推送,
	// 以及一条桌面从来没有处理者的历史遗留(server 侧仍有 REST 路由)。
	UPDATE_SESSION_MAX_TOKENS: "sessions:update-max-tokens",
	CONTEXT_SIZE_UPDATED: "sessions:context-size-updated",
	// P1(2026-08-14):压缩的开始/结束通知只有一条正路 —— session:event 信封里
	// 的 context:compact-started / context:compact-completed。专用 IPC 通道
	// (主进程从来没往里发过一条)已删,别再加回来。
	// Session optimization (metadata separation)
	SESSION_MESSAGES_CHANGED: "sessions:messages-changed", // Event: messages added/updated

	// Settings related
	// P4c 第十一批:`settings:get` / `settings:save` / `settings:get-system-theme` /
	// `network:test-proxy` 四条随 `settingsRouter` 走通用 RPC,常量随之消失。
	// 留下的是两件要 Electron 本体的事(开设置窗 / 原生对话框)与三条推送。
	OPEN_SETTINGS_WINDOW: "settings:open-window",
	SETTINGS_NAVIGATE: "settings:navigate", // main → settings window: jump to a tab
	SETTINGS_CHANGED: "settings:changed",
	SYSTEM_THEME_CHANGED: "settings:system-theme-changed",

	// Voice related
	// P4c 第十一批:十一条 voice invoke 通道随 `voiceRouter` 走通用 RPC。
	// 留下三条:两条推送(router 没有推送面)与一条**单向上行** ——
	// `VOICE_AUDIO_CHUNK` 是高频 PCM 流,`ipcRenderer.send` 不带回执;
	// router 只有请求/响应面,搬过去等于给每块音频加一条空回执(性能面变化)。
	// 它归**流式单向残留集**(与 FILE_WATCH_EVENT 等推送同类,拍板 #10)。
	VOICE_AUDIO_CHUNK: "voice:audio-chunk",
	VOICE_EVENT: "voice:event",
	VOICE_RUNTIME_COMMAND: "voice:runtime-command",

	// Music radio —— 十四条数据面已迁到通用 RPC 通道(musicRouter,P4c 第九批)。
	// 这里只剩**四条推送**:router 今天没有推送面,而它们早就走
	// `broadcastVoiceHostMessage` 端口从 `backend/wiring/music/*` 直接发出。
	MUSIC_EVENT: "music:event",
	/** main -> renderer: what is playing, or null when nothing is. */
	MUSIC_NOW_PLAYING: "music:now-playing",
	/** main -> renderer: the current song's timed lyrics, once per song start. */
	MUSIC_LYRICS: "music:lyrics",
	/**
	 * main -> renderer: the DJ's synthesized patter to play in the gap before a
	 * song. Audio rides here (not mpv) so music and voice stay on separate
	 * tracks; the renderer plays it and acks through the music RPC domain's
	 * `djSpeakDone`.
	 */
	MUSIC_DJ_SPEAK: "music:dj-speak",

	// Gateway / IM channel:八条已迁到通用 RPC 通道(gatewayRouter),本域零推送,
	// 此处不再有常量。

	// Agent 档案 CRUD:已迁到通用 RPC 通道(agentsRouter),此处不再有常量。

	// User prompt snippets:已迁到通用 RPC 通道(promptsRouter),此处不再有常量。

	// Network related

	// Model registry 与 Providers:已迁到通用 RPC 通道(modelsRouter /
	// providersRouter),此处不再有常量。

	// Tools:七条数据面已迁到通用 RPC 通道(toolsRouter,P4c 第九批),本域零推送。

	// Permission related
	PERMISSION_REQUEST: "permission:request",

	// Interaction(agent 提问 → 用户应答):两条已迁到通用 RPC 通道
	// (interactionRouter,P4c 第九批),本域零推送,此处不再有常量。

	// Dialog related
	SHOW_OPEN_DIALOG: "dialog:show-open",

	// Media —— 只剩「要宿主本体」的三条(P4c 第三批:十一条数据面已迁 mediaRouter)。
	// 「另存为」是一次原生保存对话框,两条 open-image-* 各是一个 BrowserWindow。
	SAVE_MEDIA_AS: "media:save-as",
	OPEN_IMAGE_PREVIEW: "media:open-image-preview",
	OPEN_IMAGE_GALLERY: "media:open-image-gallery",
	IMAGE_PREVIEW_UPDATE: "image-preview:update",
	IMAGE_GALLERY_UPDATE: "image-gallery:update",

	// Theme:五条数据面已迁到通用 RPC 通道(themesRouter,P4c 第七批);
	// 本域零推送,所以这里一条不剩。

	// OAuth:六条数据面已迁到通用 RPC 通道(oauthRouter,P4c 第七批)。
	// 留下的两条是**推送** —— router 今天没有推送面,它们走
	// `configureOAuthEventBroadcaster` 注入端口。
	OAUTH_TOKEN_REFRESHED: "oauth:token-refreshed",
	OAUTH_TOKEN_EXPIRED: "oauth:token-expired",

	// Files:十四条数据面已迁到通用 RPC 通道(filesRouter),只剩这一条**推送** ——
	// router 今天没有推送面。桌面侧至今没有发送方(watchStart 是投影桩),
	// 真正在用它的是 web 那条 `/api/files/watch/events` SSE。
	FILE_WATCH_EVENT: "file:watch-event",

	// Unified event-driven channels (Phase 4)
	SESSION_EVENT: "session:event",
	SESSION_STREAM: "session:stream",

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

	// Plugin management —— 十九条 invoke 已随 `pluginsRouter` 迁到通用
	// `rpc:invoke` / `POST /api/rpc`(P4 终态批 C2);留下的是**两条推送**,
	// router 今天没有推送面。
	//
	// main → renderer 推送:api.ui.notify 与熔断自动禁用都走它。
	// 在此之前 'plugin:notification' 只被 emitGlobal 到全局总线上,而全局总线
	// 在 core/events 之外零订阅者 —— 插件的唯一 UI 触点其实从未接通。
	// 它由 IPCBridge 扇给所有窗,从头到尾不经过请求面(所以连注入端口都不用)。
	PLUGINS_NOTIFICATION: "plugins:notification",
	// 统一请求通道(R2)的**中间态**。请求与取消本身已经是
	// `plugins.request` / `plugins.requestAbort` 两条 router 方法;进度改走
	// `@onething/backend/wiring/plugins/events.ts` 的注入端口,桌面按
	// `RpcDispatchContext.callerId` **定向回发起窗** —— 设置窗是独立 BrowserWindow,
	// 广播出去等于每扇窗都收一份别人的进度。
	PLUGINS_REQUEST_PROGRESS: "plugins:request-progress",

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

	// Evals(提示词评估 + 事故工作台)—— 二十五条请求/响应通道已整只迁到通用
	// RPC 通道(P4c 第十批,`@shared/ipc/evals.ts` 的 evalsRouter +
	// `@shared/ipc/evals-workbench.ts` 的 evalsWorkbenchRouter)。
	// 只剩这三条**推送** —— router 没有推送面;它们走
	// `backend/wiring/evals/events.ts` 的 configureEvalsEventBroadcaster 注入端口。
	EVALS_RUN_PROGRESS: "evals:run-progress",
	EVALS_REPLAY_PROGRESS: "evals:replay-progress",
	EVALS_DIAGNOSE_PROGRESS: "evals:diagnose-progress",

	// Token usage / billing moved to the generic RPC channel (usageRouter).

	// Terminal (real PTY, user-driven; distinct from the ACP protocol "terminal").
	// 七条请求面已迁通用 RPC 通道(P4 终态批 D2,`terminalRouter`);留下的两条是
	// **推送面**,走注入广播器端口 `configureTerminalBroadcaster`(router 无推送面)。
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
