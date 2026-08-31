import { useMemo } from 'react'
import { create } from 'zustand'
import type { FileSearchEntry, FilesDirectoryEntry } from '@shared/ipc/files'
import { useExposeStore } from '../expose/store'
import type { SessionSummary } from '../expose/types'
import { notify } from '../services/notify'
import { t } from '../i18n'
import { filesPort } from './files-port'
import { useSessionsSource } from './sessions-source'

/**
 * 文件面的**真数据源**(D5)。全应用一个:文件树面板与检索面板的文件侧都从这里取,
 * 不许谁再开第二份 —— 与会话侧(data/sessions-source.ts)逐字同一条纪律。
 *
 * 分工:
 *  - 形状与判据(根怎么定、树怎么摊平、失败怎么归类):**这个文件里的纯函数**;
 *  - 取数:端口(data/files-port.ts);
 *  - 画:content/FilesPanel.tsx 与 search/components/SearchPanel.tsx。
 *
 * ── 根目录的判据(单一产地) ──────────────────────────────────────────────
 * 根 = **活跃会话的工作目录**。产地是 `SessionMeta.workingDirectory`,它在壳里
 * 已经被 `expose/projection.ts` 归一成 `SessionSummary.projectId`(那个名字说的是
 * 「按工作目录分的项目」,值就是归一后的绝对路径)—— 所以这里不再去问一次后端,
 * 也不另起一个字段:`sessionCwdOf` 是这条判据的**唯一**写法,面板与检索面都调它。
 *
 * 拿不到时(没选会话 / 这条会话没有工作目录 / 老会话没有这一格)退到 `~`,
 * 并把 `rootOrigin` 翻成 'home' —— 面板头据此如实说出「现在看的是主目录」。
 * `~` 由 `stat` 展开:后端的 `listDirectory` 不认识 `~`(它直接 readdir),
 * 而 `stat` 认识并回真正的绝对路径。**不在渲染层自己拼 homedir** —— 浏览器里
 * 根本没有那个事实,拼出来就是编。
 *
 * ── 缓存与刷新 ────────────────────────────────────────────────────────────
 * 每个目录**拉一次就缓存**(`dirs[path]`),展开态(`expanded`)只活在内存里:
 * 它是「我此刻正看着树的哪一段」,不是偏好,不进 localStorage。
 * 刷新是**显式**的一颗钮:`refresh()` 清掉缓存,重拉根与所有仍然展开的目录。
 * 没有 watch —— 理由写在 files-port.ts 的留账里。
 */

/** 预览最多读多少字节。超过这个数就只读前一段,并如实说「截断了」。 */
export const PREVIEW_MAX_BYTES = 256 * 1024

/**
 * 一次文件检索最多要多少条 —— **缺省值**,不是硬上限。
 *
 * 检索面板每翻一页都会带一个更大的 `limit` 重查(后端只有 limit、没有游标,
 * 判据写在 search/transitions.ts 的「分页」一节),所以这个数只在调用方
 * 什么都不说时生效。后端那边不设上限(`files/file-search.ts` 只有 `?? 50`
 * 这一个缺省),要多少给多少 —— 于是这里也不夹。
 */
export const FILE_SEARCH_LIMIT = 40

/* ── 纯判据 ────────────────────────────────────────────────────────────── */

/**
 * 活跃会话的工作目录。**这是根目录判据的唯一产地。**
 * 空串 sessionId(没选会话)、找不到那条会话、那条会话没有工作目录 —— 三种都是 null。
 */
export function sessionCwdOf(
  sessions: readonly SessionSummary[],
  sessionId: string,
): string | null {
  if (!sessionId) return null
  return sessions.find((session) => session.id === sessionId)?.projectId ?? null
}

/**
 * 组件侧的同一条判据。会话换了根就跟着换 —— 跟随规则只在这里成立一次,
 * 两块面板(文件树、检索)各自调它,而不是各自去拼一遍。
 */
export function useSessionCwd(): string | null {
  const sessionId = useExposeStore((st) => st.currentSessionId)
  const sessions = useSessionsSource((st) => st.sessions)
  return useMemo(() => sessionCwdOf(sessions, sessionId), [sessions, sessionId])
}

/**
 * 失败归类。后端交下来的是一句**英文原话**(`Permission denied` /
 * `File not found` / `EACCES: permission denied, scandir '…'`),那句原话是数据,
 * 原样进详情行;这里只把它归成三档,好让界面挑一句人话当标题。
 *
 * 沙箱越界(`… must stay inside the workspace sandbox root.`)归 'denied' ——
 * 对用户来说它就是「这台不让我读那儿」,与 EACCES 是同一件事的两个成因。
 */
export type FileFailure = 'denied' | 'missing' | 'failed'

export function classifyFileFailure(error: string | undefined): FileFailure {
  const text = (error ?? '').toLowerCase()
  if (!text) return 'failed'
  if (text.includes('permission denied') || text.includes('eacces') || text.includes('eperm')) {
    return 'denied'
  }
  if (text.includes('sandbox root')) return 'denied'
  if (text.includes('not found') || text.includes('enoent')) return 'missing'
  return 'failed'
}

/** 路径末段。根自己也走它,所以根行显示的是目录名而不是整条路径。 */
export function baseNameOf(path: string): string {
  const trimmed = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path
  const at = trimmed.lastIndexOf('/')
  return at < 0 ? trimmed : trimmed.slice(at + 1) || trimmed
}

/**
 * 扩展名 → 高亮语言。表里没有的一律 null = **素文本**,那不是错误,
 * 是这台不认识它(与 blocks/kinds/code/highlight.ts 顶部同一条口径:
 * 高亮器的语言表本来就是固定的一小撮,认不出就退素文本)。
 */
const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  py: 'python',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  css: 'css',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  sql: 'sql',
  yml: 'yaml',
  yaml: 'yaml',
  go: 'go',
  rs: 'rust',
  java: 'java',
  diff: 'diff',
  patch: 'diff',
}

export function langOfPath(path: string): string | null {
  const name = baseNameOf(path)
  const at = name.lastIndexOf('.')
  if (at <= 0) return null
  return LANG_BY_EXT[name.slice(at + 1).toLowerCase()] ?? null
}

/**
 * 字节数 → 一句人话。单位符号(B / KB / MB / GB)是**数据**不是文案:
 * 换一门语言它不该变,所以它不进字典(判据见 i18n/index.ts 顶部)。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const shown = unit === 0 ? String(Math.round(value)) : value.toFixed(value < 10 ? 1 : 0)
  return `${shown} ${units[unit]}`
}

/**
 * 毫秒时间戳 → 一句绝对时间。**不用相对时间**(「昨天」/「9月2日」):
 * 会话卡上问的是「多久以前的事」,文件详情上问的是「到底是哪一刻」——
 * 后者要年月日时分,少一格就得再点一次别的地方去查。
 *
 * 走 `toLocaleString` 而不是自己拼:年月日的次序、12/24 小时制这些是**语言环境的
 * 事实**,不是文案(与 formatBytes 的单位符号同一条口径 —— 它们不进字典)。
 * 非法时间戳回 null,由调用方画成缺席格,**不拿 1970-01-01 顶**。
 */
export function formatMtime(mtimeMs: number | undefined, lang: 'zh' | 'en'): string | null {
  if (mtimeMs === undefined || !Number.isFinite(mtimeMs) || mtimeMs <= 0) return null
  const date = new Date(mtimeMs)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/* ── 面包屑 ────────────────────────────────────────────────────────────── */

export interface Crumb {
  /** 这一段的名字(路径末段)。 */
  name: string
  /** 这一段**自己**的绝对路径 —— 点它就回跳到这里。 */
  path: string
}

/**
 * 绝对路径 → 逐段可点的面包屑。**这是投影,不是状态**。
 *
 * `/a/b/c` → [a:/a, b:/a/b, c:/a/b/c]。根目录 `/` 与空根都回空表 ——
 * 那时屏幕上只剩下一条领头的斜杠,没有可点的段,这是事实不是缺陷。
 * 尾段(当前所在)由渲染层画成不可点的文字:它已经在这儿了,点它没有去处。
 */
export function breadcrumbsOf(root: string | null): Crumb[] {
  if (!root) return []
  const trimmed = root.endsWith('/') && root.length > 1 ? root.slice(0, -1) : root
  const crumbs: Crumb[] = []
  let at = ''
  for (const part of trimmed.split('/')) {
    if (!part) continue
    at = `${at}/${part}`
    crumbs.push({ name: part, path: at })
  }
  return crumbs
}

/* ── 树的形状 ──────────────────────────────────────────────────────────── */

export type DirStatus = 'loading' | 'ready' | 'error'

export interface DirState {
  status: DirStatus
  entries: FilesDirectoryEntry[]
  /** 后端原话。归类交给 classifyFileFailure,原话原样进详情。 */
  error?: string
}

/**
 * 屏幕上的一行。**这是投影,不是状态** —— 由 `dirs` × `expanded` 摊平出来,
 * 所以「展开一层」只改一个布尔,不改树。
 *
 * 两种行,不是一种带空字段的行:`entry` 是真的文件系统条目,`note` 是那条
 * 「这里没有更多东西了 / 还在读 / 读不到」的诚实交代。把它们混成一种,
 * 视图就得靠 `name === undefined` 这类判据分岔。
 */
export type TreeRow =
  | {
      kind: 'entry'
      path: string
      name: string
      type: 'file' | 'directory'
      depth: number
      /** 目录才有意义:此刻展着没有。 */
      expanded: boolean
    }
  | {
      kind: 'note'
      /** 稳定 key:注挂在哪个目录下面。 */
      id: string
      depth: number
      note: 'loading' | 'empty' | FileFailure
      /** 后端原话(note 是 loading / empty 时缺席)。 */
      error?: string
    }

/**
 * 摊平。**深度优先、目录在前**(次序由后端的 `listOnethingDirectory` 定,
 * 这里一个字不重排 —— 两处各排一次就会漂)。
 *
 * 根自己不出现在表里:它是面板头上那一行,不是树里的一行。
 */
export function flattenTree(
  root: string | null,
  dirs: Readonly<Record<string, DirState>>,
  expanded: Readonly<Record<string, true>>,
): TreeRow[] {
  if (!root) return []
  const rows: TreeRow[] = []
  const walk = (dir: string, depth: number): void => {
    const state = dirs[dir]
    if (!state || state.status === 'loading') {
      rows.push({ kind: 'note', id: `${dir}:loading`, depth, note: 'loading' })
      return
    }
    if (state.status === 'error') {
      rows.push({
        kind: 'note',
        id: `${dir}:error`,
        depth,
        note: classifyFileFailure(state.error),
        error: state.error,
      })
      return
    }
    if (state.entries.length === 0) {
      rows.push({ kind: 'note', id: `${dir}:empty`, depth, note: 'empty' })
      return
    }
    for (const entry of state.entries) {
      const open = entry.type === 'directory' && expanded[entry.path] === true
      rows.push({
        kind: 'entry',
        path: entry.path,
        name: entry.name,
        type: entry.type,
        depth,
        expanded: open,
      })
      if (open) walk(entry.path, depth + 1)
    }
  }
  walk(root, 0)
  return rows
}

/* ── 预览 ──────────────────────────────────────────────────────────────── */

export type PreviewStatus = 'loading' | 'ready' | 'binary' | 'error'

export interface PreviewState {
  path: string
  status: PreviewStatus
  /** status === 'ready' 才有意义。 */
  content?: string
  /** 文件**真实**字节数(不是读回来那一段的长度)。 */
  size?: number
  /** 真实字节数 > PREVIEW_MAX_BYTES —— 屏幕上看到的只是开头一段。 */
  truncated: boolean
  failure?: FileFailure
  /** 后端原话。 */
  error?: string
}

/* ── 详情 ──────────────────────────────────────────────────────────────── */

export type DetailStatus = 'loading' | 'ready' | 'error'

/**
 * 双击一行问出来的那几格。**大小与时间只活在这里**,不进树 ——
 * 树是拿来扫的(一行三件:箭头 / 图标 / 名),扫的时候没人在读字节数;
 * 真要那个数的那一刻,是**问一件具体的东西**,那是详情干的活。
 *
 * 缺格如实缺席:后端的 `files.stat` 不保证给 `size` / `mtimeMs`(目录尤其),
 * 缺了就画一道 `—`,**不拿 0 B 和 1970-01-01 顶**。
 */
export interface FileDetailState {
  path: string
  name: string
  type: 'file' | 'directory'
  status: DetailStatus
  size?: number
  mtimeMs?: number
  failure?: FileFailure
  /** 后端原话。 */
  error?: string
}

/* ── store ────────────────────────────────────────────────────────────── */

export type RootStatus = 'idle' | 'loading' | 'ready' | 'error'
export type SearchStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface FilesSourceState {
  /** 已经解析成绝对路径的根;null = 还没定下来。 */
  root: string | null
  rootStatus: RootStatus
  /**
   * 根是**从哪来的**。三档,各说各的话:
   *  · session —— 活跃会话的工作目录(正常态,面板不多说一句);
   *  · home    —— 会话没带工作目录,退到了 `~`(底注如实说出来);
   *  · manual  —— 用户自己点面包屑走上去的(既不是会话的,也不是主目录,
   *               所以那句「显示的是主目录」不能再说 —— 它会变成假话)。
   */
  rootOrigin: 'session' | 'home' | 'manual'
  rootError?: string
  dirs: Record<string, DirState>
  expanded: Record<string, true>
  preview: PreviewState | null
  detail: FileDetailState | null
  searchStatus: SearchStatus
  searchHits: FileSearchEntry[]
  /**
   * **产生 `searchHits` 的那个词**(已 trim)。它存在是为了让消费方能问一句
   * 「手上这批命中说的是不是我此刻这个词」—— 去抖窗口里那 220ms,词已经变了而
   * 结果还没回来,不问这一句就会在屏幕上闪一下**另一个词**的结果。
   * 空串 = 手上没有任何一次查询的结果。
   */
  searchQuery: string
  /**
   * **产生 `searchHits` 的那一次要了多少条**(0 = 手上没有任何一次查询的结果)。
   *
   * 它存在只为一件事:回答「取尽了没有」。后端这一条没有游标、也不下发命中总数
   * (`files.list` 的回执只有 `files` / `entries`),所以唯一能判的判据是
   * **回来的条数 < 要的条数**。少了这个数,消费方就只能猜。
   */
  searchLimit: number
  searchError?: string

  /** 换根。入参是**会话的工作目录**(null = 没有,退 `~`)。幂等。 */
  setRoot(cwd: string | null): Promise<void>
  /**
   * 面包屑回跳:把根挪到一条**已经解析好的绝对路径**上(祖先段)。
   *
   * 与 setRoot 分成两口而不是加一个 flag:setRoot 收的是「会话的工作目录」这件
   * **事实**(可能是 null,要 stat 展 `~`),这一口收的是「用户此刻想看哪儿」这个
   * **意图**(一定是绝对路径,不必再问后端)。合成一口就得在里面分岔判断入参
   * 到底是哪一种,那正是两件事被塞进一个名字的味道。
   *
   * 它同时把 setRoot 的幂等基准挪到这条新路径上 —— 于是会话真换目录时
   * (cwd 变了)照样能把用户拉回会话的根,而手动漫游不会被一次重渲染打回去。
   */
  navigateRoot(path: string): Promise<void>
  /** 展开 / 收起一个目录;展开时按需拉它的内容(拉过就不再拉)。 */
  toggleDir(path: string): Promise<void>
  /** 重新读取:清缓存,重拉根与所有仍然展开的目录。 */
  refresh(): Promise<void>
  openPreview(path: string): Promise<void>
  closePreview(): void
  /**
   * 打开一行的详情(双击那条路)。名字与类型是**树上已经知道的事实**,原样带进来;
   * 大小与时间要现问 —— 那正是 stat 在这个端口上的第二个用处。
   */
  openDetail(entry: { path: string; name: string; type: 'file' | 'directory' }): Promise<void>
  closeDetail(): void
  /** 在文件管理器里定位。失败**弹出来**,不静默。 */
  reveal(path: string): Promise<void>
  /**
   * 按名字搜文件。空词 = 清空(见 search/data.ts 顶部的诚实缺口)。
   *
   * `limit` 是**这一次要多少条**:分页靠它递增(后端只有 limit 没有游标 ——
   * 代价是每翻一页都从头重查一遍,判据与留账写在 search/transitions.ts)。
   */
  searchFiles(query: string, cwd: string | null, limit?: number): Promise<void>
  /** 只给测试用:模块级 store 要能在用例之间归零。 */
  reset(): void
}

const EMPTY: Pick<
  FilesSourceState,
  | 'root'
  | 'rootStatus'
  | 'rootOrigin'
  | 'rootError'
  | 'dirs'
  | 'expanded'
  | 'preview'
  | 'detail'
  | 'searchStatus'
  | 'searchHits'
  | 'searchQuery'
  | 'searchLimit'
  | 'searchError'
> = {
  root: null,
  rootStatus: 'idle',
  rootOrigin: 'session',
  rootError: undefined,
  dirs: {},
  expanded: {},
  preview: null,
  detail: null,
  searchStatus: 'idle',
  searchHits: [],
  searchQuery: '',
  searchLimit: 0,
  searchError: undefined,
}

export const useFilesSource = create<FilesSourceState>()((set, get) => {
  /*
   * 三个令牌各管一条竞速。合成一个会互相作废:换根期间点开一个预览,
   * 预览不该因为根换完了而被判过期。
   */
  let rootToken = 0
  let previewToken = 0
  let searchToken = 0
  /** 详情自己一条竞速:双击第二行时,第一行的 stat 回来了也不许改屏。 */
  let detailToken = 0
  /** 上一次 setRoot 收到的入参 —— 幂等的判据(注意 null 是合法值,不能用 ?? 兜)。 */
  let lastCwd: string | null | undefined

  /** 拉一个目录进缓存。已经在拉 / 已经拉好的直接返回。 */
  async function loadDir(path: string, force = false): Promise<void> {
    if (!force) {
      const cached = get().dirs[path]
      if (cached && cached.status !== 'error') return
    }
    set((st) => ({ dirs: { ...st.dirs, [path]: { status: 'loading', entries: [] } } }))
    const port = await filesPort()
    const response = await port.listDirectory(path)
    set((st) => ({
      dirs: {
        ...st.dirs,
        [path]: response.success
          ? { status: 'ready', entries: response.entries ?? [] }
          : { status: 'error', entries: [], error: response.error },
      },
    }))
  }

  return {
    ...EMPTY,

    setRoot: async (cwd) => {
      if (lastCwd === cwd && get().rootStatus !== 'idle') return
      lastCwd = cwd
      const token = ++rootToken
      set({
        ...EMPTY,
        rootStatus: 'loading',
        rootOrigin: cwd ? 'session' : 'home',
        // 检索是跨根的一件事,换根不该把刚搜出来的结果抹掉。
        searchStatus: get().searchStatus,
        searchHits: get().searchHits,
        searchQuery: get().searchQuery,
        searchLimit: get().searchLimit,
        searchError: get().searchError,
      })

      let root = cwd
      if (!root) {
        // `~` 只有后端展得开(渲染层没有 homedir 这个事实)。
        const port = await filesPort()
        const stat = await port.stat('~')
        if (rootToken !== token) return
        if (!stat.success || !stat.path) {
          set({ rootStatus: 'error', rootError: stat.error })
          return
        }
        root = stat.path
      }
      if (rootToken !== token) return
      set({ root, rootStatus: 'ready' })
      await loadDir(root)
    },

    navigateRoot: async (path) => {
      if (!path || get().root === path) return
      const token = ++rootToken
      // 幂等基准跟着走(理由写在接口那一条的注里)。
      lastCwd = path
      set({
        ...EMPTY,
        root: path,
        rootStatus: 'ready',
        rootOrigin: 'manual',
        // 与 setRoot 逐字同一条:检索是跨根的一件事,换根不抹掉刚搜出来的结果。
        searchStatus: get().searchStatus,
        searchHits: get().searchHits,
        searchQuery: get().searchQuery,
        searchLimit: get().searchLimit,
        searchError: get().searchError,
      })
      if (rootToken !== token) return
      await loadDir(path)
    },

    toggleDir: async (path) => {
      const open = get().expanded[path] === true
      if (open) {
        set((st) => {
          const next = { ...st.expanded }
          delete next[path]
          return { expanded: next }
        })
        return
      }
      set((st) => ({ expanded: { ...st.expanded, [path]: true } }))
      await loadDir(path)
    },

    refresh: async () => {
      const { root, expanded } = get()
      if (!root) return
      set({ dirs: {} })
      await loadDir(root, true)
      // 仍然展着的那些一起重拉 —— 刷新之后树的形状不该塌回一层。
      await Promise.all(Object.keys(expanded).map((path) => loadDir(path, true)))
    },

    openPreview: async (path) => {
      const token = ++previewToken
      set({ preview: { path, status: 'loading', truncated: false } })
      const port = await filesPort()
      const response = await port.readContent(path, PREVIEW_MAX_BYTES)
      if (previewToken !== token) return
      if (!response.success) {
        set({
          preview: {
            path,
            status: 'error',
            truncated: false,
            failure: classifyFileFailure(response.error),
            error: response.error,
          },
        })
        return
      }
      const size = response.size ?? 0
      set({
        preview: {
          path,
          status: response.isBinary ? 'binary' : 'ready',
          content: response.content ?? '',
          size,
          truncated: size > PREVIEW_MAX_BYTES,
        },
      })
    },

    closePreview: () => {
      previewToken += 1
      set({ preview: null })
    },

    openDetail: async (entry) => {
      const token = ++detailToken
      set({ detail: { ...entry, status: 'loading' } })
      const port = await filesPort()
      const response = await port.stat(entry.path)
      if (detailToken !== token) return
      if (!response.success) {
        set({
          detail: {
            ...entry,
            status: 'error',
            failure: classifyFileFailure(response.error),
            error: response.error,
          },
        })
        return
      }
      set({
        detail: {
          ...entry,
          // stat 回的是**真正 stat 到的**那条绝对路径(`~` 已展开),以它为准。
          path: response.path ?? entry.path,
          // 后端认出来的类型压过树上那一格 —— 符号链接指向哪儿,只有 stat 知道。
          type: response.type ?? entry.type,
          status: 'ready',
          size: response.size,
          mtimeMs: response.mtimeMs,
        },
      })
    },

    closeDetail: () => {
      detailToken += 1
      set({ detail: null })
    },

    reveal: async (path) => {
      const port = await filesPort()
      const response = await port.reveal(path)
      if (response.success) return
      /*
       * 失败必须可见。走 notify 而不是吞掉:级别 error(用户点了一下,期待
       * 访达跳出来,什么都没发生就是出错了),后端原话原样进 detail ——
       * 「在联网宿主上做不到」与「路径越界」是两句不同的话,不该被合成一句。
       */
      notify({
        level: 'error',
        source: 'files.reveal',
        title: t('files.revealFailed'),
        body: path,
        detail: response.error,
      })
    },

    searchFiles: async (query, cwd, limit = FILE_SEARCH_LIMIT) => {
      const q = query.trim()
      const token = ++searchToken
      if (!q) {
        set({
          searchStatus: 'idle',
          searchHits: [],
          searchQuery: '',
          searchLimit: 0,
          searchError: undefined,
        })
        return
      }
      set({ searchStatus: 'loading' })
      const port = await filesPort()
      const response = await port.list({
        ...(cwd ? { cwd } : {}),
        query: q,
        limit,
      })
      if (searchToken !== token) return
      if (!response.success) {
        set({
          searchStatus: 'error',
          searchHits: [],
          searchQuery: q,
          searchLimit: limit,
          searchError: response.error,
        })
        return
      }
      /*
       * `entries` 是带类型与出处的那一份,`files` 是纯路径表。两者同源,
       * 优先用前者 —— 少一次「这条是目录还是文件」的猜。
       */
      const entries: FileSearchEntry[] =
        response.entries ?? response.files.map((path) => ({ path, type: 'file' as const }))
      set({
        searchStatus: 'ready',
        searchHits: entries,
        searchQuery: q,
        searchLimit: limit,
        searchError: undefined,
      })
    },

    reset: () => {
      rootToken += 1
      previewToken += 1
      searchToken += 1
      detailToken += 1
      lastCwd = undefined
      set({ ...EMPTY })
    },
  }
})
