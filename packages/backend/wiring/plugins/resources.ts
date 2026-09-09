/**
 * 插件的三个动词接到内核上(原子 K4-b,`docs/design/atom-2026-09.md` §4
 * 「调度 / 网关 / 插件」那一行:「都是 `Principal` 不同的 `do`」)。
 *
 * core 那一侧(`core/plugins/api-builder.ts` 的 `api.resources`)只有晚到闸、声明门
 * 与转手;**这只文件放的是四件只有装配层知道的事**:
 *
 *  ① 主体是谁;② 一次调用的预算;③ 熔断的四步套;④ 内核在不在这个进程里。
 *
 * 与 `sessions.ts`(N1)、`llm.ts`(N7-b)、`../deeplink/registry.ts`(H4)同一条
 * 分工,连形状都抄的是它们:一个 `createXxxHostPorts` 工厂,吐出几只喂进
 * `CorePluginAPIHost` 的方法。
 *
 * ── ① 主体:`systemPrincipal('plugin:<id>')`,不是 agent ──────────────────
 *
 * 三支主体(`core/permission/principal.ts`)里,插件哪一支都不像,但**只有一支
 * 是安全的**:
 *
 *  · `user` —— 错得最离谱。它是「桌面前面的那个人」,拿到的是这台机器主人的**全部**
 *    授权面:K3-a' 拍定「效果按主体定」之后,`session:remove` 这类做法对用户主体是
 *    `[]`(不问)、对其余主体是 `session_destructive`(要审批)。把插件铸成 user,
 *    等于一个第三方 npm 包可以静默删掉用户的消息 —— 而用户点头的那句披露只说了
 *    「它能操作应用里的东西,每一次都会被记下来」。
 *  · `agent` —— 错得更隐蔽。`agentId` 是**会话里那个 AI 的身份**:授权 grant 按它
 *    记账、权限卡按它显示「谁在请求」、`invokedBy` 按它追责。插件不是一个 agent:
 *    它没有会话、不消耗上下文、不是模型。铸成 agent 会让一条 grant 在插件与真 agent
 *    之间串味(`principalId` 一样,grant 就一样),而权限卡会显示一个根本不存在的
 *    agent 名字。
 *  · `system` —— 对。它的文档原话是「the minimum-privilege principal:everything
 *    that cannot prove who it is lands here rather than on the default agent」。插件
 *    正是这种东西:它有一个稳定的名字(`plugin:<id>`,于是审计与 grant 分得清是哪个
 *    插件),但**没有一份能证明它有多大权限的凭证**。凭证级主体那一片地 09-03 已经
 *    明确搁置,所以这里不发明第四支 —— 用已经成立的最小权限那一支,并把名字带上。
 *
 * `system:plugin:<id>` 因此同时是审计里那一行的身份(`<store>/audit/resource.jsonl`
 * 的 `principal`)与将来 grant 的键。**它不带发起会话**:插件的调用不是从任何一轮
 * 对话里发起的,拿它操作的那条会话顶上就是 K1 留账的那个病(审计读成「A 自己改了
 * 自己」),所以坐标缺席,落 `NO_ORIGIN_SESSION` 那本账。
 *
 * ── ② 预算:接进内核的 signal,不自己写计时器 ────────────────────────────
 *
 * `AbortSignal.timeout(...)` 进 `ResourceCallOptions.signal`。内核已经把三个取消源
 * 合成一处(关机 / 卸载 / 调用方),这里递的是第三个;写一个 `Promise.race` 是造
 * 第四个源,而且是唯一一个下游看不见的那种 —— 输的那一半还在跑、`apply` 还在写,
 * 正是 §10.2「不许摘了之后 apply 还在写」禁止的形状。
 *
 * ── ③ 熔断:只记「压根没拿到结局」那种失败 ──────────────────────────────
 *
 * 四步照 `invokePluginDeepLinkAction`:查得到吗 → 灰着吗(半开满一个间隔放行一次
 * 探测)→ 跑 → 记账。唯一一处**故意与它不同**的是「什么算失败」:深链那边 handler
 * 是插件的代码,它抛错就是插件坏了;这边跑的是内核,而内核**从不抛** —— 它把五种
 * 结局都折成 `Outcome`。所以:
 *
 *   抛了 / 预算烧完 → 记失败(这次调用压根没拿出答案);
 *   拿到任何一支结局(含 `failed` / `denied` / `invalid`)→ 记成功。
 *
 * 后半句是要紧的那半句。`read('session:一条已删的会话','get')` 稳态回
 * `failed(SessionNotFoundError)`,那是管线给出的**答案**、插件当场看得见;把它算进
 * 连败,一个正常的轮询三次之后就把自己关掉了。罚则的理由(`policy.ts` 的
 * `resource-call` 一格)写的就是这句话。
 */

import {
  PLUGIN_RESOURCE_CALL_TIMEOUT_MS,
  pluginResourceSurface,
  pluginScope,
} from '@onething/core/plugins'
import { parseRef, ReadOutcome } from '@onething/core/resource'
import type { ReadOutcome as ReadOutcomeValue, ResourceEvent } from '@onething/core/resource'
import { systemPrincipal } from '@onething/core/permission'
import type { Principal } from '@onething/core/permission'
import { Outcome } from '@onething/core/toolkit'
import type { Outcome as OutcomeValue } from '@onething/core/toolkit'
import {
  isPluginSurfaceDegraded,
  probePluginSurface,
  reportPluginRuntimeFailure,
  reportPluginRuntimeSuccess,
} from '@onething/runtime/plugins/health'

/**
 * 内核里插件用得到的那三格。
 *
 * 写成一个**结构接口**而不是直接吃 `ResourceKernel`,是为了让这只文件与测试都不必
 * 拉起一整台内核 —— `ResourceKernel` 在结构上满足它,所以生产路径上一次转换都没有。
 */
export interface PluginResourceAccess {
  read(
    ref: string,
    name: string,
    query: Record<string, unknown>,
    options: { principal: Principal; signal?: AbortSignal },
  ): Promise<ReadOutcomeValue>
  do(
    ref: string,
    op: string,
    params: Record<string, unknown>,
    options: { principal: Principal; signal?: AbortSignal },
  ): Promise<OutcomeValue>
  readonly events: {
    watch(prefix: string, listener: (event: ResourceEvent) => void): () => void
  }
}

/** 喂进 `CorePluginAPIHost` 的那三只。名字与那边的键逐字相同。 */
export interface PluginResourceHostPorts {
  readResource(
    pluginId: string,
    ref: string,
    name: string,
    query: Record<string, unknown>,
  ): Promise<ReadOutcomeValue>
  doResource(
    pluginId: string,
    ref: string,
    op: string,
    params: Record<string, unknown>,
  ): Promise<OutcomeValue>
  watchResources(
    pluginId: string,
    prefix: string,
    listener: (event: ResourceEvent) => void,
  ): () => void
}

export interface CreatePluginResourceHostPortsOptions {
  /**
   * 这个进程当下那台内核。**每次调用现取** —— 内核的寿命是一次装配
   * (§10.1),而插件的寿命跨得过它;抓住一台已经 dispose 的内核,得到的是一个
   * 表已经空了、却还会安静地答「未登记」的东西。
   */
  resources: () => PluginResourceAccess | undefined
}

/** 一次调用要记在哪条车道上。地址读不出 scheme 时无从归因 —— 见调用点。 */
function schemeOf(ref: string): string | undefined {
  return parseRef(ref)?.scheme
}

export function createPluginResourceHostPorts(
  options: CreatePluginResourceHostPortsOptions,
): PluginResourceHostPorts {
  const { resources } = options

  /**
   * 四步套的前两步(查得到吗 / 灰着吗)。两条路共用一处 —— 写两份的下场是某天
   * 有人给 `do` 加了第三道闸,而 `read` 不知道。
   *
   * 回的是「这次不能跑」的**理由字符串**,不是一个结局:两条路的结局类型不同
   * (`ReadOutcome` / `Outcome`),而理由是同一句话。
   */
  function refuseBefore(pluginId: string, scheme: string | undefined): string | undefined {
    if (!resources()) return 'this host has no resource kernel'
    if (!scheme) return undefined
    const surface = pluginResourceSurface(scheme)
    if (isPluginSurfaceDegraded(pluginId, surface) && !probePluginSurface(pluginId, surface)) {
      return `"${surface}" is temporarily disabled after repeated failures`
    }
    return undefined
  }

  /** 一次调用的坐标。见文件头 ①:主体带名字,发起会话缺席。 */
  function callOptions(pluginId: string): { principal: Principal; signal: AbortSignal } {
    return {
      principal: systemPrincipal(`plugin:${pluginId}`),
      signal: AbortSignal.timeout(PLUGIN_RESOURCE_CALL_TIMEOUT_MS),
    }
  }

  /**
   * 四步套的后两步(跑 / 记账),**一处**给两条路用。
   *
   * 记账的判据见文件头 ③:拿到结局就是成功(哪一支都算),抛了才是失败。
   *
   * 地址读不出 scheme 时**不记账** —— 归因不到某个命名空间的失败不该落在任何一个
   * 命名空间的账上(那会让一次笔误灰掉一条好路)。这一支照样交给内核,它会回一句
   * 具名的 `ResourceSchemeUnknownError`。
   */
  async function runOnLane<T>(
    pluginId: string,
    scheme: string | undefined,
    call: () => Promise<T>,
    fold: (error: unknown) => T,
  ): Promise<T> {
    if (!scheme) {
      try { return await call() } catch (error) { return fold(error) }
    }
    const scope = pluginScope.resourceCall(scheme)
    try {
      const outcome = await call()
      reportPluginRuntimeSuccess(pluginId, scope)
      return outcome
    } catch (error) {
      reportPluginRuntimeFailure(pluginId, scope, error)
      return fold(error)
    }
  }

  return {
    async readResource(pluginId, ref, name, query) {
      const scheme = schemeOf(ref)
      const refusal = refuseBefore(pluginId, scheme)
      if (refusal) return ReadOutcome.denied(refusal)
      const kernel = resources()!
      return runOnLane(
        pluginId,
        scheme,
        () => kernel.read(ref, name, query, callOptions(pluginId)),
        error => ReadOutcome.failed(error),
      )
    },

    async doResource(pluginId, ref, op, params) {
      const scheme = schemeOf(ref)
      const refusal = refuseBefore(pluginId, scheme)
      if (refusal) return Outcome.denied(refusal)
      const kernel = resources()!
      return runOnLane(
        pluginId,
        scheme,
        () => kernel.do(ref, op, params, callOptions(pluginId)),
        error => Outcome.failed(error),
      )
    },

    /**
     * 看住一个前缀。
     *
     * **不进熔断账**:订阅不是调用,它没有「跑一次」这回事 —— 一条监听器抛错已经
     * 由 core 那一侧就地吞掉并归因(旁观者不是参与者,与 `ResourceEventHub.emit`
     * 逐字同一条)。前缀非法时总线**抛**,这里原样让它抛回 core,由那边折成一条
     * 按插件归因的日志加一个空退订。
     */
    watchResources(_pluginId, prefix, listener) {
      const kernel = resources()
      if (!kernel) throw new Error('this host has no resource kernel')
      return kernel.events.watch(prefix, listener)
    },
  }
}
