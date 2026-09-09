/**
 * K1 —— 实现侧的接口(`docs/design/atom-2026-09.md` §2 不变量 3:「谁提供一种资源,
 * 谁交一份 `ResourceSpec` + 一份实现」)。
 *
 * K0 交的是「自述」那一半 —— 纯数据,说这种资源有哪些读法、做法、事件。这只文件是
 * 另一半:**一个 scheme 一个 provider 对象**,自述挂在它身上,三个动词各是一个方法。
 * 面向对象的落点就在这里 —— 加一种资源 = 新写一个类,不是在内核里加一支 `switch`。
 *
 * ── 「做」为什么是两拍,而不是一个 `run(op, params)` ────────────────────────
 * 因为 §2 不变量 2 要的是「每一次做经过同一条管线」,而那条管线(`core/toolkit` 的
 * `ToolRunner`)的形状就是两拍:`plan` 说清楚将要做什么(具体到资源的效果 + 给人看
 * 的预览),授权发生在两拍之间,`apply` 才动手。一个 `run` 会把授权挤到实现里面 ——
 * 那正是「界面走 RPC、AI 走工具,两套权限两套审计」这条老病的形状。
 *
 * 所以 provider 的 `plan` / `apply` 与 `Tool` 的 `plan` / `apply` **是同一对方法**,
 * 只是多了一个 `op` 参数和一个 `ref`。`ResourceTool`(`tool.ts`)把 N 条做法折成一只
 * 工具,除此之外一个字都不翻译。
 *
 * ── `read` 为什么不进管线的两拍 ────────────────────────────────────────────
 * 读无效果(§2 不变量 1),这是**结构性**的:`ReadSpec` 里没有 effects 这一格,
 * `ResourceProvider.read` 也没有 plan 阶段。
 *
 * **同一只 `read` 有两个调用方**(K2c-2):模型那条路经 `ResourceTool` 走完整条
 * 管线(拦截 → 校验 → 授权 → 预算),plan 出来的 `Intent` 恒无效果、授权者恒静默
 * 放行,读到的值最后投影成一段文本;界面 / 脚本那条路经 `ResourceKernel.read`,
 * 短路径、拿到的是**值本身**、不落审计不吃预算(理由在 `read-outcome.ts` 的文件
 * 头)。实现这一侧对两者一视同仁 —— 它只管答,答给谁不是它的判据。
 */

import { Intent } from '../toolkit/intent.js'
import type { Result } from '../toolkit/result.js'
import type { PlanContext, RunContext } from '../toolkit/run-context.js'
import type { Scene } from '../toolkit/spec.js'
import type { SandboxPolicy } from '../toolkit/ports.js'
import type { Effect, EffectClass } from '../toolkit/effects.js'
import type { Principal } from '../permission/principal.js'
import { ResourceOpUnknownError } from './errors.js'
import type { ResourceEventHub } from './events.js'
import { formatRef, type ResourceRef } from './ref.js'
import type { ResourceSpec } from './spec.js'

/**
 * 一次读的上下文。**刻意比 `PlanContext` 窄**:读没有 plan 阶段,给它一个能生
 * 后台进程、能往观察流里写东西的上下文,等于把「读无效果」变成一句自觉。
 *
 * `sessionId` 是调用坐标(谁的回合里发生的),不是读的参数 —— 一条读法要按会话
 * 取数就自己从 ref 或 query 里拿,而不是偷偷读这一格。它在这里是为了让实现能做
 * 授权范围的收窄(`docs/design/search-index-2026-09.md` 那条「授权是查询输入」的
 * 同一个道理)。
 */
export interface ResourceReadContext {
  readonly principal: Principal
  readonly sessionId: string
  readonly signal: AbortSignal
  /**
   * 沙箱(K2c-2)。可选 —— 缺席 = 这台宿主没有沙箱这一格,不是「随便读」:
   * 一条要判越界的读法在缺席时该自己决定怎么退(结构化降级或拒绝),而不是把
   * `undefined` 当成放行。路径的解析与判定归宿主,内核既不认识 fs 也不认识仓库根
   * (`toolkit/ports.ts` 的 `SandboxPolicy` 那句话)。
   */
  readonly sandbox?: SandboxPolicy
  /** 现在几点。与 `PlanContext.now()` 同名同义 —— 实现不自己读 `Date.now()`。 */
  now(): number
}

/**
 * 一种资源的实现。
 *
 * 泛型 `Payload` 是 `plan` 交给 `apply` 的中间产物(算好的 diff、解析好的目标),
 * 对内核不透明 —— 与 `Intent<Payload>` 同一个位置、同一个理由。
 */
export interface ResourceProvider<Payload = unknown> {
  readonly spec: ResourceSpec

  /**
   * 读:纯查询。返回值会被投影成给模型看的文本(`tool.ts`),所以它该是可
   * `JSON.stringify` 的东西 —— 但内核不校验这一点,那是这条读法自己的 `result`
   * schema 说了算。
   *
   * `ref` 可以是 `null`:一条列举整个命名空间的读法(「列出收件箱」)没有实例地址。
   * 这一格与 `plan` 保持同形,不为读单开一种签名。
   */
  read(name: string, ref: ResourceRef | null, query: unknown, ctx: ResourceReadContext): Promise<unknown>

  /** 做的第一拍:产出 `Intent`(具体效果带资源、给人看的预览、给 apply 的载荷)。 */
  plan(op: string, ref: ResourceRef | null, params: unknown, ctx: PlanContext): Promise<Intent<Payload>>

  /** 做的第二拍:按已经被授权的计划动手。`home: 'shell'` 的做法不会走到这里。 */
  apply(op: string, intent: Intent<Payload>, ctx: RunContext): Promise<Result>

  /**
   * 这一 scheme 此刻露不露面。缺省 `true`(到处成立)—— 与 `Tool.visibleIn` 同义,
   * 场子判据留在产品层的 `resolveScene` 一处,这里只读结论。
   */
  visibleIn?(scene: Scene): boolean

  /**
   * 挂上事件总线。`ResourceKernel.mount` 在登记那一刻调它一次。
   *
   * 为什么是 `attach` 而不是塞进 `RunContext`:事件不只在 apply 里发(一条外部推来
   * 的变更、一次后台同步也要发),而 `RunContext` 只活在一次调用里。总线的寿命是
   * provider 的寿命,所以它在装配那一刻交接。
   */
  attach?(hub: ResourceEventHub): void
}

/**
 * 按 `OpSpec.effects` 造一条**顶格**的计划:每一类效果各一条,资源是这个地址。
 *
 * 给「效果与参数无关」的那批做法用(重命名、归档、播放)——它们的具体效果就等于
 * 静态上界,自己写一遍 `Intent.of` 只是把同一份清单抄第二遍。真正需要按参数分档
 * 的做法(读一个越界路径要报 `external_directory` 而不是 `read`)不该用它:那种
 * 判据只有实现知道,而这个辅助函数**不做任何判断**。
 *
 * 空 `effects` 出来的是一条零效果的 `Intent`(不打扰任何人,仍然落审计、仍然发事件)。
 */
export function planFromSpec<Payload>(
  spec: ResourceSpec,
  op: string,
  ref: ResourceRef | null,
  payload: Payload,
  preview?: { readonly title: string },
): Intent<Payload> {
  const declared = Object.prototype.hasOwnProperty.call(spec.ops, op) ? spec.ops[op] : undefined
  // 走到这里时 `ResourceTool.plan` 已经查过一次 op 在不在。仍然自己再查一遍:
  // 一个「按上界造效果」的辅助函数,拿不到上界时唯一诚实的答案是抛,不是造一条
  // 零效果的计划(那会是一次静默的免检)。
  if (!declared) throw new ResourceOpUnknownError(spec.scheme, op)
  const resources = ref ? [formatRef(ref)] : []
  const effects = declared.effects.map((kind: EffectClass): Effect => ({ kind, resources }))
  return Intent.of(preview ? { effects, payload, preview } : { effects, payload })
}
