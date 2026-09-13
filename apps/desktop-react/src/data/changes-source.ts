import { useEffect } from 'react'
import type { ResourceReadView } from '@shared/ipc/resources'
import { createQueryFamily } from './kernel'
import type { Query } from './kernel'
import { onRunEnded } from './chat-source'
import { gitPort, gitRef } from './git-port'
import { useExposeStore } from '../expose/store'

/**
 * 「改动」面的数据层(正本 `apps/desktop-react/docs/changes-panel-2026-09.md` §3.3)。
 *
 * **两条读法,两族 query**,都打在后端 `git:` 资源上 —— 与模型调 `git` 那只工具
 * 是同一条路(音乐 / 浏览器立的那条判例在这里逐字适用:真源不在渲染进程里,
 * 壳与 AI 就不该各走各的路)。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 状态先行 · ① 生命周期(②③ 两张在 `content/changes/ChangesPanel.tsx` 的组件头上)
 * ══════════════════════════════════════════════════════════════════════════
 *  · 挂载    —— import 这只文件**只建两族空 query**:零往返、零订阅
 *                (与 `browser-source` / `resources/shell-host` 同一条纪律)。
 *                「一轮跑完了」那条订阅由**第一份改动面到场**时接上、
 *                **最后一份离场**时退掉(见 `holdRoot`);
 *  · 首载    —— 面板第一次可见时 `statusQuery.get(root).ensure()`(幂等:同一个
 *                目录开两块面只问后端一次);选中一行时 `diffQuery` 那一格 `ensure()`;
 *  · 刷新    —— 三条路,一条 poll 都没有(见 `refreshOpenChanges`);
 *  · 换宿主  —— 叶从架子拖成浮窗 / 抬上舞台,拼贴树的结构共享保证面不重挂,
 *                这条线一格都不动(读数按 root 键控,与谁在画它无关);
 *  · 卸载    —— **什么都不做**:读数留在格子里,切回来时旧内容当场在屏上(律②′)。
 *                一份改动表几 KB,而清掉它换来的是每次回来一次骨架;
 *  · HMR     —— **不需要**:这只文件没有模块级副作用(订阅的寿命是「屏幕上还有
 *                没有改动面」,不是「这个模块实例」——09-01 立法那句判据的反面用法)。
 *
 * ── 没有 fs watch ───────────────────────────────────────────────────────
 * 与目录面同一条留账(`files-port.ts` 文件头那一段):那两条 watch 在桌面侧从来是
 * 投影桩。所以这里的新鲜由**三条显式的路**保证,而不是一只每 N 秒问一遍的计时器
 * —— poll 在一台开着十个仓的机器上是十条常驻的 `git status`,而它们九成答的是
 * 「什么都没变」。
 */

/* ── 读数的形(逐格对着 `runtime/src/files/git-resource-spec.ts`)─────────── */

/** 一行改动的状态。与自述里那个 enum 逐字相同。 */
export type GitFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflicted'
  | 'typechange'

export interface GitChangedFile {
  /** **仓库根相对**路径(与 git 自己说的一样)。 */
  path: string
  status: GitFileStatus
  staged: boolean
  unstaged: boolean
  /** 二进制文件**缺席**(不是 0)—— 它的行数不是零,是不适用。 */
  add?: number
  del?: number
  binary?: boolean
  /** 只有 `renamed` / `copied` 有。 */
  oldPath?: string
}

/**
 * `status` 那条读法的答案。**`repo: false` 是一种状态,不是一次失败** ——
 * 面板据它画「这里不是 git 仓库」那一档,而不是一条报错。
 */
export interface GitStatusView {
  repo: boolean
  root?: string
  /**
   * **这一份表只列了仓库的哪一段**(`''` = 整仓)。
   *
   * 地址常常是仓库的一个子目录(一条会话绑的工作目录就经常是 `repo/packages/foo`),
   * 而读根按发起会话的工作目录算 —— 那时后端交出的是**那一段下面**的改动,并用这
   * 一格说清是哪一段。判词整段在 `runtime/src/files/git-resource-spec.ts` 上;要紧
   * 的是它**不影响任何一行的坐标**:`files[].path` 照旧是仓库根相对,`root` 照旧是
   * 真正的仓根。
   *
   * **本单不画它**(留账):屏幕上要把「我只看得见这一段」说清楚是一句拍板件的
   * 文案(画在檐上?画成空态的一半?),而它今天还没有过。壳这边先把它带进来,
   * 免得下一批要先改一次形状 —— 一格读得到但没人画的事实,比一格根本不在的事实
   * 容易补。
   */
  scope?: string
  branch?: string
  /** HEAD 的短 sha。空仓(还没有一次提交)时缺席。 */
  head?: string
  files?: GitChangedFile[]
  stat?: { add: number; del: number; files: number }
}

/** `diff` 那条读法的答案。 */
export interface GitDiffView {
  path: string
  /** `git diff HEAD -- <path>` 的原文。二进制文件是空串。 */
  text: string
  binary: boolean
  truncated: boolean
}

/**
 * 一个文件的**一个版本**的原文(`file` 那条读法交的两格都是这个形)。
 *
 * `binary` 时 `text` 是空串 —— 那不是「这个文件是空的」,是「这一版不是文本」;
 * `truncated` 时 `text` 是开头那一截,而且截在**最后一个完整的行**上(半行原文喂给
 * 一个按行对齐的算法,画出来的是一张骗人的表)。`bytes` 说的永远是截断前的真大小。
 */
export interface GitFileText {
  text: string
  binary: boolean
  truncated: boolean
  bytes: number
}

/**
 * `file` 那条读法的答案:一个文件的两个版本原文。**后端不算 diff**,算法在壳里
 * (`content/code/line-diff.ts`)—— 正本 §1 那条分工。
 *
 * 两格的 `null` 各自是一句话:`head` 空 = 这一版在上一次提交里不存在(新增 / 未跟踪 /
 * 空仓);`work` 空 = 盘上没有它了(删掉的文件)。重命名按**新路径**问,于是它长得
 * 和新增一样 —— 那是正确答案。
 */
export interface GitFileView {
  path: string
  head: GitFileText | null
  work: GitFileText | null
}

/* ── 结局 → 一句人话(四支,**不发明文案**)───────────────────────────────── */

/**
 * 与 `browser-source.readFailureText` 逐字相同的一句:把四支非 ok 折成 query 的
 * `error`,**每一支带的是后端自己的原话**。壳这边不替它写一句「读不到改动」——
 * 那会把「没权限」「这台机器没有 git」「git 退出码 128 加一段 stderr」三种完全
 * 不同的现场糊成同一句废话。
 */
function readFailureText(view: ResourceReadView): string {
  switch (view.kind) {
    case 'invalid':
      return view.message
    case 'denied':
      return view.reason
    case 'failed':
      return view.error.message
    default:
      return ''
  }
}

/**
 * **这一发是从哪条会话里发起的**。
 *
 * 答案只有一个产地:`expose.envSessionId`(环境会话,带粘性 —— 判词整段在
 * `content/session-projection.ts` 上)。它是后端判读根的钥匙(见 `GitPort.read`),
 * 而且与「哪一条会话跑完一轮才算数」问的是**同一格** —— 两处读同一个字段,
 * 不是巧合:改动面整件事的坐标系就是这条会话。
 *
 * 读不到(还没进过任何会话)= **不带**,让后端按它自己那条缺省落地。
 */
function originSessionId(): string | undefined {
  return useExposeStore.getState().envSessionId || undefined
}

async function readGit<T>(
  ref: string,
  name: string,
  query?: Record<string, unknown>,
): Promise<T> {
  const port = await gitPort()
  await port.ready()
  const answer = await port.read(ref, name, query, originSessionId())
  if (answer.kind === 'ok') return answer.value as T
  throw new Error(readFailureText(answer))
}

/* ── 两族读数 ────────────────────────────────────────────────────────────── */

/**
 * 一个工作目录此刻改了什么。**键 = 那个工作目录**(不是仓库根:根是答案的一部分,
 * 拿答案当键就得先问一次才知道该问谁)。
 */
export const statusQuery = createQueryFamily<GitStatusView>('changes.status', (ctx) =>
  readGit<GitStatusView>(gitRef(ctx.key), 'status'),
)

/**
 * 一个文件的统一 diff。键是**两段拼起来**的(见 `diffKey`)—— 同一条相对路径在
 * 两个仓里是两份 diff,拿 `path` 单独当键会让第二个仓读到第一个仓的缓存。
 */
export const diffQuery = createQueryFamily<GitDiffView>('changes.diff', (ctx) => {
  const at = splitDiffKey(ctx.key)
  return readGit<GitDiffView>(gitRef(at.root), 'diff', { path: at.path })
})

/**
 * 一个文件的**两个版本原文**。键与 `diffQuery` 那一族同形(见 `diffKey`)。
 *
 * 与 `diff` 那一族**并存**:整文件视图吃这一只,而 `diff` 那条读法是后端自述里
 * 一等的一条(模型调 `git` 工具时问的就是它),壳这边今天没有消费者不等于它该删 ——
 * 删它是另一笔账,不搭这一单的车。
 */
export const fileQuery = createQueryFamily<GitFileView>('changes.file', (ctx) => {
  const at = splitDiffKey(ctx.key)
  return readGit<GitFileView>(gitRef(at.root), 'file', { path: at.path })
})

/**
 * `root` + 仓库根相对路径 → 一格的键。**两族共用这一只** —— 同一条路径在两个仓里
 * 是两份答案,拿 `path` 单独当键会让第二个仓读到第一个仓的缓存;而两族各写一份
 * 拼法,迟早只改好其中一份。
 *
 * 分隔符取 `\n`:它**不可能**出现在这两段里的任何一段(git 自己就用 `-z` 把
 * 路径按 NUL 分开,而路径里带换行的文件在 `status` 那一侧根本活不下来),所以
 * 不必转义、也不会有「路径里恰好有一个分隔符」那种拆错。
 */
const DIFF_KEY_SEP = '\n'

export function diffKey(root: string, path: string): string {
  return `${root}${DIFF_KEY_SEP}${path}`
}

function splitDiffKey(key: string): { root: string; path: string } {
  const at = key.indexOf(DIFF_KEY_SEP)
  if (at < 0) return { root: key, path: '' }
  return { root: key.slice(0, at), path: key.slice(at + DIFF_KEY_SEP.length) }
}

/** 这一格 diff 的 query(面板只经这一只问,不自己拼键)。 */
export function diffQueryOf(root: string, path: string): Query<GitDiffView> {
  return diffQuery.get(diffKey(root, path))
}

/** 这一格「两个版本原文」的 query。 */
export function fileQueryOf(root: string, path: string): Query<GitFileView> {
  return fileQuery.get(diffKey(root, path))
}

/* ── 刷新:三条路,零 poll ────────────────────────────────────────────────── */

/**
 * **一本引用计数账**:这个键此刻有几份在屏幕上。
 *
 * ── 为什么是计数而不是一张 `Set` ────────────────────────────────────────
 * `diff` 那一种**不是单例**(`content/kinds/diff.tsx`):同一个 workdir 可以在两片
 * 叶里各开一份改动面。用 `Set` 的话第二份关掉会把第一份的「在场」一起删掉 ——
 * 之后那一份只剩标脏、不再后台补拉,屏幕上停在旧读数而没有任何人报错。
 * 同一句话对一格 diff 也成立(两份面选着同一个文件)。
 *
 * 两本账共用这一只(根一本、diff 键一本):它们要的是同一件事,而写两遍必然在
 * 某一天只修好其中一本。
 */
interface HoldLedger {
  /** 到场。返回离场那一口(幂等由调用方的 effect 保证:一次挂载一次卸载)。 */
  hold(key: string): () => void
  has(key: string): boolean
  keys(): string[]
  clear(): void
}

function createHoldLedger(onFirst?: () => void, onLast?: () => void): HoldLedger {
  const counts = new Map<string, number>()
  let total = 0
  return {
    hold(key) {
      counts.set(key, (counts.get(key) ?? 0) + 1)
      total += 1
      if (total === 1) onFirst?.()
      let released = false
      return () => {
        // 一次卸载只还一次:React 18 的 StrictMode 会重跑 effect,但每一次挂载
        // 都配一次自己的清理,所以这一格只防「同一只清理被调两遍」。
        if (released) return
        released = true
        const left = (counts.get(key) ?? 0) - 1
        if (left > 0) counts.set(key, left)
        else counts.delete(key)
        total = Math.max(0, total - 1)
        if (total === 0) onLast?.()
      }
    },
    has: (key) => counts.has(key),
    keys: () => [...counts.keys()],
    clear() {
      const had = total > 0
      counts.clear()
      total = 0
      if (had) onLast?.()
    },
  }
}

/**
 * **屏幕上此刻有哪几份改动面开着**,以及每个根有几份。
 *
 * 它同时是那条订阅的**寿命**:第一份到场时接上「一轮跑完了」,最后一份离场时
 * 退掉 —— 屏幕上一份改动面都没有的时候,这只文件在整台壳上是零负担
 * (与 `browser-source.openBrowserSource` 的 refcount 逐字同一个形)。
 *
 * 「谁认识拼贴树谁来填」那条依赖方向没变:`data/` 不 import `workbench/`,
 * 报到的是面板自己(`useChangesLive`)。
 */
const openRoots = createHoldLedger(
  () => {
    unsubscribeRunEnded ??= onRunEnded(onEnvSessionRunEnded)
  },
  () => {
    unsubscribeRunEnded?.()
    unsubscribeRunEnded = undefined
  },
)

/** 屏幕上此刻正看着哪几格 diff(键与 `diffQuery` 那一族同形)。 */
const openDiffs = createHoldLedger()

/** 屏幕上此刻正看着哪几个文件的两版原文(同一条规矩,另一族)。 */
const openFiles = createHoldLedger()

let unsubscribeRunEnded: (() => void) | undefined

/**
 * **重问所有在场的改动面**(四律第②条:重拉旧内容留屏,骨架只首载)。
 *
 * 两支分流,判据是**在不在屏幕上**,两族**同一条规矩**:
 *  · **在场** → `refetch()`:后台去问,旧屏一直留着,读回来再换;
 *  · **不在场** → `invalidate()`:只标脏,下一次它可见时 `ensure()` 自己去拉。
 *    为一块没人在看的面发一次 `git status`,是拿一次真的子进程换一个没人看见的数。
 *
 * ── 一条内核事实,写下来免得下一个人以为这里少了一半 ──────────────────────
 * `Query.invalidate()` **在有订阅者时就地后台补拉**(`data/kernel/query.ts` 的
 * `invalidate`:`if (listeners.size > 0) void start(true)`)。所以严格说,一格
 * 正被 `useQuery` 订着的读数走哪一支都会重问 —— 上面那条分流因此是**显式**的
 * 而不是必需的。留着它的理由是判据的产地:「这一份在不在屏幕上」该由这只文件
 * 自己说得出口,而不是靠「恰好有没有人订阅」这条内核的内部性质替它回答。
 * (那条性质由 `changes-source.test.ts` 里那一例钉着,免得它哪天变了没人发现。)
 *
 * **空 path 那一格跳过**:面板没选中行时订的是 `diffQueryOf(root, '')`(判词与
 * `data/file-peek-source.useFilePeek` 那句「路径为空时订空串那一格」逐字同源)。
 * 它永远没人 `ensure`,快照恒是出厂那一份 —— 标脏它只会在有人订着的时候换来一发
 * `path: ''` 的真请求。
 */
export function refreshOpenChanges(): void {
  for (const key of statusQuery.keys()) {
    if (openRoots.has(key)) void statusQuery.get(key).refetch()
    else statusQuery.invalidate(key)
  }
  for (const key of diffQuery.keys()) {
    if (!splitDiffKey(key).path) continue
    if (openDiffs.has(key)) void diffQuery.get(key).refetch()
    else diffQuery.invalidate(key)
  }
  for (const key of fileQuery.keys()) {
    if (!splitDiffKey(key).path) continue
    if (openFiles.has(key)) void fileQuery.get(key).refetch()
    else fileQuery.invalidate(key)
  }
}

/**
 * **重问某一个目录的那一份**(檐上那颗「重新读取」按下去那一发)。
 *
 * 它比 `refreshOpenChanges` 窄一格:只重问这一个 root 的改动表,外加**这个 root
 * 下面此刻正被人看着的那几个文件**的两版原文。批⑤ 之前后半句是面板自己写的一行
 * (`fileSource.refetch()`)—— 那时正文就在这块面里,「选中的那一个」有唯一答案;
 * 拆开之后正文是别处那几格 tab,而按下刷新的人要的是「把这个仓此刻的样子重读一遍」,
 * 不是「重读我脚下这一行」。
 *
 * 不在场的那几格**不碰**:标脏由 `refreshOpenChanges` 那条全局的路管,而这一发是
 * 一次人按出来的、有范围的重读。
 */
export function refreshChangesOf(root: string): void {
  void statusQuery.get(root).refetch()
  const prefix = `${root}${DIFF_KEY_SEP}`
  for (const key of fileQuery.keys()) {
    if (!key.startsWith(prefix) || !splitDiffKey(key).path) continue
    if (openFiles.has(key)) void fileQuery.get(key).refetch()
  }
}

/**
 * **环境会话一轮跑完 → 重问**(第三条路;前两条是「首次可见 `ensure()`」与
 * 「檐上那颗刷新钮 `refetch()`」)。
 *
 * ── 为什么只认**环境会话** ──────────────────────────────────────────────
 * 改动面画的是**某个工作目录**的事,而「此刻这台屏幕在哪个项目里」这句话的产地
 * 只有一个:`expose.envSessionId`(判词整段在 `content/session-projection.ts` 上
 * —— 它带粘性,焦点落到一片文件叶时不跟着换)。别的会话跑完一轮,多半改的是别的
 * 目录;为它重问一次,换来的是屏幕上这一份莫名其妙地闪一下读数。
 *
 * 两片会话叶并排时伴随面只跟环境会话 —— 既有裁定(正本 §8),这一句是同一条。
 */
function onEnvSessionRunEnded(sessionId: string): void {
  if (sessionId !== originSessionId()) return
  refreshOpenChanges()
}

/**
 * **回到出厂**:两族读数归零 + 两本在场账清空(最后一份离场那一下顺带退订)。
 * 测试用;产品里没有第二个调用点 —— 订阅的寿命由在场账自己管。
 */
export function resetChangesSource(): void {
  statusQuery.reset()
  diffQuery.reset()
  fileQuery.reset()
  openDiffs.clear()
  openFiles.clear()
  openRoots.clear()
}

/** 只给测试与门:此刻有哪几份改动面在场。 */
export function openChangeRoots(): string[] {
  return openRoots.keys()
}

/** 只给测试:那条「一轮跑完了」的订阅此刻接着没有。 */
export function isChangesUpkeepLive(): boolean {
  return unsubscribeRunEnded !== undefined
}

/**
 * **一份改动面在场的那一段**(唯一的挂载点 —— 组件里不再写第二段 effect)。
 *
 * 三件事:报到(引用计数)、首载 `ensure()`、以及**第一份到场时把那条订阅接上**
 * (由在场账的 `onFirst` 做)。三件都幂等,所以同一个目录开两块面只问后端一次。
 */
export function useChangesLive(root: string): void {
  useEffect(() => {
    const release = openRoots.hold(root)
    void statusQuery.get(root).ensure()
    return release
  }, [root])
}

/**
 * **正看着这一格 diff 的那一段**。**今天零消费者** —— 改动面批 ③-b 起吃的是
 * `useFileLive`;这一只与 `diffQuery` 一起留着(那条读法是后端自述里一等的一条),
 * 删是另一笔账。
 *
 * 与 `useChangesLive` 同一个形:报到 + 首载。**空 path 不报到也不拉** —— 那是
 * 「还没选中」的占位格(见 `refreshOpenChanges` 末段)。
 */
export function useDiffLive(root: string, path: string): void {
  const key = path ? diffKey(root, path) : ''
  useEffect(() => {
    if (!key) return
    const release = openDiffs.hold(key)
    void diffQuery.get(key).ensure()
    return release
  }, [key])
}

/**
 * **正看着这一个文件两版原文的那一段**(`ChangeFileView` 挂载期间)。
 * 与 `useDiffLive` 逐字同一个形,只是记在另一本账上。
 */
export function useFileLive(root: string, path: string): void {
  const key = path ? diffKey(root, path) : ''
  useEffect(() => {
    if (!key) return
    const release = openFiles.hold(key)
    void fileQuery.get(key).ensure()
    return release
  }, [key])
}
