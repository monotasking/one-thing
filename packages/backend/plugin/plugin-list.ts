import { describePluginConfigSchema, type PluginConfigField } from './config-schema.js'
import {
  describePluginWebviewPanelProblem,
  isEffectiveUiDrawerSlot,
  isIgnoredUiDrawerDeclaration,
  isIgnoredUiSlotSideDeclaration,
  isUiAnchor,
  resolveUiSlotSide,
  isPluginWebviewPanel,
  resolvePluginAmbients,
  resolvePluginBackgrounds,
} from '@onething/backend/plugin/plugin-contract'
import type {
  PluginAmbientDescriptor,
  PluginAmbientEntry,
  PluginAmbientInput,
  PluginBackgroundDescriptor,
  PluginBackgroundEntry,
  PluginBackgroundInput,
  PluginBackgroundParamsPatch,
} from '@onething/backend/plugin/plugin-contract'
import {
  resolvePluginThemeOverrides,
  type PluginThemeOverrideEntry,
} from './theme-overrides.js'
import {
  resolvePluginSkins,
  type PluginSkinEntry,
} from './plugin-skin.js'

export interface OnethingPluginListManifestLike {
  name: string
  version: string
  description?: string
  author?: string
  minAppVersion?: string
  contributes?: {
    commands?: Array<{ name: string }>
    panels?: Array<{ id: string; label: string; view?: string; entry?: string; placements?: string[] }>
    uiSlots?: Array<{ anchor: string; id: string; label: string; lifetime?: string; drawer?: boolean; side?: string }>
    theme?: {
      overrides?: Record<string, string>
      background?: unknown
      skin?: Record<string, string>
    }
    ambient?: unknown
    webviewRoot?: string
    settings?: {
      title?: string
      schema?: Record<string, unknown>
      ui?: Record<string, { label?: string; hint?: string; control?: string }>
    }
    permissions?: string[]
    activation?: { events?: string[] }
  }
}

export interface OnethingPluginListDefinitionLike {
  id: string
  source?: string
  manifest: OnethingPluginListManifestLike
  enabled: boolean
  dirPath: string
}

/** 运行期健康(core 的 CorePluginRuntimeHealth 的结构镜像,过线只走 JSON)。 */
export interface OnethingPluginRuntimeHealthLike {
  status: string
  consecutiveFailures: number
  lastError?: string
  lastErrorScope?: string
  lastErrorAt?: number
  disabledReason?: string
  /** 降级中的界面(R7):只影响一个面板,插件其余能力照常。 */
  degradedSurfaces?: Array<{ surface: string; reason: string; at: number }>
}

export interface OnethingPluginListItemLike {
  definition: OnethingPluginListDefinitionLike
  loaded: boolean
  commands: string[]
  error?: string
  health?: OnethingPluginRuntimeHealthLike
}

export interface ProjectOnethingPluginsOptions {
  /** 每个插件当前登记的请求 action(来自 manager 的活状态,不是 manifest)。 */
  getRequestActions?(pluginId: string): string[]
  /** 已校验、已填默认值的有效配置(宿主持有;未启用的插件也有)。 */
  getConfig?(pluginId: string): Record<string, unknown>
  /**
   * 该插件最近一次 `api.theme.updateBackground` 的结果(G 期,内存态)。
   *
   * 省略 = 只按 manifest 缺省投影(server 只读镜像的自然缺省 —— 方案 A 下那侧
   * 不跑插件代码,也就没有运行期调参这回事)。
   */
  getBackgroundParams?(pluginId: string): PluginBackgroundParamsPatch | undefined
}

export interface OnethingRendererPluginInfo {
  id: string
  source: string
  name: string
  version: string
  description: string
  author: string
  loaded: boolean
  enabled: boolean
  commands: string[]
  error: string
  dirPath: string
  /**
   * manifest 声明的贡献点摘要(宪法第 3 条:声明先于代码)。
   * R2 只把它透出到设置页,消费者在 R3(settings)/R5(panels)。
   */
  contributes: {
    commands: string[]
    /**
     * 面板(R5)。C 期起逐条带形态与判决:
     * `view` 是 `'descriptor'` 或 `'webview'`;`unsupported` = 这条声明非法
     * (webview 缺 entry / entry 越界 / 静态根非法 / view 是个不认识的值),
     * 该面板**不渲染**,但设置页要能把 `reason` 说出来 —— 与未知锚点同规:
     * 降级不拒载,不计熔断。
     */
    panels: Array<{
      id: string
      label: string
      view: string
      entry: string
      unsupported: boolean
      reason: string
      /**
       * 这个面板可以出现在哪些宿主表面(H1)。`'workspace'` = 主工作区面板
       * (MediaPanel/⋯ 菜单);`'workbench'` = 可作为右侧工作台的一个 tab 打开。
       * 缺省 `['workspace']` —— 老面板没有声明,只在主工作区(append-only)。
       */
      placements: string[]
    }>
    /**
     * 锚点块(R5.x)。`unsupported` = 该条声明的锚点不在宿主清单里:
     * 块不渲染,但设置页要能把这件事说出来(前向兼容,见设计文档 §4.1)。
     *
     * `lifetime` 原样流出(plugin-message-state-2026-08 §3.2):它是消息态落盘的
     * **闸门声明**,装前确认页要据此告诉用户"这插件会在消息上留下持久内容"。
     * 不在这里归一成布尔 —— 市场索引那条路走的是未投影的 manifest 原文,
     * 两条路各判一次才是漂移的开始,判据只留在 renderer 的一个 helper 里。
     *
     * `drawer` 是 **裁决后的**抽屉形态(F 期):锚点开了抽屉能力 **且** 这条
     * 声明了 `drawer: true` 才为 true;别的锚点上声明它 → `drawer: false` +
     * `drawerIgnored: true`(该字段被忽略,插件照常加载)。判据在 core 的
     * `isEffectiveUiDrawerSlot`,renderer 不再判第二遍 —— 与未知锚点同规:
     * 一处裁决,两处消费。
     */
    uiSlots: Array<{
      anchor: string
      id: string
      label: string
      unsupported: boolean
      lifetime: string
      drawer: boolean
      drawerIgnored: boolean
      /**
       * 裁决后的**侧位**(I 期,composer.aside):分侧锚点上是 `'left'` /
       * `'right'`(未声明或未知值归一成缺省侧),不分侧的锚点上是 `''` +
       * `sideIgnored: true`。判据在 core 的 `resolveUiSlotSide` ——
       * 与 drawer 同规:一处裁决,两处消费。
       */
      side: string
      sideIgnored: boolean
    }>
    /**
     * 主题 token 覆盖(B 期)。逐条带裁决结果:
     * `active` 生效中 / `shadowed` 被规范顺序更后的插件压过 / `inactive` 插件未启用 /
     * `invalid` 键不在主题 token 表或值不过颜色白名单(丢弃,但要说得出来)。
     *
     * 裁决在投影里做而不是在设置页做:它依赖**全体插件**(谁压谁),
     * renderer 只拿到一个插件的卡片,自己判不出来;server 只读镜像走同一条
     * 投影 —— 声明透传,合成不发生在那一侧(方案 A)。
     */
    theme: PluginThemeOverrideEntry[]
    /**
     * 皮肤包(H3)。逐条带裁决结果,词与 token 覆盖同一套:
     * `active` 生效中 / `shadowed` 被规范顺序更后的插件压过 / `inactive` 插件未启用 /
     * `invalid` 旋钮不认识或档位在枚举外(丢弃该键,但要说得出来)。
     *
     * 与 token 覆盖同规:裁决在投影里做(谁压谁要看全体插件),非法**不拒载**。
     */
    skin: PluginSkinEntry[]
    /**
     * 背景/材质层(G 期,L2.5)。`null` = 这个插件没声明背景。
     *
     * 与 token 覆盖同规:裁决在投影里做(谁压谁要看全体插件,renderer 只拿到
     * 一张卡片判不出来),非法声明**不拒载**,只是 `status: 'invalid'` + `reason`,
     * 让设置页说得出"这张背景为什么没出现"。
     */
    background: PluginBackgroundEntry | null
    /**
     * 氛围层(G2 —— 全窗动画覆盖)。`null` = 这个插件没声明氛围。
     *
     * 与背景层同规:裁决在投影里做(谁压谁要看全体插件,全窗只有一层),
     * 非法声明**不拒载**,只是 `status: 'invalid'` + `reason`,让设置页说得出
     * "这层氛围为什么没出现"。用户的总闸 / 每插件静音是**另一码事**(渲染层
     * 据 preference 决定 winner 画不画),不进这条逐插件裁决。
     */
    ambient: PluginAmbientEntry | null
    hasSettingsSchema: boolean
    permissions: string[]
    activationEvents: string[]
  }
  /** 插件登记的请求通道 action 列表。 */
  requestActions: string[]
  /**
   * 配置区的渲染材料(R3)。schema 单源在 manifest,归约成控件表在产品层 ——
   * renderer 不自己解 JSON Schema,两端各写一份解析器就是漂移的开始。
   */
  configFields: PluginConfigField[]
  configTitle: string
  configValues: Record<string, unknown>
  /** 声明了 settings schema 但超出宿主控件集时的逐条原因。 */
  configUnsupportedReasons: string[]
  /**
   * configValues 是"schema 默认值"而不是宿主真实存量。
   *
   * server 只读镜像没接取值器 —— 不标出来的话,用户会把默认值读成桌面真值。
   */
  configValuesAreDefaults: boolean
  /** 本宿主是否允许编辑配置(方案 A 下 server 侧为 false)。 */
  configEditable: boolean
  minAppVersion: string
  /** 'healthy' | 'degraded' | 'disabled';无健康记录时为 'healthy'。 */
  healthStatus: string
  healthFailures: number
  /** 运行期失败原因(熔断说明优先,其次最后一次错误)—— 设置页据此亮红。 */
  healthReason: string
  /**
   * 降级中的界面(R7)。
   *
   * 插件卡片要如实说"某个面板暂不可用",而不是把整体标成 Failed —— 用户主动
   * 触发的失败只连坐它自己那一个界面,插件的工具/命令/提示词照常。
   */
  degradedSurfaces: Array<{ surface: string; reason: string }>
}

export interface OnethingPluginCommandLike {
  name: string
  description?: string
  usage?: string
}

export interface OnethingRendererPluginCommandInfo {
  id: string
  name: string
  description: string
  usage: string
}

/**
 * 背景裁决的输入 —— 逐插件投影与"胜出者"共用**同一个**收集器。
 *
 * 两处各拼一遍就是漂移的开始:一处忘了带 runtimeParams,卡片上说的透明度
 * 就会与画在屏幕上的那一张对不上,而两边都"看着对"。
 */
function collectBackgroundInputs<TPlugin extends OnethingPluginListItemLike>(
  plugins: TPlugin[],
  options: ProjectOnethingPluginsOptions,
): PluginBackgroundInput[] {
  return plugins.map(plugin => ({
    pluginId: plugin.definition.id,
    enabled: plugin.definition.enabled,
    background: plugin.definition.manifest.contributes?.theme?.background,
    runtimeParams: options.getBackgroundParams?.(plugin.definition.id),
  }))
}

/**
 * 胜出的背景描述符(G 期,L2.5)—— renderer 直接拿它画层,不再判第二遍。
 *
 * 它**不挂在逐插件的投影里**:背景是全局唯一那一格,挂进数组等于让 renderer
 * 自己再跑一遍裁决(而它只看得到自己那一张卡片)。宿主把结论放在清单响应的
 * 同一层上,零新通道 —— renderer 已经在 `onething:plugins-changed` 上重拉清单。
 */
export function resolveOnethingPluginBackgroundForRenderer<TPlugin extends OnethingPluginListItemLike>(
  plugins: TPlugin[],
  options: ProjectOnethingPluginsOptions = {},
): PluginBackgroundDescriptor | null {
  return resolvePluginBackgrounds(collectBackgroundInputs(plugins, options)).winner
}

/** 氛围裁决的输入 —— 逐插件投影与"胜出者"共用**同一个**收集器(与背景同规)。 */
function collectAmbientInputs<TPlugin extends OnethingPluginListItemLike>(
  plugins: TPlugin[],
): PluginAmbientInput[] {
  return plugins.map(plugin => ({
    pluginId: plugin.definition.id,
    enabled: plugin.definition.enabled,
    ambient: plugin.definition.manifest.contributes?.ambient,
  }))
}

/**
 * 胜出的氛围层(G2 —— 全窗动画覆盖)—— renderer 直接拿它挂 iframe,不再判第二遍。
 *
 * 与背景描述符同规:全窗只有一层,挂进逐插件数组等于让 renderer 自己再跑一遍
 * 裁决(而它只看得到自己那一张卡片)。用户主权(总闸 / 每插件静音)不在这里 ——
 * 那是 renderer 侧的 preference,渲染层据它决定这个 winner 到底画不画。
 */
export function resolveOnethingPluginAmbientForRenderer<TPlugin extends OnethingPluginListItemLike>(
  plugins: TPlugin[],
): PluginAmbientDescriptor | null {
  return resolvePluginAmbients(collectAmbientInputs(plugins)).winner
}

export function projectOnethingPluginsForRenderer<TPlugin extends OnethingPluginListItemLike>(
  plugins: TPlugin[],
  options: ProjectOnethingPluginsOptions = {},
): OnethingRendererPluginInfo[] {
  // 主题覆盖的冲突裁决要看**全体插件**,所以先整体算一遍再逐个投影。
  const themeResolution = resolvePluginThemeOverrides(plugins.map(plugin => ({
    pluginId: plugin.definition.id,
    enabled: plugin.definition.enabled,
    overrides: plugin.definition.manifest.contributes?.theme?.overrides,
  })))
  // 皮肤同理(H3):一个旋钮全局只有一个档位,谁压谁必须看全体。
  const skinResolution = resolvePluginSkins(plugins.map(plugin => ({
    pluginId: plugin.definition.id,
    enabled: plugin.definition.enabled,
    skin: plugin.definition.manifest.contributes?.theme?.skin,
  })))
  // 背景同理(G 期):全局只有一块背景,谁压谁必须看全体。
  const backgroundResolution = resolvePluginBackgrounds(
    collectBackgroundInputs(plugins, options),
  )
  // 氛围同理(G2):全窗只有一层,谁压谁必须看全体。
  const ambientResolution = resolvePluginAmbients(collectAmbientInputs(plugins))
  return plugins.map(plugin => ({
    id: plugin.definition.id,
    source: plugin.definition.source || 'user',
    name: plugin.definition.manifest.name,
    version: plugin.definition.manifest.version,
    description: plugin.definition.manifest.description || '',
    author: plugin.definition.manifest.author || '',
    loaded: plugin.loaded,
    enabled: plugin.definition.enabled,
    commands: plugin.commands,
    error: plugin.error || '',
    dirPath: plugin.definition.dirPath,
    contributes: {
      commands: (plugin.definition.manifest.contributes?.commands ?? []).map(command => command.name),
      panels: (plugin.definition.manifest.contributes?.panels ?? []).map(panel => {
        const problem = describePluginWebviewPanelProblem(
          panel,
          plugin.definition.manifest.contributes?.webviewRoot,
        )
        return {
          id: panel.id,
          label: panel.label,
          // 非法声明一律按 descriptor 呈现形态报出去:renderer 不该拿一个
          // "自称 webview 但被丢弃"的条目去拼 iframe 的 src。
          view: !problem && isPluginWebviewPanel(panel) ? 'webview' : 'descriptor',
          entry: !problem && isPluginWebviewPanel(panel) ? String(panel.entry ?? '') : '',
          unsupported: Boolean(problem),
          reason: problem ?? '',
          // 缺省 ['workspace'](现状)。只保留字符串成员;未知值原样透传,
          // 由消费方按已知 placement 判 —— 与未知锚点降级同规,前向兼容。
          placements: Array.isArray(panel.placements) && panel.placements.length
            ? panel.placements.filter(item => typeof item === 'string')
            : ['workspace'],
        }
      }),
      uiSlots: (plugin.definition.manifest.contributes?.uiSlots ?? []).map(slot => ({
        anchor: slot.anchor,
        id: slot.id,
        label: slot.label,
        unsupported: !isUiAnchor(slot.anchor),
        lifetime: slot.lifetime ?? '',
        drawer: isEffectiveUiDrawerSlot(slot.anchor, slot.drawer),
        drawerIgnored: isIgnoredUiDrawerDeclaration(slot.anchor, slot.drawer),
        side: resolveUiSlotSide(slot.anchor, slot.side) ?? '',
        sideIgnored: isIgnoredUiSlotSideDeclaration(slot.anchor, slot.side),
      })),
      theme: themeResolution.byPlugin.get(plugin.definition.id) ?? [],
      skin: skinResolution.byPlugin.get(plugin.definition.id) ?? [],
      background: backgroundResolution.byPlugin.get(plugin.definition.id) ?? null,
      ambient: ambientResolution.byPlugin.get(plugin.definition.id) ?? null,
      hasSettingsSchema: Boolean(plugin.definition.manifest.contributes?.settings?.schema),
      permissions: plugin.definition.manifest.contributes?.permissions ?? [],
      activationEvents: plugin.definition.manifest.contributes?.activation?.events ?? [],
    },
    requestActions: options.getRequestActions?.(plugin.definition.id) ?? [],
    ...projectPluginConfig(plugin, options),
    minAppVersion: plugin.definition.manifest.minAppVersion || '',
    healthStatus: plugin.health?.status || 'healthy',
    healthFailures: plugin.health?.consecutiveFailures || 0,
    healthReason: plugin.health?.disabledReason
      || (plugin.health?.lastError
        ? `${plugin.health.lastErrorScope ? `${plugin.health.lastErrorScope}: ` : ''}${plugin.health.lastError}`
        : ''),
    degradedSurfaces: (plugin.health?.degradedSurfaces ?? [])
      .map(entry => ({ surface: entry.surface, reason: entry.reason })),
  }))
}

function projectPluginConfig<TPlugin extends OnethingPluginListItemLike>(
  plugin: TPlugin,
  options: ProjectOnethingPluginsOptions,
): {
  configFields: PluginConfigField[]
  configTitle: string
  configValues: Record<string, unknown>
  configUnsupportedReasons: string[]
  configValuesAreDefaults: boolean
  configEditable: boolean
} {
  const editable = Boolean(options.getConfig)
  const settings = plugin.definition.manifest.contributes?.settings
  if (!settings?.schema) {
    return {
      configFields: [],
      configTitle: '',
      configValues: {},
      configUnsupportedReasons: [],
      configValuesAreDefaults: false,
      configEditable: editable,
    }
  }
  const described = describePluginConfigSchema(settings.schema, {
    title: settings.title,
    ui: settings.ui,
  })
  if (!described.supported) {
    return {
      configFields: [],
      configTitle: settings.title || '',
      configValues: {},
      configUnsupportedReasons: described.reasons,
      configValuesAreDefaults: false,
      configEditable: editable,
    }
  }
  // 宿主没给取值器时(server 只读镜像)退回默认值:呈现要诚实,
  // 但不能因为拿不到值就把整个配置区藏起来 —— 所以退默认的同时把
  // configValuesAreDefaults 标出来,让 UI 说清楚"这不是桌面真值"。
  return {
    configFields: described.fields,
    configTitle: described.title || '',
    configValues: options.getConfig?.(plugin.definition.id)
      ?? Object.fromEntries(described.fields.map(field => [field.key, field.defaultValue])),
    configUnsupportedReasons: [],
    configValuesAreDefaults: !editable,
    configEditable: editable,
  }
}

export function projectOnethingPluginCommandsForRenderer<TCommand extends OnethingPluginCommandLike>(
  commands: Iterable<TCommand>,
): OnethingRendererPluginCommandInfo[] {
  return Array.from(commands).map(command => ({
    id: command.name.replace(/^\//, ''),
    name: command.name,
    description: command.description || 'Plugin command',
    usage: command.usage || command.name,
  }))
}
