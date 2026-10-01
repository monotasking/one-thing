/**
 * 会话命令 type 字面量的**唯一权威**。
 *
 * 它以前住在 `packages/shared/events/session-commands.ts`,而 core 禁 import
 * `@shared` —— 于是引擎那边只能把同一批字符串再手抄一遍(`onAnySession('command:…')`),
 * 词汇变成两份,渲染层的 `sessionCommands.emit({ …, command: { type: SESSION_COMMAND_TYPES.X } })`
 * 到引擎订阅点的 find-references 就断在中间。
 *
 * 后来表搬到了 core,shared 反过来从 core 再导出 —— 于是 core 与 shared 互相 import,
 * 成了一个环。2026-10(server / client 拆分第①步,`docs/design/server-client-split-2026-10.md`
 * §2 ①a)把主人定为 shared:词汇是 server 与 client 之间的契约,client 只看得见 shared。
 * 现在表住在这里,core 的引擎订阅表从 `@shared/events/session-command-types` 取,
 * 渲染层 / apps / backend 经 `@shared/events/session-commands` 再导出拿到的是同一个标识符。
 *
 * 值与线上格式逐字相同;命令的**载荷形状**在同目录的 `session-commands.ts`,那边压着
 * 一条双向穷尽断言:这张表多一条 / 少一条,shared 都编译不过。
 */
export const SESSION_COMMAND_TYPES = {
  SEND_MESSAGE: 'command:send-message',
  EDIT_AND_RESEND: 'command:edit-and-resend',
  ABORT: 'command:abort',
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
