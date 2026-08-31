import type {
  ExecutePluginCommandResponse,
  GetPluginCommandsResponse,
} from '@shared/ipc/plugins'
import type { SessionCommandEmitResult } from '@shared/ipc/session-command'

/**
 * 斜杠命令里**插件那一半**与 `@renderer/platform` 之间的那一层端口
 * (D4 波二)—— 与 `data/models-port.ts` / `data/files-port.ts` 同一形状、同一理由。
 *
 * 形状是平台调用面的子集,不是新契约:三条逐条对应
 * `pluginsApi.getPluginCommands` / `pluginsApi.executePluginCommand` /
 * `sessionCommands.emit`,一个字段都没多。
 *
 * ── 为什么内置那七条几乎不在这里 ────────────────────────────────────────────
 * 内置命令**表**不需要取数:它是 `@onething/core/slash-commands` 的
 * `SHARED_SLASH_COMMANDS`,一份编译期常量,壳直接读(见 commands-source.ts)。
 * 执行也大多骑现成的口 —— `/new` 走建会话的编排点(由调用现场递进来)、
 * `/cd` 走 `sessions-port.updateWorkingDirectory`。只有 `/compact` 在这里多一条:
 * 它要往会话命令总线上发一封信,而这一层此前没有任何一条通向那条总线的路。
 *
 * 它**没有**放到 `chat-port` 上(那里也发同一条总线),判据是**谁按下它**:
 * 按发送键 / 按停止键的那几下归聊天那块屏幕,从命令表里派出去的这一下归命令表。
 * 合在一起会让「聊天数据源」凭空多出一条它自己从不使用的动作。
 *
 * ── 留账:写面在联网宿主上会被能力位挡住 ────────────────────────────────────
 * `plugins` 域按 `context.transport` 分叉:读面(`commands`)两个宿主都真,
 * 而 `executeCommand` 在一台**没有装配插件管理器**的 standalone server 上会回
 * 「desktop host only」那句结构化回答(CLAUDE.md 的 plugins 段)。这里不预判 ——
 * 后端答什么就报什么,壳不替它编一句「你的宿主不支持」。
 */
export interface CommandsPort {
  /** 传输面就绪(D0 的 whenConnected);浏览器直开时它也会 resolve。 */
  ready(): Promise<unknown>
  /** 这台机器上装着的插件命令。拉不到 = 只剩内置那七条(静默降级,见 source)。 */
  listPluginCommands(): Promise<GetPluginCommandsResponse>
  /**
   * 跑一条插件命令。`commandName` 是**带斜杠的原名**(后端按它查表),
   * `args` 是命令名之后原样的那一截。
   */
  executePluginCommand(
    commandName: string,
    args: string,
    sessionId: string,
  ): Promise<ExecutePluginCommandResponse>
  /**
   * 压缩这条会话的上下文(`command:compact-context`)—— `/compact` 的收件人。
   *
   * 与壳里其它命令信封同惯例:只多给一格 `manual: true`,而它不是现造的事实
   * (这一次压缩确实是人按出来的,不是引擎到线自动触发的 —— 契约上那一格
   * 问的正是这件事)。**不带 `requestId`**:它在 Vue 壳里的用处是配对那条完成
   * 事件好画一张「压缩中」的卡,而这套壳没有那块地方 —— 结果以账本上的
   * `session/compacted` 落进会话里,屏幕跟着折叠产物走。
   */
  compactContext(sessionId: string): Promise<SessionCommandEmitResult>
}

let port: CommandsPort | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureCommandsPort(next: CommandsPort | undefined): void {
  port = next
}

/**
 * 真实现是**惰性**建的,理由与 sessions-port 逐字相同:`@renderer/platform`
 * 在模块顶层就会去摸 `window`,而端口被换掉的测试根本不该把它拖进来
 * (默认假端口装在 `src/test/setup.ts` 里)。
 */
async function realPort(): Promise<CommandsPort> {
  const [{ pluginsApi }, { sessionCommands }, { whenConnected }] = await Promise.all([
    import('@renderer/platform/plugins-client'),
    import('@renderer/platform/session-command-client'),
    import('../platform/connection'),
  ])
  const { SESSION_COMMAND_TYPES } = await import('@shared/events/session-commands')
  return {
    ready: () => whenConnected(),
    listPluginCommands: () => pluginsApi.getPluginCommands(),
    executePluginCommand: (commandName, args, sessionId) =>
      pluginsApi.executePluginCommand(commandName, args, sessionId),
    compactContext: (sessionId) =>
      sessionCommands.emit({
        sessionId,
        command: { type: SESSION_COMMAND_TYPES.COMPACT_CONTEXT, manual: true },
      }),
  }
}

let pending: Promise<CommandsPort> | undefined

export function commandsPort(): Promise<CommandsPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}
