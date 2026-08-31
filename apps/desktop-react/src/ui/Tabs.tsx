import { useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { resolveIcon, X } from '../components/icons'
import { useRoving } from './a11y/roving'
import s from './Tabs.module.css'

/**
 * 规范画布「Tabs 族」的唯一实现:高 36、tab 左右内边距 10。
 * 活动态只换字色 + 底缘 2px accent 指示条(inset box-shadow,不占布局,
 * 所以切换 tab 一像素都不动);非活动 --text-3,hover --st-hover。
 *
 * 完全受控:它不存 activeId,也不认识 item 里装的是什么内容。
 * onClose 给了才画 ×,× 平时透明、hover 本 tab 时浮出(只动 opacity,位子一直占着)。
 *
 * ── 键盘表(A11y 线 · A2)───────────────────────────────────────────────
 *   ← / →             在 tab 之间移动焦点(循环),整条只占**一个** Tab 位;
 *                     **只移焦点不切页**(APG 的手动激活档)——「移到就切」会让
 *                     键盘用户路过一条 tab 就把它的内容装一遍,这台上每张页都要拉数据
 *   Home / End        到首 / 末
 *   Enter / Space     激活当前 tab
 *   Delete / Backspace 关掉当前 tab(给了 onClose 才有)—— 屏幕上那颗 × 是**鼠标**
 *                     的顺手路,它不进 Tab 序,理由写在下面那颗按钮上
 *   Tab               走出 tab 条(整条只占一个位子)
 * 语义:role=tablist / tab + aria-selected。**没有 aria-controls** —— 内容面板
 * 由宿主画在别处,Tabs 不认识它;指一个自己不知道在不在的 id 比不指更糟。
 * ──────────────────────────────────────────────────────────────────────
 */
export interface TabSpec {
  id: string
  label: string
  /** lucide 图标名,与 items 表同一套字符串 */
  icon?: string
}

interface TabsProps {
  items: TabSpec[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose?: (id: string) => void
  /**
   * 谁摆 Tabs 谁决定「按住一个 tab 意味着什么」。Tabs 自己不认识拖拽 ——
   * 它只把按下这件事连同 id 递出去,拖不拖得动、拖出去变成什么,是宿主的语法。
   * 不接就是不接:没给这个 prop 时 tab 的行为与从前逐字相同(按下 → 松开 → onSelect)。
   */
  onTabPointerDown?: (id: string, e: ReactPointerEvent<HTMLElement>) => void
  label?: string
}

export function Tabs({ items, activeId, onSelect, onClose, onTabPointerDown, label }: TabsProps) {
  const bar = useRef<HTMLDivElement>(null)
  useRoving(bar, { axis: 'horizontal' })
  return (
    <div ref={bar} className={s.bar} role="tablist" aria-label={label}>
      {items.map((tab) => {
        const Icon = tab.icon ? resolveIcon(tab.icon) : null
        const on = tab.id === activeId
        return (
          /*
           * **tab 就是这一层**,不是里面那个按钮(A11y 线 · A2 的一处结构改动)。
           *
           * 理由是 ARIA 的一条硬约束:tablist 的合法子成员**只有** tab。从前的写法是
           * 「壳 div > [tab 按钮, × 按钮]」,那个 × 在无障碍树里是 tablist 的直接
           * 子成员(壳无论有没有 role,都会被穿过),于是 tablist 里坐着一个不是 tab
           * 的东西 —— axe 的 aria-required-children 判 critical,而它判得对:
           * 读屏软件按「第几个 tab」数下去会数错。
           *
           * 所以把 role="tab" 提到壳上,× 变成 tab **内部**的一个按钮。代价是这一层
           * 不再是原生 <button>,Enter / Space 要自己接一下 —— 这是**唯一**自造的
           * 一格键盘行为,写在下面那个 onKeyDown 里,别处一行都没有。
           */
          <div
            key={tab.id}
            className={on ? `${s.tab} ${s.tabOn}` : s.tab}
            role="tab"
            aria-selected={on}
            // roving 入组标记 + 初值。选中的那一条由 useRoving 改回 0 ——
            // 不给初值的话,一条八页的 tab 条要按八下 Tab 才走得出去。
            data-roving-item
            tabIndex={on ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(e) => {
              // 原生按钮白送的那一格,这里补上。
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(tab.id)
                return
              }
              // 关这条 tab 的**键盘路**(APG 可删除 tab 的做法)。× 是鼠标的顺手路,
              // 它不进 Tab 序(理由见下面那颗按钮上的注释),所以键盘要有自己这一下。
              if (onClose && (e.key === 'Delete' || e.key === 'Backspace')) {
                e.preventDefault()
                onClose(tab.id)
              }
            }}
            onPointerDown={onTabPointerDown ? (e) => onTabPointerDown(tab.id, e) : undefined}
          >
            <span className={s.main}>
              {Icon && <Icon className={s.icon} strokeWidth={1.75} aria-hidden="true" />}
              <span className={s.label}>{tab.label}</span>
            </span>
            {onClose && (
              /*
               * × 是**鼠标的顺手路**,不是键盘的路 —— 所以它 `aria-hidden` 且不进
               * Tab 序,键盘那一路是上面 onKeyDown 里的 Delete / Backspace。
               *
               * 这不是省事,是 ARIA 逼出来的唯一出口,两边都撞过墙才落到这里:
               *  · × 摆在 tab **外面**(从前的写法)→ tablist 里坐着一个不是 tab 的
               *    成员,aria-required-children 判 critical;
               *  · × 摆在 tab **里面**且可聚焦 → tab 是「子元素呈现性」的角色,
               *    nested-interactive 判 serious(两条都是真机 axe 实测出来的,
               *    不是纸上推的)。
               * 第三条路才两边都过:× 退成纯装饰,关闭这件事由 tab 自己用一个键表达。
               * 连 `<button>` 都不能留 —— axe 的原话是「元素上加负 tabindex(哪怕再
               * 加 aria-hidden)也挡不住辅助技术聚焦到它」,所以它必须**从一开始就不是
               * 一个控件**:一个 aria-hidden 的 <span>,只接鼠标。
               * 代价记档:读屏软件不再念得到那颗 ×(它本来也只念得出「关闭 files」
               * 这句我们编的话),键盘用户少按一下 Tab、多知道一个 Delete。
               */
              /* 刻意不给 role / tabIndex:一给就又变回「tab 里嵌了个控件」,也就是
               * 上面那两堵墙里的第二堵。键盘那一路在外层 tab 的 onKeyDown 上。
               * (jsx-a11y 的 click-events-have-key-events 不在这里报 —— 它认
               * aria-hidden:一个不在无障碍树里的节点,规则不要求它自带键盘路。) */
              <span
                className={s.close}
                aria-hidden="true"
                // 两处都要拦:click 不拦会顺手把这条 tab 选中(它现在在 tab 里面),
                // pointerdown 不拦会被宿主的拖拽处理器当成「按住这条 tab 要拖」。
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(tab.id)
                }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <X className={s.closeIcon} strokeWidth={2} aria-hidden="true" />
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
