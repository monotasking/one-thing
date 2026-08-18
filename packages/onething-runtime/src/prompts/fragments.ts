/**
 * Runtime prompt-fragment registry — the plug for contributors that are not
 * tools.
 *
 * Three ways into the prompt, one shape (`CorePromptFragment`):
 *
 * 1. **Tools** declare `prompt` on their definition; the assembly layer derives
 *    fragments from the turn's tool surface (`getToolPromptFragments`). Nothing
 *    to register here.
 * 2. **Plugins** keep `api.registerPromptContextProvider` (per-turn function,
 *    timeout + breaker) — see `plugin-context.ts`. Plugin *tools* go through 1.
 * 3. **Everything else** — a runtime feature, a host, a subsystem that has a
 *    standing paragraph to say — registers a fragment here and keeps the
 *    disposer. Unregister = the paragraph is gone next turn. This is the
 *    seam a `FeatureContext.registerDisposer(registerPromptFragment(...))`
 *    uses.
 *
 * Fragments registered here can still carry `requiresTools`, so a feature
 * whose paragraph only makes sense next to its tools declares that and stops
 * lying when the tools are off the surface.
 *
 * Module state is one Map; importing this file registers nothing.
 */
import type { CorePromptFragment } from '@onething/core/engine'
import type { PromptSource } from './composer.js'

export class PromptFragmentRegistry implements PromptSource {
  readonly name = 'registry'
  private readonly fragments = new Map<string, CorePromptFragment>()

  /**
   * Register a fragment. The key is `source + id`; registering the same key
   * again replaces the previous entry (last writer wins, no accumulation).
   * Returns an idempotent disposer that removes exactly this registration.
   */
  register(fragment: CorePromptFragment): () => void {
    const key = fragmentKey(fragment)
    this.fragments.set(key, fragment)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.fragments.get(key) === fragment) this.fragments.delete(key)
    }
  }

  /** Remove every fragment contributed by `source` (a plugin/feature teardown). */
  clearSource(source: string): number {
    let removed = 0
    for (const [key, fragment] of this.fragments) {
      if (fragment.source === source) {
        this.fragments.delete(key)
        removed += 1
      }
    }
    return removed
  }

  list(): CorePromptFragment[] {
    return [...this.fragments.values()]
  }

  /** `PromptSource`: everything registered, read fresh on every build. */
  collect(): CorePromptFragment[] {
    return this.list()
  }

  get size(): number {
    return this.fragments.size
  }

  clear(): void {
    this.fragments.clear()
  }
}

function fragmentKey(fragment: CorePromptFragment): string {
  return `${fragment.source}\u0001${fragment.slot}\u0001${fragment.id}`
}

/** The process-wide registry the assembly layer reads on every build. */
export const promptFragments = new PromptFragmentRegistry()

export function registerPromptFragment(fragment: CorePromptFragment): () => void {
  return promptFragments.register(fragment)
}

export function listRegisteredPromptFragments(): CorePromptFragment[] {
  return promptFragments.list()
}
