/**
 * 会话事件 type 字面量的**唯一权威**。
 *
 * 它以前住在 `packages/shared/events/session-events.ts`,而 core 禁 import `@shared`
 * —— 于是引擎、会话状态机、权限、交互那边只能把同一批字符串再手抄一遍
 * (`emit(sessionId, { type: 'stream:error', … })`、`case 'message:updated':`),
 * 词汇变成两份:渲染层 `ipc-hub` 上的 `SESSION_EVENT_TYPES.STREAM_ERROR` 到
 * `CoreStreamEngine` 发射点的 find-references 就断在中间。
 *
 * 现在表在 core:core 自己用它发射 / 订阅 / 分派,shared 从这里再导出(与
 * `session-command-types.ts` 同一条做法),渲染层 / apps / backend 的
 * `import { SESSION_EVENT_TYPES } from '@shared/events/session-events'` 一个字不用改,
 * 但它们点到的标识符和引擎发射点的**是同一个**。
 *
 * 命名风格沿用 `IPC_CHANNELS`:键是 SCREAMING_SNAKE,值与线上格式逐字相同 ——
 * 这些值是会话事件日志(`events.jsonl`)与影子投影判据的输入,改一个字母就是改协议。
 *
 * 事件的**载荷形状**仍然留在 shared(它们要引用那边 ipc 目录里的消息 / 权限 / 协作
 * 类型,core 够不着),那边压着一条双向穷尽断言:这张表多一条 / 少一条,shared 都
 * 编译不过。
 */
export const SESSION_EVENT_TYPES = {
  STREAM_START: 'stream:start',
  STREAM_COMPLETE: 'stream:complete',
  STREAM_ERROR: 'stream:error',
  STREAM_ABORTED: 'stream:aborted',
  STREAM_USAGE: 'stream:usage',
  TOOL_CALL: 'tool:call',
  TOOL_RESULT: 'tool:result',
  TOOL_INPUT_START: 'tool:input-start',
  TOOL_INPUT_END: 'tool:input-end',
  TOOL_EXECUTION_START: 'tool:execution-start',
  TOOL_EXECUTION_UPDATE: 'tool:execution-update',
  TOOL_EXECUTION_END: 'tool:execution-end',
  STEP_ADDED: 'step:added',
  STEP_UPDATED: 'step:updated',
  CONTENT_PART: 'content:part',
  CONTENT_CONTINUATION: 'content:continuation',
  CONTEXT_SIZE_UPDATED: 'context:size-updated',
  CONTEXT_COMPACT_STARTED: 'context:compact-started',
  CONTEXT_COMPACT_PROGRESS: 'context:compact-progress',
  CONTEXT_COMPACT_COMPLETED: 'context:compact-completed',
  SESSION_VARIABLES_UPDATED: 'session:variables-updated',
  SESSION_GOAL_UPDATED: 'session:goal-updated',
  STREAM_PARAMS_RESOLVING: 'stream:params-resolving',
  REQUEST_SNAPSHOT: 'request:snapshot',
  SKILL_ACTIVATED: 'skill:activated',
  PERMISSION_REQUEST: 'permission:request',
  PERMISSION_TIMEOUT: 'permission:timeout',
  PERMISSION_QUEUED: 'permission:queued',
  PERMISSION_SETTLED: 'permission:settled',
  INTERACTION_REQUESTED: 'interaction:requested',
  INTERACTION_SETTLED: 'interaction:settled',
  TOOL_EXECUTING: 'tool:executing',
  TOOL_METADATA: 'tool:metadata',
  SESSION_RENAMED: 'session:renamed',
  SESSION_COLLAB_UPDATED: 'session:collab-updated',
  STEERING_QUEUED: 'steering:queued',
  STEERING_CONSUMED: 'steering:consumed',
  STEERING_RETRACTED: 'steering:retracted',
  SCRATCHPAD_CONSUMED: 'scratchpad:consumed',
  MESSAGE_USER_CREATED: 'message:user-created',
  MESSAGE_CREATED: 'message:created',
  MESSAGE_ASSISTANT_CREATED: 'message:assistant-created',
  MESSAGE_UPDATED: 'message:updated',
  MESSAGE_DELETED: 'message:deleted',
  MESSAGES_REPLACED: 'messages:replaced',
  COLLAB_BOARD_CHANGED: 'collab:board-changed',
  COLLAB_TYPING: 'collab:typing',
  COLLAB_TURN_ACTIVE: 'collab:turn-active',
  COLLAB_COORDINATOR_CHANGED: 'collab:coordinator-changed',
  COLLAB_AGENT_CHANGED: 'collab:agent-changed',
  /**
   * B 期(§17.8):**事件账本原词汇**下发。载荷是 `events.jsonl` 里逐字同一条
   * `SessionLogEventRecord` —— 推送面从此有一种"事实"的说法,而不只是 UI 词汇。
   * 骑的是既有的 `session:event` 推送面(桌面 IPCBridge / web SSE 都观察总线),
   * 所以**没有新通道常量**。
   */
  SESSION_LEDGER_EVENT: 'session:ledger-event',
  /**
   * 共享层读侧补齐 E 批:**这条会话没有了**。
   *
   * 为什么它必须是一条**会话事件**而不是全局总线事件(`emitGlobal`):全局那条
   * 车道只有进程内的 `onGlobal` 订阅者(插件),它既不进 IPCBridge 也不进 SSE
   * —— 浏览器/新壳因此永远听不见。骑既有的 `session:event` 推送面,桌面
   * (`onAnySessionAny` → IPCBridge)与 web(`?sessionId=*` 的 SSE)是**同一条**
   * 总线的两个观察者,一条事件两边都有,**零新通道**。
   *
   * 建会话那一半不需要新词:`session/created` 是账本的第一条,B 期起随
   * `SESSION_LEDGER_EVENT` 原样下发。删会话在账本上没有对应的一条(目录连同
   * `events.jsonl` 一起没了),所以这一格是它唯一的说法。
   *
   * **它必须在真正删之前发**:web 侧的通配订阅逐条问"这条会话你读得到吗"
   * (`ownerMatchesContext`),删完再发就永远被那把尺子滤掉。
   *
   * ## 为什么是 `removed` 而不是 `deleted`
   *
   * 全局总线(`@shared/events/global-events.ts`)上已经有一个字面量
   * `'session:deleted'`,那是插件订阅的那条车道。两张词汇表**必须值不相交** ——
   * `scripts/headless-boundary-check.ts` 的
   * `checkSessionVocabularyUsesTheRegistry` 用精确值集扫全仓禁手打字面量,它的
   * 设计前提写在那个函数的注释里:"精确值集不会误伤全局事件 `session:created`"。
   * 复用同一个字符串会让那把尺子把全局车道那四处合法字面量一起判红 —— 于是这里
   * 换一个词,而不是去放宽守卫。
   */
  SESSION_REMOVED: 'session:removed',
} as const satisfies Record<string, `${string}:${string}`>

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[keyof typeof SESSION_EVENT_TYPES]
