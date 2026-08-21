/**
 * MCP client identity (clientInfo.name / clientInfo.version).
 *
 * The product name is always "onething" — one product, one identity, every
 * host (desktop, web server, CLI). The version is host-known, not
 * package-known: Electron learns it from `app.getVersion()` at boot, the
 * dev-run server reads the repo's root package.json, and workspace packages
 * all say 0.0.0 (only the root carries the product version). Late-bound like
 * the other configure* ports; hosts that never configure keep the default.
 */

export interface MCPClientIdentity {
  name: string
  version: string
}

let identity: MCPClientIdentity = { name: 'onething', version: '0.0.0' }

export function configureMCPClientIdentity(next: { name?: string; version?: string }): void {
  const name = next.name?.trim()
  const version = next.version?.trim()
  identity = {
    name: name || identity.name,
    version: version || identity.version,
  }
}

export function getMCPClientIdentity(): MCPClientIdentity {
  return identity
}

/** Test hook: restore the compiled-in default between suites. */
export function resetMCPClientIdentityForTests(): void {
  identity = { name: 'onething', version: '0.0.0' }
}
