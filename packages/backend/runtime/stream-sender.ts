/**
 * 流引擎的**命令目标**形状(P3'e A1,2026-08-21)。
 *
 * 从前和 `OnethingStreamEngine` 同住 `stream-engine.ts`;那个 71 行的中间类已
 * 并进 `packages/backend/engine/stream-engine.ts`,但这三件是产品层自己的公开
 * 类型 —— `runtime.ts` / `gateway-runtime.ts` 都拿它当泛型下界与默认 sender,
 * 所以留在产品层,单独成文件。
 */

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
