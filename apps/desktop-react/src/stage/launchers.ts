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
 * ── 三口,各自可缺 ──────────────────────────────────────────────────────
 *  · `open()`     点它意味着什么。缺席不可能(没有它就不必登记);
 *  · `dragRef()`  拖它拖出去的是哪一格内容。缺席 = 那块瓦自己(`panel:<id>`);
 *                 答 `null` = 此刻拖不出来(比如目录还没解析出来)——**拒绝**,
 *                 而不是拖出一格画不出东西的假 tab;
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
  /** 拖这块瓦拖出去的是哪一格内容。缺席 = 那块瓦自己;答 null = 此刻拖不出来。 */
  dragRef?(): ContentRef | null
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
