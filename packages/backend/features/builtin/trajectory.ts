/**
 * 轨迹 feature —— C2 的被试品(`docs/design/cordis-adoption-2026-08.md` §2、§6)。
 *
 * 这是**第一个不是「rpc:<域> 薄包装」的 feature**:它的身份是一件产品功能
 * (会话事件日志的第二投影),今天恰好只落一项注册(`sessionEvents` RPC 域),
 * 明天要加的东西(导出、清理、后台索引)都往这个 `mount` 里加,而不是再去
 * 名册里插一行。选它当第一个的理由在 K1 记录里:边界最清楚(纯消费者)、
 * 被 105+ 测试钉死(等价性可自证)。
 *
 * ── C0 立下的三条 cordis 语义地雷,逐条对照(§5.5.3)──────────────────────
 *
 * 1. **并行 + 吞错的 `_unload`**。本 feature 的卸载**没有顺序契约**:只有一项
 *    注册,解绕它就是把 RPC 域从注册表里摘掉,不涉及"先停写再关文件"这类
 *    次序。所以它既不需要适配层的逆序保证,也不需要把工作收进同一个 effect ——
 *    但**这是本 feature 的属性,不是可以外推的结论**:C3 要迁的音乐 /
 *    todo-plan 有真实的停写顺序,那时必须显式收进同一个 effect。
 *    E0 采集器(`session-event-recorder`)有写侧生命周期,它**刻意不迁**
 *    (差距清单 §6 有条目):迁它就得当场回答这个顺序问题。
 * 2. **`apply` 抛错 = fiber FAILED**。本 feature 继续用**适配层接住**的默认:
 *    `mount` 是同步纯记账,唯一可能的抛点是 RPC 域重复注册(那是接线 bug,
 *    要的正是"首错原样抛给装配方"),不走 cordis 的 `logger.error` + 继续活。
 * 3. **`ctx.effect()` 在 UNLOADING 期抛 `INACTIVE_EFFECT`**。本 feature 在
 *    dispose 路径里**不注册任何东西**(没有"卸载时补记一条日志"的 disposer)。
 *
 * import 零副作用:本模块加载只产出一个常量对象,注册发生在 `mountFeature`
 * 真的调用 `mount` 的那一刻(`app/__tests__/import-side-effect-free.test.ts`)。
 */
import { sessionEventsRouter } from '@shared/ipc/session-events.js'
import { sessionEventsRpcHandlers } from '../../rpc/domains/session-events.js'
import type { FeatureDefinition } from '../index.js'

export const trajectoryFeature: FeatureDefinition = {
  // id 是 `trajectory` 而不是 `rpc:session-events`:名册里这一行从此说的是
  // **哪件功能**,不是"哪个域"。`dumpFeatures()` 因此看得见 trajectory。
  id: 'trajectory',
  mount(ctx) {
    ctx.registerRpcDomain(sessionEventsRouter, sessionEventsRpcHandlers)
  },
}
