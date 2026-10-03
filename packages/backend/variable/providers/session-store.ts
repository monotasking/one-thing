import {
  typedValueForAppend,
  typedValueForRemove,
  typedValueForSet,
} from '../typed-values.js'
import {
  readStateFlag,
  VARIABLE_LIMITS,
  VariableError,
  type ContextVariable,
  type SetInput,
  type VariableContext,
  type VariableProvider,
} from '../types.js'
import { assertNotReserved, isReservedName } from '../validation.js'

export interface SessionStoreGateway {
  read(sessionId: string): ContextVariable[]
  write(sessionId: string, variables: ContextVariable[]): void | Promise<void>
  onChange?(callback: (sessionId: string) => void): () => void
}

export interface SessionStoreProviderOptions {
  maxPerSession?: number
}

export class SessionStoreProvider implements VariableProvider {
  readonly id = 'session-store'
  readonly priority = 1000

  private readonly maxPerSession: number

  constructor(
    private readonly gateway: SessionStoreGateway,
    options: SessionStoreProviderOptions = {},
  ) {
    this.maxPerSession = options.maxPerSession ?? VARIABLE_LIMITS.MAX_PER_PROVIDER
  }

  list(ctx: VariableContext): ContextVariable[] {
    const stored = this.gateway.read(ctx.sessionId) ?? []
    return stored
      .filter(variable => !isReservedName(variable.name))
      .map(variable => ({
        name: variable.name,
        value: variable.value,
        type: variable.type,
        scope: 'session',
        description: variable.description,
        // 会话文件是唯一还可能存着旧 volatility 的落盘位置(全局/agent/project
        // 走 variables.json,已在 schema 解析时转过)——读到即转,不回写。
        state: readStateFlag(variable),
        updatedAt: variable.updatedAt,
      }))
  }

  claims(name: string): boolean {
    return !isReservedName(name)
  }

  async set(ctx: VariableContext, input: SetInput): Promise<ContextVariable> {
    assertNotReserved(input.name)

    const current = this.list(ctx)
    const existing = current.find(variable => variable.name === input.name)
    const without = current.filter(variable => variable.name !== input.name)

    if (!existing && without.length >= this.maxPerSession) {
      throw new VariableError(
        'LIMIT_EXCEEDED',
        `Session already has ${without.length} custom variables (max ${this.maxPerSession})`,
      )
    }

    const typed = typedValueForSet(input, existing)
    // description/state are sticky like type: a value update without
    // them keeps what the variable already had; an explicit "" clears.
    const next: ContextVariable = {
      name: input.name,
      value: typed.value,
      type: typed.type,
      scope: 'session',
      description: (input.description ?? existing?.description) || undefined,
      state: input.state ?? existing?.state,
      updatedAt: Date.now(),
    }
    await this.gateway.write(ctx.sessionId, [...without, next])
    return next
  }

  async append(ctx: VariableContext, input: SetInput): Promise<ContextVariable> {
    assertNotReserved(input.name)

    const current = this.list(ctx)
    const existing = current.find(variable => variable.name === input.name)
    const without = current.filter(variable => variable.name !== input.name)

    if (!existing && without.length >= this.maxPerSession) {
      throw new VariableError(
        'LIMIT_EXCEEDED',
        `Session already has ${without.length} custom variables (max ${this.maxPerSession})`,
      )
    }

    const typed = typedValueForAppend(existing, input)
    const next: ContextVariable = {
      name: input.name,
      value: typed.value,
      type: typed.type,
      scope: 'session',
      description: (input.description ?? existing?.description) || undefined,
      state: input.state ?? existing?.state,
      updatedAt: Date.now(),
    }
    await this.gateway.write(ctx.sessionId, [...without, next])
    return next
  }

  async remove(ctx: VariableContext, input: SetInput): Promise<ContextVariable> {
    assertNotReserved(input.name)

    const current = this.list(ctx)
    const existing = current.find(variable => variable.name === input.name)
    const without = current.filter(variable => variable.name !== input.name)

    const typed = typedValueForRemove(existing, input.name, input)
    const next: ContextVariable = {
      ...existing!,
      value: typed.value,
      updatedAt: Date.now(),
    }
    await this.gateway.write(ctx.sessionId, [...without, next])
    return next
  }

  async delete(ctx: VariableContext, name: string): Promise<void> {
    assertNotReserved(name)

    const current = this.list(ctx)
    const without = current.filter(variable => variable.name !== name)
    if (without.length === current.length) {
      throw new VariableError('NOT_FOUND', `No variable named "${name}"`)
    }
    await this.gateway.write(ctx.sessionId, without)
  }

  onExternalChange(emit: (ctx?: VariableContext) => void): () => void {
    if (!this.gateway.onChange) return () => undefined
    return this.gateway.onChange(sessionId => emit({ sessionId }))
  }
}
