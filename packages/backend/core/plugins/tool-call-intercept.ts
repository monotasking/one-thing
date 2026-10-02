/**
 * N4 —— tool_call 拦截 + 参数改写的**协议层**
 * (docs/design/pi-benchmark-adoption-2026-08.md)。
 *
 * 这是第二个**干预型**钩子,与 N2(`input-intercept.ts`)结构同构、失败语义
 * **相反**。同构的部分不再重复论证(专用注册方法而非裸 string 订阅、全局规范
 * 顺序、逐 handler 超时、按 hookId 记连败而按 surface 降级),那一份论证在
 * `input-intercept.ts` 的文件头。这里只写**不一样的那半边**。
 *
 * ## 为什么失败语义必须反过来
 *
 * 判据只有一条:**这条链失败时,宿主的默认动作是什么**。
 *
 *  - N2 挂在"用户按下回车"与"消息出现"之间。默认动作 = 把用户打的字发出去。
 *    那是一个无害动作,所以插件坏了就当它没说话(fail-open):一个坏插件能让
 *    人发不出消息,那是应用坏了,不是插件坏了。
 *  - N4 挂在"模型要求调用工具"与"工具真的跑起来"之间。默认动作 =
 *    **执行一个可能带副作用的工具**(删文件、发请求、跑命令)。当一个声称
 *    "我来判断这次调用该不该跑"的钩子自己挂了,我们**不知道**它会不会放行,
 *    而未知 + 有副作用 = 不执行。所以 fail-**closed**。
 *
 * ## "单次 fail-closed、熔断后 fail-open"——本期的心脏
 *
 * 纯 fail-closed 有一个显然的坏结局:一个永远抛错的插件会让**所有工具**永远
 * 跑不起来,应用瘫痪,而用户完全不知道是谁干的。纯 fail-open 又让这条钩子在
 * 最需要它的时候(插件正在被攻击 / 正在崩)失效。
 *
 * 我们取的是两段式:
 *
 *  1. **单次故障 → 挡这一次**。handler 抛错 / 超时 / 返回值读不懂 / 改写后
 *     参数非法 —— 这一次调用被阻断,阻断理由如实写"拦截器故障",作为工具错误
 *     结果回给模型。模型看得到、用户看得到、日志点得到名。
 *  2. **该插件整体熔断 → 之后放行**。连败到阈值后,严重度表判 degrade-surface,
 *     这个插件的**拦截面**被停掉;链在入口处跳过它,于是它不再参与判定 ——
 *     "降级 = 移除拦截",不是"降级 = 永远挡着"。
 *
 * 于是"坏插件会挡工具"这个代价被**限在连败阈值内**(默认 3 次):它挡得住三次
 * 调用,挡不住第四次,也挡不住别的插件的判定。安全(坏了先别执行)与可用
 * (坏了不能瘫痪应用)在时间轴上分了先后,而不是二选一。
 *
 * 半开恢复照旧靠时间(`PLUGIN_SURFACE_PROBE_INTERVAL_MS`):拦截不走请求通道,
 * 没有"用户点重试"这种逃生口,被跳过的插件永远不会有一次成功可记。
 *
 * ## 与 pi 的关键差异:**改写后的参数要过工具既有的校验**
 *
 * pi 的 tool_call 钩子改完 input 直接喂给工具,跳过 schema 校验。我们不跳:
 * 改写结果先过工具自己的参数校验(内置工具 = 注册时那份 zod),**校验不过 =
 * 当作 block**(理由里说清是校验失败),绝不把非法参数喂进去。
 *
 * 理由不是洁癖:工具的 handler 是按"参数已经过 zod"写的,少一个必填字段在
 * 里面就是一次 `undefined.something`,或者更糟 —— 一个被当成 `"undefined"`
 * 字符串拼进 shell 的路径。让一个改写钩子获得绕过校验的能力,等于让插件能
 * 构造出模型自己构造不出来的调用。**入口严、内部宽**,与 N3 同一条规矩。
 */

import { sortByPluginCanonicalOrder } from './canonical-order.js'
import { toLogger, type CompatLogger, type Logger } from '../logging/index.js'
import { PLUGIN_TOOL_CALL_INTERCEPT_SURFACE } from './policy.js'
import { runWithPluginTimeout } from './runtime-guard.js'
import {
  PLUGIN_PERMISSION_TOOLCALL_INTERCEPT,
  PLUGIN_TOOLCALL_INTERCEPT_PERMISSION_NOTE,
} from './sessions.js'

/* ── 声明门 ───────────────────────────────────────────────────────────────── */

/**
 * `toolcall:intercept` 与它的披露文案定义在 `sessions.ts`(零依赖叶子,同时是
 * 插件权限词汇表 + 装前披露口径,渲染层按子路径直接引它)。这里原样再导出,
 * 读拦截代码的人不必跳文件 —— 与 N2 同规。
 */
export { PLUGIN_PERMISSION_TOOLCALL_INTERCEPT, PLUGIN_TOOLCALL_INTERCEPT_PERMISSION_NOTE }

/* ── 预算 ─────────────────────────────────────────────────────────────────── */

/**
 * 单个 handler 的超时预算。
 *
 * 2s,**高于** N2 的 1.5s、**远低于**生命周期钩子的 5s。三个数字的位置各有理由:
 * 这条链挂在工具执行前,用户此刻在看一个"正在执行"的转圈,比空白输入框耐受度高
 * 一点(所以可以比 N2 宽);但它是**同步阻塞**在一次真实副作用之前,每一个工具
 * 调用都要付这笔钱(所以远不能到 5s)。
 *
 * 与 N2 一样是**逐 handler**的,链本身不设总预算:设了就要回答"总预算用完时
 * 后半条链算放行还是算阻断",而在 fail-closed 这一侧那个答案会把总超时变成
 * 一把随机的闸刀。
 */
export const CORE_PLUGIN_TOOL_CALL_INTERCEPT_TIMEOUT_MS = 2_000

/** 熔断降级时停掉的界面名(policy.ts 的 describePluginSurface 产出同一个串)。 */
export { PLUGIN_TOOL_CALL_INTERCEPT_SURFACE }

/* ── 契约 ─────────────────────────────────────────────────────────────────── */

export interface PluginToolCallInterceptContext {
  sessionId: string
  /** 工具名(内置工具是它的 id,MCP 工具是带服务器前缀的引用名)。 */
  toolName: string
  /** 本次调用的参数。链式累积:后手看到的是前手改写后的结果。 */
  input: unknown
  /**
   * 本次调用的 id。**可选**是诚实而不是偷懒:宿主的执行上下文里它本来就是
   * 可选字段(某些内部直调路径不铸 id),现造一个假 id 会让"按 toolCallId
   * 归因"的插件拿到一个对不上任何东西的串。
   */
  toolCallId?: string
}

/**
 * 三态。`void` / `undefined` 等价于 `allow` —— 一个只想旁观的 handler 不必写
 * return(与 N2、与 pi 的姿态一致)。
 *
 * 注意 `void = allow` 是这条 fail-closed 链上**唯一**的隐式放行:除了"什么都
 * 没返回"这一种被明文定义的沉默,任何读不懂的返回值都判阻断(见
 * `normalizePluginToolCallInterceptResult`)。
 */
export type PluginToolCallInterceptDecision =
  /** 不干预,交给下一个 handler(或宿主)。 */
  | { action: 'allow' }
  /**
   * 阻断。`reason` 会作为**该工具的错误结果**(isError)回给模型 —— 与工具
   * 自己抛错同一条路,模型可以据此改道。所以它该写成一句给模型看的话。
   */
  | { action: 'block'; reason?: string }
  /**
   * 改写入参。后续 handler 看到的是改写后的结果;改写结果必须**过工具既有的
   * 参数校验**,过不了当作 block。
   */
  | { action: 'rewrite'; input: unknown }

export type PluginToolCallInterceptResult =
  | PluginToolCallInterceptDecision
  | void
  | undefined

export type PluginToolCallInterceptHandler = (
  context: PluginToolCallInterceptContext,
) => Promise<PluginToolCallInterceptResult> | PluginToolCallInterceptResult

/** 合法动作名的枚举 —— 未知值不静默,见 `normalizePluginToolCallInterceptResult`。 */
export const PLUGIN_TOOL_CALL_INTERCEPT_ACTIONS = ['allow', 'block', 'rewrite'] as const

export type PluginToolCallInterceptAction = (typeof PLUGIN_TOOL_CALL_INTERCEPT_ACTIONS)[number]

export interface NormalizedPluginToolCallInterceptResult {
  decision: PluginToolCallInterceptDecision
  /**
   * 返回值不合规时的人话说明。**不为空 = 作者写错了**,宿主报一条 error 日志。
   *
   * 与 N2 的同名字段有一处关键差异:在 N2 那边不合规**回落到 continue**
   * (fail-open),在这里不合规**回落到 block**(fail-closed)。判据还是那一条 ——
   * 我们读不懂这个拦截器的答复,而默认动作是执行一个有副作用的工具。
   */
  problem?: string
}

const ALLOW: PluginToolCallInterceptDecision = { action: 'allow' }

function blockedByMalformedResult(problem: string): NormalizedPluginToolCallInterceptResult {
  return {
    decision: {
      action: 'block',
      reason: `its tool-call interceptor returned something the host cannot read (${problem}); `
        + 'the call was blocked instead of guessed at',
    },
    problem,
  }
}

/**
 * 把 handler 的任意返回值收敛成一个三态判决(纯函数,两侧共用)。
 *
 * 只有**明文定义的沉默**(`undefined` / `null` / `{action:'allow'}`)算放行;
 * 其余一切读不懂的形状都判阻断并带上 `problem`。
 *
 * 为什么 `{action:'rewrite'}` 少了 `input` 不能降级成 allow:那正是最危险的
 * 一种笔误 —— 作者的意图是"把参数换掉再跑",降级成 allow 会**原样执行他想
 * 换掉的那个调用**。读不懂就别跑,是这条链存在的全部理由。
 */
export function normalizePluginToolCallInterceptResult(
  raw: unknown,
): NormalizedPluginToolCallInterceptResult {
  if (raw === undefined || raw === null) return { decision: ALLOW }
  if (typeof raw !== 'object') {
    return blockedByMalformedResult(`expected an object or undefined, got ${typeof raw}`)
  }
  const action = (raw as { action?: unknown }).action
  if (action === undefined) {
    return blockedByMalformedResult('missing "action"')
  }
  if (action === 'allow') return { decision: ALLOW }
  if (action === 'block') {
    const reason = (raw as { reason?: unknown }).reason
    if (reason === undefined || reason === null) return { decision: { action: 'block' } }
    if (typeof reason !== 'string') {
      return {
        decision: { action: 'block' },
        problem: '{action:"block"} "reason" must be a string; it was dropped',
      }
    }
    return { decision: { action: 'block', reason } }
  }
  if (action === 'rewrite') {
    const input = (raw as { input?: unknown }).input
    if (input === undefined) {
      return blockedByMalformedResult('{action:"rewrite"} needs an "input"')
    }
    // 结构闸,与 schema 校验是两件事:工具入参在这个系统里恒定是一个 JSON
    // 对象(注册面就是 `z.object`),数组 / 标量 / null 连送去 safeParse 的
    // 资格都没有。这一关在 core 里判,不依赖宿主是否接了校验口。
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return blockedByMalformedResult(
        `{action:"rewrite"} "input" must be a JSON object, got ${Array.isArray(input) ? 'an array' : typeof input}`,
      )
    }
    return { decision: { action: 'rewrite', input } }
  }
  return blockedByMalformedResult(
    `unknown action "${String(action)}" — expected one of `
    + PLUGIN_TOOL_CALL_INTERCEPT_ACTIONS.join(' | '),
  )
}

/* ── 改写后的参数校验 ─────────────────────────────────────────────────────── */

/**
 * 校验口的答复。`ok:false` = 当作 block(理由里说清是校验失败)。
 *
 * 宿主不接这个口时(纯 core 场景 / 单测)链**跳过 schema 校验**,只保留上面
 * 那道结构闸。这不是一个漏洞:生产装配层永远接(见
 * `app/plugins/tool-call-intercept.ts`),而在 core 里凭空造一份 zod 依赖
 * 才是真的错 —— core 禁 zod。
 */
export type PluginToolCallInputValidation =
  | { ok: true }
  | { ok: false; message: string }

export type PluginToolCallInputValidator = (
  toolName: string,
  input: object,
) => PluginToolCallInputValidation | Promise<PluginToolCallInputValidation>

/* ── 链的结果 ─────────────────────────────────────────────────────────────── */

export type PluginToolCallInterceptOutcome =
  | {
      action: 'allow'
      /** 走完链之后的参数(累积了所有 rewrite;无人改写时是入参本身)。 */
      input: unknown
      /** 改写过参数的插件 id(按发生顺序)。 */
      rewrittenBy: string[]
      /** 实际跑过的 handler 数 —— 熔断跳过 / 未注册时为 0(诊断用)。 */
      ran: number
    }
  | {
      action: 'block'
      /** 已经格式化好的、给模型看的一句话(含归因)。 */
      reason: string
      /** 阻断者。故障阻断时也是它 —— 阻断永远可归因。 */
      blockedBy: string
      ran: number
    }

export function emptyPluginToolCallInterceptOutcome(
  input: unknown,
): PluginToolCallInterceptOutcome {
  return { action: 'allow', input, rewrittenBy: [], ran: 0 }
}

/**
 * 阻断理由的统一措辞。**归因写在最前面**:这句话会原样出现在模型的工具结果里,
 * 而模型接下来大概率会把它转述给用户 —— "谁挡的"必须比"为什么"更早出现,
 * 否则用户会以为是工具坏了。
 */
export function formatPluginToolCallBlockReason(
  pluginId: string,
  reason: string | undefined,
): string {
  const detail = reason?.trim()
  return detail
    ? `Blocked by plugin "${pluginId}": ${detail}`
    : `Blocked by plugin "${pluginId}" (no reason given).`
}

/** 故障阻断(fail-closed)的措辞 —— 它与"插件主动否决"必须一眼分得开。 */
export function formatPluginToolCallFailureReason(pluginId: string, detail: string): string {
  return formatPluginToolCallBlockReason(
    pluginId,
    `${detail} This is an interceptor fault, not a policy decision — the tool was not run `
    + 'because the host could not confirm the call was allowed (fail-closed).',
  )
}

/* ── 注册表 ───────────────────────────────────────────────────────────────── */

interface RegisteredToolCallInterceptor {
  pluginId: string
  hookId: string
  handler: PluginToolCallInterceptHandler
}

/** @deprecated 统一为 `Logger`(§8.3 区 ①);过渡期仍收老鸭子形状。 */
export type CorePluginToolCallInterceptLogger = CompatLogger

export interface CorePluginToolCallInterceptRegistryOptions {
  logger?: CorePluginToolCallInterceptLogger
  /** 逐 handler 超时预算;<=0 关闭超时。缺省 CORE_PLUGIN_TOOL_CALL_INTERCEPT_TIMEOUT_MS。 */
  timeoutMs?: number
  /**
   * 改写后的参数校验口(宿主注入)。不接 = 跳过 schema 校验,只保留结构闸。
   */
  validateInput?: PluginToolCallInputValidator
  /**
   * 抛错 / 超时 / 返回值读不懂 / 改写非法时回调,供熔断计数。
   *
   * **与 N2 的一条刻意差异**:N2 把"返回值不合规"当作者笔误、不计熔断;
   * 这里计。理由是 fail-closed 下"不计熔断"等于"永远挡着" —— 一个每次都
   * 返回垃圾的插件会把所有工具永久挡死,而熔断正是这条链唯一的逃生口。
   * 计了之后,它挡三次就被降级掉,第四次起放行。
   */
  onHandlerFailure?(input: { pluginId: string; hookId: string; error: unknown }): void
  /** 成功跑完(无论判决是哪一态)时回调,清同车道的连败账。 */
  onHandlerSuccess?(input: { pluginId: string; hookId: string }): void
  /**
   * 熔断降级闸:返回 true 表示**跳过**这个插件的拦截。
   *
   * 跳过 = 放行(fail-open)。这正是"单次 fail-closed、熔断后 fail-open"的
   * 后半句 —— 降级的语义是**移除这道拦截**,不是"永远挡着"。
   */
  isDegraded?(pluginId: string): boolean
  /** 重复 id / 非法 id 这类注册期违规的上报口(归 registration 族)。 */
  onRegistrationViolation?(input: { pluginId: string; hookId: string; reason: string }): void
}

/**
 * 工具执行前拦截链。
 *
 * 次序 = **全局规范顺序**(跨插件按 pluginId 字典序,插件内保持注册顺序),
 * 与 N2 同一个出处:目录发现序会让同一套插件在两台机器上排出两种结果,
 * 而这里的次序直接决定"谁先改写、谁先否决"。
 */
export class CorePluginToolCallInterceptRegistry {
  private readonly handlers = new Map<string, RegisteredToolCallInterceptor>()
  private readonly logger: Logger

  constructor(private readonly options: CorePluginToolCallInterceptRegistryOptions = {}) {
    this.logger = toLogger(options.logger)
  }

  /**
   * 注册。返回退订函数;**重复的 (pluginId, hookId) 被拒绝**并返回一个 no-op ——
   * 让第二个悄悄顶掉第一个的话,作者看到的是"我的第一条守卫不生效了",而在
   * 一条安全链上,一条不生效的守卫比没有守卫更糟。
   */
  register(
    pluginId: string,
    hookId: string,
    handler: PluginToolCallInterceptHandler,
  ): () => void {
    const id = String(hookId ?? '').trim()
    if (!id) {
      this.violate(pluginId, hookId, 'interceptToolCall needs a non-empty id')
      return () => {}
    }
    const key = this.key(pluginId, id)
    if (this.handlers.has(key)) {
      this.violate(pluginId, id, `interceptToolCall id "${id}" is already registered`)
      return () => {}
    }
    this.handlers.set(key, { pluginId, hookId: id, handler })
    return () => {
      this.handlers.delete(key)
    }
  }

  /**
   * 跑一遍链。**从不抛错** —— 最坏情况是返回一个 block 判决。
   *
   * 注意"从不抛错"在这里的含义与 N2 相反:那边最坏是原样放行,这边最坏是
   * 原地阻断。两边一致的只有"调用方永远不用写 try/catch"。
   */
  async run(
    context: PluginToolCallInterceptContext,
  ): Promise<PluginToolCallInterceptOutcome> {
    const ordered = sortByPluginCanonicalOrder([...this.handlers.values()], item => item.pluginId)
    if (ordered.length === 0) return emptyPluginToolCallInterceptOutcome(context.input)

    const timeoutMs = this.options.timeoutMs ?? CORE_PLUGIN_TOOL_CALL_INTERCEPT_TIMEOUT_MS
    let input = context.input
    const rewrittenBy: string[] = []
    let ran = 0

    for (const item of ordered) {
      // 熔断后 fail-open:这个插件的拦截面已被降级,链直接跳过它。
      if (this.options.isDegraded?.(item.pluginId)) continue
      const label = `${item.pluginId}/${item.hookId}`
      let raw: unknown
      try {
        raw = await runWithPluginTimeout(
          `toolCallIntercept:${label}`,
          timeoutMs,
          () => item.handler({
            sessionId: context.sessionId,
            toolName: context.toolName,
            toolCallId: context.toolCallId,
            input,
          }),
        )
      } catch (error) {
        // fail-closed:抛错 / 超时 = 阻断这一次。不是放行。
        this.logger.error(
          `[PluginToolCallIntercept] "${label}" failed; the tool call was blocked (fail-closed):`,
          undefined, error,
        )
        this.options.onHandlerFailure?.({ pluginId: item.pluginId, hookId: item.hookId, error })
        return {
          action: 'block',
          reason: formatPluginToolCallFailureReason(
            item.pluginId,
            error instanceof Error ? error.message : String(error),
          ),
          blockedBy: item.pluginId,
          ran,
        }
      }
      ran += 1

      const { decision, problem } = normalizePluginToolCallInterceptResult(raw)
      if (problem) {
        this.logger.error(
          `[PluginToolCallIntercept] "${label}" returned an invalid result: ${problem}`,
        )
      }

      if (decision.action === 'block') {
        // 读不懂的返回值也走这里(normalize 把它折成 block)。区别只在计不计
        // 熔断:真判决算这个 handler 跑成功了,读不懂算它坏了。
        if (problem) {
          this.options.onHandlerFailure?.({
            pluginId: item.pluginId,
            hookId: item.hookId,
            error: new Error(problem),
          })
        } else {
          this.options.onHandlerSuccess?.({ pluginId: item.pluginId, hookId: item.hookId })
        }
        return {
          action: 'block',
          reason: formatPluginToolCallBlockReason(item.pluginId, decision.reason),
          blockedBy: item.pluginId,
          ran,
        }
      }

      if (decision.action === 'rewrite') {
        // 与 pi 的关键差异:改写后先过工具既有的参数校验,过不了当作 block。
        let validation: PluginToolCallInputValidation = { ok: true }
        if (this.options.validateInput) {
          try {
            validation = await this.options.validateInput(context.toolName, decision.input as object)
          } catch (error) {
            // 校验口自己炸了,同样是"无法确认这次调用是安全的"。
            validation = {
              ok: false,
              message: error instanceof Error ? error.message : String(error),
            }
          }
        }
        if (!validation.ok) {
          this.logger.error(
            `[PluginToolCallIntercept] "${label}" rewrote ${context.toolName} into arguments that `
            + `fail the tool's own validation: ${validation.message}`,
          )
          this.options.onHandlerFailure?.({
            pluginId: item.pluginId,
            hookId: item.hookId,
            error: new Error(validation.message),
          })
          return {
            action: 'block',
            reason: formatPluginToolCallBlockReason(
              item.pluginId,
              `it rewrote the arguments of "${context.toolName}" into a shape the tool rejects `
              + `(${validation.message}); the original call was NOT run either, because the `
              + 'rewrite means the plugin did not want it to run as written',
            ),
            blockedBy: item.pluginId,
            ran,
          }
        }
        this.options.onHandlerSuccess?.({ pluginId: item.pluginId, hookId: item.hookId })
        input = decision.input
        rewrittenBy.push(item.pluginId)
        continue
      }

      this.options.onHandlerSuccess?.({ pluginId: item.pluginId, hookId: item.hookId })
    }

    return { action: 'allow', input, rewrittenBy, ran }
  }

  clearForPlugin(pluginId: string): void {
    for (const [key, item] of [...this.handlers]) {
      if (item.pluginId === pluginId) this.handlers.delete(key)
    }
  }

  clear(): void {
    this.handlers.clear()
  }

  /** 拆除守卫用:注册表足迹在启停前后必须回到原样。 */
  getHookCount(): number {
    return this.handlers.size
  }

  /** 诊断用:当前链的顺序(与 run 逐字一致)。 */
  listOrdered(): Array<{ pluginId: string; hookId: string }> {
    return sortByPluginCanonicalOrder([...this.handlers.values()], item => item.pluginId)
      .map(({ pluginId, hookId }) => ({ pluginId, hookId }))
  }

  private violate(pluginId: string, hookId: string, reason: string): void {
    this.logger.error(`[PluginToolCallIntercept] ${pluginId}: ${reason}`)
    this.options.onRegistrationViolation?.({ pluginId, hookId: String(hookId ?? ''), reason })
  }

  private key(pluginId: string, hookId: string): string {
    return `${pluginId}:${hookId}`
  }
}
