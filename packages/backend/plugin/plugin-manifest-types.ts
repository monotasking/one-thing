/**
 * 插件清单的形状:`plugin.json` 里写的东西(名字、版本、入口、`contributes` 下各项静态贡献),以及扫描后
 * 一只插件的记录(`CorePluginDefinition`:清单 + 目录 + 来源 + 启用与否)。全段 JSON-可序列化。
 *
 * 插件代码运行时拿到的 `api` 对象的形状在 `plugin-api-types.ts`;两边各管各的 —— 加一项清单贡献只改这里,
 * 加一个 API 面只改那里。从那只文件原样搬来(大文件拆分批 2,2026-10-04)。
 */

/**
 * 声明先于代码(设计文档 §4.2 宪法第 3 条)。
 *
 * `contributes` 是插件的**静态存在感**:宿主只读清单就能知道它会贡献什么,
 * 一行插件代码都不必执行。R2 只建类型与解析/校验/透出管道 —— 消费者在
 * R3(settings)与 R5(panels)。今天先立住形状,后面几期才不用回头改协议。
 *
 * 全段必须 JSON-可序列化(宪法第 2 条):它就住在 plugin.json 里。
 */
export interface PluginContributionCommand {
  name: string
  description?: string
  usage?: string
}

export interface PluginContributionPanel {
  id: string
  label: string
  icon?: string
  /**
   * 面板的呈现形态(C 期,L3)。缺省 `descriptor` —— 老 manifest 一个字不改。
   *
   * `webview`:内容由插件静态根内的 `entry` HTML 提供,跑在 sandbox iframe
   * (opaque origin + CSP + postMessage-only)里。插件的**逻辑代码仍在 main 进程**,
   * iframe 里只有静态文件 —— webview 换的是"一块 UI 长什么样",不是执行模型。
   */
  view?: 'descriptor' | 'webview'
  /**
   * webview 面板的入口 HTML,**静态根内的相对路径**(仅 view: 'webview' 必填)。
   * 必须是相对路径、无 `..`、无 scheme、以 .html 结尾;非法即丢弃该 panel
   * 并在清单投影里标出来(与未知锚点同规:降级不拒载)。
   */
  entry?: string
}

/**
 * 锚点块(R5.x):插件在宿主 UI 具名锚点上的一块嵌入式 UI。
 *
 * 与面板同规:静态存在感(id/label/anchor)在这里声明,运行期的
 * `registerUiSlot` 只绑 render/onAction。命名不叫 `ui` ——
 * `contributes.settings.ui`(设置项 UI hint)已经占了这个词的另一种含义。
 */
export interface PluginContributionUiSlot {
  /**
   * 必须是宿主锚点清单中的一员。
   *
   * **未知锚点不拒绝加载**:该条 contribution 被丢弃并在清单投影标记
   * `unsupported`(设置页可见),插件其余能力照常 —— 多宿主与版本偏斜下
   * "宿主不认识这个锚点"不是代码错误,不该吃 registration 熔断(阈值 1)。
   */
  anchor: string
  id: string
  label: string
  /**
   * 消息作用域状态的生命期声明(见 plugin-message-state-2026-08.md):
   *  - `'persistent'`:插件消息态落盘 + 启动水合(重启后老消息仍有内容);
   *  - `'ephemeral'`(默认):纯内存,插件卸载即丢。
   *
   * 这是**闸门声明**,不是元数据:插件有任一 slot 声明 persistent,
   * 宿主才给它的 message-state 落盘。loader 只校验形状(必须是字符串);
   * 未知值(未来新生命期)在闸门处天然读成非持久 —— 与未知锚点同规。
   */
  lifetime?: 'persistent' | 'ephemeral'
  /**
   * 抽屉形态(F 期)—— **仅在开了抽屉能力的锚点上有效**(今天只有
   * `composer.above`)。声明它,宿主就在块壳右侧画一组开合钮,块进入三态:
   * 展开(整块,高度预算 240px,块内滚动)/ 半收(单行摘要,即老形态)/
   * 全收(退位到 S 状态带一枚 chip)。render ctx 随之带 `drawerState`
   * (只有前两档会拉 render)。
   *
   * 其它锚点上声明它:**该字段被忽略**并在清单投影标 `drawerIgnored`,
   * 插件照常加载 —— 与未知锚点降级同规(版本偏斜下"这个宿主的这个位置没有
   * 抽屉"不是代码错误)。未声明的块形态一字不变(定高,无开合钮)。
   */
  drawer?: boolean
  /**
   * 落在哪一侧(I 期)—— **仅在分侧锚点上有效**(今天只有 `composer.aside`
   * 的输入框两翼)。缺省 `'right'`。每侧只有 1 个席位,同侧的第二条声明按
   * 容量截断(设置页说"锚点已满"),不是加载错误。
   *
   * 不分侧的锚点上声明它:**该字段被忽略**并在清单投影标 `sideIgnored`,
   * 插件照常加载 —— 与 `drawer` 降级同规。
   */
  side?: 'left' | 'right'
}

/** 呈现提示:不给则由 schema 推导控件。 */
export interface PluginContributionSettingsUiHint {
  label?: string
  hint?: string
  /** 覆盖由 schema 推导出的控件;超出宿主控件集的值会被拒。 */
  control?: string
}

export interface PluginContributionSettings {
  title?: string
  /**
   * JSON Schema(不是 zod)—— 过线皆 JSON Schema,zod 只是插件侧书写糖。
   *
   * **它是这个插件配置的唯一事实源**(R3 裁决):没有运行期 registerSettings。
   * 宿主只读清单就能渲染配置区、校验、填默认值,一行插件代码都不执行 ——
   * 于是**未启用的插件也能配**。
   */
  schema?: Record<string, unknown>
  ui?: Record<string, PluginContributionSettingsUiHint>
}

/**
 * 主题 token 覆盖(B 期,L2)。
 *
 * 键是**既有主题 token 路径**(产品层 `CSS_VAR_MAP` 的键),值是颜色字面量。
 * 只允许覆盖既有 token,不允许新增 —— 新增 token 就是全局 CSS 注入的变体
 * (表达力文档 §3.2 的红线)。
 *
 * 键的合法性 core 判不了(主题表在产品层,core 不吃产品层),所以这里只校验
 * **形状**;键不在表里 / 值不过颜色白名单的条目在投影层被丢弃并标记,
 * **不拒载、不计熔断**(与未知锚点同规)。
 *
 * **同一张表里还有第二种地址**(批 3b):以 `--ot-` 开头的键是**表面旋钮**
 * (浓度 / 模糊半径这类连续量),值形如 `"45%"` / `"6px"`,不是颜色。
 * token 路径永远不以 `--` 起头,两个地址空间在语法上不可能撞车,所以没有第二个
 * manifest 字段。旋钮同样由产品层判(`themes/knobs.ts`:前缀放行 + 按后缀定类型
 * + 按类型钳制区间),core 这边一样只管形状。越界值会被**钳到边界**而不是丢弃。
 */
/**
 * 背景/材质层(G 期,L2.5 —— 表达力文档 §3.3.5)。
 *
 * `image` / `darkImage` 是**包内相对路径**(相对 `contributes.webviewRoot`,
 * 缺省 `webview/`),由 C 期的 `onething-plugin://` 协议服务 —— 那条协议只服务
 * 已启用插件的静态根,于是"背景图"不需要打开任意 URL 这个红线。
 *
 * 三个旋钮 opacity / blur / fit 是**枚举出来的**,不是 CSS 片段。判据与裁决
 * 全在 `background.ts`;非法声明**丢弃 background 并在投影里标记**(不拒载)。
 */
export interface PluginContributionThemeBackground {
  image: string
  darkImage?: string
  opacity?: number
  blur?: number
  fit?: 'cover' | 'contain' | 'tile'
}

export interface PluginContributionTheme {
  /**
   * token 覆盖。**可选** —— G 期起 `contributes.theme` 可以只声明 background
   * 而一个 token 都不覆盖(把它留成必填等于逼作者写一个空对象)。
   */
  overrides?: Record<string, string>
  /** 背景/材质层(G 期,L2.5)。 */
  background?: PluginContributionThemeBackground
  /**
   * 皮肤包(H3)—— token 表达不了的**形**,以枚举档位的方式开放。
   *
   * 键是宿主开放的旋钮名,值是该旋钮的**档位名**(不是 CSS 值):插件永远碰不到
   * CSS 值,宿主查表把档位翻成变量。所以这里没有、也不需要任何值的消毒 ——
   * 这与 `overrides` 收自由颜色字符串是两种安全模型。
   *
   * 旋钮/档位的唯一事实源是主题层的 `SKIN_TIER_VALUES`(core 吃不到主题模块,
   * 所以这里只标形状)。不认识的旋钮、枚举外的档位一律**丢弃该键并在投影里
   * 标记**,不是拒载(与未知锚点、token 覆盖同规)。
   */
  skin?: Record<string, string>
}

export interface PluginContributionActivation {
  /** 懒激活的触发条件;R2 只解析不消费。 */
  events?: string[]
}

/**
 * 氛围层(G2 —— 全窗动画覆盖)。
 *
 * `entry` 是**包内相对路径**(相对 `contributes.webviewRoot`,缺省 `webview/`),
 * 由 C 期的 `onething-plugin://` 协议服务,跑在一块内容之上、`pointer-events:none`
 * 的 sandbox iframe 里。判据与裁决全在 `ambient.ts`;非法声明**丢弃 ambient 并在
 * 投影里标记**(不拒载)。装前披露:`draws animated effects over the window`。
 */
export interface PluginContributionAmbient {
  entry: string
}

export interface PluginContributes {
  commands?: PluginContributionCommand[]
  panels?: PluginContributionPanel[]
  uiSlots?: PluginContributionUiSlot[]
  theme?: PluginContributionTheme
  /** 氛围层(G2 —— 全窗动画覆盖,内容之上)。 */
  ambient?: PluginContributionAmbient
  /**
   * webview 面板的静态资源根,**相对插件的 `dirPath`**(代码区,npm 形态即
   * `plugins/node_modules/<pkg>/`)。缺省 `webview`。
   *
   * 刻意**不是**家目录 `plugins/<id>/`:家目录是数据区(config/kv/storage),
   * 随包分发的静态资产跟着代码走。`onething-plugin://` 只服务这个根之内的文件,
   * 规范化 + realpath 复核之后仍须落在根内。
   */
  webviewRoot?: string
  settings?: PluginContributionSettings
  permissions?: string[]
  activation?: PluginContributionActivation
}

export interface PluginManifest {
  name: string
  version: string
  description?: string
  entry?: string
  author?: string
  /** 语义化版本下界;低于它的宿主拒绝加载(R2 起真正生效)。 */
  minAppVersion?: string
  contributes?: PluginContributes
}

/**
 * 插件来源。
 *
 * - `builtin` = 与 app 同一份构建;
 * - `user` = `~/.onething/plugins/` 的 npm 账本插件(有 plugin.json + package.json);
 * - `local` = 轻通道:`~/.onething/plugins-dev/<name>.ts|js` 单文件脚本,无 manifest、
 *   无 package.json、不进市场、不参与更新。能力面靠"没有声明就没有能力"自动收窄
 *   (见 `scanLocalPluginFiles` 与装配层的窄化 API)。
 */
export type PluginSource = 'builtin' | 'user' | 'local'

export interface CorePluginDefinition<TEntry = unknown> {
  id: string
  source?: PluginSource
  manifest: PluginManifest
  dirPath: string
  entryPath: string
  entry?: TEntry
  enabled: boolean
  error?: string
  /**
   * 扫描期就判定的"不该加载"原因:非法 contributes、minAppVersion 不满足。
   * 置位后 manager 直接把插件放进 error 态,**不执行任何插件代码** ——
   * 声明层的问题不该等到运行期才发作。
   */
  loadBlockedReason?: string
}
