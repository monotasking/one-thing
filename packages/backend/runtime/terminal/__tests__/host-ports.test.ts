/**
 * `hasTerminalHost()` —— terminal 域拿它替掉 `context.transport === 'http'`
 * (方案 `docs/design/backend-transport-forks-2026-09.md` §2.1/§2.2)。
 *
 * 判据是广播器在不在:没有输出通道的宿主开出来的 shell 是个哑巴,所以那七条
 * 一律结构化拒绝。`configureTerminalBroadcaster(null)` 既是宿主的摘除口,也是
 * 这里的复位口 —— 不需要再开一个 `resetForTests`。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configureTerminalBroadcaster,
  hasTerminalHost,
  type TerminalBroadcaster,
} from '../service.wiring.js'

const broadcaster: TerminalBroadcaster = {
  sendData: vi.fn(),
  sendExit: vi.fn(),
}

afterEach(() => {
  configureTerminalBroadcaster(null)
})

describe('hasTerminalHost', () => {
  it('is false before any host injects a broadcaster', () => {
    expect(hasTerminalHost()).toBe(false)
  })

  it('is true once the host injects one', () => {
    configureTerminalBroadcaster(broadcaster)
    expect(hasTerminalHost()).toBe(true)
  })

  it('goes back to false when the broadcaster is removed', () => {
    configureTerminalBroadcaster(broadcaster)
    configureTerminalBroadcaster(null)
    expect(hasTerminalHost()).toBe(false)
  })
})
