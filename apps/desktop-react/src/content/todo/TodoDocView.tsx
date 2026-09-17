import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { FocusScope } from '../../focus/FocusScope'
import { useT } from '../../i18n'
import type { CaretController } from '../editing/caret-controller'
import { EditableDoc, type HeadingFold } from '../editing/EditableDoc'
import type { EditorDocument } from '../editing/editor-document'
import type { FoldRow } from '../editing/fold-row'
import { useTodoPreferences } from './preferences'
import { todoViewOf, unhideSteps } from './todo-view'

const NO_SECTIONS: readonly string[] = []

/**
 * 一份待办文档的编辑视图:`EditableDoc` + 待办的焦点作用域 + 显示偏好。
 * 计划抽屉与清单面板共用这一件,差别只有 `density`。
 *
 * **怎么看**(B 形 U5):已完成收起 / 小节折叠由 `todoViewOf` 按原文与偏好算出来,交给编辑器的
 * `hidden` / `folds` / `headingFolds`;折叠状态按 `owner` 记(一份文档一份),全局「显示已完成」
 * 在 ⋯ 菜单里。原文一个字不动。
 */
export function TodoDocView({ document, density, owner, reveal, onRevealed }: {
  document: EditorDocument
  density: 'drawer' | 'panel'
  /** 焦点树上这一格的实例名(同一种面多份时区分),也是折叠状态记账的键。 */
  owner: string
  /** 要露出来并滚到的那一行(从搜索结果打开一项);`at` 让同一行连点两次也算两次。 */
  reveal?: { readonly line: number; readonly at: number } | null
  /** 露出来了(或那一行已经不在了)—— 调用方把这件事消费掉。 */
  onRevealed?: () => void
}): ReactNode {
  const t = useT()
  const mode = useTodoPreferences(s => s.revealMode)
  const showDone = useTodoPreferences(s => s.showDone)
  const doneOpenList = useTodoPreferences(s => s.doneOpen[owner] ?? NO_SECTIONS)
  const foldedList = useTodoPreferences(s => s.folded[owner] ?? NO_SECTIONS)
  const toggleDoneOpen = useTodoPreferences(s => s.toggleDoneOpen)
  const toggleFolded = useTodoPreferences(s => s.toggleFolded)
  const setDoneOpen = useTodoPreferences(s => s.setDoneOpen)
  const setFolded = useTodoPreferences(s => s.setFolded)
  const [editing, setEditing] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const controllerRef = useRef<CaretController | null>(null)
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

  /*
   * 从搜索结果打开的那一项:它可能正收在「已完成」里、或在折起来的节里 —— 先把盖住它的那几格拨开
   * (设成确定的一档,不是翻转),下一次渲染它露出来了再滚过去、淡闪一下,然后把这件事交回去。
   * 行元素在编辑器的提交里就挂上了(子组件的效应先于这里跑);还找不到就再等一帧,仍找不到就算了。
   */
  const revealedFor = useRef<number | null>(null)
  useEffect(() => {
    if (!reveal || revealedFor.current === reveal.at) return
    if (view.hidden.has(reveal.line)) {
      const steps = unhideSteps(lines, reveal.line, { showDone, doneOpen: new Set(doneOpenList), folded: new Set(foldedList) })
      for (const section of steps.unfold) setFolded(owner, section, false)
      if (steps.openDone !== null) setDoneOpen(owner, steps.openDone, true)
      if (steps.unfold.length || steps.openDone !== null) return
    }
    const land = () => {
      const row = rootRef.current?.querySelector<HTMLElement>(`[data-unit="${reveal.line}"]`)
      if (!row) return false
      revealedFor.current = reveal.at
      row.scrollIntoView({ block: 'center' })
      document.flash([reveal.line])
      onRevealed?.()
      return true
    }
    if (land()) return
    const frame = requestAnimationFrame(() => {
      if (land()) return
      revealedFor.current = reveal.at
      onRevealed?.()
    })
    return () => cancelAnimationFrame(frame)
  }, [reveal, view, lines, showDone, doneOpenList, foldedList, owner, setFolded, setDoneOpen, document, onRevealed])

  return (
    <FocusScope
      scope="todo"
      owner={owner}
      rootRef={rootRef}
      claiming={editing}
      restingTarget={() => rootRef.current?.querySelector<HTMLElement>('[role="group"]') ?? null}
      /*
       * 编辑中按 Esc = 离开这一项,**只退这一层**。不答的话派发器沿活动路径往外问,第一个答得出的是
       * 装着这块面的浮窗 / 架子 —— 整扇待办窗被 Esc 收掉(B 形 U6 `gate:todo` ⑥→⑦ 真机挖出来的,
       * main 上就有)。没在编辑时不答,Esc 照旧交给外层。
       */
      onEscape={() => {
        const controller = controllerRef.current
        if (controller?.activeStart === null || !controller) return false
        controller.close()
        return true
      }}
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
            controllerRef={controllerRef}
            hidden={view.hidden}
            folds={folds}
            headingFolds={headingFolds}
          />
        </div>
      )}
    </FocusScope>
  )
}
