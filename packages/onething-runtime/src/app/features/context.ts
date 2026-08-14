/**
 * `FeatureContext` — 可逆注册基座的注册面（内核收缩 K0，
 * docs/design/kernel-shrink-builtin-plugins-2026-08.md §1 D2）。
 *
 * 它**不是**新框架，也不解析依赖：装配顺序仍然由 `backend.ts` 里那串写死的
 * 调用负责（这是我们与 Cordis/dsh 的清醒分界 —— 先要**可卸载**，不要
 * **自动排序**）。这一层只做一件事：把散落在装配流程里的注册调用收拢，并
 * 给每一个配上注销。
 *
 * 两条设计约束：
 *
 * 1. **每个 register* 都返回 disposer**，且该 disposer 幂等 —— 调用方可以
 *    自己提前解绕某一项，`disposeAll()` 不会再解一次。
 * 2. **`disposeAll()` 逆序**：后注册的先解。注册顺序天然带着依赖方向（后者
 *    可能建立在前者之上），逆序解绕镜像的是 dispose 的通行惯例，也是唯一
 *    不需要依赖图就正确的顺序。
 *
 * K0 刻意做小：这里**只有两个注册面** —— `registerRpcDomain`（走既有
 * `app/rpc/registry`）与 `registerDisposer`（通用逃生舱，任何已经可逆的副作
 * 用都能先挂进来）。工具 / 变量 / 斜杠命令的专用 register 面不预雕，按 D3
 * 规则等 K2/K3 迁移功能时由差距清单驱动逐个加。
 *
 * import 零副作用：本模块加载时不注册任何东西（见
 * `src/app/__tests__/import-side-effect-free.test.ts`）。
 */
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
  dispose: FeatureDisposer
  disposed: boolean
}

/**
 * `FeatureContext` 的实现。只由 `mountFeature` 构造 —— feature 作者拿到的是
 * 接口，拿不到 `disposeAll`（谁挂载谁负责卸载）。
 */
export class FeatureContextImpl implements FeatureContext {
  readonly featureId: string
  private readonly entries: Entry[] = []

  constructor(featureId: string) {
    this.featureId = featureId
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

  /** 当前注册项快照。 */
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
    const tracked: Entry = { ...entry, disposed: false }
    this.entries.push(tracked)
    return async () => {
      // 幂等：调用方提前解绕过的项，disposeAll 不会再解一次。
      if (tracked.disposed) return
      tracked.disposed = true
      await tracked.dispose()
    }
  }
}
