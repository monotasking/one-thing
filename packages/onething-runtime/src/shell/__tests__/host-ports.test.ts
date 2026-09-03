/**
 * `hasShellHost()` —— oauth 域拿它替掉 `context.transport === 'http'`
 * (方案 `docs/design/backend-transport-forks-2026-09.md` §2.1/§2.2)。
 *
 * 这个访问器在 P4c 第二批就存在了,B1 只是第一次有域读它。判据与 voice 那格
 * **有意不同**:shell 的三件能力全是可选的,「有外壳」= 至少给了一件 ——
 * 递一个空对象等于说「我什么都打不开」,那与没接是同一件事,也是 `getShellHost()`
 * 门面上那三条结构化降级的判据。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  configureShellHost,
  getShellHost,
  hasShellHost,
  SHELL_HOST_UNAVAILABLE,
} from '../host-ports.js'

afterEach(() => {
  configureShellHost({})
})

describe('hasShellHost', () => {
  it('is false before any host configures it', () => {
    expect(hasShellHost()).toBe(false)
  })

  it('is false for an empty port table — nothing can be opened', () => {
    configureShellHost({})
    expect(hasShellHost()).toBe(false)
  })

  it('is true once the host contributes any one of the three', async () => {
    configureShellHost({ openExternal: async () => ({ success: true }) })
    expect(hasShellHost()).toBe(true)
    await expect(getShellHost().openExternal('https://example.test')).resolves.toEqual({
      success: true,
    })
  })

  it('goes back to false when the host table is cleared', async () => {
    configureShellHost({ openExternal: async () => ({ success: true }) })
    configureShellHost({})
    expect(hasShellHost()).toBe(false)
    await expect(getShellHost().openExternal('https://example.test')).resolves.toEqual({
      success: false,
      error: SHELL_HOST_UNAVAILABLE,
    })
  })
})
