/**
 * **「只在用户屏幕上发生的事」**的契约(第④步批 1,决策 D5 / D278):开一扇原生对话框、把网址交给
 * 系统浏览器、用默认程序打开一个本地路径、在文件管理器里定位一个路径。
 *
 * 这四件从前经后端绕一圈(渲染层 → `POST /api/rpc` 的 `dialog` / `shell` 两个域 → 后端 → Electron
 * 注入的宿主端口);它们没有一件需要后端,而后端第④步要搬出 Electron 进程 —— 搬出去之后那条路就断了。
 * 第④步批 2b 又加了三个动词(后端状态 / 重启后端 / 定位后端日志):后端是桌面拉起的子进程之后,这三件只有
 * 拉起它的那个宿主答得出,与开对话框同性质。所以现在由**客户端自己做**:桌面的渲染层经 preload 的一条 `invoke`(`host:client-action`)交给主进程,
 * 主进程逐个校验参数再调 Electron;浏览器壳与手机没有这条口,那几颗按钮不画(判据在壳的
 * `platform/host.ts`,只有一处)。
 *
 * 这条通道与 `host:connection` 同性质 —— 只有宿主答得出的事,不是数据通道:请求 / 应答的数据仍然只走
 * `POST /api/rpc`。
 *
 * 纯类型 + 一个字面量,零依赖:渲染层、preload、主进程三边都 import 这一份。
 */

/** preload 与主进程之间那条 `invoke` 通道的名字。 */
export const CLIENT_ACTION_CHANNEL = "host:client-action";

export type ShowOpenDialogProperty =
	| "openFile"
	| "openDirectory"
	| "multiSelections"
	/** macOS:对话框里带「新建文件夹」。 */
	| "createDirectory";

/** 形状与从前 `dialog` 域的 `showOpen` 逐字相同,渲染层那十几个调用点一行不改。 */
export interface ShowOpenDialogRequest {
	properties?: ShowOpenDialogProperty[];
	title?: string;
	defaultPath?: string;
	filters?: Array<{ name: string; extensions: string[] }>;
}

export interface ShowOpenDialogResponse {
	canceled: boolean;
	filePaths: string[];
	/**
	 * 这台客户端**没有**原生对话框(浏览器壳、手机)。与「用户点了取消」分开:调用方据它退到
	 * 自己的路径输入框,而不是当作取消。
	 */
	unavailable?: boolean;
}

/**
 * **后端进程此刻的样子**(第④步批 2b:桌面拉起后端子进程之后,「后端在不在、跑了多久、要不要重启」是只有
 * 拉起它的那个宿主答得出的事)。设置页的状态行、「正在重新连接后端。」提示、「后端已停止。」横幅都读它。
 *
 *  · `starting`:拉起了,还没活;
 *  · `running`:活着(`launchedHere` = 这一程拉起的;假 = 借来的,例如上一次「退出后继续运行」留下的那台);
 *  · `restarting`:崩了,正在按「60 秒内最多 3 次」重拉;
 *  · `stopped`:三次都没起来,等人点「重启」;
 *  · `stopping` / `idle`:收尾中 / 没有后端。
 */
export interface BackendHostState {
	phase: "idle" | "starting" | "running" | "restarting" | "stopped" | "stopping";
	pid?: number;
	port?: number;
	/** 发现文件里的 `startedAt`(毫秒时间戳)。 */
	startedAt?: number;
	launchedHere?: boolean;
	/** 这一台归不归这台桌面停 / 重启(别人起的 `server:start` 不归)。 */
	ownedByDesktop?: boolean;
	/** `stopped` 时那句话(原文,给「查看日志」之前先看一眼)。 */
	error?: string;
}

/** 主进程推后端状态的那条单向通道(`webContents.send`,与 `host:fullscreen` 同形,不是 `ipcMain` 通道)。 */
export const BACKEND_STATE_CHANNEL = "host:backend-state";

/**
 * preload 挂在 `window.onethingHost.onBackendState` 上的那一格:订主进程推的后端状态,返回退订
 * (形与 `onFullScreenChange` 逐字相同)。浏览器壳没有这一格。
 */
export type BackendStateBridge = (listener: (state: BackendHostState) => void) => () => void;

/** 七个动词。主进程对每一个逐格校验(`apps/desktop-react/electron/client-action.ts`)。 */
export type ClientAction =
	| { kind: "showOpenDialog"; request: ShowOpenDialogRequest }
	/** 只放行 http(s) 与 mailto —— `file:` 与自定义 scheme 会拉起本机程序,那是 `openPath` 的事。 */
	| { kind: "openExternal"; url: string }
	/** 用默认程序打开一个**绝对**路径。 */
	| { kind: "openPath"; path: string }
	/** 在文件管理器里定位一个**绝对**路径(macOS 的「在访达中显示」)。 */
	| { kind: "revealPath"; path: string }
	/** 后端此刻的样子(第④步批 2b)。 */
	| { kind: "backendStatus" }
	/** 重启后端:停掉这台桌面拉起的那一台、清掉崩溃额度、再拉一台。别人起的 `server:start` 答 `ok: false`。 */
	| { kind: "restartBackend" }
	/** 在文件管理器里定位后端的日志(`<store>/log/app.jsonl`;路径由主进程自己算,不收参数)。 */
	| { kind: "revealBackendLog" };

export type ClientActionKind = ClientAction["kind"];

/** 打开 / 定位这三件的结局:做了,或者没做成并说一句为什么。 */
export type ClientActionDone = { ok: true } | { ok: false; error: string };

/** 每个动词答什么。 */
export interface ClientActionResults {
	showOpenDialog: ShowOpenDialogResponse;
	openExternal: ClientActionDone;
	openPath: ClientActionDone;
	revealPath: ClientActionDone;
	backendStatus: BackendHostState;
	restartBackend: ClientActionDone;
	revealBackendLog: ClientActionDone;
}

/** preload 挂在 `window.onethingHost.clientAction` 上的那一格的形状。 */
export type ClientActionBridge = <A extends ClientAction>(action: A) => Promise<ClientActionResults[A["kind"]]>;
