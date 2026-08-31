import { currentWorkspace, projectWorkspaces } from './projection'
import { useWorkspaceStore } from './store'
import type { WorkspaceSwatch } from './types'

/**
 * 把「当前工作区」贴到 `documentElement` 上 —— 这个文件是**唯一**碰 DOM 的那一半,
 * 与 reading/apply.ts 同一形状、同一理由。
 *
 * 贴的是两个属性,不是一堆行内变量:
 *   data-workspace       当前工作区的 id
 *   data-workspace-swatch 当前工作区的色标名
 * 色值住在 styles/palette.css 的 `--ws-*` 里,JS 这边**一个色值都不知道**。
 * 行内样式是刻意不用的:行内优先级压过一切样式表,今后主题层想按皮肤微调
 * 工作区色就再没有机会(判例记在 theme-source.ts 的文件头)。
 *
 * ── 它**不**做什么 ───────────────────────────────────────────────────────
 * 它不换世界 —— 换世界的是各数据源自己订的那条 `subscribeCurrentSpace`
 * (`workspace/current.ts`;三个消费者与两条机制写在 `workspace/store.ts` 文件头)。
 * 这里只贴两个属性,一个字节的数据都不重取。
 *
 * 分这两半的理由与「唯一碰 DOM 的那一半」是同一条:贴属性是同步的、幂等的、
 * 不会失败的;重取数是异步的、可能失败的、要讲先后的。混在一个订阅里,
 * 「首帧就是最终那一档」这件事就得等一次网络往返。
 */

const ATTR_ID = 'data-workspace'
const ATTR_SWATCH = 'data-workspace-swatch'

export interface WorkspaceProbe {
  applied: boolean
  id?: string
  swatch?: WorkspaceSwatch
}

declare global {
  interface Window {
    __workspace?: WorkspaceProbe
  }
}

const probe: WorkspaceProbe = { applied: false }
if (typeof window !== 'undefined') window.__workspace = probe

/** 贴一次。纯粹的「状态 → 属性」。 */
export function applyCurrentWorkspace(id: string, swatch: WorkspaceSwatch | undefined): WorkspaceProbe {
  if (typeof document === 'undefined') return probe
  const root = document.documentElement
  root.setAttribute(ATTR_ID, id)
  if (swatch) root.setAttribute(ATTR_SWATCH, swatch)
  else root.removeAttribute(ATTR_SWATCH)
  probe.applied = true
  probe.id = id
  probe.swatch = swatch
  return probe
}

let unsubscribe: (() => void) | undefined

/**
 * 开工:贴一次当下的,然后订 store。幂等。
 *
 * 排在 `main.tsx` 里 —— 与阅读四轴同一条理由:首帧就该是最终的那一档,
 * 不该先画一屏默认色再跳成用户的工作区色。
 */
export function startWorkspaceApply(): WorkspaceProbe {
  const push = () => {
    const { spaces, currentId } = useWorkspaceStore.getState()
    const view = currentWorkspace(projectWorkspaces(spaces, currentId))
    return applyCurrentWorkspace(view?.id ?? currentId, view?.swatch)
  }
  unsubscribe?.()
  unsubscribe = useWorkspaceStore.subscribe(push)
  return push()
}

/** 测试用:把模块级的一次性状态清干净(同 reading/apply.ts 的 stop*ForTest)。 */
export function stopWorkspaceApplyForTest(): void {
  unsubscribe?.()
  unsubscribe = undefined
  probe.applied = false
  probe.id = undefined
  probe.swatch = undefined
  if (typeof document !== 'undefined') {
    document.documentElement.removeAttribute(ATTR_ID)
    document.documentElement.removeAttribute(ATTR_SWATCH)
  }
}
