/**
 * 出厂种子(各家 manifest 的 `seed`,服务商自述试点 P3)的两条结构约束。
 * 值与键序的逐字证据在 `packages/backend/stores/__tests__/settings-defaults.freeze.test.ts`。
 */
import { describe, expect, it } from 'vitest'
import { VENDOR_MANIFESTS, VENDOR_SEED_ORDER } from '../vendors/manifests.js'

describe('出厂种子的名册', () => {
  it('VENDOR_SEED_ORDER 恰好是名册里每一家各一次(只是换了键序)', () => {
    expect(VENDOR_SEED_ORDER).toHaveLength(VENDOR_MANIFESTS.length)
    expect(new Set(VENDOR_SEED_ORDER).size).toBe(VENDOR_SEED_ORDER.length)
    for (const manifest of VENDOR_MANIFESTS) expect(VENDOR_SEED_ORDER).toContain(manifest)
  })

  it('有 seed 的家排在没有 seed 的家前面(拼表时跳过的只在末尾)', () => {
    const firstWithout = VENDOR_SEED_ORDER.findIndex((manifest) => !manifest.seed)
    if (firstWithout === -1) return
    expect(VENDOR_SEED_ORDER.slice(firstWithout).every((manifest) => !manifest.seed)).toBe(true)
  })
})
