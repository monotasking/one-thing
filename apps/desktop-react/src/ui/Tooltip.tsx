import { cloneElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  })

  return (
    <>
      {child}
      {pos &&
        createPortal(
          <div
            ref={tip}
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
