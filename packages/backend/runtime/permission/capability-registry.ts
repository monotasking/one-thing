import * as os from 'node:os'
import * as path from 'node:path'

/**
 * A capability is one answer to a single question: "which directory may the
 * assistant act on, in what way, without being asked every time?"
 *
 * Before this existed, that question was answered in five unrelated places —
 * a hardcoded read filter, a list of `safe` tools, an app-owned path list, the
 * permission mode, and user grants — and none of them could see the others. A
 * capability is the one shape all of those collapse into, so the answer can be
 * listed, audited, and switched off in one place.
 *
 * See docs/design/capability-registry.md.
 */

/** What the assistant may do inside the directory. */
export type CapabilityAction = 'read' | 'write'

/**
 * Who decided this capability exists. Deliberately a closed set of two: the app
 * ships it, or the user added it. The assistant is never in this enum — it may
 * propose a change (which raises a `capability_change` permission effect) but it
 * can never be the authority behind one.
 */
export type CapabilityAuthority = 'builtin' | 'user'

export interface Capability {
  /** Stable identity, e.g. 'todo.sessions'. Used for settings and telemetry. */
  id: string
  /** Human-readable, shown in settings. */
  label: string
  /**
   * Resolved on every check rather than stored: the todo directory is a user
   * setting and can move while the app runs, and the server resolves per-owner
   * paths that no static string could express.
   */
  directory: () => string | undefined
  actions: readonly CapabilityAction[]
  authority: CapabilityAuthority
  /** Set false to keep the capability listed but inert. */
  enabled?: boolean
  /**
   * When true, this directory is force-asked rather than allowed — used to
   * carve exceptions (a secrets directory) out of a broader capability. Deny
   * always wins over allow.
   */
  deny?: boolean
}

/** Why a capability was refused, so callers can surface it instead of failing silently. */
export type CapabilityRejection =
  | { reason: 'unresolved' }
  | { reason: 'too-broad'; directory: string }

export interface CapabilityResolution {
  capability: Capability
  directory: string
}

const registry = new Map<string, Capability>()

export function registerCapability(capability: Capability): void {
  registry.set(capability.id, capability)
}

export function unregisterCapability(id: string): boolean {
  return registry.delete(id)
}

export function listCapabilities(): Capability[] {
  return [...registry.values()]
}

export function resetCapabilitiesForTests(): void {
  registry.clear()
}

/**
 * A capability must name somewhere specific. Its directory can come from a
 * free-text setting or from a user-added entry, so a careless '~' must not be
 * able to turn one row of config into a blanket permit over the whole home
 * directory. Refusing here is not enough on its own — callers are expected to
 * surface the rejection, because a silently-ignored capability looks exactly
 * like a working one until you notice the prompts.
 */
export function rejectionFor(directory: string | undefined): CapabilityRejection | undefined {
  const trimmed = directory?.trim()
  if (!trimmed) return { reason: 'unresolved' }

  const resolved = path.resolve(trimmed)
  const home = os.homedir()
  if (resolved === path.parse(resolved).root) return { reason: 'too-broad', directory: resolved }
  if (home && isWithin(home, resolved)) return { reason: 'too-broad', directory: resolved }
  return undefined
}

export function isWithin(target: string, directory: string): boolean {
  const relative = path.relative(directory, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Directory the resource sits in. File effects carry a `<dirname>/*` glob rather
 * than the file itself, so the containment test runs against the directory the
 * glob would cover: if that whole directory is inside a capability, every file
 * it can reach is too.
 */
export function resourceDirectory(resource: string): string | undefined {
  if (!path.isAbsolute(resource)) return undefined
  const withoutGlob = resource.endsWith('*') ? path.dirname(resource) : resource
  return path.resolve(withoutGlob)
}

function usable(capability: Capability, action: CapabilityAction): boolean {
  if (capability.enabled === false) return false
  return capability.actions.includes(action)
}

/** The capability covering this resource for this action, if any. Deny wins. */
export function resolveCapability(
  resource: string,
  action: CapabilityAction,
): CapabilityResolution | undefined {
  const target = resourceDirectory(resource)
  if (!target) return undefined

  let allowed: CapabilityResolution | undefined
  for (const capability of registry.values()) {
    if (!usable(capability, action)) continue
    const directory = capability.directory()
    if (!directory || rejectionFor(directory)) continue

    const resolved = path.resolve(directory)
    if (!isWithin(target, resolved)) continue

    // A deny anywhere in the set settles it — no allow can override it.
    if (capability.deny) return undefined
    allowed ??= { capability, directory: resolved }
  }
  return allowed
}

/** True when every resource is covered for the action. A partial match is not a match. */
export function coversAll(resources: readonly string[], action: CapabilityAction): boolean {
  if (resources.length === 0) return false
  return resources.every(resource => Boolean(resolveCapability(resource, action)))
}
