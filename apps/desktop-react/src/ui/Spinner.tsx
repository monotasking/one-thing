import s from './Spinner.module.css'

/**
 * 规范画布「反馈态 · loading」板的**控件级** loading:700ms linear 的小圆环。
 * 板上把 loading 分成两层,并且明说「没有第三种」:区域级 = 骨架(模仿真实布局的
 * 呼吸色块),控件级 = 这个 spinner。**它只许出现在按钮的 loading 位与面板状态条** ——
 * 整屏转圈不在系统里,页面级等待请用骨架。
 *
 * 尺寸:sm 13(板上给的就是按钮里那颗 13),md 16(板上未定,取与徽 / 勾选族同档的 16,
 * 让它和同一行里的其他小件对齐)。
 *
 * prefers-reduced-motion 下不转:降为一枚半透明整环 —— 还是「在忙」的信号,
 * 只是不再动。不换成三个点是因为那会是第二种形状,系统里不该有两个 spinner。
 *
 * ── 无障碍(A11y 线 · A2)───────────────────────────────────────────────
 * 不进 Tab 序 —— 它不是控件,没有键盘表。两种用法各有各的报法:
 *   给了 label  → role="status" + aria-label:它是一块 live region,
 *                 出现时读屏软件念一句「正在载入…」(文案走 i18n,组件不落字面)
 *   没给 label  → aria-hidden:纯装饰(按钮里那颗,按钮自己已经说了话),
 *                 报出来只会变成一个没名字的噪音节点
 * 判据一句:**这枚圈是不是屏幕上唯一在说「在忙」的东西**?是就给 label。
 * ──────────────────────────────────────────────────────────────────────
 */
interface SpinnerProps {
  size?: 'sm' | 'md'
  /** 无障碍名(走 i18n)。装饰性使用可以不给,那时它对读屏是隐形的。 */
  label?: string
  className?: string
}

export function Spinner({ size = 'sm', label, className }: SpinnerProps) {
  const cls = [s.ring, s[size], className ?? ''].filter(Boolean).join(' ')
  return (
    <span
      className={cls}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  )
}
