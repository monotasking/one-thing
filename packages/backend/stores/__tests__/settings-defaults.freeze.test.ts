/**
 * 出厂设置的行为冻结(服务商自述试点 P3,`docs/design/architecture-direction-2026-10.md` §4)。
 *
 * 默认 provider 配置从前是 `@shared/defaults/settings.ts` 里一张按家点名的大表;P3 把每家那一条
 * 逐字搬进各家 manifest 的 `seed`,由装配层按名册拼回来。这份测试在搬家**之前**录下旧实现的
 * 答案(`__fixtures__/settings-defaults.frozen.json`),搬完之后逐字比对 —— 连 `ai.providers`
 * 的键序一起比(读设置的代码里有按键序取第一家的,键序也是行为)。
 *
 * 冻结文件不许重录:它是搬家前的证据,不是「当前输出」。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createDefaultSettings, mergeWithDefaults } from '../settings-defaults.js'
import type { AppSettings } from '@shared/ipc.js'
import { SETTINGS_DEFAULTS_FREEZE_INPUTS } from './__fixtures__/settings-defaults-inputs.js'

const frozen = JSON.parse(
  readFileSync(new URL('./__fixtures__/settings-defaults.frozen.json', import.meta.url), 'utf8'),
) as { createDefault: unknown; merge: Record<string, unknown> }

/** 逐字比:`JSON.stringify` 保留键序,`toEqual` 不管键序。 */
function verbatim(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

describe('出厂设置的 ai 段与搬家前逐字相同', () => {
  it('createDefaultSettings().ai(含 providers 键序)', () => {
    expect(verbatim(createDefaultSettings().ai)).toBe(verbatim(frozen.createDefault))
  })

  for (const [label, input] of Object.entries(SETTINGS_DEFAULTS_FREEZE_INPUTS)) {
    it(`mergeWithDefaults(${label}).ai`, () => {
      const merged = mergeWithDefaults(structuredClone(input) as Partial<AppSettings>)
      expect(verbatim(merged.ai)).toBe(verbatim(frozen.merge[label]))
    })
  }

  it('两次 createDefaultSettings() 不共享对象(多租户树上的跨用户泄漏防线)', () => {
    const first = createDefaultSettings()
    const second = createDefaultSettings()
    expect(first.ai.providers).not.toBe(second.ai.providers)
    expect(first.ai.providers.custom).not.toBe(second.ai.providers.custom)
  })
})
