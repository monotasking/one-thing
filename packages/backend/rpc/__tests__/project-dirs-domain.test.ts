/**
 * project-dirs 域,端到端穿过 dispatcher(结构债 P4c)。
 *
 * 接的是被删掉的三处转发的测试位:`apps/electron/src/ipc/project-dirs{,-controller}.ts`
 * 的工厂、bridge 上那五条**位置参数**包装、server 的五条 REST 路由。值得钉的是:
 *  - 五个方法全在 router 的白名单上;
 *  - **`workspaceId` 真的到了 `getProjectsStore`** —— 这是本域搬家最实在的一条:
 *    旧 web 壳把它收下就丢(参数名带下划线),浏览器里切空间等于没切;
 *  - 缺省 `workspaceId` = default 空间(`getProjectsStore(undefined)`,零迁移,批 B4),
 *    所以「没说空间」必须原样传 `undefined`,不能被补成某个字符串;
 *  - `list` 要两个端口(名册索引 + 逐条详情),投影据此拼摘要;
 *  - 出错时回 `{ success:false, error, code }`,而不是让 dispatcher 变成 `ok:false`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stores = vi.hoisted(() => {
  const store = {
    list: vi.fn(),
    get: vi.fn(),
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  }
  return { store, getProjectsStore: vi.fn(() => store) }
})

vi.mock('@onething/runtime/project-dirs/store', () => ({
  getProjectsStore: stores.getProjectsStore,
}))

const PROJECT = {
  id: 'p1',
  path: '/workspace',
  paths: ['/workspace'],
  description: 'Main project',
  addedAt: 1,
  lastUsedAt: 2,
}

async function loadDomain() {
  const [{ dispatchRpc, resetRpcRegistryForTests }, { registerProjectDirsRpcDomain }] =
    await Promise.all([import('../registry.js'), import('../domains/project-dirs.js')])
  return { dispatchRpc, resetRpcRegistryForTests, registerProjectDirsRpcDomain }
}

describe('project-dirs RPC domain', () => {
  let dispose: (() => void) | undefined

  beforeEach(async () => {
    stores.getProjectsStore.mockClear()
    stores.store.list.mockReset().mockReturnValue([{ id: 'p1', path: '/workspace', paths: ['/workspace'] }])
    stores.store.get.mockReset().mockReturnValue(PROJECT)
    stores.store.add.mockReset().mockReturnValue(PROJECT)
    stores.store.update.mockReset().mockReturnValue(PROJECT)
    stores.store.remove.mockReset().mockReturnValue(true)

    const { resetRpcRegistryForTests, registerProjectDirsRpcDomain } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerProjectDirsRpcDomain()
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  it('binds all five methods — an unlisted one never reaches a handler', async () => {
    const { dispatchRpc } = await loadDomain()

    for (const method of ['list', 'get', 'add', 'update', 'remove']) {
      const response = await dispatchRpc({
        domain: 'projectDirs',
        method,
        payload: { path: '/workspace' },
      })
      expect(response.ok, `${method} should dispatch`).toBe(true)
    }

    await expect(dispatchRpc({ domain: 'projectDirs', method: 'nope', payload: {} }))
      .resolves.toMatchObject({ ok: false })
  })

  it('every method opens the store for the requested workspace', async () => {
    const { dispatchRpc } = await loadDomain()

    for (const [method, payload] of [
      ['list', {}],
      ['get', { path: '/workspace' }],
      ['add', { path: '/workspace' }],
      ['update', { path: '/workspace', description: 'x' }],
      ['remove', { path: '/workspace' }],
    ] as const) {
      stores.getProjectsStore.mockClear()
      await dispatchRpc({
        domain: 'projectDirs',
        method,
        payload: { ...payload, workspaceId: 'work' },
      })
      expect(stores.getProjectsStore, `${method} should scope by workspace`)
        .toHaveBeenCalledWith('work')
    }
  })

  it('an absent workspaceId stays undefined — the default space, not a made-up id', async () => {
    const { dispatchRpc } = await loadDomain()

    await dispatchRpc({ domain: 'projectDirs', method: 'list', payload: {} })

    expect(stores.getProjectsStore).toHaveBeenCalledWith(undefined)
  })

  it('list joins the index with per-entry detail', async () => {
    const { dispatchRpc } = await loadDomain()

    const response = await dispatchRpc({ domain: 'projectDirs', method: 'list', payload: {} })

    expect(response).toMatchObject({ ok: true, data: { success: true } })
    expect(stores.store.list).toHaveBeenCalled()
    expect(stores.store.get).toHaveBeenCalledWith('/workspace')
  })

  it('add hands the whole request to the projection (path + description + paths)', async () => {
    const { dispatchRpc } = await loadDomain()

    await dispatchRpc({
      domain: 'projectDirs',
      method: 'add',
      payload: { path: '/workspace', description: 'Main project', paths: ['/workspace', '/docs'] },
    })

    expect(stores.store.add).toHaveBeenCalledWith(expect.objectContaining({
      path: '/workspace',
      description: 'Main project',
      paths: ['/workspace', '/docs'],
    }))
  })

  it('a store failure stays a { success:false } payload, not an ok:false envelope', async () => {
    const { dispatchRpc } = await loadDomain()
    stores.store.remove.mockImplementation(() => {
      throw new Error('ENOENT')
    })

    const response = await dispatchRpc({
      domain: 'projectDirs',
      method: 'remove',
      payload: { path: '/workspace' },
    })
    expect(response).toMatchObject({ ok: true, data: { success: false } })
  })
})
