import {
  typedValueForAppend,
  typedValueForRemove,
  typedValueForSet,
} from '../typed-values.js'
import {
  VARIABLE_LIMITS,
  VariableError,
  type ContextVariable,
  type SetInput,
  type VariableContext,
  type VariableProvider,
  type VariableScope,
} from '../types.js'
import { assertNotReserved, isReservedName } from '../validation.js'

/**
 * Storage gateway for a scope whose variables are shared by every session
 * that resolves to the same key — the agent id for scope='agent', the
 * active workdir's project id for scope='project'. resolveKey returns null
 * when the session has no such binding (e.g. no workdir set), which makes
 * the scope read as empty and reject writes with a scope-specific hint.
 */
export interface KeyedStoreGateway {
  resolveKey(sessionId: string): string | null
  read(key: string): ContextVariable[]
  write(key: string, variables: ContextVariable[]): void | Promise<void>
  onChange?(callback: () => void): () => void
}

export interface KeyedStoreProviderOptions {
  id: string
  scope: Extract<VariableScope, 'agent' | 'project'>
  priority: number
  /** Error message when resolveKey returns null for a write. */
  unresolvedHint: string
  maxPerKey?: number
}

/**
 * Generic store provider for scopes keyed off a session attribute. One
 * instance per scope ('agent-store', 'project-store'); the shape mirrors
 * SessionStoreProvider so all custom-variable stores behave alike.
 */
export class KeyedStoreProvider implements VariableProvider {
  readonly id: string
  readonly priority: number
  readonly scope: Extract<VariableScope, 'agent' | 'project'>

  private readonly unresolvedHint: string
  private readonly maxPerKey: number

  constructor(
    private readonly gateway: KeyedStoreGateway,
    options: KeyedStoreProviderOptions,
  ) {
    this.id = options.id
    this.scope = options.scope
    this.priority = options.priority
    this.unresolvedHint = options.unresolvedHint
    this.maxPerKey = options.maxPerKey ?? VARIABLE_LIMITS.MAX_PER_PROVIDER
  }

  list(ctx: VariableContext): ContextVariable[] {
    const key = this.gateway.resolveKey(ctx.sessionId)
    if (!key) return []
    return (this.gateway.read(key) ?? [])
      .filter(variable => !isReservedName(variable.name))
      .map(variable => ({
        name: variable.name,
        value: variable.value,
        type: variable.type,
        scope: this.scope,
        description: variable.description,
        state: variable.state,
        updatedAt: variable.updatedAt,
      }))
  }

  claims(name: string): boolean {
    return !isReservedName(name)
  }

  async set(ctx: VariableContext, input: SetInput): Promise<ContextVariable> {
    assertNotReserved(input.name)
    const key = this.resolveKeyOrThrow(ctx)

    const current = this.list(ctx)
    const existing = current.find(variable => variable.name === input.name)
    const without = current.filter(variable => variable.name !== input.name)

    if (!existing && without.length >= this.maxPerKey) {
      throw new VariableError(
        'LIMIT_EXCEEDED',
        `The ${this.scope} scope already has ${without.length} variables (max ${this.maxPerKey})`,
      )
    }

    const typed = typedValueForSet(input, existing)
    // description/state are sticky like type: a value update without
    // them keeps what the variable already had; an explicit "" clears.
    const next: ContextVariable = {
      name: input.name,
      value: typed.value,
      type: typed.type,
      scope: this.scope,
      description: (input.description ?? existing?.description) || undefined,
      state: input.state ?? existing?.state,
      updatedAt: Date.now(),
    }
    await this.gateway.write(key, [...without, next])
    return next
  }

  async append(ctx: VariableContext, input: SetInput): Promise<ContextVariable> {
    assertNotReserved(input.name)
    const key = this.resolveKeyOrThrow(ctx)

    const current = this.list(ctx)
    const existing = current.find(variable => variable.name === input.name)
    const without = current.filter(variable => variable.name !== input.name)

    if (!existing && without.length >= this.maxPerKey) {
      throw new VariableError(
        'LIMIT_EXCEEDED',
        `The ${this.scope} scope already has ${without.length} variables (max ${this.maxPerKey})`,
      )
    }

    const typed = typedValueForAppend(existing, input)
    const next: ContextVariable = {
      name: input.name,
      value: typed.value,
      type: typed.type,
      scope: this.scope,
      description: (input.description ?? existing?.description) || undefined,
      state: input.state ?? existing?.state,
      updatedAt: Date.now(),
    }
    await this.gateway.write(key, [...without, next])
    return next
  }

  async remove(ctx: VariableContext, input: SetInput): Promise<ContextVariable> {
    assertNotReserved(input.name)
    const key = this.resolveKeyOrThrow(ctx)

    const current = this.list(ctx)
    const existing = current.find(variable => variable.name === input.name)
    const without = current.filter(variable => variable.name !== input.name)

    const typed = typedValueForRemove(existing, input.name, input)
    const next: ContextVariable = {
      ...existing!,
      value: typed.value,
      updatedAt: Date.now(),
    }
    await this.gateway.write(key, [...without, next])
    return next
  }

  async delete(ctx: VariableContext, name: string): Promise<void> {
    assertNotReserved(name)
    const key = this.resolveKeyOrThrow(ctx)

    const current = this.list(ctx)
    const without = current.filter(variable => variable.name !== name)
    if (without.length === current.length) {
      throw new VariableError('NOT_FOUND', `No ${this.scope} variable named "${name}"`)
    }
    await this.gateway.write(key, without)
  }

  onExternalChange(emit: (ctx?: VariableContext) => void): () => void {
    if (!this.gateway.onChange) return () => undefined
    // A keyed change affects every session sharing the key; broadcast like
    // the global store does instead of guessing a single session.
    return this.gateway.onChange(() => emit())
  }

  private resolveKeyOrThrow(ctx: VariableContext): string {
    const key = this.gateway.resolveKey(ctx.sessionId)
    if (!key) {
      throw new VariableError('INVALID_VALUE', this.unresolvedHint)
    }
    return key
  }
}
