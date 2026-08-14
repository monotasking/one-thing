/**
 * A1 解析纪律的 renderer 镜像(M4,docs/design/agent-domain-model.md §4)。
 *
 * 后端三态分家之后,renderer 这一侧原来只有一个 `getAgent(id) || defaultAgent`
 * —— 一个未知 id 会被渲染成 default 的名字和头像。这一组盯住镜像后的分工:
 * `findAgent` 严格、`displayAgent` 给墓碑、`getAgent` 只剩「当前 persona」这类
 * 功能兜底场景,三者的形状与 runtime store 逐字对齐。
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentsStore } from '../agents'
import type { AgentDefinition } from '@shared/ipc'

const platformApiMock = vi.hoisted(() => ({}) as Record<string, unknown>)
// agents 域已迁到通用 RPC 通道(主线 T1 第二批):store 现在引的是壳外客户端,
// 不再是 platformApi 上的方法,所以打桩打这个模块。
const agentsApiMock = vi.hoisted(() => ({}) as Record<string, unknown>)

vi.mock('@/platform', () => ({ platformApi: platformApiMock }))
vi.mock('@/platform/agents-client', () => ({ agentsApi: agentsApiMock }))

function agent(overrides: Partial<AgentDefinition> & { id: string }): AgentDefinition {
  return {
    name: overrides.id,
    systemPrompt: '',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as AgentDefinition
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('agents store: 解析三态(M4 镜像)', () => {
  it('findAgent 严格查找:查无此人/空 id 都是 null', () => {
    const store = useAgentsStore()
    store.agents = [
      agent({ id: 'default', name: 'Default Agent', isDefault: true }),
      agent({ id: 'fe', name: '小李' }),
    ]

    expect(store.findAgent('fe')?.name).toBe('小李')
    expect(store.findAgent('ghost')).toBeNull()
    expect(store.findAgent('')).toBeNull()
    expect(store.findAgent(undefined)).toBeNull()
  })

  it('displayAgent 给身份投影,未知 id 给「已注销」墓碑而不是 default', () => {
    const store = useAgentsStore()
    store.agents = [
      agent({ id: 'default', name: 'Default Agent', isDefault: true }),
      agent({ id: 'fe', name: '小李', title: '前端', avatar: '🧑‍💻', systemPrompt: 'persona' }),
    ]

    const identity = store.displayAgent('fe')
    expect(identity).toMatchObject({ id: 'fe', name: '小李', title: '前端', kind: 'colleague', status: 'active' })
    // 身份面而已 —— 心智面不跟着出门。
    expect(identity).not.toHaveProperty('systemPrompt')

    expect(store.displayAgent('ghost')).toEqual({
      id: 'ghost',
      name: '已注销',
      kind: 'colleague',
      status: 'retired',
    })
    // retired 的人身份面照旧(A2 的灰显徽标读的就是这个 status)。
    store.agents = [...store.agents, agent({ id: 'gone', name: '老王', status: 'retired' })]
    expect(store.displayAgent('gone')).toMatchObject({ name: '老王', status: 'retired' })
  })

  it('getAgent 仍是功能兜底(composer 当前 persona),但只在这一种语义下用', () => {
    const store = useAgentsStore()
    store.agents = [
      agent({ id: 'default', name: 'Default Agent', isDefault: true }),
      agent({ id: 'fe', name: '小李' }),
    ]

    expect(store.getAgent('fe')?.id).toBe('fe')
    // 无 agentId 的会话 = default persona,这是功能语义,保留。
    expect(store.getAgent(undefined)?.id).toBe('default')
    expect(store.getAgent('ghost')?.id).toBe('default')
  })

  it('colleagues 只收 colleague 且 active(社交面名册)', () => {
    const store = useAgentsStore()
    store.agents = [
      agent({ id: 'default', name: 'Default Agent', isDefault: true }),
      agent({ id: 'fe', name: '小李' }),
      agent({ id: 'radio-dj', name: 'DJ', kind: 'service' }),
      agent({ id: 'gone', name: '老王', status: 'retired' }),
    ]

    expect(store.colleagues.map(item => item.id)).toEqual(['default', 'fe'])
  })

  it('activeAgents / retiredAgents 按 status 分栏,不掺 kind(管理面显示全部)', () => {
    const store = useAgentsStore()
    store.agents = [
      agent({ id: 'fe', name: '小李' }),
      agent({ id: 'radio-dj', name: 'DJ', kind: 'service' }),
      agent({ id: 'gone', name: '老王', status: 'retired' }),
    ]

    expect(store.activeAgents.map(item => item.id)).toEqual(['fe', 'radio-dj'])
    expect(store.retiredAgents.map(item => item.id)).toEqual(['gone'])
  })
})

/**
 * A2 生命周期的 renderer 一侧(§3.2):后端决定「退休还是硬删」,store 照结果对账。
 * 退休回来的那一行必须**留在名册里**换成墓碑 —— 摘掉它就等于前端自己把历史署名
 * 和恢复入口一起抹了。
 */
describe('agents store: 退休 / 硬删 / 恢复', () => {
  it('retired:换成回传的墓碑并留在名册里,返回 outcome', async () => {
    const deleteAgent = vi.fn().mockResolvedValue({
      success: true,
      outcome: 'retired',
      agent: agent({ id: 'fe', name: '小李', status: 'retired' }),
    })
    const store = useAgentsStore()
    store.agents = [agent({ id: 'fe', name: '小李' })]
    agentsApiMock.deleteAgent = deleteAgent

    await expect(store.deleteAgent('fe')).resolves.toBe('retired')
    expect(store.agents.map(item => item.id)).toEqual(['fe'])
    expect(store.agents[0].status).toBe('retired')
    expect(store.colleagues).toEqual([])
  })

  it('deleted:从名册里真摘掉', async () => {
    agentsApiMock.deleteAgent = vi.fn().mockResolvedValue({ success: true, outcome: 'deleted' })
    const store = useAgentsStore()
    store.agents = [agent({ id: 'fe', name: '小李' })]

    await expect(store.deleteAgent('fe')).resolves.toBe('deleted')
    expect(store.agents).toEqual([])
  })

  it('restore:status 翻回 active,重回社交面名册', async () => {
    agentsApiMock.restoreAgent = vi.fn().mockResolvedValue({
      success: true,
      agent: agent({ id: 'fe', name: '小李', status: 'active' }),
    })
    const store = useAgentsStore()
    store.agents = [agent({ id: 'fe', name: '小李', status: 'retired' })]

    await store.restoreAgent('fe')
    expect(store.agents[0].status).toBe('active')
    expect(store.colleagues.map(item => item.id)).toEqual(['fe'])
  })

  it('后端拒绝(default 之类)时抛错,名册一字不动', async () => {
    agentsApiMock.deleteAgent = vi.fn().mockResolvedValue({
      success: false,
      error: 'Default Agent cannot be retired or deleted',
    })
    const store = useAgentsStore()
    store.agents = [agent({ id: 'default', name: 'Default Agent', isDefault: true })]

    await expect(store.deleteAgent('default')).rejects.toThrow('Default Agent cannot be retired or deleted')
    expect(store.agents.map(item => item.id)).toEqual(['default'])
  })
})
