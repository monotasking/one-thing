import { createContext, useContext, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { Check } from '../components/icons'
import { useFocusTrap } from './a11y/focus-trap'
import { useRoving } from './a11y/roving'
import { useFloatDismiss, useFloatPosition } from './float'
import type { FloatAnchor } from './float'
import s from './Menu.module.css'

/**
 * 规范画布「菜单族」的唯一实现:浮出面 + 项 + 小节标题 + 分隔线。
 * 面 --surface-2 / r-2、项 r-1 / 高 30 / 字 12.5、投影 sh-2、层级 --z-dropdown。
 *
 * 它只负责「一个菜单该怎么行为」:定位并 clamp 进视口、Esc 关、点外关、
 * 入场只淡入(不位移)。菜单里放什么由消费方决定 —— Menu 不认识任何业务。
 * 前三件的实现与判例都在 `ui/float`(Popover 与它共用同一份)。
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
  /**
   * 给了它就换一档锚:菜单贴着这个**活矩形**的下缘左对齐,并且**跟着它滚**
   * (Select 的面板用的就是这一档 —— 触发器随页面滚,面板不跟就与它脱开了)。
   * 不给就是老行为:光标那个点摆一次,不跟滚。
   * 两档的差别写在 ui/float 的 `FloatAnchor` 上。
   */
  anchor?: () => DOMRect | null
  /**
   * `anchor` 档的对齐边。缺省 `below-start`(贴锚点下缘左对齐,Select 面板那一形)。
   * **锚点自己贴着右边线时给 `below-end`** —— 一行尾巴上的 ⋯ 左对齐开出去,
   * 菜单整个探到那块面外面(判例:密钥池的行菜单,09-02 批 12)。
   * 左对齐还是右对齐是「锚点在这一行的哪一头」的函数,不是口味,所以是一格 prop。
   */
  anchorPlace?: 'below-start' | 'below-end'
}

export function Menu({
  x,
  y,
  onClose,
  children,
  label,
  role = 'menu',
  id,
  minWidth,
  anchor,
  anchorPlace = 'below-start',
}: MenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  // 菜单在场即开启:圈禁 Tab、开时把焦点移进来、关时还给锚点。
  useFocusTrap(ref, true)
  useRoving(ref, { axis: 'vertical' })

  // 定位、Esc 关、点外关全在 ui/float —— 行为与判例都写在那儿,这里不重写一份。
  // x/y 在 anchor 在场时只当首帧兜底:矩形量得到就一次都用不上。
  const floatAnchor: FloatAnchor = anchor
    ? { kind: 'rect', get: anchor, place: anchorPlace }
    : { kind: 'point', x, y }
  const pos = useFloatPosition(ref, floatAnchor, { fallback: { left: x, top: y } })
  useFloatDismiss(ref, onClose)

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
  /**
   * 危险动作(删除一类)。**只换字色,不换底** —— 状态色永远不上底
   * (CLAUDE.md 第 1 轴);一行红字在一列黑字里已经足够扎眼,而红底会让
   * 这一项看起来像「已选中」。
   */
  danger?: boolean
  /**
   * 给了它就是**两段就地确认**:第一下把字换成这句话、**不触发** onClick,
   * 第二下才真做。菜单不关(onClick 才是关它的那一下),所以两段都在原地发生。
   *
   * 为什么不弹 `confirm` 对话框:那会把焦点从菜单上拽走、再拽回来,而这一族
   * 动作(删一行、删一家)的后果是**局部**的 —— 一个模态框对它太重了。
   * 判例:自定义 provider 的删除从前就是这么两段的,只是那时藏在编辑对话框的
   * 页脚里;09-01 把入口挪进右键菜单,这一段行为跟着搬进库件,不在业务面重写。
   *
   * 离开这一项(blur)就撤回第一段 —— 一个「点了一下就走开」的半截确认
   * 不该在那儿等着下一次误触。
   */
  confirmLabel?: ReactNode
  /**
   * **禁灰而不消失**(09-02 批 12 补口)。一张菜单的形状不该随上下文变 ——
   * 「到顶了所以上移这一项没了」会让同一张菜单在第 1 行与第 2 行长得不一样,
   * 于是每次打开都要重新找那一项在第几格。禁灰说的是「这一项此刻做不了」,
   * 那是**同一张表的一个状态**,不是另一张表。
   *
   * 走原生 `disabled` 而不是 `aria-disabled`:`a11y/roving` 的入组判据
   * (`itemsOf`)两者都认得,而原生那一格连点击都一并挡掉 —— `aria-disabled`
   * 还要各消费方自己记得别响应。禁掉的项因此不进方向键的循环,这是对的:
   * 方向键该在**做得动的**项之间走。
   */
  disabled?: boolean
  children: ReactNode
}

export function MenuItem({
  onClick,
  checked,
  danger,
  confirmLabel,
  disabled,
  children,
}: MenuItemProps) {
  const menuRole = useContext(RoleCtx)
  const radio = checked !== undefined
  const listbox = menuRole === 'listbox'
  const [confirming, setConfirming] = useState(false)
  const armed = confirmLabel !== undefined
  return (
    <button
      type="button"
      className={[s.item, checked ? s.itemOn : '', danger ? s.itemDanger : '']
        .filter(Boolean)
        .join(' ')}
      role={listbox ? 'option' : radio ? 'menuitemradio' : 'menuitem'}
      aria-selected={listbox ? Boolean(checked) : undefined}
      aria-checked={!listbox && radio ? checked : undefined}
      // roving tabindex 的入组标记。初值 -1,由 useRoving 每次渲染后重排 ——
      // 不给初值的话,菜单开出来那一瞬间每一项都还在 Tab 序里。
      data-roving-item
      tabIndex={-1}
      disabled={disabled}
      data-confirming={armed && confirming ? 'true' : undefined}
      onClick={() => {
        if (armed && !confirming) {
          setConfirming(true)
          return
        }
        setConfirming(false)
        onClick()
      }}
      onBlur={() => setConfirming(false)}
    >
      {radio && (
        <span className={s.check} aria-hidden="true">
          {checked && <Check className={s.checkIcon} strokeWidth={2} />}
        </span>
      )}
      <span className={s.itemLabel}>{armed && confirming ? confirmLabel : children}</span>
    </button>
  )
}

export function MenuSeparator() {
  return <div className={s.sep} role="separator" />
}
