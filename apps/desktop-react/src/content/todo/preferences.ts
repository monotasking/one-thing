import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { REVEAL_MODES, type RevealMode } from '../editing/reveal'

/**
 * 待办的两格视图偏好(正本 `docs/todo-2026-09.md` §5.4、`todo-editor-2026-09.md` §6.5)。
 *
 *  · `revealMode` —— 编辑时记号怎么显示:元素(缺省,与 Typora 缺省一致)/ 整块 / 不显示;
 *  · `activeNoteId` —— 清单面板上次停在哪一份;`recent` —— 切换弹层「最近」那一组。
 *
 * 都是「这个人习惯怎么看」,不进后端。存档是不可信输入:水合按形状归一,不看版本号
 * (判例 `content/settings/store.ts`)。
 */
/** 「最近」记几份(切换弹层空输入时那一组)。 */
export const TODO_RECENT_LIMIT = 5

interface TodoPreferences {
  revealMode: RevealMode
  activeNoteId: string | null
  /** 最近打开的清单 id,新的在前。 */
  recent: string[]
  setRevealMode: (mode: RevealMode) => void
  /** 换当前清单,并记进「最近」。 */
  setActiveNoteId: (id: string | null) => void
  /** 改名 / 删除之后把旧 id 换成新 id(或摘掉),「当前」与「最近」一起跟着。 */
  replaceNoteId: (from: string, to: string | null) => void
}

export const useTodoPreferences = create<TodoPreferences>()(
  persist(
    set => ({
      revealMode: 'element',
      activeNoteId: null,
      recent: [],
      setRevealMode: revealMode => set({ revealMode }),
      setActiveNoteId: activeNoteId => set(st => ({
        activeNoteId,
        recent: activeNoteId ? [activeNoteId, ...st.recent.filter(id => id !== activeNoteId)].slice(0, TODO_RECENT_LIMIT) : st.recent,
      })),
      replaceNoteId: (from, to) => set(st => ({
        activeNoteId: st.activeNoteId === from ? to : st.activeNoteId,
        recent: st.recent.flatMap(id => (id === from ? (to ? [to] : []) : [id])),
      })),
    }),
    {
      name: 'onething.todo',
      storage: createJSONStorage(() => localStorage),
      merge: (persisted, current) => {
        const raw = persisted as { revealMode?: unknown; activeNoteId?: unknown; recent?: unknown } | undefined
        return {
          ...current,
          revealMode: REVEAL_MODES.includes(raw?.revealMode as RevealMode) ? (raw?.revealMode as RevealMode) : 'element',
          activeNoteId: typeof raw?.activeNoteId === 'string' ? raw.activeNoteId : null,
          recent: Array.isArray(raw?.recent) ? raw.recent.filter((id): id is string => typeof id === 'string').slice(0, TODO_RECENT_LIMIT) : [],
        }
      },
      partialize: s => ({ revealMode: s.revealMode, activeNoteId: s.activeNoteId, recent: s.recent }),
    },
  ),
)
