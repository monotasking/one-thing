/**
 * 可逆注册基座的对外面（内核收缩 K0）。
 *
 * 装配层（`backend.ts` 及各 feature 的定义文件）只从这里进。
 */
export {
  FeatureContextImpl,
  type FeatureContext,
  type FeatureDisposer,
  type FeatureDump,
} from './context.js'
export {
  dumpFeatures,
  hasFeature,
  mountFeature,
  resetFeaturesForTests,
  type FeatureDefinition,
  type FeatureUnmount,
} from './registry.js'
