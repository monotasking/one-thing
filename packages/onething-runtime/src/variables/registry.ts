import {
  VARIABLE_LIMITS,
  VariableError,
  type ContextVariable,
  type SetInput,
  type VariableContext,
  type VariableProvider,
  type VariableScope,
} from './types.js'
import { assertNotReserved, assertValidName, assertValidValue, findDuplicateNames } from './validation.js'

import { getLogger } from '../logging/index.js'

const log = getLogger('variables')

type ChangeListener = (ctx: VariableContext, snapshot: ContextVariable[]) => void

/**
 * The custom-variable store provider per scope. Non-store providers (core,
 * notes, goal, …) own reserved names and are reached through claims() when
 * no explicit store scope routes elsewhere.
 */
const STORE_IDS_BY_SCOPE: Record<VariableScope, string> = {
  global: 'global-store',
  session: 'session-store',
  agent: 'agent-store',
  project: 'project-store',
}

const STORE_IDS = new Set(Object.values(STORE_IDS_BY_SCOPE))

/** Store ids other than session-store — excluded from default routing. */
const NON_DEFAULT_STORE_IDS = new Set(
  Object.entries(STORE_IDS_BY_SCOPE)
    .filter(([scope]) => scope !== 'session')
    .map(([, id]) => id),
)

function scopeOfStoreId(id: string): VariableScope | undefined {
  return (Object.keys(STORE_IDS_BY_SCOPE) as VariableScope[])
    .find(scope => STORE_IDS_BY_SCOPE[scope] === id)
}

export class VariableRegistry {
  private providers: VariableProvider[] = []
  private listeners = new Set<ChangeListener>()
  private writeChains = new Map<string, Promise<unknown>>()
  private externalUnsubs: Array<() => void> = []

  register(provider: VariableProvider): void {
    if (this.providers.some(p => p.id === provider.id)) {
      throw new VariableError(
        'PROVIDER_CONFLICT',
        `Provider with id "${provider.id}" is already registered`,
      )
    }
    this.providers.push(provider)
    this.providers.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))

    if (provider.onExternalChange) {
      const unsub = provider.onExternalChange((ctx) => {
        if (ctx) {
          this.list(ctx)
            .then(snapshot => this.emit(ctx, snapshot))
            .catch(() => undefined)
        } else {
          this.broadcast()
        }
      })
      this.externalUnsubs.push(unsub)
    }
  }

  reset(): void {
    for (const unsub of this.externalUnsubs) {
      try {
        unsub()
      } catch {
        // Ignore teardown failures from host adapters.
      }
    }
    this.externalUnsubs = []
    this.providers = []
    this.listeners.clear()
    this.writeChains.clear()
  }

  async list(ctx: VariableContext): Promise<ContextVariable[]> {
    const chunks = await Promise.all(
      this.providers.map(provider => Promise.resolve(provider.list(ctx))),
    )
    // Sort within each provider chunk so the flattened list is ordered by
    // (provider priority, name). Identical variable sets must always render
    // to identical bytes, or prompt-cache prefixes get invalidated for free.
    const flat = chunks
      .map(chunk => [...chunk].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)))
      .flat()

    const dupes = findDuplicateNames(flat.map(variable => variable.name))
    if (dupes.length > 0) {
      throw new VariableError(
        'PROVIDER_CONFLICT',
        `Providers exposed duplicate variable names: ${dupes.join(', ')}`,
      )
    }
    return flat
  }

  async get(ctx: VariableContext, name: string): Promise<ContextVariable | undefined> {
    assertValidName(name)
    const all = await this.list(ctx)
    return all.find(variable => variable.name === name)
  }

  async set(ctx: VariableContext, input: SetInput): Promise<ContextVariable> {
    assertValidName(input.name)
    assertValidValue(input.value)

    return this.serialize(ctx.sessionId, async () => {
      let provider = this.findClaimant(input.name, input.scope)
      if (!provider) {
        throw new VariableError(
          'NO_PROVIDER',
          `No provider accepts variable "${input.name}"${input.scope ? ` in ${input.scope} scope` : ''}`,
        )
      }
      provider = await this.resolveStoreClaimant(ctx, provider, input.name, input.scope)
      if (!provider.set) {
        throw new VariableError(
          'READONLY',
          `Variable "${input.name}" is read-only`,
        )
      }
      const result = await provider.set(ctx, input)
      await this.emitForWrite(ctx, scopeOfStoreId(provider.id) ?? input.scope)
      return result
    })
  }

  async append(ctx: VariableContext, input: SetInput): Promise<ContextVariable> {
    assertValidName(input.name)
    assertValidValue(input.value)

    return this.serialize(ctx.sessionId, async () => {
      let provider = this.findClaimant(input.name, input.scope)
      if (!provider) {
        throw new VariableError(
          'NO_PROVIDER',
          `No provider accepts variable "${input.name}"${input.scope ? ` in ${input.scope} scope` : ''}`,
        )
      }
      provider = await this.resolveStoreClaimant(ctx, provider, input.name, input.scope)
      if (!provider.append) {
        throw new VariableError(
          'READONLY',
          `Variable "${input.name}" does not support append`,
        )
      }
      const result = await provider.append(ctx, input)
      await this.emitForWrite(ctx, scopeOfStoreId(provider.id) ?? input.scope)
      return result
    })
  }

  async remove(ctx: VariableContext, input: SetInput): Promise<ContextVariable> {
    assertValidName(input.name)
    assertValidValue(input.value)

    return this.serialize(ctx.sessionId, async () => {
      let provider = this.findClaimant(input.name, input.scope)
      if (!provider) {
        throw new VariableError(
          'NO_PROVIDER',
          `No provider accepts variable "${input.name}"${input.scope ? ` in ${input.scope} scope` : ''}`,
        )
      }
      provider = await this.resolveStoreClaimant(ctx, provider, input.name, input.scope)
      if (!provider.remove) {
        throw new VariableError(
          'READONLY',
          `Variable "${input.name}" does not support remove`,
        )
      }
      const result = await provider.remove(ctx, input)
      await this.emitForWrite(ctx, scopeOfStoreId(provider.id) ?? input.scope)
      return result
    })
  }

  async delete(ctx: VariableContext, name: string, scope?: VariableScope): Promise<void> {
    assertValidName(name)
    return this.serialize(ctx.sessionId, async () => {
      let provider = this.findClaimant(name, scope)
      if (!provider) {
        throw new VariableError('NOT_FOUND', `No variable named "${name}"`)
      }
      // Unscoped deletes follow the variable to its owning store; an explicit
      // scope targets that store directly (a miss is that store's NOT_FOUND).
      if (scope === undefined) {
        provider = await this.resolveStoreClaimant(ctx, provider, name, undefined)
      }
      if (!provider.delete) {
        throw new VariableError(
          'READONLY',
          `Variable "${name}" is read-only`,
        )
      }
      await provider.delete(ctx, name)
      await this.emitForWrite(ctx, scopeOfStoreId(provider.id) ?? scope)
    })
  }

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get limits() {
    return VARIABLE_LIMITS
  }

  assertNotReserved(name: string): void {
    assertNotReserved(name)
  }

  private findClaimant(name: string, scope?: VariableScope): VariableProvider | undefined {
    if (scope === 'global') {
      return this.providers.find(provider => provider.id === 'global-store' && provider.claims(name))
        // Reserved names with global effect (note dirs) live in their own
        // providers; scope=global still reaches them.
        ?? this.providers.find(provider => !STORE_IDS.has(provider.id) && provider.claims(name))
    }
    if (scope === 'agent' || scope === 'project') {
      const storeId = STORE_IDS_BY_SCOPE[scope]
      return this.providers.find(provider => provider.id === storeId && provider.claims(name))
    }
    // scope === 'session' and the unscoped default: reserved names route to
    // their owning provider, everything else falls through to session-store.
    return this.providers.find(
      provider => !NON_DEFAULT_STORE_IDS.has(provider.id) && provider.claims(name),
    )
  }

  /**
   * The store provider that currently holds `name` for this session, if any.
   * Store providers all claim every non-reserved name, so claims() cannot
   * distinguish "would accept" from "already has" — this can.
   */
  private async findOwnerStore(
    ctx: VariableContext,
    name: string,
  ): Promise<VariableProvider | undefined> {
    for (const provider of this.providers) {
      if (!STORE_IDS.has(provider.id)) continue
      const chunk = await Promise.resolve(provider.list(ctx))
      if (chunk.some(variable => variable.name === name)) return provider
    }
    return undefined
  }

  /**
   * Keep one name in one store: a second store accepting the same name would
   * make the next list() throw PROVIDER_CONFLICT and take the whole variable
   * system (including prompt assembly) down with it. Unscoped writes follow
   * the variable to wherever it already lives; explicitly-scoped writes into
   * a different store are rejected up front.
   */
  private async resolveStoreClaimant(
    ctx: VariableContext,
    claimant: VariableProvider,
    name: string,
    scope: VariableScope | undefined,
  ): Promise<VariableProvider> {
    if (!STORE_IDS.has(claimant.id)) return claimant
    const owner = await this.findOwnerStore(ctx, name)
    if (!owner || owner === claimant) return claimant
    if (scope === undefined) return owner
    const ownerScope = scopeOfStoreId(owner.id) ?? 'another'
    throw new VariableError(
      'PROVIDER_CONFLICT',
      `Variable "${name}" already exists in ${ownerScope} scope. Delete it there first, or omit scope to update it in place.`,
    )
  }

  private async emitForWrite(ctx: VariableContext, scope?: VariableScope): Promise<void> {
    const snapshot = await this.list(ctx)
    this.emit(ctx, snapshot)
    // Shared-scope writes are visible beyond the writing session.
    if (scope === 'global' || scope === 'agent' || scope === 'project') this.broadcast()
  }

  private serialize<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.writeChains.get(sessionId) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(task)
    this.writeChains.set(sessionId, next)
    next.finally(() => {
      if (this.writeChains.get(sessionId) === next) {
        this.writeChains.delete(sessionId)
      }
    }).catch(() => undefined)
    return next
  }

  private emit(ctx: VariableContext, snapshot: ContextVariable[]): void {
    for (const listener of this.listeners) {
      try {
        listener(ctx, snapshot)
      } catch (error) {
        log.error('variable registry listener failed', undefined, error)
      }
    }
  }

  private broadcast(): void {
    this.emit({ sessionId: '' }, [])
  }
}

let singleton: VariableRegistry | null = null

export function getVariableRegistry(): VariableRegistry {
  if (!singleton) singleton = new VariableRegistry()
  return singleton
}

export function resetVariableRegistryForTests(): VariableRegistry {
  singleton = new VariableRegistry()
  return singleton
}
