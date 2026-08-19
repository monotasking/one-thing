import { toJsonSchemaObject, type JsonSchemaObject } from '../json.js'
import type { ToolDefinition } from './types.js'





export interface CoreToolSettingsLike {
  enabled: boolean
  autoExecute: boolean
}

export type CoreToolParameterType = 'string' | 'number' | 'boolean' | 'object' | 'array'

export interface CoreToolParameterDefinition {
  name: string
  type: CoreToolParameterType
  description: string
  required?: boolean
  enum?: string[]
}

export interface CoreToolJsonSchemaLike {
  properties?: Record<string, unknown>
  required?: string[]
}


export interface CoreToolDefinitionFromJsonSchemaInput {
  id: string
  name: string
  description: string
  jsonSchema: CoreToolJsonSchemaLike
  enabled: boolean
  autoExecute: boolean
  permissionGuard?: string
  executionMode?: string
  renderKind?: string
  renderShell?: string
  category: string
}


export interface CoreToolHostExecutionContext<
  TMetadataUpdate = unknown,
  TPartialResult = unknown,
  TStep = unknown,
  TApprovedAnalysis = unknown,
  TAbortSignal = unknown,
> {
  sessionId: string
  messageId: string
  toolCallId?: string
  workingDirectory?: string
  workingDirectoryRoots?: string[]
  abortSignal?: TAbortSignal
  onMetadata?: (update: TMetadataUpdate) => void
  onPartialResult?: (update: TPartialResult) => void
  onStepStart?: (step: TStep) => void
  onStepComplete?: (step: TStep) => void
  beforeSideEffect?: () => Promise<void>
  approvedAnalysis?: TApprovedAnalysis
}




export interface CoreToolFailureResult {
  success: false
  error: string
}

export type CoreMaybePromise<T> = T | Promise<T>

export type CoreToolValidationResult<TArgs, TError = unknown> =
  | { success: true; data: TArgs }
  | { success: false; error: TError }





export type CoreToolDecision =
  | { allowed: true; requested?: boolean }
  | { allowed: false; requested?: boolean; message?: string }



export function extractCoreErrorMessage(error: object | undefined, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  if (error && 'message' in error && typeof error.message === 'string' && error.message) {
    return error.message
  }
  return fallback
}

export function normalizeCoreToolParameterType(type: string | undefined): CoreToolParameterType {
  return type === 'string' ||
    type === 'number' ||
    type === 'boolean' ||
    type === 'object' ||
    type === 'array'
    ? type
    : 'string'
}

function coreSchemaObject(value: unknown): {
  type?: string
  description?: string
  enum?: string[]
} {
  const object = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined
  const type = object && 'type' in object && typeof object.type === 'string'
    ? object.type
    : undefined
  const description = object && 'description' in object && typeof object.description === 'string'
    ? object.description
    : undefined
  const enumValues = object && 'enum' in object && Array.isArray(object.enum)
    ? object.enum.filter((item): item is string => typeof item === 'string')
    : undefined

  return {
    type,
    description,
    enum: enumValues && enumValues.length > 0 ? enumValues : undefined,
  }
}

export function coreToolParameterFromSchema(
  name: string,
  prop: unknown,
  required: boolean,
): CoreToolParameterDefinition {
  const schema = coreSchemaObject(prop)
  return {
    name,
    type: normalizeCoreToolParameterType(schema.type),
    description: schema.description ?? '',
    required,
    enum: schema.enum,
  }
}





/** `CoreToolHostExecutionContext` 映射出来的那份运行期上下文。 */
export interface CoreToolRuntimeContext<
  TMetadata extends object = object,
  TPartialResult = unknown,
  TStep = unknown,
  TApprovedAnalysis = unknown,
  TAbortSignal = unknown,
> {
  sessionId: string
  messageId: string
  toolCallId?: string
  workingDirectory?: string
  workingDirectoryRoots?: string[]
  abortSignal?: TAbortSignal
  metadata(input: { title?: string; metadata?: Partial<TMetadata> }): void
  updateResult?(update: TPartialResult): void
  onStepStart?: (step: TStep) => void
  onStepComplete?: (step: TStep) => void
  beforeSideEffect?: () => Promise<void>
  approvedAnalysis?: TApprovedAnalysis
}

function coreToolParametersFromJsonSchema(schema: CoreToolJsonSchemaLike): CoreToolParameterDefinition[] {
  const required = schema.required ?? []
  return Object.entries(schema.properties ?? {}).map(([name, prop]) => (
    coreToolParameterFromSchema(name, prop, required.includes(name))
  ))
}

export function coreToolDefinitionFromJsonSchema<TInput extends CoreToolDefinitionFromJsonSchemaInput>(
  input: TInput,
): Omit<TInput, 'jsonSchema'> & {
  parameters: CoreToolParameterDefinition[]
  parameterSchema: JsonSchemaObject
} {
  const { jsonSchema, ...definition } = input
  return {
    ...definition,
    parameters: coreToolParametersFromJsonSchema(jsonSchema),
    parameterSchema: toJsonSchemaObject(jsonSchema),
  }
}

export function coreToolContextFromHost<
  TMetadata extends object,
  TPartialResult,
  TStep,
  TApprovedAnalysis,
  TAbortSignal,
>(
  context: CoreToolHostExecutionContext<
    { title?: string; metadata?: Partial<TMetadata> },
    TPartialResult,
    TStep,
    TApprovedAnalysis,
    TAbortSignal
  >,
): CoreToolRuntimeContext<TMetadata, TPartialResult, TStep, TApprovedAnalysis, TAbortSignal> {
  return {
    sessionId: context.sessionId,
    messageId: context.messageId,
    toolCallId: context.toolCallId,
    workingDirectory: context.workingDirectory,
    workingDirectoryRoots: context.workingDirectoryRoots,
    abortSignal: context.abortSignal,
    metadata: update => {
      context.onMetadata?.({
        title: update.title,
        metadata: update.metadata,
      })
    },
    updateResult: update => {
      context.onPartialResult?.(update)
    },
    onStepStart: context.onStepStart,
    onStepComplete: context.onStepComplete,
    beforeSideEffect: context.beforeSideEffect,
    approvedAnalysis: context.approvedAnalysis,
  }
}



export function coreToolValidationFailureMessage<TError>(
  error: TError,
  formatValidationError?: (error: TError) => string,
): string {
  return formatValidationError
    ? formatValidationError(error)
    : `Invalid arguments: ${extractCoreErrorMessage(
      error && typeof error === 'object' ? error : undefined,
      String(error),
    )}`
}














export type CoreToolRegistryKind = 'static' | 'async'

export interface CoreToolRegistryRegisterResult {
  id: string
  kind: CoreToolRegistryKind
  alreadyRegistered: boolean
}


export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()

  register(tool: ToolDefinition): void {
    if (!tool.name.trim()) {
      throw new Error('Tool name is required')
    }
    this.tools.set(tool.name, tool)
  }

  unregister(name: string): void {
    this.tools.delete(name)
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()]
  }

  clear(): void {
    this.tools.clear()
  }
}
