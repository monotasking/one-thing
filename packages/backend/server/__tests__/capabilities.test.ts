/**
 * `/api/capabilities` 的五位**从后端事实推导**(B3,方案
 * `docs/design/backend-transport-forks-2026-09.md` §2.3)。
 *
 * B3 之前这张快照除 `collabRooms` 外全是静态常量 —— 前端拿到的能力位与后端真正
 * 的护栏是两套判据,审计 `backend-architecture-review-2026-09-02.md` §2.6 的
 * "对不齐"就是它。B3 之后每一位右边是**对应那个 RPC 域自己在读的**那个函数,
 * 于是"能不能做"与"UI 让不让点"只有一个答案。
 *
 * 这份测试问的正是这件事,所以每条断言都写成两半:
 *  1. 换一个后端事实(注入广播器 / 声明信任 / 装上管理器),这一位跟着变;
 *  2. **判据同源** —— 同一时刻,那一位与那个判据函数的返回值逐字相同。
 *     第 2 半是这一批真正要钉的:把哪一位改回常量,它立刻红,而第 1 半在
 *     "常量恰好等于期望值"的宿主上可能还是绿的。
 *
 * 读的是 `runtime.capabilities.get()` —— `/api/capabilities` 路由自己调的就是这
 * 一格(`server/http.ts` 的 `handleGetCapabilities`),不另造观察口。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 插件管理器那一位是**这个进程装没装管理器**,而这只测试进程永远不装 —— 所以
 * 只能把那个判据函数换掉。换的是 `wiring/plugins/index.js` 的 `getPluginManager`
 * 本身(其余导出原样透传),也就是 plugins 域读的同一个口。
 */
let pluginManagerPresent = false
vi.mock('../../wiring/plugins/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../wiring/plugins/index.js')>()
  return {
    ...actual,
    getPluginManager: () => (pluginManagerPresent ? ({} as never) : null),
  }
})

import type { TerminalBroadcaster } from '@onething/runtime/terminal/service.wiring'
import { configureTerminalBroadcaster, hasTerminalHost } from '@onething/runtime/terminal/service.wiring'
import { getPluginManager } from '../../wiring/plugins/index.js'
import {
  configureHostLocalTrust,
  isHostLocallyTrusted,
  resetHostLocalTrustForTests,
} from '../host-trust.js'
import type { OnethingServerRuntime } from '../runtime.js'
import { createTestServerRuntime } from './test-helpers.js'

const broadcaster: TerminalBroadcaster = { sendData: vi.fn(), sendExit: vi.fn() }

const runtimes: OnethingServerRuntime[] = []
const tempDirs: string[] = []
const originalStorePath = process.env.ONETHING_STORE_PATH

/** 每条用例一份新的 runtime:能力位是**现取**的,但 runtime 本身要一只真的。 */
async function capabilities(): Promise<Record<string, unknown>> {
  const dir = await mkdtemp(join(tmpdir(), 'onething-capabilities-'))
  tempDirs.push(dir)
  process.env.ONETHING_STORE_PATH = dir
  const runtime = await createTestServerRuntime()
  runtimes.push(runtime)
  const adapter = runtime.runtime.capabilities
  expect(adapter).toBeTruthy()
  return (await adapter!.get()) as unknown as Record<string, unknown>
}

beforeEach(() => {
  pluginManagerPresent = false
  configureTerminalBroadcaster(null)
  resetHostLocalTrustForTests()
  delete process.env.ONETHING_SERVER_FILES_SANDBOX
})

afterEach(async () => {
  pluginManagerPresent = false
  configureTerminalBroadcaster(null)
  resetHostLocalTrustForTests()
  await Promise.all(runtimes.map(runtime => runtime.shutdown()))
  runtimes.length = 0
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
  tempDirs.length = 0
  if (originalStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = originalStorePath
})

describe('/api/capabilities 的能力位从后端事实推导(B3)', () => {
  it('未注入任何宿主能力时,推导出来的四位全是 false', async () => {
    const snapshot = await capabilities()
    expect(snapshot).toMatchObject({
      localFileSystem: false,
      shellTools: false,
      terminal: false,
      pluginsManage: false,
      // 纯客户端形态那几位仍是常量,B3 不动。
      workspaceFileSystem: true,
      nativeWindowControls: false,
      clipboardWrite: false,
      desktopWindows: false,
      globalMenuEvents: false,
    })
  })

  it('注入终端广播器 → terminal 抬起来,摘掉 → 落回去', async () => {
    configureTerminalBroadcaster(broadcaster)
    expect((await capabilities()).terminal).toBe(true)

    configureTerminalBroadcaster(null)
    expect((await capabilities()).terminal).toBe(false)
  })

  it('声明本机可信 → localFileSystem 抬起来,重置 → 落回去', async () => {
    configureHostLocalTrust({ origin: 'desktop-embedded' })
    expect((await capabilities()).localFileSystem).toBe(true)

    resetHostLocalTrustForTests()
    expect((await capabilities()).localFileSystem).toBe(false)
  })

  it('装上插件管理器 → pluginsManage 抬起来', async () => {
    pluginManagerPresent = true
    expect((await capabilities()).pluginsManage).toBe(true)

    pluginManagerPresent = false
    expect((await capabilities()).pluginsManage).toBe(false)
  })

  /**
   * **判据同源**。反证:把 `currentServerCapabilities()` 的 `terminal` 改回常量
   * `false`(或 `pluginsManage` / `localFileSystem` 同理),这一条立刻红 —— 而
   * 上面那三条里"落回 false"的那一半仍然绿。
   */
  it('同一时刻,每一位与它那个判据函数逐字相同', async () => {
    configureTerminalBroadcaster(broadcaster)
    configureHostLocalTrust({ origin: 'loopback-server', host: '127.0.0.1' })
    pluginManagerPresent = true

    const snapshot = await capabilities()
    expect(snapshot.terminal).toBe(hasTerminalHost())
    expect(snapshot.localFileSystem).toBe(isHostLocallyTrusted())
    expect(snapshot.pluginsManage).toBe(getPluginManager() !== null)

    // 反过来再问一次:三个判据一起翻面,三位必须一起翻。
    configureTerminalBroadcaster(null)
    resetHostLocalTrustForTests()
    pluginManagerPresent = false

    const flipped = await capabilities()
    expect(flipped.terminal).toBe(hasTerminalHost())
    expect(flipped.localFileSystem).toBe(isHostLocallyTrusted())
    expect(flipped.pluginsManage).toBe(getPluginManager() !== null)
    expect(flipped.terminal).toBe(false)
    expect(flipped.localFileSystem).toBe(false)
    expect(flipped.pluginsManage).toBe(false)
  })
})
