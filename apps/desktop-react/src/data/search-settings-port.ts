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
  return {
    ready: () => whenConnected(),
    readSettings: () => api.getSettings({}),
    saveSettings: (settings) => api.saveSettings(settings),
  }
}

let pending: Promise<SearchSettingsPort> | undefined

export function searchSettingsPort(): Promise<SearchSettingsPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}
