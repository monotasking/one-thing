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
} as const satisfies Record<string, `${string}:${string}`>

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[keyof typeof SESSION_EVENT_TYPES]
