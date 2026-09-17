import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { LINE_CHANGED_MS } from '../../components/motion'
import { ButtonBase } from '../../ui/ButtonBase'
import { Checkbox } from '../../ui/Checkbox'
import headingStyles from '../blocks/kinds/heading/Heading.module.css'
import listStyles from '../blocks/kinds/list/List.module.css'
import paragraphStyles from '../blocks/kinds/paragraph/Paragraph.module.css'
import quoteStyles from '../blocks/kinds/quote/Quote.module.css'
import inlineStyles from '../blocks/inline/InlineRun.module.css'
import shellStyles from '../blocks/shell/BlockShell.module.css'
import { CaretController, type EditorDom } from './caret-controller'
import type { EditorDocument } from './editor-document'
import type { PaintClasses } from './paint'
import type { RevealMode } from './reveal'
import { isList, parseUnits, type ListUnit, type Unit } from './units'
import s from './EditableDoc.module.css'

/**
 * 一份可编辑的 markdown 文档(正本 `docs/todo-editor-2026-09.md`)。
 *
 * 不在编辑的项按消息的块样式画;按下鼠标或键盘进入某一项时,那一项的内容元素原地变成编辑区,
 * 由 `CaretController` 接管 —— 它按同一份切分重画这一格的 `innerHTML`、放回光标;React 从不
 * 往编辑区里渲子节点(否则会在光标底下重排 DOM)。与「待办」无关:文档从哪来、存到哪去,
 * 都在 `EditorDocument` 的 channel 里。
 *
 * ══ 三张状态表 ══════════════════════════════════════════════════════════
 * ① 生命周期
 *   挂载  —— 订文档变化,建控制器(同一份文档一个);
 *   换宿主 —— 抽屉 ↔ 面板 ↔ 浮窗是一次重挂:控制器随组件重建,编辑状态不跨宿主保留
 *            (离开前 `close()` 已经把改动写回文档并 flush),光标落回渲染态;
 *   卸载  —— 控制器 dispose;文档的 flush 由持有文档的一层负责。
 * ② UI 生命状态
 *   空文档 → 只有「+ 添加一项」;ready → 块;编辑中 → 那一项换成编辑区,其余不动;
 *   外部改动 → 新出现的行淡底一次(`--dur-line-changed`);超量 → 按行解析每次按键只重画一格。
 * ③ UI 交互状态
 *   列表行:rest / hover(整行淡底,包住勾选框)/ 编辑中(底色与 hover 同,光标 + 淡灰记号);
 *   标题 / 段落 / 引用:rest / hover 无底只换文字光标 / 编辑中;代码卡:hover 与编辑中边线加深;
 *   组字中:结构键交给输入法。
 * ══════════════════════════════════════════════════════════════════════
 */

export interface EditableDocProps {
  readonly document: EditorDocument
  readonly mode: RevealMode
  /** 给读屏的名字。 */
  readonly label: string
  readonly addLabel: string
  readonly checkLabel: (done: boolean) => string
  readonly density?: 'drawer' | 'panel'
  /** 编辑开始 / 结束(外层据它认领快捷键)。 */
  readonly onEditingChange?: (editing: boolean) => void
  /** 拿到这份文档的光标控制器(外层要「打开第一项」、实验台要读光标时用)。 */
  readonly controllerRef?: { current: CaretController | null }
}

const PAINT_CLASSES: PaintClasses = {
  code: inlineStyles.code,
  link: inlineStyles.link,
  mark: s.mark,
  url: s.url,
  current: s.current,
}

function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ')
}

const INDENT_CLASS = ['', s.indent1, s.indent2, s.indent3]

interface UnitRowProps {
  readonly unit: Unit
  readonly text: string
  readonly active: boolean
  readonly changed: boolean
  readonly html: string
  readonly register: (start: number, element: HTMLElement | null) => void
  readonly onToggle: (line: number) => void
  readonly checkLabel: (done: boolean) => string
}

/**
 * 一项。内容元素的子节点**只经 `innerHTML`**:渲染态在这里写,编辑态由控制器写。
 * memo 的键是这一项的原文 + 是否在编辑 + 是否刚被改过 —— 打字只重画那一格。
 */
const UnitRow = memo(function UnitRow({ unit, active, changed, html, register, onToggle, checkLabel }: UnitRowProps) {
  const contentRef = useRef<HTMLElement | null>(null)
  const setContent = useCallback((element: HTMLElement | null) => {
    contentRef.current = element
    register(unit.start, element)
  }, [register, unit.start])

  useLayoutEffect(() => {
    if (!active && contentRef.current) contentRef.current.innerHTML = html || '​'
  }, [active, html])

  const content = (
    <div
      ref={setContent}
      className={cx(s.content, unit.type === 'code' && s.codeBody, changed && s.changed)}
      contentEditable={active ? 'true' : undefined}
      suppressContentEditableWarning
      role={active ? 'textbox' : undefined}
      aria-multiline={active ? unit.type === 'para' || unit.type === 'quote' || unit.type === 'code' : undefined}
      spellCheck={false}
      data-focus-ring="none"
    />
  )

  switch (unit.type) {
    case 'heading':
      return (
        <div className={cx(headingStyles[`h${unit.level}`], s.unit)} data-prose={`h${unit.level}`} data-unit={unit.start} data-active={active}>
          {content}
        </div>
      )
    case 'quote':
      return (
        <blockquote className={cx(quoteStyles.quote, s.unit)} data-prose="text" data-unit={unit.start} data-active={active}>
          {content}
        </blockquote>
      )
    case 'code':
      return (
        <div className={cx(shellStyles.block, s.codeCard, s.unit)} data-prose="object" data-unit={unit.start} data-active={active}>
          {content}
        </div>
      )
    case 'para':
      return (
        <div className={cx(paragraphStyles.paragraph, s.unit)} data-prose="text" data-unit={unit.start} data-active={active}>
          {content}
        </div>
      )
    default: {
      const item = unit as ListUnit
      const task = item.type === 'task'
      return (
        <li
          className={cx(listStyles.item, s.item, s.unit, task && s.task, item.done && s.done, INDENT_CLASS[Math.min(3, Math.floor(item.indent / 2))])}
          value={item.type === 'ordered' ? item.num : undefined}
          data-unit={unit.start}
          data-active={active}
        >
          {content}
          {task && (
            <span className={s.check} data-check="">
              <Checkbox checked={item.done} onChange={() => onToggle(unit.start)} label={checkLabel(item.done)} />
            </span>
          )}
        </li>
      )
    }
  }
}, (a, b) => a.text === b.text && a.active === b.active && a.changed === b.changed && a.html === b.html
  && a.unit.type === b.unit.type && a.unit.start === b.unit.start && a.checkLabel === b.checkLabel)

export function EditableDoc({ document, mode, label, addLabel, checkLabel, density = 'panel', onEditingChange, controllerRef }: EditableDocProps): ReactNode {
  const lines = useSyncExternalStore(
    useCallback((notify: () => void) => document.subscribe(notify), [document]),
    () => document.lines,
  )
  const [activeStart, setActiveStart] = useState<number | null>(null)
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const contents = useRef(new Map<number, HTMLElement>())
  const modeRef = useRef(mode)
  modeRef.current = mode
  const editingRef = useRef(onEditingChange)
  editingRef.current = onEditingChange

  const register = useCallback((start: number, element: HTMLElement | null) => {
    if (element) contents.current.set(start, element)
    else if (contents.current.get(start)?.isConnected === false) contents.current.delete(start)
  }, [])

  const controller = useMemo(() => {
    const dom: EditorDom = {
      unitContent: start => {
        const element = contents.current.get(start)
        return element?.isConnected ? element : null
      },
      scroller: () => containerRef.current?.closest<HTMLElement>('[data-scroll-root]') ?? containerRef.current?.parentElement ?? null,
      commit: () => flushSync(() => bump()),
    }
    return new CaretController(document, dom, {
      mode: () => modeRef.current,
      classes: PAINT_CLASSES,
      onActiveChange: start => {
        setActiveStart(start)
        editingRef.current?.(start !== null)
      },
    })
  }, [document])

  useEffect(() => controller.attach(), [controller])

  useEffect(() => {
    if (!controllerRef) return undefined
    controllerRef.current = controller
    return () => { if (controllerRef.current === controller) controllerRef.current = null }
  }, [controller, controllerRef])

  // 档位变了:正在编辑的那一格按新规则重画。
  useLayoutEffect(() => { controller.repaint() }, [controller, mode])

  // 浏览器事件里 React 不代理的那几种:beforeinput(要 inputType)、选区、拖选、点到文档外。
  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined
    const onBeforeInput = (event: Event) => controller.handleBeforeInput(event as InputEvent)
    const onSelection = () => controller.handleSelectionChange()
    const onMove = (event: MouseEvent) => controller.handlePointerMove(event)
    const onUp = () => controller.handlePointerUp()
    const onOutside = (event: MouseEvent) => {
      if (controller.activeStart === null) return
      if (event.target instanceof Node && container.contains(event.target)) return
      controller.close()
    }
    container.addEventListener('beforeinput', onBeforeInput)
    globalThis.document.addEventListener('selectionchange', onSelection)
    globalThis.document.addEventListener('mousemove', onMove)
    globalThis.document.addEventListener('mouseup', onUp)
    globalThis.document.addEventListener('mousedown', onOutside, true)
    return () => {
      container.removeEventListener('beforeinput', onBeforeInput)
      globalThis.document.removeEventListener('selectionchange', onSelection)
      globalThis.document.removeEventListener('mousemove', onMove)
      globalThis.document.removeEventListener('mouseup', onUp)
      globalThis.document.removeEventListener('mousedown', onOutside, true)
    }
  }, [controller])

  const units = useMemo(() => parseUnits(lines), [lines])
  const now = Date.now()
  for (const [line, at] of document.recentlyChanged) if (now - at > LINE_CHANGED_MS) document.recentlyChanged.delete(line)

  const onMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('[data-check]') || target.closest('[data-add]')) return
    const row = target.closest<HTMLElement>('[data-unit]') ?? nearestRow(containerRef.current, event.clientY)
    const handled = controller.handlePointerDown(event.nativeEvent, row ? Number(row.dataset.unit) : null)
    if (handled) event.preventDefault()
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (controller.activeStart === null) {
      // ui-consume-allow: kbd-select-handwritten — 文本编辑器的光标进入,不是候选列表选择(没有 active 下标)
      // 文档本身拿着焦点(键盘 Tab 进来):↵ / ↓ 进第一项,↑ 进最后一项。
      if (event.target !== containerRef.current) return
      if (event.key === 'Enter' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const target = event.key === 'ArrowUp' ? units[units.length - 1] : units[0]
        if (target) { event.preventDefault(); controller.open(target.start, event.key === 'ArrowUp' ? 'end' : 0) }
      }
      return
    }
    controller.handleKeyDown(event.nativeEvent)
  }

  const onToggle = useCallback((line: number) => controller.toggleTask(line), [controller])

  const rows: ReactNode[] = []
  for (let index = 0; index < units.length;) {
    const unit = units[index]
    const row = (u: Unit) => {
      const text = lines.slice(u.start, u.end + 1).join('\n')
      return (
        <UnitRow
          key={`${u.start}:${u.type}`}
          unit={u}
          text={text}
          active={activeStart === u.start}
          changed={document.recentlyChanged.has(u.start)}
          html={controller.restingHtml(u, lines)}
          register={register}
          onToggle={onToggle}
          checkLabel={checkLabel}
        />
      )
    }
    if (isList(unit)) {
      const ordered = unit.type === 'ordered'
      const items: ReactNode[] = []
      const first = unit.start
      while (index < units.length && isList(units[index]) && (units[index].type === 'ordered') === ordered) {
        items.push(row(units[index]))
        index++
      }
      rows.push(ordered
        ? <ol key={`ol:${first}`} className={listStyles.list} data-prose="text">{items}</ol>
        : <ul key={`ul:${first}`} className={listStyles.list} data-prose="text">{items}</ul>)
      continue
    }
    rows.push(row(unit))
    index++
  }

  return (
    /* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions --
       一份可编辑文档的容器:键盘 / 指针 / 输入法事件在这里汇给唯一的光标控制器,
       真正拿焦点、可输入的是里面那一格 contentEditable;容器本身没有「按一下」的语义可给 role */
    <div
      ref={containerRef}
      className={s.flow}
      data-density={density}
      role="group"
      aria-label={label}
      tabIndex={activeStart === null ? 0 : -1}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
      onInput={() => controller.handleInput()}
      onCompositionStart={() => controller.handleCompositionStart()}
      onCompositionEnd={event => controller.handleCompositionEnd(event.data)}
      onCopy={event => {
        const text = controller.selectedText()
        if (text === null) return
        event.preventDefault()
        event.clipboardData.setData('text/plain', text)
      }}
      onCut={event => {
        const text = controller.selectedText()
        if (text === null) return
        event.preventDefault()
        event.clipboardData.setData('text/plain', text)
        controller.cutSelection()
      }}
    >
      {rows}
      <ButtonBase className={s.add} data-add="" onClick={() => controller.insertAfterLastTask()}>
        {addLabel}
      </ButtonBase>
    </div>
  )
}

/**
 * 按下没落在任何一项上(行间的缝、勾选框左边)时找最近那一项的范围。它是命中判据的一段距离,
 * 不是样式:比一行高多一点,缝与勾选框左边都在里面,离开文档太远的空白不会误进编辑。
 */
const NEAREST_ROW_REACH = 24

/** 按下没落在任何一项上:找垂直方向 `NEAREST_ROW_REACH` 以内最近的那一项。 */
function nearestRow(container: HTMLElement | null, y: number): HTMLElement | null {
  if (!container) return null
  let best: HTMLElement | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const row of container.querySelectorAll<HTMLElement>('[data-unit]')) {
    const box = row.getBoundingClientRect()
    const distance = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0
    if (distance < bestDistance) { bestDistance = distance; best = row }
  }
  return bestDistance <= NEAREST_ROW_REACH ? best : null
}
