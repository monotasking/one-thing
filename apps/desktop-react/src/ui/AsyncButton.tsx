import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Button } from './Button'
import { useAsyncPending } from '../data/kernel/react'
import { useDelayedFlag } from '../components/useDelayedFlag'
import { SKELETON_DELAY_MS } from '../components/motion'
import type { AsyncSource } from '../data/kernel/async-source'

/**
 * 第 17 件基础件:**会自己说「在办了」的按钮**。
 *
 * 交互稳定律③(§8)原话:「异步动作必有进行中反馈,而且长在发起它的那个控件上。」
 * 这件组件把那条律从「每个作者记得写」变成「默认就有」—— 它吃一个 `AsyncSource`
 * (query 或 mutation,见 `data/kernel/async-source.ts`),忙态是**读来的**,
 * 不是调用方自己 `useState` 记的一份。
 *
 * ── 三态怎么走(状态清单)──────────────────────────────────────────────
 *   idle     children、可点、`aria-busy` 缺席
 *   pending  disabled + `aria-busy="true"` **立刻**;文案换成 `pendingLabel`
 *            **等 150ms 才换**
 *   settled  回 idle。完成的信号不在这颗钮上 —— 在它作用的那块内容上
 *            (新数据落位 / 时刻更新),钮不该抢这一份反馈
 *
 * ── 为什么 disabled 立刻、换字要等 ────────────────────────────────────────
 * 08-31 真机报障的「Refresh 闪」是 E 型:缓存命中极快,图标换成转圈再换回来,
 * 眼睛只看见闪了一下,一个字都没读到。**比 150ms 更快回来的请求根本不该
 * 报告自己在忙**(与骨架的 `SKELETON_DELAY_MS` 同一条规范、同一个常量)。
 * 但 `disabled` 不能等:它挡的是连点,而连点就发生在头 150ms 里。
 * 两者分开正是因为它们防的是两件事 —— 一个防误读,一个防误点。
 *
 * 宽度会随文案变。这是**有意**的取舍:与复制反馈(钮上的字换成「已复制」)
 * 同一拍板 —— 反馈要人读得懂,而读得懂就意味着字数不一样。给它锁一个 min-width
 * 等于让两种语言里必有一种排不下。
 *
 * ── 键盘与无障碍 ────────────────────────────────────────────────────────
 * 一切来自 `ui/Button`(原生 `<button>`);这里只多一个 `aria-busy` ——
 * 它是读屏软件唯一能听见「这颗钮正在办事」的那一格。
 */
interface AsyncButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** 这颗钮发起的那件异步事。query 或 mutation 都行。 */
  action: AsyncSource | undefined
  /**
   * 只问这一格忙不忙。mutation 打在具体某一行上时给它(律③:一次勾选不该把
   * 整表禁掉);query 本来就一格一发,给不给都一样。
   */
  pendingKey?: string
  /** 忙起来之后钮上说的那句话。**必给**,而且必须经 i18n —— 组件里不落字面文案。 */
  pendingLabel: ReactNode
  variant?: 'primary' | 'ghost'
  size?: 'sm' | 'md'
  pill?: boolean
  children: ReactNode
}

export function AsyncButton({
  action,
  pendingKey,
  pendingLabel,
  disabled,
  children,
  ...rest
}: AsyncButtonProps) {
  const pending = useAsyncPending(action, pendingKey)
  // 只有「换字」走防闪闸;disabled / aria-busy 立刻生效,理由见文件头。
  const announce = useDelayedFlag(pending, SKELETON_DELAY_MS)

  return (
    <Button {...rest} disabled={disabled || pending} aria-busy={pending || undefined}>
      {announce ? pendingLabel : children}
    </Button>
  )
}
