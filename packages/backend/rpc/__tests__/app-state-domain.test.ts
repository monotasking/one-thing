/**
 * app-state 域,端到端穿过 dispatcher(结构债 P4c)。
 *
 * 接的是被删掉的三处转发的测试位:`apps/electron/src/ipc/app-state{,-controller}.ts`
 * 的工厂、bridge 上那两条包装、server 的 `GET /api/app-state` 与
 * `POST /api/app-state/ui`。值得钉的是:
 *  - 两个方法都在 router 的白名单上;
 *  - `get` 把整份状态**原样**交出去(不是像旧 server adapter 那样现场拼一份最小态);
 *  - `saveUiState` 是**补丁**语义:整个信封原样递给存储层,传输面不拆包、不补默认值 ——
 *    补一个 `sidebarCollapsed: false` 之类的默认值就会把「没说」变成「说了 false」;
 *  - 存储层报错时回的是 `{ success:false, error }`,而不是让 dispatcher 变成 `ok:false`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  getAppState: vi.fn(),
}))

const paths = vi.hoisted(() => ({
  getOnethingAppStatePath: vi.fn(() => '/store/app-state.json'),
}))

const storage = vi.hoisted(() => ({
  saveOnethingUiStateForIpc: vi.fn(),
}))

vi.mock('../../stores/app-state.js', () => store)
vi.mock('@onething/runtime/storage', () => ({ ...paths, ...storage }))

const STATE = {
  currentSessionId: 'session-1',
  currentWorkspaceId: 'default',
  sidebarCollapsed: true,
  workspace: { version: 5, spaces: {} },
}

async function loadDomain() {
  const [{ dispatchRpc, resetRpcRegistryForTests }, { registerAppStateRpcDomain }] =
    await Promise.all([import('../registry.js'), import('../domains/app-state.js')])
  return { dispatchRpc, resetRpcRegistryForTests, registerAppStateRpcDomain }
}

describe('app-state RPC domain', () => {
  let dispose: (() => void) | undefined

  beforeEach(async () => {
    store.getAppState.mockReset().mockReturnValue(STATE)
    storage.saveOnethingUiStateForIpc.mockReset().mockReturnValue({ success: true, state: STATE })
    paths.getOnethingAppStatePath.mockClear()

    const { resetRpcRegistryForTests, registerAppStateRpcDomain } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerAppStateRpcDomain()
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  it('binds both methods — an unlisted one never reaches a handler', async () => {
    const { dispatchRpc } = await loadDomain()

    for (const method of ['get', 'saveUiState']) {
      const response = await dispatchRpc({ domain: 'appState', method, payload: {} })
      expect(response.ok, `${method} should dispatch`).toBe(true)
    }

    await expect(dispatchRpc({ domain: 'appState', method: 'nope', payload: {} }))
      .resolves.toMatchObject({ ok: false })
  })

  it('get hands the whole stored state through, not a synthesized minimum', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({ domain: 'appState', method: 'get', payload: {} }))
      .resolves.toEqual({ ok: true, data: STATE })
  })

  it('saveUiState is a patch: the envelope reaches storage untouched', async () => {
    const { dispatchRpc } = await loadDomain()
    const patch = { sessionReadMarks: { 'session-1': { readAt: 1, inboundAt: 1 } } }

    await expect(dispatchRpc({ domain: 'appState', method: 'saveUiState', payload: patch }))
      .resolves.toEqual({ ok: true, data: { success: true, state: STATE } })
    expect(storage.saveOnethingUiStateForIpc).toHaveBeenCalledWith('/store/app-state.json', patch)
  })

  it('an empty patch stays empty — the transport adds no defaults', async () => {
    const { dispatchRpc } = await loadDomain()

    await dispatchRpc({ domain: 'appState', method: 'saveUiState', payload: {} })

    expect(storage.saveOnethingUiStateForIpc).toHaveBeenCalledWith('/store/app-state.json', {})
  })

  it('a storage failure stays a { success:false } payload, not an ok:false envelope', async () => {
    const { dispatchRpc } = await loadDomain()
    storage.saveOnethingUiStateForIpc.mockReturnValue({ success: false, error: 'disk full' })

    await expect(dispatchRpc({
      domain: 'appState',
      method: 'saveUiState',
      payload: { sidebarCollapsed: true },
    })).resolves.toEqual({ ok: true, data: { success: false, error: 'disk full' } })
  })
})
