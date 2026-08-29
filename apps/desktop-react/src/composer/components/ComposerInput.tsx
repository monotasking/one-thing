import { useImperativeHandle, useRef } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { parseToken } from '../transitions'
import type { TokenHit } from '../types'
import s from './Composer.module.css'

/**
 * 本体行的输入面。它是 composer 里**唯一**一块直接动 DOM 的地方,理由是
 * 行内 chip:@ 引用要变成一枚不可编辑的整体(退格是整枚删),
 * 而 React 的受控 value 表达不了「文本 + 不可编辑节点」的混排。
 *
 * 所以这里的分工是:光标在哪、插进哪 —— 宿主的事实,由这个文件量;
 * 「这截 token 算不算触发」「命中哪几条」—— 判断,全在 transitions 里。
 * 这个文件一条业务规则都不许有。
 */

export interface ComposerInputHandle {
  focus: () => void
  /** 把光标处的 @xx / /xx 换成一枚 chip(files)或命令徽(commands) */
  insert: (kind: 'files' | 'commands', label: string) => void
  text: () => string
  clear: () => void
}

interface Props {
  apiRef: RefObject<ComposerInputHandle | null>
  placeholder: string
  /** files / commands 抽屉是否开着 —— 开着时上下键与回车归抽屉,不归输入框 */
  picking: boolean
  onToken: (hit: TokenHit | null) => void
  onMove: (delta: number) => void
  onPick: () => void
  onEscape: () => void
  onSend: (text: string) => void
}

/** 光标之前那一截文本 + 它落在哪个文本节点上。不在文本节点里就没有 token 可言。 */
function caretToken(
  el: HTMLElement,
): { hit: TokenHit; node: Text; offset: number } | null {
  const sel = typeof window === 'undefined' ? null : window.getSelection()
  const node = sel?.anchorNode
  if (!node || node.nodeType !== Node.TEXT_NODE || !el.contains(node)) return null
  const offset = sel?.anchorOffset ?? 0
  const upto = (node.textContent ?? '').slice(0, offset)
  const hit = parseToken(upto, el.textContent ?? '')
  return hit ? { hit, node: node as Text, offset } : null
}

export function ComposerInput({
  apiRef,
  placeholder,
  picking,
  onToken,
  onMove,
  onPick,
  onEscape,
  onSend,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useImperativeHandle(apiRef, () => ({
    focus: () => ref.current?.focus(),
    text: () => ref.current?.textContent ?? '',
    clear: () => {
      if (ref.current) ref.current.innerHTML = ''
    },
    insert: (kind, label) => {
      const el = ref.current
      if (!el) return
      const cur = caretToken(el)
      if (!cur) return
      const raw = cur.node.textContent ?? ''
      // 把 @xx / /xx 那一截原地摘掉,chip 补在原位,后半截原样跟上。
      const before = raw.slice(0, cur.offset).replace(/(@|\/)[\w.-]*$/, '')
      const rest = raw.slice(cur.offset)
      const chip = document.createElement('span')
      chip.className = kind === 'files' ? s.chip : s.cmdTok
      chip.textContent = kind === 'files' ? `@${label}` : label
      chip.contentEditable = 'false'
      const after = document.createTextNode(` ${rest}`)
      cur.node.textContent = before
      cur.node.parentNode?.insertBefore(chip, cur.node.nextSibling)
      chip.parentNode?.insertBefore(after, chip.nextSibling)
      // 光标落在 chip 后那个空格之后:接着打字就是接着说话。
      const range = document.createRange()
      const sel = window.getSelection()
      range.setStart(after, 1)
      range.collapse(true)
      sel?.removeAllRanges()
      sel?.addRange(range)
      el.focus()
    },
  }))

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (picking) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        onMove(1)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        onMove(-1)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        onPick()
        return
      }
      if (e.key === 'Escape') {
        // 抽屉先吃掉这一下:外层(舞台 / 浮窗)只在 !defaultPrevented 时才轮到它。
        e.preventDefault()
        onEscape()
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSend(ref.current?.textContent ?? '')
    }
  }

  // `data-testid` 是给门用的落点:aria-label 是翻译过的文案,会跟着系统语言变。
  return (
    <div
      ref={ref}
      className={s.input}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      /* contentEditable 本来就进 tab 序,但那是**浏览器行为**;role="textbox" 是
       * 给辅助技术的**声明**。两者要对上,声明了可编辑就得显式声明可聚焦,
       * 否则读屏软件按 ARIA 的说法去找焦点会落空(jsx-a11y 揪出的就是这条)。 */
      tabIndex={0}
      aria-multiline="true"
      aria-label={placeholder}
      data-testid="composer-input"
      data-placeholder={placeholder}
      onInput={() => onToken(ref.current ? (caretToken(ref.current)?.hit ?? null) : null)}
      onKeyDown={handleKeyDown}
    />
  )
}
