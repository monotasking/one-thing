import { ipcMain } from 'electron'

export interface ElectronScratchpadIpcMainLike {
  handle<TArgs extends unknown[]>(
    channel: string,
    listener: (event: unknown, ...args: TArgs) => unknown,
  ): void
}

export interface ElectronScratchpadIpcChannels {
  get: string
  update: string
  delete: string
  adopt: string
}

export interface RegisterElectronScratchpadIpcHandlersOptions {
  channels: ElectronScratchpadIpcChannels
  get(request: unknown): unknown
  update(request: unknown): unknown
  delete(request: unknown): unknown
  adopt(request: unknown): unknown
  ipcMain?: ElectronScratchpadIpcMainLike
}

export function registerElectronScratchpadIpcHandlers(
  options: RegisterElectronScratchpadIpcHandlersOptions,
): void {
  const host = options.ipcMain ?? ipcMain

  host.handle(options.channels.get, (_event, request: unknown) => {
    return options.get(request)
  })

  host.handle(options.channels.update, (_event, request: unknown) => {
    return options.update(request)
  })

  host.handle(options.channels.delete, (_event, request: unknown) => {
    return options.delete(request)
  })

  host.handle(options.channels.adopt, (_event, request: unknown) => {
    return options.adopt(request)
  })
}
