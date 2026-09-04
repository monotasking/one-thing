import { useCallback, useRef, useState } from 'react'
import { X } from '../components/icons'
import { ButtonBase } from './ButtonBase'
import { IconButton } from './IconButton'
import { Menu, MenuItem } from './Menu'
import s from './FilterChip.module.css'

/**
 * **过滤片** —— 一颗扁的、描边的、可按的小药丸,说的是「我此刻按这个条件在筛」。
 *
 * ── 它为什么是一件库件,而不是检索面里的一段手写 ────────────────────────
 * 基础件先行(09-01 立法)。片这件东西有**三类状态要写全**:交互态
 * (rest / hover / focus / active / disabled)、生命态(有没有值、值多长)、
 * 数据态(选项从哪来、超量怎么弯腰)。这三类在检索面、将来的日志面、
 * 会话总览的筛选条里是同一份规格 —— 各写一遍就是「各写各的」的下一个案发现场。
 *
 * ── API 走哪一档:数据表驱动(09-01 库自审立法)────────────────────────────
 * 判据是「项里装什么由谁说了算」。片的选项是**封闭集合、行形态统一**
 * (一行一句话 + 一个勾),消费方决定不了每一项长什么样 —— 所以是 `options` 数组,
 * 不是复合 children。与 Select / Segmented / Tabs 同一档。
 *
 * ── 两种形,一件件 ──────────────────────────────────────────────────────
 *  · **多值片**:给 `options` + `value` + `onSelect` —— 按下去开一张
 *    `role="listbox"` 的菜单(定位与点外关归 `ui/float`,由 `ui/Menu` 消费,
 *    这里一行都不重写)。
 *  · **两态片**:不给 `options`,给 `onToggle` —— 按下去就翻(含归档 / 含推理)。
 *    `aria-pressed` 因此只在这一形上报:多值片没有「按下去了没有」这回事,
 *    它有的是「此刻选的是哪一格」(那由菜单里的 `aria-selected` 说)。
 *
 * `onRemove` 在场时尾巴上多一颗 ×(范围片那一形)。它是**另一颗按钮** ——
 * 嵌套 `<button>` 非法,所以片身与 × 是兄弟,外面那层 `.wrap` 才是视觉上的一颗
 * 药丸(`:has()` 让 hover 落在整颗上,不是只落在片身)。
 */

export interface FilterChipOption {
  value: string
  /** 这一格的成品文案(库件不查字典 —— 字典在消费方那一侧)。 */
  label: string
}

export interface FilterChipProps {
  /** 片名(「空间」「角色」),永不弯腰。 */
  label: string
  /** 挑过了没有:描边加重 + 一层选中膜。**不换底色**。 */
  on?: boolean
  /** 此刻选中的那一格(多值片)。 */
  value?: string
  /** 选项表(多值片)。缺席 = 这是一颗两态片。 */
  options?: readonly FilterChipOption[]
  /** 多值片:选了某一格。 */
  onSelect?: (value: string) => void
  /** 两态片:翻一下。 */
  onToggle?: () => void
  /** 范围片:尾巴上那颗 × 的落点。缺席 = 这颗片去不掉。 */
  onRemove?: () => void
  /** × 那颗钮叫什么(aria-label + Tooltip 共用;`ui/IconButton` 的口径)。 */
  removeLabel?: string
  /**
   * 这一档摆不出它对应的 facet 键。**禁灰而不消失** —— 一张片条的形状不该随
   * 档位变(与 `ui/Menu` 那条 `disabled` 判例同一个理由)。
   */
  disabled?: boolean
  /** `data-filter` 的值:门与用例按它认这一颗是谁(不按文案 —— 文案随语言变)。 */
  name?: string
}

export function FilterChip({
  label,
  on = false,
  value,
  options,
  onSelect,
  onToggle,
  onRemove,
  removeLabel,
  disabled = false,
  name,
}: FilterChipProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  /*
   * 菜单贴着片身的**活矩形**开(rect 档 —— 片条会随面板滚,点锚会与它脱开)。
   * 定位与跟随归 `ui/float`,这里只把锚交出去:那条法说「浮层行为单产地」。
   */
  const anchor = useCallback(() => ref.current?.getBoundingClientRect() ?? null, [])

  const selected = options?.find(option => option.value === value)

  return (
    <span className={on ? `${s.wrap} ${s.on}` : s.wrap} data-filter={name} data-on={on ? 'true' : undefined}>
      {/* 片身是**结构性交互件**(它有自己的形)→ `ui/ButtonBase` 只清 UA。 */}
      <ButtonBase
        ref={ref}
        className={s.chip}
        disabled={disabled}
        // 两态片才有「按下去了没有」;多值片的当前值由菜单里的 aria-selected 说。
        aria-pressed={options === undefined ? on : undefined}
        aria-haspopup={options === undefined ? undefined : 'listbox'}
        aria-expanded={options === undefined ? undefined : open}
        onClick={() => {
          if (options === undefined) onToggle?.()
          else setOpen(value_ => !value_)
        }}
      >
        <span className={s.label}>{label}</span>
        {/* 值是这一片里唯一会长的那一段 —— 挤压纪律:一行一个弯腰件,弯的是它。 */}
        {selected !== undefined && <span className={s.value}>{selected.label}</span>}
      </ButtonBase>
      {onRemove !== undefined && (
        <IconButton
          className={s.remove}
          icon={X}
          size="xs"
          label={removeLabel ?? label}
          onClick={onRemove}
        />
      )}
      {open && options !== undefined && (
        <Menu
          x={0}
          y={0}
          anchor={anchor}
          role="listbox"
          label={label}
          onClose={() => setOpen(false)}
        >
          {options.map(option => (
            <MenuItem
              key={option.value}
              checked={option.value === value}
              onClick={() => {
                setOpen(false)
                onSelect?.(option.value)
              }}
            >
              {option.label}
            </MenuItem>
          ))}
        </Menu>
      )}
    </span>
  )
}
