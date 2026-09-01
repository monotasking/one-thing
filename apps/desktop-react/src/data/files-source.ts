import { useMemo } from 'react'
import { create } from 'zustand'
import { languageIdOfExtension } from './languages'
import type { FileSearchEntry, FilesDirectoryEntry } from '@shared/ipc/files'
import { useExposeStore } from '../expose/store'
import type { SessionSummary } from '../expose/types'
import { notify } from '../services/notify'
import { t } from '../i18n'
import { filesPort } from './files-port'
import { swapSpace, type PerSpaceSpec } from '../workspace/per-space'
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
 * 扩展名 → 高亮语言。**表在 `data/languages.ts`,这里只是一条委托** ——
 * 09-01 把「扩展名 → 语言 id」与「语言 id → grammar」并成了一张表(理由写在
 * 那个文件头:两处会静默分叉,而分叉的表现是「怎么没上色」)。
 * 表里没有的一律 null = 素文本,那不是错误,是这台不认识它。
 */
export function langOfPath(path: string): string | null {
  const name = baseNameOf(path)
  const at = name.lastIndexOf('.')
  if (at <= 0) return null
  return languageIdOfExtension(name.slice(at + 1))
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
      /**
       * 懒展开时那两条骨架短横。**它是两行不是一行**:每一行仍然恰好一格行高,
       * 而窗口化渲染按「行序 × 行高」反推位置 —— 一个两倍高的特例会把整条卷轴算歪。
       */
      kind: 'skeleton'
      id: string
      depth: number
      bar: 1 | 2
    }
  | {
      kind: 'note'
      /** 稳定 key:注挂在哪个目录下面。 */
      id: string
      /** 这条注说的是哪个目录 —— 失败态那颗「重试」钮要拿它去重拉。 */
      dir: string
      depth: number
      note: 'empty' | FileFailure
      /** 后端原话(note 是 empty 时缺席)。 */
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
      rows.push({ kind: 'skeleton', id: `${dir}:skel:1`, depth, bar: 1 })
      rows.push({ kind: 'skeleton', id: `${dir}:skel:2`, depth, bar: 2 })
      return
    }
    if (state.status === 'error') {
      rows.push({
        kind: 'note',
        id: `${dir}:error`,
        dir,
        depth,
        note: classifyFileFailure(state.error),
        error: state.error,
      })
      return
    }
    if (state.entries.length === 0) {
      rows.push({ kind: 'note', id: `${dir}:empty`, dir, depth, note: 'empty' })
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

/* ── 窗口化渲染(超大目录)────────────────────────────────────────────────── */

/**
 * 一行有多高。**它与 `styles/tokens.css` 的 `--files-row-h` 是同一个事实的两半**
 * ——`files-source.test.ts` 读那个文件的文本逐字比对(同 motion-tokens.test 解析
 * `--dur` 族的判例)。改一处不改另一处,卷轴会算歪而屏幕上看不出为什么。
 */
export const FILES_ROW_H = 27

/**
 * 可视窗上下各多画几行。缓冲的用处只有一个:**快卷时不出现空白带** ——
 * 浏览器把 scroll 事件交给我们的那一刻,画面已经动过了。
 * 8 行 ≈ 216px,比一次滚轮的跨度大,而代价只是多 16 个 DOM 节点。
 */
export const FILES_ROW_BUFFER = 8

export interface RowWindow {
  /** 要渲染的区间 `[start, end)`。 */
  start: number
  end: number
  /** 区间前 / 后用两块空撑子占位,卷轴长度因此与「全画出来」逐像素相同。 */
  padTop: number
  padBottom: number
}

/**
 * 摊平后的行数组 × 卷到哪儿 × 视口多高 → **这一帧该画哪一段**。
 *
 * 纯算术,不碰 DOM、不认识 React —— 所以它能被逐条钉死(边界、负数、视口比内容
 * 还高、卷过了头)。行高恒定是它成立的前提,那条前提写在 tokens.css 的
 * 「文件面几何」一节,并由骨架 / 空 / 失败三种注行**同高**来兑现。
 *
 * `viewportH` 为 0(还没量到 / 面被收起来了)时给一个整表窗口:第一帧宁可多画
 * 一点,也不要画一片空白然后等 ResizeObserver —— 那一帧的空白是看得见的。
 */
export function rowWindow(
  total: number,
  scrollTop: number,
  viewportH: number,
  rowH: number = FILES_ROW_H,
  buffer: number = FILES_ROW_BUFFER,
): RowWindow {
  if (total <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 }
  if (viewportH <= 0 || rowH <= 0) {
    return { start: 0, end: total, padTop: 0, padBottom: 0 }
  }
  const top = Math.max(0, scrollTop)
  const first = Math.floor(top / rowH)
  const visible = Math.ceil(viewportH / rowH) + 1
  const start = Math.max(0, first - buffer)
  const end = Math.min(total, first + visible + buffer)
  return {
    start,
    end: Math.max(start, end),
    padTop: start * rowH,
    padBottom: Math.max(0, (total - Math.max(start, end)) * rowH),
  }
}

/*
 * ── 「预览」整条退役了(查看器 F1)────────────────────────────────────────
 * 从前这里有一份 `PreviewState` 四态(loading / ready / binary / error)与
 * `openPreview` / `closePreview` 两口。它们搬去了 `data/viewer-source.ts`,
 * 并且**换了语义**:预览说的是「瞄一眼」(一层盖在树上的只读代码块),
 * 查看器说的是「看」(一份文件按它自己的样子完整铺开)。
 *
 * 搬走而不是留一个转发口,是因为这两个 store 分的是**事实**不是文件:树是目录
 * 的事实,查看是一个文件的事实。留一份在这里就等于说「文件内容也是目录面的
 * 一部分」,那正是 §0 铁律 3 要拆掉的那种耦合。
 */

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
  /**
   * 展开态的**家具账**(T-W1):workspaceId → 那个空间展开着哪几支。
   *
   * 只记 `expanded` 一格,不记 `dirs` —— 后者是**目录内容的缓存**(可能很大,
   * 而且随时可能过期),留着每个空间一份既费内存又会在切回去时画一屏陈的树。
   * 展开态是「用户翻开过哪几支」,那才是他切回来想看见的东西;内容重拉一次即可。
   *
   * 这本账**不落盘**:文件树的展开态本来就不进 localStorage(见文件头
   * 「我此刻正看着树的哪一段,不是偏好」),T-W1 不改这一条 —— 它只让这条
   * 「一次会话之内」的记忆按空间分开,而不是让它活过一次刷新。
   */
  byWorkspace: Record<string, { expanded: Record<string, true> }>

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
  /**
   * 一层不留地收起来。**只动展开态,不碰缓存** —— 收起是「我不想看它们了」,
   * 不是「刚才读到的都作废」;再展开时不该又问一遍后端。
   */
  collapseAll(): void
  /**
   * 重拉**一个**目录(读失败那一行上的「重试」)。与 refresh 的差别是范围:
   * 那一条是整棵树重来,这一条只重来出错的那一层 —— 别的层没坏,不该跟着重读。
   */
  retryDir(path: string): Promise<void>
  /** 重新读取:清缓存,重拉根与所有仍然展开的目录。 */
  refresh(): Promise<void>
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
  detail: null,
  searchStatus: 'idle',
  searchHits: [],
  searchQuery: '',
  searchLimit: 0,
  searchError: undefined,
}

/**
 * 文件树那一份家具。只有展开态 —— 理由写在 `FilesSourceState.byWorkspace` 上。
 */
/**
 * 把三条竞速令牌与 `setRoot` 的幂等闸一起归零。**store 创建时赋值**,
 * 两个调用点(`reset()` 与换空间那条订阅)共用同一句话 —— 两套拆卸迟早漏一格。
 */
let resetFilesRootGate: () => void = () => {}

const FILES_PER_SPACE: PerSpaceSpec<FilesSourceState, { expanded: Record<string, true> }> = {
  pick: (st) => ({ expanded: st.expanded }),
  factory: () => ({ expanded: {} }),
}

export const useFilesSource = create<FilesSourceState>()((set, get) => {
  /*
   * 三个令牌各管一条竞速。合成一个会互相作废:换根期间开一次检索,
   * 检索不该因为根换完了而被判过期。
   */
  let rootToken = 0
  let searchToken = 0
  /** 详情自己一条竞速:双击第二行时,第一行的 stat 回来了也不许改屏。 */
  let detailToken = 0
  /** 上一次 setRoot 收到的入参 —— 幂等的判据(注意 null 是合法值,不能用 ?? 兜)。 */
  let lastCwd: string | null | undefined
  // 换空间那条订阅要清它(理由写在文件末尾那段);闭包变量在模块外够不着,
  // 所以留这一口。**只此一个写法** —— 换空间与 reset 走的是同一句话。
  resetFilesRootGate = () => {
    rootToken += 1
    searchToken += 1
    detailToken += 1
    lastCwd = undefined
  }

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
    byWorkspace: {},

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

    collapseAll: () => {
      set({ expanded: {} })
    },

    retryDir: async (path) => {
      await loadDir(path, true)
    },

    refresh: async () => {
      const { root, expanded } = get()
      if (!root) return
      set({ dirs: {} })
      await loadDir(root, true)
      // 仍然展着的那些一起重拉 —— 刷新之后树的形状不该塌回一层。
      await Promise.all(Object.keys(expanded).map((path) => loadDir(path, true)))
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
      resetFilesRootGate()
      set({ ...EMPTY, byWorkspace: {} })
    },
  }
})

/**
 * 换工作区 = 文件树整棵换掉(T-W1)。**订阅不在这里** —— 它在
 * `workspace/layout-scope.ts`(理由:模块作用域里够别的模块会撞上这台壳既有的
 * import 环,那个文件头有病历)。这里只出这一口纯换装。
 *
 * 它比别的四个面多一件事:除了换展开态,还要把**根与所有缓存**清掉 ——
 * 那些路径属于上一个空间的根:
 *  · `root` / `rootStatus` / `rootOrigin` —— 根由新空间的活跃会话重新推出来
 *    (`useSessionCwd` → FilesPanel 的 setRoot),这里先归零免得旧根多留一帧;
 *  · `dirs` —— 上一个空间那些绝对路径的目录内容,在新空间里一条都用不上;
 *  · `detail` / `search*` —— 同理,它们说的都是上一个空间的文件。
 * 而 `lastCwd` 那格幂等闸也要清:不清的话新空间恰好是同一个 cwd 时,
 * `setRoot` 会当场早退,树就再也不重建了。
 *
 * **一次 `set` 完成**,所以中间没有「新账配旧树」的那一帧。
 */
export function swapFilesForSpace(next: string, previous: string): void {
  const swapped = swapSpace(useFilesSource.getState(), FILES_PER_SPACE, next, previous)
  resetFilesRootGate()
  useFilesSource.setState({ ...EMPTY, ...swapped })
}
