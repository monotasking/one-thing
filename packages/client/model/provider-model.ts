/**
 * provider / model 的**纯判据** —— 从设置推导「显示哪个 provider、哪个模型」。
 *
 * C0 搬家记录(`docs/design/client-sdk-2026-09.md` §3):产地是
 * `packages/renderer/stores/helpers/provider-model.ts`,除下面这条 import 之外
 * 逐字未改。`AppSettings` 改从 `@shared/ipc/settings` 直接引 —— renderer 的
 * `@/types` 对这个类型本来就只是再导出(`packages/renderer/types/index.ts`),
 * 而本包禁 import 任何壳。本批**不删原件**,Vue renderer 改成再导出是 C2 的事。
 */
import type { AppSettings } from '@shared/ipc/settings.js'

/*
 * 「这个 provider 开没开」的判据(含家族派生与 per-space 覆盖)住在
 * `@shared/provider-families` —— 后端的发送路也要问同一句(设计正本
 * provider-settings-rework §2.3),两边共用一份,不复制。这里只再导出。
 *
 * P4 起家族不再是 `@shared` 里的一张表:`isProviderEnabledIn` 要调用方给家族查询。
 * 客户端的查询从下发的名册来 —— `providerFamilyLookupOf(providers)`(`providers.getProviders`
 * 的 `ProviderInfo[]`,每条带 `family`)。
 */
export {
  isProviderConfigEnabled,
  isProviderEnabledIn,
  providerFamilyLinkOf,
  providerFamilyLookupOf,
  type ProviderEnabledOverride,
  type ProviderFamilyInfo,
  type ProviderFamilyLink,
  type ProviderFamilyLookup,
} from '@shared/provider-families'

export interface SessionModelLike {
  lastProvider?: string
  lastModel?: string
  /** The user picked lastProvider/lastModel by hand (not the per-turn stamp). */
  modelPinned?: boolean
}

export interface AgentModelBindingLike {
  providerId?: string
  modelId?: string
}

/** 当前空间的默认选择(批 B9)。缺席 = 这个空间没表达过 → 落回全局默认。 */
export interface SpaceDefaultSelectionLike {
  provider?: string
  model?: string
}

interface ResolveProviderModelOptions {
  settings?: AppSettings | null
  session?: SessionModelLike | null
  /** The session agent's model binding, when it has one. */
  agentModel?: AgentModelBindingLike | null
  /**
   * 当前空间的默认 provider/model(批 B9)。默认空间传 `undefined` —— 那一支
   * 与今天逐字相同。
   */
  spaceDefault?: SpaceDefaultSelectionLike | null
}

interface ResolvedProviderModel {
  providerId: string
  model: string
}

/**
 * Display-side mirror of the engine's provider resolution
 * (packages/backend/provider/provider-config.ts,
 * getEffectiveProviderConfig). The two MUST stay rule-for-rule identical —
 * this helper decides what the model picker SHOWS, the engine decides what
 * requests SEND, and any divergence means the UI displays one provider
 * while the request goes to another (which is exactly how a "selected
 * deepseek, billed on codex" incident happens).
 *
 * The rule: a model the user PINNED on this session wins; then the session
 * agent's model binding; then session.lastProvider (which is also stamped
 * automatically by every assistant message, hence ranked below the binding);
 * then the SPACE default (batch B9); then the global selection. lastModel falls
 * back to the provider's configured default. No inference, no repair of
 * mismatched pairs.
 *
 * 空间默认(批 B9)插在 **agent 绑定 / 会话之下、全局之上**:agent 与会话都是
 * 「这一条会话的选择」,比「这个空间的缺省」更具体。引擎侧的同一格在
 * `providers/provider-config.ts` 的 `getEffectiveProviderConfig` —— 两边必须
 * 逐条同形,不然选择器显示一个、请求发往另一个。
 */
export function resolveProviderModelSelection({
  settings,
  session,
  agentModel,
  spaceDefault,
}: ResolveProviderModelOptions): ResolvedProviderModel {
  const sessionProviderId = session?.lastProvider || ''
  const sessionSelection = (): ResolvedProviderModel | null => {
    if (!sessionProviderId) return null
    const providerConfig = settings?.ai?.providers?.[sessionProviderId]
    if (!providerConfig) return null
    return {
      providerId: sessionProviderId,
      model: session?.lastModel || providerConfig.model || '',
    }
  }

  if (session?.modelPinned) {
    const pinned = sessionSelection()
    if (pinned) return pinned
  }

  const agentProviderId = agentModel?.providerId || ''
  if (agentProviderId) {
    const providerConfig = settings?.ai?.providers?.[agentProviderId]
    if (providerConfig) {
      return {
        providerId: agentProviderId,
        model: agentModel?.modelId || providerConfig.model || '',
      }
    }
  }

  const fromSession = sessionSelection()
  if (fromSession) return fromSession

  const spaceProviderId = spaceDefault?.provider || ''
  if (spaceProviderId) {
    const providerConfig = settings?.ai?.providers?.[spaceProviderId]
    // 指着一个 settings 里不存在的 provider 时落到全局 —— 与 agent / session
    // 两支同一条不变式。「这个空间没配凭证」是另一回事:那一档 provider 配置在,
    // 选择器照列,起流时由 B3 的隔离闸诚实拦截。
    if (providerConfig) {
      return {
        providerId: spaceProviderId,
        model: spaceDefault?.model || providerConfig.model || '',
      }
    }
  }

  const globalProviderId = settings?.ai?.provider || ''
  const globalModel = globalProviderId
    ? settings?.ai?.providers?.[globalProviderId]?.model || ''
    : ''
  return { providerId: globalProviderId, model: globalModel }
}
