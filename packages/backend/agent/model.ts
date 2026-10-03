/**
 * Agent 域模型的投影层(M1,docs/design/agent-domain-model.md §2)。
 *
 * `OnethingAgentDefinition` 是存储真源(agents.json 一行);这里的三个投影是
 * 访问路径,不是新真源——调用方按需取面,自文档化「我要的是哪一面」:
 * roster/联系人拿身份面,prompt builder/引擎拿心智面,执行守卫拿能力面。
 * 在场面(Presence)永不落库、永远现算,不在此文件(A3 的 presence.ts)。
 *
 * MIRROR NOTE: `isColleague` / `isActiveAgent` 在 shared 包的 IPC 契约层
 * (agents 契约文件)有一份语义相同的实现供 renderer 使用——产品层禁止
 * import 那一层(boundary checker 强制),故两份实现;
 * 以 `__tests__/model.test.ts` 的镜像测试盯住。
 */
import type {
  OnethingAgentDefinition,
  OnethingAgentExecutor,
  OnethingAgentKind,
  OnethingAgentModelBinding,
  OnethingAgentStatus,
} from './store.js'
import { resolveAgentExecutorSelection } from './executor/selection.js'

/**
 * 身份面:被引用的最小面。变更要广播(署名/联系人跟随),retired 后永久保留
 * (墓碑)。消费方:联系人区、roster、签名气泡、履历页、墓碑渲染。
 * kind/status 在投影里已解析缺省(colleague/active),消费方不用再各自兜底。
 */
export interface OnethingAgentIdentity {
  id: string
  name: string
  title?: string
  avatar?: string
  avatarImage?: string
  color?: string
  description?: string
  kind: OnethingAgentKind
  status: OnethingAgentStatus
}

/**
 * 心智面:驱动一个回合时装配的东西。消费方:prompt builder、coordinator
 * 模型盖章、(前瞻)外部连接器。executor 已解析缺省({ type: 'native' })。
 */
export interface OnethingAgentMind {
  systemPrompt: string
  model?: OnethingAgentModelBinding
  executor: OnethingAgentExecutor
}

/**
 * 能力面:执行期守卫。经 resolveAgentProfile 与 session/settings 复合成
 * EffectiveAgentProfile(app/agents/profile.ts,已落地,复合链不动)。
 */
export interface OnethingAgentCapability {
  tools?: string[]
  toolGrants?: string[]
  permissionMode?: string
  maxTurns?: number
}

/** 身份面投影。 */
export function agentIdentity(agent: OnethingAgentDefinition): OnethingAgentIdentity {
  return {
    id: agent.id,
    name: agent.name,
    title: agent.title,
    avatar: agent.avatar,
    avatarImage: agent.avatarImage,
    color: agent.color,
    description: agent.description,
    kind: agent.kind ?? 'colleague',
    status: agent.status ?? 'active',
  }
}

/**
 * 心智面投影。
 *
 * executor 从「存了什么就是什么、没存就算 native」改成**解析结果**(E0 接线,
 * claude-code-integration-v2 §3):显式字段优先,缺省由 model.providerId 推导。
 * 从前那个 `?? { type: 'native' }` 会对 Iris(providerId 是外部执行体、
 * executor 字段为空)撒谎说「本引擎驱动」——字段没接线时无人消费所以看不出来,
 * 一接线就是个陷阱。
 */
export function agentMind(agent: OnethingAgentDefinition): OnethingAgentMind {
  return {
    systemPrompt: agent.systemPrompt,
    model: agent.model,
    executor: resolveAgentExecutorSelection(agent),
  }
}

/** 能力面投影。 */
export function agentCapability(agent: OnethingAgentDefinition): OnethingAgentCapability {
  return {
    tools: agent.tools,
    toolGrants: agent.toolGrants,
    permissionMode: agent.permissionMode,
    maxTurns: agent.maxTurns,
  }
}

/**
 * 社交面判定(M2):联系人区、roster 候选、群成员选择器、AgentSelector 只收
 * colleague。缺省 kind 按 colleague 解释(旧 agents.json 无此字段)。
 */
export function isColleague(agent: Pick<OnethingAgentDefinition, 'kind'>): boolean {
  return (agent.kind ?? 'colleague') === 'colleague'
}

/** 生命周期判定(M3):缺省 status 按 active 解释。 */
export function isActiveAgent(agent: Pick<OnethingAgentDefinition, 'status'>): boolean {
  return (agent.status ?? 'active') === 'active'
}

/**
 * 墓碑文案(M4)——**双口径,单一属主**(架构审查 B8)。
 *
 * 「名字不可考的这一位」在系统里有两句话,不是笔误,是两个受众:
 *
 *  - `'ui'` → 「已注销」。人看的:成员条、看板菜单、署名、Agent 管理页。用户
 *    删过这个人,「注销」对应的正是 TA 按下的那个动作。
 *  - `'model'` → 「前成员」。模型看的:信封的 `from`、意愿判定窗口的行首、日
 *    摘要的署名。这里要说的是**与这间房的关系**(它曾经在,现在不在),而不是
 *    账号状态 —— 说「已注销」会让模型以为这是个可操作的状态,进而去试着"恢复"
 *    或者绕开它。
 *
 * 之所以要一个属主:此前这两句话在 8 处各写各的字面量,于是"改词"这件事等于
 * "grep 得干净",而 grep 不干净的那一处会安静地留在真机上。双口径是设计,
 * 8 份字面量不是。
 */
export const AGENT_TOMBSTONE_UI_NAME = '已注销'

/** 模型面的墓碑口径。见 `AGENT_TOMBSTONE_UI_NAME` 的双口径说明。 */
export const AGENT_TOMBSTONE_MODEL_NAME = '前成员'

/** 受众 → 墓碑文案。加第三种受众之前先读上面那段为什么是两种。 */
export function agentTombstoneLabel(audience: 'ui' | 'model'): string {
  return audience === 'model' ? AGENT_TOMBSTONE_MODEL_NAME : AGENT_TOMBSTONE_UI_NAME
}
