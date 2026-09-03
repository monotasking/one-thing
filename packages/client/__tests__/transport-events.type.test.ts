// @vitest-environment node
/**
 * `TransportEvents` 的**类型**测试。
 *
 * 真正的判官是 `tsc -p tsconfig.node.json`(这棵树在它的 include 里),`expectTypeOf`
 * 只是把断言写成可读的一行。要证的三件事:
 *
 * 1. **名字从 `@shared/ipc/channels` 派生**,不是手抄的字符串字面量 —— 打错一个
 *    字母是编译红,不是运行时静默失聪。
 * 2. **载荷从 `@shared/events` / `@shared/ipc/settings` 派生**,不是本包重新声明的
 *    影子形状 —— 服务器改了字段,这里跟着红。
 * 3. `hub.on()` 的回调参数**按名字自动收窄**,壳不用自己标注也不用 `as`。
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import { IPC_CHANNELS } from '@shared/ipc/channels.js'
import type { SessionEventEnvelope, SessionStreamPayload } from '@shared/events/index.js'
import type { AppSettings } from '@shared/ipc/settings.js'
import type { EventHub } from '../events/subscriptions.js'
import type { TransportEventName, TransportEvents } from '../transport/types.js'

describe('TransportEvents 是从 @shared 派生的表', () => {
  it('三条事件名恰好是 /api/events 今天发的那三条', () => {
    expectTypeOf<TransportEventName>().toEqualTypeOf<
      | typeof IPC_CHANNELS.SESSION_EVENT
      | typeof IPC_CHANNELS.SESSION_STREAM
      | typeof IPC_CHANNELS.SETTINGS_CHANGED
    >()
  })

  it('载荷类型就是 @shared 的那一份,不是影子声明', () => {
    expectTypeOf<TransportEvents[typeof IPC_CHANNELS.SESSION_EVENT]>()
      .toEqualTypeOf<SessionEventEnvelope>()
    expectTypeOf<TransportEvents[typeof IPC_CHANNELS.SESSION_STREAM]>()
      .toEqualTypeOf<SessionStreamPayload>()
    expectTypeOf<TransportEvents[typeof IPC_CHANNELS.SETTINGS_CHANGED]>()
      .toEqualTypeOf<AppSettings>()
  })

  it('hub.on 的回调参数按名字收窄', () => {
    // **只编译,不执行**:这一格的判官是 `tsc -p tsconfig.node.json`(这棵树在它的
    // include 里),vitest 只负责把文件带进类型图。所以断言写在一个声明了但从不调用
    // 的函数里 —— 造一个假 hub 去真调用会在运行时炸,而那与要证的事无关。
    const narrowsByName = (hub: EventHub): void => {
      hub.on(IPC_CHANNELS.SESSION_EVENT, envelope => {
        expectTypeOf(envelope).toEqualTypeOf<SessionEventEnvelope>()
        expectTypeOf(envelope.sequence).toEqualTypeOf<number>()
      })
      hub.on(IPC_CHANNELS.SESSION_STREAM, payload => {
        expectTypeOf(payload).toEqualTypeOf<SessionStreamPayload>()
        expectTypeOf(payload.sessionId).toEqualTypeOf<string>()
      })
      // 不在表里的名字编译不过 —— 这一行是那条规矩的记录。
      // @ts-expect-error 'voice:event' 不在 /api/events 这条流上(它走 /api/voice/events)。
      hub.on('voice:event', () => {})
    }
    expect(typeof narrowsByName).toBe('function')
  })
})
