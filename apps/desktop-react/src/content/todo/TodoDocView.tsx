import { useCallback, useRef, useState, type ReactNode } from 'react'
import { FocusScope } from '../../focus/FocusScope'
import { useT } from '../../i18n'
import { EditableDoc } from '../editing/EditableDoc'
import type { EditorDocument } from '../editing/editor-document'
import { useTodoPreferences } from './preferences'

/**
 * 一份待办文档的编辑视图:`EditableDoc` + 待办的焦点作用域 + 显示档位偏好。
 * 计划抽屉与清单面板共用这一件,差别只有 `density`。
 */
export function TodoDocView({ document, density, owner }: {
  document: EditorDocument
  density: 'drawer' | 'panel'
  /** 焦点树上这一格的实例名(同一种面多份时区分)。 */
  owner: string
}): ReactNode {
  const t = useT()
  const mode = useTodoPreferences(s => s.revealMode)
  const [editing, setEditing] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const checkLabel = useCallback((done: boolean) => t(done ? 'todo.uncheck' : 'todo.check'), [t])
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
          />
        </div>
      )}
    </FocusScope>
  )
}
