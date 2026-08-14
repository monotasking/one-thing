/**
 * `FeatureContext` —— 可逆注册基座的注册面。
 *
 * 底座在 C0 换成了 cordis（`docs/design/cordis-adoption-2026-08.md`），**对外
 * API 面一个字没改**（K0 的既有测试就是这次换芯的验收门）。原来手写的挂载表 /
 * disposer 清单，正是 cordis 的 fiber / effect 的形状；继续自己养的终点是「拥
 * 有一个更差的 Cordis」。
 *
 * 它**不是**新框架，也不解析依赖：装配顺序仍然由 `backend.ts` 里那串写死的
 * 调用负责（这是我们与 Cordis/dsh 的清醒分界 —— 先要**可卸载**，不要
 * **自动排序**；cordis 的 `inject` 依赖激活按需渐进采用，解除封印需逐处论证）。
 * 这一层只做一件事：把散落在装配流程里的注册调用收拢，并给每一个配上注销。
 *
 * 两条设计约束（换底座后由「适配层 + cordis」共同保证）：
 *
 * 1. **每个 register* 都返回 disposer**，且该 disposer 幂等 —— 调用方可以
 *    自己提前解绕某一项，`disposeAll()` 不会再解一次。幂等性现在由 cordis 的
 *    effect wrapper 兜底（单次生效、并发调用汇入同一次 teardown）。
 * 2. **`disposeAll()` 逆序**：后注册的先解。注册顺序天然带着依赖方向（后者
 *    可能建立在前者之上），逆序解绕镜像的是 dispose 的通行惯例，也是唯一
 *    不需要依赖图就正确的顺序。
 *
 *    这条**必须由适配层自己保证**：cordis 的 `Fiber._unload()` 是
 *    `Promise.all(...)` 并行解绕、且逐项 `logger.error` 吞掉异常。逆序 +
 *    `AggregateError` 是 K0 钉死的语义，所以本层保留自己的 entries 账本，只把
 *    「一次性 disposer」这件事交给 cordis。fiber 仍然持有全部 effect，是兜底：
 *    任何绕过本层的路径（如直接 `fiber.dispose()`）也不会漏解。
 *
 * K0 刻意做小：这里**只有两个注册面** —— `registerRpcDomain`（走既有
 * `app/rpc/registry`）与 `registerDisposer`（通用逃生舱，任何已经可逆的副作
 * 用都能先挂进来）。工具 / 变量 / 斜杠命令的专用 register 面不预雕，按 D3
 * 规则等 C2/C3 迁移功能时由差距清单驱动逐个加。
 *
 * import 零副作用：本模块加载时不注册任何东西、也不创建 cordis Context（见
 * `src/app/__tests__/import-side-effect-free.test.ts`）。
 */
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type { DomainRoutes, Router } from '@onething/core/ipc'
import { registerRouterHandlers, type RpcRouteHandlers } from '../rpc/registry.js'

/** 解绕一项注册。允许异步：未来的注册面（面板、连接）可能要等 I/O。 */
export type FeatureDisposer = () => void | Promise<void>

/** 一个 feature 的注册面。feature 的 `mount` 拿到的就是它。 */
export interface FeatureContext {
  /** 挂载它的 feature id。诊断与报错用，注册面本身不读。 */
  readonly featureId: string

  /**
   * 注册一个 RPC 域。内部走 `app/rpc/registry` 的既有注册表 —— 域重复注册
   * 仍然 throw（两份实现同名域永远是接线 bug）。
   */
  registerRpcDomain: <T extends DomainRoutes>(
    router: Router<T>,
    handlers: RpcRouteHandlers<T>,
  ) => FeatureDisposer

  /**
   * 通用逃生舱：把一个**已经存在**的可逆副作用挂进本 feature 的清单。
   *
   * 存在的理由是迁移路径，不是偷懒 —— 一个专用 register 面还没长出来之前，
   * 先用它把注销语义接上；等 D3 的差距清单把该面原语化了，再改挂过去。
   */
  registerDisposer: (dispose: FeatureDisposer) => FeatureDisposer
}

/** 一个 feature 的注册项快照（`dumpFeatures` 的元素）。 */
export interface FeatureDump {
  id: string
  /** 各注册项种类的计数。种类随 ctx 的注册面一起长。 */
  registrations: {
    rpcDomain: number
    disposer: number
  }
  /** 当前仍然生效的 RPC 域名（已被单独解绕的不在其中）。 */
  rpcDomains: string[]
}

type EntryKind = 'rpcDomain' | 'disposer'

interface Entry {
  kind: EntryKind
  /** rpcDomain 项携带域名，供 dump 输出；其余种类为 undefined。 */
  label?: string
  /** cordis effect 的一次性 disposer（wrapper）。 */
  dispose: FeatureDisposer
  disposed: boolean
}

/**
 * `FeatureContext` 的实现。只由 `mountFeature` 构造 —— feature 作者拿到的是
 * 接口，拿不到 `disposeAll`（谁挂载谁负责卸载）。
 *
 * `scope` 是本 feature 的 cordis plugin fiber 的 context：每一项注册都作为它的
 * 一个 `ctx.effect()` 落地。
 */
export class FeatureContextImpl implements FeatureContext {
  readonly featureId: string
  private readonly scope: CordisContext
  private readonly entries: Entry[] = []

  constructor(featureId: string, scope: CordisContext) {
    this.featureId = featureId
    this.scope = scope
  }

  registerRpcDomain<T extends DomainRoutes>(
    router: Router<T>,
    handlers: RpcRouteHandlers<T>,
  ): FeatureDisposer {
    const unregister = registerRouterHandlers(router, handlers)
    return this.track({ kind: 'rpcDomain', label: router.domain, dispose: unregister })
  }

  registerDisposer(dispose: FeatureDisposer): FeatureDisposer {
    return this.track({ kind: 'disposer', dispose })
  }

  /**
   * 逆序解绕本 feature 的全部注册。
   *
   * 一项抛错不阻断其余项 —— 半解绕的 feature 比全解绕危险得多。但错误也不
   * 吞：全部跑完后以 `AggregateError` 抛出（`shutdown` 路径上的静默失败正是
   * 这类基座最容易埋的雷）。
   *
   * 注意这里没有改用 `fiber.dispose()`：cordis 的 fiber 卸载是并行的、且把每
   * 一项的异常交给 logger 吞掉，两条都与本层钉死的语义相反。
   */
  async disposeAll(): Promise<void> {
    const errors: unknown[] = []
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const entry = this.entries[i]
      if (entry.disposed) continue
      entry.disposed = true
      try {
        await entry.dispose()
      } catch (error) {
        errors.push(error)
      }
    }
    this.entries.length = 0
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `[feature] "${this.featureId}" 卸载时有 ${errors.length} 项失败`,
      )
    }
  }

  /**
   * 当前注册项快照。
   *
   * 账本是本层自己记的，不从 cordis registry 反推：`fiber.getEffects()` 只给得
   * 出 `EffectMeta { label, children }`（一棵标签树），要还原「哪一项是 RPC 域、
   * 域名叫什么」只能反解字符串标签 —— 诚实优先，dump 的准确性不为「纯 cordis」
   * 让路。cordis 那边能提供的（effect 存活性、标签树）是本账本的交叉验证面，
   * 不是它的替代。
   */
  dump(): FeatureDump {
    const live = this.entries.filter(entry => !entry.disposed)
    return {
      id: this.featureId,
      registrations: {
        rpcDomain: live.filter(entry => entry.kind === 'rpcDomain').length,
        disposer: live.filter(entry => entry.kind === 'disposer').length,
      },
      rpcDomains: live
        .filter(entry => entry.kind === 'rpcDomain')
        .map(entry => entry.label as string),
    }
  }

  private track(entry: Omit<Entry, 'disposed'>): FeatureDisposer {
    // cordis effect：注销权从此归本 feature 的 fiber 所有。effect 的 execute
    // 只是把已有的 disposer 交出去（`() => dispose` 是 cordis 的 SyncEffect
    // 形状），拿回的 wrapper 是**单次生效**的 —— 重复调用是 no-op，并发调用
    // 汇入同一次 teardown。label 进 `fiber.getEffects()`，是 C4 自省的原料。
    const label = entry.label
      ? `feature(${this.featureId}):${entry.kind}:${entry.label}`
      : `feature(${this.featureId}):${entry.kind}`
    const inner = entry.dispose
    const wrapper = this.scope.effect(() => inner, label)

    const tracked: Entry = { ...entry, dispose: wrapper, disposed: false }
    this.entries.push(tracked)
    return async () => {
      // 幂等：调用方提前解绕过的项，disposeAll 不会再解一次。
      if (tracked.disposed) return
      tracked.disposed = true
      await tracked.dispose()
    }
  }
}
