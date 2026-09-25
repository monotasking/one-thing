/**
 * 原生「打开」对话框的**宿主壳路由**(结构债 P4 终态批 A1-a,2026-08-23)。
 *
 * 全仓调用点最多的一条宿主能力(选文件 / 选目录 / 多选,设置页、侧栏、媒体面板、
 * MCP 导入、技能目录…… 都走它)。处理者是 `dialog.showOpenDialog` 本人,只能住在
 * `apps/electron` —— 所以它走 `shell:invoke` 而不是 `rpc:invoke`。
 *
 * 形状与迁移前那条手写通道**逐字相同**:入参就是从前 `showOpenDialog(options)`
 * 的那个 options 对象,出参就是 Electron 的 `OpenDialogReturnValue` 里被渲染层
 * 用到的那两格。浏览器没有这样一次宿主对话框,web 处理者如实回
 * `{ canceled: true, filePaths: [] }`(同迁移前的桩,一字未改)。
 */
import { defineRouter } from "./router.js";

export type ShowOpenDialogProperty =
	| "openFile"
	| "openDirectory"
	| "multiSelections"
	/** macOS:对话框里带「新建文件夹」。 */
	| "createDirectory";

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
	 * 这台宿主**没有**原生对话框(独立 server / CLI 守护进程 / 未注入 `dialog` 端口)。
	 * 与「用户点了取消」分开:调用方据它退到自己的路径输入框,而不是当作取消。
	 */
	unavailable?: boolean;
}

export type DialogRoutes = {
	showOpen: { input: ShowOpenDialogRequest; output: ShowOpenDialogResponse };
};

export const dialogRouter = defineRouter<DialogRoutes>("dialog", ["showOpen"]);
