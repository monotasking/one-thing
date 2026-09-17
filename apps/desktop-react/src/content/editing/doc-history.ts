/**
 * 一条文档级撤销历史(正本 `docs/todo-editor-2026-09.md` §6.4)。
 *
 * **一条**,不分「编辑框里原生撤销 / 离开之后另一个栈」两层 —— 分两层的时候离开一项
 * ⌘Z 就失效,拆项并项也撤不了。每一步存「改之前的整份行 + 改之前的光标」;
 * 打字在同一项里 600ms 内合并成一步,结构编辑每次单独一步。
 *
 * 撤销恢复原文,并把光标放回那次改动之前的位置 —— 不管你之后去了哪一项。
 * 恢复出来的行照常经文档模型算成行编辑发给后端(撤销也走对账)。
 */

export interface CaretMemo {
  /** 那一项第一行的行号。 */
  readonly start: number
  readonly anchor: number
  readonly focus: number
}

export interface HistoryEntry {
  readonly lines: readonly string[]
  readonly caret: CaretMemo | null
}

export type EditKind = 'type' | 'struct'

export const TYPING_MERGE_MS = 600

export class DocHistory {
  private readonly undoStack: HistoryEntry[] = []
  private readonly redoStack: HistoryEntry[] = []
  private lastTypedAt = 0
  private lastTypedUnit: number | null = null

  constructor(private readonly now: () => number = () => Date.now(), private readonly limit = 200) {}

  /** 改动**之前**调:把那一刻记下来(打字按规则合并)。 */
  record(kind: EditKind, before: HistoryEntry): void {
    const at = this.now()
    const unit = before.caret?.start ?? null
    if (kind === 'type' && at - this.lastTypedAt < TYPING_MERGE_MS && unit === this.lastTypedUnit) {
      this.lastTypedAt = at
      return
    }
    this.undoStack.push(before)
    if (this.undoStack.length > this.limit) this.undoStack.shift()
    this.redoStack.length = 0
    this.lastTypedAt = kind === 'type' ? at : 0
    this.lastTypedUnit = kind === 'type' ? unit : null
  }

  /** 撤销:交回要恢复的那一刻;`current` 进重做栈。没得撤返回 null。 */
  undo(current: HistoryEntry): HistoryEntry | null {
    return this.move(this.undoStack, this.redoStack, current)
  }

  redo(current: HistoryEntry): HistoryEntry | null {
    return this.move(this.redoStack, this.undoStack, current)
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  clear(): void {
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.lastTypedAt = 0
    this.lastTypedUnit = null
  }

  private move(from: HistoryEntry[], to: HistoryEntry[], current: HistoryEntry): HistoryEntry | null {
    const entry = from.pop()
    if (!entry) return null
    to.push(current)
    this.lastTypedAt = 0
    this.lastTypedUnit = null
    return entry
  }
}
