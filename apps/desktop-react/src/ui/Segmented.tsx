import { useRef } from 'react'
import type { HTMLAttributes } from 'react'
import { useRoving } from './a11y/roving'
import s from './Segmented.module.css'

/**
 * 规范画布「分段器族」的唯一实现:少量互斥选项的就地切换(不是下拉、不是开关)。
 * 槽底 --st-hover,选中段抬起为 --surface-2 + sh-1;非选中 --text-2。
 * 受控且泛型:值是什么由消费方决定,组件只认 value / options / onChange。
 *
 * ── 键盘表(A11y 线 · A2)───────────────────────────────────────────────
 *   ← / →             在段之间移动焦点(循环),整组只占**一个** Tab 位
 *   Home / End        到首段 / 末段
 *   Enter / Space     选中当前段(原生 <button>)
 * 语义:role=radiogroup / radio + aria-checked。
 * **移到不等于选中**:与 Tabs 同一条口径(手动激活)—— 一路方向键走过去
 * 不该沿途把每一档都真的切一遍,那是可见的副作用,不是浏览。
 *
 * ── disabled:整组一起禁,没有「单段禁」(09-02 Dock 放大批立)────────────
 * 这件是**一组互斥选项**,所以可禁的粒度只有一整组:禁掉的是「这个问题现在
 * 轮不到你答」,不是「这几档不能选那几档能选」——后者该表达成选项表本身少几行,
 * 而不是画几个灰段让人猜为什么。起因是 Dock 的「放大幅度」:磁性放大关掉时它
 * 管不着任何东西,**禁掉而不是藏掉** —— 藏掉会让人以为这个选项没了。
 * 配方与 Button / Switch 同一条:`--btn-disabled-o`,外加原生 `disabled`
 * (于是它整组退出 Tab 序、不吃点击、hover 也不亮),组上再挂一句 `aria-disabled`
 * 让读屏软件念得出「这一组现在是关着的」。禁着时不发 `data-roving-item`:
 * roving 只在能拿到焦点的项之间走,给它一串永远 focus 不上的项是在骗它。
 *
 * ── 透传口子:落点自己的身份(09-02 批 8a 补口)──────────────────────────
 * 剩下的 `HTMLAttributes` 原样摊到根 `<div>`,照 `ui/Card` / `ui/GroupHead` 的先例。
 * 起因是一格具体的哑火:**`ui/Field` 里包一件 Segmented 时 `htmlFor` 指了个空**
 * ——`<label for>` 只认可标注元素,而这件的根是 `role="radiogroup"` 的 `<div>`。
 * 修法是 Field 那头多交一格 `aria-labelledby`(它的文件头写着为什么不走
 * 「库件自己去吃 Field 的 context」那条路:那是隐式耦合),这头把口子开出来,
 * 于是消费方一句 `<Segmented {...field} … />` 就关联上了。
 *
 * 撞名的三个键 Omit 掉,各有理由(与 `ui/Card` / `ui/GroupHead` 同一手):
 *  · `onChange` —— `HTMLAttributes` 上那个是 `FormEventHandler`,这件的
 *    `onChange` 收的是**新值**(`(v: T) => void`)。两个词义不可能共存,
 *    留下的是这件的那一个;
 *  · `children` —— 这件的身子由 `options` 表画出来(封闭集合走数据表,
 *    09-01 库自审立法),收了只会被静默丢掉;
 *  · `defaultValue` —— 这件是**受控**的,一个「初值」参数只会让人以为它自持。
 *
 * 属性次序是**算出来的,不是随手排的**:
 *  · `role` 在 rest **之后** —— 它是这件的语义身份,透传盖不掉;
 *  · `className` 解构走并入算好的皮肤 —— 透传不是样式旁路;
 *  · `aria-label` 在 rest **之前** —— 若排在后面,`label` 缺席时会写进一个
 *    `undefined` 把落点自己传的 `aria-label` **静默抹掉**(rest 里没有这个键时
 *    它盖不掉任何东西,所以放前面对 `label` 这条路零影响)。
 * `label` 与落点的 `aria-labelledby` 同时在场时以后者为准 —— 可访问名计算的
 * 既定次序,也正是「Field 里的那一格说了算」。
 * ──────────────────────────────────────────────────────────────────────
 */
export interface SegmentedOption<T extends string> {
  value: T
  label: string
}

export interface SegmentedProps<T extends string>
  extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'children' | 'defaultValue'> {
  options: Array<SegmentedOption<T>>
  value: T
  onChange: (v: T) => void
  /** 整组的可访问名。不给就靠落点的 `aria-labelledby`(Field 那一格)。 */
  label?: string
  /** 整组禁用(见文件头:粒度只有一整组)。 */
  disabled?: boolean
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled,
  className,
  ...rest
}: SegmentedProps<T>) {
  const group = useRef<HTMLDivElement>(null)
  useRoving(group, { axis: 'horizontal' })
  return (
    <div
      ref={group}
      className={[s.group, disabled ? s.disabled : '', className ?? ''].filter(Boolean).join(' ')}
      aria-label={label}
      {...rest}
      role="radiogroup"
      aria-disabled={disabled || undefined}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          disabled={disabled}
          // roving 入组标记 + 初值(选中的那一段才在 Tab 序里)。
          // 禁着时不入组:那几颗按钮 focus 不上,roving 走过去只会走进一堵墙。
          data-roving-item={disabled ? undefined : ''}
          tabIndex={o.value === value ? 0 : -1}
          className={o.value === value ? `${s.seg} ${s.segOn}` : s.seg}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
