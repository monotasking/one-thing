/**
 * 检索取材面的**装配点**(进程单槽)。
 *
 * S5(2026-09-05)之前这个文件还有第二件事:`executeSearch` —— 旧扫描路的门面
 * (`switch(category)` 那条路 + 插件结果并入)。旧路退役之后查询只剩一条:
 * `rpc/domains/search.ts` → 进程单槽里那份 `SearchService` → 注册表 → 能力。
 * 于是这里只剩装配:把宿主的取材面装进 runtime 的进程单槽。
 *
 * 那个单槽只服务于两个**不带参数**被调到的口(`resolveDailyNoteSearchDirs()` 与
 * 下面这只 `createDailyNote`);查询路一律把取材面当参数递
 * (`createAppSearchService` 现造一份给六个能力),因为 server 那侧的取材面是
 * per-owner 的,组不出进程单例。
 */
import { configureOnethingSearchProviders } from '@onething/runtime/search'
import { createDailyNote as createRuntimeDailyNote } from '@onething/runtime/search/capabilities'
import { createAppSearchProvidersAdapters } from './adapters.js'

let searchProvidersConfigured = false

/** Explicit assembly step; also self-ensured by this module's wrapper. */
export function configureAppSearchProviders(): void {
  if (searchProvidersConfigured) return
  searchProvidersConfigured = true
  configureOnethingSearchProviders(createAppSearchProvidersAdapters())
}

/** 「新建今天的日记」按下去那一下。取材面来自上面那个单槽。 */
export function createDailyNote(filePath: string): Promise<string> {
  configureAppSearchProviders()
  return createRuntimeDailyNote(filePath)
}
