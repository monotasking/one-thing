/**
 * HTTP 服务器那一侧的设置变更推送(设置第二入口的一个方面,决策 D26)。
 *
 * 浏览器 / React 壳经 `GET /api/events` 听 `settings:changed`。这里把设置的广播端口**串联**
 * 起来:先让宿主那只把事件推给窗口,再把脱敏后的设置扇进 SSE 订阅表;`restore()` 还原。
 *
 * 2026-10-04 从 `http-server/http-server-runtime.ts` 原样搬来(决策 D219),代码一行没改。
 */
import {
	configureSettingsEventBroadcaster,
	getSettingsEventBroadcaster,
	type SettingsEvent,
} from "@onething/backend/settings";
import { getLogger } from '@onething/backend/logging'
import type { RuntimeSettingsAdapter } from "@onething/backend/http-server/http-server-runtime-facade.js";
import type { AppSettings } from "@shared/ipc/settings.js";
import { sanitizeSettingsForClient } from "./settings-client-api-projection.js";

// 日志命名空间沿用搬家前的 `server.runtime`。
const log = getLogger('server.runtime')

/** 调用即串联上广播端口;返回门面的 `settings` 一格与还原函数。 */
export function createServerSettingsChangeEvents() {
	/**
	 * 设置变更(E 批)——**与 oauth 逐字同形**的单槽端口串联:先让宿主那只把
	 * 事件推给窗口,再扇进这里的 SSE 订阅表;`shutdown()` 还原。
	 *
	 * 两件事故意与桌面那一侧不同,理由都写在这儿:
	 *
	 *  - **载荷脱敏**。桌面回灌的是整份 `AppSettings`(同一台机器,设置页要读到
	 *    自己刚填的凭证);SSE 那头是网络对端,所以过一遍 `sanitizeSettingsForClient`
	 *    —— **逐字复用** `settings.getSettings` 在 `transport === 'http'` 那一支上
	 *    已经在用的那个投影,于是推送与读取交出去的是同一形状,一格不多。
	 *  - **不排除发起窗**。`excludeCallerId` 说的是"哪扇 BrowserWindow 别收自己的
	 *    回声",它是 `webContents.id`;SSE 连接里没有那样一个东西,而浏览器那侧
	 *    发起保存后本来就要用回执刷新自己。原样全发。
	 */
	const settingsChangedHandlers = new Set<(settings: AppSettings) => void>();
	const previousSettingsEventBroadcaster = getSettingsEventBroadcaster();
	configureSettingsEventBroadcaster((event: SettingsEvent) => {
		previousSettingsEventBroadcaster?.(event);
		if (settingsChangedHandlers.size === 0) return;
		const sanitized = sanitizeSettingsForClient(event.settings);
		for (const handler of settingsChangedHandlers) {
			try {
				handler(sanitized);
			} catch (error) {
				log.error("settings changed broadcast failed", {}, error);
			}
		}
	});
	const restoreSettingsEventBroadcaster = (): void => {
		configureSettingsEventBroadcaster(previousSettingsEventBroadcaster);
		settingsChangedHandlers.clear();
	};
	const settingsPort: RuntimeSettingsAdapter = {
		subscribeChanged(handler) {
			const typedHandler = handler as (settings: AppSettings) => void;
			settingsChangedHandlers.add(typedHandler);
			return () => {
				settingsChangedHandlers.delete(typedHandler);
			};
		},
	};
	return { port: settingsPort, restore: restoreSettingsEventBroadcaster };
}
