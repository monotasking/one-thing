/**
 * A0 (agent-domain-model.md M1/M2/M3/M7): the three projections and the two
 * classification predicates — including the mirror discipline with the shared
 * layer. The product layer must not import `@shared/ipc` in src, so renderer
 * and product each carry an implementation; this test (tests are outside the
 * boundary rules) pins the two to the same semantics.
 */
import { describe, expect, it } from 'vitest'
import {
  AGENT_TOMBSTONE_MODEL_NAME,
  AGENT_TOMBSTONE_UI_NAME,
  agentCapability,
  agentIdentity,
  agentMind,
  agentTombstoneLabel,
  isActiveAgent,
  isColleague,
} from '../model.js'
import type { OnethingAgentDefinition } from '../agent-store.js'
import {
  isActiveAgent as sharedIsActiveAgent,
  isColleague as sharedIsColleague,
  type AgentDefinition,
} from '@shared/ipc/agents.js'

function fullAgent(): OnethingAgentDefinition {
  return {
    id: 'agent-a',
    name: '小李',
    systemPrompt: 'you are 小李',
    tools: ['bash'],
    createdAt: 1,
    updatedAt: 2,
    title: '工程师',
    avatar: '🛠️',
    avatarImage: 'abc.png',
    color: '#f00',
    description: '写代码',
    model: { providerId: 'claude', modelId: 'sonnet' },
    toolGrants: ['collab-room'],
    permissionMode: 'ask',
    maxTurns: 8,
    kind: 'colleague',
    status: 'active',
    executor: { type: 'external', connectorId: 'acp' },
  }
}

describe('classification predicates (M2/M3)', () => {
  it('interprets an absent kind as colleague and an absent status as active', () => {
    expect(isColleague({})).toBe(true)
    expect(isActiveAgent({})).toBe(true)
  })

  it('recognizes explicit values', () => {
    expect(isColleague({ kind: 'colleague' })).toBe(true)
    expect(isColleague({ kind: 'service' })).toBe(false)
    expect(isActiveAgent({ status: 'active' })).toBe(true)
    expect(isActiveAgent({ status: 'retired' })).toBe(false)
  })

  it('mirrors the shared-layer predicates exactly (renderer parity)', () => {
    const cases = [
      {},
      { kind: 'colleague' as const },
      { kind: 'service' as const },
      { status: 'active' as const },
      { status: 'retired' as const },
      { kind: 'service' as const, status: 'retired' as const },
    ]
    for (const agent of cases) {
      expect(sharedIsColleague(agent)).toBe(isColleague(agent))
      expect(sharedIsActiveAgent(agent)).toBe(isActiveAgent(agent))
    }
  })
})

/**
 * 逐字段镜像的**字段名**那一半(架构审查 B8)。
 *
 * 谓词对拍已经盯住了"行为跑偏";跑偏之前更常见的是**字段加在一侧**:
 * `OnethingAgentDefinition`(产品层真源,agents.json 一行)与 `AgentDefinition`
 * (shared 的 IPC 契约)必须逐字段同构 —— `app/agents/store.ts` 的
 * `as AgentDefinition` cast 全靠这一点成立,而 cast 是不会报错的。
 *
 * 两张表都写成 `Record<keyof …, true>`:
 *  - 一侧**加**字段 → 那张表少一个键 → 类型红(缺属性);
 *  - 一侧**删**字段 → 那张表多一个键 → 类型红(多余属性);
 *  - 两张表不一致 → 下面的断言红。
 *
 * 于是"加一个字段忘了改另一侧"从"下次谁读到谁发现"变成一条红线。
 */
const RUNTIME_FIELDS: Record<keyof OnethingAgentDefinition, true> = {
  id: true,
  name: true,
  systemPrompt: true,
  tools: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
  title: true,
  avatar: true,
  avatarImage: true,
  color: true,
  description: true,
  model: true,
  toolGrants: true,
  permissionMode: true,
  maxTurns: true,
  kind: true,
  status: true,
  executor: true,
}

const SHARED_FIELDS: Record<keyof AgentDefinition, true> = {
  id: true,
  name: true,
  systemPrompt: true,
  tools: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
  title: true,
  avatar: true,
  avatarImage: true,
  color: true,
  description: true,
  model: true,
  toolGrants: true,
  permissionMode: true,
  maxTurns: true,
  kind: true,
  status: true,
  executor: true,
}

describe('mirror discipline: OnethingAgentDefinition ↔ shared AgentDefinition', () => {
  it('carries the same field names on both sides (the `as AgentDefinition` cast rests on this)', () => {
    expect(Object.keys(RUNTIME_FIELDS).sort()).toEqual(Object.keys(SHARED_FIELDS).sort())
  })
})

/**
 * 墓碑双口径(M4):UI 面「已注销」是用户按下的那个动作,模型面「前成员」说的
 * 是与房间的关系。两句话都 pin 住 —— 它们会被写进转录与真机截图,不是内部标识。
 */
describe('tombstone labels (M4)', () => {
  it('keeps the two audiences distinct and stable', () => {
    expect(agentTombstoneLabel('ui')).toBe('已注销')
    expect(agentTombstoneLabel('model')).toBe('前成员')
    expect(AGENT_TOMBSTONE_UI_NAME).toBe(agentTombstoneLabel('ui'))
    expect(AGENT_TOMBSTONE_MODEL_NAME).toBe(agentTombstoneLabel('model'))
  })
})

describe('projections (M1)', () => {
  it('identity carries the referenced face only — no mind or capability fields', () => {
    const identity = agentIdentity(fullAgent())
    expect(identity).toEqual({
      id: 'agent-a',
      name: '小李',
      title: '工程师',
      avatar: '🛠️',
      avatarImage: 'abc.png',
      color: '#f00',
      description: '写代码',
      kind: 'colleague',
      status: 'active',
    })
    expect(identity).not.toHaveProperty('systemPrompt')
    expect(identity).not.toHaveProperty('tools')
  })

  it('mind carries what a turn assembles — prompt, model binding, executor', () => {
    expect(agentMind(fullAgent())).toEqual({
      systemPrompt: 'you are 小李',
      model: { providerId: 'claude', modelId: 'sonnet' },
      executor: { type: 'external', connectorId: 'acp' },
    })
  })

  it('capability carries the execution guards', () => {
    expect(agentCapability(fullAgent())).toEqual({
      tools: ['bash'],
      toolGrants: ['collab-room'],
      permissionMode: 'ask',
      maxTurns: 8,
    })
  })

  it('resolves the defaults for a legacy row: colleague, active, native executor', () => {
    const legacy: OnethingAgentDefinition = {
      id: 'old',
      name: 'Old',
      systemPrompt: '',
      createdAt: 1,
      updatedAt: 1,
    }
    const identity = agentIdentity(legacy)
    expect(identity.kind).toBe('colleague')
    expect(identity.status).toBe('active')
    expect(agentMind(legacy).executor).toEqual({ type: 'native' })
  })
})
