/**
 * 宿主壳路由的适配器 —— `@main` 的**最后一个 handle 文件的对称件**
 * (结构债 P4 终态批 A1-a,2026-08-23)。
 *
 * `@main/ipc/rpc.ts` 说「加一个**数据面**域不再往这个目录落一行」;这只文件对
 * **窗口系**说同一句话:一条 `ipcMain.handle`,服务所有壳域。新的窗口域只在
 * `apps/electron/src/ipc/shell/<d>.ts` 注册一份处理者表(由该域自己的接线点调用),
 * **不再在这里落一行**。
 *
 * 与 `rpc.ts` 唯一的不同是派发表在哪:那边是 `@onething/backend/rpc/registry`
 * (装配层,禁 import electron),这边是 `apps/electron/src/ipc/shell-registry`
 * (宿主,处理者要碰 `BrowserWindow` / `dialog` / `Notification`)。
 *
 * `dispatchShell` 从不 reject —— 它回 `{ ok:false, error }` —— 所以渲染层拿到的是
 * 我们自己的错误消息,而不是 Electron 的 "Error invoking remote method …" 包装。
 */
import { ipcMain } from "electron";
import { IPC_CHANNELS, type RpcRequest } from "@shared/ipc.js";
import { dispatchShell } from "@onething/electron-host/ipc/shell-registry";

export function registerShellRpcHandler(): void {
	// context 在**这里**铸,永远不从信封里读(同 `@main/ipc/rpc.ts` 的规矩)。
	// `event.sender.id` 就是发起的那扇窗:`window.close` 靠它认要关哪扇,
	// search 的两条靠它认从哪扇窗按的,notify 靠它认点击要唤回谁。
	ipcMain.handle(IPC_CHANNELS.SHELL_INVOKE, async (event, request: RpcRequest) =>
		dispatchShell(request, { callerId: event.sender?.id }),
	);
}
