/**
 * feature 挂载表。底座是 cordis（C0，`docs/design/cordis-adoption-2026-08.md`）：
 * 一个 feature = 根 Context 上的一个 cordis plugin，它的 fiber 就是这个 feature
 * 的 scope，注册项作为 fiber 的 effect 落地。
 *
 * `mountFeature` 是装配序列调用的那一行：起一个 plugin，在它的 fiber context 上
 * 执行 feature 的 `mount`，把留下的全部注册记进本表，返回一个**只卸载这个
 * feature** 的函数。
 *
 * 明确不做的事（边界，写在这里免得下一个人顺手加）：
 * - **不解析依赖、不排序**。挂载顺序 = 调用顺序 = `backend.ts` 里写死的顺序。
 *   cordis 的 `inject` 依赖激活**没有启用**，根 Context 上也**没有注册任何
 *   service** —— 那是 C1 的对表工作。
 * - **不自动重挂**。卸载了就是卸载了，要回来就再 `mountFeature` 一次。
 *   （cordis 的 `fiber.restart()` / `update()` 同样按下不表。）
 *
 * 重复 id 直接 throw 而不是后来者覆盖：同一个 id 两份实现同时在线，是接线
 * bug 的确定信号，静默留下其中一份正是这张表要防的事（与 RPC 注册表的域重
 * 复守卫同一判例）。cordis 的 registry 以 plugin 的 callback 作身份键，天然不
 * 认识我们的 id —— 这道守卫是本表自己的，换底座后依旧由本表把。
 *
 * import 零副作用：表在加载时是空的、根 Context 也还没生，只有显式
 * `mountFeature` 才会填。
 */
import type { EffectMeta, Fiber } from '@deepseek-ai/cordis'
import { FeatureContextImpl, type FeatureContext, type FeatureDump } from './context.js'
import { dropFeatureRootContextForTests, getFeatureRootContext } from './cordis-root.js'

/** 一个 feature 的定义。id 全局唯一，`mount` 只在挂载时跑一次。 */
export interface FeatureDefinition {
  /** 全局唯一。约定用 `<域>:<名>` 形式，如 `rpc:usage`。 */
  id: string
  mount: (ctx: FeatureContext) => void | Promise<void>
}

/** 卸载一个已挂载的 feature。幂等：重复调用（或已被卸载）直接返回。 */
export type FeatureUnmount = () => Promise<void>

/** 挂载表的一行：注册面 + 承载它的 cordis fiber。 */
interface MountedFeature {
  /** feature 的注册账本。plugin 的 apply 跑起来之前是 undefined。 */
  ctx?: FeatureContextImpl
  /** 本 feature 的 cordis plugin fiber。同上，起来之后才有。 */
  fiber?: Fiber
}

const mounted = new Map<string, MountedFeature>()

/**
 * 挂载一个 feature，返回它的卸载函数。
 *
 * `mount` 抛错时：本 feature 已经落地的注册会被逆序解绕，fiber 一并 dispose，
 * id 退出挂载表，错误原样抛给调用方。半挂载的 feature 留在表里，比装配直接失
 * 败危险得多。
 *
 * 注意 `mount` 的异常是在 plugin 的 `apply` 内部**接住**的，不让它冒进 cordis
 * 的 fiber：cordis 对启动失败的处理是 `logger.error` + 并行 `_unload`，两条都
 * 会改变 K0 钉死的行为（首错原样抛出、回滚逆序、过程静默）。
 */
export async function mountFeature(definition: FeatureDefinition): Promise<FeatureUnmount> {
  const { id } = definition
  if (mounted.has(id)) {
    throw new Error(
      `[feature] "${id}" is already mounted. Unmount it before mounting again.`,
    )
  }
  const record: MountedFeature = {}
  // 先占位再 mount：一个 feature 的 mount 里若（直接或间接）再挂一次同名
  // feature，重复守卫必须能看见它。
  mounted.set(id, record)

  let mountFailure: { error: unknown } | undefined
  let fiber: Fiber
  try {
    // 每次挂载都是一份新的 plugin 对象 —— cordis 以 `apply` 的函数身份作
    // registry 键，新对象 = 独立的 runtime 记录，卸载时连记录一起回收。
    fiber = await getFeatureRootContext().plugin({
      name: `feature:${id}`,
      async apply(scope) {
        record.ctx = new FeatureContextImpl(id, scope)
        try {
          await definition.mount(record.ctx)
        } catch (error) {
          mountFailure = { error }
        }
      },
    })
  } catch (error) {
    mounted.delete(id)
    throw error
  }
  record.fiber = fiber

  if (mountFailure) {
    mounted.delete(id)
    await record.ctx?.disposeAll().catch(() => {
      // 回滚过程中的次生错误不能盖掉 mount 的首错 —— 那才是要看的那一个。
    })
    await fiber.dispose()
    throw mountFailure.error
  }

  return async () => {
    // 只卸自己：这个 id 若已被后来的挂载占用，那份不归本函数管。
    if (mounted.get(id) !== record) return
    mounted.delete(id)
    let failure: { error: unknown } | undefined
    try {
      await record.ctx?.disposeAll()
    } catch (error) {
      failure = { error }
    }
    // 账本已经逐项解绕完（effect wrapper 自会把自己从 fiber 摘掉），这一步收
    // 的是 fiber 本身：把 plugin 从 cordis registry 里摘掉，顺带兜住任何绕过
    // 本层留下的 effect。
    await fiber.dispose()
    if (failure) throw failure.error
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
  return [...mounted.values()]
    .map(record => record.ctx?.dump())
    .filter((dump): dump is FeatureDump => dump !== undefined)
}

/** 某个 feature 当前是否挂着。诊断与测试用。 */
export function hasFeature(id: string): boolean {
  return mounted.has(id)
}

/** `dumpFeatureEffects()` 的一行:一个 feature 与它 fiber 上的 effect 标签树。 */
export interface FeatureEffectDump {
  id: string
  /** cordis `Fiber.getEffects()` 的原样输出(`{ label, children }` 递归树)。 */
  effects: EffectMeta[]
}

/**
 * 每个 feature 的 cordis effect 标签树。**`dumpFeatures()` 的交叉验证面**,
 * 不是它的替代(C0 §5.2 已钉死:账本准确性不为「纯 cordis」让路)。
 *
 * 两份 dump 的分工:`dumpFeatures()` 说的是「注册了几项、都是什么种类」——
 * 那是适配层自己的账本,类型信息完整;这一份说的是「fiber 上现在还活着哪些
 * effect」——那是 cordis 的真相,标签是字符串。**两份对不上,就是账本漏记或
 * 有人绕过了适配层**,而这正是 C4 自省要看的东西:模型现场挂进来的 feature,
 * 它的注册到底落在了哪。
 *
 * 拿不到 fiber 的行(plugin 的 apply 还没跑完)整行略过,与 `dumpFeatures()`
 * 的同款处理 —— 半挂载的中间态不进诊断输出。
 */
export function dumpFeatureEffects(): FeatureEffectDump[] {
  const dumps: FeatureEffectDump[] = []
  for (const [id, record] of mounted) {
    if (!record.fiber) continue
    dumps.push({ id, effects: record.fiber.getEffects() })
  }
  return dumps
}

/**
 * 清空挂载表。**测试专用**，且**不跑任何 disposer** —— 生产路径永远走
 * `mountFeature` 返回的卸载函数。连同根 Context 一起丢弃（同样不 dispose）。
 */
export function resetFeaturesForTests(): void {
  mounted.clear()
  dropFeatureRootContextForTests()
}
