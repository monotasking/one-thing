import type { ButtonHTMLAttributes, Ref, ReactNode } from 'react'
import s from './Button.module.css'

/**
 * 规范画布「按钮族」的唯一实现:三个变体 × 两档高度,别的都是这几格的组合。
 * primary = accent 实底(一屏只该有一个);ghost = 描边空底(其余全部);
 * danger = 描边空底 + **危险色只上字**(见下)。
 * sm 28 / md 32、r-1、字重 600、disabled 只降透明度到 0.45 不换色。
 *
 * ── `danger` 档为什么长这样(09-01 批 3.5 补口)──────────────────────────
 * 配方与 `ui/IconButton` 的 `tone='danger'` **同语汇**:危险色只上字,
 * hover 才补一层浅底,**永不实底红**(四轴第一条:状态色只上图标 / 文字)。
 * 几何仍是 ghost 那一份(边框 / 高度 / 内边距逐字相同)—— 危险不改变一颗钮
 * 占多大地方,只改变它说话的颜色。所以 `danger` 不是第二个 primary:
 * 一屏可以有好几颗危险钮,而 primary 只该有一颗。
 * 起因:批 3 把 AskForm 的「拒绝」迁进 `ui/Button` 时,本地那句
 * `:hover { color: var(--danger) }` 因为库件没有这一档而退役(记成缺口 B),
 * 这一档就是那笔账的落点。
 *
 * 三个开关,各只管一件事,不互相耦合:
 * - pill    只换圆角 → r-full(总览的「＋ Project」、Quick Look 的「进入 ↵」)
 * - iconOnly只换成正方 + 去边框去内边距(组头那个 ＋)
 * - size    只换高度
 *
 * 它不认识业务:文案由调用方经 i18n 传进来,图标由调用方当 children 传进来
 * (图标尺寸也归调用方 —— 同一个按钮在不同面上图标可以不一样大)。
 *
 * ── 键盘表(A11y 线 · A2)───────────────────────────────────────────────
 *   Tab               进出(原生 <button>,天生在 Tab 序里)
 *   Enter / Space     触发
 *   焦点环             不在这里画 —— 走 styles/global.css 的全局 :focus-visible
 * 一件都不自造:这一整格全是原生按钮白送的。**iconOnly 的按钮没有文字**,
 * 所以调用方必须给 `aria-label`(它经 ButtonHTMLAttributes 透传);
 * 缺了会被 lint 的 jsx-a11y 与真机门 gate:a11y 的 axe 一起抓。
 * ──────────────────────────────────────────────────────────────────────
 */
/**
 * ── `ref` 单独声明一格(09-02 批 8a 补口,与 `ui/IconButton` 同一笔账)──────
 * React 19 里 `ref` 对函数组件是普通 prop,所以它本来就跟着 `...rest` 摊到
 * 下面那个真 `<button>` 上 —— 运行时的链一直是通的。缺的是**类型**:
 * `ButtonHTMLAttributes` 不含 `ref`(它长在 `ClassAttributes`/`RefAttributes` 上),
 * 于是 `<Button ref={r}>` 过不了 tsc。补这一格,量矩形 / 手动聚焦 / 挂锚点
 * 才不必在外面再包一层贴身 `span`。
 */
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 那颗 `<button>` 本身。 */
  ref?: Ref<HTMLButtonElement>
  variant?: 'primary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  /** 丸形:只影响圆角 */
  pill?: boolean
  /** 只有一个图标的方形按钮 */
  iconOnly?: boolean
  children?: ReactNode
}

export function Button({
  variant = 'ghost',
  size = 'sm',
  pill,
  iconOnly,
  className,
  type,
  children,
  ...rest
}: ButtonProps) {
  const cls = [
    s.btn,
    s[variant],
    size === 'md' ? s.md : '',
    pill ? s.pill : '',
    iconOnly ? s.iconOnly : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button type={type ?? 'button'} className={cls} {...rest}>
      {children}
    </button>
  )
}
