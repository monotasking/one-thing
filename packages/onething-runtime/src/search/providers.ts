/**
 * 检索的**取材面** —— 六个内置能力向宿主要的那几件东西,一张接口 + 一个进程单槽。
 *
 * 设计:docs/design/search-index-2026-09.md §3 落位表 / §4.4。
 *
 * S5(2026-09-05)之前这个文件还装着旧扫描路的六个扫描器(`searchChats` /
 * `searchMessages` / `searchActions` / `searchPrompts` / `searchFiles` /
 * `searchDailyNotes`)与它们的入口 `executeSearch`。旧路退役之后:
 *
 *  - `chats` / `messages` / `daily` 三条已经是索引型,匹配这件事根本不在这一层;
 *  - `actions` / `prompts` / `files` 三条的匹配器搬进了各自的
 *    `capabilities/<id>.ts` —— **一类 = 一个文件**;
 *  - 每日笔记的配置、「今天那一条」与建文件搬进了 `capabilities/daily-notes.ts`。
 *
 * 于是这里只剩下**接口**:能力问宿主要会话表 / 会话消息 / 设置 / 变量仓 /
 * 文件列举 / 提示词表,宿主(桌面装配、server 按 owner、单测的假件)各给一份。
 *
 * ## 那个进程单槽
 *
 * `configureOnethingSearchProviders` 装的是**这台进程的**取材面,只服务于两个
 * 不带参数被调到的口:`resolveDailyNoteSearchDirs()` 与 `createDailyNote()`
 * (搜索结果上「新建今天的日记」按下去那一下)。真正的查询路一律**把 adapters
 * 当参数递**(`createBuiltinSearchCapabilities(adapters, index)`),因为 server
 * 那一侧的取材面是 per-owner 的,组不出进程单例。
 */

export interface OnethingSearchSessionMeta {
  id: string
  name?: string
  previewText?: string
  isArchived?: boolean
  updatedAt: number
  /**
   * 这间会话有多少条消息(`session-overview` 预览那一格,S4a 加)。
   *
   * 它**不是新读数**:会话列表投影本来就维护 `SessionMeta.messageCount`
   * (`core/session/store-helpers.ts`),宿主交下来的对象上一直有这一格,
   * 只是从前这份收窄的形没有声明它。缺席 = 那台宿主的会话表不带这一格
   * (单测里的假 adapters 就是),预览按 0 画,**不去数账本补**。
   */
  messageCount?: number
}

export interface OnethingSearchMessage {
  id: string
  role?: string
  content?: unknown
  timestamp?: number
}

/**
 * `getSession` 的返回:搜索只从会话上要**空间语境**(工作目录),不要消息。
 * 消息一律走 `iterateSessionMessages`(P0.2 区 ②;P0.4 起是必填端口,raw 回落已删)。
 */
export interface OnethingSearchSession {
  workingDirectory?: string
}

export interface OnethingSearchPrompt {
  id: string
  title: string
  description?: string
  body: string
  tags?: string[]
  updatedAt: number
}

export interface OnethingSearchVariablesStore {
  getUserNoteDir(): string | undefined
  getWorkNoteDir(): string | undefined
}

export interface OnethingDailyNoteSettings {
  enabled?: boolean
  directoryMode?: 'personal' | 'custom' | string
  customDirectory?: string
  useObsidianConfig?: boolean
  format?: string
}

export interface OnethingSearchSettings {
  general: {
    dailyNotes?: OnethingDailyNoteSettings
  }
}

export interface OnethingSearchListFilesOptions {
  cwd: string
  glob?: string[]
  hidden?: boolean
  noIgnore?: boolean
}

export interface OnethingSearchProvidersAdapters {
  getSessionsList(): OnethingSearchSessionMeta[]
  /**
   * 按会话取消息(`messages` 那一类的**预览**要读命中那条前后各两条)。
   * **raw 语义**:不进 LRU、不 sanitize、不回写。宿主接
   * `sessionReads.iterateMessagesRaw`。
   */
  iterateSessionMessages(sessionId: string): Iterable<OnethingSearchMessage>
  getSession(sessionId: string): OnethingSearchSession | undefined
  getCurrentSessionId(): string | undefined
  getSettings(): OnethingSearchSettings
  getVariablesStore(): OnethingSearchVariablesStore
  /** 用户配置的「接入目录」;缺席/空数组 = 搜索根与没有这个功能时一致。 */
  getConnectedDirectories?(): string[]
  listFiles(options: OnethingSearchListFilesOptions): AsyncIterable<string>
  listPrompts(): OnethingSearchPrompt[]
}

let configuredAdapters: OnethingSearchProvidersAdapters | undefined

export function configureOnethingSearchProviders(adapters: OnethingSearchProvidersAdapters): void {
  configuredAdapters = adapters
}

/** 递了就用递的那份;没递就用这台进程装配的那份;都没有是**结构化的错**。 */
export function getSearchAdapters(
  adapters?: OnethingSearchProvidersAdapters,
): OnethingSearchProvidersAdapters {
  const resolved = adapters ?? configuredAdapters
  if (!resolved) throw new Error('Onething search providers are not configured')
  return resolved
}
