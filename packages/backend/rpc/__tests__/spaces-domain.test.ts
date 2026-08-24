/**
 * space 域,端到端穿过 dispatcher(结构债 P0.3)。
 *
 * 接的是被删掉的 `apps/electron/src/ipc/spaces.ts` + `spaces-controller.ts` 那条线
 * 的测试位:那两个文件从来没有自己的用例(它们只是 `ipcMain.handle` 的十三条转发),
 * 真正值得钉的是**注入点没搬错** —— 判定全在 runtime 的 `*ForIpc` 一族里,传输面
 * 只递不判。所以这里逐条盯的是「递进去的是哪个依赖」:
 *  - 十三个方法全在 router 的白名单上(少一个 = 渲染侧那一格静默失灵);
 *  - `remove` 的占用统计吃的是 `countSessionsInWorkspace`,不是 spaces store 自己;
 *  - 所有带 id 的方法都先过「这个空间登记过没有」,没登记就是 NOT_FOUND ——
 *    否则一个手滑的 id 会在 `workspaces/` 下长出没有主人的目录;
 *  - `getProviderSettings` 读不到文件时给**空设置**(无回落),不是全局那份;
 *  - `importCredentials` 对默认空间是拒绝(它就是导入的来源)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spacesRouter } from '@shared/ipc/spaces.js'

const store = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}))

const overlay = vi.hoisted(() => ({
  readSpaceOverlay: vi.fn(),
  writeSpaceOverlay: vi.fn(),
}))

const providerSettings = vi.hoisted(() => ({
  readSpaceProviderSettings: vi.fn(),
  writeSpaceProviderSettings: vi.fn(),
  createEmptySpaceProviderSettings: vi.fn(() => ({})),
}))

const credentials = vi.hoisted(() => ({
  getSpaceCredentialsSummary: vi.fn(),
  setSpaceProviderCredential: vi.fn(),
  setSpaceProviderCredentialPoolForRequest: vi.fn(),
  clearSpaceProviderCredential: vi.fn(),
  importDefaultSpaceCredentials: vi.fn(),
}))

const sessions = vi.hoisted(() => ({ countSessionsInWorkspace: vi.fn() }))

vi.mock('@onething/runtime/spaces/store', () => ({ getSpacesStore: () => store }))
vi.mock('@onething/runtime/spaces/overlay', () => overlay)
vi.mock('@onething/runtime/spaces/provider-settings', () => providerSettings)
vi.mock('../../wiring/providers/space-credentials.js', () => credentials)
vi.mock('../../stores/sessions.js', () => sessions)

const SPACE = { id: 'work', name: '工作', createdAt: 1 }
const DEFAULT_SPACE = { id: 'default', name: '默认空间', createdAt: 0 }

async function loadDomain() {
  const [
    { dispatchRpc, registerRouterHandlers, resetRpcRegistryForTests },
    { spacesRpcHandlers },
  ] = await Promise.all([
    import('../registry.js'),
    import('../domains/spaces.js'),
  ])
  return { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, spacesRpcHandlers }
}

describe('spaces RPC domain', () => {
  let dispose: (() => void) | undefined

  beforeEach(async () => {
    store.list.mockReset().mockReturnValue([DEFAULT_SPACE, SPACE])
    store.create.mockReset().mockImplementation((input: { name: string }) => ({ ...SPACE, ...input }))
    store.update.mockReset().mockImplementation((id: string, patch: object) => ({ ...SPACE, id, ...patch }))
    store.remove.mockReset().mockImplementation((_id: string, opts: { sessionCount: number }) =>
      (opts.sessionCount > 0 ? { removed: false, reason: 'not-empty' } : { removed: true }))
    overlay.readSpaceOverlay.mockReset().mockReturnValue({ connectedDirectories: ['/tmp'] })
    overlay.writeSpaceOverlay.mockReset().mockImplementation((_id: string, next: object) => next)
    providerSettings.readSpaceProviderSettings.mockReset().mockReturnValue(undefined)
    providerSettings.writeSpaceProviderSettings.mockReset().mockImplementation((_id: string, ai: object) => ai)
    providerSettings.createEmptySpaceProviderSettings.mockReset().mockReturnValue({})
    credentials.getSpaceCredentialsSummary.mockReset().mockReturnValue({ providers: {} })
    credentials.setSpaceProviderCredential.mockReset().mockReturnValue({ providers: { deepseek: { entries: [], policy: 'single' } } })
    credentials.setSpaceProviderCredentialPoolForRequest.mockReset().mockReturnValue({ providers: {} })
    credentials.clearSpaceProviderCredential.mockReset().mockReturnValue({ providers: {} })
    credentials.importDefaultSpaceCredentials.mockReset().mockReturnValue({ imported: ['deepseek'], skipped: [], credentials: { providers: {} } })
    sessions.countSessionsInWorkspace.mockReset().mockReturnValue(0)
    const { resetRpcRegistryForTests, registerRouterHandlers, spacesRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(spacesRouter, spacesRpcHandlers)
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  it('binds all thirteen methods — an unlisted one never reaches a handler', async () => {
    const { dispatchRpc } = await loadDomain()
    const methods = [
      'list', 'create', 'update', 'remove',
      'getOverlay', 'setOverlay',
      'getProviderSettings', 'setProviderSettings',
      'getCredentials', 'setCredential', 'setCredentialPool', 'clearCredential',
      'importCredentials',
    ]

    for (const method of methods) {
      const response = await dispatchRpc({ domain: 'spaces', method, payload: { id: 'work', providerId: 'deepseek', overlay: {}, ai: {}, entryIds: [], name: 'x' } })
      expect(response.ok, `${method} should dispatch`).toBe(true)
    }

    await expect(dispatchRpc({ domain: 'spaces', method: 'nope', payload: {} }))
      .resolves.toMatchObject({ ok: false })
  })

  it('list projects the spaces store', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({ domain: 'spaces', method: 'list', payload: {} }))
      .resolves.toEqual({ ok: true, data: { success: true, spaces: [DEFAULT_SPACE, SPACE] } })
  })

  it('remove counts sessions through the app-layer session index, not the spaces store', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({ domain: 'spaces', method: 'remove', payload: { id: 'work' } }))
      .resolves.toMatchObject({ ok: true, data: { success: true } })
    expect(sessions.countSessionsInWorkspace).toHaveBeenCalledWith('work')
  })

  it('remove refuses a space that still holds sessions', async () => {
    const { dispatchRpc } = await loadDomain()
    sessions.countSessionsInWorkspace.mockReturnValue(3)

    await expect(dispatchRpc({ domain: 'spaces', method: 'remove', payload: { id: 'work' } }))
      .resolves.toMatchObject({ ok: true, data: { success: false, code: 'NOT_EMPTY' } })
    // 占用数是**注入进去的**,store 只负责按它裁决 —— 传输面不自己数会话。
    expect(store.remove).toHaveBeenCalledWith('work', { sessionCount: 3 })
  })

  it('every id-bearing method is gated on the space being registered', async () => {
    const { dispatchRpc } = await loadDomain()
    const payload = { id: 'ghost', providerId: 'deepseek', overlay: {}, ai: {}, entryIds: [] }

    for (const method of [
      'getOverlay', 'setOverlay',
      'getProviderSettings', 'setProviderSettings',
      'getCredentials', 'setCredential', 'setCredentialPool', 'clearCredential',
      'importCredentials',
    ]) {
      await expect(dispatchRpc({ domain: 'spaces', method, payload }), method)
        .resolves.toMatchObject({ ok: true, data: { success: false, code: 'NOT_FOUND' } })
    }
    expect(overlay.writeSpaceOverlay).not.toHaveBeenCalled()
    expect(providerSettings.writeSpaceProviderSettings).not.toHaveBeenCalled()
  })

  it('getProviderSettings falls back to an EMPTY settings object, never the global one', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({ domain: 'spaces', method: 'getProviderSettings', payload: { id: 'work' } }))
      .resolves.toEqual({ ok: true, data: { success: true, ai: {} } })
    expect(providerSettings.createEmptySpaceProviderSettings).toHaveBeenCalled()
  })

  it('setOverlay is a whole-layer write handed straight to the overlay writer', async () => {
    const { dispatchRpc } = await loadDomain()
    const next = { connectedDirectories: ['/a', '/b'] }

    await expect(dispatchRpc({ domain: 'spaces', method: 'setOverlay', payload: { id: 'work', overlay: next } }))
      .resolves.toEqual({ ok: true, data: { success: true, overlay: next } })
    expect(overlay.writeSpaceOverlay).toHaveBeenCalledWith('work', next)
  })

  it('importCredentials refuses the default space — it is the source, not a target', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({ domain: 'spaces', method: 'importCredentials', payload: { id: 'default' } }))
      .resolves.toMatchObject({ ok: true, data: { success: false } })
    expect(credentials.importDefaultSpaceCredentials).not.toHaveBeenCalled()
  })

  it('setCredential hands the request through untouched (no transport-side branching)', async () => {
    const { dispatchRpc } = await loadDomain()
    const request = { id: 'work', providerId: 'deepseek', apiKey: 'sk-x', entryId: 'e1', label: '主力' }

    await expect(dispatchRpc({ domain: 'spaces', method: 'setCredential', payload: request }))
      .resolves.toMatchObject({ ok: true, data: { success: true } })
    expect(credentials.setSpaceProviderCredential).toHaveBeenCalledWith(request)
  })
})
