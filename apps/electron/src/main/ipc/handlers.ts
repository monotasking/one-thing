import { emitCoreSessionCommandForIpc } from "@onething/core/events";
import {
	registerElectronSessionCommandIpcHandler,
	type ElectronSessionCommandRequest,
} from "@onething/electron-host/ipc/session-command";
import { IPC_CHANNELS } from "@shared/ipc.js";
import { registerChatHandlers } from "./chat.js";
import { registerSessionHandlers } from "./sessions.js";
import { registerSettingsHandlers } from "./settings.js";
import { registerCollabHandlers } from "./collab.js";
import { registerToolHandlers } from "./tools.js";
import { registerMCPHandlers, initializeMCP, shutdownMCP } from "./mcp.js";
import { registerSkillHandlers, initializeSkills } from "./skills.js";
import { registerShellHandlers } from "./shell.js";
import { registerMediaHandlers } from "./media.js";
import { registerPermissionHandlers } from "./permission.js";
import { registerInteractionHandlers } from "./interaction.js";
import { registerOAuthHandlers, cleanupOAuth } from "./oauth.js";
import { registerThemeHandlers, initializeThemeSystem } from "./themes.js";
import { registerVariableHandlers } from "./variables.js";
import { registerProjectDirsHandlers } from "./project-dirs.js";
import { registerSpacesHandlers } from "./spaces.js";
import { registerPluginHandlers } from "./plugins.js";
import { registerSchedulerHandlers } from "./scheduler.js";
import { registerFilesHandlers } from "./files.js";
import { registerSearchHandlers } from "@onething/electron-host/search/ipc";
import { registerAppStateHandlers } from "./app-state.js";
import { registerWindowHandlers } from "@onething/electron-host/ipc/window";
import { registerTodoPlanHandlers } from "./todo-plan.js";
import { registerScratchpadHandlers } from "./scratchpad.js";
import { registerVoiceHandlers } from "./voice.js";
import { registerMusicHandlers } from "./music.js";
import { startMusicNowPlayingWatch } from "@onething/app/music/service.js";
import { startRadioConductor } from "@onething/app/music/radio.js";
import { registerACPHandlers, initializeACP, shutdownACP } from "./acp.js";
import { registerGatewayHandlers } from "./gateway.js";
import { registerEvalsHandlers } from "./evals.js";
import { registerRpcHandler } from "./rpc.js";
import { registerPracticeHandlers } from "./practice.js";
import { registerTerminalHandlers } from "./terminal.js";
import { registerBrowserHandlers } from "./browser.js";
import { registerDeepLinkHandlers } from "./deeplink.js";
import { registerNotifyHandlers } from "./notify.js";
import { getEventBus } from "@onething/app/events/index.js";
import { sanitizeRendererOrigin } from "@onething/app/channel/index.js";

import { SESSION_COMMAND_TYPES } from "@shared/events/index.js";

export function initializeIPC() {
	registerChatHandlers();
	registerSessionHandlers();
	registerSettingsHandlers();
	registerCollabHandlers();
	registerToolHandlers();
	registerMCPHandlers();
	registerSkillHandlers();
	registerShellHandlers();
	registerMediaHandlers();
	registerPermissionHandlers();
	registerInteractionHandlers();
	registerOAuthHandlers();
	registerThemeHandlers();
	registerVariableHandlers();
	registerProjectDirsHandlers();
	registerSpacesHandlers();
	registerPluginHandlers();
	registerSchedulerHandlers();
	registerFilesHandlers();
	registerSearchHandlers();
	registerAppStateHandlers();
	registerWindowHandlers();
	registerTodoPlanHandlers();
	registerScratchpadHandlers();
	registerVoiceHandlers();
	registerMusicHandlers();
	// Safe at startup, unlike the keepalive: watching is a file stat on a timer,
	// and `ncm-cli state` cannot start a player even when it does run. Nothing
	// here can make sound.
	startMusicNowPlayingWatch();
	// Also inert while the radio is off: every sample starts with a brief read
	// that says "inactive" and returns. Sound only ever follows a user opening
	// the station in conversation.
	startRadioConductor();
	registerACPHandlers();
	registerGatewayHandlers();
	registerEvalsHandlers();
	// 通用 RPC 适配器:一条通道服务所有 router 域(usage 是首个)。加域不再动这里。
	registerRpcHandler();
	registerPracticeHandlers();
	registerTerminalHandlers();
	registerBrowserHandlers();
	registerNotifyHandlers();
	// 深链确认门(H4)。协议注册在同步段(bootstrap),这里只接确认卡的两条 invoke。
	registerDeepLinkHandlers();
	registerCommandHandler();
}

/**
 * Register the unified session:command handler.
 * Routes renderer commands through EventBus for processing by
 * subscribed systems (Permission, StreamEngine, etc.).
 */
function registerCommandHandler() {
	registerElectronSessionCommandIpcHandler({
		channel: IPC_CHANNELS.SESSION_COMMAND,
		handleCommand: async ({
			sessionId,
			command,
		}: ElectronSessionCommandRequest) => {
			const safeCommand = sanitizeRendererCommand(command);
			return emitCoreSessionCommandForIpc({
				sessionId,
				command: safeCommand as Parameters<
					ReturnType<typeof getEventBus>["emit"]
				>[1],
				eventBus: getEventBus(),
				logger: console,
			});
		},
	});
	console.log("[IPC] session:command handler registered");
}

function sanitizeRendererCommand(command: unknown): unknown {
	if (!command || typeof command !== "object") return command;
	const record = command as Record<string, unknown>;
	if (typeof record.type !== "string") return command;
	if (!record.type.startsWith("command:")) return command;

	// Phase 1 evals: amend turn records on retry/edit ("先落盘后补写").
	// turnId must match the assistant message id recorded by
	// turn-evaluation.ts (see collectContext there), not the sessionId —
	// otherwise every turn in a session collapses onto one record.
	if (record.type === SESSION_COMMAND_TYPES.RETRY_MESSAGE) {
		const sessionId = record.sessionId as string | undefined;
		// messageId here is the assistant message being retried, which is
		// exactly the turnId recorded for that turn.
		const turnId = record.messageId as string | undefined;
		if (sessionId && turnId) {
			// A retry is a late negative signal: materialize the incident
			// bundle now (scene from LRU + trace from persisted messages).
			Promise.all([
				import("@onething/runtime"),
				import("./evals.js"),
			])
				.then(async ([{ amendTurnRetry }, { createIncidentForTurn }]) => {
					const incident = await createIncidentForTurn({
						sessionId,
						turnId,
						origin: "auto",
						signals: { retried: true },
					});
					amendTurnRetry({
						turnId,
						sessionId,
						incidentRef: incident?.incidentId ?? null,
					});
				})
				.catch(() => {});
		}
	}
	if (record.type === SESSION_COMMAND_TYPES.EDIT_AND_RESEND) {
		const sessionId = record.sessionId as string | undefined;
		// messageId here is the user message being edited, not the assistant
		// turnId — best-effort amend key until callers can pass the
		// responding assistant message id. The prompt-capture LRU is keyed by
		// assistant message id, so this path usually creates no incident.
		const turnId = record.messageId as string | undefined;
		if (sessionId && turnId) {
			Promise.all([
				import("@onething/runtime"),
				import("./evals.js"),
			])
				.then(async ([{ amendTurnEditResend }, { createIncidentForTurn }]) => {
					const incident = await createIncidentForTurn({
						sessionId,
						turnId,
						origin: "auto",
						signals: { editResent: true },
					});
					amendTurnEditResend({
						turnId,
						sessionId,
						incidentRef: incident?.incidentId ?? null,
					});
				})
				.catch(() => {});
		}
	}

	if (
		record.type === SESSION_COMMAND_TYPES.SEND_MESSAGE ||
		record.type === SESSION_COMMAND_TYPES.EDIT_AND_RESEND ||
		record.type === SESSION_COMMAND_TYPES.INJECT_STEERING ||
		record.type === SESSION_COMMAND_TYPES.INJECT_FOLLOWUP
	) {
		return {
			...record,
			origin: sanitizeRendererOrigin(record),
		};
	}

	return command;
}

export {
	initializeMCP,
	shutdownMCP,
	initializeSkills,
	cleanupOAuth,
	initializeThemeSystem,
	initializeACP,
	shutdownACP,
};
