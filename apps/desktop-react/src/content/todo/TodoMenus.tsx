import { useEffect } from 'react'
import { useQuery } from '../../data/kernel'
import { useHomeDir } from '../../data/home-dir'
import { revealPath } from '../../data/reveal-path'
import { deleteTodoNote, todoDocumentFamily, todoNoteRef, type TodoNoteSummary } from '../../data/todo-source'
import { useT } from '../../i18n'
import { useConfirm } from '../../ui/Dialog'
import { Field, useFieldControlProps } from '../../ui/Field'
import { Input } from '../../ui/Input'
import { useInlineEdit } from '../../ui/inline-edit'
import { Menu, MenuItem, MenuSection, MenuSeparator } from '../../ui/Menu'
import { REVEAL_MODES } from '../editing/reveal'
import { openFileInCurrentTarget } from '../viewer/open-target'
import { useTodoPreferences } from './preferences'
import s from './TodoHeader.module.css'

/**
 * 待办窗的两张菜单与改名框(从 T3 的面板里搬出来:B 形之后它们挂在**头**上,
 * 头与正文是两个宿主位置,见 `TodoHeader`)。
 *
 *  · ⋯ 菜单:新建清单 / 打开源文件 / 在访达中显示 / 编辑时显示记号(三档);
 *  · 右键清单名:重命名 / 在访达中显示 / 删除(`useConfirm` 二次确认,删的是文件)。
 */

export function TodoMenu({ at, note, contextual, anchor, onClose, onCreate, onRename }: {
  at: { x: number; y: number }
  note: TodoNoteSummary | undefined
  /** 右键开在清单名上(只列这一份清单的动作);否则是 ⋯ 菜单。 */
  contextual: boolean
  anchor?: () => DOMRect | null
  onClose: () => void
  onCreate: () => void
  onRename: (note: TodoNoteSummary) => void
}) {
  const t = useT()
  const confirm = useConfirm()
  const revealMode = useTodoPreferences(st => st.revealMode)
  const setRevealMode = useTodoPreferences(st => st.setRevealMode)
  const act = (action: () => void) => () => { onClose(); action() }

  return (
    <Menu x={at.x} y={at.y} onClose={onClose} label={t('todo.more')} anchor={anchor} anchorPlace="below-end">
      {contextual && note ? (
        <>
          <MenuItem onClick={act(() => onRename(note))}>{t('todo.rename')}</MenuItem>
          <NoteFileItems note={note} withOpen={false} act={act} />
          <MenuSeparator />
          <MenuItem
            danger
            onClick={act(() => {
              void confirm({
                title: t('todo.deleteTitle'),
                description: t('todo.deleteConfirm', { title: note.title }),
                confirmLabel: t('todo.delete'),
              }).then(ok => { if (ok) void deleteTodoNote.run({ id: note.id }) })
            })}
          >
            {t('todo.delete')}
          </MenuItem>
        </>
      ) : (
        <>
          <MenuItem onClick={act(onCreate)}>{t('todo.newList')}</MenuItem>
          {note && <NoteFileItems note={note} withOpen act={act} />}
          <MenuSeparator />
          <MenuSection>{t('todo.revealMode')}</MenuSection>
          {REVEAL_MODES.map(mode => (
            <MenuItem key={mode} checked={revealMode === mode} onClick={act(() => setRevealMode(mode))}>
              {t(`todo.revealMode.${mode}`)}
            </MenuItem>
          ))}
        </>
      )}
    </Menu>
  )
}

/**
 * 与一份清单的源文件有关的两项。路径在文档读数上(`document` 读法带 `filePath`),
 * 列表摘要里没有 —— 所以这一件自己问那一格(当前清单那格早已读过,别的标签上右键才会补一发)。
 */
function NoteFileItems({ note, withOpen, act }: {
  note: TodoNoteSummary
  withOpen: boolean
  act: (action: () => void) => () => void
}) {
  const t = useT()
  const canReveal = useHomeDir() !== null
  const query = todoDocumentFamily.get(todoNoteRef(note.id))
  const view = useQuery(query).data
  useEffect(() => { void query.ensure() }, [query])
  const filePath = view?.filePath || undefined
  return (
    <>
      {withOpen && (
        <MenuItem disabled={!filePath} onClick={act(() => { if (filePath) openFileInCurrentTarget(filePath) })}>
          {t('todo.openSource')}
        </MenuItem>
      )}
      <MenuItem disabled={!canReveal || !filePath} onClick={act(() => { if (filePath) void revealPath(filePath) })}>
        {t('todo.reveal')}
      </MenuItem>
    </>
  )
}

export function RenameField({ value, label, onChange, onCommit, onCancel }: {
  value: string
  label: string
  onChange: (value: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  return (
    <Field layout="inline" size="sm" labelHidden label={label} className={s.rename}>
      <RenameInput value={value} onChange={onChange} onCommit={onCommit} onCancel={onCancel} />
    </Field>
  )
}

/** 单独一件:`useFieldControlProps()` 只在 `<Field>` 之内拿得到(判例 `WorkspaceOverview.RenameInput`)。 */
function RenameInput({ value, onChange, onCommit, onCancel }: {
  value: string
  onChange: (value: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  const field = useFieldControlProps()
  const edit = useInlineEdit({ controlId: field.id, onCommit, onCancel })
  return <Input {...field} {...edit} size="sm" className={s.renameInput} value={value} onValueChange={onChange} data-todo-rename="" />
}
