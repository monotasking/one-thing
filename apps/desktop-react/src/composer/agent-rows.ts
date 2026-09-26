import type { ACPAgentState } from '@shared/ipc/acp'
import type { ModelSelection, ProviderGroup } from '../data/models-source'
import { sourceOf } from '../data/acp-agents-source'
import { isAgentProviderId, LOCAL_MODE_KINDS } from '../providers/families'

/**
 * **模型选择器里的「Agent」那一组**(2026-09-26 用户裁定:「ACP agent 不许被画成普通模型」)。
 *
 * 从前 ACP 的 agent 是「ACP」那家 provider 底下的几行模型:名字是 agent id、行尾一格
 * 「128k」(后端编的窗口)、有没有这一行由模型设置页的 `selectedModels` 说了算。三件都错:
 * 它不是一型模型、它没有窗口、它在不在由它自己的名册(设置页「Agent」那一页)说了算。
 *
 * 所以这只纯函数把组表拆成两半:
 *  · **模型的组**:原样,减掉 agent 那几行;
 *  · **Agent 一组**:ACP 那一半来自名册(`acp.getAgents`,启用着的那些 —— 没装的也列,
 *    置灰);目录说是 agent 的行(`ModelOption.kind === 'agent'`)按同一种画法并进来。
 *    (A6-b 起本地 CLI 那一家 `claude-code-agent` 退役,Claude Code 就是名册里的一台。)
 *
 * 判据只读**种类**,不读 provider id 字串:一行算不算 agent = 它的家是 agent 那一种
 * (`isAgentProviderId`,名字只在 `LOCAL_MODE_KINDS` 那一处点)或目录说它是
 * (`ModelOption.kind === 'agent'`,后端 `providerMetadata.acp.agent`)。
 *
 * 选中一行走的仍是原来那条路(`chooseModel(provider, model)`:ACP 的 provider + agent id),
 * 数据模型一格不动。
 */

export type AgentRowStatus = 'missing' | 'ready' | 'running'

export interface AgentPickRow {
  /** 选中时交给 `chooseModel` 的那一对。 */
  providerId: string
  model: string
  /** 行上那一句名字。 */
  label: string
  /** 方图标查表用的键(`ProviderGlyph` 的 `familyId`);查不到就画首字母。 */
  glyphKey: string
  custom: boolean
  /** ACP 那一半才有:名册那一行(来处 / 探测 / 装法都读它)。 */
  agent?: ACPAgentState
  /**
   * 一个状态字。不知道就缺席(不编):本地 CLI 那一半今天没有探测;ACP 还没探测过的也是。
   * 登录态归 A3-c,今天不出现「未登录」。
   */
  status?: AgentRowStatus
}

export interface PickerSections {
  modelGroups: ProviderGroup[]
  agentRows: AgentPickRow[]
}

function agentStatusOf(agent: ACPAgentState): AgentRowStatus | undefined {
  if (agent.status === 'connected') return 'running'
  if (agent.detect === undefined) return undefined
  return agent.detect.installed ? 'ready' : 'missing'
}

function nameOf(agent: ACPAgentState): string {
  return agent.config.name || agent.manifest?.name || agent.config.id
}

/** 这台 agent 认不认这个 id(旧 id 走种子的 `aliases`,与后端同一张表)。 */
function answersTo(agent: ACPAgentState, id: string): boolean {
  return agent.config.id === id || (agent.manifest?.aliases ?? []).includes(id)
}

export function splitPickerSections(input: {
  /** `filterProviders(buildProviderGroups(...), query)` 的结果(已按检索词筛过)。 */
  groups: readonly ProviderGroup[]
  /** 名册里有没有 ACP 那家(`providers` 全集里找,不经 `enabled` / `selectedModels` 那两道闸)。 */
  acpProviderId: string | undefined
  /** `acp.getAgents` 的名册;还没到 = undefined(那一半先空着,不编)。 */
  agents: readonly ACPAgentState[] | undefined
  current: ModelSelection | null
  query: string
}): PickerSections {
  const { groups, acpProviderId, agents, current, query } = input
  const kw = query.trim().toLowerCase()
  const modelGroups: ProviderGroup[] = []
  const agentRows: AgentPickRow[] = []

  for (const g of groups) {
    // ACP 那家的行不从 `selectedModels` 来,从名册来(下面那一段)。
    if (g.id === acpProviderId) continue
    const agentFamily = isAgentProviderId(g.id)
    const models = agentFamily ? [] : g.models.filter((m) => m.kind !== 'agent')
    for (const m of g.models) {
      if (!agentFamily && m.kind !== 'agent') continue
      agentRows.push({
        providerId: g.id,
        model: m.model,
        // 缺省那一型的 id 与家同名时那一行说家的名字;其余行说模型 id。
        label: m.model === g.id ? g.provider : m.model,
        glyphKey: g.id,
        custom: false,
      })
    }
    if (models.length > 0) modelGroups.push({ ...g, models })
  }

  if (acpProviderId && agents) {
    for (const agent of agents) {
      const isCurrent =
        current !== null && current.provider === acpProviderId && answersTo(agent, current.model)
      // 名册里关掉的不列 —— 除非它正是这条会话此刻用着的那一台(列表里找不到当前选中是更坏的谎)。
      if (!agent.config.enabled && !isCurrent) continue
      const label = nameOf(agent)
      if (kw && !label.toLowerCase().includes(kw) && !agent.config.id.includes(kw)) continue
      agentRows.push({
        providerId: acpProviderId,
        // 当前选中存的若是旧 id,行上交的也是那个旧 id —— 否则选中态对不上。
        model: isCurrent ? current!.model : agent.config.id,
        label,
        glyphKey: agent.manifest?.icon ?? agent.config.id,
        custom: sourceOf(agent) === 'user',
        agent,
        status: agentStatusOf(agent),
      })
    }
  }

  return { modelGroups, agentRows }
}

/**
 * 一个 agent id 在人眼里叫什么:名册里认这个 id 的那一台(旧 id 走 `aliases`)的名字,
 * 与 Agent 那一组行上写的是同一句;名册还没到或没有这一台就照实写 id —— 不编名字。
 */
export function agentDisplayNameOf(agents: readonly ACPAgentState[] | undefined, id: string): string {
  const agent = agents?.find((entry) => answersTo(entry, id))
  return agent ? nameOf(agent) : id
}

/** 名册全集里 ACP 那一家的 id(名字只在 `LOCAL_MODE_KINDS` 点一次)。 */
export function acpProviderIdOf(providers: readonly { id: string }[]): string | undefined {
  return providers.find((p) => LOCAL_MODE_KINDS[p.id] === 'acp')?.id
}
