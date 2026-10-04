/**
 * ambient —— 环境信息(时钟、天气……):每一种是一个自述的「环境源」,合起来作为 `ambient:` 资源交给资源面。
 *
 * 对外交出两类东西:
 * - 环境源的形状 `AmbientSource` 与内置的那几只(`defaultAmbientSources`);
 * - `ambient:` 资源的规格与它的两个地址常量。
 * 依赖 settings(天气源借它的受管 fetch)。
 */
export type { AmbientSource } from './ambient-source.js'
export { defaultAmbientSources } from './ambient-sources.js'
export { AMBIENT_HERE_PATH, AMBIENT_RESOURCE_SCHEME, ambientResourceSpecFor } from './ambient-resource-spec.js'
