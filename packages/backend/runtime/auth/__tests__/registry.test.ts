import { describe, expect, it } from 'vitest'
import {
  generatePKCE,
  getAuthProviderDefinition,
  normalizeGenericOAuthToken,
} from '../index.js'

describe('onething runtime auth registry', () => {
  it('generates PKCE material without host dependencies', () => {
    const pkce = generatePKCE()

    expect(pkce.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(pkce.codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(pkce.codeVerifier).not.toBe(pkce.codeChallenge)
  })

  it('declares Codex OAuth parameters in runtime', () => {
    const definition = getAuthProviderDefinition('codex')

    expect(definition).toMatchObject({
      providerId: 'codex',
      flowKind: 'pkce-callback',
      oauthFlow: 'authorization-code',
      tokenBodyFormat: 'form',
    })
    expect(definition?.authorizationParams?.({
      providerId: 'codex',
      flowId: 'flow',
      state: 'state',
      redirectUri: 'http://127.0.0.1:1455/auth/callback',
      codeChallenge: 'challenge',
    })).toMatchObject({
      codex_cli_simplified_flow: 'true',
      originator: 'codex_cli_rs',
      code_challenge: 'challenge',
    })
  })

  it('normalizes generic OAuth token payloads', () => {
    const token = normalizeGenericOAuthToken({
      access_token: 'access',
      refresh_token: 'refresh',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'read',
    })

    expect(token).toMatchObject({
      accessToken: 'access',
      refreshToken: 'refresh',
      tokenType: 'Bearer',
      scope: 'read',
    })
    expect(token.expiresAt).toBeGreaterThan(Date.now())
  })
})
