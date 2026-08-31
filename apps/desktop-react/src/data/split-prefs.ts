import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

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
 * 各处分栏的出厂比例。
 *
 * 文件面板那条取 45 —— 它逐字等于 F1 那两枚 token(`--files-tree-fr: 0.9fr` /
 * `--files-viewer-fr: 1.1fr`,0.9 / (0.9+1.1) = 45%)。**改版不改手感**是有意的:
 * 这一批加的是「能拖」,不是「换一个新的默认」。
 */
export const DEFAULT_SPLIT_RATIOS: Record<string, number> = {
  [FILES_SPLIT_ID]: 45,
}

/** 拖到头的两档。留 15% 是因为再窄的一栏里什么都读不出来,那不是「收起」而是「坏了」。 */
export const SPLIT_MIN = 15
export const SPLIT_MAX = 85

interface SplitPrefsStore {
  ratios: Record<string, number>
  setRatio: (id: string, ratio: number) => void
}

function clampRatio(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Math.round(value)))
}

export const useSplitPrefs = create<SplitPrefsStore>()(
  persist(
    (set) => ({
      ratios: {},
      setRatio: (id, ratio) =>
        set((st) => ({
          ratios: { ...st.ratios, [id]: clampRatio(ratio, DEFAULT_SPLIT_RATIOS[id] ?? 50) },
        })),
    }),
    {
      name: 'onething.split',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      /*
       * 存盘可能来自旧版本、也可能被人手改过:每一格都钳一次,认不出的整条丢掉。
       * 同 file-open-mode / reading store 的 merge 钳制 —— 一个从盘上读回来的
       * `-3` 会让分栏当场塌成一条缝,而那种坏法查起来像是布局 bug。
       */
      merge: (persisted, current) => {
        const saved = (persisted as Partial<SplitPrefsStore> | undefined)?.ratios
        const ratios: Record<string, number> = {}
        if (saved && typeof saved === 'object') {
          for (const [id, value] of Object.entries(saved)) {
            ratios[id] = clampRatio(value, DEFAULT_SPLIT_RATIOS[id] ?? 50)
          }
        }
        return { ...current, ratios }
      },
      partialize: (st) => ({ ratios: st.ratios }),
    },
  ),
)

/** 这一处分栏此刻的比例(没存过就是出厂值)。**读的唯一口**。 */
export function useSplitRatio(id: string): number {
  return useSplitPrefs((st) => st.ratios[id] ?? DEFAULT_SPLIT_RATIOS[id] ?? 50)
}
