import type { ReactNode } from 'react'
import type { ContentRef } from '../workbench/kinds'

/**
 * **启动瓦**(W6-a,设计 `apps/desktop-react/docs/workbench-tabs-2026-09.md` §3)。
 *
 * ── 它治的是什么 ────────────────────────────────────────────────────────
 * Dock 上一块瓦一直等于「一块面」:点它 = 按它的打开方式把 `panel:<瓦 id>` 那格
 * 内容摆出来。文件面板按目录多开之后这句话不成立了 —— 「文件」不再是一块面,
 * 它是**一族**面(一个目录一份 `files-root:<路径>`),而那块瓦要做的事变成了
 * 「开哪一个目录」。
 *
 * 修法不是在 Dock 里写一句 `if (id === 'files')` —— 那正是「加功能不许改骨架」
 * 那条法点名的病型(Dock 会一块瓦一句 if 地长下去)。这张表是它的反面:
 * **瓦自述,Dock 读表**。表上没有这块瓦 = 它照旧是一块面,Dock 那三条路
 * (点开 / 拖出去 / 右键那排落点)逐字不变。
 *
 * ── 四口,各自可缺 ──────────────────────────────────────────────────────
 *  · `open()`     点它意味着什么。缺席不可能(没有它就不必登记);
 *  · `dragRef()`  **这块瓦此刻代表哪一格内容**。缺席 = 那块瓦自己(`panel:<id>`);
 *                 答 `null` = 此刻答不出来(比如目录还没解析出来)。
 *                 拖是它的第一个消费者(答 null = **拒绝**起拖,而不是拖出一格
 *                 画不出东西的假 tab);**召唤是第二个**(W7-p 裁定 6:点这块瓦
 *                 之前先问「它代表的那格内容是不是已经开着」,开着就对那个位置
 *                 走四态 —— 判词在 `stage/open-item.ts`)。名字留着 `dragRef` 是
 *                 因为改名要动登记方那只文件;它答的一直是这一句话,不是两句;
 *  · `residentKind` **它开出来的东西是哪一种**(W7-c)。`dragRef()` 答 null 时的
 *                 退一步:屏幕上有没有同类的一格已经开着。缺席 = 没有这个退路;
 *  · `MenuRows`   右键菜单里这块瓦自己那几行,**替掉**那一排落点单选。
 *                 缺席 = 照旧画落点。判据与工作区那块瓦的快切表同型
 *                 (那一处 08-31 起就是这么做的,只是当时写成了 Dock 里的一句
 *                 `if`;本批把它连同这一块一起收进这张表)。
 *
 * ── 登记与退役 ──────────────────────────────────────────────────────────
 * 与 `workbench/kinds.registerContentKind` 逐字同一体例:调用方把自己那份
 * `import.meta.hot` 递进来,退役那一段只写一遍。重名**抛**而不是替换。
 */
export interface StageLauncher {
  /** 点这块瓦 = 做这件事。 */
  open(): void
  /**
   * 这块瓦此刻代表哪一格内容(拖它拖出去的、召唤它要找的,同一格)。
   * 缺席 = 那块瓦自己;答 null = 此刻答不出来。
   */
  dragRef?(): ContentRef | null
  /**
   * **这块瓦开出来的东西属于哪一种内容**(W7-c 裁定 6)。
   *
   * 它是 `dragRef()` 答 `null` 时的**退一步**:那一口答的是「此刻拖得出哪一格」,
   * 而这一格答的是「屏幕上有没有**同类**的一格已经开着」。目录面板那块瓦是现场:
   * 会话没绑目录时 `dragRef()` 答 null(拖不出东西是对的),但屏幕上可能正开着
   * 一棵别的目录树 —— 点那块瓦想要的是「让我看见目录」,不是「再开一个」。
   *
   * 缺席 = 没有这个退路(照旧直接 `open()`)。查找由 `workbench/tree` 的
   * `firstRefOfKindIn` 做,判词在那儿;这张表只持有**这块瓦自述的那个种类名**。
   */
  residentKind?: string
  /** 右键菜单里这块瓦自己那几行(替掉那排落点单选)。 */
  MenuRows?: (props: { onDone: () => void }) => ReactNode
}

/** Vite 的 `import.meta.hot` 里这里只用得到 `dispose` 一口(照种类表的形)。 */
export interface LauncherHot {
  dispose(cb: () => void): void
}

const REGISTRY = new Map<string, StageLauncher>()

export function registerStageLauncher(
  id: string,
  launcher: StageLauncher,
  hot?: LauncherHot,
): () => void {
  const now = REGISTRY.get(id)
  if (now && now !== launcher) throw new Error(`stage launcher 重复注册:${id}`)
  REGISTRY.set(id, launcher)
  const off = () => {
    // 只摘「确实是我登记的那一格」—— 别人已经换上去了就不动它。
    if (REGISTRY.get(id) === launcher) REGISTRY.delete(id)
  }
  hot?.dispose(off)
  return off
}

export function stageLauncherOf(id: string): StageLauncher | undefined {
  return REGISTRY.get(id)
}

/** 只给测试:用例之间归零。 */
export function resetStageLaunchers(): void {
  REGISTRY.clear()
}
