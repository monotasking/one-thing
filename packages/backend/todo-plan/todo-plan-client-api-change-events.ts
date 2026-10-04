/**
 * HTTP 服务器那一侧的 todo/plan 变更推送(todo/plan 第二入口的一个方面,决策 D26)。
 *
 * `/api/todo-plan/events` 那条 SSE 唯一的货源:把 todo/plan 的宿主端口**串联**起来 ——
 * 先调宿主原来那只广播,再扇进这里的订阅表;`restore()` 把宿主原来那份端口装回去,
 * `clearHandlers()` 清订阅表(收尾时排在还原之后)。
 *
 * 2026-10-04 从 `http-server/http-server-runtime.ts` 原样搬来(决策 D219),代码一行没改。
 */
import type { TodoPlanChangedPayload } from "@onething/backend/todo-plan";
import {
	configureTodoPlanHost,
	getTodoPlanHostPorts,
} from "@onething/backend/todo-plan";
import { getLogger } from '@onething/backend/logging'
import type { RuntimeTodoPlanAdapter, RuntimeUnsubscribe } from "@onething/backend/http-server/http-server-runtime-facade.js";

// 日志命名空间沿用搬家前的 `server.runtime`。
const log = getLogger('server.runtime')

type TodoPlanChangedHandler = (payload: TodoPlanChangedPayload) => void;

/** 调用即串联上宿主端口;返回门面的 `todoPlan` 一格、还原函数与清订阅表的函数。 */
export function createServerTodoPlanChangeEvents() {
	/**
	 * todo/plan 的广播和草稿纸同形:数据面迁到通用 RPC 通道之后,写发生在
	 * `@onething/backend/todo-plan` 那一个进程级 store 里,per-owner 的第二个 store
	 * 连同它的 per-owner 订阅表一起没了。**这个端口是 `/api/todo-plan/events`
	 * 这条 SSE 唯一的货源** —— 少了它,浏览器端的变更推送会安静地断掉。
	 */
	const todoPlanChangedHandlers = new Set<TodoPlanChangedHandler>();
	// 单槽端口:嵌在宿主里时**串联**(先调宿主原来那只,再喂 SSE),
	// `shutdown()` 里还原。独立进程里前一位是空的,串联退化成今天的行为。
	const previousTodoPlanHostPorts = getTodoPlanHostPorts();
	configureTodoPlanHost({
		...previousTodoPlanHostPorts,
		broadcastChanged: (payload) => {
			previousTodoPlanHostPorts.broadcastChanged?.(payload);
			for (const handler of todoPlanChangedHandlers) {
				try {
					handler(payload);
				} catch (error) {
					log.error("todo-plan broadcast failed", {}, error);
				}
			}
		},
	});

	const subscribeTodoPlanChanged = (
		handler: TodoPlanChangedHandler,
	): RuntimeUnsubscribe => {
		todoPlanChangedHandlers.add(handler);
		return () => {
			todoPlanChangedHandlers.delete(handler);
		};
	};

	const todoPlanPort: RuntimeTodoPlanAdapter<unknown> = {
		subscribeChanged: subscribeTodoPlanChanged,
	};
	return {
		port: todoPlanPort,
		restore: () => configureTodoPlanHost(previousTodoPlanHostPorts),
		clearHandlers: () => todoPlanChangedHandlers.clear(),
	};
}
