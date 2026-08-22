/**
 * Electron chat IPC host —— 结构债 P4c 第五批之后只剩**一条**。
 *
 * 六条数据面(history / title / system-prompt-snapshot / thinking-time /
 * abort / active-streams)已整只迁到通用 RPC 通道(`chatRouter` +
 * `packages/backend/rpc/domains/chat.ts`)。留在这里的是第七条
 * `RESUME_AFTER_TOOL_CONFIRM`(拍板 #21):它把 `event.sender`(发起这次 invoke
 * 的 `webContents`)往 `StreamEngine.handleResumeAfterConfirm` 递,而 router 的
 * 信封里没有「谁在问」这一格 —— 补一格进去等于给通用通道加一条只有一个宿主用
 * 得上的私货。web 侧同名方法从来就不是这条路:它打的是命令总线上的
 * `command:resume-after-confirm`。
 */
import { ipcMain } from 'electron'

export interface ElectronIpcMainLike {
  handle<TArgs extends unknown[]>(
    channel: string,
    listener: (event: unknown, ...args: TArgs) => unknown,
  ): void
}

export interface ElectronChatIpcChannels {
  resumeAfterToolConfirm: string
}

export interface ElectronResumeAfterToolConfirmRequest {
  sessionId: string
  messageId: string
}

export interface ElectronChatIpcInvokeEvent {
  sender: unknown
}

export interface RegisterElectronChatIpcHandlersOptions {
  channels: ElectronChatIpcChannels
  resumeAfterToolConfirm(request: ElectronResumeAfterToolConfirmRequest, sender: unknown): unknown
  ipcMain?: ElectronIpcMainLike
}

export function registerElectronChatIpcHandlers(
  options: RegisterElectronChatIpcHandlersOptions,
): void {
  const host = options.ipcMain ?? ipcMain

  host.handle(options.channels.resumeAfterToolConfirm, (event: unknown, request: ElectronResumeAfterToolConfirmRequest) => {
    return options.resumeAfterToolConfirm(request, (event as ElectronChatIpcInvokeEvent).sender)
  })
}
