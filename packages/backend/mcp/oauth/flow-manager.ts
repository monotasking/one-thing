/**
 * MCP OAuth flow manager.
 *
 * Owns everything about an in-flight authorization that a single connection
 * attempt cannot carry:
 *
 *  - the loopback callback registration (shared `CallbackServerManager`,
 *    dedicated port range so provider-OAuth flows never collide with ours);
 *  - the per-server `MCPOAuthFlowState` shared across transport recreations;
 *  - the `finishAuth`-capable transport reference — the v2 SDK requires the
 *    authorization code to be redeemed on the SAME transport that took the
 *    401, but a failed connect discards it from the runtime, so we hold it;
 *  - completing the flow: redeem code → close the stale transport → ask the
 *    host to reconnect (a fresh transport then reads the just-saved tokens).
 */

import { randomUUID } from 'node:crypto'
import { callbackServerManager } from '@onething/runtime/auth/callback-server'
import { MCPOAuthCredentialStore } from './credential-store.js'
import { MCPOAuthProvider } from './provider.js'
import type { MCPOAuthFlowState, MCPServerOAuthSurface } from './types.js'

/** Loopback ports for MCP OAuth callbacks (provider OAuth uses 1455/1457/54545). */
export const MCP_OAUTH_CALLBACK_PORTS = [51823, 51824, 51825]
const MCP_OAUTH_CALLBACK_PATH = '/oauth/callback'
const MCP_OAUTH_FLOW_TIMEOUT_MS = 10 * 60 * 1000

interface FinishAuthCapableTransport {
  finishAuth(code: string, iss?: string): Promise<void>
  close(): Promise<void>
}

interface ServerFlow {
  state: MCPOAuthFlowState
  provider: MCPOAuthProvider
  transport?: FinishAuthCapableTransport
  registered: boolean
}

export interface MCPOAuthFlowManagerOptions {
  credentialStorePath: string
  /** Called after tokens land: the host reconnects the server. */
  onAuthorized: (serverId: string) => void
  logger?: Pick<Console, 'log' | 'warn' | 'error'>
}

export class MCPOAuthFlowManager {
  readonly store: MCPOAuthCredentialStore
  private readonly flows = new Map<string, ServerFlow>()
  private readonly onAuthorized: (serverId: string) => void
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>

  constructor(options: MCPOAuthFlowManagerOptions) {
    this.store = new MCPOAuthCredentialStore(options.credentialStorePath)
    this.onAuthorized = options.onAuthorized
    this.logger = options.logger ?? console
  }

  /**
   * Build the auth provider for one connection attempt. The provider instance
   * is REUSED across attempts of the same server: it holds the PKCE verifier,
   * which must survive from the 401 (redirect) until the callback redeems the
   * code — a fresh instance per attempt would strand in-flight flows.
   * The loopback registration is renewed on every attempt (it expires).
   */
  async prepareProvider(serverId: string, clientName: string): Promise<MCPOAuthProvider> {
    const existing = this.flows.get(serverId)
    if (existing?.registered && existing.state.state) {
      await this.registerCallback(serverId, existing.state)
      return existing.provider
    }

    const state: MCPOAuthFlowState = existing?.state ?? {}
    state.state = randomUUID()
    await this.registerCallback(serverId, state)

    const provider = new MCPOAuthProvider({
      serverId,
      clientName,
      store: this.store,
      flowState: state,
      redirectUrl: state.redirectUrl!,
    })

    this.flows.set(serverId, { state, provider, registered: true })
    return provider
  }

  private async registerCallback(serverId: string, state: MCPOAuthFlowState): Promise<void> {
    const registration = await callbackServerManager.registerFlow({
      flowId: randomUUID(),
      providerId: `mcp:${serverId}`,
      state: state.state!,
      path: MCP_OAUTH_CALLBACK_PATH,
      ports: MCP_OAUTH_CALLBACK_PORTS,
      timeoutMs: MCP_OAUTH_FLOW_TIMEOUT_MS,
      onCallback: async ({ code, iss }) => {
        await this.completeFlow(serverId, code, iss)
      },
    })
    state.redirectUrl = registration.redirectUri
  }

  /** The transport that just took a 401 is the one that can redeem the code. */
  attachTransport(serverId: string, transport: FinishAuthCapableTransport): void {
    const flow = this.flows.get(serverId)
    if (flow) flow.transport = transport
  }

  /** What the server card shows: "登录" (with URL) or "已授权 issuer". */
  surface(serverId: string, connected: boolean): MCPServerOAuthSurface | undefined {
    const flow = this.flows.get(serverId)
    const pendingUrl = flow?.state.pendingAuthorizationUrl
    if (pendingUrl) {
      return { status: 'required', authorizationUrl: pendingUrl }
    }
    // In-session flow state first; the persisted binding covers restarts.
    const issuer = flow?.state.lastIssuer ?? this.store.issuerForServer(serverId)
    if (connected && issuer && this.store.tokens(issuer)) {
      return { status: 'authorized', issuer }
    }
    return undefined
  }

  pendingAuthorizationUrl(serverId: string): string | undefined {
    return this.flows.get(serverId)?.state.pendingAuthorizationUrl
  }

  /**
   * Redeem the authorization code on the originating transport, then drop it:
   * the fresh connect the host runs afterwards reads tokens from the store.
   */
  async completeFlow(serverId: string, code: string, iss?: string): Promise<void> {
    const flow = this.flows.get(serverId)
    if (!flow?.transport) {
      this.logger.warn?.(`[MCP:${serverId}] OAuth callback arrived but no pending transport exists`)
      return
    }
    try {
      await flow.transport.finishAuth(code, iss)
    } catch (error) {
      this.logger.error?.(`[MCP:${serverId}] OAuth token exchange failed:`, error)
      return
    }

    flow.state.pendingAuthorizationUrl = undefined
    const stale = flow.transport
    flow.transport = undefined
    stale.close().catch(() => {})

    this.logger.log?.(`[MCP:${serverId}] OAuth authorized; reconnecting`)
    this.onAuthorized(serverId)
  }

  /** "重新授权": forget credentials for this server's issuer and start over. */
  logout(serverId: string): void {
    const flow = this.flows.get(serverId)
    // The provider clears the PKCE verifier and whatever the store resolves;
    // the explicit store-level clear below covers the post-restart case where
    // no flow/provider exists yet (resolved via the persisted binding).
    const issuer = flow?.state.lastIssuer ?? this.store.issuerForServer(serverId)
    flow?.provider.invalidateCredentials('all')
    if (issuer) this.store.clear(issuer, 'all')
    this.store.unbindServer(serverId)
    if (flow) {
      flow.state.pendingAuthorizationUrl = undefined
      flow.state.lastIssuer = undefined
    }
  }

  /** Drop the in-flight flow (server removed / shutting down). */
  clear(serverId: string): void {
    const flow = this.flows.get(serverId)
    if (flow?.state.state) {
      callbackServerManager.unregisterState(flow.state.state)
    }
    this.flows.delete(serverId)
  }
}
