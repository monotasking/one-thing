/**
 * K1 —— `ResourceTool`:把一个 scheme 投影成**一只** `Tool`
 * (`docs/design/atom-2026-09.md` §9 K1「一条管线」、§4「所有出口都是投影」)。
 *
 * K1 的整句话就是这只文件的存在理由:**「做」只有一条管线,不新造第二条。**
 * 资源级的读与做复用 `core/toolkit` 的 `ToolRunner`
 * (intercept → validate → plan → assertWithinDeclaredEffects → authorize → apply →
 * budget),办法是把每个 scheme 投影成一个 `Tool`。于是 AI 调它、界面调它、脚本
 * 调它走的是**同一个 `ToolRunner.run`** —— 授权、审计、预算、取消四样自然同源,
 * 而不是四份需要互相对表的实现。
 *
 * ── 为什么是「一个 scheme 一只工具」,不是「一条做法一只工具」 ──────────────
 * 一条做法一只工具会让工具面随资源数量线性膨胀(一个邮箱四条做法就是四只工具),
 * 而模型的工具面是有预算的;更要命的是「这个命名空间能做什么」会散成 N 条互不
 * 相关的描述。一个 scheme 一只工具 + `oneOf` 可辨识联合(`schema.ts`),模型看到
 * 的是一个有名字的命名空间和它的动作表 —— 与人在命令面板里看到的是同一份东西。
 *
 * ── 两道效果检查,一道都不能少 ─────────────────────────────────────────────
 * `ToolRunner` 的 `assertWithinDeclaredEffects` 查的是 `spec.effects`,而这只工具的
 * `spec.effects` 是**全部做法的并集**(`toolEffectsOf`)。所以它只挡得住「这个
 * scheme 从没声明过的效果」。每条做法自己的上界必须在这里补查一次 —— 见
 * `errors.ts` 的 `ResourceEffectViolationError`。
 *
 * ── 这只工具自己不认识任何 scheme ──────────────────────────────────────────
 * 它读的全部是 `provider.spec`。`__tests__/stranger.test.ts` 扫本目录,发现任何
 * 具体 scheme 的名字就红 —— 那是 §2 不变量 3 的门。
 */

import { Intent } from '../toolkit/intent.js'
import { textResult, type Result } from '../toolkit/result.js'
import type { PlanContext, RunContext } from '../toolkit/run-context.js'
import { Tool } from '../toolkit/tool.js'
import type { Scene, ToolSpec } from '../toolkit/spec.js'
import {
  ResourceCallShapeError,
  ResourceEffectViolationError,
  ResourceHomeUnavailableError,
  ResourceOpUnavailableError,
  ResourceOpUnknownError,
  ResourceReadUnknownError,
  ResourceRefError,
} from './errors.js'
import type { ResourceProvider } from './provider.js'
import { parseRef, type ResourceRef } from './ref.js'
import { describeUnknownResourceReadProblem } from './validator.js'
import {
  RESOURCE_OP_KEY,
  RESOURCE_READ_KEY,
  RESOURCE_REF_KEY,
  toolDescriptionOf,
  toolEffectsOf,
  toolInputSchemaOf,
} from './schema.js'
import type { OpSpec } from './spec.js'

/**
 * 壳派发端口(§5「位置:资源住在哪、谁跑」)。
 *
 * `home: 'shell'` 的做法在 core 里走完校验与授权,`apply` 那一步经这个端口发给
 * 托管这条会话的壳。**授权永远在 core 里做**,壳只执行 —— 这与「宿主不判权限」
 * 那条既有裁定是同一句话。
 *
 * K1 只有接口和「缺席即结构化降级」这条路径,没有实现(那是 K2 的 `app:command`
 * 通道)。它现在就存在,是因为「没有壳时会发生什么」是一条要被测试钉住的行为,
 * 而不是一个等实现来了再想的问题。
 */
export interface ShellDispatch {
  run(op: string, ref: ResourceRef | null, params: unknown, ctx: RunContext): Promise<Result>
}

export interface ResourceToolOptions {
  readonly shell?: ShellDispatch
}

/** `plan` 交给 `apply` 的载荷:这次调用到底是哪一支。 */
export type ResourceCall<Payload> =
  | { readonly kind: 'read'; readonly name: string; readonly ref: ResourceRef | null; readonly query: unknown }
  | {
      readonly kind: 'op'
      readonly op: string
      readonly ref: ResourceRef | null
      readonly params: unknown
      readonly home: OpSpec['home']
      /** provider 自己那份计划。授权结论会在 `apply` 里贴回它身上。 */
      readonly intent: Intent<Payload>
    }

function own<T>(table: Readonly<Record<string, T>>, name: string): T | undefined {
  // 只查自己身上有的键:op 名直接来自模型的工具参数与 deeplink,裸下标会从
  // `Object.prototype` 上摸到 `toString` 并当成一条做法交出去(同 `registry.ts`)。
  return Object.prototype.hasOwnProperty.call(table, name) ? table[name] : undefined
}

function stringField(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

/** 摘掉判别字段与地址字段,剩下的就是这条做法 / 读法自己的参数。 */
function payloadFields(input: unknown, discriminator: string): Record<string, unknown> {
  if (!input || typeof input !== 'object') return {}
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (key === discriminator || key === RESOURCE_REF_KEY) continue
    rest[key] = value
  }
  return rest
}

export class ResourceTool<Payload = unknown> extends Tool<unknown, ResourceCall<Payload>> {
  readonly spec: ToolSpec
  readonly provider: ResourceProvider<Payload>
  private readonly shell?: ShellDispatch

  constructor(provider: ResourceProvider<Payload>, options: ResourceToolOptions = {}) {
    super()
    this.provider = provider
    if (options.shell) this.shell = options.shell
    const spec = provider.spec
    this.spec = {
      // **工具 id 就是 scheme**。地址的左半边与工具名是同一个字符串,于是脚本那条
      // `do('<scheme>:x', 'rename')` 与模型那条 `<scheme>({op:'rename', ref:'<scheme>:x'})`
      // 在审计账本里看得出是同一件事,不必再维护一张「工具名 ↔ 命名空间」的对照表。
      id: spec.scheme,
      title: spec.title,
      description: toolDescriptionOf(spec),
      input: toolInputSchemaOf(spec),
      effects: toolEffectsOf(spec),
      presentation: { kind: 'text', shell: 'default' },
      // 资源上的做法会改同一份状态(连着两条重命名),所以恒串行。等某种资源真的
      // 证明得了自己的做法两两无关时,再由那份自述自己说 —— 不在这里开天窗。
      concurrency: 'sequential',
      /*
       * K3-a —— 这只工具是**一份自述的投影**,不是一件独立注册的工具。
       *
       * 它只影响一个出口:「这台宿主注册了哪些工具」那份清单(设置页 / CLI
       * `listTools`)不列它,因为资源的呈现归应用登记表。**回合面不受影响** ——
       * 模型照常看得见(露面规则见 `docs/design/atom-2026-09.md` §10.4)。
       * 完整理由写在 `../toolkit/spec.ts` 的 `ToolSpec.projection` 上。
       */
      projection: 'resource',
    }
  }

  visibleIn(scene: Scene): boolean {
    return this.provider.visibleIn?.(scene) ?? true
  }

  async plan(input: unknown, ctx: PlanContext): Promise<Intent<ResourceCall<Payload>>> {
    const read = stringField(input, RESOURCE_READ_KEY)
    const ref = this.resolveRef(input)

    if (read !== undefined) {
      // 读法名的判据与 `ResourceKernel.read` 共用**同一只函数**(K2c-2):模型这条
      // 路上它通常已经被 `Validator` 判过一次,但那位校验者是宿主注入的端口 ——
      // 没配它的宿主上,「点了一条不存在的读法」从前要等到 provider 里才被发现,
      // 而每个 provider 各写一句自己的措辞。判据只有一处,措辞因此也只有一句。
      const problem = describeUnknownResourceReadProblem(this.provider.spec, read)
      if (problem) throw new ResourceReadUnknownError(this.provider.spec.scheme, read, problem)
      // **读无效果,结构性成立**:这一支永远造 `Intent.none`,连一条 `read` 效果
      // 都不报。授权者因此恒静默放行,而拦截 / 预算 / 审计照旧走完。
      return Intent.none<ResourceCall<Payload>>({
        kind: 'read',
        name: read,
        ref,
        query: payloadFields(input, RESOURCE_READ_KEY),
      })
    }

    const op = stringField(input, RESOURCE_OP_KEY)
    const scheme = this.provider.spec.scheme
    if (op === undefined) throw new ResourceCallShapeError(scheme)

    const declared = own(this.provider.spec.ops, op)
    if (!declared) throw new ResourceOpUnknownError(scheme, op)

    if (declared.when && !declared.when({ sessionId: ctx.invocation.sessionId })) {
      throw new ResourceOpUnavailableError(scheme, op)
    }
    // 派发端口缺席在 **plan** 期就判,不等到 apply:一次注定跑不了的做法不该先去
    // 弹一张权限卡问人。
    if (declared.home === 'shell' && !this.shell) {
      throw new ResourceHomeUnavailableError(scheme, op, declared.home)
    }

    const params = payloadFields(input, RESOURCE_OP_KEY)
    const planned = await this.provider.plan(op, ref, params, ctx)
    assertWithinOpEffects(scheme, op, declared, planned)

    const call: ResourceCall<Payload> = { kind: 'op', op, ref, params, home: declared.home, intent: planned }
    return Intent.of({
      // 效果与预览**原样上抬**:授权者看到的必须是 provider 报的那一份具体效果
      // (带资源),而不是从静态上界重新造的一份。
      effects: planned.effects,
      ...(planned.preview ? { preview: planned.preview } : {}),
      ...(planned.alwaysAsk ? { alwaysAsk: true } : {}),
      payload: call,
    })
  }

  async apply(intent: Intent<ResourceCall<Payload>>, ctx: RunContext): Promise<Result> {
    const call = intent.payload

    if (call.kind === 'read') {
      const value = await this.provider.read(call.name, call.ref, call.query, {
        principal: ctx.principal,
        sessionId: ctx.invocation.sessionId,
        signal: ctx.abort.signal,
        // 两格从 `RunContext` 原样转手(K2c-2):实现看到的读上下文,两条路上是同一
        // 份东西 —— 一条按沙箱收窄的读法,不该因为是模型问的就换一把尺子。
        ...(ctx.sandbox ? { sandbox: ctx.sandbox } : {}),
        now: () => ctx.now(),
      })
      // 读的结果投影成文本 = JSON。**不往 `details` 里再塞一份**:那一格的类型是
      // `JsonObject`,而一条读法完全可以返回一个数组或一个标量 —— 为了填满一格
      // 而把返回值包一层,读账本的人就得先猜这层包装是谁加的。
      return textResult(jsonText(value))
    }

    if (call.home === 'shell') {
      const shell = this.shell
      // plan 期已经判过一次。这里再判,因为端口是构造参数而 plan 与 apply 之间隔着
      // 一次审批(人可能等了很久),而且 `apply` 是公开方法 —— 手搓一个 Intent 直接
      // 调它的调用方绕不过这一句。
      if (!shell) throw new ResourceHomeUnavailableError(this.provider.spec.scheme, call.op, call.home)
      return shell.run(call.op, call.ref, call.params, ctx)
    }

    // 把授权结论贴回 provider 自己那份计划:provider 的 `apply` 看到的
    // `intent.decision` 与一只普通 `Tool` 看到的逐字同义。
    const decided = intent.decision ? call.intent.approved(intent.decision) : call.intent
    return this.provider.apply(call.op, decided, ctx)
  }

  /**
   * 地址:没给就是 `null`(这一次说的是整个命名空间),给了就必须是**这一种资源**
   * 的合法地址。
   */
  private resolveRef(input: unknown): ResourceRef | null {
    const raw = stringField(input, RESOURCE_REF_KEY)
    if (raw === undefined) return null
    const scheme = this.provider.spec.scheme
    const parsed = parseRef(raw)
    if (!parsed) throw new ResourceRefError(scheme, raw, 'syntax')
    if (parsed.scheme !== scheme) throw new ResourceRefError(scheme, raw, 'scheme')
    return parsed
  }
}

/** 一条做法自己的效果上界。scheme 级的那一道在 `ToolRunner` 里,两道都要。 */
export function assertWithinOpEffects(
  scheme: string,
  op: string,
  declared: OpSpec,
  intent: Intent<unknown>,
): void {
  const allowed = new Set<string>(declared.effects)
  const violations = [...new Set(intent.effects.map(effect => effect.kind).filter(kind => !allowed.has(kind)))]
  if (violations.length > 0) throw new ResourceEffectViolationError(scheme, op, violations)
}

/**
 * 读的结果 → 文本。不可序列化的东西(循环引用、`BigInt`)不该把这次调用炸掉 ——
 * 那是一条读法自己写错了 `result` 契约,如实说出来比抛一个 `TypeError` 有用。
 */
function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value ?? null, null, 2) ?? String(value)
  } catch (error) {
    return `[unserializable result: ${error instanceof Error ? error.message : String(error)}]`
  }
}
