import { Seam, SeamLine } from './Seam'
import s from './WaitingSeam.module.css'

/**
 * **等待折痕** —— 一道**没有标签**的、在扫的折痕。
 *
 * 「这一轮在跑,而屏幕上还没有东西可看」这件事此刻唯一的图形载体。
 *
 * ── 它住在哪儿(2026-09-20 G 线 P1 搬过家)──────────────────────────────
 * 09-15 立它的时候它有**两个**住处:活消息那一行的正文位置上(`MessageRow` 的
 * 头部),以及重试那一路自己那一行(`retrySeamRow`)。两处都随 G 线 P1 退役 ——
 * 病根写在正本 `docs/stream-geometry-2026-09.md` §0 的 ④ 与 §1 的 G4:
 * **只在流式期存在的东西不许住在流里**,它一卸载就带走一个行盒,下面的东西跟着动。
 * 今天它只有一个住处:**整列末尾那一格尾槽**(`content/message/TailSlot.tsx`),
 * 与那枚呼吸光标同格同高、只换 `opacity`。
 *
 * 「一轮只扫一道」那条规矩因此也换了形:从前是「有上下文更新行时由它扫、没有才画
 * 这一道」(`ContextDeltaSeam` 的 `sweeping` 那格 prop),今天上下文更新行**不再扫**
 * (正本 §2 拍点 2:「等待指示只留一处:尾部」),那格 prop 已经删掉。
 *
 * ── 为什么是基座的实例而不是一件新东西 ──────────────────────────────────
 * 折痕基座(`content/seam/Seam.tsx`)的自述是「系统在两回合之间做的一件事」,
 * `data-state="running"` 的意思正是「正在发生」—— 光扫与那条线本来就在那儿。
 * 这一件的全部内容是:**没有标签**。所以它不带 `SeamLabel`,并且把基座那三列
 * 坍成两列(判词在 `WaitingSeam.module.css`)。
 *
 * ── 三张状态表 ────────────────────────────────────────────────────────────
 * ① 生命周期:纯展示件,零 state / 零订阅 / 零计时器 / 零模块级副作用
 *    → **不需要 HMR dispose**。它只有一种宿主:尾槽那一格的「等待」脸。
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
