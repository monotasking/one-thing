import { makeLeaf } from '../workbench/tree'
import { edgeRegion, floatRegion } from '../workbench/regions'
import { useWorkbenchStore } from '../workbench/store'
import { currentSpaceId } from '../workspace/current'
import { panelRef } from './panel-ref'
import { SHELF_SIDES } from './transitions'
import type { PaneNode } from '../workbench/tree'
import type { Placement, ShelfSide } from './types'

/**
 * **v8 → v9 那一次搬家**(W4:住处从 `onething.stage` 搬进 `onething.workbench`)。
 *
 * ── 交接不是「再读一遍 localStorage」,是**迁移自己交出来** ────────────────
 * 第一版是这么写的:把 `localStorage['onething.stage']` 的原件另读一份记住,
 * 迁移那一头只管摘干净。**那一版是错的,而且错得不显眼** —— 一份 v0 的档案里
 * 根本没有 `shelves`:那时的钉栏是一格 `pinnedId`,v3 那段才把它翻成
 * `shelves.right.tabs`。照原件去折,老用户的架子会在升级那一刻整条消失。
 *
 * 所以交接口开在**迁移里**:`migrateStagePersisted` 走到 v9 那一段时,手上那份
 * 已经是逐版补齐过的 v8 形状了,它把**正要摘掉的那几格**顺手交出来
 * (`stashLegacyStageResidency`),这只文件再把它折成树。
 * 一份 v0 的档案因此也走得通,而且不必假设两个 store 谁先水合。
 *
 * ── 幂等 ────────────────────────────────────────────────────────────────
 * 交接只在 `version < 9` 时发生:第一次跑完 stage 就以 v9 落盘,下次开机 migrate
 * 根本不跑,这本账是空的,折叠是恒等变换。同一次进程里也只折一次(`folded` 那格闸)。
 */

/** 存量档案里一条架子的形(v8 的 `ShelfState`)。 */
interface LegacyShelf {
  tabs?: unknown
  activeId?: unknown
}

/** 交接过来的那一份:一格家具里所有跟「住处」有关的东西。 */
export interface LegacyStageResidency {
  placements?: Record<string, Placement>
  shelves?: Partial<Record<ShelfSide, LegacyShelf>>
}

/* ── 折叠:一份 v8 家具 → 一批区域树 ─────────────────────────────────────── */

/**
 * 把一份存量家具翻成**区域 → 单叶树**。**纯函数**,所以这一次搬家逐格测得住。
 *
 * 逐条对应关系:
 *  · `shelves[side].tabs` → `edge:<side>` 那棵**单叶**树,叶内次序原样,
 *    `activeId` 翻成 `active` 下标(找不到就落在末位 —— 与 v3 迁移那一句同口径);
 *  · `placements` 里每一条 `float` → 一棵 `float:<瓦 id>` 的单叶树。**窗 id 就是
 *    瓦 id**,于是 `floats[id]` 那张矩形表与位置记忆里的 `{kind:'float',rect}`
 *    一个字都不用改(见 `residency.regionOfPlacement` 上的判词);
 *  · `placements` 里的 `edge` **不单独看**:它与 `shelves[side].tabs` 说的是同一件事,
 *    而后者还带次序 —— 两处都读会把同一块瓦插两遍;
 *  · `stage` 是瞬态,存盘时本来就被摘掉了(v8 的 `pickStageFurniture`),
 *    真有残值也不折 —— 它们不该活过一次刷新。
 *
 * `newLeafId` 由调用方给(树的 id 要由 `workbench/ids` 铸,纯函数不去够那个模块)。
 */
export function regionsFromLegacyFurniture(
  furniture: LegacyStageResidency | undefined,
  newLeafId: () => string,
): Record<string, PaneNode> {
  const out: Record<string, PaneNode> = {}
  if (!furniture) return out

  for (const side of SHELF_SIDES) {
    const shelf = furniture.shelves?.[side]
    const tabs = Array.isArray(shelf?.tabs)
      ? (shelf.tabs as unknown[]).filter((id): id is string => typeof id === 'string')
      : []
    if (tabs.length === 0) continue
    const activeId = typeof shelf?.activeId === 'string' ? shelf.activeId : null
    const at = activeId === null ? -1 : tabs.indexOf(activeId)
    out[edgeRegion(side)] = makeLeaf(
      newLeafId(),
      tabs.map(panelRef),
      at < 0 ? tabs.length - 1 : at,
      null,
    )
  }

  for (const [id, placement] of Object.entries(furniture.placements ?? {})) {
    if (!placement || placement.kind !== 'float') continue
    out[floatRegion(id)] = makeLeaf(newLeafId(), [panelRef(id)], 0, null)
  }

  return out
}

/* ── 交接账 ─────────────────────────────────────────────────────────────── */

/**
 * 迁移交过来的那些。键是空间 id;`null` 那一格是**扁平层**(v6 之前的档案 ——
 * v6 迁移会先把它折进默认空间,所以这一格通常是空的,留着是为了不静默丢东西)。
 */
const stash = new Map<string | null, LegacyStageResidency>()

/** 这个进程折过了没有。幂等靠它 —— 它是「这一次运行做过没有」,不是可渲染状态。 */
let folded = false

/**
 * **迁移的交接口**。`migrateStagePersisted` 的 v9 那一段在摘掉住处**之前**调它。
 * 一格都不带住处的就不必记(空 Map = 没有存量要折)。
 */
export function stashLegacyStageResidency(
  spaceId: string | null,
  furniture: LegacyStageResidency,
): void {
  const hasShelfTabs = SHELF_SIDES.some((side) => {
    const tabs = furniture.shelves?.[side]?.tabs
    return Array.isArray(tabs) && tabs.length > 0
  })
  const hasFloat = Object.values(furniture.placements ?? {}).some((p) => p?.kind === 'float')
  if (!hasShelfTabs && !hasFloat) return
  stash.set(spaceId, furniture)
}

/**
 * 把交接过来的家具折进拼贴台的账。**由 `startStage()` 调一次**,幂等。
 *
 * 折的是**整本账**(每个空间一格)—— 只折当前空间的话,切到别的空间才露出
 * 「架子空了」(与 v8 那一段清 viewer 同一条判据)。
 *
 * **已经有树的区域不覆盖**:第一次折完 workbench 就把树落了盘;万一两件事同时
 * 成立(手改过档案),树是新的、交接是旧的,那就该听树的。
 */
export function foldLegacyStageFurniture(newLeafId: () => string): void {
  if (folded) return
  folded = true
  if (stash.size === 0) return

  const store = useWorkbenchStore.getState()
  const current = store.byWorkspace ?? {}
  const nextLedger = { ...current }
  const here = currentSpaceId()
  let liveRegions = store.regions
  let touched = false

  for (const [spaceId, furniture] of stash) {
    const grown = regionsFromLegacyFurniture(furniture, newLeafId)
    if (Object.keys(grown).length === 0) continue
    // 扁平层那一份属于**当前摊开的那个空间**(v6 之前的档案只有一个空间)。
    const space = spaceId ?? here
    const now = nextLedger[space]
    nextLedger[space] = {
      regions: { ...grown, ...(now?.regions ?? {}) },
      hidden: now?.hidden ?? [],
    }
    if (space === here) liveRegions = { ...grown, ...liveRegions }
    touched = true
  }

  if (!touched) return
  useWorkbenchStore.setState({ byWorkspace: nextLedger, regions: liveRegions })
}

/** 只给测试:让下一次调用重新收账、重新折。 */
export function resetLegacyStageFold(): void {
  stash.clear()
  folded = false
}

/*
 * 模块级可变状态 = 这个模块实例的寿命,所以配一段 HMR 退役(CLAUDE.md 那条法)。
 * 复用既有那一口拆卸,不写第二套。幂等;生产构建里整段被 tree-shake 掉。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(resetLegacyStageFold)
}
