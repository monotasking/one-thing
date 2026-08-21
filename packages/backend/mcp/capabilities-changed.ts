/**
 * Capabilities-changed fan-out (P2-1).
 *
 * When a server pushes `notifications/{tools,prompts,resources}/list_changed`
 * (legacy unsolicited delivery, or routed through an auto-opened
 * `subscriptions/listen` on a 2026-07-28 connection), the client runtime
 * re-reads the capability lists and updates its own state. The MODEL-facing
 * side — the tools catalog + router definitions — must regenerate too, but
 * the client cannot reach the bridge without closing an import cycle
 * (bridge ← manager ← client). Late-bound port, like the other configure*
 * seams: host IPC assemblies wire it to their `registerTools` path at boot.
 */

let handler: ((serverId: string) => void) | null = null

export function configureMCPCapabilitiesChangedHandler(h: ((serverId: string) => void) | null): void {
  handler = h
}

/**
 * R2b(§13.7 裁定 5)—— 新工具树的 MCP 目录挂点。
 *
 * **第二个口子而不是顶掉第一个**:上面那个 handler 归宿主的 `registerTools` 路
 * (旧注册表),新树的目录是并行的另一份。切换期两条路同时活着,所以通知点也要
 * 同时通知两边;R4 删旧树时这里只剩一个。开关关时它永远是 null。
 */
let toolkitHandler: ((serverId: string) => void) | null = null

export function configureToolkitMCPCapabilitiesChangedHandler(h: ((serverId: string) => void) | null): void {
  toolkitHandler = h
}

export function notifyMCPCapabilitiesChanged(serverId: string): void {
  handler?.(serverId)
  toolkitHandler?.(serverId)
}

/** Test hook. */
export function resetMCPCapabilitiesChangedHandlerForTests(): void {
  handler = null
  toolkitHandler = null
}
