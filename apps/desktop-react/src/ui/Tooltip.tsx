import { cloneElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactElement, ReactNode } from 'react'
import { TOOLTIP_DELAY_MS } from '../components/motion'
import s from './Tooltip.module.css'

/**
 * 规范画布「层级 · 浮层三件套」板的 Tooltip:反色墨底、r-1、无箭头、**无位移**入场,
 * 只淡入。板上写的是延迟 400ms 出现;仓里已经有一枚 --dur-tooltip-delay(300ms)
 * 和它在 JS 侧的镜像 TOOLTIP_DELAY_MS —— 一个数只该有一个出处,所以默认值取既有那枚,
 * 需要更慢的调用方自己传 delayMs。改延迟改 token,两处 tooltip 一起变。
 *
 * portal 到 body 不是洁癖(与 Menu 同一条判例):Dock 条上有 backdrop-filter,
 * 而 backdrop-filter 会给 position:fixed 的后代造包含块,留在原地会以 Dock 为原点定位。
 *
 * 定位:锚点正上方居中;顶不下时翻到下方。就这一次翻转,不引定位库 ——
 * 引一个库进来是为了处理十种边界,而系统里的 tooltip 只有这一种。
 * 退场直接消失(板上只给了入场,没给出场;不淡出是因为鼠标已经走了,留着才碍事)。
 *
 * 它不认识业务:content 是调用方经 i18n 给的字符串。
 * 不做「给禁用元素包一层代理」那套 —— 禁用元素本来就不该只靠 tooltip 说话。
 *
 * ── 键盘表(A11y 线 · A2)───────────────────────────────────────────────
 *   聚焦锚点(Tab 走到它)   与 hover 同一条路,同样延迟后出现
 *   Esc                    当场消失,**不关**锚点所在的任何浮层
 *                          (APG:tooltip 的 Esc 只消 tooltip)
 * 语义:提示体 role=tooltip,出现期间锚点带 aria-describedby 指着它 ——
 * 「这个控件还有一句补充说明」得说得出口,光画在屏幕上不算。
 * 它自己**永不进 Tab 序**:提示不是控件。
 * ──────────────────────────────────────────────────────────────────────
 */
interface TooltipProps {
  /** 提示文字。走 i18n,组件里不落字面。 */
  content: ReactNode
  /** 悬停/聚焦多久才出现。默认 = --dur-tooltip-delay 的 JS 镜像。 */
  delayMs?: number
  children: ReactElement<Record<string, unknown>>
}

interface Pos {
  left: number
  top: number
  below: boolean
}

export function Tooltip({ content, delayMs = TOOLTIP_DELAY_MS, children }: TooltipProps) {
  const anchor = useRef<HTMLElement | null>(null)
  const tip = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [pos, setPos] = useState<Pos | null>(null)
  const tipId = useId()

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setPos(null)
  }, [])

  const show = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const r = anchor.current?.getBoundingClientRect()
      if (!r) return
      setPos({ left: r.left + r.width / 2, top: r.top, below: false })
    }, delayMs)
  }, [delayMs])

  useEffect(() => hide, [hide])

  /*
   * Esc 消提示。只在提示**已经出现**时挂监听:不挂着不该属于自己的键 ——
   * tooltip 消失了还吃 Esc,会把它所在的对话框那一下也吞掉。
   * 不 preventDefault / 不 stopPropagation 同理:消掉提示之后,这一下 Esc
   * 该继续传给谁就传给谁(APG 明说 tooltip 的 Esc 不该拦别人)。
   */
  useEffect(() => {
    if (!pos) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pos, hide])

  // 先按「上方」画一帧,量到真高后在同一帧内决定翻不翻 —— 用户看不到中间态(同 Menu 的做法)。
  useLayoutEffect(() => {
    if (!pos || pos.below) return
    const el = tip.current
    const r = anchor.current?.getBoundingClientRect()
    if (!el || !r) return
    if (el.getBoundingClientRect().top < 0) setPos({ left: pos.left, top: r.bottom, below: true })
  }, [pos])

  const child = cloneElement(children, {
    ref: anchor,
    onMouseEnter: show,
    onMouseLeave: hide,
    onFocus: show,
    onBlur: hide,
    // 只在提示在场时指过去 —— 指一个还没渲染出来的 id 是一条断掉的引用。
    'aria-describedby': pos ? tipId : undefined,
  })

  return (
    <>
      {child}
      {pos &&
        createPortal(
          <div
            ref={tip}
            id={tipId}
            role="tooltip"
            className={pos.below ? `${s.tip} ${s.below}` : s.tip}
            style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  )
}
