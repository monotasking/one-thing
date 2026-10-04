/**
 * 检索这个功能的**唯一入口**(`@onething/backend/search`)。
 *
 * 功能目录之外(包根、别的功能、apps、scripts、evals)只许从这里拿名字;目录里其余文件都是内部实现,
 * 外面不许直接引用(`bun run entry:gate` 量这件事,规矩见 docs/design/server-client-split-2026-10.md §4「功能入口」)。
 *
 * 这里交出的东西分两类:
 * - 查询面与取材面:进程单槽的检索服务、取材适配器的形状、内置能力表与它们的端口、纯文本工具;
 * - 宿主装配与插件 API 要用的四个名字:`configureAppSearchProviders`(装取材面)、`createAppSearchService` /
 *   `unavailableIndexFace`(起服务 + 索引 Worker,或在没有索引时给一张答零结果的面)、插件 API 登记
 *   检索供给方的 `registerPluginSearchProvider`;外加 RPC 域要的两个内核类型 `CapabilityManifest` / `PreviewPayload`。
 *
 * **不从这里出口的**:Worker 的进程入口 `index/search-index-worker.ts`(顶层就开库,宿主的构建配方按文件路径指它)、
 * 嵌入运行时 `embedding/search-embedding-transformers-onnx.ts`(它动态 import 嵌入库,只许在 Worker 里被装载 —— 进了这里
 * 就会进主进程 bundle;`gate:search-index` ⑤d 按文本 grep 那个包名,所以这段说明故意不写出包名)。
 */
export * from './search-providers.js'
export * from './search-service.js'
export * from './search-service-bound.js'
export * from './capabilities/search-capabilities.js'
export * from './text/search-text-plain.js'
export { configureAppSearchProviders } from './search-install-providers.js'
export { createAppSearchService, unavailableIndexFace } from './search-service-setup.js'
export { registerPluginSearchProvider } from './search-plugin-registry.js'
export type { CapabilityManifest, PreviewPayload } from './kernel/search-kernel.js'
