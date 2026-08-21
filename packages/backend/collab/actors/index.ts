/**
 * Collab v3 的 actor 装配面(`@onething/backend` 的 `collab/actors/`)。
 *
 * 这里是带 IO 的那一半:账落盘、mailbox 广播、宿主端口、C4 快照供数。规则(账的
 * 转换、三道闸、发牌策略)在纯层的 `@onething/runtime/collab/actors`,两边共用
 * **同一个** `decide()`,金重放因此验的是真机的代码而不是它的复制品。
 *
 * D1 是房间,D2 是 AgentActor(心智循环 / 信箱 / 笔记 / MindPort);Referee(D3)、
 * Worker(D4)会挨着它们落在这个目录里。
 * **本期不接引擎、不接宿主** —— v2 的调度链仍然是生产,接线在 D6。
 */
export {
  COLLAB_ACTORS_DIR,
  COLLAB_ROOM_ACCOUNT_FILE,
  collabRoomAccountPath,
  collabRoomActorsDir,
  createCollabRoomAccountFileStore,
  createCollabRoomAccountMemoryStore,
} from './room-account.js'
export type { CollabRoomAccountStore } from './room-account.js'

export {
  buildCollabRoomActorSnapshot,
  CollabRoomActor,
  CollabRoomBroadcastError,
  collabRoomBroadcastRecipients,
} from './room-actor.js'
export type {
  CollabRoomActorHost,
  CollabRoomActorOptions,
  CollabRoomMemberMailbox,
} from './room-actor.js'

export {
  collabRoomMembersFromTranscript,
  createCollabRoomActorReplayPipeline,
} from './room-replay.js'
export type {
  CollabRoomActorReplayPipeline,
  CollabRoomReplayOptions,
} from './room-replay.js'

/* ── D2:AgentActor ─────────────────────────────────────────────────────── */

export {
  COLLAB_AGENTS_V3_DIR,
  COLLAB_AGENT_ACCOUNT_FILE,
  COLLAB_AGENT_MAILBOX_NAME,
  COLLAB_AGENT_NOTEBOOK_FILE,
  collabAgentAccountPath,
  collabAgentActorDir,
  collabAgentNotebookPath,
  createCollabAgentAccountFileStore,
  createCollabAgentAccountMemoryStore,
  openCollabAgentMailbox,
} from './agent-mailbox.js'
export type { CollabAgentAccountStore } from './agent-mailbox.js'

export {
  buildCollabAgentNotebookBlock,
  createCollabNotebookFileStore,
  createCollabNotebookMemoryStore,
} from './notebook-store.js'
export type {
  CollabNotebookAppendInput,
  CollabNotebookAppendResult,
  CollabNotebookStore,
} from './notebook-store.js'

export { createCollabScriptedMindPort } from './mind-port.js'
export type {
  CollabMindPort,
  CollabMindSay,
  CollabMindSteerRequest,
  CollabMindTurnMessage,
  CollabMindTurnOutcome,
  CollabMindTurnRequest,
  CollabMindTurnResult,
  CollabScriptedCall,
  CollabScriptedMindPort,
  CollabScriptedTurn,
} from './mind-port.js'

/**
 * **刻意不从这个桶里导出的三样**:
 *
 *  - `engine-mind-port.ts`(对话回合的生产适配器)—— 它 import 引擎、总线、会话仓库;
 *  - `worker-mind-port.ts`(工作回合的生产适配器,D4)—— 同上;
 *  - `notebook-tool.ts`(工具接线)—— 它 import 会话仓库。
 *
 * 这个桶今天的读者是**重放与测试**,它们跑在没有引擎、没有 store 的环境里。
 * 把那两个挂上来,等于让每一条 `import '@onething/backend' 的 collab/actors` 都
 * 顺带把半个主进程拉起来(D2 实施时真的把 D1 的房间测试整个拖挂了)。两者各自
 * 按路径 import:工具在 `app/tools/builtin/index.ts` 注册,适配器在 D6 接线。
 */
export { CollabAgentActor } from './agent-actor.js'
export type {
  CollabAgentActorHost,
  CollabAgentActorOptions,
  CollabAgentOrphanPolicy,
  CollabAgentOutbox,
  CollabAgentRoomContextInput,
  CollabAgentTurnFailure,
  CollabAgentWorkerFailure,
  CollabAgentWorkerOptions,
  CollabAgentWorkerRecovery,
} from './agent-actor.js'

/* ── D4:WorkerChildActor ───────────────────────────────────────────────── */

export {
  admitCollabWorkerSpawn,
  CollabWorkerChildActor,
  createCollabScriptedWorkerPort,
  createCollabWorkerBoardRecorder,
  createCollabWorkerSlotLedger,
} from './worker-child.js'
export type {
  CollabScriptedWork,
  CollabScriptedWorkerCall,
  CollabScriptedWorkerPort,
  CollabWorkerBoardCall,
  CollabWorkerBoardPort,
  CollabWorkerBoardRecorder,
  CollabWorkerBoardSettledInput,
  CollabWorkerBoardStartedInput,
  CollabWorkerBoardVerdict,
  CollabWorkerChildActorOptions,
  CollabWorkerChildOutcome,
  CollabWorkerMindPort,
  CollabWorkerRunRequest,
  CollabWorkerRunResult,
  CollabWorkerSlotLedger,
} from './worker-child.js'

/* ── D3:RefereeActor ───────────────────────────────────────────────────── */

/**
 * `referee-judge.ts`(批量裁决的生产适配器)同样**不从这个桶导出** —— 它 import
 * providers / store / 计费,与上面那三样同一条理由。D6 接线时按路径 import。
 */
export {
  COLLAB_REFEREE_TIMEOUT_MS,
  CollabRefereeActor,
  createCollabScriptedRefereeJudgePort,
} from './referee-actor.js'
export type {
  CollabRefereeActorHost,
  CollabRefereeActorOptions,
  CollabRefereeJudgePort,
  CollabRefereeJudgeRequest,
  CollabRefereeOutbox,
  CollabRefereeTrace,
  CollabScriptedJudgement,
  CollabScriptedRefereeJudgePort,
} from './referee-actor.js'

/* ── D5:迁移器 ─────────────────────────────────────────────────────────── */

/**
 * **不接宿主** —— 它没有 boot 触发点,只能被显式调用(`scripts/collab-v3-migrate.mjs`
 * 与测试)。接进启动序列是 D6 的事:一趟单向门在切换之前不该有任何自动触发的机会。
 */
export {
  collabStoreDir,
  collabV2BackupDir,
  collabV3AgentAccountExists,
  collabV3MigrationMarkerPath,
  migrateCollabToV3,
  readCollabV3MigrationMarker,
} from './migrate.js'
export type { CollabV3MigrationOptions } from './migrate.js'

export { collabDuetMembersOf, replayCollabDuet } from './agent-replay.js'
export type {
  CollabDuetReplayOptions,
  CollabDuetReplayResult,
  CollabDuetRoomSpec,
} from './agent-replay.js'

/* ── D8:调度时间轴的落盘面 ─────────────────────────────────────────────── */

/**
 * 纯规则(行类型、构造、渲染/解析、按日切、房间转换 → 行)在
 * `@onething/runtime/collab/actors` 的 `scheduler-log-rules.ts`。这边只有 fs。
 */
export {
  COLLAB_SCHEDULER_LOG_TAIL_DEFAULT,
  collabDeadLetterRoomId,
  collabSchedulerLogPath,
  createCollabDeadLetterSink,
  createCollabSchedulerLogFileStore,
  createCollabSchedulerLogMemoryStore,
  listCollabSchedulerLogFiles,
  readCollabSchedulerLogTail,
  resetCollabSchedulerLogWarnings,
  sweepCollabSchedulerLogs,
} from './scheduler-log.js'
export type {
  CollabDeadLetterSinkOptions,
  CollabSchedulerLogMemoryStore,
  CollabSchedulerLogStore,
  CollabSchedulerLogTailOptions,
} from './scheduler-log.js'
