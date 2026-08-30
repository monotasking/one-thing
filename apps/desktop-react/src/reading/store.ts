import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import {
  DEFAULT_READING_AXES,
  clampReadingAxes,
  motionTier,
  type MotionTier,
  type ReadingAxes,
  type ReadingColumn,
  type ReadingDensity,
  type ReadingFontSize,
} from './types'

/**
 * 阅读轴的 store —— 照 stage/store.ts 的惯例:`persist` + localStorage,
 * 逻辑一行不写在这里(判据在 types.ts 的纯函数里,贴 DOM 在 apply.ts 里)。
 *
 * 为什么它不并进 stage/store:那个 store 说的是「外壳怎么摆」(Dock 在哪、
 * 窗开在哪),这个说的是「读物怎么排」。两件事的读者不同、生命周期不同 ——
 * 外壳的形态是工作台状态,阅读轴是一条**偏好**,清工作台不该把它一起清了。
 */
interface ReadingStore extends ReadingAxes {
  setFontSize: (v: ReadingFontSize) => void
  setDensity: (v: ReadingDensity) => void
  setColumn: (v: ReadingColumn) => void
  /** 选动效档 = 同时记下「用户亲手选过」(见 types.ts 的 motionChosen)。 */
  setMotion: (v: MotionTier) => void
}

export const useReadingStore = create<ReadingStore>()(
  persist(
    (set) => ({
      ...DEFAULT_READING_AXES,
      setFontSize: (fontSize) => set({ fontSize }),
      setDensity: (density) => set({ density }),
      setColumn: (column) => set({ column }),
      setMotion: (motion) => set({ motion, motionChosen: true }),
    }),
    {
      name: 'onething.reading',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // 合并处钳一次档值:存盘可能来自旧版本、也可能被人手改过。
      // 与 stage/store 的 merge 同一条理由(迁移会被在飞实例的写盘绕过)。
      merge: (persisted, current) => ({
        ...current,
        ...clampReadingAxes(persisted as Partial<ReadingAxes> | undefined),
      }),
      partialize: (s) => ({
        fontSize: s.fontSize,
        density: s.density,
        column: s.column,
        motion: s.motion,
        motionChosen: s.motionChosen,
      }),
    },
  ),
)

/** 当前存着的四轴(不含 action)—— 给 apply 与设置面读。 */
export function readingAxes(state: ReadingStore): ReadingAxes {
  return {
    fontSize: state.fontSize,
    density: state.density,
    column: state.column,
    motion: state.motion,
    motionChosen: state.motionChosen,
  }
}

/**
 * 设置面上那枚动效分段器该高亮哪一段 —— 是**此刻生效的档**,不是存着的那个。
 * 系统开着减弱、用户没选过时,面上就该显示「无」:显示「标准」而屏幕上不动,
 * 是在骗人。
 */
export function effectiveMotionTier(state: ReadingStore, systemPrefersReduced: boolean): MotionTier {
  return motionTier(readingAxes(state), systemPrefersReduced)
}
