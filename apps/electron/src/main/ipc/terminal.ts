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
	type TerminalHostPorts,
} from "@onething/runtime/terminal/service.wiring";
import { getIPCBridge } from "../bridges/ipc-bridge-lifecycle.js";

/**
 * B1(方案 `docs/design/backend-transport-forks-2026-09.md` §2.1):这件宿主能力
 * 也进桌面那张 `OnethingHostPorts` 表(`main-process.ts` 的 `terminal` 一格),
 * 于是装配的第一步就接上,而不是等 `initializeIPC()`(afterTools 钩子)才接。
 *
 * 提前到装配第一步是安全的:两个闭包里的 `getIPCBridge()` 是**每次调用现取**的
 * 懒访问器(桥没起来时回 null,`?.` 直接吞掉)—— 它们不在构造时读任何装配产物。
 * 真正会发数据的时刻是 PTY 有输出,那一定在用户开出一个终端之后,桥早就在了。
 *
 * 定义留在这里 —— 输出往哪条通道推是 terminal 域自己的事;导出的只是那张表要
 * 引用的值。`registerTerminalHandlers` 里那次调用保留(同一个对象再赋一次是空
 * 操作,而这个域的接线在自己的注册函数里读得完整),照 A1 处理 todo-plan 的先例。
 */
export const electronTerminalHostPorts: TerminalHostPorts = {
	broadcaster: {
		sendData: (payload) => {
			getIPCBridge()?.sendToRenderer(IPC_CHANNELS.TERMINAL_DATA, payload);
		},
		sendExit: (payload) => {
			getIPCBridge()?.sendToRenderer(IPC_CHANNELS.TERMINAL_EXIT, payload);
		},
	},
};

export function registerTerminalHandlers(): void {
	configureTerminalBroadcaster(electronTerminalHostPorts.broadcaster);
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
