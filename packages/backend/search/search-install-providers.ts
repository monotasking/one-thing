/**
 * 检索取材面的**装配点**(进程单槽)。
 *
 * S5(2026-09-05)之前这个文件还有第二件事:`executeSearch` —— 旧扫描路的门面
 * (`switch(category)` 那条路 + 插件结果并入)。旧路退役之后查询只剩一条:
 * `search/search-client-api.ts` → 进程单槽里那份 `SearchService` → 注册表 → 能力。
 * 于是这里只剩装配:把宿主的取材面装进 runtime 的进程单槽。
 *
 * **P2 之后那个单槽一个读者都没有了**:它从前只服务两个不带参数被调到的口
 * (`resolveDailyNoteSearchDirs()` / `createDailyNote()`),而「建一篇笔记」这件事
 * 今天走 `NoteVault` 自己。查询路一律把取材面当参数递(`createAppSearchService`
 * 现造一份给六个能力),因为 server 那侧的取材面是 per-owner 的,组不出进程单例。
 * 退役这个单槽要动 `configureAppRuntimeAdapters` 那张表,不在本单 —— 见报告留账。
 */
import { configureOnethingSearchProviders } from './search-providers.js'
import { createAppSearchProvidersAdapters } from './search-adapters.js'

let searchProvidersConfigured = false

/**
 * Explicit assembly step; also self-ensured by this module's wrapper.
 *
 * `configure` 只给测试用:装配从不传它。从前这里经功能入口取 `configureOnethingSearchProviders`,
 * 测试在入口上换掉它就能数到「装了几次」;这个文件进了入口以后再从入口取就成了入口自引用,
 * 换掉的那份够不着这里,所以改成把「真正去装的那一步」当参数递进来。
 */
export function configureAppSearchProviders(
  configure: typeof configureOnethingSearchProviders = configureOnethingSearchProviders,
): void {
  if (searchProvidersConfigured) return
  searchProvidersConfigured = true
  configure(createAppSearchProvidersAdapters())
}
