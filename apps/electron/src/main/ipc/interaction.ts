/**
 * Interaction IPC Handlers
 *
 * agent 提问 → 用户应答(claude-code-integration-v2 §4,E1)。
 *
 * 两个通道:补水读 pending、写回一次应答。**通道亲和的 channel 在这里由宿主盖成
 * 'ipc'**,不从渲染层传上来 —— 让应答方自报通道,那道闸就白设了。
 *
 * 注:除了这两条,应答还能走统一命令通道(`command:interaction-respond` →
 * EventBus → Interaction 的订阅),给非 IPC 的传输面用;两条路进的是同一个内核。
 */

import {
  registerElectronInteractionIpcHandlers,
  type ElectronInteractionSessionId,
} from '@onething/electron-host/ipc/interaction'
import {
  getPendingInteractionsForIpc,
  respondInteractionForIpc,
} from '@onething/runtime/interaction/ipc-operations.wiring'
import { IPC_CHANNELS } from '@shared/ipc.js'
import type { InteractionRespondRequest } from '@shared/ipc.js'
import { getLogger } from '@onething/backend/logging/index.js'

const log = getLogger('ipc.interaction')

export function registerInteractionHandlers(): void {
  registerElectronInteractionIpcHandlers({
    channels: {
      respond: IPC_CHANNELS.INTERACTION_RESPOND,
      getPending: IPC_CHANNELS.INTERACTION_GET_PENDING,
    },
    respond: (request: unknown) => {
      return respondInteractionForIpc(request as InteractionRespondRequest, 'ipc')
    },
    getPending: (sessionId: ElectronInteractionSessionId) => {
      return getPendingInteractionsForIpc(sessionId)
    },
  })

  log.info('handlers registered')
}
