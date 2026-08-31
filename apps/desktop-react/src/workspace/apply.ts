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
 * ── 它**不**做什么(本批最要紧的一条留账) ───────────────────────────────
 * 它不换世界。切换今天只改这台壳记住的当前工作区与上面那两个属性;
 * 凭证池、接入目录、provider 设置、会话归属**不随之切换** —— 那需要每一条
 * 取数都带上 workspaceId,壳今天的六个端口一条都没有这一格,属后端批。
 * 所以这里没有「重新取数」那一步:没有的东西不假装有。界面上的注脚
 * (`workspace.scopeNote`)说的就是这句话。
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
