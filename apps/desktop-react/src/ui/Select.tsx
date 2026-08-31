import { useId, useRef, useState } from 'react'
import { ChevronDown } from '../components/icons'
import { Menu, MenuItem } from './Menu'
import s from './Select.module.css'

/**
 * 规范画布「控件 · 选择」板:板上第一句就是「触发器同输入框」,所以这里的
 * 触发器不是新配方,是用 CSS Modules 的 composes **直接复用 Input 的那一条** ——
 * 高度、圆角、底、hover 升边线、聚焦柔环全部同源,改 Input 就一起改。
 * 右侧一个 14 的 chevron,板上画的就是它。
 *
 * 浮出面同理:板上「面板 = 浮层面 + sh-2 · 选项单选打勾」和菜单族是同一件东西,
 * 所以直接组装在既有的 ui/Menu 上,不复制一份浮层。菜单族的项高 30 / 面 r-2 与板上
 * 选择族那栏写的 32 / r-3 有一格出入 —— 取既有组件那份,一个浮层只该有一套几何。
 * 板上单独规定的只有一条在这里落地:面板超过 --select-menu-max-h 就滚自己。
 *
 * 定位、Esc 关、点外关、clamp 进视口全在 Menu 里,这里一行都不重写。
 * 不做搜索、不做多选 —— 那是另一件组件,不是这件的开关。
 *
 * ── 键盘表(A11y 线 · A2)───────────────────────────────────────────────
 *   触发器上 Enter / Space / ↓   展开(↓ 是 APG combobox 模式那一下)
 *   面板里 ↑ / ↓                在选项间移动(循环),整组一个 Tab 位
 *   面板里 Home / End           到首项 / 末项
 *   面板里 Enter / Space        选中并收起 → 焦点还给触发器
 *   Esc                        收起 → 焦点还给触发器
 * 语义按 APG 的 listbox 模式:触发器 role=combobox + aria-expanded +
 * aria-controls,面板 role=listbox,项 role=option + aria-selected。
 * 面板本体复用 ui/Menu 的 'listbox' 档 —— 一个浮层只该有一套行为。
 * ──────────────────────────────────────────────────────────────────────
 */
export interface SelectOption {
  value: string
  label: string
}

interface SelectProps {
  options: SelectOption[]
  value: string
  onChange: (v: string) => void
  size?: 'sm' | 'md' | 'lg'
  disabled?: boolean
  /** 无障碍名。组件里不落字面文案,由调用方经 i18n 传。 */
  label?: string
  className?: string
}

export function Select({
  options,
  value,
  onChange,
  size = 'md',
  disabled,
  label,
  className,
}: SelectProps) {
  const ref = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)

  const current = options.find((o) => o.value === value)
  const cls = [s.trigger, s[size], disabled ? s.disabled : '', className ?? '']
    .filter(Boolean)
    .join(' ')

  const open = () => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    // 贴着触发器下缘展开;越界由 Menu 自己 clamp,这里不重复判一次视口。
    setAnchor({ x: r.left, y: r.bottom })
  }

  const toggle = () => {
    if (anchor) {
      setAnchor(null)
      return
    }
    open()
  }

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={cls}
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={anchor !== null}
        aria-controls={anchor ? listId : undefined}
        aria-label={label}
        // Menu 的「点外关」听的是 window 上的 pointerdown。触发器就在菜单外面,
        // 不拦住这一下,再点一次触发器会先关再开,看起来就是「点了没反应」。
        onPointerDown={(e) => e.stopPropagation()}
        onClick={toggle}
        // APG combobox:↓ 展开。Enter / Space 走原生 click,不用在这里再写一遍。
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !anchor) {
            e.preventDefault()
            open()
          }
        }}
      >
        <span className={s.value}>{current?.label}</span>
        <ChevronDown className={s.chevron} strokeWidth={1.75} aria-hidden="true" />
      </button>

      {anchor && (
        <Menu
          x={anchor.x}
          y={anchor.y}
          onClose={() => setAnchor(null)}
          label={label}
          role="listbox"
          id={listId}
        >
          {/* 这一层只是「超高就自己滚」的容器,不是 listbox 的一个成员 ——
              不摘掉隐式角色,读屏软件会把它当成一个不明的子项念出来。 */}
          <div className={s.list} role="presentation">
            {options.map((o) => (
              <MenuItem
                key={o.value}
                checked={o.value === value}
                onClick={() => {
                  onChange(o.value)
                  setAnchor(null)
                }}
              >
                {o.label}
              </MenuItem>
            ))}
          </div>
        </Menu>
      )}
    </>
  )
}
