import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionMeta } from '@shared/ipc/chat'
import { configureSessionsPort, type SessionsPort } from './sessions-port'
import { configureAgentsPort, type AgentsPort } from './agents-port'
import { useAgentsSource } from './agents-source'
import { useSessionsSource } from './sessions-source'
import { useChatSource } from './chat-source'
import { registerComposerFocus } from '../composer/focus'
import { useExposeStore } from '../expose/store'
import { initialExposeState } from '../expose/transitions'
import { useNotifyStore } from '../services/notify-store'
import { NOW, ONETHING_DIR, SESSION_META } from './__fixtures__/sessions'

/**
 * 建会话这条链路的判据 —— 全是纯逻辑,所以这里一台 core 都不起:两个端口都换成
 * 假的,断言的是「打了哪几发、按什么次序、失败之后屏幕上剩下什么」。
 *
 * 钉住的五件事:
 *  1. 建 = `sessions.create`,**不带 name / workspaceId**(默认名归后端);
 *  2. 落项目 = 建完再打一发 `updateWorkingDirectory`,而且只在有项目时打;
 *  3. 建完**同步重拉**列表 —— 进会话那一步要拿新会话去夹持焦点序列;
 *  4. `pendingAgentId` 被兑现并清空(agents-source 那条留账的结清);
 *  5. 失败:notify(error) + 形态一格不动。
 */

const NEW_ID = 'created-1'

let create: ReturnType<typeof vi.fn>
let updateWorkingDirectory: ReturnType<typeof vi.fn>
let listMeta: ReturnType<typeof vi.fn>
let updateSessionAgent: ReturnType<typeof vi.fn>
/** 建成之后线上多出来的那一条 —— 重拉之后列表里才会有它。 */
let extra: SessionMeta[]
let focused: number

function sessionsPortStub(): SessionsPort {
  return {
    ready: async () => undefined,
    listMeta: () => listMeta(),
    getSegments: async () => ({ success: true, segments: [] }),
    getMessagesPage: async () => ({ success: true, messages: [] }),
    getUserMarkers: async () => ({ success: true, markers: [] }),
    create: (request) => create(request),
    updateWorkingDirectory: (id, dir) => updateWorkingDirectory(id, dir),
    onSessionEvent: () => () => undefined,
    onSessionLifecycle: () => () => undefined,
  }
}

function agentsPortStub(): AgentsPort {
  return {
    ready: async () => undefined,
    list: async () => ({ success: true, agents: [] }),
    updateSessionAgent: (sessionId, agentId) => updateSessionAgent(sessionId, agentId),
  }
}

beforeEach(() => {
  extra = []
  focused = 0
  create = vi.fn(async () => ({ success: true, session: { id: NEW_ID } }))
  updateWorkingDirectory = vi.fn(async () => ({ success: true }))
  listMeta = vi.fn(async () => ({ success: true, sessions: [...SESSION_META, ...extra] }))
  updateSessionAgent = vi.fn(async () => ({ success: true }))
  configureSessionsPort(sessionsPortStub())
  configureAgentsPort(agentsPortStub())
  registerComposerFocus(() => void (focused += 1))
  useSessionsSource.getState().reset()
  useAgentsSource.getState().reset()
  // 建会话的编排点末尾会把聊天面开在新会话上(见下方那条用例),所以它也要归零。
  useChatSource.getState().reset()
  useNotifyStore.getState().clear()
  useExposeStore.setState({ ...initialExposeState })
})

afterEach(() => {
  registerComposerFocus(undefined)
  useSessionsSource.getState().reset()
  useAgentsSource.getState().reset()
  useChatSource.getState().reset()
  // 不还原成 undefined:那会让后面的用例掉回真 platform(见 test/setup.ts)。
  configureSessionsPort(sessionsPortStub())
  configureAgentsPort(agentsPortStub())
})

/** 线上「建成之后」的样子:列表里多一条,带着刚落下去的工作目录。 */
function landOnServer(workingDirectory?: string): void {
  extra = [
    {
      id: NEW_ID,
      name: 'New Chat',
      createdAt: NOW,
      updatedAt: NOW,
      ...(workingDirectory ? { workingDirectory } : {}),
    },
  ]
}

describe('sessions-source.create:两发请求,次序即语义', () => {
  it('不带项目时只建、不落目录;请求体是空的(默认名归后端)', async () => {
    landOnServer()
    const outcome = await useSessionsSource.getState().create(null)

    expect(outcome).toEqual({ ok: true, sessionId: NEW_ID })
    expect(create).toHaveBeenCalledWith({})
    expect(updateWorkingDirectory).not.toHaveBeenCalled()
  })

  it('带项目时建完再落一发工作目录', async () => {
    landOnServer(ONETHING_DIR)
    await useSessionsSource.getState().create(ONETHING_DIR)

    expect(updateWorkingDirectory).toHaveBeenCalledWith(NEW_ID, ONETHING_DIR)
  })

  it('建完**同步**重拉:回来的那一刻新会话已经在列表与分组里', async () => {
    landOnServer(ONETHING_DIR)
    await useSessionsSource.getState().create(ONETHING_DIR)

    expect(listMeta).toHaveBeenCalledTimes(1)
    expect(useSessionsSource.getState().sessions.some((s) => s.id === NEW_ID)).toBe(true)
    const group = useSessionsSource.getState().groups.find((g) => g.id === ONETHING_DIR)
    expect(group?.sessions.some((s) => s.id === NEW_ID)).toBe(true)
  })

  it('落目录失败不回滚:会话照样成立,但那句错要随结果交出去(不许无声)', async () => {
    landOnServer()
    updateWorkingDirectory.mockRejectedValueOnce(new Error('nope'))
    const outcome = await useSessionsSource.getState().create(ONETHING_DIR)

    expect(outcome).toEqual({ ok: true, sessionId: NEW_ID, workdirError: 'nope' })
  })

  it('落目录被后端拒(success:false)同样要说出去 —— 08-31 沙箱拒绝曾在这里无声蒸发', async () => {
    landOnServer()
    updateWorkingDirectory.mockResolvedValueOnce({
      success: false,
      error: 'Working directory must stay inside the workspace sandbox root.',
    })
    const outcome = await useSessionsSource.getState().create(ONETHING_DIR)

    expect(outcome).toEqual({
      ok: true,
      sessionId: NEW_ID,
      workdirError: 'Working directory must stay inside the workspace sandbox root.',
    })
  })

  it('后端说不行 → 把它那句话原样交出去,一次都不重拉', async () => {
    create.mockResolvedValueOnce({ success: false, error: '磁盘满了' })
    const outcome = await useSessionsSource.getState().create(null)

    expect(outcome).toEqual({ ok: false, error: '磁盘满了' })
    expect(listMeta).not.toHaveBeenCalled()
  })
})

describe('agents-source.applyPendingAgent:兑现一次就清账', () => {
  it('有预选的人 → 落盘并清空 pendingAgentId', async () => {
    await useAgentsSource.getState().switchAgent(null, 'reviewer')
    expect(useAgentsSource.getState().pendingAgentId).toBe('reviewer')

    await useAgentsSource.getState().applyPendingAgent(NEW_ID)

    expect(updateSessionAgent).toHaveBeenCalledWith(NEW_ID, 'reviewer')
    expect(useAgentsSource.getState().pendingAgentId).toBeNull()
  })

  it('没有预选的人 → 一发请求都不打', async () => {
    await useAgentsSource.getState().applyPendingAgent(NEW_ID)
    expect(updateSessionAgent).not.toHaveBeenCalled()
  })

  it('落盘失败照样清账(不留一块会连累下一条会话的牌),并 notify(warn)', async () => {
    await useAgentsSource.getState().switchAgent(null, 'reviewer')
    updateSessionAgent.mockResolvedValueOnce({ success: false, error: '查无此人' })

    await useAgentsSource.getState().applyPendingAgent(NEW_ID)

    expect(useAgentsSource.getState().pendingAgentId).toBeNull()
    const records = useNotifyStore.getState().items
    expect(records.some((r) => r.level === 'warn' && r.source === 'agent.switch')).toBe(true)
  })
})

describe('expose.newSession:唯一的建会话入口', () => {
  it('成功:进新会话 + 把光标交给输入框 + 兑现预选的 agent', async () => {
    landOnServer(ONETHING_DIR)
    await useAgentsSource.getState().switchAgent(null, 'reviewer')

    await useExposeStore.getState().newSession(ONETHING_DIR)
    // applyPendingAgent 是**不 await** 的一笔顺手账,让它的微任务跑完再断言。
    await Promise.resolve()
    await Promise.resolve()

    expect(useExposeStore.getState().currentSessionId).toBe(NEW_ID)
    expect(focused).toBe(1)
    expect(updateSessionAgent).toHaveBeenCalledWith(NEW_ID, 'reviewer')
  })

  it('失败:notify(error)、当前会话不动、**不碰输入框**', async () => {
    useExposeStore.setState({ currentSessionId: 'os-provider' })
    create.mockResolvedValueOnce({ success: false, error: '磁盘满了' })

    await useExposeStore.getState().newSession(null)

    expect(useExposeStore.getState().currentSessionId).toBe('os-provider')
    expect(focused).toBe(0)
    const record = useNotifyStore.getState().items.find((r) => r.source === 'session.create')
    expect(record?.level).toBe('error')
    expect(record?.body).toBe('磁盘满了')
  })

  it('一次一条:飞着的时候再按几下都当没按(⌘N 长按的自动重复)', async () => {
    landOnServer()
    const flights = [
      useExposeStore.getState().newSession(null),
      useExposeStore.getState().newSession(null),
      useExposeStore.getState().newSession(null),
    ]
    await Promise.all(flights)

    expect(create).toHaveBeenCalledTimes(1)
  })

  it('⌘N 那一条落在**当前会话的项目**下', async () => {
    useSessionsSource.setState({ status: 'ready' })
    await useSessionsSource.getState().refresh()
    useExposeStore.setState({ currentSessionId: 'os-provider' })
    landOnServer(ONETHING_DIR)

    await useExposeStore.getState().newSessionInCurrentProject()

    expect(updateWorkingDirectory).toHaveBeenCalledWith(NEW_ID, ONETHING_DIR)
  })

  it('没有当前会话时不猜一个项目 —— 建出来的不属于任何项目', async () => {
    landOnServer()
    await useExposeStore.getState().newSessionInCurrentProject()

    expect(updateWorkingDirectory).not.toHaveBeenCalled()
  })

  /*
   * 首开草稿态那条路(08-31 用户拍板)要的两件事,都在这里钉住。
   *
   * 平时没人在编排点里显式开聊天面 —— ChatStream 有个 effect 盯着「当前会话」,
   * 换一条它就 open 一次。但那个 effect 要等 React 提交完那一帧才跑,而
   * 「建完就把这句话发出去」等不了:发送读的是 chat-source 里的当前会话。
   * 所以编排点自己开一次,并且**回来的那一刻**它已经开好了。
   */
  it('回来的那一刻:聊天面已经开在这条新会话上,id 也交到了调用方手里', async () => {
    landOnServer()

    const sessionId = await useExposeStore.getState().newSession(null)

    expect(sessionId).toBe(NEW_ID)
    expect(useChatSource.getState().sessionId).toBe(NEW_ID)
  })

  it('失败 / 被单飞闸挡下时交出 undefined —— 调用方据此什么都不做', async () => {
    create.mockResolvedValueOnce({ success: false, error: '磁盘满了' })
    expect(await useExposeStore.getState().newSession(null)).toBeUndefined()

    landOnServer()
    const [first, second] = await Promise.all([
      useExposeStore.getState().newSession(null),
      useExposeStore.getState().newSession(null),
    ])
    expect(first).toBe(NEW_ID)
    expect(second).toBeUndefined()
  })
})
