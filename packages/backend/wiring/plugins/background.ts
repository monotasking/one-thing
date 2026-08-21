/**
 * 插件背景层的**装配接线**(G 期,L2.5)。
 *
 * 分工与 B 期的 theme-overrides 逐字同构:
 *  - core 给判据与裁决(`resolvePluginBackgrounds`:路径白名单、钳制、
 *    全局规范顺序后者胜);
 *  - **这里**只做两件事:把"当前活着的插件清单"喂给裁决,以及守住
 *    `api.theme.updateBackground` 写下来的那点**内存态**。
 *
 * 为什么运行期参数只在内存里:重启后回 manifest 缺省是**有意的**。
 * 持久化归插件自己 —— 它在 entry 启动时读一次 `api.settings.get()`(R3 配置,
 * 宿主已经替它落盘、校验、填默认值)再调一次 updateBackground 就行。
 * 宿主替插件记住一份"上次调到哪"等于凭空多出第二份事实源,而这份事实源
 * 既不在 manifest 里、也不在插件的配置里,卸载时还得单独扫一遍。
 *
 * 同样没有缓存:唯一数据源是插件管理器的内存清单,enable/disable/install/
 * uninstall 一改它就变。"缓存失效"最强的实现是没有缓存。
 */
import { getPluginManager } from './manager.js'
import {
  resolvePluginBackgrounds,
  type PluginBackgroundDescriptor,
  type PluginBackgroundEntry,
  type PluginBackgroundInput,
  type PluginBackgroundParamsPatch,
} from '@onething/core/plugins'

/**
 * pluginId → 最近一次 `api.theme.updateBackground` 的结果。
 *
 * 纯内存、进程级。停用/卸载时由 `clearPluginBackgroundParams` 清掉 ——
 * 留着的话,重新启用会带回一份用户早就忘了的旧参数。
 */
const runtimeParams = new Map<string, PluginBackgroundParamsPatch>()

/**
 * 合进该插件的当前生效参数(manifest 缺省 ⊕ 最新 update)。
 *
 * 合并是**逐字段**的,所以 `image: null`(撤回)必须以 null 的样子存进来 ——
 * 展开后它盖掉上一张图,裁决层再把 `null` 读成"回落 manifest 缺省"。
 * 这里不为撤回删键:删键与"从来没设过"同形,而这两件事在合并语义里必须可分。
 *
 * 注意它与 `clearPluginBackgroundParams` 不是一回事:那个是**拆除面**(停用/
 * 卸载时把这个插件的整份内存态抹掉,三个旋钮一起),这里的撤回只动 image。
 */
export function setPluginBackgroundParams(
  pluginId: string,
  patch: PluginBackgroundParamsPatch,
): void {
  const previous = runtimeParams.get(pluginId) ?? {}
  runtimeParams.set(pluginId, { ...previous, ...patch })
}

export function getPluginBackgroundParams(
  pluginId: string,
): PluginBackgroundParamsPatch | undefined {
  return runtimeParams.get(pluginId)
}

/** 拆除面:停用/卸载/dispose 都要走它,否则重新启用会带回旧参数。 */
export function clearPluginBackgroundParams(pluginId: string): void {
  runtimeParams.delete(pluginId)
}

/** 测试与整体重启用。 */
export function clearAllPluginBackgroundParams(): void {
  runtimeParams.clear()
}

export interface PluginBackgroundTable {
  /** 逐插件裁决明细(设置页卡片用);没声明背景的插件不在表里。 */
  byPlugin: Map<string, PluginBackgroundEntry>
  /** 胜出的背景描述符(含完整 `onething-plugin://` URL);没有时是 null。 */
  winner: PluginBackgroundDescriptor | null
}

const EMPTY_TABLE: PluginBackgroundTable = { byPlugin: new Map(), winner: null }

/**
 * 从插件管理器读取背景声明。
 *
 * 只读 manifest —— 一行插件代码都不执行(宪法第 3 条)。启用闸门交给裁决层:
 * 停用的插件声明照样投影出来(卡片要看得见),但不参与合成。
 */
function collectBackgroundInputs(): PluginBackgroundInput[] {
  const manager = getPluginManager()
  if (!manager) return []
  return manager.getPlugins().map(plugin => ({
    pluginId: plugin.definition.id,
    enabled: plugin.definition.enabled,
    background: plugin.definition.manifest.contributes?.theme?.background,
    runtimeParams: runtimeParams.get(plugin.definition.id),
  }))
}

/** 当前生效的插件背景表。插件系统没装配起来时是空表(而不是抛)。 */
export function getPluginBackgroundTable(): PluginBackgroundTable {
  const inputs = collectBackgroundInputs()
  if (!inputs.length) return EMPTY_TABLE
  return resolvePluginBackgrounds(inputs)
}
