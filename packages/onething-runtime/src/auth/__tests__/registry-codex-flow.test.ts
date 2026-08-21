import { describe, expect, it } from 'vitest'
import { generatePKCE, getAuthProviderDefinition } from '../index.js'

describe('auth registry (codex callback flow)', () => {
  it('generates S256 PKCE material', () => {
    const pkce = generatePKCE()

    expect(pkce.codeVerifier.length).toBeGreaterThanOrEqual(43)
    expect(pkce.codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(pkce.codeChallenge).not.toEqual(pkce.codeVerifier)
  })

  it('declares Codex browser callback OAuth parameters', () => {
    const definition = getAuthProviderDefinition('codex')

    expect(definition?.flowKind).toBe('pkce-callback')
    expect(definition?.clientId).toBe('app_EMoamEEZ73f0CkXaXp7hrann')
    expect(definition?.callbackPorts).toEqual([1455, 1457])

    const params = definition?.authorizationParams?.({
      providerId: 'codex',
      flowId: 'flow-1',
      codeVerifier: 'verifier',
      codeChallenge: 'challenge',
      state: 'state-1',
      redirectUri: 'http://localhost:1455/auth/callback',
    })

    expect(params).toMatchObject({
      response_type: 'code',
      redirect_uri: 'http://localhost:1455/auth/callback',
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'codex_cli_rs',
    })
    expect(params?.scope).toContain('offline_access')
    expect(params?.scope).toContain('api.connectors.invoke')
  })
})

