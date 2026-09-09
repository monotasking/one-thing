/**
 * `@onething/core/resource` —— 原子:资源 · 读 / 做 / 看
 * (`docs/design/atom-2026-09.md`,K0「地址与类型」)。
 *
 * 一句话(§0):**原子 = 一个有地址的资源,加三个动词:读、做、看;「做」必须
 * 声明效果。** 会话、消息、文件、目录、歌、邮件、工作区、窗口,全是资源;AI 的
 * 工具、界面的按钮、快捷键、斜杠命令、调度任务、deeplink、CLI、插件 API、给别的
 * agent 的 MCP 出口,全是这三个动词在不同出口的**投影**。
 *
 * K0 只有三件东西,一件行为都没有:
 *   · `ref.ts`      地址语法(`${scheme}:${path}`,第一个冒号处切);
 *   · `spec.ts`     自述的形状(reads / ops / events / state);
 *   · `contract.ts` 一份自述合不合规矩(§7 盲点 7 那道门的判定函数);
 *   · `registry.ts` 一张 scheme → 自述的表(类,不是模块单例)。
 *
 * 管线是 K1、出口是 K2–K4,都不在这里。零依赖、零 node 导入、**零 scheme 名** ——
 * 内核不认识 `session` / `file` / `music` 中的任何一个(§2 不变量 3),这一条由
 * `__tests__/stranger.test.ts` 扫本目录来执法。
 */

export {
  formatRef,
  isRef,
  isRefPrefix,
  isRefScheme,
  matchesRefPrefix,
  parseRef,
  sameRef,
} from './ref.js'
export type { Ref, ResourceRef } from './ref.js'

export type {
  EventSpec,
  JsonSchema,
  OpContext,
  OpHome,
  OpSpec,
  ReadSpec,
  ResourceSpec,
  StateSpec,
  StateVolatility,
} from './spec.js'

export {
  assertResourceSpec,
  describeResourceSpecProblem,
  formatResourceSpecProblem,
  ResourceSpecError,
} from './contract.js'
export type { ResourceSpecMember, ResourceSpecProblem } from './contract.js'

export { ResourceRegistry, ResourceSchemeTakenError } from './registry.js'
export type { ResolvedRef } from './registry.js'
