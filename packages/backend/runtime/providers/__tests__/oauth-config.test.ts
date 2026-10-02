import { describe, expect, it, vi } from 'vitest'
import { resolveOnethingOAuthProviderConfig } from '../oauth-config.js'

describe('resolveOnethingOAuthProviderConfig', () => {
  it('skips non-OAuth providers without touching the token adapter', async () => {
    const refreshTokenIfNeeded = vi.fn()

    await expect(resolveOnethingOAuthProviderConfig({
      providerId: 'openai',
      baseConfig: { baseUrl: 'https://api.example.test', model: 'gpt-test' },
      requiresOAuth: () => false,
      refreshTokenIfNeeded,
    })).resolves.toBeNull()

    expect(refreshTokenIfNeeded).not.toHaveBeenCalled()
  })

  it('maps refreshed OAuth tokens into provider API-key config', async () => {
    await expect(resolveOnethingOAuthProviderConfig({
      providerId: 'codex',
      baseConfig: { baseUrl: 'https://codex.example.test' },
      requiresOAuth: id => id === 'codex',
      refreshTokenIfNeeded: vi.fn(async () => ({ accessToken: 'token-123' })),
    })).resolves.toEqual({
      apiKey: 'token-123',
      baseUrl: 'https://codex.example.test',
    })
  })

  it('logs and falls back to null when token refresh fails', async () => {
    const error = new Error('refresh failed')
    const logger = { error: vi.fn() }

    await expect(resolveOnethingOAuthProviderConfig({
      providerId: 'claude-code',
      baseConfig: {},
      requiresOAuth: () => true,
      refreshTokenIfNeeded: vi.fn(async () => {
        throw error
      }),
      logger,
    })).resolves.toBeNull()

    expect(logger.error).toHaveBeenCalledWith('Failed to get OAuth config for claude-code:', error)
  })
})
