/**
 * Assembly-layer fence: importing src/app modules must configure NOTHING.
 *
 * Before the createOnethingBackend factory existed, eleven modules wired
 * runtime adapters at import time. In a process that assembles its own
 * runtime (apps/server), merely importing those modules clobbered the host's
 * configuration (last-writer-wins). All wiring now happens exclusively
 * through configureAppRuntimeAdapters() / createOnethingBackend().
 */
import { describe, expect, it, vi } from 'vitest'

const spy = vi.hoisted(() => ({ calls: [] as string[] }))

vi.mock('@onething/runtime/tools/sandbox-runtime', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configureOnethingToolSandboxRuntime: () => { spy.calls.push('sandbox') },
}))
vi.mock('@onething/runtime/tools/background-jobs', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configureCoreBackgroundJobs: () => { spy.calls.push('background-jobs') },
}))
vi.mock('@onething/runtime/scheduler', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configureOnethingScheduler: () => { spy.calls.push('scheduler') },
}))
vi.mock('@onething/runtime/files/ripgrep', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configureOnethingRipgrepRuntime: () => { spy.calls.push('ripgrep') },
}))
vi.mock('@onething/runtime/search', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configureOnethingSearchProviders: () => { spy.calls.push('search') },
}))
vi.mock('@onething/runtime/skills', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configureOnethingSkillManageRuntime: () => { spy.calls.push('skill-manage') },
  configureOnethingSkillsLoaderRuntime: () => { spy.calls.push('skills-loader') },
}))
vi.mock('@onething/runtime/permissions', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configureOnethingPermissionGrantStorage: () => { spy.calls.push('permission-grants') },
}))
vi.mock('../providers/registry.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  initializeRegistry: () => { spy.calls.push('provider-registry') },
}))
vi.mock('@onething/runtime/spaces/credentials', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configureSpaceCredentialsCrypto: () => { spy.calls.push('space-credentials-crypto') },
  // 批 E:插件凭证策略的裁决口也是一个 configure*Host 端口,同归这道栅栏管。
  configureSpaceCredentialPluginStrategyHost: () => { spy.calls.push('credential-strategy-host') },
}))
vi.mock('../permission/capabilities.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  registerBuiltinCapabilities: () => { spy.calls.push('capabilities') },
}))

describe('src/app import purity', () => {
  it('importing the formerly side-effectful modules configures nothing', { timeout: 60_000 }, async () => {
    await import('../tools/core/sandbox.js')
    await import('@onething/runtime/tools/background-jobs-bound')
    await import('@onething/runtime/tools/bash-executor')
    await import('../providers/index.js')
    await import('../scheduler/index.js')
    await import('../utils/ripgrep.js')
    await import('../search/providers.js')
    await import('../skills/manage.js')
    await import('../skills/loader.js')
    await import('../permission/permission-grants.js')
    await import('../providers/space-credentials.js')
    await import('../providers/credential-strategy.js')

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
