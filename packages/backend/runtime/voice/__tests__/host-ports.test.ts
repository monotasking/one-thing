/**
 * `hasVoiceHost()` —— voice 域拿它替掉 `context.transport === 'http'`
 * (方案 `docs/design/backend-transport-forks-2026-09.md` §2.1/§2.2)。
 *
 * 值得钉的只有一件事:判据是**调过没调过 `configureVoiceHost`**,不是端口对象里
 * 有几个方法。`{}` 是一个合法的注入(「我有语音,但那三件推送我不需要」),而缺省
 * 值恰好也是 `{}` —— 若判据写成「看内容」,`voice: {}` 的宿主就会被当成没有语音。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  configureVoiceHost,
  getVoiceHostPorts,
  hasVoiceHost,
  resetVoiceHostForTests,
} from '../host-ports.wiring.js'

afterEach(() => {
  resetVoiceHostForTests()
})

describe('hasVoiceHost', () => {
  it('is false before any host configures it', () => {
    expect(hasVoiceHost()).toBe(false)
  })

  it('is true after the host injects the port — even when the port is empty', () => {
    configureVoiceHost({})
    expect(hasVoiceHost()).toBe(true)
    expect(getVoiceHostPorts()).toEqual({})
  })

  it('keeps the injected ports readable', () => {
    const updateTray = () => {}
    configureVoiceHost({ updateTray })
    expect(hasVoiceHost()).toBe(true)
    expect(getVoiceHostPorts().updateTray).toBe(updateTray)
  })

  it('goes back to false through the test reset口', () => {
    configureVoiceHost({})
    resetVoiceHostForTests()
    expect(hasVoiceHost()).toBe(false)
    expect(getVoiceHostPorts()).toEqual({})
  })
})
