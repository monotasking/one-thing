/**
 * The generic RPC adapter — desktop half (主线 T0).
 *
 * One `ipcMain.handle` for every domain, forever. This is meant to be the LAST
 * new handler file `@main` gets: a new domain registers its handlers in the
 * assembly layer (`src/app/rpc/`) and reaches the renderer through here without
 * a single line landing in this directory.
 *
 * `dispatchRpc` never rejects — it returns `{ ok:false, error }` — so the
 * renderer gets our error message instead of Electron's
 * "Error invoking remote method …" wrapper.
 */
import { ipcMain } from "electron";
import { DESKTOP_RPC_CONTEXT, IPC_CHANNELS, type RpcRequest } from "@shared/ipc.js";
import { dispatchRpc } from "@onething/app/rpc/registry.js";

export function registerRpcHandler(): void {
	// The context is minted HERE, never read off the envelope (主线 T 批 3).
	// Desktop is the user's own machine and has exactly one owner, so the
	// constant is the whole truth: no sandbox root (unconfined, matching every
	// pre-migration `@main` handler) and no owner labels (handlers that need
	// one use their local default).
	ipcMain.handle(IPC_CHANNELS.RPC_INVOKE, async (_event, request: RpcRequest) =>
		dispatchRpc(request, DESKTOP_RPC_CONTEXT),
	);
}
