/**
 * `contributes.ambient` —— G2 氛围层(全窗动画覆盖)的**判据与裁决**。
 *
 * 氛围层是 webview 的**第三个住址**(面板 → 围栏 → 全窗覆盖):内容之上、
 * pointer-events:none 的一块 sandbox iframe,任意动画只有 L3 能承载,而 C 期
 * 已经把 sandbox iframe 的全套安全面(独立 origin + CSP + postMessage + token
 * 握手)建好了 —— 氛围层复用那一整套,只是挂载位置和 z 位不同。
 *
 * 三件事在这里,而且只在这里(与 G 期背景层 `background.ts` 逐字同构):
 *
 *  1. **入口是包内资产,不是任意 URL。** entry 走 C 期的 `onething-plugin://<id>/`
 *     协议,判据直接复用 webview entry 那一份(`describePluginRelativeAssetPathProblem`
 *     + `.html` 白名单)—— 穿越、scheme、编码变体这些判据只能有一份。
 *
 *  2. **只渲染一个氛围层。** 全窗动画叠加多个是灾难,所以背景那"全局唯一一格"
 *     的裁决在这里照抄:冲突按全局规范顺序**后者胜**(`comparePluginCanonicalOrder`),
 *     停用的插件不参与裁决(否则关掉一个插件会改变另一个插件的呈现状态)。
 *
 *  3. **判据在 core、IO 在宿主。** 这里一行 fs / electron 都不吃;真正的读文件
 *     仍住在 `apps/electron/src/plugins/protocol.ts`(与 webview / 背景同一条协议、
 *     同一批闸)。用户主权(总闸 + 每插件静音)是宿主状态,落在装配/渲染层,
 *     不在这份纯裁决里 —— 与提示音的裁决点分层同规。
 */
import { comparePluginCanonicalOrder } from './canonical-order.js'
import {
  describePluginRelativeAssetPathProblem,
  pluginWebviewEntryUrl,
} from './webview.js'

/**
 * 宿主 ⇄ 氛围 iframe 的消息名。
 *
 * host → iframe:`init`(首帧握手,带 token)、`vocabulary`(地标词表,握手
 * 确认后发一次)、`geometry`(枚举地标矩形,resize/布局变化时节流推送)、
 * `pause`/`resume`(窗口失焦/隐藏即停)。
 * iframe → host:`ready`(握手确认,宿主据此判定页面真的起来了)。
 *
 * **token 是唯一的身份凭据**:sandbox=allow-scripts(无 allow-same-origin)的
 * iframe 是 opaque origin,`event.origin` 是字符串 `"null"`,校验它等于没校验。
 * 与 webview 面板同规(见 `webview.ts` 的 `PLUGIN_WEBVIEW_MESSAGE_TYPES`),
 * 只是氛围层没有 invoke/result —— 它是纯视觉,永远不回调宿主。
 */
export const PLUGIN_AMBIENT_MESSAGE_TYPES = {
  /** host → iframe:首帧握手,带 token。 */
  init: 'ambient-init',
  /** host → iframe:地标词表(名字 × kind × cardinality),握手确认后发一次。 */
  vocabulary: 'ambient-vocabulary',
  /** host → iframe:枚举地标的矩形(viewport + composerRect,…)。 */
  geometry: 'ambient-geometry',
  /** host → iframe:窗口失焦/隐藏,停 rAF。 */
  pause: 'ambient-pause',
  /** host → iframe:窗口重新可见,恢复 rAF。 */
  resume: 'ambient-resume',
  /** iframe → host:握手确认。 */
  ready: 'ambient-ready',
} as const

export type PluginAmbientMessageType =
  (typeof PLUGIN_AMBIENT_MESSAGE_TYPES)[keyof typeof PLUGIN_AMBIENT_MESSAGE_TYPES]

/** manifest 里的声明形状(未校验)。 */
export interface PluginAmbientDeclarationLike {
  entry?: unknown
}

/**
 * 一条 `contributes.ambient` 的判据。返回错误字符串 = **丢弃该声明**(不拒载整个
 * 插件,只是这块氛围画不出来,并在投影里标出来)。
 *
 * entry 判据与 webview entry 逐字相同(同一条协议、同一批穿越/scheme/编码闸),
 * 只在"必须是 .html"这一条上与背景图分叉。
 */
export function describePluginAmbientProblem(declaration: unknown): string | null {
  if (declaration === null || typeof declaration !== 'object') {
    return 'contributes.ambient must be an object with an "entry"'
  }
  const entry = (declaration as PluginAmbientDeclarationLike).entry
  const entryProblem = describePluginRelativeAssetPathProblem(entry, 'contributes.ambient.entry')
  if (entryProblem) return entryProblem
  if (!/\.html?$/i.test(entry as string)) {
    return 'contributes.ambient.entry must point at an .html file inside the plugin static root'
  }
  return null
}

/** 一条氛围声明在裁决后的状态(与背景/主题覆盖的四态同名同义)。 */
export type PluginAmbientStatus =
  /** 生效中:此刻画在氛围层上。 */
  | 'active'
  /** 被规范顺序更后的插件压过(全窗只有一层)。 */
  | 'shadowed'
  /** 插件未启用。 */
  | 'inactive'
  /** entry 非法(丢弃,但要说得出来)。 */
  | 'invalid'

export interface PluginAmbientEntry {
  status: PluginAmbientStatus
  /** manifest 声明的入口(相对静态根);invalid 时可能是空串。 */
  entry: string
  /** status === 'invalid' 时的人话原因。 */
  reason?: string
  /** status === 'shadowed' 时压过它的那个插件 id。 */
  shadowedBy?: string
}

/** 胜出的那一条 —— renderer 拿它直接挂 iframe,不再做第二次判断。 */
export interface PluginAmbientDescriptor {
  pluginId: string
  /** `onething-plugin://<id>/<entry>` 完整 URL。 */
  entryUrl: string
}

export interface PluginAmbientInput {
  pluginId: string
  enabled: boolean
  /** manifest 的 `contributes.ambient`(未校验原文)。 */
  ambient?: unknown
}

export interface PluginAmbientResolution {
  /** 逐插件裁决(键 = pluginId);没声明氛围的插件不出现在表里。 */
  byPlugin: Map<string, PluginAmbientEntry>
  /** 胜出的氛围层;没有任何一条 active 时是 null。 */
  winner: PluginAmbientDescriptor | null
}

/** 氛围入口的 URL —— 与 webview entry / 背景图**同一个出处**。 */
export function pluginAmbientEntryUrl(pluginId: string, entry: string): string {
  return pluginWebviewEntryUrl(pluginId, entry)
}

/**
 * 裁决一组插件的氛围声明。
 *
 * 顺序语义与背景层逐字相同:先按全局规范顺序排,再顺序写入 —— 后写的赢,
 * 被赢掉的那条标 `shadowed` 并记下赢家。**氛围只有一层**,所以这里的"同一格"
 * 就是全窗唯一那一层。
 *
 * 用户主权(总闸 + 每插件静音)**不在这里**:那是宿主状态,渲染层据 preference
 * 决定这个 winner 到底画不画。这份裁决只回答"若不考虑用户偏好,该出现哪一层"。
 */
export function resolvePluginAmbients(
  inputs: readonly PluginAmbientInput[],
): PluginAmbientResolution {
  const ordered = [...inputs].sort((a, b) => comparePluginCanonicalOrder(a.pluginId, b.pluginId))
  const byPlugin = new Map<string, PluginAmbientEntry>()
  let winner: { pluginId: string; entry: PluginAmbientEntry } | null = null

  for (const input of ordered) {
    if (input.ambient === undefined) continue
    const problem = describePluginAmbientProblem(input.ambient)
    if (problem) {
      const raw = input.ambient && typeof input.ambient === 'object'
        ? input.ambient as PluginAmbientDeclarationLike
        : {}
      byPlugin.set(input.pluginId, {
        status: 'invalid',
        entry: typeof raw.entry === 'string' ? raw.entry : '',
        reason: problem,
      })
      continue
    }
    const entry = (input.ambient as PluginAmbientDeclarationLike).entry as string
    if (!input.enabled) {
      byPlugin.set(input.pluginId, { status: 'inactive', entry })
      continue
    }
    const active: PluginAmbientEntry = { status: 'active', entry }
    if (winner) {
      winner.entry.status = 'shadowed'
      winner.entry.shadowedBy = input.pluginId
    }
    winner = { pluginId: input.pluginId, entry: active }
    byPlugin.set(input.pluginId, active)
  }

  return {
    byPlugin,
    winner: winner
      ? {
        pluginId: winner.pluginId,
        entryUrl: pluginAmbientEntryUrl(winner.pluginId, winner.entry.entry),
      }
      : null,
  }
}
