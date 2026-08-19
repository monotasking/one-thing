import {
  CoreStreamEngine,
  resolveStreamPermissionMode,
  type CoreEventBusEmitterLike,
  type CoreStreamEngineRuntime,
  type CoreStreamPermissionModeSession,
  type CoreStreamPermissionModeSettings,
} from '@onething/core/engine'

import { getLogger } from './logging/index.js'

const log = getLogger('engine.stream')

export type OnethingStreamSenderPayload =
  | string
  | number
  | boolean
  | null
  | undefined
  | object

export interface OnethingStreamSender {
  isDestroyed(): boolean
  send(channel: string, ...args: OnethingStreamSenderPayload[]): void
}

export interface BindableOnethingStreamSender extends OnethingStreamSender {
  on(event: 'destroyed', listener: () => void): void
}

export class NoopOnethingStreamSender implements OnethingStreamSender {
  isDestroyed(): boolean {
    return false
  }

  send(): void {}
}

export class OnethingStreamEngine<
  TEventBus extends CoreEventBusEmitterLike = CoreEventBusEmitterLike,
  TSender extends OnethingStreamSender = OnethingStreamSender,
> extends CoreStreamEngine<TEventBus, TSender> {
  constructor(
    protected readonly onethingRuntime: CoreStreamEngineRuntime,
  ) {
    super(onethingRuntime)
  }

  getPermissionMode(sessionId: string): string {
    const session = this.onethingRuntime.store.getSession(sessionId) as CoreStreamPermissionModeSession | undefined
    const settings = this.onethingRuntime.store.getSettings() as CoreStreamPermissionModeSettings | undefined
    return resolveStreamPermissionMode(session, settings)
  }

  bind(sender: BindableOnethingStreamSender & TSender): void {
    this.bindCommandTarget(sender, clear => sender.on('destroyed', clear))
  }

  bindStatic(sender: TSender): void {
    this.bindCommandTarget(sender)
  }

  hasBoundSender(): boolean {
    return this.hasCommandTarget(sender => !sender.isDestroyed())
  }

  protected override onShutdown(): void {
    super.onShutdown()
    log.info('stream engine shut down')
  }
}
