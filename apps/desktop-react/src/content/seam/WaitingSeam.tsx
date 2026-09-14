import { Seam, SeamLine } from './Seam'
import s from './WaitingSeam.module.css'

/**
 * **等待折痕**(正本 `docs/send-flow-2026-09.md` §2 规矩 ③)。
 *
 * 回复的槽位已经开出来(`run/start` 到了、活消息立着),但此刻一个字都画不出来:
 * 模型在思考、请求还在路上。这一段从前是三颗点(`ui/Dots` + `.firstToken`),
 * 09-15 起换成一道**在扫的折痕** —— 理由是它与上下文更新那一行说的是同一件事:
 * 「系统在这一回合开张时正在做的事」。两者因此合成一行:这一轮有上下文更新时
 * 由 `ContextDeltaSeam` 自己扫(`sweeping`),没有时才画这一道空的。
 * 不插第二行 —— 插了就是同一句话说两遍,而且首字到达时要收两处。
 *
 * ── 为什么是基座的实例而不是一件新东西 ──────────────────────────────────
 * 折痕基座(`content/seam/Seam.tsx`)的自述是「系统在两回合之间做的一件事」,
 * `data-state="running"` 的意思正是「正在发生」—— 光扫与那条线本来就在那儿。
 * 这一件的全部内容是:**没有标签**。所以它不带 `SeamLabel`,并且把基座那三列
 * 坍成两列(判词在 `WaitingSeam.module.css`)。
 *
 * ── 首字到达那一下是**同一次提交**里的换手 ──────────────────────────────
 * 摆它的判据是 `segments.length === 0`(`ChatStream` 里那句既有的话),
 * 第一块内容的判据是同一份 `segments` —— 于是卸载这一道与挂上第一块由**同一次**
 * React 提交推出来,中间没有一帧「两样都不在」。净变化 = 第一块的高 − 一行
 * (所以这一件按一行正文的高占位,见样式),只长不缩。
 *
 * ── 三张状态表 ────────────────────────────────────────────────────────────
 * ① 生命周期:纯展示件,零 state / 零订阅 / 零计时器 / 零模块级副作用
 *    → **不需要 HMR dispose**。它只有一种宿主:活消息那一行里,正文该出现的位置上。
 * ② UI 生命状态:只有一种 —— 「在等」。没有 empty / loading / error:
 *    它自己就是 loading 那一档的形。**超量**不成立(它不吃数据)。
 * ③ UI 交互状态:只有 rest —— 它不是钮,点它什么都不发生。
 *    动效档「无」与系统 `prefers-reduced-motion` 下光束摊平成一条均匀的淡光
 *    (降级归基座的样式表,这里一个字都不必写)。
 */
export function WaitingSeam({ label }: {
  /**
   * 无障碍名。这道折痕是「还在跑」这件事此刻唯一的图形载体,所以给名
   * (与退役的 `Dots label` 逐字同源:文案归调用方,组件里不落字面)。
   * `role="img"` 也照抄那一件 —— 一块没有文字的图形要先有角色才配得上名字。
   */
  label: string
}) {
  return (
    <Seam
      className={s.wait}
      data-state="running"
      data-testid="waiting-seam"
      role="img"
      aria-label={label}
    >
      <SeamLine />
      <SeamLine />
    </Seam>
  )
}
