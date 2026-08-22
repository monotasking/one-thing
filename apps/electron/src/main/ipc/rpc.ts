/**
 * The generic RPC adapter — desktop half (主线 T0).
 *
 * One `ipcMain.handle` for every domain, forever. This is meant to be the LAST
 * new handler file `@main` gets: a new domain registers its handlers in the
 * assembly layer (`packages/backend/rpc/`) and reaches the renderer through here without
 * a single line landing in this directory.
 *
 * `dispatchRpc` never rejects — it returns `{ ok:false, error }` — so the
 * renderer gets our error message instead of Electron's
 * "Error invoking remote method …" wrapper.
 */
import { ipcMain } from "electron";
import { DESKTOP_RPC_CONTEXT, IPC_CHANNELS, type RpcRequest } from "@shared/ipc.js";
import { dispatchRpc } from "@onething/backend/rpc/registry.js";

export function registerRpcHandler(): void {
	// The context is minted HERE, never read off the envelope (主线 T 批 3).
	// Desktop is the user's own machine and has exactly one owner, so the
	// constant is almost the whole truth: no sandbox root (unconfined, matching
	// every pre-migration `@main` handler) and no owner labels (handlers that
	// need one use their local default).
	//
	// 结构债 P4c 第十一批:常量带不动的那一格 per-request 事实是**谁在问**。
	// `event.sender.id` 就是发起的那扇窗,而一个把推送扇出到所有窗口的处理者
	// 需要它来跳过发起者 —— `settings.saveSettings` 是逼出这一格的那条:
	// 回灌整份 settings 会打断那扇窗正在编辑的草稿,靠「幂等」兜不住。
	// `DESKTOP_RPC_CONTEXT` 仍是可 grep 的底座,这里只在它上面摊一格。
	ipcMain.handle(IPC_CHANNELS.RPC_INVOKE, async (event, request: RpcRequest) =>
		dispatchRpc(request, { ...DESKTOP_RPC_CONTEXT, callerId: event.sender?.id }),
	);
}
