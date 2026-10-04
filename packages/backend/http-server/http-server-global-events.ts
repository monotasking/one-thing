/**
 * `GET /api/events` 的**非会话那一半**(原子 K2a',`docs/design/atom-2026-09.md`
 * §4「所有出口都是投影」)。
 *
 * 那条 SSE 上流着两类东西:会话事件(带序号、进合批器、`?after=` 能回放)与
 * 「不属于任何一条会话」的推送。第二类从前只有一条(`settings:changed`,共享层
 * 读侧补齐 E 批),K2a' 又给它加了通用的全局事件出口 —— 于是它们值一只文件,
 * `http.ts` 那边只剩一行调用。
 *
 * ## 三条纪律
 *
 * 1. **不新开路由。** 两半骑的是同一条 `GET /api/events` —— 再开一条 `/api/<域>/events`
 *    就是加一条壳税(`transport:gate` 量的正是这个),而这两类推送与会话事件天然
 *    同一批订阅者:打开页面就要听。
 * 2. **不占会话事件的序号。** 全局事件不进任何一条会话的环形缓冲,所以这些帧
 *    **不带 `id:`**,`?after=` / `Last-Event-ID` 重连也**不回放**它们 —— 那两样只对
 *    会话事件的 seq 有意义。断线期间错过的全局事件就是错过了;要补的东西该由客户端
 *    重新读一次现状(`resources.list` / `describe`),而不是让内核替每一种事件都
 *    存一本回放账。
 * 3. **转发这一侧不认识任何一种事件的名字。** 出网名单是
 *    `@shared/events` 的 `GLOBAL_EVENT_LEAVES_PROCESS`(表在事件旁边,不在传输面
 *    旁边:加一种全局事件时要做的决定属于那种事件,不属于这条 SSE)。这里只负责
 *    把过了名单的每一条原样写成一帧,`event` 名就是它的 `type`。
 *
 * 桌面内嵌面与 `apps/backend-server` 共用 `http.ts`,所以这一处改两处生效 —— `embed.ts`
 * 没有第二份订阅逻辑,它只是把同一台 runtime 挂到自己的端口上。
 */

import type { ServerResponse } from 'node:http'
import type { OnethingRuntimeFacade, RuntimeGlobalEventsAdapter, RuntimeRequestContext, RuntimeUnsubscribe } from './http-server-runtime-facade.js'
import type { GenericEventBus } from '@onething/backend/event'
import type { AgentEngineSessionEvent } from '@onething/backend/agent'
import { GLOBAL_EVENT_LEAVES_PROCESS, type GlobalEvent } from '@shared/events/index.js'
import { writeSse, type SseDelivery } from './http-server-sse.js'

/** 这只文件要的全部上下文。刻意结构化 —— 它不需要认识 `http.ts` 的 `RouteContext`。 */
interface NonSessionDeliveryContext {
  response: ServerResponse
  sse?: SseDelivery
  runtime: OnethingRuntimeFacade
  requestContext: RuntimeRequestContext
}

function leavesProcess(type: string): boolean {
  // `hasOwnProperty` 而不是裸下标:`type` 来自一条事件的自述字段,裸下标会从
  // `Object.prototype` 上摸到 `toString` 并把它当成一行放行(同 `registry.ts`)。
  return Object.prototype.hasOwnProperty.call(GLOBAL_EVENT_LEAVES_PROCESS, type)
    && GLOBAL_EVENT_LEAVES_PROCESS[type as GlobalEvent['type']]
}

/**
 * 设置变更(E 批):**骑这条已有的 SSE**,不新开 `/api/settings/events` ——
 * 它不是会话事件,所以不进合批器、不占 `session:event` 的 seq(重连的
 * Last-Event-ID 只对会话事件序号有意义)。载荷是脱敏过的整份设置,与
 * `settings.getSettings` 在 http 分叉上交出去的逐字同形。
 */
function subscribeSettingsEvents(context: NonSessionDeliveryContext, unsubs: RuntimeUnsubscribe[]): void {
  const settingsAdapter = context.runtime.settings
  if (settingsAdapter?.subscribeChanged) {
    unsubs.push(settingsAdapter.subscribeChanged((settings: unknown) => {
      writeSse(context, 'settings:changed', settings)
    }, context.requestContext))
  }
}

/**
 * 全局事件(K2a'):过名单的每一条转成一帧,`event` 名 = 事件的 `type`,载荷原样。
 *
 * 会话事件那条路与 `SessionStreamCoalescer` 一个字都没动:合批器攒的是同一条流上
 * 的 delta,而全局事件既不属于任何一条流,也没有需要攒的量。
 */
function subscribeGlobalEvents(context: NonSessionDeliveryContext, unsubs: RuntimeUnsubscribe[]): void {
  const adapter = context.runtime.globalEvents
  if (!adapter) return
  unsubs.push(adapter.subscribe((event: unknown) => {
    const type = (event as { type?: unknown } | null)?.type
    if (typeof type !== 'string' || !leavesProcess(type)) return
    writeSse(context, type, event)
  }, context.requestContext))
}

/** `/api/events` 上非会话的那一半。退订随连接关闭(`unsubs` 由调用方持有)。 */
export function subscribeNonSessionEvents(
  context: NonSessionDeliveryContext,
  unsubs: RuntimeUnsubscribe[],
): void {
  subscribeSettingsEvents(context, unsubs)
  subscribeGlobalEvents(context, unsubs)
}

/**
 * 门面的 `globalEvents` 一格:按 `GLOBAL_EVENT_LEAVES_PROCESS` 逐条 `onGlobal`。
 * 2026-10-04 随 server runtime 拆分从 `http-server-runtime.ts` 原样搬来(决策 D219)。
 */
export function createServerGlobalEventsPort(
	eventBus: Pick<GenericEventBus<AgentEngineSessionEvent>, 'onGlobal'>,
): RuntimeGlobalEventsAdapter {
	/**
	 * 全局(非会话)事件的推送面(原子 K2a')。
	 *
	 * 名单来自 `@shared/events` 的 `GLOBAL_EVENT_LEAVES_PROCESS` —— **这里逐条
	 * `onGlobal` 而不是挂一个"什么都收"的钩子**:`EventBus` 只有按类型的订阅面,
	 * 而为转发在总线上新开一个通配钩子,等于给一个只有一个读者的需求加一种机制。
	 * 名单是数据(加一种事件在那张表上加一行),这一句循环里没有任何事件的名字。
	 *
	 * 过滤在**这一头**做一次(哪些出得了进程),SSE 那头(`global-event-delivery.ts`)
	 * 再读同一张表做一次:一次是"不订阅",一次是"不写帧"。两处读同一张表,不是两份
	 * 名单 —— 别的宿主将来装自己的 `globalEvents` 端口时,SSE 那一道仍然在。
	 */
	const globalEventsPort: RuntimeGlobalEventsAdapter = {
		subscribe(handler: (event: unknown) => void): RuntimeUnsubscribe {
			const unsubs: RuntimeUnsubscribe[] = [];
			for (const [type, leaves] of Object.entries(GLOBAL_EVENT_LEAVES_PROCESS)) {
				if (!leaves) continue;
				unsubs.push(
					eventBus.onGlobal(type as never, (envelope: { event: unknown }) => {
						handler(envelope.event);
					}),
				);
			}
			return () => {
				for (const unsubscribe of unsubs.splice(0)) unsubscribe();
			};
		},
	};
	return globalEventsPort;
}
