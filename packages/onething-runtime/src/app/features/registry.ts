/**
 * feature 挂载表（内核收缩 K0，docs/design/kernel-shrink-builtin-plugins-2026-08.md §1 D2）。
 *
 * `mountFeature` 是装配序列调用的那一行：执行 feature 的 `mount`，把它在
 * `FeatureContext` 上留下的全部注册记进本表，返回一个**只卸载这个 feature**
 * 的函数。
 *
 * 明确不做的事（K0 的边界，写在这里免得下一个人顺手加）：
 * - **不解析依赖、不排序**。挂载顺序 = 调用顺序 = `backend.ts` 里写死的顺序。
 * - **不自动重挂**。卸载了就是卸载了，要回来就再 `mountFeature` 一次。
 *
 * 重复 id 直接 throw 而不是后来者覆盖：同一个 id 两份实现同时在线，是接线
 * bug 的确定信号，静默留下其中一份正是这张表要防的事（与 RPC 注册表的域重
 * 复守卫同一判例）。
 *
 * import 零副作用：表在加载时是空的，只有显式 `mountFeature` 才会填。
 */
import { FeatureContextImpl, type FeatureContext, type FeatureDump } from './context.js'

/** 一个 feature 的定义。id 全局唯一，`mount` 只在挂载时跑一次。 */
export interface FeatureDefinition {
  /** 全局唯一。约定用 `<域>:<名>` 形式，如 `rpc:usage`。 */
  id: string
  mount: (ctx: FeatureContext) => void | Promise<void>
}

/** 卸载一个已挂载的 feature。幂等：重复调用（或已被卸载）直接返回。 */
export type FeatureUnmount = () => Promise<void>

const mounted = new Map<string, FeatureContextImpl>()

/**
 * 挂载一个 feature，返回它的卸载函数。
 *
 * `mount` 抛错时：本 feature 已经落地的注册会被逆序解绕，id 退出挂载表，错
 * 误原样抛给调用方。半挂载的 feature 留在表里，比装配直接失败危险得多。
 */
export async function mountFeature(definition: FeatureDefinition): Promise<FeatureUnmount> {
  const { id } = definition
  if (mounted.has(id)) {
    throw new Error(
      `[feature] "${id}" is already mounted. Unmount it before mounting again.`,
    )
  }
  const ctx = new FeatureContextImpl(id)
  // 先占位再 mount：一个 feature 的 mount 里若（直接或间接）再挂一次同名
  // feature，重复守卫必须能看见它。
  mounted.set(id, ctx)
  try {
    await definition.mount(ctx)
  } catch (error) {
    mounted.delete(id)
    await ctx.disposeAll().catch(() => {
      // 回滚过程中的次生错误不能盖掉 mount 的首错 —— 那才是要看的那一个。
    })
    throw error
  }

  return async () => {
    // 只卸自己：这个 id 若已被后来的挂载占用，那份不归本函数管。
    if (mounted.get(id) !== ctx) return
    mounted.delete(id)
    await ctx.disposeAll()
  }
}

/**
 * 当前挂载的 feature 与它们各自的注册项清单。
 *
 * 对齐 dsh `--dump-config` 的可观测性，但输出的是**注册表**不是配置树。K0
 * 阶段它只是一个内部函数（由单测覆盖）—— 开发者出口属于壳改动，主线 T 正
 * 在做的就是减少壳面，不为一条诊断线现开一条通道。
 */
export function dumpFeatures(): FeatureDump[] {
  return [...mounted.values()].map(ctx => ctx.dump())
}

/** 某个 feature 当前是否挂着。诊断与测试用。 */
export function hasFeature(id: string): boolean {
  return mounted.has(id)
}

/**
 * 清空挂载表。**测试专用**，且**不跑任何 disposer** —— 生产路径永远走
 * `mountFeature` 返回的卸载函数。
 */
export function resetFeaturesForTests(): void {
  mounted.clear()
}
