/**
 * 本文件在 P4c 第七批之后**只剩广播**:6 条 oauth invoke 通道已整只迁到通用 RPC
 * 通道(`@shared/ipc/oauth.ts` 的 `oauthRouter` + `packages/backend/rpc/domains/oauth.ts`),
 * 桌面和 web 走同一条 dispatch、同一台 authService。router 没有推送面,所以
 * `OAUTH_TOKEN_REFRESHED` / `OAUTH_TOKEN_EXPIRED` 两条留在这里。
 *
 * 这两条推送如今是**注入端口**(`configureOAuthEventBroadcaster`,同 practice /
 * scratchpad 判例):事件源是装配层那台 authService 单例,谁在跑就由谁决定往哪儿
 * 广播 —— 桌面这一侧的答案是所有活着的窗口,server 那一侧的答案是
 * `GET /api/oauth/events` 的 SSE。递给渲染层的 payload 与迁移前逐字相同
 * (`{ providerId }` / `{ providerId, error }`)。
 */
import {
  broadcastElectronOAuthTokenExpired,
  broadcastElectronOAuthTokenRefreshed,
} from "@onething/electron-host/oauth/events";
import { configureOAuthEventBroadcaster } from "@onething/backend/wiring/auth/oauth-events.js";
import { IPC_CHANNELS } from "@shared/ipc.js";

export function registerOAuthHandlers(): void {
	configureOAuthEventBroadcaster(event => {
		if (event.type === "oauth:token-refreshed") {
			broadcastElectronOAuthTokenRefreshed({
				channel: IPC_CHANNELS.OAUTH_TOKEN_REFRESHED,
				providerId: event.providerId,
			});
			return;
		}
		broadcastElectronOAuthTokenExpired({
			channel: IPC_CHANNELS.OAUTH_TOKEN_EXPIRED,
			providerId: event.providerId,
			error: event.error,
		});
	});
}
