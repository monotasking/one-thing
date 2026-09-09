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
 * K1 在它上面加了**一条管线**,而且是**已经存在的那一条**(§9 K1「一条管线」):
 *   · `provider.ts` 实现侧的接口(一个 scheme 一个对象,三个动词各一个方法);
 *   · `schema.ts`   自述 → AI 工具的入参契约 / 描述 / 效果并集(纯函数);
 *   · `tool.ts`     `ResourceTool extends Tool` —— 每个 scheme 投影成一只工具,
 *                   于是资源级的「做」复用 `core/toolkit` 的 `ToolRunner`,
 *                   **没有第二条管线**;
 *   · `events.ts`   「看」:一张内存监听表 + 前缀判据(接总线是 K2);
 *   · `kernel.ts`   非 AI 调用方(RPC / 调度 / 测试)进那条管线的门;
 *   · `errors.ts`   运行期会说的几句「不」(登记期的那一族在 `contract.ts`)。
 *
 * K3-a 补了 §4「AI 工具」那一行的第二半句:
 *   · `meta-tool.ts` 元工具 `resources` —— 列命名空间 / 描述一个命名空间。它不是
 *                    任何一份自述的投影,所以它是一只普通 `Tool`,手里拿着注册表。
 *
 * K2a 补了一件 K1 明说留账的东西(`errors.ts` 头注释的最后一段):
 *   · `validator.ts` 认得生成 schema 的 `PartialValidator` —— 未知 op / 形不对从
 *                    `failed` 改判 `invalid`,而**不是**在内核里给 plan 开一个能返回
 *                    `Outcome` 的后门。
 *
 * K2c-2 给**读**修了一条自己的路(原子方案对读的一次修正):
 *   · `read-outcome.ts` 读的结局(`ok` 装的是**值**,不是文本);
 *                    `ResourceKernel.read` 不再走 `ToolRunner` —— 输出预算、
 *                    `Result` 只装文本、每读一次落一条审计,三样对界面全是错的。
 *                    「做」那一半一个字没动。
 *
 * 出口是 K2–K4,都不在这里。零依赖、零 node 导入、**零 scheme 名** ——
 * 内核不认识任何一个具体的命名空间 —— 会话、文件、音乐、邮件,一个都不认识
 * (§2 不变量 3)。这一条由
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
  StateScope,
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

export { planFromSpec } from './provider.js'
export type { ResourceProvider, ResourceReadContext } from './provider.js'

export {
  RESOURCE_OP_KEY,
  RESOURCE_READ_KEY,
  RESOURCE_REF_KEY,
  toolDescriptionOf,
  toolEffectsOf,
  toolInputSchemaOf,
} from './schema.js'

export { assertWithinOpEffects, ResourceTool } from './tool.js'
export type { ResourceCall, ResourceToolOptions, ShellDispatch } from './tool.js'

export {
  RESOURCE_META_TOOL_ID,
  ResourceMetaCallShapeError,
  ResourceMetaTool,
} from './meta-tool.js'
export type { ResourceMetaCall } from './meta-tool.js'

export { ResourceEventHub } from './events.js'
export type { ResourceEvent, ResourceEventListener } from './events.js'

export { NO_ORIGIN_SESSION, ResourceKernel } from './kernel.js'
export type { ReadGuard, ReadVerdict, ResourceCallOptions, ResourceKernelOptions } from './kernel.js'

export { ReadOutcome } from './read-outcome.js'

export {
  describeResourceRefProblem,
  describeUnknownResourceReadProblem,
  ResourceInputValidator,
} from './validator.js'

export {
  ResourceCallShapeError,
  ResourceEffectViolationError,
  ResourceHomeUnavailableError,
  ResourceOpUnavailableError,
  ResourceOpUnknownError,
  ResourceReadUnknownError,
  ResourceRefError,
  ResourceSchemeUnknownError,
  ResourceWatchPrefixError,
} from './errors.js'
