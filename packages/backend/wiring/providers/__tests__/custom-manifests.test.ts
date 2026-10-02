/**
 * 批 M:自定义服务商按设置进出 manifest 注册表(`wiring/providers/custom-manifests.ts`)。
 * 默认空间的生效设置 ∪ 每个空间的 `providers.json`;内容没变不动,变了先卸再登,
 * 不见了的卸掉,撞内置 id 的跳过;`settings:changed` 触发重同步;`dispose()` 卸干净。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  global: [] as unknown[],
  spaces: {} as Record<string, unknown[]>,
}))

vi.mock('../../../stores/settings.js', () => ({
  getSettings: () => ({ ai: { customProviders: state.global } }),
}))
vi.mock('@onething/backend/runtime/spaces/store', () => ({
  getSpacesStore: () => ({ list: () => Object.keys(state.spaces).filter((id) => id !== 'default').map((id) => ({ id })) }),
}))
vi.mock('@onething/backend/runtime/spaces/provider-settings', () => ({
  readSpaceProviderSettings: (spaceId: string) =>
    state.spaces[spaceId] ? { provider: '', providers: {}, customProviders: state.spaces[spaceId] } : null,
}))

import { getProviderManifest, resetProviderManifestRegistryForTests } from '@onething/backend/runtime/providers/manifest'
import { CustomProviderManifestSync } from '../custom-manifests.js'
import { getDialect } from '@onething/backend/runtime/agent-loop/providers/base/dialect'
import {
  broadcastSettingsChanged,
  configureSettingsEventBroadcaster,
  getSettingsEventBroadcaster,
} from '@onething/backend/runtime/settings/events'

afterEach(() => {
  state.global = []
  state.spaces = {}
  configureSettingsEventBroadcaster(null)
  resetProviderManifestRegistryForTests()
})

describe('CustomProviderManifestSync', () => {
  it('registers custom providers from the default settings and every space', () => {
    state.global = [{ id: 'custom-a', name: 'A', apiType: 'anthropic' }]
    state.spaces = { work: [{ id: 'custom-b', name: 'B' }, { id: 'custom-a', name: 'shadowed' }] }
    const sync = new CustomProviderManifestSync()
    sync.sync()
    expect(sync.registeredIds().sort()).toEqual(['custom-a', 'custom-b'])
    expect(getProviderManifest('custom-a')).toMatchObject({ origin: 'custom', name: 'A', dialect: 'custom-anthropic' })
    expect(getProviderManifest('custom-b')).toMatchObject({ origin: 'custom', dialect: 'custom-openai' })
    sync.dispose()
    expect(getProviderManifest('custom-a')).toBeUndefined()
  })

  it('keeps an unchanged entry, replaces a changed one, drops a removed one', () => {
    state.global = [{ id: 'custom-a', name: 'A' }, { id: 'custom-b', name: 'B' }]
    const sync = new CustomProviderManifestSync()
    sync.sync()
    const before = getProviderManifest('custom-a')

    state.global = [{ id: 'custom-a', name: 'A' }, { id: 'custom-c', name: 'C', dialect: 'openrouter' }]
    sync.sync()
    expect(getProviderManifest('custom-a')).toBe(before)
    expect(getProviderManifest('custom-b')).toBeUndefined()
    expect(getProviderManifest('custom-c')).toMatchObject({ dialect: 'openrouter' })

    state.global = [{ id: 'custom-a', name: 'A2' }, { id: 'custom-c', name: 'C', dialect: 'openrouter' }]
    sync.sync()
    expect(getProviderManifest('custom-a')).toMatchObject({ name: 'A2' })
    sync.dispose()
  })

  it('never lets a custom entry shadow a builtin', () => {
    state.global = [{ id: 'codex', name: 'fake codex' }]
    const sync = new CustomProviderManifestSync()
    sync.sync()
    expect(sync.registeredIds()).toEqual([])
    expect(getProviderManifest('codex')).toMatchObject({ origin: 'builtin', name: 'Codex' })
  })

  it('re-syncs on settings:changed, chained after the host broadcaster, and restores it', () => {
    const host = vi.fn()
    configureSettingsEventBroadcaster(host)
    const sync = new CustomProviderManifestSync()
    const unwatch = sync.watchSettingsChanged()
    state.global = [{ id: 'custom-live', name: 'Live' }]
    broadcastSettingsChanged({} as never)
    expect(host).toHaveBeenCalledTimes(1)
    expect(getProviderManifest('custom-live')).toBeDefined()
    unwatch()
    expect(getSettingsEventBroadcaster()).toBe(host)
    sync.dispose()
  })

  it('batch 4: an applied adapter registers custom:<id> and the manifest points at it', () => {
    const adapter = {
      version: 1,
      wire: 'openai-chat',
      response: { reasoningDeltaPath: 'choices[0].delta.reasoning' },
    }
    state.global = [{ id: 'custom-relay', name: 'Relay', dialect: 'custom-openai', adapter }]
    const sync = new CustomProviderManifestSync()
    sync.sync()
    expect(getProviderManifest('custom-relay')).toMatchObject({ dialect: 'custom:custom-relay', modelRules: 'openai' })
    const first = getDialect('custom:custom-relay')
    expect(first?.wire).toBe('openai-chat')

    // 同一张表:不动
    sync.sync()
    expect(getDialect('custom:custom-relay')).toBe(first)

    // 表变了:换一份
    state.global = [{ id: 'custom-relay', name: 'Relay', dialect: 'custom-openai', adapter: { ...adapter, response: { reasoningDeltaPath: 'choices[0].delta.thinking' } } }]
    sync.sync()
    expect(getDialect('custom:custom-relay')).not.toBe(first)

    // 表撤了:方言跟着撤,manifest 回到接口类型那一份
    state.global = [{ id: 'custom-relay', name: 'Relay', dialect: 'custom-openai' }]
    sync.sync()
    expect(getDialect('custom:custom-relay')).toBeUndefined()
    expect(getProviderManifest('custom-relay')).toMatchObject({ dialect: 'custom-openai' })

    state.global = [{ id: 'custom-relay', name: 'Relay', adapter }]
    sync.sync()
    sync.dispose()
    expect(getDialect('custom:custom-relay')).toBeUndefined()
  })

  it('batch 4: a malformed adapter is ignored (old path, no error)', () => {
    state.global = [{ id: 'custom-x', name: 'X', adapter: { version: 2, wire: 'openai-chat' } }]
    const sync = new CustomProviderManifestSync()
    sync.sync()
    expect(getProviderManifest('custom-x')).toMatchObject({ dialect: 'custom-openai' })
    expect(getDialect('custom:custom-x')).toBeUndefined()
    sync.dispose()
  })
})
