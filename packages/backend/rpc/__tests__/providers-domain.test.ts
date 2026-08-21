/**
 * providers 域(主线 T1 第二批),搬自 `apps/electron/src/main/ipc/__tests__/providers.test.ts`。
 *
 * 钉的是与被删掉那条线的等价:非 Codex provider 报 unsupported、Codex 先刷新
 * token 再取官方用量、登录失效时把原话回上去、env status 永远不回显真钥匙。
 *
 * mock 的路径必须解析到 handler **自己 import 的那个模块**(`../../auth/...`、
 * `../../providers/...`)——差一层就什么也没 mock 到,测试会拿用户真 store 跑。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  refreshTokenIfNeeded: vi.fn(),
  fetchCodexUsage: vi.fn(),
  getAvailableProviders: vi.fn(() => []),
  resolveSpaceCredential: vi.fn((spaceId: string) => ({
    kind: 'oauth-entry' as const,
    spaceId,
    entry: { id: 'entry-1', label: 'l', authType: 'oauth' as const, source: 'user' },
  })),
}))

vi.mock('../../wiring/auth/auth-service.js', () => ({
  authService: { refreshTokenIfNeeded: mocks.refreshTokenIfNeeded },
}))

vi.mock('../../wiring/providers/builtin/codex.js', () => ({
  fetchCodexUsage: mocks.fetchCodexUsage,
}))

vi.mock('../../wiring/providers/index.js', () => ({
  getAvailableProviders: mocks.getAvailableProviders,
}))

// C1:用量按**哪个空间的 codex 账号**查。这里只 mock 解析那一格 —— 真实模块会
// 顺着 registry 把整棵 provider 树拖进来(builtin/codex 的默认导出正是那样漏进
// 这条测试的)。
vi.mock('../../wiring/providers/space-credentials.js', () => ({
  resolveSpaceProviderCredentialForSpace: mocks.resolveSpaceCredential,
  credentialTargetFromMarker: (marker: unknown) => marker,
}))

const { providersRpcHandlers } = await import('../domains/providers.js')

describe('providers RPC domain', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.OPENAI_API_KEY
  })

  afterEach(() => {
    delete process.env.OPENAI_API_KEY
  })

  it('returns unsupported for non-Codex providers', async () => {
    const response = await providersRpcHandlers.usage({ providerId: 'openai' })

    expect(response).toEqual({ success: true, providerId: 'openai', unsupported: true })
    expect(mocks.refreshTokenIfNeeded).not.toHaveBeenCalled()
    expect(mocks.fetchCodexUsage).not.toHaveBeenCalled()
  })

  it('refreshes Codex auth and returns official usage', async () => {
    const token = {
      accessToken: 'secret-token',
      expiresAt: Date.now() + 60_000,
      tokenType: 'Bearer',
      accountId: 'acct_123',
      email: 'user@example.com',
      planType: 'pro',
      isFedrampAccount: false,
    }
    const usage = {
      planType: 'pro',
      credits: { hasCredits: true, unlimited: false, balance: '10' },
      limits: [{ id: 'codex', primary: { usedPercent: 15 } }],
    }
    mocks.refreshTokenIfNeeded.mockResolvedValue(token)
    mocks.fetchCodexUsage.mockResolvedValue(usage)

    const response = await providersRpcHandlers.usage({ providerId: 'codex' })

    // C1:第二个参数是**这个空间的那条 codex entry**(批 B10 移交项 2)。
    expect(mocks.refreshTokenIfNeeded).toHaveBeenCalledWith('codex', {
      spaceId: 'default',
      entryId: 'entry-1',
      authType: 'oauth',
    })
    expect(mocks.fetchCodexUsage).toHaveBeenCalledWith(token)
    expect(response).toMatchObject({
      success: true,
      providerId: 'codex',
      account: {
        id: 'acct_123',
        email: 'user@example.com',
        planType: 'pro',
        isFedramp: false,
      },
      usage,
    })
    expect(response.capturedAt).toEqual(expect.any(Number))
  })

  it('returns a clear error when Codex is not logged in', async () => {
    mocks.refreshTokenIfNeeded.mockRejectedValue(new Error('Not logged in'))

    const response = await providersRpcHandlers.usage({ providerId: 'codex' })

    expect(response).toEqual({
      success: false,
      providerId: 'codex',
      error: 'Not logged in',
    })
    expect(mocks.fetchCodexUsage).not.toHaveBeenCalled()
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
