import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { REVEAL_MODES, type RevealMode } from '../editing/reveal'

/**
 * 待办的两格视图偏好(正本 `docs/todo-2026-09.md` §5.4、`todo-editor-2026-09.md` §6.5)。
 *
 *  · `revealMode` —— 编辑时记号怎么显示:元素(缺省,与 Typora 缺省一致)/ 整块 / 不显示;
 *  · `activeNoteId` —— 清单面板上次停在哪一份;`recent` —— 切换弹层「最近」那一组;
 *  · `showDone` —— 全局「显示已完成」;`doneOpen` / `folded` —— **按文档**记的「这一节的已完成展开着」
 *    与「这一节折起来了」(键 = 文档的 owner,`note:<id>` / `plan:<sessionId>`;值 = 节的键,见 `todo-view.ts`)。
 *    两张表各封顶 `TODO_VIEW_DOCS_LIMIT` 份文档,最近动过的在后,超了删最早的。
 *
 * 都是「这个人习惯怎么看」,不进后端。存档是不可信输入:水合按形状归一,不看版本号
 * (判例 `content/settings/store.ts`)。
 */
/** 「最近」记几份(切换弹层空输入时那一组)。 */
export const TODO_RECENT_LIMIT = 5
/** 按文档记的折叠状态最多记几份文档(会话计划一条会话一份,不封顶会一直长)。 */
export const TODO_VIEW_DOCS_LIMIT = 200

type SectionTable = Readonly<Record<string, readonly string[]>>

/** 在一份文档的节集合里翻一个键;空了就把这份文档摘掉;最近动过的挪到最后,超了删最早的。 */
function toggleIn(table: SectionTable, doc: string, section: string): SectionTable {
  const current = table[doc] ?? []
  const next = current.includes(section) ? current.filter(key => key !== section) : [...current, section]
  const rest = Object.fromEntries(Object.entries(table).filter(([key]) => key !== doc))
  const entries = next.length ? [...Object.entries(rest), [doc, next] as const] : Object.entries(rest)
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - TODO_VIEW_DOCS_LIMIT)))
}

function renameDoc(table: SectionTable, from: string, to: string | null): SectionTable {
  if (!(from in table)) return table
  return Object.fromEntries(Object.entries(table).flatMap(([key, value]) => (key === from ? (to ? [[to, value]] : []) : [[key, value]])))
}

function sectionTableOf(raw: unknown): SectionTable {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const entries = Object.entries(raw as Record<string, unknown>)
    .map(([key, value]) => [key, Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []] as const)
    .filter(([, value]) => value.length > 0)
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - TODO_VIEW_DOCS_LIMIT)))
}

/** 一份清单文档在两张表里的键。 */
export function todoNoteViewKey(id: string): string {
  return `note:${id}`
}

interface TodoPreferences {
  revealMode: RevealMode
  activeNoteId: string | null
  /** 最近打开的清单 id,新的在前。 */
  recent: string[]
  showDone: boolean
  doneOpen: SectionTable
  folded: SectionTable
  setShowDone: (showDone: boolean) => void
  toggleDoneOpen: (doc: string, section: string) => void
  toggleFolded: (doc: string, section: string) => void
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
      showDone: false,
      doneOpen: {},
      folded: {},
      setRevealMode: revealMode => set({ revealMode }),
      setShowDone: showDone => set({ showDone }),
      toggleDoneOpen: (doc, section) => set(st => ({ doneOpen: toggleIn(st.doneOpen, doc, section) })),
      toggleFolded: (doc, section) => set(st => ({ folded: toggleIn(st.folded, doc, section) })),
      setActiveNoteId: activeNoteId => set(st => ({
        activeNoteId,
        recent: activeNoteId ? [activeNoteId, ...st.recent.filter(id => id !== activeNoteId)].slice(0, TODO_RECENT_LIMIT) : st.recent,
      })),
      replaceNoteId: (from, to) => set(st => ({
        activeNoteId: st.activeNoteId === from ? to : st.activeNoteId,
        recent: st.recent.flatMap(id => (id === from ? (to ? [to] : []) : [id])),
        doneOpen: renameDoc(st.doneOpen, todoNoteViewKey(from), to ? todoNoteViewKey(to) : null),
        folded: renameDoc(st.folded, todoNoteViewKey(from), to ? todoNoteViewKey(to) : null),
      })),
    }),
    {
      name: 'onething.todo',
      storage: createJSONStorage(() => localStorage),
      merge: (persisted, current) => {
        const raw = persisted as { revealMode?: unknown; activeNoteId?: unknown; recent?: unknown; showDone?: unknown; doneOpen?: unknown; folded?: unknown } | undefined
        return {
          ...current,
          revealMode: REVEAL_MODES.includes(raw?.revealMode as RevealMode) ? (raw?.revealMode as RevealMode) : 'element',
          activeNoteId: typeof raw?.activeNoteId === 'string' ? raw.activeNoteId : null,
          recent: Array.isArray(raw?.recent) ? raw.recent.filter((id): id is string => typeof id === 'string').slice(0, TODO_RECENT_LIMIT) : [],
          showDone: raw?.showDone === true,
          doneOpen: sectionTableOf(raw?.doneOpen),
          folded: sectionTableOf(raw?.folded),
        }
      },
      partialize: s => ({ revealMode: s.revealMode, activeNoteId: s.activeNoteId, recent: s.recent, showDone: s.showDone, doneOpen: s.doneOpen, folded: s.folded }),
    },
  ),
)
