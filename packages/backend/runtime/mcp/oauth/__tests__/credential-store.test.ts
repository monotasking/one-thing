import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MCPOAuthCredentialStore } from '../credential-store.js'

let dir: string
let storePath: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-test-'))
  storePath = path.join(dir, 'mcp-oauth-credentials.json')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('MCPOAuthCredentialStore', () => {
  it('starts empty when the file does not exist', () => {
    const store = new MCPOAuthCredentialStore(storePath)
    expect(store.tokens('https://auth.example.com')).toBeUndefined()
    expect(store.issuerForServer('srv-1')).toBeUndefined()
  })

  it('persists tokens keyed by issuer', () => {
    const store = new MCPOAuthCredentialStore(storePath)
    store.saveTokens('https://auth-a.example.com', { access_token: 'a', token_type: 'Bearer' })
    store.saveTokens('https://auth-b.example.com', { access_token: 'b', token_type: 'Bearer' })

    // Re-read from disk: a fresh instance sees the same data.
    const reread = new MCPOAuthCredentialStore(storePath)
    expect(reread.tokens('https://auth-a.example.com')?.access_token).toBe('a')
    expect(reread.tokens('https://auth-b.example.com')?.access_token).toBe('b')
  })

  it('persists server→issuer bindings across restarts', () => {
    const store = new MCPOAuthCredentialStore(storePath)
    store.saveTokens('https://auth-a.example.com', { access_token: 'a', token_type: 'Bearer' })
    store.bindServer('srv-1', 'https://auth-a.example.com')
    store.bindServer('srv-2', 'https://auth-b.example.com')

    // Re-read from disk: bindings survive (they are the cold-start resolver).
    const reread = new MCPOAuthCredentialStore(storePath)
    expect(reread.issuerForServer('srv-1')).toBe('https://auth-a.example.com')
    expect(reread.issuerForServer('srv-2')).toBe('https://auth-b.example.com')

    reread.unbindServer('srv-1')
    expect(reread.issuerForServer('srv-1')).toBeUndefined()
    expect(reread.issuerForServer('srv-2')).toBe('https://auth-b.example.com')
  })

  it('persists DCR client information keyed by issuer', () => {
    const store = new MCPOAuthCredentialStore(storePath)
    store.saveClientInformation('https://auth.example.com', { client_id: 'cid-1' })
    expect(store.clientInformation('https://auth.example.com')?.client_id).toBe('cid-1')
  })

  it('clears by scope without touching other issuers', () => {
    const store = new MCPOAuthCredentialStore(storePath)
    store.saveTokens('https://auth-a.example.com', { access_token: 'a', token_type: 'Bearer' })
    store.saveClientInformation('https://auth-a.example.com', { client_id: 'cid-a' })
    store.saveTokens('https://auth-b.example.com', { access_token: 'b', token_type: 'Bearer' })

    store.clear('https://auth-a.example.com', 'tokens')
    expect(store.tokens('https://auth-a.example.com')).toBeUndefined()
    expect(store.clientInformation('https://auth-a.example.com')?.client_id).toBe('cid-a')

    store.clear('https://auth-a.example.com', 'all')
    expect(store.entry('https://auth-a.example.com')).toBeUndefined()
    expect(store.tokens('https://auth-b.example.com')?.access_token).toBe('b')
  })

  it('writes the file with owner-only permissions', () => {
    const store = new MCPOAuthCredentialStore(storePath)
    store.saveTokens('https://auth.example.com', { access_token: 'a', token_type: 'Bearer' })
    const mode = fs.statSync(storePath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('survives a corrupt file by starting empty', () => {
    fs.writeFileSync(storePath, 'not json at all')
    const store = new MCPOAuthCredentialStore(storePath)
    expect(store.tokens('https://auth.example.com')).toBeUndefined()
  })
})
