import { create } from 'zustand'
import type { FileEntryType, FileSearchEntry, FilesListResponse } from '@shared/ipc/files'
import { filesPort } from './files-port'

/**
 * `@` 引用的候选**真数据源**(D3 波二)。
 *
 * 它与 `data/files-source.ts` 骑同一条端口(`filesPort().list`),但**不共用那份
 * 状态**,这是有意的:文件面板的 `searchHits` 是「检索面板此刻在看什么」,
 * 输入框打字时的候选是「这一截 `@xx` 匹配到谁」。让两者共用一格,任何一边打字
 * 都会把另一边的结果换掉 —— 那不是省一份状态,是让两块屏幕互相说谎。
 *
 * ── cwd 的判据(不自造第二条) ──────────────────────────────────────────────
 * `cwd` = 活跃会话的工作目录,产地是 `files-source.sessionCwdOf`(D5 立的**唯一**
 * 写法),组件侧读 `useSessionCwd()`。
 *
 * 拿不到时(没选会话 / 这条会话没有工作目录)**把这一格留空**,而不是在渲染层
 * 拼一个 `~`:后端 `files.list` 的 `cwd` 缺席就是「按宿主自己的搜索根找」——
 * 桌面那侧正是 `os.homedir()` + 下载目录 + 笔记根 + 按会话解析的接入目录
 * (`backend/rpc/domains/files.ts` 文件头第 1 条)。文件树那侧要展开 `~` 是因为
 * `listDirectory` 直接 `readdir` 不认识它;这条口不需要,所以不该多解析一次 ——
 * 同一条判据两处各解析一遍就会漂。
 *
 * ── 防抖不在这里 ────────────────────────────────────────────────────────────
 * `search` 是**立即**发的,竞速由令牌管。去抖是「人打字的节奏」,归调用现场
 * (`Composer.tsx` 的那只 effect,与 `search/components/SearchPanel.tsx` 逐条同款)。
 */

/** 一次补全最多要多少条。 */
export const FILE_MENTION_LIMIT = 50

/**
 * 打字去抖。行内补全比面板检索**更短**(SearchPanel 是 220ms):那边是「搜一个
 * 词」,人打完才等结果;这边是「接着打字,列表跟着收窄」,220ms 会让抽屉明显滞后。
 */
export const FILE_MENTION_DEBOUNCE_MS = 120

/** 屏幕上的一条候选。 */
export interface FileMention {
  /** 绝对路径。**token 里写的就是它** —— 引用要经得起换目录。 */
  path: string
  /** 那一行 / 那枚 chip 上的几个字:在 cwd 之下就是相对路径,否则是整条路径。 */
  label: string
  type: FileEntryType
}

/* ── 纯判据 ────────────────────────────────────────────────────────────── */

/**
 * cwd 补上尾斜杠 —— 判据的一部分,不是格式化:不补,`/a/bc` 会被算成 `/a/b` 之下。
 */
function cwdPrefix(cwd: string): string {
  return cwd.endsWith('/') ? cwd : `${cwd}/`
}

/**
 * **「这条路径归这个工作目录管吗」—— 全文件唯一的那一句。**
 *
 * 它同时是「怎么念」(`relativeLabel`)与「收不收」(`toFileMentions` 的筛)的判据。
 * 两处各写一遍 `startsWith` 就会漂:哪天补上大小写归一或符号链接解析,只改一处的
 * 那天,屏幕上就会出现「念成相对路径却被筛掉」这种自相矛盾的条目。
 *
 * 工作目录**自己**算在内:后端在空词时会把每个搜索根本身也当一条候选发下来
 * (`listOnethingFileSearchEntries` 的 rootEntry),而工作目录这一条本来就是
 * 「这条会话的项目」,不是混进来的别人。要挡的是**别的根**,不是这一条。
 */
function ownedByCwd(path: string, cwd: string): boolean {
  const prefix = cwdPrefix(cwd)
  // 「就是它」这一比也走归一后的前缀:`cwd` 带不带尾斜杠是调用现场的事,
  // 判据不该因此给出两个答案。
  return path === prefix.slice(0, -1) || path.startsWith(prefix)
}

/**
 * 一条路径在屏幕上怎么念。cwd 之下 → 相对路径(那是人心里的名字);
 * 不在 cwd 之下 → **整条路径**,不砍成文件名。
 *
 * 砍成文件名会让「下载目录里的 a.ts」和「笔记根里的 a.ts」长得一模一样,
 * 而 `files.list` 在桌面上确实同时搜这几个根(见文件头)。
 */
export function relativeLabel(path: string, cwd: string | null): string {
  if (!cwd) return path
  const prefix = cwdPrefix(cwd)
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/**
 * 线上形状 → 屏幕形状。
 *
 * `entries` 是带类型的那一份,`files` 是纯路径表;两者同源,优先用前者
 * (与 `files-source.searchFiles` 逐字同一手 —— 少一次「这条是目录还是文件」的猜)。
 *
 * ── 有工作目录时筛到该根名下(08-31 真机走查)──────────────────────────
 * 后端 `files.list` 的语义是「**cwd 是搜索根之一,不是搜索范围**」:
 * `resolveOnethingFileSearchRoots`(runtime/src/files/file-search.ts)把 cwd、笔记根、
 * 接入目录、下载目录**并列**加进根表,给不给 cwd 都一样并。于是真机上敲 `@` 的
 * 第二行候选是 `/Users/…/Downloads/…` —— 一个跟这条会话毫无关系的目录。
 *
 * 这一层的裁定:**人在某条会话里敲 `@`,问的是「这个项目里的哪个文件」**。
 * 所以有工作目录时把候选筛到它名下;拿不到工作目录时一条不筛 —— 那是「按宿主
 * 自己的搜索根找」这条既有裁定(见文件头),不在这一批的射程里。
 *
 * 筛在壳侧而不是去改后端:后端那张根表还有别的消费者(文件面板的检索、工具侧的
 * 枚举),改它是一次跨面的行为变化,得单独拍。**留账**:哪天后端开出「只搜这个根」
 * 的开口,这一筛就该退役,判据回到唯一那处。
 */
export function toFileMentions(response: FilesListResponse, cwd: string | null): FileMention[] {
  const entries: FileSearchEntry[] =
    response.entries ?? (response.files ?? []).map((path) => ({ path, type: 'file' as const }))
  const inScope = cwd ? entries.filter((entry) => ownedByCwd(entry.path, cwd)) : entries
  return inScope.map((entry) => ({
    path: entry.path,
    label: relativeLabel(entry.path, cwd),
    type: entry.type,
  }))
}

/* ── store ────────────────────────────────────────────────────────────── */

export type FileMentionsStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface FileMentionsSourceState {
  status: FileMentionsStatus
  /**
   * **产生 `mentions` 的那个词**(已 trim)。判据同 `files-source.searchQuery`:
   * 去抖窗口里词已经变了而结果还没回来,不问这一句就会闪一下另一个词的结果。
   */
  query: string
  mentions: FileMention[]
  error?: string

  /** 找一批候选。空词也发 —— 刚敲下 `@` 就该出一批,那不是「清空」。 */
  search(query: string, cwd: string | null, sessionId: string): Promise<void>
  /** 抽屉收了:候选跟着散(它是「此刻在匹配什么」,不是缓存)。 */
  clear(): void
  reset(): void
}

const EMPTY = {
  status: 'idle' as FileMentionsStatus,
  query: '',
  mentions: [] as FileMention[],
  error: undefined as string | undefined,
}

export const useFileMentionsSource = create<FileMentionsSourceState>()((set) => {
  let token = 0

  return {
    ...EMPTY,

    search: async (query, cwd, sessionId) => {
      const q = query.trim()
      const mine = ++token
      set({ status: 'loading' })
      const port = await filesPort()
      const response = await port.list({
        ...(cwd ? { cwd } : {}),
        query: q,
        limit: FILE_MENTION_LIMIT,
        // 接入目录是 per-space 的,而「哪个 space」由会话归属决定
        // (`FilesListRequest.sessionId` 的契约注释)。没有会话就不带。
        ...(sessionId ? { sessionId } : {}),
      })
      if (token !== mine) return
      if (!response.success) {
        set({ status: 'error', mentions: [], query: q, error: response.error })
        return
      }
      set({ status: 'ready', mentions: toFileMentions(response, cwd), query: q, error: undefined })
    },

    // 已经是空的就**什么都不做**:抽屉每关一次都 set 一份新的空数组,会让每一个
    // 订阅 `mentions` 的组件白重渲染一次(数组身份变了,值没变)。
    clear: () => {
      token += 1
      const now = useFileMentionsSource.getState()
      if (now.status === 'idle' && now.mentions.length === 0 && !now.query) return
      set({ ...EMPTY })
    },

    reset: () => {
      token += 1
      set({ ...EMPTY })
    },
  }
})
