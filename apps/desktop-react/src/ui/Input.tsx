import type { InputHTMLAttributes, ReactNode } from 'react'
import s from './Input.module.css'

/**
 * 规范画布「控件 · 输入」板的唯一实现。
 *
 * 板上写的是**一档高 34**、r-2、底 = 抬升面(比区域面高一层)、内边距 12、字 13;
 * hover 只把边线升一档(line-1 → line-2)不涂底;聚焦 = accent 边 + 同一枚焦点柔环;
 * 错误只换边色;disabled 整体降 0.45。这些逐条照抄。
 *
 * 唯一按拍板偏离板的地方是**高度改三档**:sm 28 / md 32 / lg 38。
 * 前两档直接复用按钮族的 --btn-sm / --btn-md —— 所以输入框和按钮并排时基线一致;
 * lg 是新补的 --input-lg。板上那个 34 在三档表里没有位置,不再单列。
 *
 * 焦点环的例外:全局规矩是「焦点环只在 :focus-visible」,文本输入类是那条规矩的
 * 例外 —— 鼠标点进输入框也要亮环,因为「光标现在在这里」本来就该被看见。
 *
 * 它不认识业务:没有 label、没有错误文案、没有 aria-label 默认值,
 * 全部由调用方传进来(文案归 i18n,组件里不落字面)。
 *
 * ── 键盘表(A11y 线 · A2)───────────────────────────────────────────────
 *   Tab               进出(原生 <input>)
 *   其余              全归原生:选词、行内移动、撤销 —— 一个都不许自造
 *   焦点环             **这件自己画**(见上面那段「例外」):环画在外壳 `.field` 上,
 *                     所以里面那个 `<input>` 的 `outline: none` 不是裸删,
 *                     它的替代品就在同一个文件、同一个焦点态里(:focus-within)
 * 无障碍名:`aria-label` / `aria-labelledby` 经 InputHTMLAttributes 透传,
 * 由调用方给;`invalid` 会落成 `aria-invalid`,读屏软件据此说「这里填错了」。
 * ──────────────────────────────────────────────────────────────────────
 */
interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  value: string
  onValueChange: (v: string) => void
  size?: 'sm' | 'md' | 'lg'
  /** 边色转 danger。说明文字由调用方画在下面 —— 输入框只表达「这里错了」。 */
  invalid?: boolean
  /** 左槽:图标。给了就占位,不给一个像素都不占。 */
  prefix?: ReactNode
  /** 右槽:图标或单位。 */
  suffix?: ReactNode
  /**
   * 右槽的**可交互**那一档(09-02 批 12 补口)。
   *
   * `prefix` / `suffix` 两槽都包在 `aria-hidden="true"` 的壳里 —— 它们装的是
   * 装饰(一枚图标、一个单位),报出来只会是没名字的噪音节点。但**一颗钮不是
   * 装饰**:把它塞进 `suffix`,axe 的 `aria-hidden-focus` 当场判红(一个能拿到
   * 焦点的东西藏在无障碍树外面,读屏用户 Tab 到了却听不见它是什么)。
   *
   * 所以开的是**第三槽**而不是「把 suffix 的 aria-hidden 摘掉」:两者要回答的
   * 是同一个问题的两个答案,合成一格就等于让每个消费方自己去猜这一次该报不该报。
   * 判据一句:**这一格能不能被点 / 被聚焦**?能就走 `action`。
   * 今天唯一的消费者是 `ui/SecretInput` 的那颗眼睛钮。
   */
  action?: ReactNode
}

export function Input({
  value,
  onValueChange,
  size = 'md',
  invalid,
  prefix,
  suffix,
  action,
  className,
  disabled,
  ...rest
}: InputProps) {
  const cls = [
    s.field,
    s[size],
    invalid ? s.invalid : '',
    disabled ? s.disabled : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={cls}>
      {prefix && (
        <span className={s.slot} aria-hidden="true">
          {prefix}
        </span>
      )}
      <input
        className={s.input}
        value={value}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onChange={(e) => onValueChange(e.target.value)}
        {...rest}
      />
      {suffix && (
        <span className={s.slot} aria-hidden="true">
          {suffix}
        </span>
      )}
      {/* 可交互那一槽:**不包 aria-hidden**(见 props 上那段判据)。 */}
      {action && <span className={s.action}>{action}</span>}
    </div>
  )
}
