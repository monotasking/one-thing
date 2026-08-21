/**
 * 确认卡的**内容**(H4,装配层)。
 *
 * 卡长什么样是 renderer 的事;卡上**写什么**是这里的事,原因是那些话全都要查
 * 产品层的事实:这个 agent 存在吗、这个插件叫什么、这个动作还在不在、还灰不灰。
 * 把它们留给 renderer 现查,等于把同一份判断散成两份(而两份迟早会漂)。
 *
 * 一条纪律贯穿全文件:**卡上不出现裸 id**。用户读的是"发送到新会话(以 小张 的
 * 身份)"和"交给「划词翻译」的『翻译选中文本』动作",不是 `agent=a3f1` 和
 * `plugin:trans:translate`。id 只在日志里。
 *
 * 另一条:**说不了的事就说不能做**。agent 查不到 → 卡上明说"回落默认";动作
 * 不在了 / 灰着 → 卡上是一条**没有确认按钮**的拒绝,而不是让用户确认一个不会
 * 发生的动作。
 */
import type {
  DeepLinkAskCardPayload,
  DeepLinkCardPayload,
  DeepLinkPluginCardPayload,
  DeepLinkRejectionCardPayload,
} from '@shared/ipc/deeplink.js'
import {
  DEEPLINK_TEXT_MAX_BYTES,
  type DeepLinkIntent,
  type DeepLinkParseResult,
} from '@onething/core/plugins'
import { defaultAgent, findAgent } from '../agents/index.js'
import { getPluginManager } from '../plugins/manager.js'
import { describePluginDeepLinkAction } from './registry.js'

/** 卡上的来源标注。用户要一眼看出"这不是我在应用里点的"。 */
export const DEEPLINK_CARD_SOURCE_LABEL = 'external link request'

/**
 * 卡的形状住在 `@shared/ipc/deeplink`(renderer 要直接渲染它,而 renderer 不许
 * import 装配层)。这里只是把它们取个短名字用 —— **不重新定义**,一份形状两处
 * 声明是最容易漂的那种重复。
 */
export type DeepLinkAskCard = DeepLinkAskCardPayload
export type DeepLinkPluginCard = DeepLinkPluginCardPayload
export type DeepLinkRejectionCard = DeepLinkRejectionCardPayload
export type DeepLinkCard = DeepLinkCardPayload

/**
 * 把一次解析结果变成"给用户看的东西",或者 `null` = **静默丢弃**。
 *
 * `null` 是这个函数最重要的返回值:外部世界可以随便构造一串 `onething://…`,
 * 形状非法的那些必须是**哑**的(一行日志,零弹窗),否则任何一个网页都能拿
 * 弹窗骚扰用户。判据不在这里现编 —— 它是 core 的 `isVisibleDeepLinkRejection`。
 */
export function buildDeepLinkCard(parsed: DeepLinkParseResult): DeepLinkCard | null {
  if (!parsed.ok) {
    if (parsed.reason !== 'text-too-long') return null
    return {
      kind: 'rejected',
      reason: parsed.reason,
      message: `The link carries more than ${Math.round(DEEPLINK_TEXT_MAX_BYTES / 1024)}KB of text — refused.`,
    }
  }
  return buildCardForIntent(parsed.intent)
}

function buildCardForIntent(intent: DeepLinkIntent): DeepLinkCard {
  if (intent.kind === 'ask') return buildAskCard(intent.text, intent.agentId)
  return buildPluginCard(intent.pluginId, intent.action, intent.text, intent.params)
}

function buildAskCard(text: string, agentId?: string): DeepLinkAskCard {
  const card: DeepLinkAskCard = { kind: 'ask', text }
  if (!agentId) return card
  // 严格查找:查无此人**不冒充 default**(那正是 findAgent 与 getAgent 的分野),
  // 我们自己回落,并把回落这件事写在卡上。
  const agent = findAgent(agentId)
  if (agent) {
    card.agentId = agent.id
    card.agentName = agent.name
    return card
  }
  card.agentFallbackFrom = agentId
  try {
    card.defaultAgentName = defaultAgent().name
  } catch {
    // agent 库还没初始化(冷启动早期)——名字说不出来就不说,回落这件事照说。
  }
  return card
}

function buildPluginCard(
  pluginId: string,
  action: string,
  text: string,
  params: Record<string, string>,
): DeepLinkPluginCard | DeepLinkRejectionCard {
  const info = describePluginDeepLinkAction(pluginId, action)
  const pluginName = resolvePluginDisplayName(pluginId)
  if (!info) {
    return {
      kind: 'rejected',
      reason: 'action-unavailable',
      message: `No plugin here handles “${action}”. The plugin may be disabled or not installed.`,
    }
  }
  if (info.degraded) {
    return {
      kind: 'rejected',
      reason: 'action-degraded',
      message: `“${info.title}” (${pluginName}) is temporarily disabled after repeated failures. Try again in a few minutes.`,
    }
  }
  return {
    kind: 'plugin',
    text,
    params,
    pluginId,
    action,
    pluginName,
    actionTitle: info.title,
  }
}

/** manifest.name 是显示名;查不到(插件已卸载 / 系统未装配)才退回 id。 */
export function resolvePluginDisplayName(pluginId: string): string {
  try {
    const found = getPluginManager()
      ?.getPlugins()
      .find(info => info.definition.id === pluginId)
    const name = found?.definition.manifest?.name
    return typeof name === 'string' && name.trim() ? name.trim() : pluginId
  } catch {
    return pluginId
  }
}
