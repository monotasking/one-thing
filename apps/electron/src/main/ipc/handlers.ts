import { registerChatHandlers } from "./chat.js";
import { registerSettingsHandlers } from "./settings.js";
import { registerToolHandlers } from "./tools.js";
import { initializeMCP, shutdownMCP } from "./mcp.js";
import { registerShellHandlers } from "./shell.js";
import { registerMediaHandlers } from "./media.js";
import { registerInteractionHandlers } from "./interaction.js";
import { registerOAuthHandlers } from "./oauth.js";
import { registerSpacesHandlers } from "./spaces.js";
import { registerPluginHandlers } from "./plugins.js";
import { registerSearchHandlers } from "@onething/electron-host/search/ipc";
import { registerWindowHandlers } from "@onething/electron-host/ipc/window";
import { registerTodoPlanHandlers } from "./todo-plan.js";
import { registerScratchpadHandlers } from "./scratchpad.js";
import { registerVoiceHandlers } from "./voice.js";
import { registerMusicHandlers } from "./music.js";
import { startMusicNowPlayingWatch } from "@onething/backend/wiring/music/service.js";
import { startRadioConductor } from "@onething/backend/wiring/music/radio.js";
import { initializeACP, shutdownACP } from "./acp.js";
import { registerEvalsHandlers } from "./evals.js";
import { registerRpcHandler } from "./rpc.js";
import { registerPracticeHandlers } from "./practice.js";
import { registerTerminalHandlers } from "./terminal.js";
import { registerBrowserHandlers } from "./browser.js";
import { registerDeepLinkHandlers } from "./deeplink.js";
import { registerNotifyHandlers } from "./notify.js";
export function initializeIPC() {
	registerChatHandlers();
	registerSettingsHandlers();
	registerToolHandlers();
	registerShellHandlers();
	registerMediaHandlers();
	registerInteractionHandlers();
	registerOAuthHandlers();
	registerSpacesHandlers();
	registerPluginHandlers();
	registerSearchHandlers();
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
	registerEvalsHandlers();
	// 通用 RPC 适配器:一条通道服务所有 router 域(usage 是首个)。加域不再动这里。
	registerRpcHandler();
	registerPracticeHandlers();
	registerTerminalHandlers();
	registerBrowserHandlers();
	registerNotifyHandlers();
	// 深链确认门(H4)。协议注册在同步段(bootstrap),这里只接确认卡的两条 invoke。
	registerDeepLinkHandlers();
}

export { initializeMCP, shutdownMCP, initializeACP, shutdownACP };
