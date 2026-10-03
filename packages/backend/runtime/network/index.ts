/**
 * 网络件的入口(包根归位 3 第 1 笔,2026-10-03)。
 *
 * 这个功能管两件事:代理设置的校验、规整与绕行规则(`proxy.ts`),以及按代理设置选 dispatcher、
 * 绑上超时 / 重试 / 中止转发的受管 fetch(`managed-fetch.ts`)。两只文件从前住在 `runtime/providers/`,
 * 但它们与服务商无关:服务商、设置自检、索引 Worker 的模型下载都用它们。
 *
 * 这里刻意不 import 设置:索引 Worker(`search/index/worker-network.ts`)也从这个入口拿受管 fetch,
 * 入口闭包一变大,三份 `search-worker.cjs` 就跟着变大。「按用户设置里的代理去请求」的那层薄壳在
 * `runtime/settings/proxy-fetch.ts`,经设置入口交出。
 *
 * 下面列的是外面真在用的名字。
 */
export {
  validateOnethingProxyUrl,
  type OnethingProxySettings,
} from './proxy.js'
export {
  clearOnethingAppDispatcherCache,
  createOnethingAppFetch,
  createRequiredOnethingAppFetch,
  validateOnethingAppProxyUrl,
  type OnethingFetchFn,
  type OnethingHttpPolicyName,
  type OnethingHttpRequestOptions,
} from './managed-fetch.js'
