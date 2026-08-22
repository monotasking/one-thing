/**
 * Terminal 的宿主残留:**输出推送的广播注入**与**消费者掉线的 detach 边**。
 *
 * 七条请求面(create / list / write / resize / kill / attach / ack)于
 * 2026-08-22(结构债 P4 终态批 D2)整只迁到通用 `rpc:invoke` / `POST /api/rpc`
 * 的 `terminal` 域(`packages/backend/rpc/domains/terminal.ts`),
 * `apps/electron/src/ipc/terminal.ts` 那只可移植工厂随之删除。
 *
 * 留在这里的两条是 `TERMINAL_DATA` / `TERMINAL_EXIT` —— router 今天只有请求/
 * 响应面,推送统一走注入广播器端口(practice / scratchpad / oauth 同判例)。
 * 见 docs/design/terminal-system.md。
 */
import { IPC_CHANNELS } from "@shared/ipc.js";
import {
	configureTerminalBroadcaster,
	markAllTerminalsDetached,
} from "@onething/runtime/terminal/service.wiring";
import { getIPCBridge } from "../bridges/ipc-bridge-lifecycle.js";

export function registerTerminalHandlers(): void {
	configureTerminalBroadcaster({
		sendData: (payload) => {
			getIPCBridge()?.sendToRenderer(IPC_CHANNELS.TERMINAL_DATA, payload);
		},
		sendExit: (payload) => {
			getIPCBridge()?.sendToRenderer(IPC_CHANNELS.TERMINAL_EXIT, payload);
		},
	});
}

interface TerminalConsumerWebContentsLike {
	on(event: "render-process-gone" | "did-start-loading" | "destroyed", listener: () => void): unknown;
}

/**
 * Detach edge of the flow-control generation protocol: acks only come from a
 * live renderer, so when the consumer provably goes away (reload navigates,
 * renderer crashes, window destroyed) every terminal must drop to detached —
 * otherwise output freezes at the high-water mark until the next attach.
 * markAllTerminalsDetached is no-op safe when no terminal was ever created.
 */
export function watchTerminalConsumer(webContents: TerminalConsumerWebContentsLike): void {
	webContents.on("did-start-loading", () => markAllTerminalsDetached());
	webContents.on("render-process-gone", () => markAllTerminalsDetached());
	webContents.on("destroyed", () => markAllTerminalsDetached());
}
