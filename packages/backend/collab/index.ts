export {
  handleCollabRoomSendMessage,
  isCollabRoomSession,
  type CollabRoomInboundCommand,
} from './ingress.js'
/**
 * 房间的配置门(D6-b:从已删除的 `coordinator.ts` 搬进 `room-config.ts`)。
 * 名字一个都没改 —— 壳层与 daemon 的调用点因此一行不用动。
 */
export {
  applyUserCollabBoardAction,
  clearCollabRoomHistory,
  getCollabCoordinatorState,
  getCollabRoomSpend,
  readCollabRoomSpentTodayUSD,
  setCollabRoomBudgets,
  setCollabRoomConfig,
  setCollabRoomFrozen,
  type CollabBoardActResult,
  type CollabRoomClearHistoryResult,
  type CollabRoomConfigPatch,
  type CollabRoomConfigResult,
} from './room-config.js'
/**
 * Agent 视角的冷启动补水(D8 观测体系 §3.1)。
 *
 * 与 `getCollabCoordinatorState` 是**两本互不派生的账**:房间那本按房广播,而
 * 大脑、信箱、工作卡是跨房的 —— 任何一份房间快照里都没有它们的位置。
 */
export { getCollabAgentActivity } from './agent-activity.js'
/**
 * 调度时间轴的尾读(D8 §3.3)——「刚才为什么是那样」的唯一读口。
 *
 * 读**账文件**、不经运行时:app 挂了也能查,而抓瞎最惨的时刻恰恰是进程不对劲的
 * 时刻。UI 与诊断 CLI 走同一个函数,不各自 `readFileSync` 一遍(轮转、按日切文件、
 * 坏行跳过这几条规则只该有一份实现)。
 */
export {
  readCollabSchedulerLogTail,
  type CollabSchedulerLogTailOptions,
} from './actors/scheduler-log.js'
/** 停止按钮那扇门(D6-b 起只有 v3 一条实现)—— 见 `actors/stop-door.ts`。 */
export { abortCollabRoomTurnForStop } from './actors/stop-door.js'
/** Collab v3 运行时(D6-a):`createOnethingBackend` 的协作装配点。 */
export {
  initializeCollabV3Runtime,
  isCollabV3RuntimeRunning,
  shutdownCollabV3Runtime,
  type CollabV3RuntimeOptions,
} from './actors/runtime.js'
/** 建群房的唯一入口(架构收敛 C3):校验 + 落库,壳层不留业务规则。 */
export {
  ensureCollabGroupRoom,
  type CollabGroupRoomInput,
  type EnsureCollabGroupRoomOptions,
  type EnsureCollabGroupRoomResult,
} from './room-create.js'
/** 群 folder 的只读列目录(agent-im-chat-ui.md §3.2「文件」块)。 */
export {
  listCollabRoomFolder,
  type CollabRoomFolderEntry as CollabRoomFolderListEntry,
  type CollabRoomFolderListing,
} from './room-folder.js'
/** 用户 ↔ agent 托管私聊房的 get-or-create(agent-im-dm.md D1)。 */
export { ensureUserDmRoom } from './user-dm-room.js'
/** agent ↔ agent 私聊房的 get-or-create(agent-im-dm.md D3;`dm` 工具的建房口)。 */
export { ensureAgentDmRoom } from './agent-dm-room.js'
/**
 * 卡级停止的读口与停口(D6-b:v2 `worker.ts` 删除后改由 v3 运行时供数)。
 *
 * 对外的名字保持不变 —— collab 域的 `taskStop` 方法与「停止执行」菜单项的显示
 * 条件都吃这两个名字。
 */
export {
  hasActiveCollabV3Work as hasActiveCollabWork,
  stopCollabV3TaskWork as stopCollabTaskWork,
} from './actors/runtime.js'
/**
 * 人级停止(E5)—— 三级停止的第三级,collab 域的 `roomRevokeLease` 吃这个名字。
 *
 * 房级在 `stop-door.ts`(界面语义与运行时语义分家的那一层),卡级在上面那条,
 * 这一条直接对外:它没有"不是 v3 房就回落 v2"的第二条路可走 —— v2 从来没有过
 * 人级停止,回落的目的地是空的。
 */
export { revokeCollabV3RoomLease as revokeCollabRoomLease } from './actors/runtime.js'
export { attachCollabMentions } from './mentions.js'
export { attachCollabReplyTo } from './reply-quote.js'
export {
  reactToCollabMessage,
  type CollabMessageReactionOptions,
  type CollabMessageReactionResult,
} from './reactions.js'
