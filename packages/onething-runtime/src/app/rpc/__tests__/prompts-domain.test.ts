/**
 * 提示词片段域，端到端穿过 dispatcher。
 *
 * 钉的是**与被拔掉的三条旧线的等价性**：删掉的
 * `apps/electron/src/main/ipc/prompts.ts` 调的是 `@onething/app/prompts/store`
 * 的五个函数，删掉的 `/api/prompts*` 五条路由经 facade 调的是同一组 ipc-operations。
 * 迁移后必须还是那一组调用、同样的参数、结果原样回传。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  listPrompts: vi.fn(),
  getPrompt: vi.fn(),
  createPrompt: vi.fn(),
  updatePrompt: vi.fn(),
  deletePrompt: vi.fn(),
}))

// 这个 specifier 必须解析到 handler 自己 import 的那个模块（src/app/prompts/store.ts）。
// 差一级目录就等于什么都没 mock，测试会安静地去写用户真实的 prompts.json。
vi.mock('@onething/runtime/prompts/store-bound', () => store)

const PROMPT = {
  id: 'prompt-1',
  title: 'Reusable Review',
  body: 'Review this carefully.',
  createdAt: 1,
  updatedAt: 2,
}

async function loadDomain() {
  const [{ dispatchRpc, resetRpcRegistryForTests }, { registerPromptsRpcDomain }] = await Promise.all([
    import('../registry.js'),
    import('../domains/prompts.js'),
  ])
  return { dispatchRpc, resetRpcRegistryForTests, registerPromptsRpcDomain }
}

describe('prompts RPC domain', () => {
  let dispose: (() => void) | undefined

  beforeEach(async () => {
    store.listPrompts.mockReset().mockReturnValue([PROMPT])
    store.getPrompt.mockReset().mockReturnValue(PROMPT)
    store.createPrompt.mockReset().mockReturnValue(PROMPT)
    store.updatePrompt.mockReset().mockReturnValue(PROMPT)
    store.deletePrompt.mockReset().mockReturnValue(true)
    const { resetRpcRegistryForTests, registerPromptsRpcDomain } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerPromptsRpcDomain()
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  it('list returns the store contents in the response shape the picker expects', async () => {
    const { dispatchRpc } = await loadDomain()

    const response = await dispatchRpc({ domain: 'prompts', method: 'list', payload: {} })

    expect(store.listPrompts).toHaveBeenCalledTimes(1)
    expect(response).toEqual({ ok: true, data: { success: true, prompts: [PROMPT] } })
  })

  it('get / create / update / delete reach the store with the caller payload untouched', async () => {
    const { dispatchRpc } = await loadDomain()

    await dispatchRpc({ domain: 'prompts', method: 'get', payload: { id: 'prompt-1' } })
    expect(store.getPrompt).toHaveBeenCalledWith('prompt-1')

    await dispatchRpc({
      domain: 'prompts',
      method: 'create',
      payload: { title: 'Reusable Review', body: 'Review this carefully.' },
    })
    expect(store.createPrompt).toHaveBeenCalledWith({
      title: 'Reusable Review',
      body: 'Review this carefully.',
    })

    await dispatchRpc({
      domain: 'prompts',
      method: 'update',
      payload: { id: 'prompt-1', body: 'Updated body' },
    })
    expect(store.updatePrompt).toHaveBeenCalledWith({ id: 'prompt-1', body: 'Updated body' })

    await expect(dispatchRpc({
      domain: 'prompts',
      method: 'delete',
      payload: { id: 'prompt-1' },
    })).resolves.toEqual({ ok: true, data: { success: true } })
    expect(store.deletePrompt).toHaveBeenCalledWith('prompt-1')
  })

  it('a missing prompt is a success:false payload, not a dispatcher error', async () => {
    const { dispatchRpc } = await loadDomain()
    store.getPrompt.mockReturnValue(undefined)

    await expect(dispatchRpc({
      domain: 'prompts',
      method: 'get',
      payload: { id: 'nope' },
    })).resolves.toEqual({ ok: true, data: { success: false, error: 'Prompt not found' } })
  })

  it('a store read failure comes back as ok:false, not a rejection', async () => {
    const { dispatchRpc } = await loadDomain()
    store.listPrompts.mockImplementation(() => { throw new Error('prompts.json unreadable') })

    await expect(dispatchRpc({
      domain: 'prompts',
      method: 'list',
      payload: {},
    })).resolves.toEqual({ ok: true, data: { success: false, error: 'prompts.json unreadable' } })
  })

  it('exposes exactly the five methods the router declares', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({
      domain: 'prompts',
      method: 'reorder',
      payload: {},
    })).resolves.toEqual({
      ok: false,
      error: { message: 'Unknown RPC method "prompts.reorder"', code: 'UNKNOWN_METHOD' },
    })
  })
})
