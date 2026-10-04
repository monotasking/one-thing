/**
 * HTTP 服务器那一侧的语音推送(语音第二入口的一个方面,决策 D26)。
 *
 * server 上没有语音运行时:`/api/voice/events` 与 `/api/voice/runtime-commands` 两条 SSE 原样保留
 * (router 今天没有推送面),订阅一如既往是空的。十一条数据面在 http 上的答案由
 * `voice-client-api.ts` 的域处理者在 `transport === 'http'` 那一支上给出。
 *
 * 2026-10-04 从 `http-server/http-server-runtime.ts` 原样搬来(决策 D219),代码一行没改。
 */
import type { RuntimeUnsubscribe, RuntimeVoiceAdapter } from "@onething/backend/http-server/http-server-runtime-facade.js";
import type {
	VoiceEvent,
	VoiceRuntimeCommand,
} from "@shared/ipc/voice.js";

/** 门面的 `voice` 一格:两条订阅都是空的。 */
export function createServerVoiceEventsPort(): RuntimeVoiceAdapter {
	const voicePort: RuntimeVoiceAdapter = {
		subscribeEvents(
			_handler: (event: VoiceEvent) => void,
		): RuntimeUnsubscribe {
			return () => {};
		},
		subscribeRuntimeCommands(
			_handler: (command: VoiceRuntimeCommand) => void,
		): RuntimeUnsubscribe {
			return () => {};
		},
	};
	return voicePort;
}
