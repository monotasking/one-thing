/**
 * HTTP 服务器那一侧的 OAuth 令牌事件推送(认证第二入口的一个方面,决策 D26)。
 *
 * `GET /api/oauth/events` 那条 SSE 的货源:把装配层那台 `authService` 的令牌事件广播端口
 * **串联**起来 —— 先让宿主原来那只把事件推给窗口,再扇进这里的订阅表;`restore()` 还原。
 * 独立进程里前一位是空的,串联退化成只扇给 SSE。
 *
 * 2026-10-04 从 `http-server/http-server-runtime.ts` 原样搬来(决策 D219),代码一行没改。
 */
import {
	configureOAuthEventBroadcaster,
	getOAuthEventBroadcaster,
	type OAuthTokenEvent,
} from "./auth-oauth-events.js";
import { getLogger } from '@onething/backend/logging'
import type { RuntimeOAuthAdapter, RuntimeUnsubscribe } from "@onething/backend/http-server/http-server-runtime-facade.js";

// 日志命名空间沿用搬家前的 `server.runtime`。
const log = getLogger('server.runtime')

/** 调用即串联上广播端口;返回门面的 `oauth` 一格与还原函数。 */
export function createServerOAuthTokenEvents() {
	/**
	 * OAuth 令牌事件同形(P4c 第七批):数据面迁走之后,事件源是装配层那台
	 * `authService` 单例,而 `GET /api/oauth/events` 那条 SSE 是它在 web 上的出口。
	 * 端口是单槽的,所以嵌在宿主里时**串联** —— 先让桌面那只把事件推给窗口,
	 * 再扇进这里的订阅表;`shutdown()` 还原。
	 */
	const oauthTokenEventHandlers = new Set<(event: OAuthTokenEvent) => void>();
	const previousOAuthEventBroadcaster = getOAuthEventBroadcaster();
	configureOAuthEventBroadcaster((event) => {
		previousOAuthEventBroadcaster?.(event);
		for (const handler of oauthTokenEventHandlers) {
			try {
				handler(event);
			} catch (error) {
				log.error("oauth token event broadcast failed", {}, error);
			}
		}
	});
	const restoreOAuthEventBroadcaster = (): void => {
		configureOAuthEventBroadcaster(previousOAuthEventBroadcaster);
		oauthTokenEventHandlers.clear();
	};
	const subscribeOAuthTokenEvents = (
		handler: (event: OAuthTokenEvent) => void,
	): RuntimeUnsubscribe => {
		oauthTokenEventHandlers.add(handler);
		return () => {
			oauthTokenEventHandlers.delete(handler);
		};
	};
	const oauthPort: RuntimeOAuthAdapter = {
		subscribe: subscribeOAuthTokenEvents,
	};
	return { port: oauthPort, restore: restoreOAuthEventBroadcaster };
}
