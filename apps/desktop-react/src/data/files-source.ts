import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import { create } from 'zustand'
import { languageIdOfExtension } from './languages'
import type { FileSearchEntry, FilesDirectoryEntry } from '@shared/ipc/files'
import { useExposeStore } from '../expose/store'
import type { SessionSummary } from '../expose/types'
import { notify } from '../services/notify'
import { t } from '../i18n'
import { filesPort } from './files-port'
import { createMutation, createQueryFamily } from './kernel'
import type { Mutation, QuerySnapshot } from './kernel'
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
 * 每个目录**拉一次就缓存**(`dirsQuery` 那一族里的一格),展开态(`expanded`)
 * 只活在内存里:它是「我此刻正看着树的哪一段」,不是偏好,不进 localStorage。
 * 刷新是**显式**的一颗钮:`refresh()` 重拉根与所有仍然展开的目录 ——
 * **不清缓存**(判据见下面 7d 拍板一)。没有 watch —— 理由写在 files-port.ts 的留账里。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 7d(读路战役):目录与详情迁 data/kernel,reveal 迁 mutation
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── 拍板一:`refresh()` 那句 `set({ dirs: {} })` 删掉 —— 这是病型 A 的根治 ──
 * 旧的刷新是「清空 → 骨架 → 重灌」:一句 `set({ dirs: {} })` 把整棵树的缓存抹掉,
 * 于是 `flattenTree` 当场只剩两条骨架短横,读回来再长出来。真机探针(修前)采到的
 * 就是这个:5 行的树在刷新中掉到 3 行、出现 1 条骨架、而且 180 帧里那几行的
 * **DOM 节点身份全换过**(律④当场破)。
 *
 * 现在刷新 = 对**已展开的每一格** `refetch()`:旧 entries 留在屏上(keep-previous
 * 是原语的性质,不是选项),读回来答案没变时 `equals` 让 kernel 留住上一个数组 ——
 * 于是连重渲染都省了。收起来的那些格改判 `invalidate()`:它们没人看着,只留一个
 * 脏标记,下次展开时 `ensure()` 自然重拉。**不是 `drop()`** —— 丢格说的是「这个键
 * 指的东西没了」,而一个收起来的目录还在盘上。
 *
 * ── 拍板二:失败与旧 entries **并存** ────────────────────────────────────
 * 从前目录读失败写的是 `{ status:'error', entries: [] }` —— 一次刷新失败会把已经
 * 读到的那一层整个抹掉。现在错误行画在**那一层的最前面**、旧行照留在它下面
 * (与 7e 总览「错误行并存于列表上方」逐字同形)。骨架只在**从来没有过内容**
 * 那一档画(`phase === 'initial'`,律②)。
 *
 * ── 拍板三:检索侧**就地保留**,不迁族 ──────────────────────────────────
 * 它的键是随击键变化的 `(cwd, query, limit)`,建族就等于给每一个前缀永久留一格
 * (与 `file-mentions-source` 同一条裁定)。本批只结掉那条偏离:失败不再清空命中。
 * 清与不清的判据是**手上那批命中是不是同一个问题的答案** —— 同一个词的重查
 * (翻页)失败,旧命中留屏(律②);换了词才失败,那批命中说的是别的词,留着就是
 * 在屏幕上说谎。这恰好是键控语义的手写等价物:同键留、异键换。
 *
 * ── 拍板四:换根仍然把树整棵扔掉,换空间也是 ────────────────────────────
 * `setRoot` / `navigateRoot` 里那一句 `dirsQuery.reset()` 是**旧语义原样保留**:
 * 上一条会话展开的那几层不许跟过来,而且缓存里那些绝对路径属于上一棵树。
 * 它与拍板一不冲突 —— 换根是「换了一棵树」,刷新是「同一棵树再读一遍」。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 状态先行:三张表(只列本批动的三族)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── ① 生命周期 ──────────────────────────────────────────────────────────
 *  · 挂载   —— import 只建两只**空**族 + 一只 mutation,零往返、零订阅;
 *  · 首载   —— 根定下来时 `ensure()` 根那一格;展开一个目录时 `ensure()` 它那一格。
 *              「问过一次且不脏就什么都不做」由原语承担,旧的 `if (cached &&
 *              cached.status !== 'error') return` 逐字等价(失败过的 dataRev 仍是 0,
 *              所以 `ensure` 会重试);
 *  · 换宿主 —— 目录格跟着**路径**走,不跟会话走。换会话 = 换根 = 换一棵树,
 *              所以那时整族 reset(拍板四);
 *  · 作废   —— 刷新:展开的 `refetch()`、收起的 `invalidate()`(拍板一);
 *  · 丢格   —— 换根 / 换空间 = 整族 `reset()`;单格 `drop()` 本批没有产地
 *              (一个目录「不在了」这件事今天没有人告诉这块面 —— 没有 watch);
 *  · 卸载   —— `reset()`:两族 + mutation + 本地态一起归零。HMR dispose 复用它。
 *
 * ── ② UI 生命状态(消费者:FilesPanel 的树 / 详情浮层)───────────────────
 *  · empty   —— 目录真的是空的 → 一行斜体「这里没有更多东西了」;
 *  · loading —— **只有首载算**:`phase === 'initial'` 且还没有错 → 两条骨架短横。
 *               重拉期间 `phase` 停在 ready,骨架一次都不画(律②);
 *  · ready   —— 有过一次内容就永远是它,重拉保旧;
 *  · error   —— 后端原话画成那一层最前面的一行 + 一颗「重试」,**旧行照留**;
 *  · 超量    —— 一个目录几千项是常事,削量在**画**的那一侧(rowWindow 窗口化),
 *               不在数据这一层。
 *
 * ── ③ UI 交互状态 ───────────────────────────────────────────────────────
 *  · 读那两族不画控件(展开 / 刷新 / 重试都是幂等取数,忙态由骨架与旧内容说);
 *  · **pending** —— 只有 reveal 是真·写动作(它让访达跳出来)。格键
 *    `reveal:<path>`,由 `useAsyncPending(revealMutation, revealKey(path))` 读:
 *    详情浮层底部那颗钮在飞时 `aria-busy` 并挡住第二发(律③,**零新像素**);
 *    行菜单里那一条点完菜单当场关掉 —— 控件都不在了,律③没有落点,只留那道闸;
 *  · disabled —— reveal 那颗钮**永不禁用**(`aria-busy` 说的是「在飞」不是「不可用」,
 *    与 7e 总览 `+` 钮同一条)。
 * ══════════════════════════════════════════════════════════════════════════
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
  /*
   * 读的是**环境会话**(W5-b 裁定 3 第三义),不是「当前会话」:焦点落到一片
   * 文件叶上时根不该换 —— 那正是「焦点落到文件叶不换根」那条粘性存在的理由。
   */
  const sessionId = useExposeStore((st) => st.envSessionId)
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
/**
 * 这条路径在不在那棵树底下(W6-a)。**根自己算在里面**。
 *
 * 判据是**路径分段**而不是裸前缀:`/a/bc` 不在 `/a/b` 底下,而
 * `path.startsWith('/a/b')` 会说在。加不加尾斜杠都认(根可能是 `/`)。
 */
export function isUnder(path: string, root: string): boolean {
  if (path === root) return true
  const base = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(base)
}

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

/**
 * 一层目录此刻的处境 —— **`dirsQuery` 那一格快照的投影**,不是第二份状态。
 *
 * 三个读数**正交**,这是 7d 把它从 `status: 'loading'|'ready'|'error'` 拆开的全部
 * 理由(与 kernel 拆 `phase` / `inflight` 逐字同一条判例):
 *  · `phase`    —— 这一层**从来有没有过内容**。骨架只许在 'initial' 画;
 *  · `inflight` —— 此刻有没有一发在飞。**它不清屏**,今天也没有消费者(树上那一层
 *                  的忙态由旧内容原地留着来说,而不是画一个转圈);
 *  · `error`    —— 最近一次失败的后端原话,**与 entries 共存**(拍板二)。
 *
 * 压成一个 `status` 的代价在真机上量到过:刷新时 `'loading'` 与首载的 `'loading'`
 * 长得一样,于是 `flattenTree` 画骨架 —— 用户看到的是「刚才那棵树没了」。
 */
export interface DirState {
  phase: 'initial' | 'ready'
  /*
   * ui-consume-allow: async-busy-boolean — 这一格**不是**手写的忙布尔,它是
   * `QuerySnapshot.inflight` 逐字的投影(`dirStateOf` 是唯一产地,没有第二处写它)。
   * 规则要拦的是「source 自己记一格忙态」,而这里恰恰是**消费** kernel 那一格 ——
   * 规则头上写着「data/kernel 自己不受这条管:它就是被消费的那一头」,这条投影
   * 是那句话的下游。就地豁免、不进基线(与批 8a 的 spinner-placement 同一手)。
   */
  inflight: boolean
  entries: readonly FilesDirectoryEntry[]
  /** 后端原话。归类交给 classifyFileFailure,原话原样进注行。 */
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
 *
 * ── 环保护:一个目录在一次摊平里最多走一遍(7d)────────────────────────────
 * 产地是**符号链接环**:后端的 `listDirectory` 直接 `fs.readdir`,一个指回祖先的
 * 符号链接会照实回一条 `type:'directory'` 的条目(它不解引用、也不去判环),
 * 于是「展开 A → 里面有指回 A 的 B → 展开 B」在这里就是一条无限递归 ——
 * `walk` 会一层层套下去直到栈满,整块面被 ErrorBoundary 接走。
 *
 * 这不是纸上推演:7d 写用例时喂了一份互指的假目录,**当场 RangeError:
 * Maximum call stack size exceeded**,componentStack 停在 `FilesPanel`。
 * 那份夹具随即留成了下面这条用例。
 *
 * 修法是一格 `seen`:再遇到已经走过的路径就**当场返回** —— 不抛(环是数据的
 * 事实,不是这次调用出了错)、也不画第二遍(那一行本身照旧在,只是它的孩子
 * 不再摊一次;摊了也是同一批路径,屏幕上就成了重影)。判据因此是
 * 「一个目录在一张表里最多出现一次」,而不是「深度不许超过 N」—— 后者要挑一个
 * 说不出理由的数,而且真有 40 层深的仓库时它会当场说谎。
 */
export function flattenTree(
  root: string | null,
  dirs: Readonly<Record<string, DirState>>,
  expanded: Readonly<Record<string, true>>,
): TreeRow[] {
  if (!root) return []
  const rows: TreeRow[] = []
  /** 这一次摊平里已经走过的目录。环保护的全部实现就是它 + 下面那一句早退。 */
  const seen = new Set<string>()
  const walk = (dir: string, depth: number): void => {
    // 符号链接环(理由与实证写在文件头上面那一节):走过的目录不再摊第二遍。
    if (seen.has(dir)) return
    seen.add(dir)
    const state = dirs[dir]
    /*
     * 骨架**只在这一层从来没有过内容、而且也没有话要说**的时候画(律②)。
     * 重拉期间 `phase` 已经是 'ready',所以那两条短横一次都不出现 —— 那正是
     * 病型 A 的根治点:屏幕上留着的是上一次读到的那几行。
     */
    if (!state || (state.phase === 'initial' && !state.error)) {
      rows.push({ kind: 'skeleton', id: `${dir}:skel:1`, depth, bar: 1 })
      rows.push({ kind: 'skeleton', id: `${dir}:skel:2`, depth, bar: 2 })
      return
    }
    /*
     * 失败那一行画在**这一层的最前面**,底下的旧行照留(拍板二,与 7e 总览
     * 「错误行并存于列表上方」同形)。从来没读到过时它下面本来就没有东西,
     * 于是这一档与迁移前逐字同形。
     */
    if (state.error) {
      rows.push({
        kind: 'note',
        id: `${dir}:error`,
        dir,
        depth,
        note: classifyFileFailure(state.error),
        error: state.error,
      })
    }
    if (state.phase === 'initial') return
    if (state.entries.length === 0) {
      // 读失败**而且**手上一行都没有时不再多说一句「这里是空的」——
      // 那是两句互相矛盾的话。错误行已经交代过了。
      if (!state.error) {
        rows.push({ kind: 'note', id: `${dir}:empty`, dir, depth, note: 'empty' })
      }
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

/**
 * 详情那一格**问回来的事实**(`files.stat` 的四格)。
 *
 * 它与 `FileDetailState` 分成两个形状而不是一个:后者是**屏幕上那一格**,里头的
 * `name` / 起始 `type` 是「用户点的是树上哪一行」这件事(本地态,产地在 store),
 * 而这里只有 stat 说的话。合成一个的话,那族 query 就得把「谁点的」也存一份 ——
 * 那是把一件本地的事塞进一个键控缓存里。
 */
export interface FileStatFacts {
  /** stat 真正认到的那条绝对路径(`~` 已展开),以它为准。 */
  path: string
  /** 后端认出来的类型 —— 符号链接指向哪儿只有 stat 知道,它压过树上那一格。 */
  type?: 'file' | 'directory'
  size?: number
  mtimeMs?: number
}

/* ── 取数与写数:两族 query + 一只 mutation ───────────────────────────── */

/** 空表的**同一个**引用 —— 没拉过的格摊出来的 entries 不该每次都是新数组。 */
const NO_ENTRIES: readonly FilesDirectoryEntry[] = []

/**
 * 「这两次列出来的是不是同一层」。
 *
 * **必须给**:`listDirectory` 每一发都把整层重新造成一批新对象,不给 equals 的话
 * `Object.is` 判每次都变 —— 于是一次「刷新但目录没动过」会推进 `dataRev`、换掉
 * `data` 引用,`flattenTree` 重算、整层行重渲(律④)。真机探针修前采到的
 * 「180 帧节点身份全换」正是这条。
 *
 * 比的是**屏幕上认得出的三格**(名 / 路径 / 类型)—— 后端还给了别的字段,但树上
 * 一格都没读;真要读了,那一格就得加进这份清单(与 7e 的 `sameSession` 同一条纪律)。
 */
function sameEntries(a: readonly FilesDirectoryEntry[], b: readonly FilesDirectoryEntry[]): boolean {
  if (a.length !== b.length) return false
  return a.every((x, i) => x.name === b[i].name && x.path === b[i].path && x.type === b[i].type)
}

/**
 * 一层目录 = 一格。**键就是那条绝对路径** —— 「拉过一次就缓存」「换一坑再换回来
 * 不重拉」这两件事因此是键控自带的,不必再记一张表。
 *
 * 「后端说 `success:false`」在这里是**失败**而不是空目录:回一张空表会把
 * 「没权限」画成「这里什么都没有」,那是编。抛出去之后 kernel 记进 `error`
 * 并**留住上一次读到的那些行**(拍板二)。
 */
export const dirsQuery = createQueryFamily<FilesDirectoryEntry[]>(
  'files.dir',
  async (ctx) => {
    const port = await filesPort()
    const response = await port.listDirectory(ctx.key)
    if (!response.success) throw new Error(response.error || 'files.listDirectory 未成功')
    return response.entries ?? []
  },
  { equals: sameEntries },
)

/**
 * 一条路径的详情 = 一格。**`detailToken` 那条竞速由键控退役** —— 双击第二行时
 * 第一行的 stat 回来了也只会落进它自己那一格,屏幕上那一格问的是另一个键。
 *
 * 与目录同一条口径:后端说不行 = 抛出去,归类由 `classifyFileFailure` 在投影时做
 * (三处失败共用同一条归类,不在这里各判一遍)。
 */
export const detailQuery = createQueryFamily<FileStatFacts>('files.detail', async (ctx) => {
  const port = await filesPort()
  const response = await port.stat(ctx.key)
  if (!response.success) throw new Error(response.error || 'files.stat 未成功')
  return {
    path: response.path ?? ctx.key,
    ...(response.type ? { type: response.type } : {}),
    ...(response.size === undefined ? {} : { size: response.size }),
    ...(response.mtimeMs === undefined ? {} : { mtimeMs: response.mtimeMs }),
  }
})

/**
 * 忙态格子的唯一词表 —— 发起的控件与这里共用它(与 `sessions-source.workdirKey`
 * 同一条:两头各拼一次就是两处会漂)。
 */
export function revealKey(path: string): string {
  return `reveal:${path}`
}

/**
 * 在文件管理器里定位。**这是这块面唯一一件真·写动作**(它让访达跳出来),
 * 所以它是 mutation 而不是 query:重做一遍不是无害的。
 *
 * 失败**弹出来**,不静默:级别 error(用户点了一下,期待访达跳出来,什么都没发生
 * 就是出错了),后端原话原样进 detail ——「在联网宿主上做不到」与「路径越界」
 * 是两句不同的话,不该被合成一句。这段话与迁移前逐字相同,搬的只有它的家。
 *
 * 没有 `optimistic`,也没有 `settle`:reveal 不改这台壳里的任何一格数据,
 * 它的全部效果在另一个进程里(拿 `invalidate` 去「对账」一次目录是无中生有)。
 */
export const revealMutation: Mutation<string, void> = createMutation<string, void>('files.reveal', {
  key: revealKey,
  run: async (path) => {
    const port = await filesPort()
    const response = await port.reveal(path)
    if (!response.success) throw new Error(response.error || '')
  },
  onError: (error, path) => {
    notify({
      level: 'error',
      source: 'files.reveal',
      title: t('files.revealFailed'),
      body: path,
      // 后端没给原话时如实缺席(空串 = 没有 detail 那一行),不拿一句「操作失败」顶。
      ...(error.message ? { detail: error.message } : {}),
    })
  },
})

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
  expanded: Record<string, true>
  /**
   * 详情浮层此刻问的是**树上哪一行**(null = 没开着)。
   *
   * 它是本地态而不是取数:`name` 与起始 `type` 是「用户点的那一行知道的事实」,
   * 原样带进来(那一行的名字不必再问一次后端)。stat 回来的四格住在
   * `detailQuery` 那一格里,两半由 `useFileDetail()` 合成屏幕上那一格。
   */
  detailTarget: { path: string; name: string; type: 'file' | 'directory' } | null
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
   *
   * `root` 给了就**只收这一支**(W6-a:文件面板按目录多开之后,一块面上的
   * 「全部收起」说的是**它自己那棵树**,不是屏幕上另外那两个目录也一起收)。
   * 展开态是一张按**绝对路径**记的平表(两棵树各读各的前缀),所以按前缀收
   * 就是精确的那一句话;缺席 = 全收(换空间那条路仍旧要它)。
   */
  collapseAll(root?: string): void
  /**
   * 重拉**一个**目录(读失败那一行上的「重试」)。与 refresh 的差别是范围:
   * 那一条是整棵树重来,这一条只重来出错的那一层 —— 别的层没坏,不该跟着重读。
   */
  retryDir(path: string): Promise<void>
  /**
   * 重新读取:重拉这棵树的根与它所有仍然展开的目录,别的层标脏。
   * `root` 给了就只重拉这一支(理由与 `collapseAll` 逐字同源);缺席 = 会话那一棵。
   */
  refresh(root?: string): Promise<void>
  /**
   * 打开一行的详情(双击那条路)。名字与类型是**树上已经知道的事实**,原样带进来;
   * 大小与时间要现问 —— 那正是 stat 在这个端口上的第二个用处。
   */
  openDetail(entry: { path: string; name: string; type: 'file' | 'directory' }): Promise<void>
  closeDetail(): void
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
  | 'expanded'
  | 'detailTarget'
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
  expanded: {},
  detailTarget: null,
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
   * 两个令牌各管一条竞速。合成一个会互相作废:换根期间开一次检索,
   * 检索不该因为根换完了而被判过期。
   * (从前还有第三条 `detailToken` —— 7d 由 `detailQuery` 的键控吃掉了:
   *  第一行的 stat 回来只会落进它自己那一格,不可能改到别人那一格。)
   */
  let rootToken = 0
  let searchToken = 0
  /** 上一次 setRoot 收到的入参 —— 幂等的判据(注意 null 是合法值,不能用 ?? 兜)。 */
  let lastCwd: string | null | undefined
  // 换空间那条订阅要清它(理由写在文件末尾那段);闭包变量在模块外够不着,
  // 所以留这一口。**只此一个写法** —— 换空间与 reset 走的是同一句话。
  resetFilesRootGate = () => {
    rootToken += 1
    searchToken += 1
    lastCwd = undefined
  }

  return {
    ...EMPTY,
    byWorkspace: {},

    setRoot: async (cwd) => {
      if (lastCwd === cwd && get().rootStatus !== 'idle') return
      lastCwd = cwd
      const token = ++rootToken
      // 换根 = 换了一棵树:上一棵的缓存里全是别的绝对路径(拍板四)。
      dirsQuery.reset()
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
      await dirsQuery.get(root).ensure()
    },

    navigateRoot: async (path) => {
      if (!path || get().root === path) return
      const token = ++rootToken
      // 幂等基准跟着走(理由写在接口那一条的注里)。
      lastCwd = path
      dirsQuery.reset()
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
      await dirsQuery.get(path).ensure()
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
      await dirsQuery.get(path).ensure()
    },

    collapseAll: (root) => {
      if (!root) {
        set({ expanded: {} })
        return
      }
      set((st) => {
        const next: Record<string, true> = {}
        for (const path of Object.keys(st.expanded)) {
          if (!isUnder(path, root)) next[path] = true
        }
        // 一格都没收掉 = 引用恒等(不惊动订阅者)。
        return Object.keys(next).length === Object.keys(st.expanded).length ? st : { expanded: next }
      })
    },

    retryDir: async (path) => {
      await dirsQuery.get(path).refetch()
    },

    refresh: async (only) => {
      const { root: sessionRoot, expanded } = get()
      const root = only ?? sessionRoot
      if (!root) return
      /*
       * ── 病型 A 的根治点(拍板一)────────────────────────────────────────
       * 从前这里有一句 `set({ dirs: {} })` —— 清空 → 骨架 → 重灌。现在什么都不清:
       * 屏上这几层各自 `refetch()`,旧 entries 留着(keep-previous 是原语的性质),
       * 答案没变时 `sameEntries` 让 kernel 连引用都不换。
       */
      const onScreen = [root, ...Object.keys(expanded).filter((path) => isUnder(path, root))]
      const shown = new Set(onScreen)
      /*
       * 收起来的那些格**标脏而不是重拉**:没人看着它们,`invalidate()` 只留一个
       * 脏标记,下次展开时那一发 `ensure()` 自然会去问。这一句补的是旧代码
       * 靠「整族清空」附带做到的事 —— 少了它,刷新之后再展开一个收着的目录
       * 会拿到刷新之前的旧内容。
       */
      /*
       * **只标这一棵树底下的**(W6-a):屏幕上另外那两个目录面板此刻正看着它们
       * 自己那几层,把它们一起标脏等于让别人的树在下一次展开时凭空重读一遍。
       * 判据与上面那句 `onScreen` 同一条前缀。
       */
      for (const key of dirsQuery.keys()) {
        if (!shown.has(key) && isUnder(key, root)) dirsQuery.invalidate(key)
      }
      await Promise.all(onScreen.map((path) => dirsQuery.get(path).refetch()))
    },

    openDetail: async (entry) => {
      set({ detailTarget: entry })
      /*
       * `refetch()` 而不是 `ensure()`:**每开一次就再问一次**,与迁移前逐字同义
       * (大小与时间是会变的,而用户点开详情正是为了看此刻那两个数)。
       * 手上有上一次的答案时它照旧留在屏上(律②)—— 那是这一批白得的一格:
       * 从前每开一次都先画一遍「正在读取…」。
       */
      await detailQuery.get(entry.path).refetch()
    },

    closeDetail: () => {
      set({ detailTarget: null })
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
        /*
         * ── 失败不清命中(7d 拍板三)────────────────────────────────────
         * 判据是**手上那批命中是不是同一个问题的答案**:
         *  · 同一个词的重查(翻页要更多条)失败 → 旧命中留在屏上,错误行并陈
         *    (律②;从前这里一句 `searchHits: []` 会把用户正在读的那一页抹掉);
         *  · 换了词才失败 → 那批命中说的是**别的词**,留着就是在屏幕上说谎
         *    (检索面按 `searchQuery` 对得上才画命中,留下来也只会被判成不是当前的)。
         * 这恰好是键控的手写等价物:同键留、异键换 —— 而这块面刻意不建族,
         * 理由(键随击键无限长)写在文件头拍板三。
         * `searchLimit` 跟着命中走:它回答的是「手上这批取尽了没有」。
         */
        const sameQuestion = get().searchQuery === q
        set({
          searchStatus: 'error',
          ...(sameQuestion ? {} : { searchHits: [], searchLimit: 0 }),
          searchQuery: q,
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
      dirsQuery.reset()
      detailQuery.reset()
      revealMutation.reset()
      set({ ...EMPTY, byWorkspace: {} })
    },
  }
})

/* ── 组件侧的读法 ─────────────────────────────────────────────────────── */

/**
 * 屏幕上那几层目录的现状。**键面由屏幕给定**(根 + 展开着的那几支),所以这里是
 * 逐键订(`useCatalogRecord` 那一手),不是订整族 —— 后者服务的是「哪些键有内容
 * 由数据说了算」那一种读法(检索面的章节缓存)。判据写在 kernel 的
 * `QueryFamily.subscribe` 头上。
 *
 * 两层身份守卫,都是律④要的:
 *  · **每一格**的 `DirState` 只在那一格的快照真变了时才重造(kernel 保证快照对象
 *    在读数没变时逐次同引用,所以这里比引用就够,不必逐字段比);
 *  · **整张表**在所有格都没变时原样交回上一个对象 —— `useSyncExternalStore` 要求
 *    getSnapshot 稳定,不稳定不只是白重渲,是无限重渲。
 */
export function useDirStates(paths: readonly string[]): Readonly<Record<string, DirState>> {
  /** 订阅面与快照都按这一串认身份 —— 数组每次渲染都是新的,字符串不是。 */
  const key = paths.join('\n')
  const ids = useMemo(() => (key ? key.split('\n') : []), [key])
  /*
   * 「从来没算过」用 `key: null` 表达而不是一个「不可能的字符串」:`join` 出来的
   * 键**可以是空串**(还没有根的那一屏),任何字符串哨兵都得先证明自己撞不上。
   */
  const cache = useRef<{
    key: string | null
    /** 上一次每一格看到的**那个快照对象**(kernel 保证读数没变时逐次同引用)。 */
    seen: Map<string, { snap: QuerySnapshot<FilesDirectoryEntry[]>; state: DirState }>
    value: Readonly<Record<string, DirState>>
  }>({ key: null, seen: new Map(), value: {} })

  const subscribe = useCallback(
    (listener: () => void) => {
      const offs = ids.map((id) => dirsQuery.get(id).subscribe(listener))
      return () => {
        for (const off of offs) off()
      }
    },
    [ids],
  )

  const snapshot = useCallback(() => {
    const held = cache.current
    const seen = new Map<string, { snap: QuerySnapshot<FilesDirectoryEntry[]>; state: DirState }>()
    let changed = held.key !== key
    for (const id of ids) {
      const snap = dirsQuery.get(id).get()
      const before = held.seen.get(id)
      // 那一格的快照没变 = 那一格的投影没变 = 交回上一次那个对象(那一层的行不必重渲)。
      if (before && before.snap === snap) {
        seen.set(id, before)
        continue
      }
      changed = true
      seen.set(id, { snap, state: dirStateOf(snap) })
    }
    if (!changed) return held.value
    const value: Record<string, DirState> = {}
    for (const [id, entry] of seen) value[id] = entry.state
    cache.current = { key, seen, value }
    return value
  }, [ids, key])

  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** 一格快照 → 屏幕上那一层的现状。**这是投影,不是第二份状态。** */
function dirStateOf(snap: QuerySnapshot<FilesDirectoryEntry[]>): DirState {
  return {
    phase: snap.phase,
    inflight: snap.inflight,
    entries: snap.data ?? NO_ENTRIES,
    ...(snap.error ? { error: snap.error } : {}),
  }
}

/**
 * 一层目录此刻的现状(非组件侧的读法:测试与门用它)。
 * **不订阅**,只问一次 —— 组件一律走 `useDirStates`。
 */
export function dirStateAt(path: string): DirState {
  return dirStateOf(dirsQuery.get(path).get())
}

/**
 * 屏幕上那一格详情 —— **两半合成**:store 里「问的是哪一行」+ 那一格 stat 的答案。
 *
 * 合成在这里做一次,而不是让两个宿主(树面板 / 查看区)各拼一遍:三档状态
 * (loading / ready / error)的判据只该有一处产地。归类走 `classifyFileFailure`,
 * 与树、查看器共用同一条。
 */
export function useFileDetail(): FileDetailState | null {
  const target = useFilesSource((st) => st.detailTarget)
  const query = useMemo(() => detailQuery.get(target?.path ?? ''), [target?.path])
  const subscribe = useCallback((listener: () => void) => query.subscribe(listener), [query])
  const read = useCallback(() => query.get(), [query])
  const snap = useSyncExternalStore(subscribe, read, read)
  return useMemo(() => (target ? projectDetail(target, snap) : null), [target, snap])
}

/**
 * 屏幕上那一格详情(非组件侧的读法:测试与门用它)。**不订阅**,只问一次 ——
 * 与 `dirStateAt` 同一体例,组件一律走 `useFileDetail`。
 */
export function currentFileDetail(): FileDetailState | null {
  const target = useFilesSource.getState().detailTarget
  return target ? projectDetail(target, detailQuery.get(target.path).get()) : null
}

function projectDetail(
  target: { path: string; name: string; type: 'file' | 'directory' },
  snap: QuerySnapshot<FileStatFacts>,
): FileDetailState {
  /*
   * 错误与旧答案**共存**(律②的另一半):再问一次砸了、而手上还有上一次的四格时,
   * `status` 说的是「这几格里有真数字」,`error` 说的是「最近一次没问到,原话是这句」。
   * 两件事各占一格,所以浮层上那条错误行的判据是 `error` 在不在,不是 status。
   */
  const failed = snap.error
    ? { failure: classifyFileFailure(snap.error), error: snap.error }
    : undefined
  if (snap.data) {
    return {
      ...target,
      // stat 回的是**真正 stat 到的**那条绝对路径(`~` 已展开),以它为准。
      path: snap.data.path,
      // 后端认出来的类型压过树上那一格 —— 符号链接指向哪儿,只有 stat 知道。
      type: snap.data.type ?? target.type,
      status: 'ready',
      ...(snap.data.size === undefined ? {} : { size: snap.data.size }),
      ...(snap.data.mtimeMs === undefined ? {} : { mtimeMs: snap.data.mtimeMs }),
      ...failed,
    }
  }
  if (failed) return { ...target, status: 'error', ...failed }
  return { ...target, status: 'loading' }
}

/**
 * 换工作区 = 文件树整棵换掉(T-W1)。**订阅不在这里** —— 它在
 * `workspace/layout-scope.ts`(理由:模块作用域里够别的模块会撞上这台壳既有的
 * import 环,那个文件头有病历)。这里只出这一口纯换装。
 *
 * 它比别的四个面多一件事:除了换展开态,还要把**根与所有缓存**清掉 ——
 * 那些路径属于上一个空间的根:
 *  · `root` / `rootStatus` / `rootOrigin` —— 根由新空间的活跃会话重新推出来
 *    (`useSessionCwd` → FilesPanel 的 setRoot),这里先归零免得旧根多留一帧;
 *  · 目录那一族 —— 上一个空间那些绝对路径的目录内容,在新空间里一条都用不上;
 *  · `detailTarget` / 详情那一族 / `search*` —— 同理,说的都是上一个空间的文件。
 * 而 `lastCwd` 那格幂等闸也要清:不清的话新空间恰好是同一个 cwd 时,
 * `setRoot` 会当场早退,树就再也不重建了。
 *
 * ── 次序:**先本地态,后两族**(7d)────────────────────────────────────────
 * 从前一句 `set` 就完事,现在有三处要动,所以次序成了一件要拍的事。判据是
 * **中间那一步屏幕上是什么**:先 set(`root` 归 null)→ `flattenTree` 当场回空表,
 * 那一帧是「一棵还没有根的树」,与换空间之后本来就该有的样子逐字相同;反过来先
 * reset 两族的话,那一步 `root` 还是旧的,树会画成两条骨架短横 —— 凭空多一帧闪。
 * (React 18 的自动批处理多半会把这两步合成一次渲染,所以这一条是**兜底**:
 * 不去赌批处理,而是让中间那一步本身就无害。)
 */
export function swapFilesForSpace(next: string, previous: string): void {
  const swapped = swapSpace(useFilesSource.getState(), FILES_PER_SPACE, next, previous)
  resetFilesRootGate()
  useFilesSource.setState({ ...EMPTY, ...swapped })
  dirsQuery.reset()
  detailQuery.reset()
}

/**
 * 模块级副作用的退役口(09-01 立法)。这个模块在模块作用域里留着两族 query、
 * 一只 mutation 与 `resetFilesRootGate` 那格闭包 —— 它们的寿命就是「这个模块实例」,
 * 所以热更时必须退役,否则新旧两份缓存同时活着各自应答。
 *
 * 退役**复用这个模块已有的那一口拆卸**(`reset()`),不写第二套:两套拆卸迟早漏一格。
 * 它自身幂等;生产构建里 `import.meta.hot` 是 undefined,整段被 tree-shake 掉。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    useFilesSource.getState().reset()
  })
}
