/**
 * K1 —— 资源内核的装配面(`docs/design/atom-2026-09.md` §9 K1)。
 *
 * 两件事,一件不多:
 *   ① `createResourceKernel(runner)` —— 把一张新注册表与**宿主那台 `ToolRunner`**
 *      装进一个 `ResourceKernel`。递进来的是同一台 runner,不是「给资源另配一台」:
 *      那正是 K1 的整句话(不新造第二条管线)在装配这一侧的样子。
 *   ② `mountBuiltinResources(kernel)` —— 内置资源的**唯一**注册点,返回逆序注销。
 *
 * 加一种内置资源 = 这只文件里加一行 `providers.push(new XxxProvider())`,加一份
 * 自述,加一份 provider。§8 演练要的「能力自己的模块 + 一行注册」就是这一行 ——
 * `backend.ts` 里不出现任何资源的名字,`core` 里更不出现。
 *
 * ── 目录名为什么是 `wiring/resource` ────────────────────────────────────────
 * `wiring/<domain>` 是「只为把一个领域插进脊柱而存在」的那一档(结构债 P3 定的),
 * 而这里正是:自述在产品层、内核在 core,这一层只负责把两头接上并交给装配。
 * I1(backend 根目录名不许影子化 runtime 领域名)对 `wiring/` 豁免;I2 那条不适用
 * ——`packages/onething-runtime/src` 下**没有** `resource/` 目录,会话那份自述住在
 * `sessions/` 里,不新开一棵同名树。
 */

import { ResourceKernel, ResourceRegistry } from '@onething/core/resource'
import type { ResourceKernelOptions } from '@onething/core/resource'
import type { ToolRunner } from '@onething/core/toolkit'
import { SessionResourceProvider } from './session-provider.js'

export { SessionResourceProvider, SessionNotFoundError, SessionRefRequiredError } from './session-provider.js'
export type { SessionOpPayload } from './session-provider.js'

/**
 * 一台资源内核。注册表是**新建**的(不是进程单例):谁要一张表谁自己 new 一个,
 * `OnethingBackend` 把它当字段持有 —— 与 `registry.ts` 头注释里那条组合根法条
 * 逐字同义。
 */
export function createResourceKernel(runner: ToolRunner, options: ResourceKernelOptions = {}): ResourceKernel {
  return new ResourceKernel(new ResourceRegistry(), runner, options)
}

/**
 * 装上这台宿主的内置资源,返回**逆序**注销。
 *
 * 逆序不是仪式:注销顺序与注册顺序相反是 `own()` 那条纪律的形状,一种资源将来若
 * 依赖另一种先在场(K3 的音乐依赖目录),顺序就已经是对的。
 */
export function mountBuiltinResources(kernel: ResourceKernel): () => void {
  const disposers = [kernel.mount(new SessionResourceProvider())]
  return () => {
    for (const dispose of [...disposers].reverse()) dispose()
  }
}
