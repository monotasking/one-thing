import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { Check } from '../components/icons'
import s from './Menu.module.css'

/**
 * 规范画布「菜单族」的唯一实现:浮出面 + 项 + 小节标题 + 分隔线。
 * 面 --surface-2 / r-2、项 r-1 / 高 30 / 字 12.5、投影 sh-2、层级 --z-dropdown。
 *
 * 它只负责「一个菜单该怎么行为」:光标处定位并 clamp 进视口、Esc 关、点外关、
 * 入场只淡入(不位移)。菜单里放什么由消费方决定 —— Menu 不认识任何业务。
 *
 * 用 portal 挂到 body 不是洁癖:Dock 条上有 backdrop-filter,而 backdrop-filter
 * 会给 position:fixed 的后代造一个包含块,菜单留在 Dock 里会以 Dock 为原点定位。
 */
interface MenuProps {
  /** 光标位置(视口坐标) */
  x: number
  y: number
  onClose: () => void
  children: ReactNode
  label?: string
}

export function Menu({ x, y, onClose, children, label }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  // 先按光标画一帧,量到真实尺寸后在同一帧内 clamp 回视口内 —— 用户看不到中间态。
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setPos({
      left: Math.max(0, Math.min(x, window.innerWidth - el.offsetWidth)),
      top: Math.max(0, Math.min(y, window.innerHeight - el.offsetHeight)),
    })
  }, [x, y])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      className={s.menu}
      style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
      role="menu"
      /* ARIA 菜单模式:容器**可编程聚焦**(-1),项自己进 tab 序(MenuItem 是真 <button>)。
       * 不给 -1 的话容器根本拿不到焦点,读屏软件进不去这棵菜单树。 */
      tabIndex={-1}
      aria-label={label}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  )
}

/** 小节标题:10px 宽字距的弱色分组名,自身不可交互。 */
export function MenuSection({ children }: { children: ReactNode }) {
  return <div className={s.section}>{children}</div>
}

/**
 * 菜单项。checked 有值时该项是单选项 —— 勾位永远占着,
 * 所以选中态切换只换字色和那个勾,不引起一像素的重排。
 */
interface MenuItemProps {
  onClick: () => void
  checked?: boolean
  children: ReactNode
}

export function MenuItem({ onClick, checked, children }: MenuItemProps) {
  const radio = checked !== undefined
  return (
    <button
      type="button"
      className={checked ? `${s.item} ${s.itemOn}` : s.item}
      role={radio ? 'menuitemradio' : 'menuitem'}
      aria-checked={radio ? checked : undefined}
      onClick={onClick}
    >
      {radio && (
        <span className={s.check} aria-hidden="true">
          {checked && <Check className={s.checkIcon} strokeWidth={2} />}
        </span>
      )}
      <span className={s.itemLabel}>{children}</span>
    </button>
  )
}

export function MenuSeparator() {
  return <div className={s.sep} role="separator" />
}
