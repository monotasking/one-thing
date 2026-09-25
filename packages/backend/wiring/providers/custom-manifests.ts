/**
 * 自定义服务商进 manifest 注册表(批 M,`docs/design/provider-settings-rework-2026-09.md` §5.2)。
 *
 * 内置 16 家在 runtime 模块加载时就登记好了;自定义的住在设置里(每个空间一份
 * `providers.json` 的 `customProviders[]`,默认空间的生效设置也算),所以由装配层
 * 在读完设置之后逐个 `register`,并在两种「设置变了」的时刻重同步:
 *  - `settings:changed`(保存全局 / 默认空间设置);
 *  - `spaces.setProviderSettings`(某个空间的 provider 设置整份写回)—— 那条写路
 *    不发 `settings:changed`,所以由域处理者直接喊一声 `sync()`。
 *
 * 同步是**比对式**的:内容没变的条目不动(卸载函数与注册表里的对象都不换),变了
 * 的先卸再登,不见了的卸掉。内置 id 被自定义条目撞上时内置的赢(跳过并记一行)。
 *
 * 状态住在实例上(`OnethingBackend.providerManifests`),`dispose()` 卸干净 ——
 * 与 `assembly:gate` 同一句话:装配期的状态不住模块槽。
 */
import {
  getProviderManifestRegistry,
  manifestOfCustomProvider,
  type CustomProviderManifestSource,
  type ProviderManifest,
} from '@onething/runtime/providers/manifest'
import { readSpaceProviderSettings } from '@onething/runtime/spaces/provider-settings'
import { getSpacesStore } from '@onething/runtime/spaces/store'
import { DEFAULT_SPACE_ID } from '@onething/runtime/spaces/types'
import { getSettings } from '../../stores/settings.js'
import {
  configureSettingsEventBroadcaster,
  getSettingsEventBroadcaster,
  type SettingsEventBroadcaster,
} from '../settings/events.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('providers.manifests')

interface RegisteredCustom {
  fingerprint: string
  unregister: () => void
}

function sourceOf(raw: unknown): CustomProviderManifestSource | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!id) return null
  const text = (key: string): string | undefined =>
    typeof record[key] === 'string' ? (record[key] as string) : undefined
  const apiType = record.apiType === 'anthropic' || record.apiType === 'openai' ? record.apiType : undefined
  return {
    id,
    ...(text('name') !== undefined ? { name: text('name') } : {}),
    ...(text('description') !== undefined ? { description: text('description') } : {}),
    ...(apiType ? { apiType } : {}),
    ...(text('dialect') ? { dialect: text('dialect') } : {}),
    ...(text('baseUrl') !== undefined ? { baseUrl: text('baseUrl') } : {}),
    ...(text('model') !== undefined ? { model: text('model') } : {}),
  }
}

/** 整台机器上的自定义服务商:默认空间的生效设置 ∪ 每个空间的 `providers.json`。先见者赢。 */
function collectCustomProviders(): CustomProviderManifestSource[] {
  const lists: unknown[][] = [
    (getSettings()?.ai as { customProviders?: unknown[] } | undefined)?.customProviders ?? [],
  ]
  const spaceIds = new Set<string>([DEFAULT_SPACE_ID])
  for (const space of getSpacesStore().list()) spaceIds.add(space.id)
  for (const spaceId of spaceIds) {
    lists.push(readSpaceProviderSettings(spaceId)?.customProviders ?? [])
  }
  const seen = new Map<string, CustomProviderManifestSource>()
  for (const list of lists) {
    for (const raw of list) {
      const source = sourceOf(raw)
      if (source && !seen.has(source.id)) seen.set(source.id, source)
    }
  }
  return [...seen.values()]
}

function fingerprintOf(manifest: ProviderManifest): string {
  return JSON.stringify(manifest)
}

export class CustomProviderManifestSync {
  private readonly registered = new Map<string, RegisteredCustom>()
  private disposed = false

  /** 按当前设置对齐注册表。幂等;任何一条坏数据只跳过那一条。 */
  sync(): void {
    if (this.disposed) return
    const registry = getProviderManifestRegistry()
    const next = new Map<string, ProviderManifest>()
    let sources: CustomProviderManifestSource[]
    try {
      sources = collectCustomProviders()
    } catch (error) {
      log.warn('reading custom providers failed; keeping the current manifests', {}, error)
      return
    }
    for (const source of sources) {
      const existing = registry.get(source.id)
      if (existing && existing.origin !== 'custom') {
        log.warn('custom provider id collides with a builtin provider; skipped', { providerId: source.id })
        continue
      }
      next.set(source.id, manifestOfCustomProvider(source))
    }

    for (const [id, entry] of this.registered) {
      const manifest = next.get(id)
      if (manifest && fingerprintOf(manifest) === entry.fingerprint) continue
      entry.unregister()
      this.registered.delete(id)
    }
    for (const [id, manifest] of next) {
      if (this.registered.has(id)) continue
      try {
        this.registered.set(id, {
          fingerprint: fingerprintOf(manifest),
          unregister: registry.register(manifest),
        })
      } catch (error) {
        log.warn('registering a custom provider manifest failed', { providerId: id }, error)
      }
    }
  }

  /** 订「设置刚保存过」。串联进单槽广播端口,还原带身份守卫(与 pets / search 同一判例)。 */
  watchSettingsChanged(): () => void {
    const previous = getSettingsEventBroadcaster()
    const ours: SettingsEventBroadcaster = event => {
      previous?.(event)
      try {
        this.sync()
      } catch (error) {
        log.warn('custom provider manifest sync failed', {}, error)
      }
    }
    configureSettingsEventBroadcaster(ours)
    return () => {
      if (getSettingsEventBroadcaster() !== ours) return
      configureSettingsEventBroadcaster(previous)
    }
  }

  /** 卸掉本实例登记过的每一条。之后 `sync()` 是 no-op。 */
  dispose(): void {
    this.disposed = true
    for (const entry of this.registered.values()) entry.unregister()
    this.registered.clear()
  }

  /** 测试用:当前由本实例登记着的 id。 */
  registeredIds(): string[] {
    return [...this.registered.keys()]
  }
}
