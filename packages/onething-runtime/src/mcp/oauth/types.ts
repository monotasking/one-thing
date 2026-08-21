/**
 * MCP OAuth — local mirrors of the v2 SDK auth shapes.
 *
 * The boundary rule: `@modelcontextprotocol/*` may only be imported by the
 * designated SDK call sites (`app/mcp/client.ts`, `apps/server/src/mcp-client.ts`).
 * The OAuth provider is consumed BY those call sites structurally — the SDK's
 * `OAuthClientProvider` is an interface, so matching these shapes is enough and
 * the compiler validates the fit at the call site.
 */

/** Mirror of the SDK's `StoredOAuthTokens` (OAuthTokens + SEP-2352 issuer stamp). */
export interface MCPOAuthTokens {
  access_token: string
  id_token?: string
  token_type: string
  expires_in?: number
  scope?: string
  refresh_token?: string
  issuer?: string
}

/** Mirror of the SDK's `StoredOAuthClientInformation` (DCR registration result). */
export interface MCPOAuthClientInformation {
  client_id: string
  client_secret?: string
  client_id_issued_at?: number
  client_secret_expires_at?: number
  issuer?: string
}

/** Mirror of the SDK's `OAuthClientMetadata` (the fields we declare). */
export interface MCPOAuthClientMetadata {
  client_name: string
  redirect_uris: string[]
  grant_types: string[]
  response_types: string[]
  token_endpoint_auth_method: string
  scope?: string
}

/** Mirror of the SDK's `OAuthClientInformationContext`. */
export interface MCPOAuthIssuerContext {
  issuer: string
}

/**
 * Per-server ephemeral flow state. Lives in the flow manager, shared by the
 * provider instances created for successive connection attempts of the same
 * MCP server (a 401 discards the transport but must not lose the flow).
 */
export interface MCPOAuthFlowState {
  /** Stashed by redirectToAuthorization; the UI opens this URL. */
  pendingAuthorizationUrl?: string
  /** The state parameter correlating the loopback callback registration. */
  state?: string
  /** The redirect URL registered with the loopback callback server. */
  redirectUrl?: string
  /** Last authorization-server issuer this server authenticated against. */
  lastIssuer?: string
}

/** What the settings UI renders on a server card. */
export interface MCPServerOAuthSurface {
  status: 'required' | 'authorized'
  /** Present when status is 'required' — the UI opens this to log in. */
  authorizationUrl?: string
  /** Present when status is 'authorized' — the AS we hold credentials for. */
  issuer?: string
}
