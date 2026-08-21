import {
  getOnethingStorePath,
} from '@onething/runtime/storage'
import { registerElectronShellIpcHandlers } from './shell-controller.js'

export { registerElectronShellIpcHandlers } from './shell-controller.js'
export type {
  ElectronIpcMainLike,
  ElectronShellIpcChannels,
  ElectronShellIpcEvent,
  ElectronShellIpcOperations,
  RegisterElectronShellIpcHandlersOptions,
} from './shell-controller.js'

export function registerShellHandlers(): void {
  registerElectronShellIpcHandlers({
    getDataPath: () => getOnethingStorePath(),
  })
}
