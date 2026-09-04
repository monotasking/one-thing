/**
 * Search Everywhere — 装配。
 *
 * 设计:docs/design/search-index-2026-09.md §3 落位表最后一行
 * (「装配:… 注册六个能力 + 插件能力」)/ §10 S2 行。
 *
 * 这个文件就是「加一类 = 一个文件 + **一行注册**」里的那一行住的地方。它做四件事:
 *  ① 用宿主的适配器造一份带六个内置能力的 `SearchService`(能力清单来自
 *     `@onething/runtime/search/capabilities` 的那张表,这里不点名任何一类);
 *  ② 把已在册的插件供给方接成 `remote` 能力(§4.2 第四行);
 *  ③ 把服务装进进程单槽(`@onething/runtime/search/service-bound`)——
 *     `rpc/domains/search.ts` 从那里读;
 *  ④ 返回**一个** disposer,装配层 `own()` 它,于是 `backend.dispose()` 把这三件
 *     逆序放回去。
 *
 * S3 起这里还要多起一件事:`SearchIndexService`(Worker)、账本观察者、总线订阅;
 * 那时 messages / chats / daily 三条换成 `indexedCapability`,而这个文件的形状不变。
 */

import {
  createOnethingSearchService,
  type OnethingSearchService,
} from '@onething/runtime/search/service'
import { configureOnethingSearchService } from '@onething/runtime/search/service-bound'
import { getLogger } from '../logging/index.js'
import { createAppSearchProvidersAdapters } from './adapters.js'
import { syncPluginSearchCapabilities } from './plugin-search-registry.js'

export { createDailyNote, executeSearch } from './providers.js'

const log = getLogger('search')

export interface AppSearchServiceHandle {
  service: OnethingSearchService
  dispose(): void
}

export function createAppSearchService(): AppSearchServiceHandle {
  const service = createOnethingSearchService(createAppSearchProvidersAdapters(), {
    // §6.4b 的兜底核验:候选逃出可见范围是「能力实现有 bug」的证据,记 warn 不抛。
    warn: (message, detail) => log.warn(message, detail),
  })
  const unsyncPlugins = syncPluginSearchCapabilities(service)
  const restoreSlot = configureOnethingSearchService(service)

  return {
    service,
    dispose() {
      restoreSlot()
      unsyncPlugins()
    },
  }
}
