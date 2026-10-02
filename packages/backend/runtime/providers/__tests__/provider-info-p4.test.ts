/**
 * `providerInfoOfManifest` 在 P4 多投的三格(服务商自述试点 P4)。
 *
 * 三格的**值**各有等价证据(档位 / 家族各一份 equivalence 测试);这里钉的是「有才出现」与
 * `hasQuota` 的判据 —— 壳从前读 manifest 的 `quotaSource` 在不在(`Boolean(quotaSource)`),
 * 下发之后必须是同一句话,不能悄悄换成「注册表里真有这个源」之类更严的判据。
 */
import { describe, expect, it } from 'vitest'
import { BUILTIN_PROVIDER_MANIFESTS, builtinProviderFamilyInfoOf } from '../builtin-manifests.js'
import { providerInfoOfManifest } from '../builtin-providers.js'
import { dialDescriptorOf } from '../dials.js'

describe('providerInfoOfManifest · P4 三格', () => {
  for (const manifest of BUILTIN_PROVIDER_MANIFESTS) {
    it(manifest.id, () => {
      const info = providerInfoOfManifest(manifest)
      expect(info.hasQuota === true).toBe(Boolean(manifest.quotaSource))
      expect('hasQuota' in info).toBe(Boolean(manifest.quotaSource))
      expect(info.dials).toEqual(manifest.dials ? dialDescriptorOf(manifest.dials) : undefined)
      expect('dials' in info).toBe(Boolean(manifest.dials))
      expect(info.family).toEqual(builtinProviderFamilyInfoOf(manifest.id))
      expect('family' in info).toBe(Boolean(manifest.sibling))
    })
  }
})
