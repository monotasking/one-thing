/**
 * 停止按钮的那扇门。
 *
 * `apps/electron/src/main/ipc/chat.ts` 注入的是 `abortCollabRoomTurnForStop` ——
 * 从 D6-a 到 D6-b 这个名字一个字都没改,变的只是门后面:v2 那条按 `activeTurns`
 * 逐条 abort 的老路随调度链一起删了,现在只剩租约那一条(换代 + 撤牌 + 掐流)。
 *
 * 为什么仍然是独立一个文件而不是直接导出 `runtime.ts` 里那个:名字的**语义**
 * 归界面(「停下这间房」),`stopCollabV3RoomFloor` 的语义归运行时(「这间房的
 * 租约换一代」)。中间这一层还负责把「这不是一间 v3 房」翻译成 `false` —— 一间
 * 从没被驱动过的房按下停止,答案是"没停下任何东西",而不是一个 null 漏到界面上。
 */
import { stopCollabV3RoomFloor } from './runtime.js'

/**
 * 停下这间房的对话。返回 true = 真的停下了什么(渲染层据此决定要不要提示)。
 *
 * **工作会话刻意不碰**:停对话不是停干活 —— 那是冻结开关的语义,它有自己的按钮。
 */
export function abortCollabRoomTurnForStop(sessionId: string): boolean {
  return stopCollabV3RoomFloor(sessionId) ?? false
}
