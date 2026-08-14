/**
 * 会话目标域，端到端穿过 dispatcher。
 *
 * 被拔掉的 `apps/electron/src/main/ipc/goal.ts` 里藏着两条**只写在注释里**的
 * 规矩，搬家时最容易丢，所以这里逐条钉住：
 *
 *  1. create 不 kick（第一次驱动是渲染层那条可见的 'goal-set' 用户消息）；
 *  2. 只有显式 resume（status:'active'）才 kick，改预算 / 改目标不许自己起跑。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const goals = vi.hoisted(() => ({
  getGoal: vi.fn(),
  getGoals: vi.fn(),
  createGoal: vi.fn(),
  updateGoalFromUser: vi.fn(),
  clearGoal: vi.fn(),
  kickGoalRunIfIdle: vi.fn(),
  collectGoalFileDiffs: vi.fn(),
}))

vi.mock('../../goals/index.js', () => ({
  getGoal: goals.getGoal,
  getGoals: goals.getGoals,
  createGoal: goals.createGoal,
  updateGoalFromUser: goals.updateGoalFromUser,
  clearGoal: goals.clearGoal,
}))
vi.mock('../../goals/kick.js', () => ({ kickGoalRunIfIdle: goals.kickGoalRunIfIdle }))
vi.mock('../../goals/file-changes.js', () => ({ collectGoalFileDiffs: goals.collectGoalFileDiffs }))

const GOAL = { id: 'goal-1', objective: 'Ship it', status: 'active', createdAt: 100 }

async function loadDomain() {
  const [{ dispatchRpc, resetRpcRegistryForTests }, { registerGoalRpcDomain }] = await Promise.all([
    import('../registry.js'),
    import('../domains/goal.js'),
  ])
  return { dispatchRpc, resetRpcRegistryForTests, registerGoalRpcDomain }
}

describe('goal RPC domain', () => {
  let dispose: (() => void) | undefined

  beforeEach(async () => {
    goals.getGoal.mockReset().mockReturnValue(GOAL)
    goals.getGoals.mockReset().mockReturnValue([GOAL])
    goals.createGoal.mockReset().mockReturnValue(GOAL)
    goals.updateGoalFromUser.mockReset().mockReturnValue(GOAL)
    goals.clearGoal.mockReset()
    goals.kickGoalRunIfIdle.mockReset()
    goals.collectGoalFileDiffs.mockReset().mockResolvedValue([{ path: 'a.ts', added: 1, removed: 0 }])
    const { resetRpcRegistryForTests, registerGoalRpcDomain } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerGoalRpcDomain()
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  it('get returns the current goal plus the full history', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({
      domain: 'goal',
      method: 'get',
      payload: { sessionId: 'session-1' },
    })).resolves.toEqual({ ok: true, data: { success: true, goal: GOAL, goals: [GOAL] } })
  })

  it('create does NOT kick a run — the visible goal-set message is the first drive', async () => {
    const { dispatchRpc } = await loadDomain()

    await dispatchRpc({
      domain: 'goal',
      method: 'set',
      payload: { sessionId: 'session-1', action: 'create', objective: 'Ship it', tokenBudget: 5000 },
    })

    expect(goals.createGoal).toHaveBeenCalledWith('session-1', {
      objective: 'Ship it',
      tokenBudget: 5000,
    })
    expect(goals.kickGoalRunIfIdle).not.toHaveBeenCalled()
  })

  it('only an explicit resume kicks — a budget edit must not start work on its own', async () => {
    const { dispatchRpc } = await loadDomain()

    await dispatchRpc({
      domain: 'goal',
      method: 'set',
      payload: { sessionId: 'session-1', action: 'update', tokenBudget: 9000 },
    })
    expect(goals.kickGoalRunIfIdle).not.toHaveBeenCalled()

    await dispatchRpc({
      domain: 'goal',
      method: 'set',
      payload: { sessionId: 'session-1', action: 'update', status: 'active' },
    })
    expect(goals.kickGoalRunIfIdle).toHaveBeenCalledWith('session-1', GOAL)
  })

  it('clear archives rather than deletes, and answers with a null goal', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({
      domain: 'goal',
      method: 'set',
      payload: { sessionId: 'session-1', action: 'clear', reason: 'changed my mind' },
    })).resolves.toEqual({ ok: true, data: { success: true, goal: null } })
    expect(goals.clearGoal).toHaveBeenCalledWith('session-1', 'changed my mind')
  })

  it('diffs reviews the goal by id when asked, else the current one', async () => {
    const { dispatchRpc } = await loadDomain()

    await dispatchRpc({
      domain: 'goal',
      method: 'diffs',
      payload: { sessionId: 'session-1' },
    })
    expect(goals.collectGoalFileDiffs).toHaveBeenCalledWith('session-1', 100)

    goals.getGoals.mockReturnValue([GOAL, { ...GOAL, id: 'goal-2', createdAt: 200 }])
    await dispatchRpc({
      domain: 'goal',
      method: 'diffs',
      payload: { sessionId: 'session-1', goalId: 'goal-2' },
    })
    expect(goals.collectGoalFileDiffs).toHaveBeenLastCalledWith('session-1', 200)
  })

  it('a session with no goal gets a success:false answer, not a throw', async () => {
    const { dispatchRpc } = await loadDomain()
    goals.getGoal.mockReturnValue(undefined)
    goals.getGoals.mockReturnValue([])

    await expect(dispatchRpc({
      domain: 'goal',
      method: 'diffs',
      payload: { sessionId: 'session-1' },
    })).resolves.toEqual({
      ok: true,
      data: { success: false, error: 'No goal is set for this session' },
    })
  })

  it('rejects an unknown action instead of silently doing nothing', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({
      domain: 'goal',
      method: 'set',
      payload: { sessionId: 'session-1', action: 'obliterate' },
    })).resolves.toEqual({
      ok: true,
      data: { success: false, error: 'Unknown goal action: obliterate' },
    })
  })
})
