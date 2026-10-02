/**
 * MCP OAuth provider.
 *
 * Implements the v2 SDK's `OAuthClientProvider` shape (structurally — see
 * types.ts for why nothing here imports the SDK). One provider instance is
 * created per transport (= per connection attempt); state that must survive a
 * failed 401 attempt (the pending authorization URL, the loopback state, the
 * last issuer) lives in the shared `MCPOAuthFlowState` handed in by the flow
 * manager, while durable secrets (tokens, DCR registrations) go to the
 * issuer-keyed credential store.
 *
 * Registration: we do NOT set `clientMetadataUrl` — Client ID Metadata
 * Documents require a publicly hosted metadata URL, which a desktop/self-
 * hosted client does not have. With it absent the SDK falls back to Dynamic
 * Client Registration (RFC 7591) when the AS supports it. If onething ever
 * hosts a metadata document, one line here switches the mechanism.
 */

import type { MCPOAuthCredentialStore } from './credential-store.js'
import type {
  MCPOAuthClientInformation,
  MCPOAuthClientMetadata,
  MCPOAuthFlowState,
  MCPOAuthIssuerContext,
  MCPOAuthTokens,
} from './types.js'
import { getLogger } from '../../logging/index.js'

const log = getLogger('mcp.oauth')


export interface MCPOAuthProviderOptions {
  serverId: string
  clientName: string
  store: MCPOAuthCredentialStore
  flowState: MCPOAuthFlowState
  /** Loopback URL already registered with the callback server. */
  redirectUrl: string
  /** Optional scope override for servers that require specific scopes. */
  scope?: string
}

export class MCPOAuthProvider {
  private verifier: string | undefined

  constructor(private readonly options: MCPOAuthProviderOptions) {}

  get redirectUrl(): string {
    return this.options.redirectUrl
  }

  get clientMetadata(): MCPOAuthClientMetadata {
    return {
      client_name: this.options.clientName,
      redirect_uris: [this.options.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.options.scope ? { scope: this.options.scope } : {}),
    }
  }

  /**
   * Correlates the authorization request with our loopback registration.
   * Always set by `prepareProvider` before the SDK can start a flow.
   */
  state(): string {
    const state = this.options.flowState.state
    if (!state) throw new Error('OAuth flow was not prepared for this server')
    return state
  }

  /**
   * Issuer resolution order: explicit SDK context → this session's last-used
   * issuer → the persisted server↔issuer binding (cold-start path). There is
   * deliberately NO global "latest tokens" fallback: a bearer read that
   * crosses issuers would leak server B's access token to server A.
   */
  private resolveIssuer(ctx?: MCPOAuthIssuerContext): string | undefined {
    return (
      ctx?.issuer ??
      this.options.flowState.lastIssuer ??
      this.options.store.issuerForServer(this.options.serverId)
    )
  }

  clientInformation(ctx?: MCPOAuthIssuerContext): MCPOAuthClientInformation | undefined {
    const issuer = this.resolveIssuer(ctx)
    return issuer ? this.options.store.clientInformation(issuer) : undefined
  }

  saveClientInformation(info: MCPOAuthClientInformation, ctx?: MCPOAuthIssuerContext): void {
    const issuer = ctx?.issuer ?? info.issuer
    if (!issuer) {
      log.warn('DCR registration arrived without an issuer, not persisted', { serverId: this.options.serverId })
      return
    }
    this.options.flowState.lastIssuer = issuer
    this.options.store.saveClientInformation(issuer, info)
    this.options.store.bindServer(this.options.serverId, issuer)
  }

  tokens(ctx?: MCPOAuthIssuerContext): MCPOAuthTokens | undefined {
    // The transport's per-request bearer read passes no context; the
    // persisted binding is what answers it correctly after a restart.
    const issuer = this.resolveIssuer(ctx)
    return issuer ? this.options.store.tokens(issuer) : undefined
  }

  saveTokens(tokens: MCPOAuthTokens, ctx?: MCPOAuthIssuerContext): void {
    const issuer = ctx?.issuer ?? tokens.issuer
    if (!issuer) {
      log.warn('tokens arrived without an issuer, not persisted', { serverId: this.options.serverId })
      return
    }
    this.options.flowState.lastIssuer = issuer
    this.options.store.saveTokens(issuer, { ...tokens, issuer })
    this.options.store.bindServer(this.options.serverId, issuer)
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier
  }

  codeVerifier(): string {
    if (!this.verifier) {
      throw new Error('No PKCE code verifier saved for this flow')
    }
    return this.verifier
  }

  /**
   * The SDK calls this when the server demands authorization. We do NOT open
   * a browser here — the URL is stashed for the UI, which decides how to open
   * it (shell.openExternal on desktop, new tab on web). The SDK throws
   * UnauthorizedError right after; the connect failure plus this stash is
   * what surfaces "登录" on the server card.
   */
  redirectToAuthorization(authorizationUrl: URL): void {
    this.options.flowState.pendingAuthorizationUrl = authorizationUrl.toString()
  }

  /**
   * Logout / "重新授权": forget what the server told us is no longer valid.
   * Scoped to the issuer this server last used — other servers backed by a
   * different AS keep their credentials.
   */
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'verifier' || scope === 'all') {
      this.verifier = undefined
    }
    if (scope === 'discovery') return
    const issuer = this.resolveIssuer()
    if (!issuer) return
    if (scope === 'all') {
      this.options.store.clear(issuer, 'all')
    } else if (scope === 'tokens') {
      this.options.store.clear(issuer, 'tokens')
    } else if (scope === 'client') {
      this.options.store.clear(issuer, 'client')
    }
  }
}
