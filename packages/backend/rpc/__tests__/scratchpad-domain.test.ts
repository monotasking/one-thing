/**
 * scratchpad 域,端到端穿过 dispatcher(结构债 P4c)。
 *
 * 接的是被删掉的三处转发的测试位:`apps/electron/src/ipc/scratchpad.ts` 的工厂、
 * bridge 上那四条包装、server 的四条 REST 路由。值得钉的是:
 *  - 四个方法都在 router 的白名单上,**推送不在**(`SCRATCHPAD_CHANGED` 是注入端口,
 *    router 今天没有推送面 —— 白名单上多一条就等于承诺了一条不存在的通道);
 *  - 每个方法各自 try/catch,把异常压成 `{ success:false, error }`:渲染侧那套
 *    `response.success` 判断照旧成立,dispatcher 不会因此变成 `ok:false`;
 *  - `adopt` 是**改名认领**(from → to 两个 id 按序递下去),不是复制;
 *  - `update` 回的是写完之后的 document(渲染侧靠它的 `version` 做回声抑制)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scratchpadRouter } from '@shared/ipc/scratchpad.js'

const scratchpad = vi.hoisted(() => ({
  readScratchpad: vi.fn(),
  updateScratchpad: vi.fn(),
  removeScratchpad: vi.fn(),
  adoptScratchpad: vi.fn(),
}))

vi.mock('@onething/runtime/scratchpad/service-bound', () => scratchpad)

const DOC = {
  sessionId: 's1',
  filePath: '/store/scratchpads/s1.md',
  content: 'hello',
  version: 42,
  updatedAt: 42,
}

async function loadDomain() {
  const [{ dispatchRpc, registerRouterHandlers, resetRpcRegistryForTests }, { scratchpadRpcHandlers }] =
    await Promise.all([import('../registry.js'), import('../domains/scratchpad.js')])
  return { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, scratchpadRpcHandlers }
}

describe('scratchpad RPC domain', () => {
  let dispose: (() => void) | undefined

  beforeEach(async () => {
    scratchpad.readScratchpad.mockReset().mockResolvedValue(DOC)
    scratchpad.updateScratchpad.mockReset().mockResolvedValue({ ...DOC, content: 'next', version: 43 })
    scratchpad.removeScratchpad.mockReset().mockResolvedValue(undefined)
    scratchpad.adoptScratchpad.mockReset().mockResolvedValue(undefined)

    const { resetRpcRegistryForTests, registerRouterHandlers, scratchpadRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(scratchpadRouter, scratchpadRpcHandlers)
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  it('binds the four data methods — the change push is deliberately not one of them', async () => {
    const { dispatchRpc } = await loadDomain()

    for (const method of ['get', 'update', 'delete', 'adopt']) {
      const response = await dispatchRpc({
        domain: 'scratchpad',
        method,
        payload: { sessionId: 's1', content: 'x', fromSessionId: 'a', toSessionId: 'b' },
      })
      expect(response.ok, `${method} should dispatch`).toBe(true)
    }

    // 推送是注入端口(configureScratchpadHost),不是这个域上的一个方法。
    await expect(dispatchRpc({ domain: 'scratchpad', method: 'subscribeChanged', payload: {} }))
      .resolves.toMatchObject({ ok: false })
  })

  it('get wraps the document; update returns the document written', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({ domain: 'scratchpad', method: 'get', payload: { sessionId: 's1' } }))
      .resolves.toEqual({ ok: true, data: { success: true, document: DOC } })

    await expect(dispatchRpc({
      domain: 'scratchpad',
      method: 'update',
      payload: { sessionId: 's1', content: 'next' },
    })).resolves.toEqual({
      ok: true,
      data: { success: true, document: { ...DOC, content: 'next', version: 43 } },
    })
    expect(scratchpad.updateScratchpad).toHaveBeenCalledWith('s1', 'next')
  })

  it('adopt renames from → to, in that order', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({
      domain: 'scratchpad',
      method: 'adopt',
      payload: { fromSessionId: 'draft:1', toSessionId: 'session-1' },
    })).resolves.toEqual({ ok: true, data: { success: true } })
    expect(scratchpad.adoptScratchpad).toHaveBeenCalledWith('draft:1', 'session-1')
  })

  it('a filesystem failure stays a { success:false } payload, not an ok:false envelope', async () => {
    const { dispatchRpc } = await loadDomain()
    scratchpad.readScratchpad.mockRejectedValue(new Error('EACCES'))

    await expect(dispatchRpc({ domain: 'scratchpad', method: 'get', payload: { sessionId: 's1' } }))
      .resolves.toEqual({ ok: true, data: { success: false, error: 'EACCES' } })
  })
})
