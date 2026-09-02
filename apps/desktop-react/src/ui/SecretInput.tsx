import { useState } from 'react'
import type { ComponentProps } from 'react'
import { Eye, EyeOff } from '../components/icons'
import { IconButton } from './IconButton'
import { Input } from './Input'

/**
 * **密钥输入框**(09-02 批 12 立件)—— `ui/Input` 的密码形 + 一颗切明暗的眼睛钮。
 *
 * ── 为什么立件 ──────────────────────────────────────────────────────────
 * 「基础件先行」那条法:动手写任何交互行为之前先查 `src/ui/`。「一格密码框 +
 * 一颗能把它看一眼的钮」此刻有两个真产地(凭证池的改密钥格与添加格),而它们
 * 要的是**同一件东西**:密钥是粘贴进来的,粘错一位到发请求那一刻才知道,所以
 * 「让我核对一眼」不是装饰,是这一格唯一的纠错手段。两处各写一份的必然结局是
 * 「这一格能看,那一格不能」—— 而没有任何一道门会发现。
 *
 * ── 它为什么走 `Input` 的 `action` 槽而不是 `suffix` ──────────────────────
 * `suffix` 包在 `aria-hidden="true"` 里(它装的是装饰)。**一颗钮不是装饰**:
 * 藏在无障碍树外面的可聚焦元素正是 axe `aria-hidden-focus` 那一条,而且读屏
 * 用户 Tab 到了会听见一个没名字的东西。所以批 12 给 `ui/Input` 补了第三槽
 * `action`(可交互),这件是它今天唯一的消费者。
 *
 * ── 三张状态表(库件规格)──────────────────────────────────────────────
 * ① 生命周期
 *    挂载   `revealed` 恒从 **false** 起 —— 一格密钥框刚长出来时不该是明文的
 *           (它常常长在别人能看见的屏幕上)。这一格是**组件自持**的:它是
 *           「此刻看不看得见」而不是「值是什么」,消费方没有理由要知道。
 *    换宿主 没有第二种落点:它就是一格输入框,尺寸与滚动都归它长在的那一行。
 *    卸载   无订阅、无计时器、无模块级副作用 → **不需要 HMR dispose**。
 *           明暗态随卸载一起消失,这是对的:重新长出来的那一格应当是暗的。
 * ② UI 生命状态
 *    这件不取数,所以没有 loading / error / 超量之分。`empty`(空值)由
 *    `placeholder` 说话,与 `ui/Input` 逐字相同;`invalid` 原样透传给它。
 * ③ UI 交互状态
 *    输入框   rest / hover / focus / disabled 全归 `ui/Input`,这件一个字不改。
 *    眼睛钮   `ui/IconButton size="xs"`,`aria-pressed` 报的是**明暗**
 *             (按下去=看得见)。**禁用跟着输入框一起禁** —— 一格禁掉的密码框
 *             还能被看一眼是说不通的。它自己不进 `type` 之外的任何逻辑。
 */
export interface SecretInputProps
  extends Omit<ComponentProps<typeof Input>, 'type' | 'action' | 'suffix'> {
  /** 眼睛钮此刻(暗态)的名字:按下去会**显示**密钥。 */
  revealLabel: string
  /** 眼睛钮此刻(明态)的名字:按下去会**隐藏**密钥。 */
  hideLabel: string
}

export function SecretInput({ revealLabel, hideLabel, disabled, ...rest }: SecretInputProps) {
  const [revealed, setRevealed] = useState(false)
  return (
    <Input
      {...rest}
      disabled={disabled}
      type={revealed ? 'text' : 'password'}
      action={
        <IconButton
          size="xs"
          icon={revealed ? EyeOff : Eye}
          label={revealed ? hideLabel : revealLabel}
          pressed={revealed}
          disabled={disabled}
          onClick={() => setRevealed((on) => !on)}
        />
      }
    />
  )
}
