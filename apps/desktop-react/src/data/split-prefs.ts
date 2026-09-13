import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import {
  foldFlatIntoDefaultSpace,
  spreadSpace,
  stashSpace,
  type PerSpaceSpec,
  type PerSpaceState,
} from '../workspace/per-space'
import { DEFAULT_SPACE_ID } from '../workspace/types'

/**
 * **分栏比例的记忆**(09-01 报障:「file open 之后,没办法调整宽度」)。
 *
 * 它跟 `file-open-mode` 是同一类东西 —— 一条**偏好**,所以照那一份的先例写:
 * zustand + persist + localStorage + 一个把认不出的值钳回默认的 `merge`。
 *
 * ── 为什么是一张按 id 的表,而不是「文件面板的比例」一个字段 ────────────────
 * 分栏在这台壳里不会只有一处(将来的 diff 面、终端上下分屏都是同一件事)。
 * 一张 `id → 比例` 的表让第二处分栏零成本接入;而给每一处各起一个字段,
 * 就得每加一处改一次 store 的形状。
 *
 * 存的是**前一栏占的百分比**(0–100 的整数),不是像素:面板本身会被拖宽拖窄、
 * 会从面板搬到浮窗里,存像素等于存一个换个宿主就不成立的数。
 */

/** 文件面板那条分栏的 id。**两处引用**(面板与这张默认表),所以有名字。 */
export const FILES_SPLIT_ID = 'files'

/**
 * 「改动」面那条分栏的 id。与上面那一格逐字同一条理由不许各写各的字面量。
 *
 * 它就是这张表头上那句「第二处分栏零成本接入」兑现下来的样子:加一处分栏 =
 * 这里一个名字 + 下面那张表一行,store 的形状一个字不动。
 */
export const CHANGES_SPLIT_ID = 'changes'

/**
 * 各处分栏的出厂比例。
 *
 * 文件面板那条取 45 —— 它逐字等于 F1 那两枚 token(`--files-tree-fr: 0.9fr` /
 * `--files-viewer-fr: 1.1fr`,0.9 / (0.9+1.1) = 45%)。**改版不改手感**是有意的:
 * 这一批加的是「能拖」,不是「换一个新的默认」。
 *
 * 改动面那条取 **32**(正本 §3.4)。它比文件面窄,而那不是审美:左边是一列**路径**
 * (一行一个文件名,长的那些本来就要省略号),右边是一块 **diff**(等宽字,行不折,
 * 折了缩进的含义就变了)。两边要的宽度不对等,所以缺省不对半。
 */
export const DEFAULT_SPLIT_RATIOS: Record<string, number> = {
  [FILES_SPLIT_ID]: 45,
  [CHANGES_SPLIT_ID]: 32,
}

/** 拖到头的两档。留 15% 是因为再窄的一栏里什么都读不出来,那不是「收起」而是「坏了」。 */
export const SPLIT_MIN = 15
export const SPLIT_MAX = 85

/** 跟着工作区走的那一格。分栏比是**用户在这个空间里摆好的**,所以是家具。 */
interface SplitFurniture {
  ratios: Record<string, number>
}

interface SplitPrefsStore extends SplitFurniture, PerSpaceState<SplitFurniture> {
  setRatio: (id: string, ratio: number) => void
}

export const SPLIT_PER_SPACE: PerSpaceSpec<SplitPrefsStore, SplitFurniture> = {
  pick: (st) => ({ ratios: st.ratios }),
  // 出厂 = 一格都没存过。**不是** DEFAULT_SPLIT_RATIOS —— 那张表是「没存过时读什么」
  // (`splitRatioOf` 的回落),不是「存过一份出厂值」。两者混起来会让「重置」与
  // 「从没拖过」在盘上长成两个样子。
  factory: () => ({ ratios: {} }),
}

function clampRatio(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Math.round(value)))
}

export const useSplitPrefs = create<SplitPrefsStore>()(
  persist(
    (set) => ({
      ratios: {},
      byWorkspace: {},
      setRatio: (id, ratio) =>
        set((st) => ({
          ratios: { ...st.ratios, [id]: clampRatio(ratio, DEFAULT_SPLIT_RATIOS[id] ?? 50) },
        })),
    }),
    {
      name: 'onething.split',
      // v2:分栏比按工作区各持一份(T-W1)。存量那一份原样折进默认空间。
      version: 2,
      migrate: (persisted, version) => {
        if (version >= 2 || !persisted || typeof persisted !== 'object') return persisted
        return foldFlatIntoDefaultSpace<SplitFurniture>(
          persisted as Record<string, unknown>,
          ['ratios'],
          DEFAULT_SPACE_ID,
        )
      },
      storage: createJSONStorage(() => localStorage),
      /*
       * 存盘可能来自旧版本、也可能被人手改过:每一格都钳一次,认不出的整条丢掉。
       * 同 file-open-mode / reading store 的 merge 钳制 —— 一个从盘上读回来的
       * `-3` 会让分栏当场塌成一条缝,而那种坏法查起来像是布局 bug。
       */
      merge: (persisted, current) => {
        const byWorkspace = ((persisted as Partial<SplitPrefsStore> | undefined)?.byWorkspace
          ?? {}) as Record<string, SplitFurniture>
        // 钳制对**账上每一格**都做一遍,不只是当前那一格:切过去才发现盘上是
        // `-3`,那时屏幕已经塌了一帧 —— 钳在读回来的这一刻,只有这一处。
        const clamped: Record<string, SplitFurniture> = {}
        for (const [spaceId, furniture] of Object.entries(byWorkspace)) {
          const saved = furniture?.ratios
          const ratios: Record<string, number> = {}
          if (saved && typeof saved === 'object') {
            for (const [id, value] of Object.entries(saved)) {
              ratios[id] = clampRatio(value, DEFAULT_SPLIT_RATIOS[id] ?? 50)
            }
          }
          clamped[spaceId] = { ratios }
        }
        // 同步摊开当前空间那一格 —— 第一帧就是对的(理由同 stage 的 merge)。
        return { ...current, byWorkspace: clamped, ...spreadSpace(clamped, SPLIT_PER_SPACE) }
      },
      partialize: (st) => ({ byWorkspace: stashSpace(st, st.byWorkspace, SPLIT_PER_SPACE) }),
    },
  ),
)

/** 这一处分栏此刻的比例(没存过就是出厂值)。**读的唯一口**。 */
export function useSplitRatio(id: string): number {
  return useSplitPrefs((st) => st.ratios[id] ?? DEFAULT_SPLIT_RATIOS[id] ?? 50)
}
