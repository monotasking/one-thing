/**
 * N2 —— 发送前拦截(改写 / 接管)的**协议层**
 * (docs/design/pi-benchmark-adoption-2026-08.md)。
 *
 * 这是本系统第一个**干预型**钩子:在此之前插件的一切都是观察型(`api.on` 的
 * 返回值被忽略)或旁路型(`api.sendMessage` 往别处投递)。这里第一次出现
 * "插件的返回值改变了宿主的下一步" —— 架构图里"拦截钩子屋"的第一个解冻点
 * (`beforeSend`),按点解冻、每点单独设计预算 / 超时回退 / 次序 / 幂等。
 *
 * ## 为什么是专用注册方法而不是 `api.on('input')`
 *
 * pi 的账单里最贵的一条是**裸 string 订阅面零校验**:自用扩展订阅了不存在的
 * `session_switch`(真名 `session_before_switch`),handler 永远不会被调用,
 * 没人发现。拼错 = 静默死订阅。
 *
 * 我们的答案不是"给 `api.on` 加一张事件名白名单"(那只治拼错,不治另一半
 * 问题:观察族的 handler 返回值今天被忽略,把可消费返回值混进同一个函数会让
 * "我 return 了为什么没生效"变成一个说不清的问题)。答案是**两个家族在类型上
 * 就分开**:
 *
 *   - 观察族 `api.on(eventType, handler)` —— 返回值继续被忽略,零污染;
 *   - 拦截族 `api.interceptInput(id, handler)` —— 与 `beforeContextCompact`
 *     同构的注册风格,`id` 用于熔断归因与重复拒绝。
 *
 * 于是"订阅名枚举化"这条通用前置在这里以最强的形态兑现:**根本没有名字可以
 * 拼错** —— 拦截点是一个函数名,拼错就是 TypeError,不是静默的死订阅。
 *
 * ## fail-open(与 N4 的 tool_call 拦截刻意相反)
 *
 * 这条链挂在用户按下回车与消息出现之间。插件抛错 / 超时 = **当它返回
 * continue**,消息照常发出。"发消息永远不能因为插件坏了而发不出去"是这一期的
 * 硬约束 —— 一个坏插件能让人发不出消息,那是应用坏了,不是插件坏了。
 * (N4 会反过来:改工具参数的钩子挂了必须 fail-closed,因为那一边的默认动作
 * 是"执行一个可能带副作用的工具"。默认动作不同,失败语义就必须不同。)
 */

import { sortByPluginCanonicalOrder } from './canonical-order.js'
import { toLogger, type CompatLogger, type Logger } from '../logging/index.js'
import { PLUGIN_INPUT_INTERCEPT_SURFACE } from './policy.js'
import { runWithPluginTimeout } from './runtime-guard.js'
import {
  PLUGIN_INPUT_INTERCEPT_PERMISSION_NOTE,
  PLUGIN_PERMISSION_INPUT_INTERCEPT,
} from './sessions.js'

/* ── 声明门 ───────────────────────────────────────────────────────────────── */

/**
 * `input:intercept` 与它的披露文案定义在 `sessions.ts`(那个文件是零依赖叶子,
 * 同时是**插件权限词汇表 + 披露口径**的所在地,渲染层按子路径直接引它)。
 * 这里原样再导出,读拦截代码的人不必跳文件。
 */
export { PLUGIN_INPUT_INTERCEPT_PERMISSION_NOTE, PLUGIN_PERMISSION_INPUT_INTERCEPT }

/* ── 预算 ─────────────────────────────────────────────────────────────────── */

/**
 * 单个 handler 的超时预算。
 *
 * **刻意短于生命周期钩子的 5s**(`CORE_PLUGIN_LIFECYCLE_HOOK_TIMEOUT_MS`):
 * 那两个钩子挂在压缩路径与回合结束后,用户不在等;这一条挂在**回车与消息出现
 * 之间**,超过一秒的空白就已经是"应用卡了"。1.5s 高于任何本地计算(宏展开、
 * 查表、算术求值),低于用户开始重复按回车的阈值。
 *
 * 注意它是**逐 handler**的:三个插件各超时一次是 4.5s。链本身不设总预算 ——
 * 设了就要回答"总预算用完时后半条链算 continue 还是算没跑",而那是一个
 * 不可归因的状态。逐个超时、逐个计熔断,连败三次那个插件就被降级掉了。
 */
export const CORE_PLUGIN_INPUT_INTERCEPT_TIMEOUT_MS = 1_500

/** 熔断降级时停掉的界面名(policy.ts 的 describePluginSurface 产出同一个串)。 */
export { PLUGIN_INPUT_INTERCEPT_SURFACE }

/* ── 契约 ─────────────────────────────────────────────────────────────────── */

/**
 * 拦截链只看**真实用户发送**。
 *
 * 今天只有 `'user'` 一个值,但它是一个字段而不是一个隐含前提:系统内部源
 * (goal / radio / collab / `plugin:<id>` 前缀族)**一律不进拦截链**,否则
 * N1 的插件投递会被别的插件二次改写 —— 一条谁也说不清是谁写的消息。
 * 将来若有第二类源要进来,它在这里有位置,而不必改 handler 签名。
 */
export type PluginInputInterceptSource = 'user'

export interface PluginInputInterceptContext {
  sessionId: string
  /** 待发文本。链式累积:后手看到的是前手改写后的结果。 */
  text: string
  source: PluginInputInterceptSource
}

/**
 * 三态。`void` / `undefined` 等价于 `continue` —— 一个只想旁观的 handler
 * 不必写 return(与 pi 的姿态一致)。
 */
export type PluginInputInterceptDecision =
  /** 不干预,交给下一个 handler(或宿主)。 */
  | { action: 'continue' }
  /** 用 `text` 替换待发文本,继续走链。**结果即真相**:持久化的是改写后的文本。 */
  | { action: 'transform'; text: string }
  /**
   * 接管:后续 handler 不再跑,**不起模型轮**。
   *
   * 用户消息照常持久化与显示(用户说过的话不消失);`reply` 若给出,以该插件
   * 身份贴一条同样不起轮的消息。
   */
  | { action: 'handled'; reply?: string }

export type PluginInputInterceptResult =
  | PluginInputInterceptDecision
  | void
  | undefined

export type PluginInputInterceptHandler = (
  context: PluginInputInterceptContext,
) => Promise<PluginInputInterceptResult> | PluginInputInterceptResult

/** 合法动作名的枚举 —— 未知值不静默,见 `normalizePluginInputInterceptResult`。 */
export const PLUGIN_INPUT_INTERCEPT_ACTIONS = ['continue', 'transform', 'handled'] as const

export type PluginInputInterceptAction = (typeof PLUGIN_INPUT_INTERCEPT_ACTIONS)[number]

export interface NormalizedPluginInputInterceptResult {
  decision: PluginInputInterceptDecision
  /**
   * 返回值不合规时的人话说明。**不为空 = 作者写错了**,宿主报一条 error 日志。
   *
   * 它不计熔断:与"未声明权限"同规 —— 那是笔误,不是运行期抖动,连坐整个插件
   * 帮不上任何人。但它也**绝不静默**:pi 的死订阅正是"写错了什么都不发生"。
   */
  problem?: string
}

const CONTINUE: PluginInputInterceptDecision = { action: 'continue' }

/**
 * 把 handler 的任意返回值收敛成一个三态判决(纯函数,两侧共用)。
 *
 * 一切不合规都**回落到 continue**(fail-open),但都带上 `problem`:
 * 收敛与告警是两件事,少了后者就是又一个静默死订阅。
 */
export function normalizePluginInputInterceptResult(
  raw: unknown,
): NormalizedPluginInputInterceptResult {
  if (raw === undefined || raw === null) return { decision: CONTINUE }
  if (typeof raw !== 'object') {
    return { decision: CONTINUE, problem: `expected an object or undefined, got ${typeof raw}` }
  }
  const action = (raw as { action?: unknown }).action
  if (action === undefined) {
    return { decision: CONTINUE, problem: 'missing "action"' }
  }
  if (action === 'continue') return { decision: CONTINUE }
  if (action === 'transform') {
    const text = (raw as { text?: unknown }).text
    if (typeof text !== 'string') {
      return { decision: CONTINUE, problem: '{action:"transform"} needs a string "text"' }
    }
    return { decision: { action: 'transform', text } }
  }
  if (action === 'handled') {
    const reply = (raw as { reply?: unknown }).reply
    if (reply === undefined || reply === null) return { decision: { action: 'handled' } }
    if (typeof reply !== 'string') {
      return {
        decision: { action: 'handled' },
        problem: '{action:"handled"} "reply" must be a string; it was dropped',
      }
    }
    return { decision: { action: 'handled', reply } }
  }
  return {
    decision: CONTINUE,
    problem: `unknown action "${String(action)}" — expected one of `
      + PLUGIN_INPUT_INTERCEPT_ACTIONS.join(' | '),
  }
}

/* ── 链的结果 ─────────────────────────────────────────────────────────────── */

export interface PluginInputInterceptOutcome {
  /** 走完链之后的文本(累积了所有 transform)。 */
  text: string
  /** 有插件接管了 —— 宿主持久化 `text` 但不起模型轮。 */
  handled: boolean
  /** 接管者;`handled` 为 true 时必有。 */
  handledBy?: string
  /** 接管者要贴的回应(可选)。 */
  reply?: string
  /**
   * 改写过文本的插件 id(按发生顺序)。
   *
   * **只记 id,不存原文**。存原文 = 每条被改写的消息在盘上有两份内容,历史重建
   * 要回答"喂给模型的是哪一份"、编辑重发要回答"编的是哪一份"、压缩要决定摘要
   * 哪一份 —— 三个已经很复杂的地方各多一个分叉,换来的只是一次事后取证。
   * 归因(谁改的)保留,原文不留。
   */
  transformedBy: string[]
  /** 实际跑过的 handler 数 —— 熔断跳过 / 未注册时为 0(诊断用)。 */
  ran: number
}

export function emptyPluginInputInterceptOutcome(text: string): PluginInputInterceptOutcome {
  return { text, handled: false, transformedBy: [], ran: 0 }
}

/* ── 注册表 ───────────────────────────────────────────────────────────────── */

interface RegisteredInterceptor {
  pluginId: string
  hookId: string
  handler: PluginInputInterceptHandler
}

/** @deprecated 统一为 `Logger`(§8.3 区 ①);过渡期仍收老鸭子形状。 */
export type CorePluginInputInterceptLogger = CompatLogger

export interface CorePluginInputInterceptRegistryOptions {
  logger?: CorePluginInputInterceptLogger
  /** 逐 handler 超时预算;<=0 关闭超时。缺省 CORE_PLUGIN_INPUT_INTERCEPT_TIMEOUT_MS。 */
  timeoutMs?: number
  /** 抛错 / 超时(= 当作 continue)时回调,供熔断计数。 */
  onHandlerFailure?(input: { pluginId: string; hookId: string; error: unknown }): void
  /** 成功跑完(无论判决是哪一态)时回调,清同车道的连败账。 */
  onHandlerSuccess?(input: { pluginId: string; hookId: string }): void
  /**
   * 熔断降级闸:返回 true 表示**跳过**这个插件的拦截。
   *
   * 闸在这里而不在别处,是因为拦截根本不走请求通道 —— 与 IM 渠道同一个先例
   * (闸在投递口)。跳过 = 消息照常发出,这正是 fail-open 的延伸。
   */
  isDegraded?(pluginId: string): boolean
  /** 重复 id / 非法 id 这类注册期违规的上报口(归 registration 族)。 */
  onRegistrationViolation?(input: { pluginId: string; hookId: string; reason: string }): void
}

/**
 * 发送前拦截链。
 *
 * 次序 = **全局规范顺序**(跨插件按 pluginId 字典序,插件内保持注册顺序),
 * 与锚点块排列、主题覆盖"后者胜"同一个出处 —— 目录发现序会让同一套插件在两台
 * 机器上排出两种结果,而这里的次序直接决定"谁先改写、谁先接管"。
 */
export class CorePluginInputInterceptRegistry {
  private readonly handlers = new Map<string, RegisteredInterceptor>()
  private readonly logger: Logger

  constructor(private readonly options: CorePluginInputInterceptRegistryOptions = {}) {
    this.logger = toLogger(options.logger)
  }

  /**
   * 注册。返回退订函数;**重复的 (pluginId, hookId) 被拒绝**并返回一个 no-op ——
   * 让第二个悄悄顶掉第一个的话,插件作者看到的是"我的第一个宏不生效了"。
   */
  register(
    pluginId: string,
    hookId: string,
    handler: PluginInputInterceptHandler,
  ): () => void {
    const id = String(hookId ?? '').trim()
    if (!id) {
      this.violate(pluginId, hookId, 'interceptInput needs a non-empty id')
      return () => {}
    }
    const key = this.key(pluginId, id)
    if (this.handlers.has(key)) {
      this.violate(pluginId, id, `interceptInput id "${id}" is already registered`)
      return () => {}
    }
    this.handlers.set(key, { pluginId, hookId: id, handler })
    return () => {
      this.handlers.delete(key)
    }
  }

  /**
   * 跑一遍链。**从不抛错** —— 最坏情况是原样返回入参文本。
   */
  async run(context: PluginInputInterceptContext): Promise<PluginInputInterceptOutcome> {
    const ordered = sortByPluginCanonicalOrder([...this.handlers.values()], item => item.pluginId)
    if (ordered.length === 0) return emptyPluginInputInterceptOutcome(context.text)

    const timeoutMs = this.options.timeoutMs ?? CORE_PLUGIN_INPUT_INTERCEPT_TIMEOUT_MS
    let text = context.text
    const transformedBy: string[] = []
    let ran = 0

    for (const item of ordered) {
      if (this.options.isDegraded?.(item.pluginId)) continue
      const label = `${item.pluginId}/${item.hookId}`
      let raw: unknown
      try {
        raw = await runWithPluginTimeout(
          `inputIntercept:${label}`,
          timeoutMs,
          () => item.handler({ sessionId: context.sessionId, source: context.source, text }),
        )
      } catch (error) {
        // fail-open:抛错 / 超时 = 当它返回 continue。消息照常往下走。
        this.logger.error(`[PluginInputIntercept] "${label}" failed; treated as continue:`, undefined, error)
        this.options.onHandlerFailure?.({ pluginId: item.pluginId, hookId: item.hookId, error })
        continue
      }
      ran += 1
      this.options.onHandlerSuccess?.({ pluginId: item.pluginId, hookId: item.hookId })

      const { decision, problem } = normalizePluginInputInterceptResult(raw)
      if (problem) {
        this.logger.error(`[PluginInputIntercept] "${label}" returned an invalid result: ${problem}`)
      }
      if (decision.action === 'transform') {
        text = decision.text
        transformedBy.push(item.pluginId)
        continue
      }
      if (decision.action === 'handled') {
        return {
          text,
          handled: true,
          handledBy: item.pluginId,
          ...(decision.reply ? { reply: decision.reply } : {}),
          transformedBy,
          ran,
        }
      }
    }

    return { text, handled: false, transformedBy, ran }
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
    this.logger.error(`[PluginInputIntercept] ${pluginId}: ${reason}`)
    this.options.onRegistrationViolation?.({ pluginId, hookId: String(hookId ?? ''), reason })
  }

  private key(pluginId: string, hookId: string): string {
    return `${pluginId}:${hookId}`
  }
}
