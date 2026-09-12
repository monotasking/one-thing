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

	/**
	 * 宿主壳路由(结构债 P4 终态批 A1-a):与 `RPC_INVOKE` 一条一条对称 —— 同一个
	 * 信封、同一套 `defineRouter` 契约、同一个 `createRouterClient`,唯一的差别是
	 * **处理者住在宿主**(`apps/electron/src/ipc/shell/`)而不是装配层
	 * (`packages/backend/rpc/domains/`,禁 import electron)。开设置窗 / 关窗 /
	 * 原生对话框 / 系统通知 / 深链应答只有 Electron 本体做得了,合成一张表等于把
	 * electron 处理者塞进装配层 —— 那道边界正是 `packages/backend` 存在的理由。
	 * 新的窗口域 = 一个 router + 宿主处理者 + web 处理者 + 一个 client,
	 * **不再往这张表加常量**。
	 */
	SHELL_INVOKE: "shell:invoke",

	// Chat related(`chat:clear` 于 A1-a 删除:全仓零引用,只剩名字的遗留)。
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
	// `sessions:update-max-tokens` 于 A1-a 删除:桌面无 handler、渲染层零调用点;
	// server 的 `POST /api/sessions/:id/max-tokens` 路由原样留着(mobile 面)。
	CONTEXT_SIZE_UPDATED: "sessions:context-size-updated",
	// P1(2026-08-14):压缩的开始/结束通知只有一条正路 —— session:event 信封里
	// 的 context:compact-started / context:compact-completed。专用 IPC 通道
	// (主进程从来没往里发过一条)已删,别再加回来。
	// Session optimization (metadata separation)
	SESSION_MESSAGES_CHANGED: "sessions:messages-changed", // Event: messages added/updated

	// Settings related
	// P4c 第十一批:`settings:get` / `settings:save` / `settings:get-system-theme` /
	// `network:test-proxy` 四条随 `settingsRouter` 走通用 RPC,常量随之消失。
	// 只剩三条推送:开设置窗 / 原生对话框于 A1-a 走宿主壳路由
	// (`settingsWindowRouter.open` / `dialogRouter.showOpen`)。
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

	// Media —— 十一条数据面走 `mediaRouter`(P4c 第三批);「要宿主本体」的三条
	// (另存为对话框 + 两个 BrowserWindow)于 A1-a 走 `mediaWindowRouter`。只剩推送。
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

	// Window / App State —— `window:close` 于 A1-a 走 `windowRouter.close`:关哪扇窗
	// 由宿主从 `ShellDispatchContext.callerId` 认,不从请求体读(壳 context 首例)。

	// Search Everywhere —— 三条动窗口的与 `search:execute-action`(关搜索窗 + 找主窗
	// + 送动作 + 聚焦)于 A1-a 走 `searchWindowRouter`;`search:query` 于 A1-b 走
	// `rpc:invoke` 的 backend `search` 域(数据面,按 `context.transport` 分叉:
	// ipc 查整机那份、http 查 per-owner 沙箱那份)。这里只剩三条**推送**。
	SEARCH_WINDOW_SHOWN: "search-window:shown",
	SEARCH_WINDOW_GUIDES: "search-window:guides",
	SEARCH_ACTION: "search:action",

	// onething:// 深链(H4)。确认门三个时刻里的两条请求面(READY / RESPOND)本就是
	// invoke,于 A1-a 走 `deeplinkRouter`;只剩主进程推卡这一条真推送。
	DEEPLINK_REQUEST: "deeplink:request",

	// Todo / Plan
	// 数据面走 `todoPlanRouter`;七条动窗口的于 A1-a 走 `todoPlanWindowRouter`
	// (含 drag —— 每帧开销的记账写在那份契约里)。这里只剩一条推变更。
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

	// Terminal:七条请求面走 `terminalRouter`(P4-D2);两条推送常量 T0 删除 ——
	// 无 import(唯一宿主是已退役的 Vue 壳),真正的出网口是全局事件
	// `terminal:data` / `terminal:exit` → `GET /api/events`(壳只有一条 IPC)。

	// Browser (embedded WebContentsView; distinct from the WorkbenchTab
	// 'browser' <iframe> which stays only as the apps/web fallback)
	// 19 条请求面于 A1-b 走**宿主壳路由**(`browserRouter`,处理者在
	// `apps/electron/src/ipc/shell/browser.ts` —— 它动的是主进程里一扇真原生视图,
	// 所以是壳面不是数据面)。这里只剩一条**推送**:一次合批的标签态广播。
	BROWSER_TABS_CHANGED: "browser:tabs-changed",

	// 系统通知与 dock 徽标(agent-dm-user.md §4.2)。判定在 renderer;两条执行面
	// (弹通知 / 画墨点)于 A1-a 走 `notifyRouter`。
	// Push main→renderer:用户点了通知,带上要打开的会话。
	NOTIFY_ACTIVATE: "notify:activate",

	// collab(多 agent 协作房)的十五条请求/响应通道已整只迁到通用 RPC 通道
	// (P4a,`./collab.ts` 的 collabRouter)。这个域一条推送也没有 —— 看板 /
	// 协调器 / agent 的实时更新与表情回灌走的是 `collab:*-changed` /
	// `message:updated` 会话事件,不是这张表上的通道。
} as const;
