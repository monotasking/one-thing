/**
 * 装配层这一侧的「生效 AI 设置」接缝(C2)。
 *
 * 纯合成/拆分的两个函数住在 `@shared/defaults/ai-settings` —— 渲染层的设置页要
 * 做**同样的**拆分,两处各写一份的第一天不会有人发现,第一百天没人解释得清为什么
 * 设置页存下去的东西引擎读不到。这里只加装配层才知道的两件事:
 *
 * 1. 迁移标记(它住在 `settings.storage` 里);
 * 2. 「这个空间还没有 providers.json」时该怎么办 —— 迁移之前原样返回旧形状,
 *    迁移之后就是「这个空间是空的」(**无回落**)。
 *
 * 设计见 `docs/design/workspace-provider-config-review-2026-08-18.md` §7 / C2。
 */

import type { AppSettings, PersistedAppSettings } from '@shared/ipc.js'
import {
  composeEffectiveAISettings,
  createEmptySpaceProviderSettings,
  splitEffectiveAISettings,
} from '@shared/defaults/ai-settings.js'
import type { SpaceProviderSettings } from '@onething/runtime/spaces/provider-settings'

export { composeEffectiveAISettings, createEmptySpaceProviderSettings, splitEffectiveAISettings }

/** 这份 settings 跑过 C2 的整体搬迁没有。 */
export function hasSpaceProviderSettingsMigrated(
  settings: { storage?: { spaceProviderSettingsMigratedAt?: number } } | undefined,
): boolean {
  return typeof settings?.storage?.spaceProviderSettingsMigratedAt === 'number'
}

/**
 * 持久化形状 + 某个空间的 providers.json → 消费者手里的 `AppSettings`。
 *
 * `space === null` 且**迁移标记不在** = 这台机器还没迁移,原样返回旧形状
 * (装配序列第 2 步就会把它迁走)。标记在而文件不在 = 这个空间就是空的
 * (无回落:C2 之后没有「缺席落回全局」这一档)。
 */
export function resolveEffectiveAppSettings(
  persisted: AppSettings | PersistedAppSettings,
  space: SpaceProviderSettings | null,
): AppSettings {
  const raw = persisted as AppSettings
  if (space === null && !hasSpaceProviderSettingsMigrated(persisted)) return raw
  return {
    ...raw,
    ai: composeEffectiveAISettings(
      raw.ai,
      (space ?? createEmptySpaceProviderSettings()) as never,
    ),
  }
}
