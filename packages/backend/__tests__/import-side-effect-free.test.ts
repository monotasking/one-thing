/**
 * Assembly-layer fence: importing @onething/backend modules must configure NOTHING.
 *
 * Before the createOnethingBackend factory existed, eleven modules wired
 * runtime adapters at import time. In a process that assembles its own
 * runtime (apps/server), merely importing those modules clobbered the host's
 * configuration (last-writer-wins). All wiring now happens exclusively
 * through configureAppRuntimeAdapters() / createOnethingBackend().
 */
import { describe, expect, it, vi } from 'vitest'

const spy = vi.hoisted(() => ({ calls: [] as string[] }))

vi.mock('@onething/backend/runtime/tools/sandbox-runtime', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configureOnethingToolSandboxRuntime: () => { spy.calls.push('sandbox') },
}))
vi.mock('@onething/backend/runtime/tools/background-jobs', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configureCoreBackgroundJobs: () => { spy.calls.push('background-jobs') },
}))
// P3'a-3:绑定件归位后从 `./scheduler.js` 直取(runtime 源码不自引用包名),所以
// 打在 barrel 上的桩够不着了 —— 换成打在**具体模块**上。barrel 的 `export *` 同样
// 解析到这一个 id,走 barrel 的调用方照旧拿到桩。
vi.mock('@onething/backend/runtime/scheduler/scheduler', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configureOnethingScheduler: () => { spy.calls.push('scheduler') },
}))
vi.mock('@onething/backend/runtime/files/ripgrep', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configureOnethingRipgrepRuntime: () => { spy.calls.push('ripgrep') },
}))
// 检索收口(2026-10-03)以后 `install-providers` 是检索入口的一部分,不再经入口取
// `configureOnethingSearchProviders`,所以桩打在入口的 `configureAppSearchProviders` 上:
// 照旧调真的那一份(它的闩还在起作用),只把「真正去装」那一步换成计数。
vi.mock('@onething/backend/runtime/search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@onething/backend/runtime/search')>()
  return {
    ...actual,
    configureAppSearchProviders: () => actual.configureAppSearchProviders(() => { spy.calls.push('search') }),
  }
})
vi.mock('@onething/backend/runtime/skills', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configureOnethingSkillManageRuntime: () => { spy.calls.push('skill-manage') },
  configureOnethingSkillsLoaderRuntime: () => { spy.calls.push('skills-loader') },
}))
vi.mock('@onething/backend/runtime/permissions', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configureOnethingPermissionGrantStorage: () => { spy.calls.push('permission-grants') },
}))
vi.mock('@onething/backend/runtime/providers/provider-table', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  initializeRegistry: () => { spy.calls.push('provider-registry') },
}))
vi.mock('../runtime/credentials/credentials-pool.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configureSpaceCredentialsCrypto: () => { spy.calls.push('space-credentials-crypto') },
  // 批 E:插件凭证策略的裁决口也是一个 configure*Host 端口,同归这道栅栏管。
  configureSpaceCredentialPluginStrategyHost: () => { spy.calls.push('credential-strategy-host') },
}))
vi.mock('@onething/backend/runtime/permissions/capabilities', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  registerBuiltinCapabilities: () => { spy.calls.push('capabilities') },
}))

// 包根归位 B(2026-10-03):会话表与设置仓储改成首次用到时才建,import 会话入口不再读设置、不再建仓储。
// 计数桩打在三个仓储 / 驱动的构造口与两条「要读设置 / 应用状态才会问」的路径函数上;都照旧调真的那一份。
const loadSpy = vi.hoisted(() => ({ calls: [] as string[] }))

vi.mock('../runtime/sessions/session-repository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@onething/backend/runtime/sessions')>()
  return {
    ...actual,
    createOnethingSessionRepository: ((options: never) => {
      loadSpy.calls.push('session-repository')
      return actual.createOnethingSessionRepository(options)
    }) as typeof actual.createOnethingSessionRepository,
  }
})
vi.mock('../runtime/sessions/storage-driver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@onething/backend/runtime/sessions')>()
  return {
    ...actual,
    createHybridSessionStorageDriver: ((options: never) => {
      loadSpy.calls.push('session-storage-driver')
      return actual.createHybridSessionStorageDriver(options)
    }) as typeof actual.createHybridSessionStorageDriver,
  }
})
// 包根归位 2:设置缓存搬进 `runtime/settings/` 以后按相对路径取构造口,桩因此打在定义它的那只模块上。
vi.mock('../runtime/settings/settings-repository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@onething/backend/runtime/settings')>()
  return {
    ...actual,
    createOnethingSettingsRepository: ((options: never) => {
      loadSpy.calls.push('settings-repository')
      return actual.createOnethingSettingsRepository(options)
    }) as typeof actual.createOnethingSettingsRepository,
  }
})
vi.mock('@onething/backend/runtime/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@onething/backend/runtime/storage')>()
  return {
    ...actual,
    getOnethingSettingsPath: () => {
      loadSpy.calls.push('settings-path')
      return actual.getOnethingSettingsPath()
    },
    getOnethingAppStatePath: () => {
      loadSpy.calls.push('app-state-path')
      return actual.getOnethingAppStatePath()
    },
  }
})

describe('@onething/backend import purity', () => {
  it('importing the formerly side-effectful modules configures nothing', { timeout: 60_000 }, async () => {
    await import('@onething/backend/runtime/tools/access-control/sandbox')
    await import('@onething/backend/runtime/tools/background-jobs-bound')
    await import('@onething/backend/runtime/tools/bash-executor')
    await import('../runtime/engine/engine-chat-facade.js')
    await import('@onething/backend/runtime/scheduler/scheduler-bound')
    await import('../utils/ripgrep.js')
    await import('@onething/backend/runtime/search')
    await import('@onething/backend/runtime/skills/manage-setup')
    await import('@onething/backend/runtime/skills/skill-sources')
    await import('@onething/backend/runtime/permissions/grant-storage')
    await import('../runtime/credentials/credentials-resolution.js')
    await import('../runtime/credentials/credentials-strategy.js')

    expect(spy.calls).toEqual([])
  })

  /**
   * K0 的注册基座同样归这道栅栏管(内核收缩,
   * docs/design/kernel-shrink-builtin-plugins-2026-08.md §1 D2)。
   *
   * 它比上面那批更容易在未来出事:`features/registry` 与 `rpc/index` 都在模块
   * 级持有表,而「顺手在模块级挂一个 feature」是个只要写一次就再也发现不了的
   * 错 —— 症状会是 apps/server 里 import 一下就把域注册了,与宿主自己的装配
   * 撞重复守卫。所以这里断言的是**表在 import 后是空的**。
   */
  it('importing the K0 feature base mounts nothing', { timeout: 60_000 }, async () => {
    const features = await import('../features/index.js')
    await import('../rpc/index.js')

    expect(features.dumpFeatures()).toEqual([])
  })

  /**
   * 会话入口交出会话表(`session-store.ts`)与会话组合根以后,import 它的模块在加载时都会带上会话表、设置与
   * 应用状态那几只模块。这道栅栏断言的是**带上不等于用上**:加载期不建会话仓储、不建存储驱动、不建设置仓储,
   * 也不去问设置 / 应用状态文件在哪。上面那条 `it` 已经连带加载过入口的话,这里照样数得到。
   */
  it('importing the sessions entry builds no repository and reads no settings', { timeout: 60_000 }, async () => {
    const sessions = await import('@onething/backend/runtime/sessions')
    // 包根归位 2(2026-10-03):设置仓储进了设置入口、接入目录进了文件入口,兼容桶 `store.ts` 两边都转发;一并 import。
    await import('@onething/backend/runtime/settings')
    await import('@onething/backend/runtime/files')
    await import('../store.js')

    expect(typeof sessions.getSession).toBe('function')
    expect(loadSpy.calls).toEqual([])
  })

  it('configureAppRuntimeAdapters wires every adapter exactly once', { timeout: 60_000 }, async () => {
    const { configureAppRuntimeAdapters } = await import('../backend.js')

    configureAppRuntimeAdapters()
    configureAppRuntimeAdapters()

    expect([...spy.calls].sort()).toEqual([
      'background-jobs',
      'capabilities',
      'credential-strategy-host',
      'permission-grants',
      'provider-registry',
      'ripgrep',
      'sandbox',
      'scheduler',
      'search',
      'skill-manage',
      'skills-loader',
      'space-credentials-crypto',
    ])
  })
})
