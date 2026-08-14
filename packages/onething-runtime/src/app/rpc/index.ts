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
 */
import { agentsRouter } from '@shared/ipc/agents.js'
import { channelIdentityRouter } from '@shared/ipc/channel-identity.js'
import { goalRouter } from '@shared/ipc/goal.js'
import { promptsRouter } from '@shared/ipc/prompts.js'
import { modelsRouter, providersRouter } from '@shared/ipc/providers.js'
import { sessionEventsRouter } from '@shared/ipc/session-events.js'
import { todoPlanRouter } from '@shared/ipc/todo-plan.js'
import { usageRouter } from '@shared/ipc/usage.js'
import { mountFeature, type FeatureDefinition, type FeatureUnmount } from '../features/index.js'
import { agentsRpcHandlers } from './domains/agents.js'
import { channelIdentityRpcHandlers } from './domains/channel-identity.js'
import { goalRpcHandlers } from './domains/goal.js'
import { modelsRpcHandlers } from './domains/models.js'
import { promptsRpcHandlers } from './domains/prompts.js'
import { providersRpcHandlers } from './domains/providers.js'
import { sessionEventsRpcHandlers } from './domains/session-events.js'
import { todoPlanRpcHandlers } from './domains/todo-plan.js'
import { usageRpcHandlers } from './domains/usage.js'

/**
 * 内置 RPC 域的名册。**顺序即装配顺序**，与 K0 之前逐行调用的顺序逐字一致
 * （包装不重排：K0 的宪法是行为零变化）。
 */
const RPC_FEATURES: FeatureDefinition[] = [
  { id: 'rpc:usage', mount: ctx => { ctx.registerRpcDomain(usageRouter, usageRpcHandlers) } },
  { id: 'rpc:prompts', mount: ctx => { ctx.registerRpcDomain(promptsRouter, promptsRpcHandlers) } },
  { id: 'rpc:goal', mount: ctx => { ctx.registerRpcDomain(goalRouter, goalRpcHandlers) } },
  { id: 'rpc:todo-plan', mount: ctx => { ctx.registerRpcDomain(todoPlanRouter, todoPlanRpcHandlers) } },
  { id: 'rpc:session-events', mount: ctx => { ctx.registerRpcDomain(sessionEventsRouter, sessionEventsRpcHandlers) } },
  { id: 'rpc:channel-identity', mount: ctx => { ctx.registerRpcDomain(channelIdentityRouter, channelIdentityRpcHandlers) } },
  { id: 'rpc:agents', mount: ctx => { ctx.registerRpcDomain(agentsRouter, agentsRpcHandlers) } },
  { id: 'rpc:providers', mount: ctx => { ctx.registerRpcDomain(providersRouter, providersRpcHandlers) } },
  { id: 'rpc:models', mount: ctx => { ctx.registerRpcDomain(modelsRouter, modelsRpcHandlers) } },
]

/** Bind every builtin domain. Returns a disposer that unbinds all of them. */
export async function registerAppRpcDomains(): Promise<() => Promise<void>> {
  const unmounts: FeatureUnmount[] = []
  for (const feature of RPC_FEATURES) {
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
