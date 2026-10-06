/**
 * **「只在用户屏幕上发生的事」**的契约(第④步批 1,决策 D5 / D278):开一扇原生对话框、把网址交给
 * 系统浏览器、用默认程序打开一个本地路径、在文件管理器里定位一个路径。
 *
 * 这四件从前经后端绕一圈(渲染层 → `POST /api/rpc` 的 `dialog` / `shell` 两个域 → 后端 → Electron
 * 注入的宿主端口);它们没有一件需要后端,而后端第④步要搬出 Electron 进程 —— 搬出去之后那条路就断了。
 * 所以现在由**客户端自己做**:桌面的渲染层经 preload 的一条 `invoke`(`host:client-action`)交给主进程,
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

/** 四个动词。主进程对每一个逐格校验(`apps/desktop-react/electron/client-action.ts`)。 */
export type ClientAction =
	| { kind: "showOpenDialog"; request: ShowOpenDialogRequest }
	/** 只放行 http(s) 与 mailto —— `file:` 与自定义 scheme 会拉起本机程序,那是 `openPath` 的事。 */
	| { kind: "openExternal"; url: string }
	/** 用默认程序打开一个**绝对**路径。 */
	| { kind: "openPath"; path: string }
	/** 在文件管理器里定位一个**绝对**路径(macOS 的「在访达中显示」)。 */
	| { kind: "revealPath"; path: string };

export type ClientActionKind = ClientAction["kind"];

/** 打开 / 定位这三件的结局:做了,或者没做成并说一句为什么。 */
export type ClientActionDone = { ok: true } | { ok: false; error: string };

/** 每个动词答什么。 */
export interface ClientActionResults {
	showOpenDialog: ShowOpenDialogResponse;
	openExternal: ClientActionDone;
	openPath: ClientActionDone;
	revealPath: ClientActionDone;
}

/** preload 挂在 `window.onethingHost.clientAction` 上的那一格的形状。 */
export type ClientActionBridge = <A extends ClientAction>(action: A) => Promise<ClientActionResults[A["kind"]]>;
