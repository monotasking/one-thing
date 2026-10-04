/**
 * HTTP 服务器那一侧的草稿纸变更推送(草稿纸第二入口的一个方面,决策 D26)。
 *
 * `GET /api/scratchpad/events` 那条 SSE 的货源:把草稿纸的宿主端口**串联**起来(先调宿主
 * 原来那只广播,再扇进这里的订阅表);这个进程是 core 进程时再起那只文件 watcher ——
 * AI 用普通 write/edit 工具改纸时不经过 store,watcher 是唯一会告诉浏览器「纸变了」的人。
 * 收尾:`restore()` 装回宿主原来那份端口,`stopWatcher()` 只停自己起的那只,
 * `clearHandlers()` 清订阅表。
 *
 * 2026-10-04 从 `http-server/http-server-runtime.ts` 原样搬来(决策 D219),代码一行没改。
 */
import {
	configureScratchpadHost,
	getScratchpadHostPorts,
	startScratchpadWatcher,
	stopScratchpadWatcher,
} from "./scratchpad-service-bound.js";
import { getLogger } from '@onething/backend/logging'
import type { RuntimeScratchpadAdapter, RuntimeUnsubscribe } from "@onething/backend/http-server/http-server-runtime-facade.js";
import type { ScratchpadChangedPayload } from "@shared/ipc/scratchpad.js";

// 日志命名空间沿用搬家前的 `server.runtime`。
const log = getLogger('server.runtime')

/**
 * 调用即串联上宿主端口(`ownsProcessPorts` 时再起 watcher);返回门面的 `scratchpad` 一格
 * 与三只收尾函数。
 */
export function createServerScratchpadChangeEvents(ports: { ownsProcessPorts: boolean }) {
	const { ownsProcessPorts } = ports;
	/**
	 * 草稿纸的广播是**进程级**的:store 是 `@onething/backend/scratchpad` 的单例
	 * (引擎在同一进程里读同一张纸),所以订阅者也不按 owner 分表 —— 分了就要
	 * 有第二个 store,而第二个 store 就是第二份事实。
	 */
	const scratchpadChangedHandlers = new Set<
		(payload: ScratchpadChangedPayload) => void
	>();
	// 单槽端口:嵌在宿主里时**串联**(先调宿主原来那只,再喂 SSE),
	// `shutdown()` 里还原。独立进程里前一位是空的,串联退化成今天的行为。
	const previousScratchpadHostPorts = getScratchpadHostPorts();
	configureScratchpadHost({
		...previousScratchpadHostPorts,
		broadcastChanged: (payload) => {
			previousScratchpadHostPorts.broadcastChanged?.(payload);
			for (const handler of scratchpadChangedHandlers) {
				try {
					handler(payload);
				} catch (error) {
					log.error("scratchpad broadcast failed", {}, error);
				}
			}
		},
	});
	// AI 用普通 write/edit 工具改纸时不经过 store —— watcher 是唯一会告诉
	// 浏览器"纸变了"的人。嵌在宿主里时宿主已经起过同一只 watcher(它是单例),
	// 不重复起,也因此不由这里停。
	if (ownsProcessPorts) {
		void startScratchpadWatcher().catch((error) => {
			log.error("scratchpad watcher failed to start", {}, error);
		});
	}

	const subscribeScratchpadChanged = (
		handler: (payload: ScratchpadChangedPayload) => void,
	): RuntimeUnsubscribe => {
		scratchpadChangedHandlers.add(handler);
		return () => {
			scratchpadChangedHandlers.delete(handler);
		};
	};

	const scratchpadPort: RuntimeScratchpadAdapter<unknown> = {
		// 结构债 P4c:四条数据面已迁到 `scratchpad` RPC 域。这里只剩推送面 ——
		// `GET /api/scratchpad/events` 的 SSE 源,router 今天没有推送面。
		subscribeChanged: subscribeScratchpadChanged,
	};
	return {
		port: scratchpadPort,
		restore: () => configureScratchpadHost(previousScratchpadHostPorts),
		stopWatcher: () => { if (ownsProcessPorts) stopScratchpadWatcher(); },
		clearHandlers: () => scratchpadChangedHandlers.clear(),
	};
}
