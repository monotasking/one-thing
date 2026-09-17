import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { REVEAL_MODES, type RevealMode } from '../editing/reveal'

/**
 * 待办的两格视图偏好(正本 `docs/todo-2026-09.md` §5.4、`todo-editor-2026-09.md` §6.5)。
 *
 *  · `revealMode` —— 编辑时记号怎么显示:元素(缺省,与 Typora 缺省一致)/ 整块 / 不显示;
 *  · `activeNoteId` —— 清单面板上次停在哪一份。
 *
 * 都是「这个人习惯怎么看」,不进后端。存档是不可信输入:水合按形状归一,不看版本号
 * (判例 `content/settings/store.ts`)。
 */
interface TodoPreferences {
  revealMode: RevealMode
  activeNoteId: string | null
  setRevealMode: (mode: RevealMode) => void
  setActiveNoteId: (id: string | null) => void
}

export const useTodoPreferences = create<TodoPreferences>()(
  persist(
    set => ({
      revealMode: 'element',
      activeNoteId: null,
      setRevealMode: revealMode => set({ revealMode }),
      setActiveNoteId: activeNoteId => set({ activeNoteId }),
    }),
    {
      name: 'onething.todo',
      storage: createJSONStorage(() => localStorage),
      merge: (persisted, current) => {
        const raw = persisted as { revealMode?: unknown; activeNoteId?: unknown } | undefined
        return {
          ...current,
          revealMode: REVEAL_MODES.includes(raw?.revealMode as RevealMode) ? (raw?.revealMode as RevealMode) : 'element',
          activeNoteId: typeof raw?.activeNoteId === 'string' ? raw.activeNoteId : null,
        }
      },
      partialize: s => ({ revealMode: s.revealMode, activeNoteId: s.activeNoteId }),
    },
  ),
)
