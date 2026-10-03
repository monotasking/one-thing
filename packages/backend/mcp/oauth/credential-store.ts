/**
 * MCP OAuth credential store.
 *
 * Tokens and DCR client registrations are persisted **keyed by authorization-
 * server issuer** (SEP-2352: credentials are bound to the AS that issued them;
 * switching authorization servers requires re-registration). Two MCP servers
 * backed by the same AS deliberately share one entry — same principal.
 *
 * NOT settings.json: secrets live in their own file next to the other runtime
 * stores, written mode 0600, atomic (tmp + rename) so a crash mid-write cannot
 * truncate the credentials of every server at once.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { MCPOAuthClientInformation, MCPOAuthTokens } from './types.js'

export interface MCPOAuthCredentialEntry {
  tokens?: MCPOAuthTokens
  clientInformation?: MCPOAuthClientInformation
}

interface CredentialFile {
  version: 1
  issuers: Record<string, MCPOAuthCredentialEntry>
  /**
   * serverId → issuer binding. Written whenever a server's provider persists
   * credentials; this is what lets a cold-started process (no in-memory flow
   * state yet) resolve WHICH issuer a given server belongs to — for the
   * per-request bearer read, for the "authorized" badge, and for
   * "重新授权" (logout must find the credentials without a live flow).
   */
  servers?: Record<string, string>
}

export class MCPOAuthCredentialStore {
  constructor(private readonly filePath: string) {}

  entry(issuer: string): MCPOAuthCredentialEntry | undefined {
    return this.readFile().issuers[issuer]
  }

  tokens(issuer: string): MCPOAuthTokens | undefined {
    return this.entry(issuer)?.tokens
  }

  clientInformation(issuer: string): MCPOAuthClientInformation | undefined {
    return this.entry(issuer)?.clientInformation
  }

  saveTokens(issuer: string, tokens: MCPOAuthTokens): void {
    this.mutate(file => {
      file.issuers[issuer] = { ...file.issuers[issuer], tokens }
    })
  }

  saveClientInformation(issuer: string, clientInformation: MCPOAuthClientInformation): void {
    this.mutate(file => {
      file.issuers[issuer] = { ...file.issuers[issuer], clientInformation }
    })
  }

  clear(issuer: string, scope: 'all' | 'client' | 'tokens'): void {
    this.mutate(file => {
      const entry = file.issuers[issuer]
      if (!entry) return
      if (scope === 'all') {
        delete file.issuers[issuer]
      } else if (scope === 'tokens') {
        delete entry.tokens
      } else {
        delete entry.clientInformation
      }
    })
  }

  /** Record that `serverId`'s credentials live under `issuer`. */
  bindServer(serverId: string, issuer: string): void {
    this.mutate(file => {
      file.servers = { ...file.servers, [serverId]: issuer }
    })
  }

  issuerForServer(serverId: string): string | undefined {
    return this.readFile().servers?.[serverId]
  }

  unbindServer(serverId: string): void {
    this.mutate(file => {
      if (file.servers) delete file.servers[serverId]
    })
  }

  private mutate(fn: (file: CredentialFile) => void): void {
    const file = this.readFile()
    fn(file)
    this.writeFile(file)
  }

  private readFile(): CredentialFile {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as CredentialFile
      if (parsed && typeof parsed === 'object' && parsed.issuers && typeof parsed.issuers === 'object') {
        return {
          version: 1,
          issuers: parsed.issuers,
          ...(parsed.servers && typeof parsed.servers === 'object' ? { servers: parsed.servers } : {}),
        }
      }
    } catch {
      // Missing or corrupt file starts empty — never crash a connect for it.
    }
    return { version: 1, issuers: {} }
  }

  private writeFile(file: CredentialFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.filePath)
    try { fs.chmodSync(this.filePath, 0o600) } catch { /* best effort */ }
  }
}
