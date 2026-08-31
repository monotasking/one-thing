import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { Check } from '../components/icons'
import { useFocusTrap } from './a11y/focus-trap'
import { useRoving } from './a11y/roving'
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
 *
 * ── 键盘表(A11y 线 · A2)───────────────────────────────────────────────
 *   ↑ / ↓             在项之间移动(循环),整组只占**一个** Tab 位
 *   Home / End        到首项 / 末项
 *   Enter / Space     触发当前项(原生 <button> 白送,不自造)
 *   Tab / Shift+Tab   圈在菜单内 —— 浮层开着的时候焦点不许溜到它后面那一屏去
 *   Esc               关闭 → 焦点还给开它的那个元素
 * 开启瞬间焦点移进菜单容器(tabIndex=-1):不移进来,上面这几行就都够不着。
 * ──────────────────────────────────────────────────────────────────────
 *
 * ── 两种角色,同一件浮层 ────────────────────────────────────────────────
 * `role="menu"`(默认)= 一组动作;`role="listbox"` = 一组**值**里选一个
 * (Select 用的就是这一档,见 ui/Select.tsx)。两者的键盘行为逐字相同,
 * 差的只是读屏软件念什么 —— 所以是一个 prop,不是第二个组件。
 * 项的角色由容器决定、经 context 下发:**没有哪个消费方该自己去写 role**。
 * ──────────────────────────────────────────────────────────────────────
 */
export type MenuRole = 'menu' | 'listbox'

const RoleCtx = createContext<MenuRole>('menu')

interface MenuProps {
  /** 光标位置(视口坐标) */
  x: number
  y: number
  onClose: () => void
  children: ReactNode
  label?: string
  /** 默认 'menu'。选值用 'listbox'(项自动变成 option)。 */
  role?: MenuRole
  /** 给 aria-controls 指过来用(Select 的触发器要指着它)。 */
  id?: string
  /**
   * 缺省宽度是菜单族的 `--menu-w`(176)。个别菜单装的东西天然更宽 —— 文件面
   * 那张要放得下「打开方式」七行 + 一句折行的注脚 —— 由消费方**递一格 token**
   * (不是一个字面 px)把下界抬上去。它只改 min-width:内容更宽时照样撑开。
   */
  minWidth?: string
}

export function Menu({ x, y, onClose, children, label, role = 'menu', id, minWidth }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  // 菜单在场即开启:圈禁 Tab、开时把焦点移进来、关时还给锚点。
  useFocusTrap(ref, true)
  useRoving(ref, { axis: 'vertical' })

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
    <RoleCtx.Provider value={role}>
      <div
        ref={ref}
        id={id}
        className={s.menu}
        style={{ left: `${pos.left}px`, top: `${pos.top}px`, ...(minWidth ? { minWidth } : {}) }}
        role={role}
        /* ARIA 菜单模式:容器**可编程聚焦**(-1),项走 roving tabindex。
         * 不给 -1 的话容器根本拿不到焦点,读屏软件进不去这棵菜单树。 */
        tabIndex={-1}
        aria-label={label}
        onContextMenu={(e) => e.preventDefault()}
      >
        {children}
      </div>
    </RoleCtx.Provider>,
    document.body,
  )
}

/**
 * 小节标题:10px 宽字距的弱色分组名,自身不可交互。
 * `role="presentation"`:它在 menu / listbox 里是**布局**,不是一项 ——
 * 不摘掉隐式角色,读屏软件会把它当成菜单树里的一个不明成员念出来。
 */
export function MenuSection({ children }: { children: ReactNode }) {
  return (
    <div className={s.section} role="presentation">
      {children}
    </div>
  )
}

/**
 * 菜单项。checked 有值时该项是单选项 —— 勾位永远占着,
 * 所以选中态切换只换字色和那个勾,不引起一像素的重排。
 *
 * 角色三态,全由容器的 role 与 checked 推出来,消费方一个字都不用写:
 *   listbox → option(aria-selected)
 *   menu + checked 有值 → menuitemradio(aria-checked)
 *   menu + 没有 checked → menuitem
 */
interface MenuItemProps {
  onClick: () => void
  checked?: boolean
  children: ReactNode
}

export function MenuItem({ onClick, checked, children }: MenuItemProps) {
  const menuRole = useContext(RoleCtx)
  const radio = checked !== undefined
  const listbox = menuRole === 'listbox'
  return (
    <button
      type="button"
      className={checked ? `${s.item} ${s.itemOn}` : s.item}
      role={listbox ? 'option' : radio ? 'menuitemradio' : 'menuitem'}
      aria-selected={listbox ? Boolean(checked) : undefined}
      aria-checked={!listbox && radio ? checked : undefined}
      // roving tabindex 的入组标记。初值 -1,由 useRoving 每次渲染后重排 ——
      // 不给初值的话,菜单开出来那一瞬间每一项都还在 Tab 序里。
      data-roving-item
      tabIndex={-1}
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
