/**
 * providers 域(主线 T1 第二批),搬自 `apps/electron/src/main/ipc/__tests__/providers.test.ts`。
 *
 * 批 5:`usage` 改名 `quota`,handler 只把请求递给 `backend.quota`(判据全在
 * `runtime/quota`,那边有自己的测试);这里钉的是递什么、缺省是什么、没有活实例时答什么。
 * env status 永远不回显真钥匙那一条照旧。
 *
 * mock 的路径必须解析到 handler **自己 import 的那个模块** —— 差一层就什么也没 mock 到。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  quotaGet: vi.fn(),
  backend: { current: null as null | { quota?: { get: (...args: unknown[]) => unknown } } },
  getAvailableProviders: vi.fn(() => []),
}))

vi.mock('../../current.js', () => ({
  getCurrentBackendInstance: () => mocks.backend.current,
}))

vi.mock('@onething/backend/runtime/providers/chat-facade', () => ({
  getAvailableProviders: mocks.getAvailableProviders,
}))

const { providersRpcHandlers } = await import('../domains/providers.js')

describe('providers RPC domain', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.backend.current = { quota: { get: mocks.quotaGet } }
    delete process.env.OPENAI_API_KEY
  })

  afterEach(() => {
    delete process.env.OPENAI_API_KEY
  })

  it('quota:缺省空间 = default,不带 force / credentialId 就不递', async () => {
    mocks.quotaGet.mockResolvedValue({ quota: { kind: 'unsupported' } })
    const response = await providersRpcHandlers.quota({ providerId: 'openai' })
    expect(response).toEqual({ quota: { kind: 'unsupported' } })
    expect(mocks.quotaGet).toHaveBeenCalledWith({ providerId: 'openai', spaceId: 'default' })
  })

  it('quota:空间 / 凭证 / force 原样递给配额服务,答案原样回', async () => {
    const answer = {
      quota: { kind: 'windows', windows: [{ id: '5h', seconds: 18000, usedPercent: 62 }], fetchedAt: 1 },
      credentialId: 'entry-1',
    }
    mocks.quotaGet.mockResolvedValue(answer)
    const response = await providersRpcHandlers.quota({
      providerId: 'codex',
      spaceId: 's2',
      credentialId: 'entry-1',
      force: true,
    })
    expect(mocks.quotaGet).toHaveBeenCalledWith({ providerId: 'codex', spaceId: 's2', credentialId: 'entry-1', force: true })
    expect(response).toEqual(answer)
  })

  it('quota:没有活实例(或空 providerId)答 unsupported,不抛', async () => {
    mocks.backend.current = null
    await expect(providersRpcHandlers.quota({ providerId: 'codex' })).resolves.toEqual({ quota: { kind: 'unsupported' } })
    mocks.backend.current = { quota: { get: mocks.quotaGet } }
    await expect(providersRpcHandlers.quota({ providerId: '' })).resolves.toEqual({ quota: { kind: 'unsupported' } })
    expect(mocks.quotaGet).not.toHaveBeenCalled()
  })

  it('reports provider env status without returning the API key value', async () => {
    process.env.OPENAI_API_KEY = 'secret-env-key-1234'

    const response = await providersRpcHandlers.envStatus({ providerId: 'openai' })

    expect(response).toMatchObject({
      success: true,
      status: {
        providerId: 'openai',
        detectedEnvVar: 'OPENAI_API_KEY',
        resolvedEnvVar: 'OPENAI_API_KEY',
        keyPreview: 'secret••••1234',
      },
    })
    expect(response.status?.candidates).toContainEqual({
      name: 'OPENAI_API_KEY',
      isSet: true,
    })
    expect(JSON.stringify(response)).not.toContain('secret-env-key-1234')
  })

  it('reads the provider catalog off the app registry', async () => {
    mocks.getAvailableProviders.mockReturnValue([{ id: 'openai' }] as never)

    await expect(providersRpcHandlers.list({})).resolves.toMatchObject({
      success: true,
      providers: [{ id: 'openai' }],
    })
  })
})

/** 批 3 §6.1:「接口类型」下拉读方言注册表 —— 自述了人话名的才进。 */
describe('providers RPC domain — listDialects', () => {
  it('有人话名的方言都在;绑登录方式的那几份不在', async () => {
    const response = await providersRpcHandlers.listDialects({})
    expect(response.success).toBe(true)
    const ids = (response.dialects ?? []).map(d => d.id)
    for (const id of ['custom-openai', 'custom-anthropic', 'openai', 'claude', 'gemini', 'openrouter', 'zhipu', 'qwen', 'deepseek', 'kimi', 'grok']) {
      expect(ids).toContain(id)
    }
    for (const id of ['codex', 'claude-code', 'github-copilot', 'kimi-code', 'grok-oauth']) {
      expect(ids).not.toContain(id)
    }
    expect(response.dialects?.find(d => d.id === 'custom-openai')?.label).toBe('OpenAI compatible')
  })
})
