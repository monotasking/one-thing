/**
 * RPC assembly point.
 *
 * `registerAppRpcDomains()` is the ONE line the assembly sequence runs and the
 * one place a new domain is listed — the target水位 of 主线 T: adding a domain
 * is a router file + a handler file + a line here, with zero shell edits.
 *
 * K0（内核收缩，docs/design/kernel-shrink-builtin-plugins-2026-08.md §3）：每个
 * 域现在是一个 **feature**（`rpc:<域>`），注册走 `FeatureContext`。对外的形状
 * 一个字没变 —— 仍然是「注册全部、返回总 disposer」；变的只是**接线方式**：
 * 注册项从此有主（`dumpFeatures()` 看得见谁注册了哪个域），卸载从「一串闭包」
 * 变成「逐 feature 逆序解绕」。域 handler 文件本身零改动。
 *
 * C2（cordis 采纳，docs/design/cordis-adoption-2026-08.md §2）：名册里出现了
 * 第一个**不是 `rpc:<域>` 薄包装**的成员 —— `trajectoryFeature` 从
 * `features/builtin/` 整个 import 进来，占的正是它从前那一格（`rpc:session-events`
 * 的位置），装配顺序一格未动。名册因此改名 `BUILTIN_FEATURES`：它列的是
 * **feature**，其中大多数今天恰好只注册一个 RPC 域。
 *
 * 为什么不另起一张表 + 另一条装配调用：那会把装配顺序拆成两处、并让
 * `backend.ts` 多一行 —— 与 C5「feature 名册 = 一个显式数组」的收口方向正好
 * 相反。一张有序表、一个入口，迁一个功能就是把一行内联包装换成一次 import，
 * 这是本期要证的形状。（遗留：函数仍叫 `registerAppRpcDomains`，名字比内容窄
 * 了半格 —— 改它要动 `backend.ts`，留给 C5 收口一起做。）
 */
import { agentsRouter } from '@shared/ipc/agents.js'
import { channelIdentityRouter } from '@shared/ipc/channel-identity.js'
import { goalRouter } from '@shared/ipc/goal.js'
import { markdownRouter } from '@shared/ipc/markdown.js'
import { permissionGrantsRouter } from '@shared/ipc/permission-grants.js'
import { promptsRouter } from '@shared/ipc/prompts.js'
import { modelsRouter, providersRouter } from '@shared/ipc/providers.js'
import { todoPlanRouter } from '@shared/ipc/todo-plan.js'
import { usageRouter } from '@shared/ipc/usage.js'
import { trajectoryFeature } from '../features/builtin/trajectory.js'
import { mountFeature, type FeatureDefinition, type FeatureUnmount } from '../features/index.js'
import { agentsRpcHandlers } from './domains/agents.js'
import { channelIdentityRpcHandlers } from './domains/channel-identity.js'
import { goalRpcHandlers } from './domains/goal.js'
import { markdownRpcHandlers } from './domains/markdown.js'
import { modelsRpcHandlers } from './domains/models.js'
import { permissionGrantsRpcHandlers } from './domains/permission-grants.js'
import { promptsRpcHandlers } from './domains/prompts.js'
import { providersRpcHandlers } from './domains/providers.js'
import { todoPlanRpcHandlers } from './domains/todo-plan.js'
import { usageRpcHandlers } from './domains/usage.js'

/**
 * 内置 feature 的名册。**顺序即装配顺序**，与 K0 之前逐行调用的顺序逐字一致
 * （包装不重排：K0 的宪法是行为零变化）。
 *
 * 两种成员，同一张表：
 *  - **内联的 `rpc:<域>` 包装**（还没迁的那批）—— 一行一个域；
 *  - **import 进来的 feature**（已迁的）—— 一行一次 import，它自己决定要注册
 *    几项、注册什么。迁移一个功能 = 把前者换成后者，位置不动。
 */
const BUILTIN_FEATURES: FeatureDefinition[] = [
  { id: 'rpc:usage', mount: ctx => { ctx.registerRpcDomain(usageRouter, usageRpcHandlers) } },
  { id: 'rpc:prompts', mount: ctx => { ctx.registerRpcDomain(promptsRouter, promptsRpcHandlers) } },
  { id: 'rpc:goal', mount: ctx => { ctx.registerRpcDomain(goalRouter, goalRpcHandlers) } },
  { id: 'rpc:todo-plan', mount: ctx => { ctx.registerRpcDomain(todoPlanRouter, todoPlanRpcHandlers) } },
  // C2：轨迹是第一个迁成真 feature 的功能。它占的就是 `rpc:session-events`
  // 从前那一格 —— 顺序不变，变的是这一行说的是「哪件功能」而不是「哪个域」。
  trajectoryFeature,
  { id: 'rpc:channel-identity', mount: ctx => { ctx.registerRpcDomain(channelIdentityRouter, channelIdentityRpcHandlers) } },
  { id: 'rpc:agents', mount: ctx => { ctx.registerRpcDomain(agentsRouter, agentsRpcHandlers) } },
  { id: 'rpc:providers', mount: ctx => { ctx.registerRpcDomain(providersRouter, providersRpcHandlers) } },
  { id: 'rpc:models', mount: ctx => { ctx.registerRpcDomain(modelsRouter, modelsRpcHandlers) } },
  // 批 3：两个「带 context 的安全域」。护栏在 handler 里，靠 dispatch context
  // 的 sandboxRoot / owner 判定，不再由 server 壳自己抄一份。
  { id: 'rpc:markdown', mount: ctx => { ctx.registerRpcDomain(markdownRouter, markdownRpcHandlers) } },
  { id: 'rpc:permission-grants', mount: ctx => { ctx.registerRpcDomain(permissionGrantsRouter, permissionGrantsRpcHandlers) } },
]

/** Bind every builtin domain. Returns a disposer that unbinds all of them. */
export async function registerAppRpcDomains(): Promise<() => Promise<void>> {
  const unmounts: FeatureUnmount[] = []
  for (const feature of BUILTIN_FEATURES) {
    unmounts.push(await mountFeature(feature))
  }
  return async () => {
    // 逆序：与 FeatureContext.disposeAll 同一惯例（后挂的先卸）。
    for (let i = unmounts.length - 1; i >= 0; i -= 1) await unmounts[i]()
  }
}

export {
  dispatchRpc,
  hasRpcDomain,
  registerRouterHandlers,
  resetRpcRegistryForTests,
} from './registry.js'
