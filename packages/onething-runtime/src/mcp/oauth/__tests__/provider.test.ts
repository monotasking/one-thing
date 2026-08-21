import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MCPOAuthCredentialStore } from '../credential-store.js'
import { MCPOAuthProvider } from '../provider.js'
import type { MCPOAuthFlowState } from '../types.js'

let dir: string
let store: MCPOAuthCredentialStore
let flowState: MCPOAuthFlowState

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-provider-test-'))
  store = new MCPOAuthCredentialStore(path.join(dir, 'creds.json'))
  flowState = { state: 'flow-state-1', redirectUrl: 'http://localhost:51823/oauth/callback' }
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function makeProvider(): MCPOAuthProvider {
  return new MCPOAuthProvider({
    serverId: 'srv-1',
    clientName: 'one-thing',
    store,
    flowState,
    redirectUrl: 'http://localhost:51823/oauth/callback',
  })
}

describe('MCPOAuthProvider', () => {
  it('declares authorization-code + PKCE client metadata', () => {
    const provider = makeProvider()
    expect(provider.clientMetadata).toEqual({
      client_name: 'one-thing',
      redirect_uris: ['http://localhost:51823/oauth/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    })
    expect(provider.state()).toBe('flow-state-1')
  })

  it('stashes the authorization URL for the UI instead of opening a browser', () => {
    const provider = makeProvider()
    provider.redirectToAuthorization(new URL('https://auth.example.com/authorize?client_id=x'))
    expect(flowState.pendingAuthorizationUrl).toBe('https://auth.example.com/authorize?client_id=x')
  })

  it('round-trips the PKCE verifier', () => {
    const provider = makeProvider()
    provider.saveCodeVerifier('verifier-123')
    expect(provider.codeVerifier()).toBe('verifier-123')
  })

  it('persists tokens keyed by the context issuer and reads them back per issuer', () => {
    const provider = makeProvider()
    provider.saveTokens({ access_token: 'a', token_type: 'Bearer' }, { issuer: 'https://auth-a.example.com' })
    provider.saveTokens({ access_token: 'b', token_type: 'Bearer' }, { issuer: 'https://auth-b.example.com' })

    expect(provider.tokens({ issuer: 'https://auth-a.example.com' })?.access_token).toBe('a')
    // The no-context per-request bearer read is issuer-scoped: this server's
    // last issuer wins, NEVER a global latest (which would leak cross-issuer).
    expect(provider.tokens()?.access_token).toBe('b')
    // The flow remembers the last issuer for later scoped operations.
    expect(flowState.lastIssuer).toBe('https://auth-b.example.com')
  })

  it('never leaks another issuer\'s tokens on the no-context bearer read', () => {
    // Server A persists credentials under issuer X (this also writes the
    // server→issuer binding, simulating a previous session).
    const providerA = makeProvider()
    providerA.saveTokens({ access_token: 'a-token', token_type: 'Bearer' }, { issuer: 'https://auth-x.example.com' })

    // Server B (different provider, different serverId, fresh flow state —
    // the post-restart shape) must see NOTHING, not server A's token.
    const providerB = new MCPOAuthProvider({
      serverId: 'srv-2',
      clientName: 'one-thing',
      store,
      flowState: { state: 's2', redirectUrl: 'http://localhost:51824/oauth/callback' },
      redirectUrl: 'http://localhost:51824/oauth/callback',
    })
    expect(providerB.tokens()).toBeUndefined()

    // And server A's cold-started provider (fresh flow state, no lastIssuer)
    // still resolves its own issuer through the persisted binding.
    const providerACold = new MCPOAuthProvider({
      serverId: 'srv-1',
      clientName: 'one-thing',
      store,
      flowState: {},
      redirectUrl: 'http://localhost:51823/oauth/callback',
    })
    expect(providerACold.tokens()?.access_token).toBe('a-token')
  })

  it('persists DCR client information keyed by issuer', () => {
    const provider = makeProvider()
    provider.saveClientInformation({ client_id: 'cid-1' }, { issuer: 'https://auth.example.com' })
    expect(provider.clientInformation({ issuer: 'https://auth.example.com' })?.client_id).toBe('cid-1')
    // No context: falls back to the last-used issuer.
    expect(provider.clientInformation()?.client_id).toBe('cid-1')
  })

  it('invalidateCredentials(all) clears the last issuer and the verifier', () => {
    const provider = makeProvider()
    provider.saveTokens({ access_token: 'a', token_type: 'Bearer' }, { issuer: 'https://auth-a.example.com' })
    provider.saveCodeVerifier('v')
    provider.invalidateCredentials('all')

    expect(provider.tokens({ issuer: 'https://auth-a.example.com' })).toBeUndefined()
    expect(() => provider.codeVerifier()).toThrow()
  })

  it('invalidateCredentials(tokens) keeps the DCR registration', () => {
    const provider = makeProvider()
    provider.saveClientInformation({ client_id: 'cid-1' }, { issuer: 'https://auth-a.example.com' })
    provider.saveTokens({ access_token: 'a', token_type: 'Bearer' }, { issuer: 'https://auth-a.example.com' })
    provider.invalidateCredentials('tokens')

    expect(provider.tokens({ issuer: 'https://auth-a.example.com' })).toBeUndefined()
    expect(provider.clientInformation({ issuer: 'https://auth-a.example.com' })?.client_id).toBe('cid-1')
  })
})
