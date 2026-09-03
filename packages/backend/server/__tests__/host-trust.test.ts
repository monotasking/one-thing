/**
 * `server/host-trust.ts` —— 本机宿主可信这一格本身(B2 改名批新立)。
 *
 * 这个单槽端口 B2 之前叫 `local-trust.ts` / `configureFilesLocalTrust`,只有 files
 * 与 sessions 两个消费者;B2 之后 tools / search / evals / mcp 也问它,所以它的
 * 三条不变量值得单独钉一份,而不是散在六个域的用例里:
 *
 *  1. **未声明 = 不可信**(单元测试 / CLI daemon / 非回环 server 的默认态);
 *  2. **`ONETHING_SERVER_FILES_SANDBOX=1` 压得住任何声明**,且是**每次现读** ——
 *     开关一撤,声明照旧生效(它不是"把声明抹掉");
 *  3. **还原函数按栈让位**:桌面内嵌面与 `server:start` 在同一进程里先后起落时,
 *     后者的 shutdown 不许把前者的声明一起清掉。
 *
 * 外加 B2 自己的两件:`hostLocalTrustOrigin()`(mcp 的 stdio 闸要在两种可信之间
 * 再分一档)与那几个 `@deprecated` 旧名(必须与新名**是同一个函数**,否则"保留
 * 别名"就成了第二条实现)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  configureFilesLocalTrust,
  configureHostLocalTrust,
  hostLocalTrustOrigin,
  isFilesHostLocallyTrusted,
  isHostLocallyTrusted,
  resetFilesLocalTrustForTests,
  resetHostLocalTrustForTests,
} from '../host-trust.js'

describe('host local trust port', () => {
  beforeEach(() => {
    resetHostLocalTrustForTests()
    delete process.env.ONETHING_SERVER_FILES_SANDBOX
  })

  afterEach(() => {
    resetHostLocalTrustForTests()
    delete process.env.ONETHING_SERVER_FILES_SANDBOX
  })

  it('starts undeclared: not trusted, no origin', () => {
    expect(isHostLocallyTrusted()).toBe(false)
    expect(hostLocalTrustOrigin()).toBeNull()
  })

  it('reports the declaring origin so a judgment can split the two kinds of trust', () => {
    const restore = configureHostLocalTrust({ origin: 'loopback-server', host: '127.0.0.1' })
    expect(isHostLocallyTrusted()).toBe(true)
    expect(hostLocalTrustOrigin()).toBe('loopback-server')

    restore()
    configureHostLocalTrust({ origin: 'desktop-embedded' })
    expect(hostLocalTrustOrigin()).toBe('desktop-embedded')
  })

  it('lets ONETHING_SERVER_FILES_SANDBOX=1 override a declaration, and re-reads it every time', () => {
    configureHostLocalTrust({ origin: 'desktop-embedded' })
    process.env.ONETHING_SERVER_FILES_SANDBOX = '1'
    expect(isHostLocallyTrusted()).toBe(false)
    // 强制收紧时 origin 也必须收回 null —— 否则 mcp 的 stdio 闸会绕过这个开关。
    expect(hostLocalTrustOrigin()).toBeNull()

    delete process.env.ONETHING_SERVER_FILES_SANDBOX
    expect(isHostLocallyTrusted()).toBe(true)
    expect(hostLocalTrustOrigin()).toBe('desktop-embedded')
  })

  it('restores the previous declaration instead of clearing the slot', () => {
    const restoreOuter = configureHostLocalTrust({ origin: 'desktop-embedded' })
    const restoreInner = configureHostLocalTrust({ origin: 'loopback-server' })
    restoreInner()
    expect(hostLocalTrustOrigin()).toBe('desktop-embedded')
    restoreOuter()
    expect(isHostLocallyTrusted()).toBe(false)
  })

  it('keeps the pre-B2 names as aliases of the very same functions, not a second implementation', () => {
    expect(configureFilesLocalTrust).toBe(configureHostLocalTrust)
    expect(isFilesHostLocallyTrusted).toBe(isHostLocallyTrusted)
    expect(resetFilesLocalTrustForTests).toBe(resetHostLocalTrustForTests)
  })
})
