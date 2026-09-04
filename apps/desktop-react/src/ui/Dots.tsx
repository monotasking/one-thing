import type { HTMLAttributes } from 'react'
import s from './Dots.module.css'

/**
 * **三个点**(C1 §5.3,视觉词汇立件)。
 *
 * 它说的是一句很窄的话:**这件事正在进行,只是此刻还没有东西可看**。
 * 与它最容易混的两件各有各的地盘,判据写死在这里:
 *
 *   `ui/Spinner`   —— 「我在等一次往返」。它有边界(请求回来就没了),而且按
 *                     既有禁令只许出现在按钮内或状态栏里;
 *   `ui/StatusDot` —— 「现在是什么状态」。一颗静止的点,状态色只上它;
 *   `ui/Dots`      —— 「**在流了,只是第一个字还没到**」。它没有进度、不带颜色
 *                     语义(走 `currentColor`,跟着落点的字色),只有节奏。
 *
 * 两个消费点,一句话就说得完 —— 跟随丸的「生成中」那张脸(`content/FollowPill`)
 * 与助手回复槽位开出来到第一个 delta 之间那段空档(`content/ChatStream`)。
 * 两处画的是同一件事,所以它们不许各画一份(那正是立件要治的病)。
 *
 * ── 只有一档尺寸 ────────────────────────────────────────────────────────
 * 与 `ui/StatusDot` 的两档不同,这件**故意只有一档**:两个消费点对这枚点的读法
 * 完全相同(都是「一行字那么高的地方,有三颗点在走」),没有第二种读法要表达。
 * 档位的意义在于穷举 —— 穷举出来只有一格,就不该先造一个 `size` 出来占位。
 * 需要更大 / 更小的那一天,加的是第二个**档**(和它的理由),不是一个自由量。
 *
 * ── 无障碍:它默认是装饰 ────────────────────────────────────────────────
 * 判据与 `ui/StatusDot` 同一条,只是缺省档相反 —— 这件几乎总有一个**容器**在
 * 说话(丸自己带 `aria-label`;消息体那处由外面那格说「正在生成」),再念一遍
 * 就是噪音。所以缺省 `aria-hidden`;真要它当唯一的信息载体时给 `label`,
 * 它变成 `role="img"` + 名字。
 * **不加 `aria-live`**:这三颗点每秒起伏一次,挂上 live 区等于让读屏软件
 * 每秒念一句(§5.3 的原话:「丸上不加 aria-live,流式每帧一句会念疯」)。
 *
 * ── 三类状态(库件规格)────────────────────────────────────────────────
 *   生命状态:无。零订阅、零计时器、零可变状态 —— 动画整条跑在 CSS 里
 *             (JS 侧一个定时器都没有),所以也不需要 HMR dispose。
 *             挂载即在走,卸载即无;它没有 empty / loading / error 三态,
 *             因为**它本身就是别人的 loading 态**。
 *   交互状态:无。它不是控件:不进 Tab 序,没有 hover / active / disabled。
 *             落在按钮里时那几态归按钮画(`ui/Button` 的配方),不归它。
 *   数据状态:无。它不吃数据 —— 三颗点是**常数**,不随任何进度变多变少
 *             (那是进度条的活)。**超量**这一格因此不成立。
 *   动效档:  `none` 与系统 `prefers-reduced-motion` 下 = 三颗静止的点
 *             (§5.3 字面)。降级不是「不画」——「在进行」这件事仍然要说得出来。
 * ──────────────────────────────────────────────────────────────────────
 */
export interface DotsProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, 'children' | 'role' | 'aria-label'> {
  /**
   * 无障碍名。**只在这三颗点是唯一信息载体时给** —— 外面那格已经在说同一句话
   * 时给它就是念两遍(判据见文件头)。文案归调用方,组件里不落字面。
   */
  label?: string
  className?: string
}

export function Dots({ label, className, ...rest }: DotsProps) {
  const cls = [s.dots, className ?? ''].filter(Boolean).join(' ')
  /*
   * 三颗点是**三个真元素**而不是一段 `…` 文本:文本的三个句点跟着字体走
   * (不同字重 / 不同语言下宽窄不一),而且没法各自错峰。错峰用 `nth-child`
   * 在 CSS 里排,所以这里连 index 都不必传。
   * 属性次序与 `ui/StatusDot` 同一条:`className` 已解构走(透传盖不掉皮肤),
   * 语义身份排在 rest 之后。
   */
  const body = (
    <>
      <span className={s.dot} />
      <span className={s.dot} />
      <span className={s.dot} />
    </>
  )
  if (label === undefined) {
    return (
      <span className={cls} {...rest} aria-hidden="true">
        {body}
      </span>
    )
  }
  return (
    <span className={cls} {...rest} role="img" aria-label={label}>
      {body}
    </span>
  )
}
