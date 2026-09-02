import type { ButtonHTMLAttributes, Ref } from 'react'
import { ButtonBase } from './ButtonBase'
import { Tooltip } from './Tooltip'
import type { LucideIcon } from '../components/icons'
import s from './IconButton.module.css'

/**
 * **IconButton —— 组件库第 18 件**(09-01 立件)。
 *
 * ── 它为什么必须是一件库件 ────────────────────────────────────────────────
 * 09-01 报障:「copy 文件路径、编辑,他们的 hover 有遵循规范吗?」——核下来
 * 病根不在某一颗钮,而在**每块面各自画一套图标钮**:有的 hover 只换字色不换底、
 * 有的没有 `:active`(按住与悬停长得一样)、有的把提示写成 native `title=`。
 * 于是 CLAUDE.md 立法「图标按钮必须消费 ui 库件」,这件就是那条法的落点:
 * 配方(rest / hover / active / pressed / disabled / focus)随件走,业务面只声明
 * 「哪个图标、叫什么、按下去干什么」。
 *
 * ── 与 `Button iconOnly` 的分工 ──────────────────────────────────────────
 * `Button` 是**动作钮**:有边框、有 primary/ghost 变体、28/32 两档、进表单与
 * 动作组。`IconButton` 是**檐上那种钮**:无边框、无变体、更小的三档、贴着标题
 * 和状态栏站。两者不是一件东西的两种写法 —— 把 Button 缩到 20px 会让边框、
 * 内边距、字重那一整套配方全部失去意义。
 *
 * ── 三条硬规矩 ──────────────────────────────────────────────────────────
 * ① **`label` 必填**:一颗只有图标的钮必须说得出自己叫什么(它同时是 aria-label
 *    和 Tooltip 的内容)。这不是可选项 —— 无名图标钮在读屏里念作「按钮」。
 * ② **提示走 `ui/Tooltip`,禁 native `title=`**(全仓禁令)。要关掉提示只有一种
 *    正当理由:这颗钮**旁边就写着**同一句话,那时传 `tip={false}`。
 * ③ **焦点环不自绘**:全局 `:focus-visible` 那一圈管所有控件,这里一个字都不写
 *    (禁裸删 outline 是四轴第一条)。
 *
 * ── 透传口子:落点自己的身份,不是样式旁路(09-01 批 3.5)────────────────
 * 剩下的 `ButtonHTMLAttributes` 原样摊到根 `ui/ButtonBase` 上,照
 * `ui/Button` / `ui/Card` / `ui/GroupHead` 的既有先例。它开的是**落点自己的
 * `data-*` / `aria-*` / `form` 那一族** —— 判例就是 composer 那颗发送键:
 * 一颗钮两副面孔,`data-mode={busy ? 'stop' : 'send'}` 是「它此刻是哪副面孔」
 * 的产地,而 `scripts/gate-chat.mjs` 与 `Composer.test.tsx` 都逐字读它;
 * 只收 `testId` 一格自定义属性递不进去,批 3 因此在那一处**当场停**。
 * **样式仍然只走 `className` 皮肤**:透传不是 `style={{…}}` 的口子 ——
 * 配方产地重新被打散成每面一份,正是立这件要治的病。
 *
 * `onClick` 同批从无参回调放宽成收事件(`MouseEventHandler`)——**放宽不是收紧**,
 * 既有调用点一个字不用改。它治的是「钮自己的矩形量不到」:此前 FloatWindow
 * 的钉边钮拿不到 `e.currentTarget`,只好在外面包一格贴身 `span` 去量。
 *
 * 两个键不透传,各有理由:`children`(这件的身子就是那一个图标,收了只会被
 * JSX 里的显式 children 静默盖掉,与 `ui/GroupHead` 同一手)、`title`
 *(原生 `title=` 是浏览器那条小黄条,全仓明令禁止 —— 这件的提示走
 * `ui/Tooltip`,内容就是 `label`;`ui/Card` 已有同样的 Omit 先例)。
 *
 * ── `ref` 是第三条透传,单独声明(09-02 批 8a 补口)──────────────────────
 * React 19 里 `ref` 对函数组件是一个**普通 prop**,所以运行时它本来就跟着
 * `...rest` 摊到 `ui/ButtonBase`(那件是 `forwardRef`,React 会把 props 里的
 * `ref` 摘出来交给它),最后落在那颗 `<button>` 上 —— 链是通的。
 * 缺的只是**类型**:`ButtonHTMLAttributes` 里没有 `ref`(它在 `ClassAttributes`
 * / `RefAttributes` 上),于是 `<IconButton ref={r}>` 过不了 tsc。这里补的就是那一格。
 * 它治的是「钮自己的矩形量不到」的另一半:批 3.5 放宽 `onClick` 收到了
 * `e.currentTarget`(点击那一刻的矩形),而 FloatWindow 的钉边钮要的是
 * **任意时刻**量一次 —— 那只能靠一个 ref。从前的绕法是在外面包一格贴身 `span`。
 * (消费面的收编不在本批:批 8a 只补库件的口。)
 */
export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'title'> {
  /** 那颗 `<button>` 本身。经 `ui/ButtonBase` 的 forwardRef 落到 DOM 节点上。 */
  ref?: Ref<HTMLButtonElement>
  icon: LucideIcon
  /** 这颗钮叫什么。aria-label 与 Tooltip 共用它 —— 说给眼睛和说给读屏的是同一句。 */
  label: string
  /** xs = 行内挂件(树行尾的 ⋯);sm = 檐上;md = 与 Button 同高的场合。 */
  size?: 'xs' | 'sm' | 'md'
  /** 危险动作只换字色不换底(四轴:状态色永不换底)。 */
  tone?: 'danger'
  /** 开着(aria-pressed)。缺席 = 这颗钮没有开关语义,不报 aria-pressed。 */
  pressed?: boolean
  /** 旁边已经写着同一句话时关掉提示 —— 唯一正当的关法。 */
  tip?: boolean
  /** `data-testid` 的短写。落点也可以直接透传 `data-testid=`,两条同一格。 */
  testId?: string
}

export function IconButton({
  icon: Icon,
  label,
  size = 'sm',
  tone,
  pressed,
  disabled,
  tip = true,
  className,
  testId,
  ...rest
}: IconButtonProps) {
  const cls = [s.btn, s[size], pressed && s.on, tone === 'danger' && s.danger, className]
    .filter(Boolean)
    .join(' ')

  /* 底座走 `ui/ButtonBase`(只清 UA):清 UA 这件事全仓一处,这件只画配方。 */
  const button = (
    // 次序照 `ui/GroupHead`:**rest 在前,这件自己的那几格在后**。
    // 皮肤(`cls` 里已经并进了消费方的 `className`)、名字、开关态与禁用
    // 都是这件的声明式产地,透传盖不掉它们;`data-testid` 反过来排在 rest 前面 ——
    // 它只是 `testId` 的短写,落点直接写 `data-testid=` 时以落点为准。
    <ButtonBase
      data-testid={testId}
      {...rest}
      className={cls}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
    >
      <Icon className={s.icon} strokeWidth={1.75} aria-hidden="true" />
    </ButtonBase>
  )

  // 禁用的钮不挂提示:它不响应指针事件,提示永远出不来,挂着只是自欺
  // (「禁用元素本来就不该只靠 tooltip 说话」—— Tooltip 文件头那条)。
  if (!tip || disabled) return button
  return <Tooltip content={label}>{button}</Tooltip>
}
