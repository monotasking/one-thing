/**
 * N5 —— tool_result 改写的**协议层**
 * (docs/design/pi-benchmark-adoption-2026-08.md)。
 *
 * 这是第三个**干预型**钩子。它与 N4(`tool-call-intercept.ts`)是同一个函数
 * (`executeCoreDirectTool`)上一前一后的两道闸:N4 在工具执行**之前**拦调用,
 * N5 在工具执行**之后**改结果。结构同构(专用注册方法而非裸 string 订阅、全局
 * 规范顺序、逐 handler 超时、按 hookId 记连败而按 surface 降级),失败语义则
 * 回到 N2 那一侧 —— **fail-open**。同构的部分不再重复论证,这里只写不一样的半边。
 *
 * ## 为什么失败语义是 fail-open,而 N4 是 fail-closed —— 一对刻意的镜像
 *
 * 判据只有一条,与 N4 完全一样:**这条链失败时,宿主的默认动作是什么。**
 *
 *  - N4 挂在"模型要求调用工具"与"工具真的跑起来"之间。默认动作 = 执行一个可能
 *    带副作用的工具。当声称"我来判断这次调用该不该跑"的钩子自己挂了,未知 +
 *    有副作用 = **不执行**(fail-closed)。
 *  - N5 挂在"工具已经跑完、产出了一个结果"与"结果回给模型"之间。默认动作 =
 *    **把工具产出的原始结果原样交给模型**。当一个声称"我来脱敏 / 摘要 / 富化
 *    这个结果"的钩子挂了,最坏的后果只是"模型看到了未经改写的原始结果" ——
 *    工作流一步不断。**未知 + 无副作用(结果早已产生)= 放行原结果**(fail-open)。
 *
 * 两条钩子共用一个函数、一前一后,注释互相指认;而它们的失败语义正相反,是因为
 * "闸坏了默认会发生什么"这一件事正相反。N4 坏了挡工具(安全优先),N5 坏了放行
 * 原结果(可用优先)。把这对镜像写清楚,是为了让下一个改这两条链的人不会把
 * 其中一条的罚则抄到另一条上。
 *
 * ## 没有 block、没有短路 —— 只有"改写"
 *
 * N4 有 `block`:结果还没产生,可以否决。N5 没有 —— 结果已经产生,没有"拦截"
 * 可言,只有"改写"。于是三态塌成两态:`keep`(不干预)与 `replace`(改写文本 /
 * 翻转错误态)。多插件链式,`replace` 累积:后手 `ctx.result` 是前手改写后的
 * 结果。每一个 handler 都能改,没有谁能让别人闭嘴。
 *
 * ## 改写后的 content 不过 schema —— 与 N4 的又一处刻意不同
 *
 * N4 改的是**工具入参**,必须过工具那份 zod,否则会构造出模型自己都构造不出的
 * 非法调用。N5 改的是**给模型看的一段文本**,它本来就是自由字符串,没有 schema
 * 可过。唯一的闸是**长度上限**(`CORE_PLUGIN_TOOL_RESULT_INTERCEPT_MAX_LENGTH`):
 * 一个脱敏 / 摘要插件只会让结果变短或等长,而一个坏插件不该能把结果撑爆上下文。
 * 超限就截断并留一行宿主标注 —— 这不是安全闸,是一道防手滑的护栏。
 *
 * ## 熔断:与 N2 同规
 *
 * 抛错 / 超时(2s)= 当作 `keep`(用改写前的结果),并计熔断;连败到阈值后这个
 * 插件的改写面被降级掉,之后它的结果改写被跳过(= 原结果)。返回值读不懂当作者
 * 笔误、**不计熔断**(与 N4 刻意相反 —— 在 fail-open 一侧一个乱返回值的插件只是
 * 没改成结果,无害,不该被它自己的笔误连累进熔断账)。半开靠时间。
 */

import { sortByPluginCanonicalOrder } from './canonical-order.js'
import { toLogger, type CompatLogger, type Logger } from '../logging/index.js'
import { PLUGIN_TOOL_RESULT_INTERCEPT_SURFACE } from './policy.js'
import { runWithPluginTimeout } from './runtime-guard.js'
import {
  PLUGIN_PERMISSION_TOOLRESULT_INTERCEPT,
  PLUGIN_TOOLRESULT_INTERCEPT_PERMISSION_NOTE,
} from './sessions.js'

/* ── 声明门 ───────────────────────────────────────────────────────────────── */

/**
 * `toolresult:intercept` 与它的披露文案定义在 `sessions.ts`(零依赖叶子,同时是
 * 插件权限词汇表 + 装前披露口径)。这里原样再导出,读拦截代码的人不必跳文件 ——
 * 与 N2 / N4 同规。
 */
export { PLUGIN_PERMISSION_TOOLRESULT_INTERCEPT, PLUGIN_TOOLRESULT_INTERCEPT_PERMISSION_NOTE }

/* ── 预算与上限 ───────────────────────────────────────────────────────────── */

/**
 * 单个 handler 的超时预算。2s,与 N4 同 —— 它同样同步阻塞在一次工具结果回模型
 * 之前,用户此刻在看"正在执行"的转圈。逐 handler,链本身不设总预算。
 */
export const CORE_PLUGIN_TOOL_RESULT_INTERCEPT_TIMEOUT_MS = 2_000

/**
 * 改写后 content 的长度上限(字符)。
 *
 * 只约束**插件的改写结果**,不约束 `keep`(keep 一字不动地放行工具的原始结果,
 * 无论它多长)。取一个很宽的天花板:脱敏 / 摘要只会缩短或等长,合法的大结果
 * 改写(比如脱敏一份 100k 的文件读取)不该被误伤;它拦的是"插件把一段文本
 * 复制放大到撑爆上下文"这种明显的滥用。`<=0` 关闭上限。
 */
export const CORE_PLUGIN_TOOL_RESULT_INTERCEPT_MAX_LENGTH = 1_000_000

/** 熔断降级时停掉的界面名(policy.ts 的 describePluginSurface 产出同一个串)。 */
export { PLUGIN_TOOL_RESULT_INTERCEPT_SURFACE }

/* ── 契约 ─────────────────────────────────────────────────────────────────── */

/**
 * 工具结果的**模型可见视图** —— 一段文本 + 是否错误态。
 *
 * 宿主负责把它自己的结果类型(`{success, data, error}` 那一套)映射成这个视图
 * 再进链,并把改写后的视图映射回结果类型。core 这一层只认 content / isError:
 * 它是模型真正看到的那两样东西,也是插件唯一该关心的两样。
 */
export interface PluginToolResultView {
  /** 结果文本。成功时是工具产出的正文,错误时是错误信息。 */
  content: string
  /** 是否错误态。脱敏场景可翻转它(把泄露路径的错误改成通用错误)。 */
  isError: boolean
}

export interface PluginToolResultInterceptContext {
  sessionId: string
  /** 工具名(内置工具是它的 id,MCP 工具是带服务器前缀的引用名)。 */
  toolName: string
  /** 本次调用的 id(可选,与 N4 同 —— 某些内部直调路径不铸 id)。 */
  toolCallId?: string
  /** 本次调用的入参(只读,给 handler 判断用;N5 不改入参)。 */
  input: unknown
  /** 本次工具结果。链式累积:后手看到的是前手改写后的结果。 */
  result: PluginToolResultView
}

/**
 * 两态。`void` / `undefined` 等价于 `keep` —— 一个只想旁观的 handler 不必写
 * return(与 N2 / N4 / pi 的姿态一致)。
 *
 * 没有 `block`:结果已经产生,没有"拦截"语义。`replace` 的 `isError` 可省 ——
 * 省了就沿用改写前的错误态(摘要一个成功结果仍是成功,脱敏一个错误仍是错误)。
 */
export type PluginToolResultInterceptDecision =
  /** 不干预,交给下一个 handler(或宿主)。 */
  | { action: 'keep' }
  /** 改写结果文本(可选翻转错误态)。 */
  | { action: 'replace'; content: string; isError?: boolean }

export type PluginToolResultInterceptResult =
  | PluginToolResultInterceptDecision
  | void
  | undefined

export type PluginToolResultInterceptHandler = (
  context: PluginToolResultInterceptContext,
) => Promise<PluginToolResultInterceptResult> | PluginToolResultInterceptResult

/** 合法动作名的枚举 —— 未知值不静默,见 `normalizePluginToolResultInterceptResult`。 */
export const PLUGIN_TOOL_RESULT_INTERCEPT_ACTIONS = ['keep', 'replace'] as const

export type PluginToolResultInterceptAction = (typeof PLUGIN_TOOL_RESULT_INTERCEPT_ACTIONS)[number]

/* ── 归一化 ───────────────────────────────────────────────────────────────── */

export interface NormalizedPluginToolResultInterceptResult {
  decision: PluginToolResultInterceptDecision
  /**
   * 返回值不合规时的人话说明。**不为空 = 作者写错了**,宿主报一条 error 日志。
   *
   * 与 N4 的同名字段一处关键差异:在 N4 那边不合规**回落到 block**(fail-closed),
   * 在这里不合规**回落到 keep**(fail-open)。判据还是那一条 —— 我们读不懂这个
   * 改写器的答复,而默认动作是把原始结果原样交给模型,无害。
   */
  problem?: string
}

const KEEP: PluginToolResultInterceptDecision = { action: 'keep' }

function keptByMalformedResult(problem: string): NormalizedPluginToolResultInterceptResult {
  return { decision: KEEP, problem }
}

/**
 * 把 handler 的任意返回值收敛成一个两态判决(纯函数,两侧共用)。
 *
 * 只有**明文定义的沉默**(`undefined` / `null` / `{action:'keep'}`)是干净的
 * keep;其余读不懂的形状也**折成 keep**,但带上 `problem`(作者写错了)。
 * `replace` 少了合法的 `content` 一律折成 keep —— 在 fail-open 一侧,读不懂就
 * 别改,原样放行,这是无害的默认。
 */
export function normalizePluginToolResultInterceptResult(
  raw: unknown,
): NormalizedPluginToolResultInterceptResult {
  if (raw === undefined || raw === null) return { decision: KEEP }
  if (typeof raw !== 'object') {
    return keptByMalformedResult(`expected an object or undefined, got ${typeof raw}`)
  }
  const action = (raw as { action?: unknown }).action
  if (action === undefined) {
    return keptByMalformedResult('missing "action"')
  }
  if (action === 'keep') return { decision: KEEP }
  if (action === 'replace') {
    const content = (raw as { content?: unknown }).content
    if (typeof content !== 'string') {
      return keptByMalformedResult(
        `{action:"replace"} needs a string "content", got ${content === undefined ? 'nothing' : typeof content}`,
      )
    }
    const isError = (raw as { isError?: unknown }).isError
    if (isError === undefined) {
      // 省略 isError = 沿用改写前的错误态(在链的 run 里解析)。
      return { decision: { action: 'replace', content } }
    }
    if (typeof isError !== 'boolean') {
      return {
        decision: { action: 'replace', content },
        problem: '{action:"replace"} "isError" must be a boolean; it was dropped (inheriting the original)',
      }
    }
    return { decision: { action: 'replace', content, isError } }
  }
  return keptByMalformedResult(
    `unknown action "${String(action)}" — expected one of `
    + PLUGIN_TOOL_RESULT_INTERCEPT_ACTIONS.join(' | '),
  )
}

/* ── 长度上限 ─────────────────────────────────────────────────────────────── */

/**
 * 把改写后的 content 截到上限内。超限时截断并追加一行宿主标注 ——
 * 标注是宿主写的、算在上限之外(它是给模型的一句解释,不是插件的内容)。
 */
export function capPluginToolResultContent(content: string, maxLength: number): string {
  if (maxLength <= 0 || content.length <= maxLength) return content
  return (
    content.slice(0, maxLength)
    + `\n[... tool result truncated by the host: a plugin's replacement exceeded ${maxLength} characters]`
  )
}

/* ── 链的结果 ─────────────────────────────────────────────────────────────── */

export interface PluginToolResultInterceptOutcome {
  /** 走完链之后是否有人改过。`keep` = 一字未改,宿主原样用工具的原始结果。 */
  action: 'keep' | 'replace'
  /** 走完链之后的结果视图(累积了所有 replace;无人改写时是入链视图本身)。 */
  result: PluginToolResultView
  /** 改写过结果的插件 id(按发生顺序)。 */
  rewrittenBy: string[]
  /** 实际跑过的 handler 数 —— 熔断跳过 / 未注册时为 0(诊断用)。 */
  ran: number
}

export function emptyPluginToolResultInterceptOutcome(
  result: PluginToolResultView,
): PluginToolResultInterceptOutcome {
  return { action: 'keep', result, rewrittenBy: [], ran: 0 }
}

/* ── 注册表 ───────────────────────────────────────────────────────────────── */

interface RegisteredToolResultInterceptor {
  pluginId: string
  hookId: string
  handler: PluginToolResultInterceptHandler
}

/** @deprecated 统一为 `Logger`(§8.3 区 ①);过渡期仍收老鸭子形状。 */
export type CorePluginToolResultInterceptLogger = CompatLogger

export interface CorePluginToolResultInterceptRegistryOptions {
  logger?: CorePluginToolResultInterceptLogger
  /** 逐 handler 超时预算;<=0 关闭超时。缺省 CORE_PLUGIN_TOOL_RESULT_INTERCEPT_TIMEOUT_MS。 */
  timeoutMs?: number
  /** 改写 content 的长度上限;<=0 关闭。缺省 CORE_PLUGIN_TOOL_RESULT_INTERCEPT_MAX_LENGTH。 */
  maxContentLength?: number
  /**
   * 抛错 / 超时时回调,供熔断计数。
   *
   * **与 N4 相同、与 N2 相同**:抛错 / 超时都计。区别只在**返回值不合规不计**
   * (见 run 里的注释)—— 在 fail-open 一侧,一个乱返回值的插件只是没改成结果,
   * 无害,不该被它自己的笔误连累进熔断账。
   */
  onHandlerFailure?(input: { pluginId: string; hookId: string; error: unknown }): void
  /** 成功跑完(无论 keep 还是 replace)时回调,清同车道的连败账。 */
  onHandlerSuccess?(input: { pluginId: string; hookId: string }): void
  /**
   * 熔断降级闸:返回 true 表示**跳过**这个插件的改写。
   *
   * 跳过 = 放行原结果(fail-open)。与 N2 一致 —— 降级的语义是移除这道改写,
   * 而这条链本来就是 fail-open,降级只是"别再浪费 2s 了"。
   */
  isDegraded?(pluginId: string): boolean
  /** 重复 id / 非法 id 这类注册期违规的上报口(归 registration 族)。 */
  onRegistrationViolation?(input: { pluginId: string; hookId: string; reason: string }): void
}

/**
 * 工具结果改写链。
 *
 * 次序 = **全局规范顺序**(跨插件按 pluginId 字典序,插件内保持注册顺序),
 * 与 N2 / N4 同一个出处:目录发现序会让同一套插件在两台机器上排出两种结果,
 * 而这里的次序直接决定"谁先改写"。
 */
export class CorePluginToolResultInterceptRegistry {
  private readonly handlers = new Map<string, RegisteredToolResultInterceptor>()
  private readonly logger: Logger

  constructor(private readonly options: CorePluginToolResultInterceptRegistryOptions = {}) {
    this.logger = toLogger(options.logger)
  }

  /**
   * 注册。返回退订函数;**重复的 (pluginId, hookId) 被拒绝**并返回一个 no-op ——
   * 与 N4 同规:让第二个悄悄顶掉第一个的话,作者看到的是"我的第一条改写不生效了"。
   */
  register(
    pluginId: string,
    hookId: string,
    handler: PluginToolResultInterceptHandler,
  ): () => void {
    const id = String(hookId ?? '').trim()
    if (!id) {
      this.violate(pluginId, hookId, 'interceptToolResult needs a non-empty id')
      return () => {}
    }
    const key = this.key(pluginId, id)
    if (this.handlers.has(key)) {
      this.violate(pluginId, id, `interceptToolResult id "${id}" is already registered`)
      return () => {}
    }
    this.handlers.set(key, { pluginId, hookId: id, handler })
    return () => {
      this.handlers.delete(key)
    }
  }

  /**
   * 跑一遍链。**从不抛错** —— 最坏情况是原样返回入链的结果(fail-open)。
   */
  async run(
    context: PluginToolResultInterceptContext,
  ): Promise<PluginToolResultInterceptOutcome> {
    const ordered = sortByPluginCanonicalOrder([...this.handlers.values()], item => item.pluginId)
    if (ordered.length === 0) return emptyPluginToolResultInterceptOutcome(context.result)

    const timeoutMs = this.options.timeoutMs ?? CORE_PLUGIN_TOOL_RESULT_INTERCEPT_TIMEOUT_MS
    const maxLength = this.options.maxContentLength ?? CORE_PLUGIN_TOOL_RESULT_INTERCEPT_MAX_LENGTH
    let result = context.result
    const rewrittenBy: string[] = []
    let ran = 0

    for (const item of ordered) {
      // 熔断后跳过:这个插件的改写面已被降级,链直接跳过它(= 原结果)。
      if (this.options.isDegraded?.(item.pluginId)) continue
      const label = `${item.pluginId}/${item.hookId}`
      let raw: unknown
      try {
        raw = await runWithPluginTimeout(
          `toolResultIntercept:${label}`,
          timeoutMs,
          () => item.handler({
            sessionId: context.sessionId,
            toolName: context.toolName,
            toolCallId: context.toolCallId,
            input: context.input,
            result,
          }),
        )
      } catch (error) {
        // fail-open:抛错 / 超时 = 保留改写前的结果,继续下一个 handler。计熔断
        // (与 N2 / N4 同 —— 抛错 / 超时是真的坏了)。
        this.logger.error(
          `[PluginToolResultIntercept] "${label}" failed; the tool result was left unchanged (fail-open):`,
          undefined, error,
        )
        this.options.onHandlerFailure?.({ pluginId: item.pluginId, hookId: item.hookId, error })
        continue
      }
      ran += 1

      const { decision, problem } = normalizePluginToolResultInterceptResult(raw)
      if (problem) {
        // 返回值不合规**不计熔断**(与 N4 刻意相反):在 fail-open 一侧一个乱返回值
        // 只是没改成结果,无害。既不算失败也不算成功,连败账原样保留。
        this.logger.error(
          `[PluginToolResultIntercept] "${label}" returned an invalid result: ${problem}`,
        )
      } else {
        this.options.onHandlerSuccess?.({ pluginId: item.pluginId, hookId: item.hookId })
      }

      if (decision.action === 'replace') {
        const isError = decision.isError ?? result.isError
        result = { content: capPluginToolResultContent(decision.content, maxLength), isError }
        rewrittenBy.push(item.pluginId)
      }
      // keep(含读不懂折成的 keep)→ 不动结果,交给下一个 handler。
    }

    return {
      action: rewrittenBy.length > 0 ? 'replace' : 'keep',
      result,
      rewrittenBy,
      ran,
    }
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
    this.logger.error(`[PluginToolResultIntercept] ${pluginId}: ${reason}`)
    this.options.onRegistrationViolation?.({ pluginId, hookId: String(hookId ?? ''), reason })
  }

  private key(pluginId: string, hookId: string): string {
    return `${pluginId}:${hookId}`
  }
}
