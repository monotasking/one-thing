import { useStageStore, syncStageResidency } from '../stage/store'
import { initialStageState } from '../stage/transitions'
import { regionsFromLegacyFurniture } from '../stage/legacy-furniture'
import { useWorkbenchStore } from '../workbench/store'
import { nextLeafId } from '../workbench/ids'
import { makeLeaf } from '../workbench/tree'
import { CENTER_REGION } from '../workbench/regions'
import type { StageState } from '../stage/types'

/**
 * **用例夹具:摆一份形态(W4)**。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * W4 之前,「哪块面在哪儿」整件住在 stage 那台 store 里,所以用例摆现场的写法是
 * 一句 `useStageStore.setState({ placements, shelves })`。W4 之后那两格降格成
 * **投影**(真相在拼贴树里,判词在 `stage/residency.ts` 文件头)—— 直接写投影
 * 只活到下一次投影跑完:任何一句形态动作都会把它对回树上那份(空的)。
 *
 * 所以摆现场要摆**树**。这只夹具就是那一句翻译,而且它**复用迁移那只纯函数**
 * (`regionsFromLegacyFurniture`)—— 「一串瓦 id → 一棵单叶树」这件事全仓只有
 * 一个折法,用例与 v8→v9 那次搬家共用它,两处不会分叉。
 *
 * ── 它摆的是什么 ────────────────────────────────────────────────────────
 *  · `shelves[side].tabs` / `activeId` → `edge:<side>` 那棵单叶树;
 *  · `placements` 里的 `float` → `float:<瓦 id>` 那棵单叶树;
 *  · `placements` 里的 `stage` → stage 自己那一格瞬态;
 *  · 别的字段(`floats` / `floatOrder` / `memory` / Dock 偏好)原样写进 stage。
 * 摆完立刻投影一次,所以 `useStageStore.getState().placements` 当场就是对的。
 */
export function seedStage(partial: Partial<StageState> = {}): void {
  const st = { ...initialStageState, ...partial }
  const grown = regionsFromLegacyFurniture(
    { placements: st.placements, shelves: st.shelves },
    nextLeafId,
  )
  useWorkbenchStore.setState({
    regions: { [CENTER_REGION]: makeLeaf(nextLeafId()), ...grown },
    hidden: [],
    focusLeafId: null,
    panelPath: null,
  })
  const stageId = Object.entries(st.placements).find(([, p]) => p.kind === 'stage')?.[0] ?? null
  useStageStore.setState({ ...st, stageId })
  syncStageResidency()
}
