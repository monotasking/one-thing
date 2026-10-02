/**
 * `hasShellHost()` —— oauth 域拿它替掉 `context.transport === 'http'`
 * (方案 `docs/design/backend-transport-forks-2026-09.md` §2.1/§2.2)。
 *
 * ## C0 R7:口径改了(方案 `backend-principal-and-mcp-lifecycle-2026-09.md` §2.3)
 *
 * B1 那版判的是**内容**(三件里至少给了一件),而同一族的 `hasVoiceHost()` /
 * `hasTerminalHost()` 判的是**声明**(configure 调过 / 广播器非 null)。审查第 7 条:
 * 一族访问器两种口径,读它的人无从知道自己问到的是哪一种。统一成声明:
 * `configureShellHost({})` 也算「这台宿主认领了外壳能力」,与 `configureVoiceHost({})`
 * 逐字同义 —— 声明了一张空表是宿主自己的事。
 *
 * **这不是把降级拆了**:三件事各自给没给,判据仍在 `getShellHost()` 门面里
 * (未注入那件 → 结构化失败),下面最后两条钉的就是这一点。今天没有任何宿主
 * 写 `shell: {}`(Vue 桌面三件齐全,其余四个宿主一律 `null`),所以现网每一台
 * 宿主的答案在改前改后逐字相同。
 *
 * 还原口从 `configureShellHost({})` 换成 `resetShellHost()`(C0 R6 新立的正式还原
 * 语义,`applyHostPorts` 在 `backend.dispose()` 时调的也是它)—— 闩语义下用一次
 * 空 configure 当 reset 已经不成立了。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  configureShellHost,
  getShellHost,
  hasShellHost,
  resetShellHost,
  SHELL_HOST_UNAVAILABLE,
} from '../host-ports.js'

afterEach(() => {
  resetShellHost()
})

describe('hasShellHost', () => {
  it('is false before any host configures it', () => {
    expect(hasShellHost()).toBe(false)
  })

  it('C0 R7:空端口表也算「宿主声明过」—— 与 hasVoiceHost 同口径', () => {
    configureShellHost({})
    expect(hasShellHost()).toBe(true)
  })

  it('is true once the host contributes any one of the three', async () => {
    configureShellHost({ openExternal: async () => ({ success: true }) })
    expect(hasShellHost()).toBe(true)
    await expect(getShellHost().openExternal('https://example.test')).resolves.toEqual({
      success: true,
    })
  })

  /**
   * 声明与「给了哪几件」是两件事:声明过、但那一件没给 → `hasShellHost()` 仍是
   * true,而门面照样交结构化失败。oauth 域的 `start` 因此不再把这条失败吞成成功
   * (C0 R7 的另一半,见 `rpc/domains/oauth.ts`)。
   */
  it('C0 R7:声明过但没给这一件 → 门面仍是结构化失败', async () => {
    configureShellHost({ openExternal: async () => ({ success: true }) })
    configureShellHost({})
    expect(hasShellHost()).toBe(true)
    await expect(getShellHost().openExternal('https://example.test')).resolves.toEqual({
      success: false,
      error: SHELL_HOST_UNAVAILABLE,
    })
  })

  it('C0 R6:resetShellHost() 把它打回「从未声明」', async () => {
    configureShellHost({ openExternal: async () => ({ success: true }) })
    resetShellHost()
    expect(hasShellHost()).toBe(false)
    await expect(getShellHost().openExternal('https://example.test')).resolves.toEqual({
      success: false,
      error: SHELL_HOST_UNAVAILABLE,
    })
  })
})
