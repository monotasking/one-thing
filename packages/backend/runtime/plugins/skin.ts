/**
 * 插件皮肤包的**裁决层**(H3)。
 *
 * 与 L2(`theme-overrides.ts`)逐条同构 —— 同一套治理照抄,不发明第二套规矩:
 *  - 键必须 ∈ `SKIN_TIER_VALUES` 的旋钮集合(**白名单就是那张表本身**);
 *  - 值必须 ∈ 该旋钮开放的档位集合(枚举,不是自由字符串);
 *  - 冲突按**全局规范顺序后者胜**(core 的 `comparePluginCanonicalOrder`,
 *    与锚点块排列、token 覆盖同一出处);
 *  - 非法条目**不拒载**,只是被标成 `invalid` 让设置页说得出来。
 *
 * 与 L2 的唯一实质差别在安全面:L2 收的是颜色**字符串**(需要字面量白名单挡注入),
 * H3 收的是**档位名**,CSS 值由宿主查表得到 —— 插件递进来的字符串永远不会出现在
 * CSS 里,所以这里没有、也不需要任何"值的消毒"。
 */
import { comparePluginCanonicalOrder } from '@onething/backend/core/plugins'
import {
  SKIN_TIER_VALUES,
  SKIN_VAR_MAP,
  generateSkinVariables,
  isSkinKnob,
  isSkinTier,
  type SkinKnob,
} from '../themes/skin.js'

/** 一条皮肤声明在裁决后的状态(与 `PluginThemeOverrideStatus` 同一套词)。 */
export type PluginSkinStatus =
  /** 生效中:这一档此刻正写在 `:root` 上(或正是缺省档,即"保持现状")。 */
  | 'active'
  /** 被更后者压过:合法,但同一旋钮有个规范顺序更靠后的插件也选了档。 */
  | 'shadowed'
  /** 插件未启用:声明还在,但不参与合成。 */
  | 'inactive'
  /** 旋钮不认识 / 档位在枚举外 —— 丢弃该键。 */
  | 'invalid'

export type PluginSkinInvalidReason = 'unknown-knob' | 'unknown-tier'

export interface PluginSkinEntry {
  knob: string
  tier: string
  status: PluginSkinStatus
  /** status === 'invalid' 时的逐条原因。 */
  reason?: PluginSkinInvalidReason
  /** status === 'shadowed' 时压过它的那个插件 id。 */
  shadowedBy?: string
}

export interface PluginSkinInput {
  pluginId: string
  enabled: boolean
  skin?: Record<string, string>
}

export interface PluginSkinResolution {
  /** 逐插件的裁决结果(键 = pluginId,顺序即声明顺序)。 */
  byPlugin: Map<string, PluginSkinEntry[]>
  /** 裁决后"谁生效"的扁平表:旋钮 → 档位名。这一份递给 `applyTheme`。 */
  tiers: Record<string, string>
  /**
   * `tiers` 查表展开后的 CSS 变量 —— 说明性投影(设置页明细)。
   *
   * 缺省档不产出任何变量(它的语义就是"不写"),所以这张表可能比 `tiers` 短。
   */
  cssVariables: Record<string, string>
}

/** 旋钮合法性:白名单就是档位表本身,不新增旋钮。 */
export function isPluginSkinKnob(knob: string): boolean {
  return isSkinKnob(knob)
}

/** 档位合法性:必须是该旋钮开放的枚举值之一。 */
export function isPluginSkinTier(knob: string, tier: unknown): boolean {
  if (!isSkinKnob(knob)) return false
  return typeof tier === 'string' && isSkinTier(knob, tier)
}

/**
 * 裁决一组插件的皮肤声明。
 *
 * 顺序语义与 L2 一字不差:先按全局规范顺序排,再顺序写入 —— 后写的赢。被赢掉的
 * 那条标 `shadowed` 并记下赢家,设置页据此说"你的档位被谁压了"。
 */
export function resolvePluginSkins(
  inputs: readonly PluginSkinInput[],
): PluginSkinResolution {
  const ordered = [...inputs].sort((a, b) => comparePluginCanonicalOrder(a.pluginId, b.pluginId))

  const byPlugin = new Map<string, PluginSkinEntry[]>()
  /** 旋钮 → 当前赢家,用来回填 shadowed。 */
  const winners = new Map<string, { pluginId: string; entry: PluginSkinEntry }>()
  const resolvedTiers: Record<string, string> = {}

  for (const input of ordered) {
    const entries: PluginSkinEntry[] = []
    for (const [knob, rawTier] of Object.entries(input.skin ?? {})) {
      if (!isPluginSkinKnob(knob)) {
        entries.push({ knob, tier: String(rawTier), status: 'invalid', reason: 'unknown-knob' })
        continue
      }
      if (!isPluginSkinTier(knob, rawTier)) {
        entries.push({ knob, tier: String(rawTier), status: 'invalid', reason: 'unknown-tier' })
        continue
      }
      const tier = rawTier as string
      if (!input.enabled) {
        // 停用的插件声明照样可见(卡片要能说"它会改什么"),但不参与合成,
        // 也不参与冲突裁决 —— 否则关掉一个插件会改变另一个插件的呈现状态。
        entries.push({ knob, tier, status: 'inactive' })
        continue
      }
      const entry: PluginSkinEntry = { knob, tier, status: 'active' }
      const previous = winners.get(knob)
      if (previous) {
        previous.entry.status = 'shadowed'
        previous.entry.shadowedBy = input.pluginId
      }
      winners.set(knob, { pluginId: input.pluginId, entry })
      resolvedTiers[knob] = tier
      entries.push(entry)
    }
    byPlugin.set(input.pluginId, entries)
  }

  return { byPlugin, tiers: resolvedTiers, cssVariables: generateSkinVariables(resolvedTiers) }
}

/** 设置页要念的档位表:旋钮 → 开放档位(顺序即声明顺序)。 */
export function listPluginSkinKnobs(): Array<{ knob: SkinKnob; tiers: string[]; cssVar: string }> {
  return (Object.keys(SKIN_TIER_VALUES) as SkinKnob[]).map(knob => ({
    knob,
    tiers: Object.keys(SKIN_TIER_VALUES[knob]),
    cssVar: SKIN_VAR_MAP[knob],
  }))
}
