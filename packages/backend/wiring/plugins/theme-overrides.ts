/**
 * 插件主题 token 覆盖的**装配接线**(B 期,L2)。
 *
 * 分工:
 *  - core 给安全判据(颜色白名单)与全局规范顺序;
 *  - 产品层 `@onething/runtime/plugins/theme-overrides` 给纯裁决(键白名单 =
 *    `CSS_VAR_MAP`、后者胜、token → CSS 变量展开);
 *  - **这里**只做一件事:把"当前活着的插件清单"喂给裁决,给宿主一张可以直接
 *    叠在主题产出之上的变量表。
 *
 * 为什么没有缓存:唯一的数据源是插件管理器的**内存清单**(`getPlugins()`),
 * enable/disable/install/uninstall 一改它就变。再缓存一层等于给自己造一个需要
 * 失效的副本 —— 而合成只发生在 applyTheme 这种低频调用上,重算一次是几十条
 * manifest 的遍历。"缓存失效"最强的实现是没有缓存。
 */
import { getPluginManager } from './manager.js'
import {
  resolvePluginThemeOverrides,
  type PluginThemeOverrideEntry,
  type PluginThemeOverrideInput,
} from '@onething/runtime/plugins/theme-overrides'

export interface PluginThemeOverrideTable {
  /** 喂给主题计算的那一份:主题 token 路径 → 颜色字面量(已裁决完冲突)。 */
  tokenValues: Record<string, string>
  /** token 展开成原始 CSS 变量名后的说明性投影(设置页明细用,别拿去叠产出)。 */
  cssVariables: Record<string, string>
  /** 表面旋钮(`--ot-*`)→ 已钳制的值。这一份**可以**直接叠在主题产出上,见下。 */
  knobVariables: Record<string, string>
  /** 逐插件裁决明细(设置页卡片用)。 */
  byPlugin: Map<string, PluginThemeOverrideEntry[]>
}

const EMPTY_TABLE: PluginThemeOverrideTable = {
  tokenValues: {},
  cssVariables: {},
  knobVariables: {},
  byPlugin: new Map(),
}

/**
 * 从插件管理器读取覆盖声明。
 *
 * 只读 manifest —— **一行插件代码都不执行**(宪法第 3 条:声明先于代码)。
 * 启用闸门交给裁决层:停用的插件声明照样投影出来(卡片要看得见),
 * 但不参与合成。
 */
function collectThemeOverrideInputs(): PluginThemeOverrideInput[] {
  const manager = getPluginManager()
  if (!manager) return []
  return manager.getPlugins().map(plugin => ({
    pluginId: plugin.definition.id,
    enabled: plugin.definition.enabled,
    overrides: plugin.definition.manifest.contributes?.theme?.overrides,
  }))
}

/** 当前生效的插件主题覆盖表。插件系统没装配起来时是空表(而不是抛)。 */
export function getPluginThemeOverrideTable(): PluginThemeOverrideTable {
  const inputs = collectThemeOverrideInputs()
  if (!inputs.length) return EMPTY_TABLE
  return resolvePluginThemeOverrides(inputs)
}

/**
 * 宿主算主题时要递进去的那张覆盖表 —— **参数**,不是事后叠加。
 *
 * 递进 `applyTheme(themeId, mode, tokenValues)`,覆盖就在 `resolveThemeUI` /
 * `generateCSSVariables` 之前落位,ui 语义层、-rgb 变体、primary 色阶全部按
 * 覆盖色重新派生。曾经的做法是拿到响应再往 cssVariables 上 spread —— 那只盖得住
 * 原始变量,派生层整片留在旧色上,真机上肉眼几乎无感。
 *
 * 主题切换天然保留:每次算主题都重新问一次这张表,不需要任何"记住覆盖"的状态。
 * 停用/卸载后表里就没有这条了,下一次下发 `:root` 自动回到主题原值 —— 这就是
 * 拆除语义。
 */
export function getPluginThemeOverrideTokenValues(): Record<string, string> {
  return getPluginThemeOverrideTable().tokenValues
}

/**
 * 宿主要叠在主题产出**之上**的那张旋钮表(批 3b)。
 *
 * 为什么这一份反过来是"事后叠加"而不是"参数前移" —— 与颜色覆盖的判据是同一条,
 * 只是结论相反:颜色必须前移,因为 `--ui-*` 语义层、`-rgb` 变体、primary 色阶全都
 * **从**它派生,叠在成品之后只盖得住原始变量;旋钮**没有任何东西从它派生**,主题
 * 计算里根本不读它,它是 CSS 绘制时才求值的一个数。所以它与 `--skin-*` 同构
 * (那边也是叠加,理由逐字相同),而且这条路让整块能力落在**干净文件**里 ——
 * `applyTheme` 的签名住在 `themes/index.ts`,那份文件在用户未提交名单里,不能碰。
 *
 * 覆盖强度:主题变量下发走 `documentElement.style.setProperty`(行内样式),压得住
 * `wallpaper.css` 里 `html.has-wallpaper` 那几条同元素声明 —— 也就是说插件拨的数
 * **压过宿主自己的壁纸缺省档**。这正是"旋转多少交由插件"的字面意思。
 * 另注:旋钮不是壁纸专属的。壁纸只是宿主自己的一次拨动;插件拨了,壁纸没开时
 * 同样生效(态 token 的公式一直在读 `var(--ot-state-alpha, 100%)`)。
 *
 * 停用/卸载后表里就没有这条了,下一次下发 `:root` 自动回到 CSS 里的缺省 —— 这就是
 * 拆除语义。
 */
export function getPluginThemeKnobVariables(): Record<string, string> {
  return getPluginThemeOverrideTable().knobVariables
}
