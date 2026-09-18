import { filesRouter, type FilesStatResponse } from '@shared/ipc/files'
import { notesRouter, type NotesListResponse, type NotesOpenInAppResponse } from '@shared/ipc/notes'
import { IPC_CHANNELS } from '@shared/ipc/channels'
import {
  settingsRouter,
  type AppSettings,
  type GetSettingsResponse,
  type SaveSettingsResponse,
} from '@shared/ipc/settings'

/**
 * 设置页「笔记」那一页与 core 之间的那一层**端口**(P4)。
 *
 * 判例与 `search-settings-port` / `browser-settings-port` 逐条相同(那两份文件头
 * 写的三条理由这里一条不差):形状是**平台调用面的子集**、不是新契约;存在的
 * 唯一理由是**可测**;整份写回一律「当场读一份新的 → 合一格 → 整份写回」,
 * 不拿缓存里那份当底本。
 *
 * ── 为什么不挂到 `search-settings-port` 上 ──────────────────────────────
 * 那两口(`readSettings` / `saveSettings`)与这里长得一模一样,但它们是**同一个
 * 平台调用面被两个数据源各用了一次**,不是一份可以共享的契约。合起来的后果是
 * 「搜索」那一页的测试替身会顺手替掉这一页的取数 —— 两页共用一个替身之后,
 * 谁也说不清某个用例在替谁。
 *
 * ── `stat` 为什么在这条端口上 ────────────────────────────────────────────
 * 「添加目录…」收下一条路径之后要回答一句「这个目录在吗」。那一发走的是既有的
 * `files.stat`(它顺手把 `~` 展开并回真正 stat 到的绝对路径 —— 正是要存进
 * `settings.notes.folders` 的那一份),**不给 notes 域加第四条路**:判一条路径
 * 存不存在不是笔记领域的知识。
 *
 * ── 没有「写笔记设置」这一口 ─────────────────────────────────────────────
 * 这一页的每一次改动都落在 `settings.notes` 里,所以写路只有 `saveSettings`
 * 一条。notes 域是**只读的 + 一个前台动作**(判词在
 * `packages/backend/rpc/domains/notes.ts` 文件头)。
 */
export interface NotesPort {
  /** 传输面就绪(D0 的 whenConnected);浏览器直开时它也会 resolve。 */
  ready(): Promise<unknown>
  /** 名册全貌。只读,一条 CLI 命令都不发。 */
  list(): Promise<NotesListResponse>
  /** 先让后端重问一遍驱动,再答同一份。给「我刚在 Obsidian 里新建了一个库」那一下。 */
  refresh(): Promise<NotesListResponse>
  /** 在原生 app 里打开。**这条端口上唯一的前台动作**;P4 的壳还没有按钮调它(P5 的行动作)。 */
  openInApp(vaultId: string, path?: string): Promise<NotesOpenInAppResponse>
  /** 整份应用设置。这一页只要 `notes` 那一格。 */
  readSettings(): Promise<GetSettingsResponse>
  /** 整份写回。见文件头。 */
  saveSettings(settings: AppSettings): Promise<SaveSettingsResponse>
  /** 认一条路径(`~` 会被展开)。用处只有一个:判「这个目录在吗」。 */
  stat(path: string): Promise<FilesStatResponse>
  /**
   * 设置变更的推送面。别的面 / 别的客户端改了设置(比如 P2 的检索面把某个库
   * 关掉),这一页要跟着变 —— 收到就 `invalidate()`,让 query 自己回后台对账。
   *
   * 返回退订函数。
   */
  onSettingsChanged(callback: () => void): () => void
}

let port: NotesPort | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureNotesPort(next: NotesPort | undefined): void {
  port = next
  pending = undefined
}

/**
 * 真实现是**惰性**建的,理由与 `browser-settings-port` 逐字相同:它要的是那个
 * 连通之后才存在的客户端,而端口被换掉的测试根本不该把连通面拖进来。
 */
async function realPort(): Promise<NotesPort> {
  const { onethingClient, whenConnected } = await import('../platform/connection')
  const client = await onethingClient()
  const notes = client.api(notesRouter)
  const settings = client.api(settingsRouter)
  const files = client.api(filesRouter)
  return {
    ready: () => whenConnected(),
    list: () => notes.list({}),
    refresh: () => notes.refresh({}),
    openInApp: (vaultId, path) => notes.openInApp(path === undefined ? { vaultId } : { vaultId, path }),
    readSettings: () => settings.getSettings({}),
    saveSettings: (next) => settings.saveSettings(next),
    stat: (path) => files.stat({ path }),
    onSettingsChanged: (callback) =>
      client.events.on(IPC_CHANNELS.SETTINGS_CHANGED, () => callback()),
  }
}

let pending: Promise<NotesPort> | undefined

export function notesPort(): Promise<NotesPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}
