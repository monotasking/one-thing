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
  findWorkspaceGrant: vi.fn(() => undefined),
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
  findWorkspaceGrant: mocks.findWorkspaceGrant,
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

/**
 * 桌面那一侧的加载口。
 *
 * 「这是一台桌面」这句话,C0 R2 之后要**声明**出来:`resolveRpcSandbox` 的"不夹"
 * 判据从 `transport === 'ipc'` 换成了 `isHostLocallyTrusted()`,而那句话由宿主在
 * **装配时**说(两个桌面壳都写 `{ origin: 'desktop-embedded' }`)。
 *
 * 声明必须排在 `loadDomain()` **之后**:它里面那句 `vi.resetModules()` 会把
 * `host-trust.js` 也重新求值一遍,先声明的那份会被丢掉。同一个理由让这份文件
 * 不需要 afterEach 还原 —— 每条用例都从一份全新的、未声明的模块起跑。
 */
async function loadDesktopDomain() {
  const handlers = await loadDomain()
  const { configureHostLocalTrust } = await import('../../server/host-trust.js')
  configureHostLocalTrust({ origin: 'desktop-embedded' })
  return handlers
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getSessionsList.mockReturnValue([])
  mocks.listSessionGrants.mockReturnValue([])
  mocks.listWorkspaceGrants.mockReturnValue([])
  mocks.revokeGrant.mockReturnValue(true)
})

describe('permissionGrants RPC domain · desktop context', () => {
  it('keeps desktop paths unconfined but binds grant ownership to the local operator', async () => {
    const handlers = await loadDesktopDomain()
    mocks.getSessionsList.mockReturnValue([{ id: 'session-1' }])

    await handlers.list(
      { sessionId: 'session-1', workspaceRoot: '/anywhere/on/disk', userId: 'bob' },
      DESKTOP_RPC_CONTEXT,
    )
    expect(mocks.listSessionGrants).toHaveBeenCalledWith('session-1')
    // 桌面上 owner 沿用请求体,不被 context 覆盖(桌面 context 本来就没有 owner)。
    expect(mocks.listWorkspaceGrants).toHaveBeenCalledWith(
      '/anywhere/on/disk',
      expect.objectContaining({ userId: 'local-user', workspaceId: 'default' }),
    )
    // 会话列表根本没被读 —— 桌面路径不付归属枚举的代价。
    expect(mocks.getSessionsList).toHaveBeenCalled()
  })

  it('refuses unknown grants on desktop too', async () => {
    const handlers = await loadDesktopDomain()

    await expect(handlers.revoke({ id: 'grant-from-nowhere' }, DESKTOP_RPC_CONTEXT))
      .resolves.toEqual({ success: false, error: 'Permission grant not found' })
    expect(mocks.revokeGrant).not.toHaveBeenCalled()
    expect(mocks.getSessionsList).toHaveBeenCalled()
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

  it('treats an ownerless legacy session as unowned — every caller reads it, a stamped one only its owner', async () => {
    // 归属判定:**两格都空 = 无主,谁都读得到**;有值的那格才比(工单 4 A3 修回
    // HEAD 语义)。老会话只是没盖过章,不该因此变成 local-user 的私产 ——
    // 变成私产的后果是任何带真实租户身份的调用者都读不到自己的历史授权。
    mocks.getSessionsList.mockReturnValue([{ id: 'legacy' }, { id: 'theirs', userId: 'bob', workspaceId: 'default' }])
    const handlers = await loadDomain()

    await handlers.list({ sessionId: 'legacy' }, httpContext())
    expect(mocks.listSessionGrants).toHaveBeenCalledWith('legacy')
    await handlers.list({ sessionId: 'legacy' }, { ...httpContext(), ownerUid: 'local-user' })
    expect(mocks.listSessionGrants).toHaveBeenCalledTimes(2)

    mocks.listSessionGrants.mockClear()
    await expect(handlers.list({ sessionId: 'theirs' }, httpContext())).resolves.toMatchObject({ success: false })
    expect(mocks.listSessionGrants).not.toHaveBeenCalled()
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
