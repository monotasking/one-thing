/**
 * Terminal IPC handlers: real PTY shells for the workbench/dock terminal.
 * Output pushes go the other way via IPCBridge on TERMINAL_DATA/TERMINAL_EXIT
 * (practice-broadcaster pattern). See docs/design/terminal-system.md.
 */
import { IPC_CHANNELS } from "@shared/ipc.js";
import {
	configureTerminalBroadcaster,
	getTerminalService,
	markAllTerminalsDetached,
} from "@onething/runtime/terminal/service.wiring";
import { registerElectronTerminalIpcHandlers } from "@onething/electron-host/ipc/terminal";
import { getIPCBridge } from "../bridges/ipc-bridge-lifecycle.js";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function registerTerminalHandlers(): void {
	configureTerminalBroadcaster({
		sendData: (payload) => {
			getIPCBridge()?.sendToRenderer(IPC_CHANNELS.TERMINAL_DATA, payload);
		},
		sendExit: (payload) => {
			getIPCBridge()?.sendToRenderer(IPC_CHANNELS.TERMINAL_EXIT, payload);
		},
	});

	registerElectronTerminalIpcHandlers({
		channels: {
			create: IPC_CHANNELS.TERMINAL_CREATE,
			list: IPC_CHANNELS.TERMINAL_LIST,
			write: IPC_CHANNELS.TERMINAL_WRITE,
			resize: IPC_CHANNELS.TERMINAL_RESIZE,
			kill: IPC_CHANNELS.TERMINAL_KILL,
			attach: IPC_CHANNELS.TERMINAL_ATTACH,
			ack: IPC_CHANNELS.TERMINAL_ACK,
		},
		create: (request) => {
			try {
				return { success: true, terminal: getTerminalService().create(request) };
			} catch (error) {
				return { success: false, error: errorMessage(error) };
			}
		},
		list: () => {
			try {
				return { success: true, terminals: getTerminalService().list() };
			} catch (error) {
				return { success: false, terminals: [], error: errorMessage(error) };
			}
		},
		write: (request) => {
			getTerminalService().write(request.terminalId, request.data);
			return { success: true };
		},
		resize: (request) => {
			getTerminalService().resize(request.terminalId, request.cols, request.rows);
			return { success: true };
		},
		kill: (request) => {
			getTerminalService().kill(request.terminalId);
			return { success: true };
		},
		attach: (request) => {
			try {
				return getTerminalService().attach(request.terminalId);
			} catch (error) {
				return { success: false, error: errorMessage(error) };
			}
		},
		ack: (payload) => {
			getTerminalService().ack(payload.terminalId, payload.bytes, payload.generation);
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
