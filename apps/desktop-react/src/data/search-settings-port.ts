import { searchRouter, type SearchModelResponse, type SearchStorageResponse } from '@shared/ipc/search'
import {
  settingsRouter,
  type AppSettings,
  type GetSettingsResponse,
  type SaveSettingsResponse,
} from '@shared/ipc/settings'

/**
 * 设置页「搜索」那一页与 core 之间的那一层**端口**。
 *
 * 判例与 `browser-settings-port` 逐条相同(那份文件头写的三条理由这里一条不差):
 * 形状是**平台调用面的子集**、不是新契约;存在的唯一理由是**可测**;整份写回时
 * 一律「当场读一份新的 → 合并一格 → 整份写回」,不拿缓存里那份当底本。
 *
 * ── 为什么不挂到 `browser-settings-port` 上 ──────────────────────────────
 * 那两口(`readSettings` / `saveSettings`)长得一模一样,但它们是**同一个平台调用面
 * 被两个数据源各用了一次**,不是一份可以共享的契约。合起来的后果是「内置浏览器」
 * 那一节的测试替身会顺手替掉这一页的取数 —— 两页共用一个替身之后,谁也说不清某个
 * 用例在替谁。
 *
 * ── 索引状态**不在这条端口上** ──────────────────────────────────────────
 * 这一页要的第三样东西是 `search.status`(向量路在干什么)。它已经有产地 ——
 * 检索面那一格 `searchStatusQuery`(`search-catalog-source.ts`)。再给它开第二条口
 * 就是第二份真相:同一台索引的状态在屏幕上会有两个答案。
 */
export interface SearchSettingsPort {
  /** 传输面就绪(D0 的 whenConnected);浏览器直开时它也会 resolve。 */
  ready(): Promise<unknown>
  /** 整份应用设置。这一页只要 `search.semantic` 那一格。 */
  readSettings(): Promise<GetSettingsResponse>
  /** 整份写回。见文件头。 */
  saveSettings(settings: AppSettings): Promise<SaveSettingsResponse>
  /**
   * ── 模型那三个动作(2026-09-17)──────────────────────────────────────
   *
   * 它们走的是 **`search` 域**,不是 settings —— 模型不是一格设置,它是一件东西
   * (用户裁定「把开关和下载模型拆开」)。放在这条端口上而不是 `search-port` 上的
   * 理由与这份文件头第一条相同:**这一页的写路要能被这一页的用例整只换掉**;
   * `search-port` 是检索面那一族的窄面,它的替身不该顺手替掉这里的三颗钮。
   *
   * **读路不在这里**:模型状态跟着 `search.status` 一起回来(`searchStatusQuery`),
   * 那是同一份真相的同一个产地。
   *
   * `download` **不等下完就答**(112.8 MB 冷下 191 秒),回执是起了这一发之后那一刻
   * 的状态;之后的进度由那只 1s 轮询读。
   */
  downloadModel(): Promise<SearchModelResponse>
  cancelModelDownload(): Promise<SearchModelResponse>
  removeModel(): Promise<SearchModelResponse>
  /**
   * ── 占了多少地方(2026-09-18)────────────────────────────────────────
   *
   * 也走 `search` 域。**读路在这里而不是跟着 `search.status` 走**,与模型那三格的
   * 理由正好相反:模型状态每秒都要问、检索面自己也在订它,所以它跟着那一格;而
   * 这一发要去扫库(真店 48.7ms 冷 / 0.5ms 热),问它的**只有这一页**,而且是
   * 「进页问一次、有东西变了再问一次」。并进那一格就等于让每一次轮询都去扫一遍库。
   */
  storage(): Promise<SearchStorageResponse>
}

let port: SearchSettingsPort | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureSearchSettingsPort(next: SearchSettingsPort | undefined): void {
  port = next
  pending = undefined
}

/** 真实现是**惰性**建的,理由与 `browser-settings-port` 逐字相同。 */
async function realPort(): Promise<SearchSettingsPort> {
  const { onethingClient, whenConnected } = await import('../platform/connection')
  const client = await onethingClient()
  const api = client.api(settingsRouter)
  const search = client.api(searchRouter)
  return {
    ready: () => whenConnected(),
    readSettings: () => api.getSettings({}),
    saveSettings: (settings) => api.saveSettings(settings),
    downloadModel: () => search.semanticModelDownload({}),
    cancelModelDownload: () => search.semanticModelCancel({}),
    removeModel: () => search.semanticModelRemove({}),
    storage: () => search.storage({}),
  }
}

let pending: Promise<SearchSettingsPort> | undefined

export function searchSettingsPort(): Promise<SearchSettingsPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}
