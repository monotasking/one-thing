/**
 * Prompt fragments — the unit of composition for the system prompt.
 *
 * The prompt used to be one hand-ordered array inside the builder, with tool
 * knowledge (which sections exist only when `variable` is present, which
 * bullets belong to `edit`) hard-coded next to the persona. That coupling is
 * what made the prompt drift from the tool surface: a tool disabled for a turn
 * kept its paragraph, a tool registered by a plugin or a runtime feature had
 * no way to bring one.
 *
 * A fragment is a self-describing piece: **where** it lands (`slot`), **who**
 * contributed it (`source`), **when** it applies (`requiresTools` /
 * `requiresAnyTools` / `when`), and **what** it says (`content`). The builder
 * only sorts, filters and renders. Everything that used to be a special case —
 * builtin sections, tool guidelines, plugin context — is the same shape.
 *
 * Tools do not construct fragments by hand: they declare a
 * `CoreToolPromptContribution` next to their definition, and
 * `promptFragmentsFromToolContribution` derives fragments that require the
 * tool itself. Register the tool → the prompt follows; disable it for a turn
 * → the prompt drops it; unregister → gone. No second bookkeeping.
 */
import type { CoreBuildPromptContextOptions } from './system-prompt.js'

/**
 * Where a fragment lands.
 *
 * - `guidelines` — a bullet under the `Tool Guidelines:` list inside the core
 *   system block (the persona message). Short, imperative, tool-usage rules.
 * - `workspace-rules` — a bullet under `## Tool Workspace Rules` inside the
 *   `# Work Directory` section (only rendered when a working directory exists).
 * - `section` — a standalone developer section with its own name (`id`). This
 *   is what `disabledSections`, snapshots and evals see as a named section.
 */
export type CorePromptSlot = 'guidelines' | 'workspace-rules' | 'section'

/**
 * **Where** a fragment is delivered (the third axis, next to `slot` and the
 * `requires*` gates — see `docs/design/prompt-channels-2026-08.md`).
 *
 * - `system` (default) — the static prefix. Bytes must not depend on the
 *   session or the turn: any change invalidates the prompt cache for every
 *   session sharing that prefix.
 * - `turn` — delivered in the `<context-update>` tail block of the latest user
 *   message, deduped per block against the visible history and replayed
 *   verbatim from the message afterwards. This is where every session- or
 *   turn-level fact belongs (working directory, projects, skills, todo,
 *   AGENTS.md, voice flag, plugin providers, the variable board).
 *
 * Only `slot: 'section'` fragments can be `turn`; guidelines and workspace
 * rules are standing rules and are always part of the static prefix. The
 * channel decides **where** a fragment lands, never **whether** it applies —
 * `requiresTools` / `when` / `disabledSections` behave identically on both.
 */
export type CorePromptChannel = 'system' | 'turn'

export type CorePromptFragmentRender = (
  ctx: CoreBuildPromptContextOptions,
) => string | false | null | undefined

export interface CorePromptFragment {
  /**
   * Stable id. For `slot: 'section'` it is the section name — the key that
   * `disabledSections`, prompt snapshots and eval section hashes use — so it
   * must not change casually. For bullets it only needs to be unique per
   * source (diagnostics and dedupe).
   */
  id: string
  slot: CorePromptSlot
  /**
   * Delivery channel. Omitted = `'system'` (the static prefix). Set `'turn'`
   * when the content reads a session/turn-level fact — see
   * `CorePromptChannel`. Ignored for the two bullet slots.
   */
  channel?: CorePromptChannel
  /**
   * Optional group name, matched by `disabledSections` alongside the id. It
   * exists so a family of per-instance fragments (plugin providers, whose ids
   * are `plugin:<pluginId>/<providerId>` so each dedupes on its own) can still
   * be switched off by one name (`plugins`).
   */
  group?: string
  /**
   * Who contributed it: `builtin`, `tool:<toolId>`, `plugin:<pluginId>`,
   * `feature:<featureId>`, … Free-form, for diagnostics; the builder does not
   * branch on it.
   */
  source: string
  /**
   * Sort key inside the slot, ascending. Builtin sections use 100-steps in
   * their historical order; tool contributions default to
   * `CORE_PROMPT_ORDER_TOOL`, plugin context to `CORE_PROMPT_ORDER_PLUGIN`.
   * Omitted = `CORE_PROMPT_ORDER_TOOL` (after the builtin table — never
   * first). Ties keep insertion order (stable sort).
   */
  order?: number
  /** Tool ids that must ALL be on the turn's tool surface. */
  requiresTools?: readonly string[]
  /** At least one of these tool ids must be on the turn's tool surface. */
  requiresAnyTools?: readonly string[]
  /** Extra predicate; evaluated after the tool requirements. */
  when?: (ctx: CoreBuildPromptContextOptions) => boolean
  /** Static text, or a renderer. Empty / falsy output omits the fragment. */
  content: string | CorePromptFragmentRender
}

/** Default order for tool-contributed sections: after every builtin section. */
export const CORE_PROMPT_ORDER_TOOL = 2000
/** Default order for plugin prompt context: after tool sections. */
export const CORE_PROMPT_ORDER_PLUGIN = 3000

/**
 * What a tool declares next to its definition. Every part is optional and
 * static — a tool's prompt does not depend on the turn; if it would, that is
 * a `<context-update>` fact, not a prompt fragment.
 */
export interface CoreToolPromptContribution {
  /** Bullets for the `Tool Guidelines:` list in the core system block. */
  guidelines?: readonly string[]
  /** Bullets for `## Tool Workspace Rules` inside `# Work Directory`. */
  workspaceRules?: readonly string[]
  /**
   * Standalone developer sections. `id` defaults to the tool id; give an
   * explicit one when the section is a named concept of its own (the
   * `variable` tool owns `context-variables`).
   */
  sections?: ReadonlyArray<{ id?: string; content: string; order?: number }>
}

/** Enabled tool ids of the turn — the only thing tool requirements are checked against. */
export function corePromptToolSurface(ctx: CoreBuildPromptContextOptions): ReadonlySet<string> {
  if (!ctx.hasTools) return EMPTY
  return new Set(ctx.toolNames ?? [])
}

const EMPTY: ReadonlySet<string> = new Set()

export function isCorePromptFragmentActive(
  fragment: CorePromptFragment,
  ctx: CoreBuildPromptContextOptions,
  surface: ReadonlySet<string> = corePromptToolSurface(ctx),
): boolean {
  if (fragment.requiresTools?.length) {
    for (const id of fragment.requiresTools) if (!surface.has(id)) return false
  }
  if (fragment.requiresAnyTools?.length) {
    if (!fragment.requiresAnyTools.some(id => surface.has(id))) return false
  }
  if (fragment.when && !fragment.when(ctx)) return false
  return true
}

export function renderCorePromptFragment(
  fragment: CorePromptFragment,
  ctx: CoreBuildPromptContextOptions,
): string | undefined {
  const raw = typeof fragment.content === 'function' ? fragment.content(ctx) : fragment.content
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  return text ? text : undefined
}

/**
 * Derive fragments from a tool's declaration. Every fragment requires the tool
 * itself, so the prompt follows the tool surface with no extra wiring.
 */
export function promptFragmentsFromToolContribution(
  toolId: string,
  prompt: CoreToolPromptContribution | undefined,
): CorePromptFragment[] {
  if (!prompt) return []
  const source = `tool:${toolId}`
  const out: CorePromptFragment[] = []
  ;(prompt.guidelines ?? []).forEach((text, index) => {
    out.push({
      id: `${toolId}:guideline:${index}`,
      slot: 'guidelines',
      source,
      order: CORE_PROMPT_ORDER_TOOL,
      requiresTools: [toolId],
      content: text,
    })
  })
  ;(prompt.workspaceRules ?? []).forEach((text, index) => {
    out.push({
      id: `${toolId}:workspace-rule:${index}`,
      slot: 'workspace-rules',
      source,
      order: CORE_PROMPT_ORDER_TOOL,
      requiresTools: [toolId],
      content: text,
    })
  })
  for (const section of prompt.sections ?? []) {
    out.push({
      id: section.id ?? toolId,
      slot: 'section',
      source,
      order: section.order ?? CORE_PROMPT_ORDER_TOOL,
      requiresTools: [toolId],
      content: section.content,
    })
  }
  return out
}

/**
 * Structural validation for declarations that cross a trust boundary (plugin
 * tools). Returns a human-readable problem or `undefined` when the shape is
 * acceptable. Builtin tools are typed; this guards the untyped edge.
 */
export function describeToolPromptContributionProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'prompt must be an object'
  }
  const prompt = value as Record<string, unknown>
  for (const key of ['guidelines', 'workspaceRules'] as const) {
    const list = prompt[key]
    if (list === undefined) continue
    if (!Array.isArray(list) || list.some(item => typeof item !== 'string' || !item.trim())) {
      return `prompt.${key} must be an array of non-empty strings`
    }
  }
  const sections = prompt.sections
  if (sections !== undefined) {
    if (!Array.isArray(sections)) return 'prompt.sections must be an array'
    for (const section of sections) {
      if (!section || typeof section !== 'object') return 'prompt.sections[] must be objects'
      const s = section as Record<string, unknown>
      if (typeof s.content !== 'string' || !s.content.trim()) {
        return 'prompt.sections[].content must be a non-empty string'
      }
      if (s.id !== undefined && (typeof s.id !== 'string' || !s.id.trim())) {
        return 'prompt.sections[].id must be a non-empty string when given'
      }
      if (s.order !== undefined && typeof s.order !== 'number') {
        return 'prompt.sections[].order must be a number when given'
      }
    }
  }
  const unknown = Object.keys(prompt).filter(
    key => key !== 'guidelines' && key !== 'workspaceRules' && key !== 'sections',
  )
  if (unknown.length > 0) return `prompt has unknown keys: ${unknown.join(', ')}`
  return undefined
}
