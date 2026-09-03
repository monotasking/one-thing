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

/**
 * 还原成编译进来的缺省(C0 R6 把它从「测试专用」提成正式的还原口:
 * `applyHostPorts` 的还原函数在 `backend.dispose()` 时调它)。
 */
export function resetMCPClientIdentity(): void {
  identity = { name: 'onething', version: '0.0.0' }
}

/** @deprecated 改用 {@link resetMCPClientIdentity}(同一个函数,C0 R6 改名)。 */
export const resetMCPClientIdentityForTests = resetMCPClientIdentity
