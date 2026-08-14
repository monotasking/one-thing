/**
 * 装配层的 cordis 根 Context（C0 底座替换，
 * docs/design/cordis-adoption-2026-08.md §2）。
 *
 * 「改为 Cordis」的落点只有这一个：`@onething/app` 装配层内部持有一个 cordis
 * 应用，feature = cordis plugin，注册的可逆性由 fiber/effect 承载。边界是硬的
 * —— `packages/core`、runtime 产品层、各 host 一概不感知 cordis（boundary
 * checker 有对应规则）。
 *
 * **惰性创建**是契约不是优化：`src/app/__tests__/import-side-effect-free.test.ts`
 * 要求 import 本模块（乃至整棵 features/）不产生任何全局状态。所以 Context 只
 * 在第一次 `mountFeature` 时才生。
 *
 * 这里**不注册任何 service**。C0 的宪法是行为零变化，装配顺序仍由调用方（
 * `rpc/index.ts` 的循环、`backend.ts` 的调用序）决定，不引入 `inject` 依赖激活
 * —— 那是 C1 的事。
 */
import { Context } from '@deepseek-ai/cordis'

let root: Context | undefined

/** 装配层的根 Context。首次调用时创建。 */
export function getFeatureRootContext(): Context {
  return (root ??= new Context())
}

/**
 * 丢弃当前根 Context。**测试专用**。
 *
 * 刻意**不** dispose —— K0 契约里 `resetFeaturesForTests()` 是「清表，不跑任何
 * disposer」。被丢下的 Context 连同它的 fiber 一起变成垃圾（cordis 的 Context
 * 不持有定时器、不挂 process 监听，丢弃是安全的）；生产路径永远走
 * `mountFeature` 返回的卸载函数。
 */
export function dropFeatureRootContextForTests(): void {
  root = undefined
}
