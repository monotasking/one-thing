/**
 * `permissionGrants` 域的归属护栏（主线 T 批 3）。
 *
 * 批 1 把这个域退回「不可迁清单」第 2 类，理由是 `canRevokePermissionGrant` /
 * `resolveServerWorkspaceGrantRoot` 这两个归属校验没有 request context 就无从
 * 判起。这份测试是验收门：**同一个 handler**，desktop context 与 http context
 * 两种输入，跨 owner 的 grant 在夹紧那侧撤不掉、在桌面那侧照旧可撤。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_RPC_CONTEXT, type RpcDispatchContext } from '@shared/ipc/rpc.js'

const mocks = vi.hoisted(() => ({
  getSessionsList: vi.fn(() => [] as unknown[]),
  listSessionGrants: vi.fn((_sessionId: string) => [] as { id: string }[]),
  listWorkspaceGrants: vi.fn(
    (_root: string, _owner?: { userId?: string; workspaceId?: string }) => [] as { id: string }[],
  ),
  revokeGrant: vi.fn((_id: string) => true),
  clearSessionGrants: vi.fn((_sessionId: string) => {}),
  clearWorkspaceGrants: vi.fn(
    (_root: string, _owner?: { userId?: string; workspaceId?: string }) => {},
  ),
}))

vi.mock('../../stores/sessions.js', () => ({
  getSessionsList: mocks.getSessionsList,
}))

vi.mock('../../wiring/permission/permission-grants.js', () => ({
  listSessionGrants: mocks.listSessionGrants,
  listWorkspaceGrants: mocks.listWorkspaceGrants,
  revokeGrant: mocks.revokeGrant,
  clearSessionGrants: mocks.clearSessionGrants,
  clearWorkspaceGrants: mocks.clearWorkspaceGrants,
}))

const SANDBOX_ROOT = '/srv/workspaces/alice/default'

function httpContext(): RpcDispatchContext {
  return {
    transport: 'http',
    ownerUid: 'alice',
    workspaceId: 'default',
    sandboxRoot: SANDBOX_ROOT,
  }
}

async function loadDomain() {
  vi.resetModules()
  const { permissionGrantsRpcHandlers } = await import('../domains/permission-grants.js')
  return permissionGrantsRpcHandlers
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getSessionsList.mockReturnValue([])
  mocks.listSessionGrants.mockReturnValue([])
  mocks.listWorkspaceGrants.mockReturnValue([])
  mocks.revokeGrant.mockReturnValue(true)
})

describe('permissionGrants RPC domain · desktop context', () => {
  it('passes the request through untouched — no ownership, no clamping', async () => {
    const handlers = await loadDomain()

    await handlers.list(
      { sessionId: 'session-1', workspaceRoot: '/anywhere/on/disk', userId: 'bob' },
      DESKTOP_RPC_CONTEXT,
    )
    expect(mocks.listSessionGrants).toHaveBeenCalledWith('session-1')
    // 桌面上 owner 沿用请求体,不被 context 覆盖(桌面 context 本来就没有 owner)。
    expect(mocks.listWorkspaceGrants).toHaveBeenCalledWith(
      '/anywhere/on/disk',
      expect.objectContaining({ userId: 'bob' }),
    )
    // 会话列表根本没被读 —— 桌面路径不付归属枚举的代价。
    expect(mocks.getSessionsList).not.toHaveBeenCalled()
  })

  it('revokes any grant without an ownership lookup', async () => {
    const handlers = await loadDomain()

    await expect(handlers.revoke({ id: 'grant-from-nowhere' }, DESKTOP_RPC_CONTEXT))
      .resolves.toEqual({ success: true })
    expect(mocks.revokeGrant).toHaveBeenCalledWith('grant-from-nowhere')
    expect(mocks.getSessionsList).not.toHaveBeenCalled()
  })
})

describe('permissionGrants RPC domain · networked context', () => {
  it('clamps the workspace root and refuses one outside the sandbox', async () => {
    const handlers = await loadDomain()

    await expect(handlers.list({ workspaceRoot: '/etc' }, httpContext())).resolves.toEqual({
      success: false,
      error: 'Workspace root must stay inside the workspace sandbox root.',
    })
    await expect(handlers.list({ workspaceRoot: '../../etc' }, httpContext())).resolves.toEqual({
      success: false,
      error: 'Workspace root must stay inside the workspace sandbox root.',
    })
    await expect(handlers.clearWorkspace({ workspaceRoot: '/etc' }, httpContext())).resolves.toEqual({
      success: false,
      error: 'Workspace root must stay inside the workspace sandbox root.',
    })

    // 沙箱内的相对根照常受理,并被解析成绝对路径。
    await handlers.list({ workspaceRoot: 'repo' }, httpContext())
    expect(mocks.listWorkspaceGrants).toHaveBeenCalledWith(
      `${SANDBOX_ROOT}/repo`,
      { userId: 'alice', workspaceId: 'default' },
    )
  })

  it('ignores owner fields in the payload and uses the authenticated identity', async () => {
    const handlers = await loadDomain()

    await handlers.list({ workspaceRoot: 'repo', userId: 'mallory', workspaceId: 'evil' }, httpContext())
    expect(mocks.listWorkspaceGrants).toHaveBeenCalledWith(
      `${SANDBOX_ROOT}/repo`,
      { userId: 'alice', workspaceId: 'default' },
    )
  })

  it('hides sessions the caller does not own', async () => {
    mocks.getSessionsList.mockReturnValue([
      { id: 'mine', userId: 'alice', workspaceId: 'default' },
      { id: 'theirs', userId: 'bob', workspaceId: 'default' },
    ])
    const handlers = await loadDomain()

    await expect(handlers.list({ sessionId: 'theirs' }, httpContext())).resolves.toEqual({
      success: false,
      error: 'Session not found',
    })
    await expect(handlers.clearSession({ sessionId: 'theirs' }, httpContext())).resolves.toEqual({
      success: false,
      error: 'Session not found',
    })
    expect(mocks.clearSessionGrants).not.toHaveBeenCalled()

    await handlers.list({ sessionId: 'mine' }, httpContext())
    expect(mocks.listSessionGrants).toHaveBeenCalledWith('mine')
  })

  it('treats unstamped legacy sessions as owned — existing data keeps working', async () => {
    mocks.getSessionsList.mockReturnValue([{ id: 'legacy' }])
    const handlers = await loadDomain()

    await handlers.list({ sessionId: 'legacy' }, httpContext())
    expect(mocks.listSessionGrants).toHaveBeenCalledWith('legacy')
  })

  it('refuses to revoke a grant that belongs to nobody the caller owns', async () => {
    mocks.getSessionsList.mockReturnValue([
      { id: 'mine', userId: 'alice', workspaceId: 'default', workingDirectory: '/srv/work/alice' },
      { id: 'theirs', userId: 'bob', workspaceId: 'default' },
    ])
    mocks.listSessionGrants.mockImplementation(sessionId =>
      sessionId === 'theirs' ? [{ id: 'bob-grant' }] : [])
    const handlers = await loadDomain()

    await expect(handlers.revoke({ id: 'bob-grant' }, httpContext())).resolves.toEqual({
      success: false,
      error: 'Permission grant not found',
    })
    expect(mocks.revokeGrant).not.toHaveBeenCalled()
    // bob 的会话根本没被查 —— 枚举只走自己名下的会话。
    expect(mocks.listSessionGrants).not.toHaveBeenCalledWith('theirs')
  })

  it('revokes a grant reachable through an owned session or an owned workspace root', async () => {
    mocks.getSessionsList.mockReturnValue([
      { id: 'mine', userId: 'alice', workspaceId: 'default', workingDirectory: '/srv/work/alice' },
    ])
    mocks.listSessionGrants.mockImplementation(sessionId =>
      sessionId === 'mine' ? [{ id: 'session-grant' }] : [])
    const handlers = await loadDomain()

    await expect(handlers.revoke({ id: 'session-grant' }, httpContext()))
      .resolves.toEqual({ success: true })
    expect(mocks.revokeGrant).toHaveBeenCalledWith('session-grant')

    // 工作区面:候选根 = 沙箱根 ∪ 自己会话的 workingDirectory。
    vi.clearAllMocks()
    mocks.getSessionsList.mockReturnValue([
      { id: 'mine', userId: 'alice', workspaceId: 'default', workingDirectory: '/srv/work/alice' },
    ])
    mocks.listSessionGrants.mockReturnValue([])
    mocks.listWorkspaceGrants.mockImplementation(root =>
      root === '/srv/work/alice' ? [{ id: 'workspace-grant' }] : [])
    mocks.revokeGrant.mockReturnValue(true)
    const handlers2 = await loadDomain()

    await expect(handlers2.revoke({ id: 'workspace-grant' }, httpContext()))
      .resolves.toEqual({ success: true })
    expect(mocks.revokeGrant).toHaveBeenCalledWith('workspace-grant')
  })

  it('fails closed when the host forgets the sandbox root', async () => {
    const handlers = await loadDomain()

    await expect(handlers.revoke(
      { id: 'anything' },
      { transport: 'http', ownerUid: 'alice', workspaceId: 'default' },
    )).rejects.toThrow(/without an absolute sandboxRoot/)
  })
})
