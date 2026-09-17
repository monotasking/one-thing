import { useCallback, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { FocusScope } from '../../focus/FocusScope'
import { useT } from '../../i18n'
import { EditableDoc, type HeadingFold } from '../editing/EditableDoc'
import type { EditorDocument } from '../editing/editor-document'
import type { FoldRow } from '../editing/fold-row'
import { useTodoPreferences } from './preferences'
import { todoViewOf } from './todo-view'

const NO_SECTIONS: readonly string[] = []

/**
 * 一份待办文档的编辑视图:`EditableDoc` + 待办的焦点作用域 + 显示偏好。
 * 计划抽屉与清单面板共用这一件,差别只有 `density`。
 *
 * **怎么看**(B 形 U5):已完成收起 / 小节折叠由 `todoViewOf` 按原文与偏好算出来,交给编辑器的
 * `hidden` / `folds` / `headingFolds`;折叠状态按 `owner` 记(一份文档一份),全局「显示已完成」
 * 在 ⋯ 菜单里。原文一个字不动。
 */
export function TodoDocView({ document, density, owner }: {
  document: EditorDocument
  density: 'drawer' | 'panel'
  /** 焦点树上这一格的实例名(同一种面多份时区分),也是折叠状态记账的键。 */
  owner: string
}): ReactNode {
  const t = useT()
  const mode = useTodoPreferences(s => s.revealMode)
  const showDone = useTodoPreferences(s => s.showDone)
  const doneOpenList = useTodoPreferences(s => s.doneOpen[owner] ?? NO_SECTIONS)
  const foldedList = useTodoPreferences(s => s.folded[owner] ?? NO_SECTIONS)
  const toggleDoneOpen = useTodoPreferences(s => s.toggleDoneOpen)
  const toggleFolded = useTodoPreferences(s => s.toggleFolded)
  const [editing, setEditing] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const checkLabel = useCallback((done: boolean) => t(done ? 'todo.uncheck' : 'todo.check'), [t])

  const lines = useSyncExternalStore(
    useCallback((notify: () => void) => document.subscribe(notify), [document]),
    () => document.lines,
  )
  const view = useMemo(
    () => todoViewOf(lines, { showDone, doneOpen: new Set(doneOpenList), folded: new Set(foldedList) }),
    [lines, showDone, doneOpenList, foldedList],
  )
  const folds = useMemo<FoldRow[]>(() => view.folds.map(fold => (fold.kind === 'done'
    ? {
        key: fold.key,
        at: fold.at,
        open: fold.open,
        label: t('todo.doneCount', { count: fold.count }),
        onToggle: () => toggleDoneOpen(owner, fold.section),
      }
    : {
        key: fold.key,
        at: fold.at,
        open: false,
        label: t('todo.remainingCount', { count: fold.remaining }),
        onToggle: () => toggleFolded(owner, fold.section),
      })), [view, t, owner, toggleDoneOpen, toggleFolded])
  const headingFolds = useMemo(() => new Map<number, HeadingFold>([...view.headings].map(([start, heading]) => [start, {
    folded: heading.folded,
    label: t(heading.folded ? 'todo.unfoldSection' : 'todo.foldSection', { title: heading.section }),
    onToggle: () => toggleFolded(owner, heading.section),
  }])), [view, t, owner, toggleFolded])

  return (
    <FocusScope
      scope="todo"
      owner={owner}
      rootRef={rootRef}
      claiming={editing}
      restingTarget={() => rootRef.current?.querySelector<HTMLElement>('[role="group"]') ?? null}
    >
      {({ scopeProps }) => (
        <div {...scopeProps}>
          <EditableDoc
            document={document}
            mode={mode}
            density={density}
            label={t('todo.docLabel')}
            addLabel={t('todo.add')}
            checkLabel={checkLabel}
            onEditingChange={setEditing}
            hidden={view.hidden}
            folds={folds}
            headingFolds={headingFolds}
          />
        </div>
      )}
    </FocusScope>
  )
}
