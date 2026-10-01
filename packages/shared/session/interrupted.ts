/**
 * 崩溃收口的**单一口径**(R-a,2026-08-20 用户裁定,§13.6)。
 *
 * 进程非正常退出时,同一次工具调用会被**两个人**分别收尾:
 *
 *  - **账本侧** `prepare`(`app/session/prepare.ts`):给没有结局的 `tool/call`
 *    合成一条 `tool/result`,给没有 `run/end` 的 run 合成一条 `interrupted`;
 *  - **消息侧** `sanitizeSessionOnStartup`(`computeSessionRepairOnLoad`,
 *    `policy:'startup'`):把还挂在 running / executing 上的 step 与 toolCall 判死。
 *
 * 这两个人从前说的**不是同一句话**(A10 / F12-W-C):账本侧写
 * `cancelled` + 一句"会话结束前工具没回来",消息侧写 `failed` +
 * `Interrupted: app was closed` 并把标题改写成 `Interrupted: X`。于是投影与消息
 * 在四格上打架,而两份账都自称修好了。
 *
 * **用户裁定:以 prepare 为准。** 理由是它是唯一能被**重放**的那一份 ——
 * 消息侧那次改写(尤其是标题重写)在事件账本里没有任何来源,投影永远重建不出来。
 * 所以:
 *
 * | 格 | 收口后的口径 |
 * |---|---|
 * | `step.status` / `toolCall.status` | `'cancelled'` |
 * | `step.error` / `toolCall.error` | `CORE_INTERRUPTED_TOOL_ERROR` |
 * | `step.title` | **不动**(占位标题 `调用工具: X` 原样留着) |
 * | 等审批时被打断 | `CORE_INTERRUPTED_PERMISSION_ERROR`(它比"工具没回来"多说了一件事) |
 *
 * 三个常量住在这里,**三个消费者共用**:prepare 的合成、core 的
 * `computeInterruptedStepRepair` / `computeInterruptedToolCallRepair`、投影的
 * `lingeringToolError`。抄一份字面量出去 = 下一次它们又分叉。
 */

/** 合成的中断结局给模型/用户看的那句话(prepare 写进 `tool/result.result.text`)。 */
export const CORE_INTERRUPTED_TOOL_ERROR
  = 'Tool call interrupted: the session ended before the tool returned.'

/** 卡在审批上被打断:比"工具没回来"多说一件事 —— 那张卡再也等不到答复了。 */
export const CORE_INTERRUPTED_PERMISSION_ERROR
  = 'Interrupted: permission request was not answered'

/** 被打断的调用/步骤的收场状态。**不是** failed —— 它没有失败,是没跑完。 */
export const CORE_INTERRUPTED_TOOL_STATUS = 'cancelled'

/**
 * 这条结局是 `prepare` 合成出来的吗?
 *
 * 判据是那一句话本身(全仓唯一产地是上面那个常量),不是某个新字段 ——
 * 老账本里那些已经合成过的 `tool/result` 同样认得出来,不必等词汇演进兜底。
 */
export function isCoreInterruptedToolResultText(text: string | undefined): boolean {
  return text === CORE_INTERRUPTED_TOOL_ERROR
}
