/**
 * 插件皮肤包的**装配接线**(H3)。
 *
 * 与 L2 的 `theme-overrides.ts` 逐条同构:
 *  - core 给全局规范顺序;
 *  - 产品层 `@onething/runtime/plugins/skin` 给纯裁决(旋钮/档位白名单 =
 *    `SKIN_TIER_VALUES`、后者胜、档位 → CSS 变量展开);
 *  - **这里**只做一件事:把"当前活着的插件清单"喂给裁决,给宿主一张可以直接
 *    递进 `applyTheme` 的档位表。
 *
 * 同样没有缓存,同样的理由:唯一数据源是插件管理器的**内存清单**,
 * enable/disable/install/uninstall 一改它就变;"缓存失效"最强的实现是没有缓存。
 */
import { getPluginManager } from './manager.js'
import {
  resolvePluginSkins,
  type PluginSkinEntry,
  type PluginSkinInput,
} from '@onething/runtime/plugins/skin'

export interface PluginSkinTable {
  /** 递给主题计算的那一份:旋钮 → 档位名(已裁决完冲突)。 */
  tiers: Record<string, string>
  /** 档位查表展开后的 CSS 变量(设置页明细用)。 */
  cssVariables: Record<string, string>
  /** 逐插件裁决明细(设置页卡片用)。 */
  byPlugin: Map<string, PluginSkinEntry[]>
}

const EMPTY_TABLE: PluginSkinTable = {
  tiers: {},
  cssVariables: {},
  byPlugin: new Map(),
}

/**
 * 从插件管理器读取皮肤声明。
 *
 * 只读 manifest —— **一行插件代码都不执行**(宪法第 3 条:声明先于代码)。
 * 启用闸门交给裁决层:停用的插件声明照样投影出来(卡片要看得见),但不参与合成。
 */
function collectSkinInputs(): PluginSkinInput[] {
  const manager = getPluginManager()
  if (!manager) return []
  return manager.getPlugins().map(plugin => ({
    pluginId: plugin.definition.id,
    enabled: plugin.definition.enabled,
    skin: plugin.definition.manifest.contributes?.theme?.skin,
  }))
}

/** 当前生效的插件皮肤表。插件系统没装配起来时是空表(而不是抛)。 */
export function getPluginSkinTable(): PluginSkinTable {
  const inputs = collectSkinInputs()
  if (!inputs.length) return EMPTY_TABLE
  return resolvePluginSkins(inputs)
}

/**
 * 宿主算主题时要递进去的那张档位表 —— **参数**,不是事后叠加。
 *
 * 递进 `applyTheme(themeId, mode, onDebug, tokenOverrides, skinTiers)`,皮肤变量
 * 就和主题变量在**同一张出口表**里下发,renderer 侧零改动(它只是消费下发的表)。
 *
 * 皮肤变量与主题变量是**不相交**的两组名字(`--skin-*` 前缀),所以这里不存在
 * L2 那个"叠在成品之后只盖得住原始变量"的陷阱:没有任何东西从 `--skin-*` 派生。
 * 反过来说,这也是为什么它可以安全地和主题表合并,而颜色覆盖必须前移到计算之内。
 *
 * 停用/卸载后表里就没有这条了,下一次下发 `:root` 自动回到组件 CSS 的兜底值 ——
 * 这就是拆除语义。
 */
export function getPluginSkinTiers(): Record<string, string> {
  return getPluginSkinTable().tiers
}
