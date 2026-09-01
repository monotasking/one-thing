import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Search } from '../../components/icons'
import { Kbd } from '../../ui/Kbd'
import { useFocusTrap } from '../../ui/a11y/focus-trap'
import { useListSelection } from '../../ui/a11y/list-selection'
import { ButtonBase } from '../../ui/ButtonBase'
import { useT } from '../../i18n'
import { currentKeymapPlatform, useKeymapStore } from '../../keymap/store'
import { effectiveCombo, formatCombo, workspaceSlotCommandId } from '../../keymap/transitions'
import { filterWorkspaces } from '../projection'
import { useWorkspaceStore, useWorkspaceViews } from '../store'
import type { WorkspaceView } from '../types'
import { useWorkspacePalette } from './palette-hub'
import sw from '../swatch.module.css'
import s from './WorkspacePalette.module.css'

/**
 * 工作区命令面板(⌘⇧W)。**过滤 + ↵ 切换 + ⌘序号直达**,三件事,没有第四件。
 *
 * 它与 Dock 右键那张快切表读的是**同一份分子**(useWorkspaceViews → WorkspaceView),
 * 所以「哪个是当前」「⌘2 是谁」两处逐字同源;粗细不同只是画法不同。
 *
 * ── 为什么不是 ui/Dialog ────────────────────────────────────────────────
 * Dialog 是「问一句、等一个答复」的模态,身量与版式(标题 / 正文 / 底部按钮排)
 * 都为那件事定的。命令面板是**过路件**:一行输入 + 一列命中 + 一条脚注,
 * 落点在视线上三分之一而不是正中。所以它复用的是 Dialog 的**地基件**
 * (ui/a11y/focus-trap 与同一块遮罩配方),不是 Dialog 本身 —— 零新原语说的是
 * 不许再造一套浮层机制,不是不许有第二种版式。
 *
 * ── 键盘表 ──────────────────────────────────────────────────────────────
 *   ↑ / ↓        在命中之间移动(循环)
 *   ↵            切到当前高亮的那个工作区
 *   ⌘1 / ⌘2 / ⌘3 直达 —— 这一下**不经过面板**:它是全局快捷键,派发器早接了,
 *                面板只是把键面画出来告诉你有这条路(所以面板开着按 ⌘2 照样好使)
 *   Esc          关(ui/a11y/focus-trap 把焦点还给开它的那个元素)
 * 焦点一开就落在输入框:面板存在的意义就是让你直接打字。
 * ──────────────────────────────────────────────────────────────────────
 */
export function WorkspacePalette() {
  const t = useT()
  const open = useWorkspacePalette((st) => st.open)
  const setOpen = useWorkspacePalette((st) => st.setOpen)
  const views = useWorkspaceViews()
  const switchTo = useWorkspaceStore((st) => st.switchTo)
  const createWorkspace = useWorkspaceStore((st) => st.createWorkspace)
  const busy = useWorkspaceStore((st) => st.busy)
  const overrides = useKeymapStore((st) => st.overrides)
  const platform = currentKeymapPlatform()

  const panel = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')

  // 圈禁 Tab + 关闭时把焦点还给开它的那个元素。开启时的落点由下面那条 effect
  // 接管到输入框上 —— 容器落点(focus-trap 的默认档)对一个「直接打字」的面是错的。
  useFocusTrap(panel, open)

  const hits = useMemo(() => filterWorkspaces(views, query), [views, query])

  /** 「新建『<词>』工作区…」那一行在不在。它只在有词、且没有逐字同名的命中时出现。 */
  const offerCreate = query.trim().length > 0 && !views.some((v) => v.name === query.trim())
  const rowCount = hits.length + (offerCreate ? 1 : 0)

  /*
   * 键盘位。走法、夹范围、把当前行滚进视野全在 `ui/a11y/list-selection` 里,
   * 与 composer 的两个抽屉同一份判据。loop=true:命令面板到底了绕回头一条。
   *
   * 09-01 修:从前每一行挂着 `onMouseEnter={() => setCursor(i)}`,鼠标经过就把
   * 键盘位拽走 —— 用户裁定 hover 只是 hover。现在改它的只剩键盘与**点击**,
   * hover 由下面那两条 CSS(`.row:hover` / `.rowOn:hover`)画。
   */
  const { active: cursor, select: selectRow, handleKey, rowRef } = useListSelection({
    count: rowCount,
    loop: true,
  })

  // 每次开、每次改词都把高亮拉回第一条:命中变了还停在第三行,↵ 就会切错人。
  useEffect(() => {
    selectRow(0)
  }, [query, open, selectRow])

  useEffect(() => {
    if (!open) {
      setQuery('')
      return
    }
    input.current?.focus()
  }, [open])

  /*
   * Esc 在 **window** 上听,不在面板的 onKeyDown 里 —— 与 ui/Menu 和 ui/Dialog
   * 逐字同一手。差别不是风格:面板本地的处理器只在焦点还在面板里时才收得到,
   * 08-31 真机上一按就露馅(焦点被别处拿走之后 Esc 关不掉这块浮层)。
   * 浮层的「逃生口」必须与焦点在哪无关。
   */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!open) return null

  const create = () => {
    const name = query.trim()
    if (!name || busy) return
    void createWorkspace(name)
    setOpen(false)
  }

  const commit = (view: WorkspaceView) => {
    switchTo(view.id)
    setOpen(false)
  }

  /* 走行与落定留在面板上:它们是**输入框里的语法**,焦点恒在输入框(见上面那段
   * 键盘表),所以不该变成三条全局监听去和别的层抢键。Esc 是那条唯一的例外。
   * ↑↓/Home/End 的走法交给原语(`handleKey` 认了就自己改完位并回 true);
   * ↵ 永远落在**键盘位**上 —— 不是鼠标底下那一行。 */
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (handleKey(e.key)) {
      e.preventDefault()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const hit = hits[cursor]
      if (hit) commit(hit)
      else if (offerCreate) create()
    }
  }

  return createPortal(
    /* eslint-disable-next-line jsx-a11y/no-static-element-interactions --
     * 遮罩点击关闭是鼠标的顺手路,不是唯一出口(Esc 就在上面那张键盘表里)。
     * 判 mousedown 且 target === currentTarget:按下和松开都在遮罩上才算点遮罩,
     * 从面板里拖出去松手不该关窗。这三句逐字对齐 ui/Dialog.module.css 那件的先例。
     * 刻意不给它 role="button":遮罩不是按钮。 */
    <div
      className={s.scrim}
      data-testid="workspace-palette-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false)
      }}
    >
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions --
        * 键盘事件挂在**容器**上而不是输入框上:↑↓ 与 ↵ 在这块面里是整面的语法
        * (焦点始终在输入框,列表不接管焦点 —— 这正是命令面板的常规做法,
        * 与 composer 的候选抽屉同一手)。规则看不到那条「焦点恒在输入框」的前提,
        * 所以它在这里是误报。 */}
      <div
        ref={panel}
        className={s.panel}
        role="dialog"
        aria-modal="true"
        aria-label={t('workspace.paletteLabel')}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className={s.head}>
          <Search className={s.headIcon} strokeWidth={1.75} aria-hidden="true" />
          <input
            ref={input}
            className={s.input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('workspace.paletteSearch')}
            aria-label={t('workspace.paletteSearch')}
            aria-controls="workspace-palette-list"
            data-testid="workspace-palette-input"
          />
          <span className={s.headHint}>{t('workspace.paletteHint')}</span>
        </div>

        <div className={s.list} id="workspace-palette-list" role="listbox" aria-label={t('workspace.paletteLabel')}>
          {hits.map((view, i) => {
            const combo =
              view.slot === null
                ? null
                : effectiveCombo({ overrides }, workspaceSlotCommandId(view.slot))
            return (
              <ButtonBase
                key={view.id}
                role="option"
                ref={rowRef(i)}
                aria-selected={i === cursor}
                tabIndex={-1}
                className={i === cursor ? `${s.row} ${s.rowOn}` : s.row}
                data-testid={`workspace-palette-row-${view.id}`}
                /* 点击 = 显式意图,可以改键盘位;鼠标**经过**不行(hover 走 CSS)。 */
                onClick={() => {
                  selectRow(i)
                  commit(view)
                }}
              >
                <span className={`${s.swatch} ${sw[view.swatch]}`} aria-hidden="true" />
                <span className={s.name}>{view.name}</span>
                {/* 当前那一条也标出来 —— 面板里看不见「我在哪」的话,↵ 就是一次盲跳。 */}
                {view.isCurrent && <span className={s.current}>{t('workspace.current')}</span>}
                {combo && (
                  <span className={s.keys}>
                    {formatCombo(combo, platform).map((cap) => (
                      <Kbd key={cap}>{cap}</Kbd>
                    ))}
                  </span>
                )}
              </ButtonBase>
            )
          })}

          {offerCreate && (
            <ButtonBase
              role="option"
              ref={rowRef(hits.length)}
              aria-selected={cursor === hits.length}
              tabIndex={-1}
              className={
                cursor === hits.length ? `${s.row} ${s.rowNew} ${s.rowOn}` : `${s.row} ${s.rowNew}`
              }
              data-testid="workspace-palette-create"
              onClick={() => {
                selectRow(hits.length)
                create()
              }}
            >
              {t('workspace.createNamed', { name: query.trim() })}
            </ButtonBase>
          )}

          {rowCount === 0 && <p className={s.empty}>{t('workspace.paletteNoHit')}</p>}
        </div>

        <div className={s.foot}>
          <span>{t('workspace.footMove')}</span>
          <span>{t('workspace.footSwitch')}</span>
          <span>{t('workspace.footClose')}</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
