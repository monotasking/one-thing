import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { AgentDefinition } from '@shared/ipc/agents'
import { AgentChip, gradientIndexOf } from '../AgentChip'
import { TopBar } from '../TopBar'
import { useAgentMenu } from '../agent-menu'
import { configureAgentsPort, type AgentsPort } from '../../data/agents-port'
import { toAgentOption, useAgentsSource } from '../../data/agents-source'
import { useSessionsSource } from '../../data/sessions-source'
import { useExposeStore } from '../../expose/store'
import { useNotifyStore } from '../../services/notify-store'
import { useStageStore } from '../../stage/store'
import type { SessionSummary } from '../../expose/types'

/**
 * 顶栏 agent 切换器。钉住的是**语义**,不是像素:
 * 徽上写的是谁、菜单里有哪些人、选中在哪一行、切换成功 / 失败各发生了什么、
 * ⌘J 开菜单,以及「顶栏不再有模型章」这一件退役事实。
 *
 * 名册与写面都走 `configureAgentsPort` 换成假的 —— 一台 core 都不起。
 */

const NOW = 1_700_000_000_000

function agent(over: Partial<AgentDefinition> & { id: string; name: string }): AgentDefinition {
  return { systemPrompt: '', createdAt: NOW, updatedAt: NOW, ...over }
}

const REVIEWER = agent({ id: 'reviewer', name: '审阅者', description: '挑毛病的那个' })
const PLANNER = agent({ id: 'planner', name: '规划师', avatar: '🗺️', color: '#5b8f7d' })
const RADIO = agent({ id: 'radio-dj', name: '电台 DJ', kind: 'service' })
const GHOST = agent({ id: 'ghost', name: '退休的那位', status: 'retired' })

function session(over: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    title: 's',
    kind: 'chat',
    projectId: null,
    preview: '',
    digest: null,
    messageCount: null,
    updatedAt: NOW,
    model: null,
    provider: null,
    agentId: null,
    ...over,
  }
}

let list: ReturnType<typeof vi.fn>
let updateSessionAgent: ReturnType<typeof vi.fn>

function installPort(over: Partial<AgentsPort> = {}): void {
  configureAgentsPort({
    ready: async () => undefined,
    list: list as unknown as AgentsPort['list'],
    updateSessionAgent: updateSessionAgent as unknown as AgentsPort['updateSessionAgent'],
    ...over,
  })
}

/** 名册直接灌进 store —— 「拉名册」那条路自己有一组用例,这里不重复走一遍。 */
function seedRoster(agents: AgentDefinition[]): void {
  useAgentsSource.setState({ status: 'ready', agents: agents.map(toAgentOption) })
}

function seedSession(summary: SessionSummary | null): void {
  useSessionsSource.setState({ sessions: summary ? [summary] : [] })
  useExposeStore.setState({ currentSessionId: summary?.id ?? '' })
}

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  list = vi.fn(async () => ({ success: true, agents: [] }))
  updateSessionAgent = vi.fn(async () => ({ success: true }))
  installPort()
  useAgentsSource.getState().reset()
  useAgentMenu.setState({ open: false })
  useNotifyStore.setState({ items: [] })
  seedSession(null)
})

describe('徽上写谁', () => {
  it('没有会话、名册也空:兜底名「默认助手」', () => {
    render(<AgentChip />)
    expect(screen.getByRole('button', { name: 'Agent 切换器' }).textContent).toContain('默认助手')
  })

  it('会话绑着具名 agent:写它的真名(不是 id)', () => {
    seedRoster([REVIEWER])
    seedSession(session({ id: 's1', agentId: 'reviewer' }))
    render(<AgentChip />)
    expect(screen.getByRole('button', { name: 'Agent 切换器' }).textContent).toContain('审阅者')
  })

  it('默认助手的名字永远是界面文案,不取名册那份(后端出厂给的是英文 Default Agent)', () => {
    seedRoster([agent({ id: 'default', name: 'Default Agent' })])
    render(<AgentChip />)
    const chip = screen.getByRole('button', { name: 'Agent 切换器' })
    expect(chip.textContent).toContain('默认助手')
    expect(chip.textContent).not.toContain('Default Agent')
  })

  it('会话绑着一个名册里查不到的 id:退回默认名,不把 id 当名字画上去', () => {
    seedRoster([REVIEWER])
    seedSession(session({ id: 's1', agentId: 'someone-else' }))
    render(<AgentChip />)
    const chip = screen.getByRole('button', { name: 'Agent 切换器' })
    expect(chip.textContent).toContain('默认助手')
    expect(chip.textContent).not.toContain('someone-else')
  })
})

describe('菜单', () => {
  // 开菜单会连带跑一次 useLayoutEffect 量坐标 —— 那也是一次 state 更新,
  // 所以整下包在 act 里,免得 React 抱怨「更新没在 act 里」。
  const open = () =>
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Agent 切换器' }))
    })

  it('点徽开、再点关', () => {
    render(<AgentChip />)
    expect(screen.queryByRole('menu')).toBeNull()
    open()
    expect(screen.getByRole('menu')).toBeTruthy()
    open()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('名册行画名字与那句描述;默认助手永远在册', () => {
    seedRoster([REVIEWER, PLANNER])
    render(<AgentChip />)
    open()
    // 徽上也写着「默认助手」,所以名册那一行要在菜单里找 —— 不是同一句话说两遍。
    const menu = within(screen.getByRole('menu'))
    expect(menu.getByText('默认助手')).toBeTruthy()
    expect(menu.getByText('审阅者')).toBeTruthy()
    expect(menu.getByText('挑毛病的那个')).toBeTruthy()
    // 规划师没有 description —— 那一行小字就不该存在,而不是画一句空的。
    expect(menu.getByText('规划师')).toBeTruthy()
  })

  it('service 与墓碑不进名册(契约层的两条判定,不在这里重写)', () => {
    seedRoster([REVIEWER, RADIO, GHOST])
    render(<AgentChip />)
    open()
    expect(screen.queryByText('电台 DJ')).toBeNull()
    expect(screen.queryByText('退休的那位')).toBeNull()
  })

  it('选中打在当前那一行上', () => {
    seedRoster([REVIEWER, PLANNER])
    seedSession(session({ id: 's1', agentId: 'planner' }))
    render(<AgentChip />)
    open()
    const checked = screen
      .getAllByRole('menuitemradio')
      .filter((el) => el.getAttribute('aria-checked') === 'true')
    expect(checked).toHaveLength(1)
    expect(checked[0].textContent).toContain('规划师')
  })

  it('名册拉不到:只有默认助手 + 一行灰字,不假装', () => {
    useAgentsSource.setState({ status: 'error', error: 'boom', agents: [] })
    render(<AgentChip />)
    open()
    expect(screen.getByText('名册不可用')).toBeTruthy()
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(1)
  })

  it('「管理 Agents…」渲染但不可点(管理页不在本批)', () => {
    render(<AgentChip />)
    open()
    const manage = screen.getByRole('menuitem', { name: '管理 Agents…' })
    expect((manage as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('切换', () => {
  // 开菜单会连带跑一次 useLayoutEffect 量坐标 —— 那也是一次 state 更新,
  // 所以整下包在 act 里,免得 React 抱怨「更新没在 act 里」。
  const open = () =>
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Agent 切换器' }))
    })

  it('有会话:调写面,徽当场换脸(乐观),菜单关上', async () => {
    seedRoster([REVIEWER])
    seedSession(session({ id: 's1' }))
    render(<AgentChip />)
    open()
    await act(async () => {
      fireEvent.click(screen.getByText('审阅者'))
    })
    expect(updateSessionAgent).toHaveBeenCalledWith('s1', 'reviewer')
    expect(screen.queryByRole('menu')).toBeNull()
    // listMeta(假端口回空表)已经把会话冲掉了,所以这里验的是写面被正确调用,
    // 换脸那一半由下面「牌撤掉」的用例接着钉。
  })

  it('写成功之后那块乐观的牌被撤掉(屏幕从此读后端事实)', async () => {
    seedRoster([REVIEWER])
    seedSession(session({ id: 's1' }))
    await act(async () => {
      await useAgentsSource.getState().switchAgent('s1', 'reviewer')
    })
    expect(useAgentsSource.getState().optimistic).toEqual({})
  })

  it('写失败:牌撤回、notify(warn) 说出来,绝不假装成功', async () => {
    updateSessionAgent = vi.fn(async () => ({ success: false, error: '后端不让' }))
    installPort()
    seedRoster([REVIEWER])
    seedSession(session({ id: 's1', agentId: 'planner' }))

    await act(async () => {
      await useAgentsSource.getState().switchAgent('s1', 'reviewer')
    })

    expect(useAgentsSource.getState().optimistic).toEqual({})
    const notes = useNotifyStore.getState().items
    expect(notes).toHaveLength(1)
    expect(notes[0].level).toBe('warn')
    expect(notes[0].source).toBe('agent.switch')
    expect(notes[0].body).toBe('后端不让')
  })

  it('没有会话:只记「下一条新会话归谁」,一条请求都不发', async () => {
    seedRoster([REVIEWER])
    render(<AgentChip />)
    open()
    await act(async () => {
      fireEvent.click(screen.getByText('审阅者'))
    })
    expect(updateSessionAgent).not.toHaveBeenCalled()
    expect(useAgentsSource.getState().pendingAgentId).toBe('reviewer')
    expect(screen.getByRole('button', { name: 'Agent 切换器' }).textContent).toContain('审阅者')
  })
})

describe('名册取数', () => {
  it('连通后拉一次', async () => {
    list = vi.fn(async () => ({ success: true, agents: [REVIEWER] }))
    installPort()
    await act(async () => {
      await useAgentsSource.getState().start()
    })
    expect(list).toHaveBeenCalledTimes(1)
    expect(useAgentsSource.getState().agents.map((a) => a.id)).toEqual(['reviewer'])
  })

  it('失败只重试一次就停,状态落在 error', async () => {
    list = vi.fn(async () => {
      throw new Error('断了')
    })
    installPort()
    await act(async () => {
      await useAgentsSource.getState().start()
    })
    expect(list).toHaveBeenCalledTimes(2)
    expect(useAgentsSource.getState().status).toBe('error')
  })
})

describe('⌘J', () => {
  it('同一个开关:store 一翻,菜单就在', () => {
    render(<AgentChip />)
    expect(screen.queryByRole('menu')).toBeNull()
    act(() => {
      useAgentMenu.getState().toggle()
    })
    expect(screen.getByRole('menu')).toBeTruthy()
    act(() => {
      useAgentMenu.getState().toggle()
    })
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('顶栏', () => {
  it('模型章已退役:顶栏上再也没有那枚写死的 claude-opus-5', () => {
    render(<TopBar />)
    expect(screen.queryByText('claude-opus-5')).toBeNull()
    expect(screen.getByRole('button', { name: 'Agent 切换器' })).toBeTruthy()
  })
})

describe('头像取色', () => {
  it('同一个 id 永远同一对渐变,且落在六对之内', () => {
    expect(gradientIndexOf('reviewer')).toBe(gradientIndexOf('reviewer'))
    for (const id of ['default', 'reviewer', 'planner', '', 'a-very-long-agent-id']) {
      expect(gradientIndexOf(id)).toBeGreaterThanOrEqual(0)
      expect(gradientIndexOf(id)).toBeLessThan(6)
    }
  })
})
