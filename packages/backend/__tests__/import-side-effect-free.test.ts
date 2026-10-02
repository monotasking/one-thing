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
vi.mock('@onething/backend/runtime/search', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configureOnethingSearchProviders: () => { spy.calls.push('search') },
}))
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
vi.mock('@onething/backend/runtime/spaces/credentials', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configureSpaceCredentialsCrypto: () => { spy.calls.push('space-credentials-crypto') },
  // 批 E:插件凭证策略的裁决口也是一个 configure*Host 端口,同归这道栅栏管。
  configureSpaceCredentialPluginStrategyHost: () => { spy.calls.push('credential-strategy-host') },
}))
vi.mock('@onething/backend/runtime/permission/capabilities', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  registerBuiltinCapabilities: () => { spy.calls.push('capabilities') },
}))

describe('@onething/backend import purity', () => {
  it('importing the formerly side-effectful modules configures nothing', { timeout: 60_000 }, async () => {
    await import('@onething/backend/runtime/tools/core/sandbox')
    await import('@onething/backend/runtime/tools/background-jobs-bound')
    await import('@onething/backend/runtime/tools/bash-executor')
    await import('@onething/backend/runtime/providers/chat-facade')
    await import('@onething/backend/runtime/scheduler/scheduler-bound')
    await import('../utils/ripgrep.js')
    await import('@onething/backend/runtime/search/install-providers')
    await import('@onething/backend/runtime/skills/manage-setup')
    await import('@onething/backend/runtime/skills/skill-sources')
    await import('@onething/backend/runtime/permission/grant-storage')
    await import('@onething/backend/runtime/providers/space-credentials')
    await import('@onething/backend/runtime/providers/credential-strategy')

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
