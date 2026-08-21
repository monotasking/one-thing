/**
 * 会话命令 type 字面量的**唯一权威**。
 *
 * 它以前住在 `packages/shared/events/session-commands.ts`,而 core 禁 import
 * `@shared` —— 于是引擎那边只能把同一批字符串再手抄一遍(`onAnySession('command:…')`),
 * 词汇变成两份,渲染层的 `platformApi.emitCommand(…, { type: SESSION_COMMAND_TYPES.X })`
 * 到引擎订阅点的 find-references 就断在中间。
 *
 * 现在表在 core:core 自己用它订阅,shared 从这里再导出(与 `shared/tool-errors.ts`
 * 从 `@onething/core/permission` 再导出同一条做法),渲染层 / apps / backend 的
 * `import { SESSION_COMMAND_TYPES } from '@shared/events/session-commands'` 一个字不用改,
 * 但它们点到的标识符和引擎订阅表的键**是同一个**。
 *
 * 值与线上格式逐字相同;命令的**载荷形状**仍然留在 shared(它们要引用那边 ipc 目录里的
 * 附件 / 语音 / 身份类型,core 够不着),那边还压着一条双向穷尽断言:这张表多一条 /
 * 少一条,shared 都编译不过。
 */
export const SESSION_COMMAND_TYPES = {
  SEND_MESSAGE: 'command:send-message',
  EDIT_AND_RESEND: 'command:edit-and-resend',
  ABORT: 'command:abort',
  CONFIRM_TOOL: 'command:confirm-tool',
  RESUME_AFTER_CONFIRM: 'command:resume-after-confirm',
  PERMISSION_RESPOND: 'command:permission-respond',
  INTERACTION_RESPOND: 'command:interaction-respond',
  RETRY_MESSAGE: 'command:retry-message',
  COMPACT_CONTEXT: 'command:compact-context',
  INJECT_STEERING: 'command:inject-steering',
  RETRACT_STEERING: 'command:retract-steering',
  INJECT_FOLLOWUP: 'command:inject-followup',
} as const satisfies Record<string, `command:${string}`>

export type SessionCommandType = (typeof SESSION_COMMAND_TYPES)[keyof typeof SESSION_COMMAND_TYPES]
