import { BrowserWindow } from "electron";
import { registerElectronScratchpadIpcHandlers } from "@onething/electron-host/ipc/scratchpad";
import {
	IPC_CHANNELS,
	type ScratchpadAdoptRequest,
	type ScratchpadChangedPayload,
	type ScratchpadDeleteRequest,
	type ScratchpadGetRequest,
	type ScratchpadUpdateRequest,
} from "@shared/ipc.js";
import {
	adoptScratchpad,
	configureScratchpadHost,
	readScratchpad,
	removeScratchpad,
	updateScratchpad,
} from "@onething/app/scratchpad/index.js";

function broadcastScratchpadChanged(payload: ScratchpadChangedPayload): void {
	for (const window of BrowserWindow.getAllWindows()) {
		if (window.isDestroyed()) continue;
		window.webContents.send(IPC_CHANNELS.SCRATCHPAD_CHANGED, payload);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function registerScratchpadHandlers(): void {
	configureScratchpadHost({ broadcastChanged: broadcastScratchpadChanged });
	registerElectronScratchpadIpcHandlers({
		channels: {
			get: IPC_CHANNELS.SCRATCHPAD_GET,
			update: IPC_CHANNELS.SCRATCHPAD_UPDATE,
			delete: IPC_CHANNELS.SCRATCHPAD_DELETE,
			adopt: IPC_CHANNELS.SCRATCHPAD_ADOPT,
		},
		get: async (request) => {
			try {
				const { sessionId } = request as ScratchpadGetRequest;
				const document = await readScratchpad(sessionId);
				return { success: true, document };
			} catch (error) {
				return { success: false, error: errorMessage(error) };
			}
		},
		update: async (request) => {
			try {
				const { sessionId, content } = request as ScratchpadUpdateRequest;
				const document = await updateScratchpad(sessionId, content);
				return { success: true, document };
			} catch (error) {
				return { success: false, error: errorMessage(error) };
			}
		},
		delete: async (request) => {
			try {
				const { sessionId } = request as ScratchpadDeleteRequest;
				await removeScratchpad(sessionId);
				return { success: true };
			} catch (error) {
				return { success: false, error: errorMessage(error) };
			}
		},
		adopt: async (request) => {
			try {
				const { fromSessionId, toSessionId } =
					request as ScratchpadAdoptRequest;
				await adoptScratchpad(fromSessionId, toSessionId);
				return { success: true };
			} catch (error) {
				return { success: false, error: errorMessage(error) };
			}
		},
	});
}
